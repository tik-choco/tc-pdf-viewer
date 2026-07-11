// LLM network consumer + provider built on top of the mistlib room transport.
//
// The wire protocol (v: 1, incl. the provider_hello.models extension this app
// pioneered) and the request/response plumbing now come from the shared
// @tik-choco/mistai library:
//   - encode/decode        -> @tik-choco/mistai protocol (wire compatible)
//   - chunk reordering,    -> ConsumerService (seq handling, per-request
//     request correlation     inactivity timeout, rejectAll)
//   - llm_request handling -> ProviderService (streaming + request log)
//
// What stays app-side (and why this is NOT the library's ConsumerClient /
// useNetworkProvider): this app's mistlib wrapper is a single-global-node
// singleton (see src/utils/mist.js — MistNode methods call global wasm
// functions, and the node's wire identity is the app-wide deviceId shared
// with pdf-sync). The library's ConsumerClient creates its own Network/node,
// which would clobber the global node and change our wire identity. So the
// claimRoom/releaseRoom arbitration, the refcounted shared room membership
// between the consumer and provider roles, the provider_hello latching /
// status state machines, and AbortSignal support all remain here, wired to
// the library services via their injected SendFn (README "Pattern B").
//
// Public API is unchanged: encode, decode, MistllmConsumer/getMistllmConsumer,
// MistllmProvider/getMistllmProvider — hooks and ai.js need no changes.

import {
    ConsumerService,
    MESSAGES_JA,
    MistaiError,
    ProviderService,
    decode,
    encode,
    formatMistaiCode,
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
// chatAiViaMistllm) can't both observe the pre-join state across the
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
 * consumer_hello, latches onto the first provider_hello (first-come-first-
 * served), and delegates llm_request/response correlation (seq reordering,
 * inactivity timeout) to the library's ConsumerService.
 *
 * Status is a small state machine surfaced to the UI:
 *   idle -> joining -> searching -> connected (providerId)
 * with a transition back to 'error' on join failure, and back to 'searching'
 * (never 'error') if the active provider disconnects — a new provider_hello
 * can still arrive and recover the session.
 */
export class MistllmConsumer {
    constructor() {
        this.roomId = null;
        this.node = null;
        this.status = 'idle'; // idle | joining | searching | connected | error
        this.providerId = null;
        this.providerModels = []; // model ids advertised by the connected provider, if any
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
        // caller (chat()) surfaces as a rejection just like the old code did.
        this.service = new ConsumerService((toId, msg) => {
            if (!this.node) throw new Error('Mist LLMネットワークに接続されていません。');
            this.node.sendMessage(toId, encode(msg), DELIVERY_RELIABLE);
        });
    }

    getState() {
        return {
            status: this.status,
            providerId: this.providerId,
            providerCount: this.providerId ? 1 : 0,
            providerModels: this.providerModels,
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
        this._rejectAllProviderWaiters(new Error('接続がリセットされました。'));
        this.providerId = null;
        this.providerModels = [];
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

                if (eventType === EVENT_PEER_DISCONNECTED && fromId === this.providerId) {
                    // Auto-recovery: don't error out, just go back to searching —
                    // a replacement provider_hello can still arrive.
                    this.providerId = null;
                    this._setStatus('searching', { providerModels: [] });
                    this._startHelloRetry();
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
            const models = Array.isArray(msg.models) ? msg.models : [];
            if (!this.providerId) {
                this._stopHelloRetry();
                this.providerId = fromId;
                this._setStatus('connected', { providerModels: models });
                const waiters = this.providerWaiters.splice(0);
                waiters.forEach((waiter) => {
                    clearTimeout(waiter.timer);
                    waiter.resolve(fromId);
                });
            } else if (fromId === this.providerId) {
                // Same provider re-announcing (e.g. after our consumer_hello) —
                // refresh its advertised model list without a full status churn.
                this.providerModels = models;
                this._emit();
            }
            return;
        }

        // llm_response_chunk / llm_response_done / llm_error correlation lives
        // in the library service; every other type no-ops there.
        this.service.handleMessage(msg);
    }

    /**
     * Resolves once a provider is known, waiting up to 10s for a
     * provider_hello if none has arrived yet. Distinct from the (much
     * longer) per-request timeout used by chat().
     */
    waitForProvider() {
        if (this.providerId) return Promise.resolve(this.providerId);

        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject, timer: null };
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
     */
    async chat(messages, options = {}) {
        const { model, onChunk, signal, timeoutMs = REQUEST_TIMEOUT_MS } = options;

        if (!this.node) throw new Error('Mist LLMネットワークに接続されていません。');
        if (signal?.aborted) throw abortError('Request cancelled.');

        const providerId = await this.waitForProvider();

        // ConsumerService has no AbortSignal support, so adapt: race the
        // request against the signal, and mute onChunk once settled so a
        // cancelled request can't keep streaming into the UI.
        return new Promise((resolve, reject) => {
            let settled = false;
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

            this.service
                .request(providerId, messages, {
                    model,
                    timeoutMs,
                    onDelta: (delta, full) => {
                        if (settled) return;
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
                        cleanup();
                        reject(localizeMistaiError(err));
                    },
                );
        });
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
        this.providerId = null;
        this.providerModels = [];
        this.service.rejectAll(abortError('Mist LLMネットワークから切断されました。'));
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

    /** Builds the provider_hello payload, including `models` only when we have any. */
    _helloMessage() {
        return this.models.length > 0
            ? { v: 1, type: 'provider_hello', models: this.models }
            : { v: 1, type: 'provider_hello' };
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
