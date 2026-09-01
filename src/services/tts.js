// Text-to-speech for selected text (pronunciation check), ported from
// tc-translate's src/lib/voice.ts + src/hooks/useSpeech.ts.
//
// The engine is DERIVED from the shared llm config's `tts` entry rather than
// stored as a local app setting, exactly like tc-translate's
// deriveVoiceEngine (see services/llmConfig.js resolveVoice):
//   - `tts` absent, or its `model` blank            -> 'browser' (Web Speech API)
//   - its provider's baseUrl is `mist-network://…`  -> 'network' (a room peer synthesizes)
//   - any other baseUrl                             -> 'api' (OpenAI-compatible /audio/speech)
//   - model set but the provider can't be resolved  -> 'api', so the settings UI can
//                                                      warn about the dangling connection
//     (the runtime call then falls back to the browser voice)
//
// Every route degrades rather than failing hard: 'api'/'network' failures fall
// back to the browser voice in hooks/useTts.js, and a browser without
// speechSynthesis just reports the feature as unsupported.

import { getMistllmConsumer } from './mistllm';
import { emptyLlmConfig, loadLlmConfig, resolvePreset, resolveVoice, saveLlmConfig } from './llmConfig';
import { isNetworkProviderBaseUrl, networkVoiceModelParam } from './networkModels';

/** Matches mistai's MAX_TTS_TEXT_CHARS; also the cap applied on the API route so both behave alike. */
export const MAX_TTS_TEXT_CHARS = 4000;

export const DEFAULT_TTS_VOICE = 'alloy';

/**
 * @typedef {object} TtsSettings
 * @property {'browser'|'api'|'network'} engine
 * @property {string} providerId '' = defaultPreset の provider にフォールバック
 * @property {string} model
 * @property {string} voice
 * @property {number|undefined} speed
 * @property {string} baseUrl 解決できなかった場合は ''
 * @property {string} apiKey
 */

/**
 * Derives the TTS engine from a shared llm config. See this module's header
 * for the rules; mirrors tc-translate's deriveVoiceEngine('tts').
 *
 * @param {import('./llmConfig').SharedLlmConfigV1} config
 * @returns {'browser'|'api'|'network'}
 */
export function deriveTtsEngine(config) {
    const cfg = config?.tts;
    if (!cfg || !cfg.model) return 'browser';

    const provider = cfg.providerId
        ? config.providers.find((p) => p.id === cfg.providerId)
        : (() => {
              const defaultTarget = resolvePreset(config);
              return defaultTarget ? config.providers.find((p) => p.id === defaultTarget.providerId) : undefined;
          })();
    if (!provider) return 'api';

    return isNetworkProviderBaseUrl(provider.baseUrl) ? 'network' : 'api';
}

/**
 * Reads the current TTS settings out of the shared llm config. Never throws;
 * an unconfigured/unresolvable config comes back as the browser engine with
 * empty connection fields.
 *
 * @param {import('./llmConfig').SharedLlmConfigV1} [config]
 * @returns {TtsSettings}
 */
export function getTtsSettings(config = loadLlmConfig() ?? emptyLlmConfig()) {
    const cfg = config.tts;
    const engine = deriveTtsEngine(config);
    const resolved = resolveVoice(config, 'tts');
    return {
        engine,
        providerId: cfg?.providerId || '',
        model: cfg?.model || '',
        voice: cfg?.voice || '',
        speed: cfg?.speed,
        baseUrl: resolved?.baseUrl || '',
        apiKey: resolved?.apiKey || '',
    };
}

/**
 * Merges `patch` into the shared llm config's `tts` entry and persists it.
 * Passing a blank `model` clears the entry entirely (= back to the browser
 * voice), which is what the settings UI's "ブラウザ音声" choice does.
 *
 * An omitted key means "leave as is", so clearing an optional field needs an
 * explicit non-undefined value: pass `speed: null` to drop a configured
 * speed back to the provider's default.
 *
 * @param {{providerId?: string, model?: string, voice?: string, speed?: number|null}} patch
 * @returns {TtsSettings} the settings after the write
 */
export function updateTtsSettings(patch) {
    const config = loadLlmConfig() ?? emptyLlmConfig();
    const current = config.tts ?? { model: '' };
    const next = {
        providerId: patch.providerId !== undefined ? patch.providerId : current.providerId,
        model: patch.model !== undefined ? patch.model : current.model,
        voice: patch.voice !== undefined ? patch.voice : current.voice,
        speed: patch.speed !== undefined ? patch.speed : current.speed,
    };

    if (!next.model || !next.model.trim()) {
        delete config.tts;
    } else {
        const entry = { model: next.model.trim() };
        if (next.providerId) entry.providerId = next.providerId;
        if (next.voice) entry.voice = next.voice;
        if (typeof next.speed === 'number' && Number.isFinite(next.speed)) entry.speed = next.speed;
        config.tts = entry;
    }

    saveLlmConfig(config);
    return getTtsSettings(config);
}

/** True when this browser exposes the Web Speech synthesis API. */
export function isBrowserTtsSupported() {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/**
 * Best-effort BCP-47 tag for `text`, used to pick the browser voice (the
 * API/network routes leave language detection to the provider's model). Only
 * the scripts a PDF reader realistically hits are distinguished; anything
 * else — including plain Latin text — reads as English, which is the case
 * this feature exists for.
 *
 * @param {string} text
 * @returns {string}
 */
export function guessSpeechLang(text) {
    const sample = (text || '').slice(0, 400);
    if (/[぀-ヿ]/.test(sample)) return 'ja-JP'; // かな -> 日本語確定
    if (/[가-힯]/.test(sample)) return 'ko-KR';
    if (/[Ѐ-ӿ]/.test(sample)) return 'ru-RU';
    // 漢字のみ(かな無し)は中国語として読む。日本語文なら普通かなが混ざる。
    if (/[一-鿿]/.test(sample)) return 'zh-CN';
    return 'en-US';
}

/**
 * Picks the installed SpeechSynthesisVoice that best matches `lang`: an exact
 * BCP-47 match first, then any voice sharing the primary subtag, else null
 * (the utterance's own `lang` then decides). Voices load asynchronously in
 * some browsers, so an empty list here just means "let the browser choose".
 *
 * @param {string} lang
 * @returns {SpeechSynthesisVoice | null}
 */
export function pickBrowserVoice(lang) {
    if (!isBrowserTtsSupported()) return null;
    let voices = [];
    try {
        voices = window.speechSynthesis.getVoices() || [];
    } catch {
        return null;
    }
    if (voices.length === 0) return null;

    const target = lang.toLowerCase();
    const primary = target.split('-')[0];
    return (
        voices.find((v) => (v.lang || '').toLowerCase().replace('_', '-') === target) ??
        voices.find((v) => (v.lang || '').toLowerCase().split(/[-_]/)[0] === primary) ??
        null
    );
}

function authHeaders(apiKey) {
    return apiKey && apiKey.trim() ? { Authorization: `Bearer ${apiKey}` } : {};
}

function speechEndpoint(baseUrl) {
    const trimmed = (baseUrl || '').trim().replace(/\/+$/, '');
    return trimmed.endsWith('/audio/speech') ? trimmed : `${trimmed}/audio/speech`;
}

/**
 * POSTs an OpenAI-compatible `/audio/speech` request and resolves with the
 * audio Blob. Throws an Error whose message is already user-facing Japanese.
 *
 * @param {{baseUrl: string, apiKey: string, model: string, voice?: string, speed?: number, text: string, signal?: AbortSignal}} params
 * @returns {Promise<Blob>}
 */
export async function synthesizeSpeechViaApi(params) {
    const body = {
        model: params.model.trim(),
        input: params.text,
        voice: (params.voice || '').trim() || DEFAULT_TTS_VOICE,
        response_format: 'mp3',
    };
    if (typeof params.speed === 'number' && Number.isFinite(params.speed)) body.speed = params.speed;

    let response;
    try {
        response = await fetch(speechEndpoint(params.baseUrl), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders(params.apiKey) },
            signal: params.signal,
            body: JSON.stringify(body),
        });
    } catch (err) {
        if (err?.name === 'AbortError') throw err;
        throw new Error('音声APIへの接続に失敗しました（CORSまたはMixed Contentの可能性があります）');
    }

    if (!response.ok) {
        const payload = await response.json().catch(() => undefined);
        const detail = typeof payload?.error?.message === 'string' ? payload.error.message : '';
        throw new Error(detail || `音声合成に失敗しました（HTTP ${response.status}）`);
    }

    return await response.blob();
}

/**
 * Requests speech synthesis from an AI Network room peer that advertised the
 * "tts" service (see MistllmConsumer.tts in ./mistllm.js). The room id comes
 * from the shared config, the same one the chat consumer joins.
 *
 * @param {{model: string, voice?: string, text: string}} params
 * @returns {Promise<Blob>}
 */
export async function synthesizeSpeechViaNetwork(params) {
    const roomId = (loadLlmConfig()?.network?.roomId || '').trim();
    if (!roomId) throw new Error('AI NetworkのRoom IDが設定されていません。');

    const consumer = getMistllmConsumer();
    if (consumer.roomId !== roomId || consumer.status === 'idle' || consumer.status === 'error') {
        await consumer.connect(roomId);
    }

    return await consumer.tts(params.text, {
        // The `network-auto` sentinel means "use the provider's own default
        // model", so it must not go out on the wire (see ./networkModels.js).
        model: networkVoiceModelParam(params.model),
        voice: (params.voice || '').trim() || undefined,
    });
}

/**
 * Synthesizes `text` through whichever engine the shared config resolves to.
 * Rejects for the 'browser' engine (that route never produces a Blob — the
 * caller speaks it through the Web Speech API instead) and whenever the
 * resolved connection is unusable, so hooks/useTts.js can fall back.
 *
 * @param {string} text
 * @param {{settings?: TtsSettings, signal?: AbortSignal}} [options]
 * @returns {Promise<Blob>}
 */
export async function synthesizeSpeech(text, options = {}) {
    const settings = options.settings ?? getTtsSettings();
    const input = (text || '').trim().slice(0, MAX_TTS_TEXT_CHARS);
    if (!input) throw new Error('読み上げるテキストがありません。');

    if (settings.engine === 'network') {
        return await synthesizeSpeechViaNetwork({ model: settings.model, voice: settings.voice, text: input });
    }

    if (settings.engine === 'api') {
        if (!settings.baseUrl) throw new Error('音声合成の接続先が解決できません（プロバイダー設定を確認してください）。');
        return await synthesizeSpeechViaApi({
            baseUrl: settings.baseUrl,
            apiKey: settings.apiKey,
            model: settings.model,
            voice: settings.voice,
            speed: settings.speed,
            text: input,
            signal: options.signal,
        });
    }

    throw new Error('ブラウザ音声はBlobを生成しません。');
}
