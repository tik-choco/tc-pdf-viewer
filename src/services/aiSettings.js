import {
    createProvider, createRoomProvider, emptyLlmConfig, isModelRef,
    loadLlmConfig, migrateSharedLlmConfig, normalizeBaseUrl, patchProvider,
    presetIdToRef, providerKind, saveLlmConfig,
} from '@tik-choco/mistai/llm-config';

export const AI_TASKS = ['explain', 'translate', 'chat', 'ocr'];
export const REASONING_EFFORT_OPTIONS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const AI_SETTINGS_KEY = 'tc-pdf-viewer-ai-settings-v1';
const SETTINGS_EVENT = 'pdf-viewer-ai-settings';
const DEFAULT_PROMPT = '以下の用語や文章を簡潔に、かつ専門的に解説してください:\n\n"{text}"';
const DEFAULT_LANGUAGES = ['日本語', 'English', '中国語', '韓国語', 'スペイン語'];

export function getSharedLlmConfig() {
    const config = loadLlmConfig() ?? emptyLlmConfig();
    if (migrateSharedLlmConfig(config).changed) saveLlmConfig(config);
    return config;
}

function readSettings(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); }
    catch { return null; }
}

/** @returns {import('@tik-choco/mistai/preact').LlmLocalSettings & {locale: string, promptTemplate: string, targetLanguages: string[]}} */
function normalizeSettings(saved = {}) {
    const tasks = Object.fromEntries(AI_TASKS.map(id => {
        const task = saved.tasks?.[id];
        return [id, {
            ...(isModelRef(task?.ref) ? { ref: task.ref } : {}),
            reasoningEffort: REASONING_EFFORT_OPTIONS.includes(task?.reasoningEffort) ? task.reasoningEffort : 'none',
        }];
    }));
    const roomProvide = Object.fromEntries(Object.entries(saved.roomProvide ?? {}).map(([id, room]) => [id, {
        enabled: room?.enabled === true,
        shared: Array.isArray(room?.shared) ? room.shared.filter(isModelRef) : [],
    }]));
    const recentModels = (Array.isArray(saved.recentModels) ? saved.recentModels : []).filter(isModelRef)
        .filter((ref, index, refs) => refs.findIndex(r => r.providerId === ref.providerId && r.model === ref.model) === index).slice(0, 8);
    return {
        tasks, roomProvide, recentModels,
        locale: ['ja', 'en', 'zh-CN', 'zh-TW'].includes(saved.locale) ? saved.locale : 'ja',
        promptTemplate: saved.promptTemplate || DEFAULT_PROMPT,
        targetLanguages: Array.isArray(saved.targetLanguages) && saved.targetLanguages.length ? saved.targetLanguages : DEFAULT_LANGUAGES,
    };
}

// Import the oldest endpoint-based settings directly into refs. New code never
// writes presets/defaultPresetId/network, even during this migration.
function importEndpoints(saved, config) {
    const before = JSON.stringify(config);
    const endpoints = Array.isArray(saved.baseUrlConfigs) ? saved.baseUrlConfigs : [];
    const ensureEndpoint = (url, apiKey = '', label = url) => {
        const baseUrl = normalizeBaseUrl(url || '');
        if (!baseUrl) return undefined;
        const previous = config.providers.find(p => p.baseUrl === baseUrl && p.apiKey === apiKey);
        if (previous) return previous.id;
        const id = createProvider(config, label || baseUrl);
        patchProvider(config, id, { baseUrl, apiKey });
        return id;
    };
    for (const endpoint of endpoints) ensureEndpoint(endpoint.url, endpoint.apiKey ?? saved.apiKey ?? '', endpoint.label);
    const tasks = {};
    for (const id of AI_TASKS) {
        const model = saved.models?.[id] || saved.model || '';
        const url = saved.modelBaseUrls?.[id] || saved.baseUrl || endpoints[0]?.url;
        const endpoint = endpoints.find(p => normalizeBaseUrl(p.url || '') === normalizeBaseUrl(url || ''));
        const providerId = model ? ensureEndpoint(url, endpoint?.apiKey ?? saved.apiKey ?? '', endpoint?.label) : undefined;
        tasks[id] = { ...(providerId ? { ref: { providerId, model } } : {}), reasoningEffort: saved.modelReasoningEfforts?.[id] ?? 'none' };
        const provider = config.providers.find(p => p.id === providerId);
        if (provider && !provider.modelsFetchedAt && !provider.models?.includes(model)) provider.models = [...(provider.models ?? []), model];
    }
    config.defaultModel ??= tasks.chat.ref ?? Object.values(tasks).find(t => t.ref)?.ref;
    const roomId = saved.mistllmRoomId?.trim();
    const roomProvide = {};
    if (roomId) {
        const room = createRoomProvider(config, { roomId });
        roomProvide[room.id] = { enabled: saved.networkProviderEnabled === true, shared: [] };
    }
    if (before !== JSON.stringify(config)) saveLlmConfig(config);
    return { ...saved, tasks, roomProvide };
}

export function getAiSettings() {
    const config = getSharedLlmConfig();
    let saved = readSettings(AI_SETTINGS_KEY);
    const oldest = !saved && readSettings('ai_settings');
    if (oldest) saved = importEndpoints(oldest, config);
    saved ||= {};
    if (!saved.tasks && (saved.taskPresetIds || saved.networkProviderPresetIds || saved.networkProviderEnabled !== undefined)) {
        const tasks = Object.fromEntries(AI_TASKS.map(id => {
            const presetId = saved.taskPresetIds?.[id];
            const preset = config.presets.find(p => p.id === presetId);
            return [id, {
                ref: presetIdToRef(config, presetId),
                reasoningEffort: saved.taskReasoningEfforts?.[id] ?? preset?.reasoningEffort ?? 'none',
            }];
        }));
        const room = config.providers.find(p => providerKind(p) === 'room' && p.baseUrl === `mist-network://${config.network.roomId.trim()}`);
        const shared = (saved.networkProviderPresetIds ?? []).map(id => presetIdToRef(config, id))
            .filter(ref => ref && config.providers.some(p => p.id === ref.providerId && providerKind(p) === 'http'));
        saved = { ...saved, tasks, roomProvide: room ? { [room.id]: { enabled: saved.networkProviderEnabled === true, shared } } : {} };
        const next = normalizeSettings(saved);
        localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(next));
        return next;
    }
    const next = normalizeSettings(saved);
    if (oldest) {
        localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(next));
        localStorage.removeItem('ai_settings');
    }
    return next;
}

export function saveAiSettings(settings) {
    localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(normalizeSettings(settings)));
    window.dispatchEvent(new Event(SETTINGS_EVENT));
}

export function subscribeAiSettings(callback) {
    const onStorage = event => { if (event.key === AI_SETTINGS_KEY || event.key === null) callback(); };
    window.addEventListener(SETTINGS_EVENT, callback);
    window.addEventListener('storage', onStorage);
    return () => {
        window.removeEventListener(SETTINGS_EVENT, callback);
        window.removeEventListener('storage', onStorage);
    };
}

export const llmLocalSettings = {
    get: getAiSettings,
    set: next => saveAiSettings({ ...getAiSettings(), ...next }),
    subscribe: subscribeAiSettings,
};
