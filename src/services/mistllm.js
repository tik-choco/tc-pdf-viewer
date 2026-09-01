// LLM network consumer + provider built on top of the mistlib room transport.
//
// The wire protocol (v: 1, incl. the provider_hello.models extension this app
// pioneered) and the request/response plumbing now come from the shared
// @tik-choco/mistai library:
//   - encode/decode          -> @tik-choco/mistai protocol (wire compatible)
//   - chunk reordering,      -> ConsumerService (seq handling, per-request
//     request correlation       inactivity timeout, rejectAll/rejectByProvider)
//   - llm_request handling   -> ProviderService (streaming + request log)
//   - provider matching      -> selectProvider (service + model matching over
//                                a provider table, v0.4+)
//   - failover policy        -> isFailoverEligible (v0.4+, exported so
//                                Pattern B apps can retry identically to
//                                ConsumerClient)
//
// What stays app-side (and why this is NOT the library's ConsumerClient /
// useNetworkProvider): this app's mistlib wrapper is a single-global-node
// singleton (see src/utils/mist.js — MistNode methods call global wasm
// functions, and the node's wire identity is the app-wide deviceId shared
// with pdf-sync). The library's ConsumerClient creates its own Network/node,
// which would clobber the global node and change our wire identity. So the
// claimRoom/releaseRoom arbitration, the refcounted shared room membership
// between the consumer and provider roles, the provider table + status state
// machines, and AbortSignal support all remain here, wired to the library
// services via their injected SendFn (README "Pattern B" — mirrors tc-note's
// src/lib/llmNet.ts, which does the same for its own custom transport).
//
// Provider selection (consumer side) now matches mistai v0.4.1's
// ConsumerClient: every announced provider is kept in a table (keyed by peer
// id, updated on each provider_hello, dropped on disconnect) instead of
// latching onto the first one forever; `selectProvider` narrows by
// provider_hello.services (this app's provider role only ever advertises
// "chat", but the consumer role also consumes "tts" for network TTS
// requests via VoiceConsumerService) and then by advertised model; a single
// failover retry is attempted via `isFailoverEligible` before the first
// response chunk arrives (chat() only — VoiceConsumerService's requestTts
// has no failover).
//
// Public API: encode, decode, MistllmConsumer/getMistllmConsumer,
// MistllmProvider/getMistllmProvider. MistllmProvider additionally exposes
// updateModels(models) (llm-settings-common-v1.md §4.3 "hello re-send"): call
// it whenever the advertised model set changes while already connected to
// re-broadcast provider_hello in place, without leaving/rejoining the room -
// see hooks/useNetworkProvider.js for the reactive wiring that calls it.

import {
    ConsumerService,
    MESSAGES_JA,
    MistaiError,
    ProviderService,
    VoiceConsumerService,
    decode,
    encode,
    formatMistaiCode,
    helloServices,
    isFailoverEligible,
    selectProvider,
} from '@tik-choco/mistai';
import { DELIVERY_RELIABLE, EVENT_RAW } from '../lib/mistlib/index.js';
import {
    addMistEventListener,
    claimRoom,
    EVENT_PEER_CONNECTED,
    EVENT_PEER_DISCONNECTED,
    getMistNode,
    releaseRoom,
} from '../utils/mist.js';

export { decode, encode };

const REQUEST_TIMEOUT_MS = 120000;
const PROVIDER_WAIT_TIMEOUT_MS = 20000;
// While searching, re-announce consumer_hello on this cadence. The one-shot
// hello sent on join races WebRTC channel establishment: at join time no peer
// is connected yet, and a provider that connects a moment later (or whose
// reliable data channel only just opened) can miss it. Periodic re-hello — plus
// a direct re-hello whenever a peer connects — is what makes a running provider
// reliably discoverable instead of intermittently "プロバイダーが見つかりません".
const HELLO_RETRY_INTERVAL_MS = 3000;
const PROVIDER_NOT_FOUND_MESSAGE = MESSAGES_JA.errors.PROVIDER_NOT_FOUND;
const PROVIDER_LOG_MAX_ENTRIES_RETAINED = 50;

function abortError(message) {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

/**
 * Converts a library error into what this app's callers historically
 * received: Japanese wording comes from the library's shared MESSAGES_JA
 * catalog; timeouts become AbortErrors (ai.js's isTimeoutError checks
 * err.name === 'AbortError'); remote llm_error relays (code REMOTE_ERROR)
 * keep the provider-authored message untouched.
 */
function localizeMistaiError(err) {
    if (err instanceof MistaiError && err.code !== 'REMOTE_ERROR') {
        const mapped = formatMistaiCode(err.code, MESSAGES_JA);
        if (mapped) {
            return err.code === 'REQUEST_TIMEOUT' ? abortError(mapped) : new Error(mapped);
        }
    }
    return err;
}

// ---------------------------------------------------------------------------
// Shared room membership.
//
// mistlib supports only one room per node globally, and both the consumer and
// the (optional, simultaneous) provider role need it joined for the same
// roomId. Rather than each owning its own join/leave, they share one
// refcounted membership under claimRoom('mistllm', roomId): whichever role
// activates first joins, and the room is only left once both are inactive.
// This intentionally departs from tc-translate's model (one `Network`
// instance per session) because this app's MistNode wrapper is a process-wide
// singleton (see src/utils/mist.js getMistNode()).
// ---------------------------------------------------------------------------
let _roomRefCount = 0;
let _roomNode = null;
let _roomId = null;
// Serializes acquireRoom() calls so two concurrent callers (e.g. the
// debounced eager-connect hook racing an explicit connect() from
// chatAiViaMistllmRoom) can't both observe the pre-join state across the
// `await getMistNode()` boundary and double-claim/corrupt the refcount.
let _joinQueue = Promise.resolve();

function acquireRoom(roomId, onEvent) {
    const attempt = _joinQueue.then(() => acquireRoomExclusive(roomId, onEvent));
    // Keep the queue moving even if this attempt fails, so a failed join
    // doesn't permanently wedge later callers behind a rejected promise.
    _joinQueue = attempt.then(() => undefined, () => undefined);
    return attempt;
}

async function acquireRoomExclusive(roomId, onEvent) {
    if (_roomId !== null && _roomId !== roomId) {
        // Another role is already using a different room; the mutual-exclusion
        // guard also lives one level down in claimRoom(), but surface a
        // friendlier message here since this is the common path (backend
        // switched rooms while a provider was still running the old one).
        throw new Error('別のRoom IDで接続中です。');
    }

    if (_roomRefCount === 0) {
        claimRoom('mistllm', roomId);
        try {
            const node = await getMistNode();
            node.joinRoom(roomId);
            _roomNode = node;
            _roomId = roomId;
        } catch (err) {
            // Join failed after claiming ownership — release it immediately so
            // a failed mistllm join doesn't permanently block pdf-sync (which
            // would otherwise see _roomOwner stuck at 'mistllm' until reload).
            releaseRoom('mistllm');
            _roomNode = null;
            _roomId = null;
            throw err;
        }
    }
    _roomRefCount += 1;

    const unsubscribe = addMistEventListener(onEvent);
    return {
        node: _roomNode,
        release: () => {
            unsubscribe();
            _roomRefCount = Math.max(0, _roomRefCount - 1);
            if (_roomRefCount === 0 && _roomNode) {
                try {
                    _roomNode.leaveRoom();
                } catch {
                    // ignore leave errors
                }
                releaseRoom('mistllm');
                _roomNode = null;
                _roomId = null;
            }
        },
    };
}

// ---------------------------------------------------------------------------
// Consumer
// ---------------------------------------------------------------------------

/**
 * Consumer-side wrapper around the shared mistlib room: joins the room, sends
 * consumer_hello, accumulates every announced provider into a table (updated
 * on each provider_hello, pruned on disconnect — mirrors mistai's
 * ConsumerClient), and delegates llm_request/response correlation (seq
 * reordering, inactivity timeout) to the library's ConsumerService, and
 * tts_request/stt_request/response correlation to VoiceConsumerService.
 * `selectProvider` matches a request's service ("chat" or "tts") and
 * optional model against the table; `chat()` retries once via
 * `isFailoverEligible` if the chosen provider disconnects/times
 * out/rejects the service before any response chunk arrives (`tts()` does
 * not retry — VoiceConsumerService has no failover support).
 *
 * Status is a small state machine surfaced to the UI:
 *   idle -> joining -> searching -> connected (providerId: first-discovered,
 *   kept for backward compatibility with the single-provider UI)
 * with a transition back to 'error' on join failure, and back to 'searching'
 * (never 'error') once the provider table empties — a new provider_hello
 * can still arrive and recover the session.
 */
export class MistllmConsumer {
    constructor() {
        this.roomId = null;
        this.node = null;
        this.status = 'idle'; // idle | joining | searching | connected | error
        // Every provider we've heard a provider_hello from, keyed by peer id:
        // { models?: string[], services: readonly string[] }. Mirrors mistai's
        // ConsumerClient internal provider table; selectProvider() reads this
        // directly.
        this.providerTable = new Map();
        this.providerId = null; // first-discovered provider id, kept for UI backward compatibility
        this.providerModels = []; // union of every known provider's advertised models, deduped
        this.providerVoices = []; // union of every known provider's advertised TTS voices, deduped
        this.errorMessage = '';
        this.errorCode = null; // MistaiErrorCode when the error came from the library, else null
        this.updatedAt = Date.now();
        this.listeners = new Set();
        this.providerWaiters = []; // [{ resolve, reject, timer }]
        this.joinGeneration = 0;
        this._release = null;
        this._helloInterval = null;
        // Sends go through this.node at call time so the service instance can
        // survive reconnects; before a room is joined this throws, which the
        // caller (chat()/tts()) surfaces as a rejection just like the old
        // code did. Shared by both services — chat and voice requests travel
        // over the same room connection.
        const send = (toId, msg) => {
            if (!this.node) throw new Error('Mist LLMネットワークに接続されていません。');
            this.node.sendMessage(toId, encode(msg), DELIVERY_RELIABLE);
        };
        this.service = new ConsumerService(send);
        this.voiceService = new VoiceConsumerService(send);
    }

    getState() {
        return {
            status: this.status,
            providerId: this.providerId,
            providerCount: this.providerTable.size,
            providerModels: this.providerModels,
            providerVoices: this.providerVoices,
            errorMessage: this.errorMessage,
            errorCode: this.errorCode,
            updatedAt: this.updatedAt,
            roomId: this.roomId,
        };
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /**
     * Recomputes the backward-compatible `providerId` (first-discovered) /
     * `providerModels` / `providerVoices` (deduped unions) fields from
     * `providerTable`. Callers
     * still emit explicitly afterwards (via _setStatus or _emit) so a single
     * notification covers both the table change and any status transition.
     */
    _refreshProviderFields() {
        this.providerId = this.providerTable.keys().next().value ?? null;
        const modelSet = new Set();
        let anyModels = false;
        this.providerTable.forEach((info) => {
            if (info.models) {
                anyModels = true;
                info.models.forEach((m) => modelSet.add(m));
            }
        });
        this.providerModels = anyModels ? Array.from(modelSet) : [];

        // provider_hello.voices is the optional TTS-voice-name extension: an
        // opaque list echoed straight back in tts_request.voice, so the
        // settings UI can offer the room's real voices instead of guessing
        // from the OpenAI catalog (mistai's unionVoices does the same for
        // ConsumerClient's own status).
        const voiceSet = new Set();
        let anyVoices = false;
        this.providerTable.forEach((info) => {
            if (info.voices) {
                anyVoices = true;
                info.voices.forEach((v) => voiceSet.add(v));
            }
        });
        this.providerVoices = anyVoices ? Array.from(voiceSet) : [];
    }

    _emit() {
        const state = this.getState();
        this.listeners.forEach((listener) => {
            try {
                listener(state);
            } catch (err) {
                console.error('mistllm listener failed:', err);
            }
        });
    }

    _setStatus(status, extra = {}) {
        this.status = status;
        this.updatedAt = Date.now();
        Object.assign(this, extra);
        this._emit();
    }

    /**
     * (Re)connects to `roomId`. Idempotent: calling again with the same
     * roomId while already joining/searching/connected is a no-op so the
     * eager-connect hook can call this on every roomId-debounce tick without
     * thrashing the connection.
     */
    async connect(roomId) {
        const normalizedRoomId = (roomId || '').trim();
        if (!normalizedRoomId) throw new Error('Room IDが指定されていません。');

        if (this.roomId === normalizedRoomId && ['joining', 'searching', 'connected'].includes(this.status)) {
            return;
        }

        const generation = ++this.joinGeneration;
        this._teardownRoom();
        this.service.rejectAll(abortError('Mist LLMネットワークから切断されました。'));
        this.voiceService.rejectAll(abortError('Mist LLMネットワークから切断されました。'));
        this._rejectAllProviderWaiters(new Error('接続がリセットされました。'));
        this.providerTable.clear();
        this.providerId = null;
        this.providerModels = [];
        this.providerVoices = [];
        this.roomId = normalizedRoomId;
        this._setStatus('joining');

        try {
            const { node, release } = await acquireRoom(normalizedRoomId, (eventType, fromId, payload) => {
                if (generation !== this.joinGeneration) return;

                if (eventType === EVENT_RAW) {
                    const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
                    const msg = decode(bytes);
                    if (msg) this._handleMessage(fromId, msg);
                    return;
                }

                if (eventType === EVENT_PEER_CONNECTED) {
                    // A peer just connected. If we're still looking for a
                    // provider, re-send consumer_hello straight to it so a
                    // provider that connected after us — or whose reliable
                    // channel only just opened — answers promptly instead of
                    // making us wait out the timeout.
                    if (!this.providerId && this.node) {
                        try {
                            this.node.sendMessage(fromId, encode({ v: 1, type: 'consumer_hello' }), DELIVERY_RELIABLE);
                        } catch {
                            // node released between the guard and the send; ignore.
                        }
                    }
                    return;
                }

                if (eventType === EVENT_PEER_DISCONNECTED && this.providerTable.delete(fromId)) {
                    // Only the requests actually sent to this provider are
                    // rejected — an in-flight request to a different, still-
                    // connected provider is left alone (ConsumerService's
                    // rejectByProvider, v0.4+).
                    const disconnectError = new MistaiError(
                        'PROVIDER_DISCONNECTED',
                        'Connection to the provider was lost.',
                    );
                    this.service.rejectByProvider(fromId, disconnectError);
                    this.voiceService.rejectByProvider(fromId, disconnectError);
                    this._refreshProviderFields();
                    if (this.providerTable.size === 0) {
                        // Auto-recovery: don't error out, just go back to
                        // searching — a replacement provider_hello can still
                        // arrive.
                        this._setStatus('searching');
                        this._startHelloRetry();
                    } else {
                        this._emit();
                    }
                }
            });

            if (generation !== this.joinGeneration) {
                // A newer connect() (different roomId, or explicit disconnect)
                // superseded this one before the room finished joining.
                release();
                return;
            }

            this._release = release;
            this.node = node;
            node.sendMessage('', encode({ v: 1, type: 'consumer_hello' }), DELIVERY_RELIABLE);
            this._setStatus('searching');
            this._startHelloRetry();
        } catch (err) {
            if (generation === this.joinGeneration) {
                this.node = null;
                this.roomId = null;
                this._setStatus('error', {
                    errorMessage: err.message || String(err),
                    errorCode: err instanceof MistaiError ? err.code : null,
                });
            }
            throw err;
        }
    }

    _handleMessage(fromId, msg) {
        if (msg.type === 'provider_hello') {
            const wasEmpty = this.providerTable.size === 0;
            this.providerTable.set(fromId, {
                models: Array.isArray(msg.models) ? msg.models : undefined,
                voices: Array.isArray(msg.voices) ? msg.voices : undefined,
                services: helloServices(msg),
            });
            this._refreshProviderFields();
            if (wasEmpty) {
                this._stopHelloRetry();
                this._setStatus('connected');
            } else {
                this._emit();
            }
            this._resolveProviderWaiters();
            return;
        }

        // llm_response_chunk / llm_response_done / llm_error correlation
        // lives in the library's ConsumerService; tts_response/stt_response
        // correlation lives in VoiceConsumerService. Both no-op on message
        // types they don't own, so every message is simply offered to both.
        this.service.handleMessage(msg);
        this.voiceService.handleMessage(msg);
    }

    /**
     * Resolves once an eligible (`service`, matching `model` if given)
     * provider is known, waiting up to PROVIDER_WAIT_TIMEOUT_MS for a
     * provider_hello if none has arrived yet. Distinct from the (much
     * longer) per-request timeout used by chat()/tts(). Resolves with a
     * `{ providerId, model }` selection from mistai's selectProvider —
     * `model` may differ from the requested one (omitted) per
     * selectProvider's matching rules. `service` defaults to "chat" for the
     * existing chat() call site; tts() passes "tts".
     */
    waitForProvider(model, service = 'chat') {
        const immediate = selectProvider(this.providerTable, service, model);
        if (immediate) return Promise.resolve(immediate);

        return new Promise((resolve, reject) => {
            const waiter = { model, service, resolve, reject, timer: null };
            waiter.timer = setTimeout(() => {
                const index = this.providerWaiters.indexOf(waiter);
                if (index >= 0) this.providerWaiters.splice(index, 1);
                // Reject *this* request so the caller shows a clear message, but
                // keep the connection in 'searching' rather than flipping to a
                // sticky 'error': the hello-retry loop is still running, so a
                // provider that appears later reconnects us automatically and
                // the next chat can succeed without a manual reconnect.
                reject(new Error(PROVIDER_NOT_FOUND_MESSAGE));
            }, PROVIDER_WAIT_TIMEOUT_MS);
            this.providerWaiters.push(waiter);
        });
    }

    /** Resolves any parked waitForProvider() calls the updated table can now satisfy. */
    _resolveProviderWaiters() {
        if (this.providerWaiters.length === 0) return;
        const remaining = [];
        this.providerWaiters.forEach((waiter) => {
            const selection = selectProvider(this.providerTable, waiter.service || 'chat', waiter.model);
            if (selection) {
                clearTimeout(waiter.timer);
                waiter.resolve(selection);
            } else {
                remaining.push(waiter);
            }
        });
        this.providerWaiters = remaining;
    }

    _rejectAllProviderWaiters(error) {
        const waiters = this.providerWaiters.splice(0);
        waiters.forEach((waiter) => {
            clearTimeout(waiter.timer);
            waiter.reject(error);
        });
    }

    /**
     * Re-broadcasts consumer_hello every HELLO_RETRY_INTERVAL_MS while we're
     * searching, so a provider that missed our first hello (its channel wasn't
     * open yet, or it joined after us) still answers. Self-stops on connect or
     * once the node is gone; teardown/disconnect also clear it.
     */
    _startHelloRetry() {
        this._stopHelloRetry();
        this._helloInterval = setInterval(() => {
            if (this.providerId || !this.node) {
                this._stopHelloRetry();
                return;
            }
            try {
                this.node.sendMessage('', encode({ v: 1, type: 'consumer_hello' }), DELIVERY_RELIABLE);
            } catch {
                // node released between the check and the send; the next
                // teardown clears the interval.
            }
        }, HELLO_RETRY_INTERVAL_MS);
    }

    _stopHelloRetry() {
        if (this._helloInterval) {
            clearInterval(this._helloInterval);
            this._helloInterval = null;
        }
    }

    /**
     * Sends an llm_request and resolves with the fully-assembled reply.
     * options: { model, onChunk(delta, fullSoFar), signal, timeoutMs }
     *
     * Provider is chosen via mistai's `selectProvider` (service "chat", then
     * `model` if given). If the chosen provider disconnects, times out, or
     * rejects with "unsupported_service" *before any response chunk arrives*,
     * this retries exactly once against another eligible provider
     * (`isFailoverEligible` — matches mistai's ConsumerClient policy). Once
     * streaming has started, no failover is attempted so a cancelled/failed
     * retry can't produce duplicate or garbled output.
     */
    async chat(messages, options = {}) {
        const { model, onChunk, signal, timeoutMs = REQUEST_TIMEOUT_MS } = options;

        if (!this.node) throw new Error('Mist LLMネットワークに接続されていません。');
        if (signal?.aborted) throw abortError('Request cancelled.');

        const first = await this.waitForProvider(model);

        // ConsumerService has no AbortSignal support, so adapt: race the
        // request against the signal, and mute onChunk once settled so a
        // cancelled request can't keep streaming into the UI.
        return new Promise((resolve, reject) => {
            let settled = false;
            let receivedChunk = false;
            let abortHandler = null;
            const cleanup = () => {
                settled = true;
                if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
            };

            if (signal) {
                abortHandler = () => {
                    if (settled) return;
                    cleanup();
                    reject(abortError('Request cancelled.'));
                };
                signal.addEventListener('abort', abortHandler, { once: true });
            }

            const attempt = (selection) => {
                this.service
                    .request(selection.providerId, messages, {
                        model: selection.model,
                        timeoutMs,
                        onDelta: (delta, full) => {
                            if (settled) return;
                            receivedChunk = true;
                            onChunk?.(delta, full);
                        },
                    })
                    .then(
                        (content) => {
                            if (settled) return;
                            cleanup();
                            resolve(content);
                        },
                        (err) => {
                            if (settled) return;
                            if (!receivedChunk && isFailoverEligible(err)) {
                                const retry = selectProvider(
                                    this.providerTable,
                                    'chat',
                                    model,
                                    new Set([selection.providerId]),
                                );
                                if (retry) {
                                    attempt(retry);
                                    return;
                                }
                            }
                            cleanup();
                            reject(localizeMistaiError(err));
                        },
                    );
            };

            attempt(first);
        });
    }

    /**
     * Requests speech synthesis from a room peer advertising the "tts"
     * service and resolves with the audio Blob. Provider is chosen via
     * `waitForProvider(model, 'tts')` — an omitted `model` matches any "tts"
     * provider and lets it use its own default (see the `network-auto`
     * sentinel handling in services/tts.js, which strips it before calling
     * here); if none is found, the rejection carries waitForProvider's
     * PROVIDER_NOT_FOUND_MESSAGE. Unlike chat(), VoiceConsumerService's
     * requestTts has no failover retry and no AbortSignal support, so a
     * single attempt is made and any failure is localized the same way
     * chat() does.
     *
     * @param {string} text
     * @param {{model?: string, voice?: string}} [options]
     * @returns {Promise<Blob>}
     */
    async tts(text, options = {}) {
        const { model, voice } = options;

        if (!this.node) throw new Error('Mist LLMネットワークに接続されていません。');

        const selection = await this.waitForProvider(model, 'tts');
        try {
            return await this.voiceService.requestTts(selection.providerId, {
                text,
                model: selection.model,
                voice,
            });
        } catch (err) {
            throw localizeMistaiError(err);
        }
    }

    _teardownRoom() {
        this._stopHelloRetry();
        if (this._release) {
            this._release();
            this._release = null;
        }
        this.node = null;
    }

    disconnect() {
        this.joinGeneration += 1;
        this._teardownRoom();
        this.roomId = null;
        this.providerTable.clear();
        this.providerId = null;
        this.providerModels = [];
        this.providerVoices = [];
        this.service.rejectAll(abortError('Mist LLMネットワークから切断されました。'));
        this.voiceService.rejectAll(abortError('Mist LLMネットワークから切断されました。'));
        this._rejectAllProviderWaiters(new Error('接続が切断されました。'));
        this._setStatus('idle', { errorMessage: '', errorCode: null });
    }

    leave() {
        this.disconnect();
    }
}

let sharedConsumer = null;

/** Returns a process-wide singleton MistllmConsumer instance. */
export function getMistllmConsumer() {
    if (!sharedConsumer) sharedConsumer = new MistllmConsumer();
    return sharedConsumer;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Provider-side service: joins the shared room, announces itself via
 * provider_hello (broadcast on join, and directly to any peer that connects
 * afterwards or sends consumer_hello), and delegates llm_request handling
 * (upstream streaming + request log) to the library's ProviderService.
 *
 * `callLlm(messages, model, onDelta) => Promise<string>` is injected so this
 * module doesn't need to know about ai.js's settings shape.
 */
export class MistllmProvider {
    constructor() {
        this.status = 'idle'; // idle | connecting | connected | error
        this.statusUpdatedAt = Date.now();
        this.errorMessage = '';
        this.roomId = null;
        this.peers = new Map(); // nodeId -> { connectedAt, isConsumer }
        this.logs = []; // most-recent-first, capped at PROVIDER_LOG_MAX_ENTRIES_RETAINED
        this.models = []; // upstream model ids, fetched once per start() and advertised in provider_hello
        this.listeners = new Set();
        this.node = null;
        this._release = null;
        this._callLlm = null;
        this._generation = 0;
        // One ProviderService per MistllmProvider (not per start()) so the
        // request log persists across stop/start, matching the old in-repo
        // implementation where `logs` lived on this singleton. The upstream
        // fn and the node are resolved at call time: after stop() the node is
        // null and late responses from still-running upstream calls are
        // dropped silently.
        this._service = new ProviderService(
            (toId, msg) => {
                if (this.node) this.node.sendMessage(toId, encode(msg), DELIVERY_RELIABLE);
            },
            (messages, model, onDelta) => {
                if (!this._callLlm) throw new Error('LLM呼び出しが設定されていません。');
                return this._callLlm(messages, model, onDelta);
            },
            {
                maxLogEntries: PROVIDER_LOG_MAX_ENTRIES_RETAINED,
                onRequestLog: () => {
                    this.logs = this._service.getLogs();
                    this._emit();
                },
            },
        );
    }

    getState() {
        const consumerCount = Array.from(this.peers.values()).filter((peer) => peer.isConsumer).length;
        return {
            status: this.status,
            statusUpdatedAt: this.statusUpdatedAt,
            errorMessage: this.errorMessage,
            roomId: this.roomId,
            peers: Array.from(this.peers.entries()).map(([nodeId, info]) => ({ nodeId, ...info })),
            consumerCount,
            logs: this.logs,
            models: this.models,
        };
    }

    /**
     * Builds the provider_hello payload. Always advertises `services: ['chat']`
     * explicitly (this app only ever serves chat) so consumers running
     * mistai's selectProvider (v0.4+) match us on the announced list rather
     * than falling back to the legacy no-`services`-field default; `models`
     * is included only when we have any.
     */
    _helloMessage() {
        return this.models.length > 0
            ? { v: 1, type: 'provider_hello', services: ['chat'], models: this.models }
            : { v: 1, type: 'provider_hello', services: ['chat'] };
    }

    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    _emit() {
        const state = this.getState();
        this.listeners.forEach((listener) => {
            try {
                listener(state);
            } catch (err) {
                console.error('mistllm provider listener failed:', err);
            }
        });
    }

    _setStatus(status, extra = {}) {
        this.status = status;
        this.statusUpdatedAt = Date.now();
        Object.assign(this, extra);
        this._emit();
    }

    /**
     * @param {string} roomId
     * @param {LlmCallFn} callLlm
     * @param {string[]} [models] - upstream model ids to advertise via
     *   provider_hello, fetched once by the caller (see useNetworkProvider)
     *   rather than re-fetched here on every hello.
     */
    async start(roomId, callLlm, models = []) {
        const normalizedRoomId = (roomId || '').trim();
        if (!normalizedRoomId) throw new Error('Room IDが指定されていません。');
        if (this.roomId === normalizedRoomId && ['connecting', 'connected'].includes(this.status)) return;

        const generation = ++this._generation;
        this._teardown();
        this._callLlm = callLlm;
        this.models = Array.isArray(models) ? models.filter((m) => typeof m === 'string' && m.length > 0) : [];
        this.roomId = normalizedRoomId;
        this.peers = new Map();
        this._setStatus('connecting');

        try {
            const { node, release } = await acquireRoom(normalizedRoomId, (eventType, fromId, payload) => {
                if (generation !== this._generation) return;

                if (eventType === EVENT_RAW) {
                    const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
                    const msg = decode(bytes);
                    if (msg) this._handleMessage(node, fromId, msg);
                    return;
                }

                if (eventType === EVENT_PEER_CONNECTED) {
                    if (!this.peers.has(fromId)) {
                        this.peers.set(fromId, { connectedAt: Date.now(), isConsumer: false });
                    }
                    // A newly connected peer might be a consumer looking for us.
                    node.sendMessage(fromId, encode(this._helloMessage()), DELIVERY_RELIABLE);
                    this._emit();
                    return;
                }

                if (eventType === EVENT_PEER_DISCONNECTED) {
                    if (this.peers.delete(fromId)) this._emit();
                }
            });

            if (generation !== this._generation) {
                release();
                return;
            }

            this._release = release;
            this.node = node;
            node.sendMessage('', encode(this._helloMessage()), DELIVERY_RELIABLE);
            this._setStatus('connected');
        } catch (err) {
            if (generation === this._generation) {
                this.node = null;
                this.roomId = null;
                this._setStatus('error', { errorMessage: err.message || String(err) });
            }
            throw err;
        }
    }

    /**
     * Updates the advertised model list in place and, if currently connected,
     * re-broadcasts provider_hello to every peer in the room - WITHOUT
     * leaving/rejoining - so already-connected consumers pick up a changed
     * share list immediately (spec llm-settings-common-v1.md §4.3: mistai's
     * consumer applies an in-connection provider_hello to its provider table
     * and status.models right away, so this alone closes the propagation
     * loop; no in-flight request is disrupted). No-op if the (sorted, deduped
     * by the caller - see getAdvertisedNetworkModels in ../services/ai.js)
     * model set is unchanged, or if not currently connected (start()'s own
     * initial hello covers that case once a connection is established).
     *
     * @param {string[]} models
     */
    updateModels(models) {
        const next = Array.isArray(models) ? models.filter((m) => typeof m === 'string' && m.length > 0) : [];
        const nextKey = [...next].sort().join('\n');
        const currentKey = [...this.models].sort().join('\n');
        if (nextKey === currentKey) return;

        this.models = next;
        if (this.status !== 'connected' || !this.node) return;
        this.node.sendMessage('', encode(this._helloMessage()), DELIVERY_RELIABLE);
    }

    _handleMessage(node, fromId, msg) {
        if (msg.type === 'consumer_hello') {
            const existing = this.peers.get(fromId);
            this.peers.set(fromId, { connectedAt: existing?.connectedAt ?? Date.now(), isConsumer: true });
            node.sendMessage(fromId, encode(this._helloMessage()), DELIVERY_RELIABLE);
            this._emit();
            return;
        }

        // llm_request handling (streaming + logs) lives in the library
        // service; every other type no-ops there.
        void this._service.handleMessage(fromId, msg);
    }

    _teardown() {
        if (this._release) {
            this._release();
            this._release = null;
        }
        this.node = null;
    }

    stop() {
        this._generation += 1;
        this._teardown();
        this.roomId = null;
        this.peers = new Map();
        this.models = [];
        this._callLlm = null;
        this._setStatus('idle', { errorMessage: '' });
    }
}

let sharedProvider = null;

/** Returns a process-wide singleton MistllmProvider instance. */
export function getMistllmProvider() {
    if (!sharedProvider) sharedProvider = new MistllmProvider();
    return sharedProvider;
}
