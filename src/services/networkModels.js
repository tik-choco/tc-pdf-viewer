// Helpers for representing LLM Network-discovered models in the shared llm
// config: they live under a pseudo-provider whose baseUrl uses the
// `mist-network://` scheme (one per Room ID), so other tik-choco apps see a
// syntactically valid provider entry while this app can recognize and
// special-case it (no HTTP model fetch, network transport routing).
//
// JS+JSDoc port of tc-translate's src/lib/networkModels.ts (see
// tc-docs/drafts/llm-settings-common-v1.md §2.2/§4.2), including the voice
// `network-auto` sentinel now that this app has a TTS feature (see
// services/tts.js / services/mistllm.js).

import { normalizeBaseUrl } from './llmConfig';

/** @typedef {import('./llmConfig').SharedLlmConfigV1} SharedLlmConfigV1 */
/** @typedef {import('./llmConfig').LlmProviderV1} LlmProviderV1 */

export const NETWORK_PROVIDER_LABEL = 'AI Network';
export const NETWORK_PROVIDER_URL_PREFIX = 'mist-network://';

/**
 * @param {string} roomId
 * @returns {string}
 */
export function networkProviderBaseUrl(roomId) {
    return `${NETWORK_PROVIDER_URL_PREFIX}${(roomId || '').trim() || 'default'}`;
}

/**
 * @param {string} baseUrl
 * @returns {boolean}
 */
export function isNetworkProviderBaseUrl(baseUrl) {
    return (baseUrl || '').trim().startsWith(NETWORK_PROVIDER_URL_PREFIX);
}

/**
 * The name a shared preset is advertised under in `provider_hello.models`, and
 * the key incoming model-specific requests are matched back to a target by:
 * the preset's user-facing label, falling back to the raw model id when the
 * label is blank. Room-level convention shared with tc-translate and the
 * other tik-choco apps: the advertised strings are display names doubling as
 * opaque routing keys, NOT necessarily upstream model ids - consumers echo
 * them back verbatim and only the provider that advertised a name knows which
 * upstream preset it maps to. Wire-compatible with peers that advertise plain
 * model ids (label defaults to the model id).
 *
 * @param {{label: string, model: string}} target
 * @returns {string}
 */
export function advertisedModelName(target) {
    return (target.label || '').trim() || target.model;
}

/**
 * Finds the `mist-network://<roomId>` pseudo-provider row for `roomId` in
 * `config`, if one has been mirrored in yet (see hooks/useNetworkModelSync.js).
 * Matches by (normalized baseUrl, apiKey === '') the same way
 * `ensureProvider`/the mirror sync's own dedup does, so this always finds the
 * same row those helpers would find-or-create.
 *
 * @param {SharedLlmConfigV1} config
 * @param {string} roomId
 * @returns {LlmProviderV1 | undefined}
 */
export function findNetworkPseudoProvider(config, roomId) {
    const normalizedBaseUrl = normalizeBaseUrl(networkProviderBaseUrl(roomId));
    return config.providers.find((p) => p.baseUrl === normalizedBaseUrl && p.apiKey === '');
}

/**
 * Every preset in `config` whose provider is `providerId` - used to prune the
 * network pseudo-provider's mirrored presets and to compute what a provider
 * role would advertise (excluding presets already living on a
 * `mist-network://` provider - see `resolveSharedNetworkTargets` in
 * services/ai.js, which is what actually excludes those for advertising).
 *
 * @param {SharedLlmConfigV1} config
 * @param {string} providerId
 * @returns {import('./llmConfig').ModelPresetV1[]}
 */
export function presetsForProvider(config, providerId) {
    return config.presets.filter((p) => p.providerId === providerId);
}

/**
 * Sentinel voice-config model meaning "let the room's provider use its own
 * configured TTS/STT model". Stored in the shared config's tts/stt model
 * field alongside a mist-network pseudo-provider id; stripped from outgoing
 * requests (an omitted wire model -> provider's own default).
 */
export const NETWORK_VOICE_AUTO_MODEL = 'network-auto';

/**
 * Maps a configured voice model to the wire request param: the auto
 * sentinel becomes undefined (omit), anything else passes through (blank
 * also becomes undefined).
 *
 * @param {string} model
 * @returns {string | undefined}
 */
export function networkVoiceModelParam(model) {
    const trimmed = (model || '').trim();
    return !trimmed || trimmed === NETWORK_VOICE_AUTO_MODEL ? undefined : trimmed;
}
