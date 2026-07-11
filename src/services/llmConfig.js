// Shared LLM/TTS/STT connection config for the tik-choco app family, vendored
// identically (modulo TS/JS syntax) into every participating app. See
// protocol/docs/data-contracts/docs/llm-config.md for the full spec.
// Contract version: v1
//
// Design: this module does NOT depend on mistlib or sharedBus.js. Unlike
// appManifest.js (one key per app, writer-owned) this key is co-owned: every
// participating app reads AND writes the same localStorage record, so a user
// only has to enter their LLM endpoint/API key once per origin instead of
// once per app. Same-origin apps mutually trust each other; conflicts are
// resolved last-write-wins by `updatedAt`. See docs/did-identity.md for the
// precedent of this co-owned-shared-key pattern
// (`tc-shared-did-identity-cid-v1`).
//
// Merge/migration policy (enforced by convention, not code): apps seeding
// this config from their own legacy local settings must loadLlmConfig() (or
// start from emptyLlmConfig() if null), add entries via ensureProvider/
// ensurePreset (which only ever append, never delete or overwrite existing
// entries), set `defaultPresetId`/`tts`/`stt`/`network.roomId` ONLY if
// currently empty/absent, then call saveLlmConfig(). Never blind-overwrite
// another app's providers/presets.
//
// This is the JS+JSDoc rendering of the canonical reference copy
// (protocol/docs/data-contracts/reference/llmConfig.ts). Don't hand-edit the
// vendored per-app copies directly — regenerate them with
// protocol/scripts/sync-vendored.mjs instead, so drift doesn't creep back in.
// Like appManifest.js, this file has no per-app placeholder to substitute:
// the vendored copy is byte-identical everywhere.

export const LLM_CONFIG_KEY = 'tc-shared-llm-config-v1';
export const LLM_CONFIG_VERSION = 1;

/**
 * @typedef {object} LlmProviderV1 接続情報のみ = 「どこに繋ぐか」
 * @property {string} id
 * @property {string} label
 * @property {string} baseUrl
 * @property {string} apiKey
 */

/**
 * @typedef {object} ModelPresetV1 名前付きモデル設定 = 「どう呼ぶか」。providerId で LlmProviderV1 を参照
 * @property {string} id
 * @property {string} label
 * @property {string} providerId
 * @property {string} model
 * @property {number} [temperature]
 * @property {string} [reasoningEffort]
 */

/**
 * @typedef {object} VoiceConfigV1 TTS/STT。providerId 省略時は defaultPreset の provider にフォールバック
 * @property {string} [providerId]
 * @property {string} model
 * @property {string} [voice]
 * @property {number} [speed]
 */

/**
 * @typedef {object} SharedLlmConfigV1
 * @property {1} v
 * @property {LlmProviderV1[]} providers
 * @property {ModelPresetV1[]} presets
 * @property {string} defaultPresetId ""(空文字)= 未設定
 * @property {VoiceConfigV1} [tts]
 * @property {VoiceConfigV1} [stt]
 * @property {{roomId: string}} network AI Network の既定ルーム。roomId: "" = 未設定
 * @property {string} updatedAt ISO 8601、LWW(last-write-wins)用
 */

/**
 * @typedef {object} ResolvedLlmTargetV1 resolvePreset() の解決結果。provider の接続情報と
 *   preset のモデル設定を1つにマージしたもの。
 * @property {string} presetId
 * @property {string} providerId
 * @property {string} label preset の label
 * @property {string} baseUrl
 * @property {string} apiKey
 * @property {string} model
 * @property {number} [temperature]
 * @property {string} [reasoningEffort]
 */

function isLlmProviderV1(value) {
    if (value === null || typeof value !== 'object') return false;
    return (
        typeof value.id === 'string' &&
        typeof value.label === 'string' &&
        typeof value.baseUrl === 'string' &&
        typeof value.apiKey === 'string'
    );
}

function isModelPresetV1(value) {
    if (value === null || typeof value !== 'object') return false;
    return (
        typeof value.id === 'string' &&
        typeof value.label === 'string' &&
        typeof value.providerId === 'string' &&
        typeof value.model === 'string' &&
        (value.temperature === undefined || typeof value.temperature === 'number') &&
        (value.reasoningEffort === undefined || typeof value.reasoningEffort === 'string')
    );
}

function isVoiceConfigV1(value) {
    if (value === null || typeof value !== 'object') return false;
    return (
        (value.providerId === undefined || typeof value.providerId === 'string') &&
        typeof value.model === 'string' &&
        (value.voice === undefined || typeof value.voice === 'string') &&
        (value.speed === undefined || typeof value.speed === 'number')
    );
}

/**
 * Field-by-field defensive parse of a raw `SharedLlmConfigV1` value. Returns
 * null if a required top-level field is missing/malformed or `v` isn't 1.
 * Malformed entries inside `providers`/`presets` are dropped individually
 * rather than invalidating the whole record; a malformed optional `tts`/`stt`
 * is dropped the same way.
 *
 * @param {unknown} value
 * @returns {SharedLlmConfigV1 | null}
 */
function sanitizeLlmConfig(value) {
    if (value === null || typeof value !== 'object') return null;

    if (value.v !== 1) return null;
    if (!Array.isArray(value.providers)) return null;
    if (!Array.isArray(value.presets)) return null;
    if (typeof value.defaultPresetId !== 'string') return null;
    if (value.network === null || typeof value.network !== 'object') return null;
    if (typeof value.network.roomId !== 'string') return null;
    if (typeof value.updatedAt !== 'string') return null;

    const config = {
        v: 1,
        providers: value.providers.filter(isLlmProviderV1),
        presets: value.presets.filter(isModelPresetV1),
        defaultPresetId: value.defaultPresetId,
        network: { roomId: value.network.roomId },
        updatedAt: value.updatedAt,
    };

    if (value.tts !== undefined && isVoiceConfigV1(value.tts)) config.tts = value.tts;
    if (value.stt !== undefined && isVoiceConfigV1(value.stt)) config.stt = value.stt;

    return config;
}

function newId() {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
    } catch {
        // fall through to the Math.random fallback below
    }
    return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Returns a fresh, empty `SharedLlmConfigV1` (not persisted).
 *
 * @returns {SharedLlmConfigV1}
 */
export function emptyLlmConfig() {
    return {
        v: 1,
        providers: [],
        presets: [],
        defaultPresetId: '',
        network: { roomId: '' },
        updatedAt: '',
    };
}

/**
 * Reads and validates `tc-shared-llm-config-v1`. Returns null if the key is
 * missing, the JSON is malformed, or the shape doesn't match
 * `SharedLlmConfigV1` (never throws). See `sanitizeLlmConfig` for how
 * malformed array entries are handled.
 *
 * @returns {SharedLlmConfigV1 | null}
 */
export function loadLlmConfig() {
    try {
        const raw = localStorage.getItem(LLM_CONFIG_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return sanitizeLlmConfig(parsed);
    } catch {
        return null;
    }
}

/**
 * Persists `config` to `tc-shared-llm-config-v1`, stamping `config.updatedAt`
 * with the current time (mutates the passed object). Never throws: storage
 * failures (quota, disabled storage, etc.) are swallowed after a
 * console.warn.
 *
 * @param {SharedLlmConfigV1} config
 */
export function saveLlmConfig(config) {
    config.updatedAt = new Date().toISOString();
    try {
        localStorage.setItem(LLM_CONFIG_KEY, JSON.stringify(config));
    } catch (error) {
        console.warn('tc-shared-llm-config: failed to persist config', error);
    }
}

/**
 * Subscribes to cross-tab/cross-app updates of `tc-shared-llm-config-v1` via
 * the `storage` window event (same-origin only, and only fires for tabs
 * other than the writer). Calls `cb` with the freshly loaded config (or null)
 * whenever the key changes. Returns an unsubscribe function.
 *
 * @param {(config: SharedLlmConfigV1 | null) => void} cb
 * @returns {() => void}
 */
export function subscribeLlmConfig(cb) {
    function onStorageEvent(event) {
        if (event.key !== LLM_CONFIG_KEY) return;
        cb(loadLlmConfig());
    }

    window.addEventListener('storage', onStorageEvent);
    return () => window.removeEventListener('storage', onStorageEvent);
}

/**
 * Trims whitespace and strips trailing slashes, so equivalent endpoints compare equal.
 *
 * @param {string} url
 * @returns {string}
 */
export function normalizeBaseUrl(url) {
    return url.trim().replace(/\/+$/, '');
}

/**
 * Finds-or-creates a provider by (normalized baseUrl, apiKey) pair. Mutates
 * `config.providers` in place (push-only, never overwrites an existing
 * entry) and returns the provider's id; the caller is responsible for
 * calling `saveLlmConfig` afterwards.
 *
 * @param {SharedLlmConfigV1} config
 * @param {{label?: string, baseUrl: string, apiKey: string}} input
 * @returns {string}
 */
export function ensureProvider(config, input) {
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const existing = config.providers.find((p) => p.baseUrl === baseUrl && p.apiKey === input.apiKey);
    if (existing) return existing.id;

    const id = newId();
    config.providers.push({ id, label: input.label || baseUrl, baseUrl, apiKey: input.apiKey });
    return id;
}

/**
 * Finds-or-creates a preset. If `input.id` is given and a preset with that id
 * already exists, it is returned unchanged (an explicit id is never
 * overwritten). Otherwise dedupes by
 * `(providerId, model, temperature ?? null, reasoningEffort ?? null)`.
 * Mutates `config.presets` in place (push-only); the caller is responsible
 * for calling `saveLlmConfig` afterwards.
 *
 * @param {SharedLlmConfigV1} config
 * @param {{id?: string, label?: string, providerId: string, model: string, temperature?: number, reasoningEffort?: string}} input
 * @returns {string}
 */
export function ensurePreset(config, input) {
    if (input.id) {
        const byId = config.presets.find((p) => p.id === input.id);
        if (byId) return byId.id;
    }

    const temperature = input.temperature ?? null;
    const reasoningEffort = input.reasoningEffort ?? null;
    const existing = config.presets.find(
        (p) =>
            p.providerId === input.providerId &&
            p.model === input.model &&
            (p.temperature ?? null) === temperature &&
            (p.reasoningEffort ?? null) === reasoningEffort,
    );
    if (existing) return existing.id;

    const preset = {
        id: input.id ?? newId(),
        label: input.label || input.model,
        providerId: input.providerId,
        model: input.model,
    };
    if (input.temperature !== undefined) preset.temperature = input.temperature;
    if (input.reasoningEffort !== undefined) preset.reasoningEffort = input.reasoningEffort;

    config.presets.push(preset);
    return preset.id;
}

/**
 * Resolves `presetId` (or, if omitted/not found, `config.defaultPresetId`)
 * to a preset and merges it with its provider's connection info. Returns
 * null if no preset can be found or its provider no longer exists.
 *
 * @param {SharedLlmConfigV1} config
 * @param {string | null} [presetId]
 * @returns {ResolvedLlmTargetV1 | null}
 */
export function resolvePreset(config, presetId) {
    const preset =
        (presetId ? config.presets.find((p) => p.id === presetId) : undefined) ??
        config.presets.find((p) => p.id === config.defaultPresetId);
    if (!preset) return null;

    const provider = config.providers.find((p) => p.id === preset.providerId);
    if (!provider) return null;

    const resolved = {
        presetId: preset.id,
        providerId: provider.id,
        label: preset.label,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: preset.model,
    };
    if (preset.temperature !== undefined) resolved.temperature = preset.temperature;
    if (preset.reasoningEffort !== undefined) resolved.reasoningEffort = preset.reasoningEffort;
    return resolved;
}

/**
 * Resolves `config.tts`/`config.stt` to concrete connection info. Returns
 * null if the voice config is absent, has no `model`, or its provider (the
 * explicit `providerId`, or else the provider of `resolvePreset(config)`)
 * can't be found.
 *
 * @param {SharedLlmConfigV1} config
 * @param {"tts" | "stt"} kind
 * @returns {{baseUrl: string, apiKey: string, model: string, voice?: string, speed?: number} | null}
 */
export function resolveVoice(config, kind) {
    const cfg = config[kind];
    if (!cfg || !cfg.model) return null;

    const provider = cfg.providerId
        ? config.providers.find((p) => p.id === cfg.providerId)
        : (() => {
              const defaultTarget = resolvePreset(config);
              return defaultTarget ? config.providers.find((p) => p.id === defaultTarget.providerId) : undefined;
          })();
    if (!provider) return null;

    const resolved = {
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        model: cfg.model,
    };
    if (cfg.voice !== undefined) resolved.voice = cfg.voice;
    if (cfg.speed !== undefined) resolved.speed = cfg.speed;
    return resolved;
}
