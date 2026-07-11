import {
    MESSAGES_JA,
    MistaiError,
    fetchModels,
    formatMistaiError,
    streamChatCompletion,
} from '@tik-choco/mistai';
import { getExplanation, saveExplanation } from './storage';
import { getMistllmConsumer } from './mistllm';
import {
    emptyLlmConfig,
    ensurePreset,
    ensureProvider,
    loadLlmConfig,
    normalizeBaseUrl,
    resolvePreset,
    saveLlmConfig,
    subscribeLlmConfig,
} from './llmConfig';

export { subscribeLlmConfig };

export const REASONING_EFFORT_OPTIONS = ['none', 'minimal', 'low', 'medium', 'high'];
export const AI_BACKENDS = ['http', 'mistllm'];
export const AI_TASKS = ['explain', 'translate', 'chat', 'ocr'];
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

// New app-local settings key (task->preset mapping + app-local prefs only).
// Connection info (baseUrl/apiKey/model) now lives in the shared
// tc-shared-llm-config-v1 key (see ./llmConfig.js). The old 'ai_settings' key
// is migrated once (see migrateLegacyAiSettings below) and then removed.
const AI_SETTINGS_KEY = 'tc-pdf-viewer-ai-settings-v1';
const LEGACY_AI_SETTINGS_KEY = 'ai_settings';

const DEFAULT_SETTINGS = {
    backend: 'http',
    networkProviderEnabled: false,
    taskPresetIds: {
        explain: '',
        translate: '',
        chat: '',
        ocr: ''
    },
    promptTemplate: '以下の用語や文章を簡潔に、かつ専門的に解説してください:\n\n"{text}"',
    targetLanguages: ['日本語', 'English', '中国語', '韓国語', 'スペイン語']
};

function normalizeAiSettings(settings) {
    const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    const backend = AI_BACKENDS.includes(merged.backend) ? merged.backend : DEFAULT_SETTINGS.backend;
    const networkProviderEnabled = typeof merged.networkProviderEnabled === 'boolean'
        ? merged.networkProviderEnabled
        : DEFAULT_SETTINGS.networkProviderEnabled;

    const taskPresetIds = { ...DEFAULT_SETTINGS.taskPresetIds };
    AI_TASKS.forEach((task) => {
        const value = merged.taskPresetIds?.[task];
        taskPresetIds[task] = typeof value === 'string' ? value : '';
    });

    const promptTemplate = typeof merged.promptTemplate === 'string' && merged.promptTemplate
        ? merged.promptTemplate
        : DEFAULT_SETTINGS.promptTemplate;
    const targetLanguages = Array.isArray(merged.targetLanguages) && merged.targetLanguages.length
        ? merged.targetLanguages
        : DEFAULT_SETTINGS.targetLanguages;

    return { backend, networkProviderEnabled, taskPresetIds, promptTemplate, targetLanguages };
}

// ---------------------------------------------------------------------------
// One-time migration: 'ai_settings' (baseUrl/apiKey/models per task) -> the
// shared tc-shared-llm-config-v1 providers/presets + this app's local
// taskPresetIds. See protocol/docs/data-contracts/docs/llm-config.md
// "マイグレーション規則" for the merge-never-delete policy this follows.
// ---------------------------------------------------------------------------

function normalizeLegacyBaseUrl(baseUrl) {
    return (baseUrl || '').trim().replace(/\/$/, '');
}

function legacyDefaultBaseUrlLabel(baseUrl) {
    try {
        return new URL(baseUrl).host || baseUrl;
    } catch {
        return baseUrl;
    }
}

// Reconstructs a fully-populated view of the legacy shape from whatever
// partial/older object was actually stored, so the migration logic below can
// rely on every field being present. Deliberately independent of the current
// (post-migration) DEFAULT_SETTINGS shape.
function reconstructLegacySettings(saved) {
    if (saved.model && !saved.models) {
        saved.models = { explain: saved.model, translate: saved.model, chat: saved.model };
    }

    const baseUrlConfigsByUrl = new Map();
    (Array.isArray(saved.baseUrlConfigs) ? saved.baseUrlConfigs : []).forEach((config) => {
        const url = normalizeLegacyBaseUrl(config?.url);
        if (!url) return;
        const label = (config?.label || '').trim();
        baseUrlConfigsByUrl.set(url, {
            label: label || legacyDefaultBaseUrlLabel(url),
            url,
            apiKey: config?.apiKey || saved.apiKey || '',
        });
    });
    [...(Array.isArray(saved.baseUrls) ? saved.baseUrls : []), saved.baseUrl]
        .map(normalizeLegacyBaseUrl)
        .filter(Boolean)
        .forEach((url) => {
            if (baseUrlConfigsByUrl.has(url)) return;
            baseUrlConfigsByUrl.set(url, { label: legacyDefaultBaseUrlLabel(url), url, apiKey: saved.apiKey || '' });
        });

    const baseUrlConfigs = baseUrlConfigsByUrl.size
        ? Array.from(baseUrlConfigsByUrl.values())
        : [{ label: 'OpenAI', url: DEFAULT_BASE_URL, apiKey: saved.apiKey || '' }];
    const normalizedSavedBaseUrl = normalizeLegacyBaseUrl(saved.baseUrl);
    const baseUrl = baseUrlConfigsByUrl.has(normalizedSavedBaseUrl) ? normalizedSavedBaseUrl : baseUrlConfigs[0].url;

    const models = { explain: '', translate: '', chat: '', ocr: '', ...(saved.models || {}) };
    const modelBaseUrls = { explain: baseUrl, translate: baseUrl, chat: baseUrl, ocr: baseUrl, ...(saved.modelBaseUrls || {}) };
    const modelReasoningEfforts = { explain: 'none', translate: 'none', chat: 'none', ocr: 'none', ...(saved.modelReasoningEfforts || {}) };

    return {
        backend: AI_BACKENDS.includes(saved.backend) ? saved.backend : 'http',
        mistllmRoomId: typeof saved.mistllmRoomId === 'string' ? saved.mistllmRoomId : '',
        networkProviderEnabled: typeof saved.networkProviderEnabled === 'boolean' ? saved.networkProviderEnabled : false,
        baseUrl,
        baseUrlConfigs,
        apiKey: saved.apiKey || '',
        models,
        modelBaseUrls,
        modelReasoningEfforts,
        promptTemplate: typeof saved.promptTemplate === 'string' && saved.promptTemplate
            ? saved.promptTemplate
            : DEFAULT_SETTINGS.promptTemplate,
        targetLanguages: Array.isArray(saved.targetLanguages) && saved.targetLanguages.length
            ? saved.targetLanguages
            : DEFAULT_SETTINGS.targetLanguages,
    };
}

// Runs (at most once, idempotently) whenever the legacy 'ai_settings' key is
// still present. Returns the freshly-migrated local settings object, or null
// if there was nothing to migrate.
function migrateLegacyAiSettings() {
    let legacyRaw;
    try {
        legacyRaw = localStorage.getItem(LEGACY_AI_SETTINGS_KEY);
    } catch {
        return null;
    }
    if (!legacyRaw) return null;

    let legacy = null;
    try {
        legacy = JSON.parse(legacyRaw);
    } catch (e) {
        console.error('Failed to parse legacy ai_settings for migration:', e);
    }
    if (!legacy || typeof legacy !== 'object') {
        try { localStorage.removeItem(LEGACY_AI_SETTINGS_KEY); } catch { /* noop */ }
        return null;
    }

    const legacySettings = reconstructLegacySettings(legacy);
    const sharedConfig = loadLlmConfig() ?? emptyLlmConfig();

    const isPristineDefaultConfig = (config) =>
        normalizeBaseUrl(config.url) === normalizeBaseUrl(DEFAULT_BASE_URL) && !config.apiKey;
    const hasAnyModel = AI_TASKS.some((task) => (legacySettings.models[task] || '').trim());

    // Seed a provider for every registered base URL, except a never-touched
    // default OpenAI entry with no API key when no task has a model
    // configured anywhere (i.e. the user never actually used AI features).
    legacySettings.baseUrlConfigs
        .filter((config) => !(isPristineDefaultConfig(config) && !hasAnyModel))
        .forEach((config) => {
            ensureProvider(sharedConfig, { label: config.label, baseUrl: config.url, apiKey: config.apiKey || '' });
        });

    const taskPresetIds = { explain: '', translate: '', chat: '', ocr: '' };
    let firstCreatedPresetId = '';
    AI_TASKS.forEach((task) => {
        const model = (legacySettings.models[task] || '').trim();
        if (!model) return;

        const taskBaseUrl = legacySettings.modelBaseUrls[task] || legacySettings.baseUrl;
        const taskConfig = legacySettings.baseUrlConfigs.find(
            (config) => normalizeBaseUrl(config.url) === normalizeBaseUrl(taskBaseUrl)
        );
        const apiKey = taskConfig?.apiKey || legacySettings.apiKey || '';
        const providerId = ensureProvider(sharedConfig, {
            label: taskConfig?.label,
            baseUrl: taskBaseUrl,
            apiKey,
        });

        const reasoningEffort = legacySettings.modelReasoningEfforts[task];
        const presetId = ensurePreset(sharedConfig, {
            label: model,
            providerId,
            model,
            reasoningEffort: reasoningEffort && reasoningEffort !== 'none' ? reasoningEffort : undefined,
        });
        taskPresetIds[task] = presetId;
        if (!firstCreatedPresetId) firstCreatedPresetId = presetId;
    });

    if (!sharedConfig.defaultPresetId) {
        sharedConfig.defaultPresetId = taskPresetIds.chat || firstCreatedPresetId || '';
    }

    const roomId = (legacySettings.mistllmRoomId || '').trim();
    if (roomId && !sharedConfig.network.roomId) {
        sharedConfig.network.roomId = roomId;
    }

    saveLlmConfig(sharedConfig);

    const migratedLocal = normalizeAiSettings({
        backend: legacySettings.backend,
        networkProviderEnabled: legacySettings.networkProviderEnabled,
        taskPresetIds,
        promptTemplate: legacySettings.promptTemplate,
        targetLanguages: legacySettings.targetLanguages,
    });

    try {
        localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(migratedLocal));
    } catch (e) {
        console.error('Failed to persist migrated ai settings:', e);
    }
    try {
        localStorage.removeItem(LEGACY_AI_SETTINGS_KEY);
    } catch { /* noop */ }

    return migratedLocal;
}

export function getAiSettings() {
    const migrated = migrateLegacyAiSettings();
    if (migrated) return migrated;

    let savedString;
    try {
        savedString = localStorage.getItem(AI_SETTINGS_KEY);
    } catch {
        return normalizeAiSettings(DEFAULT_SETTINGS);
    }
    if (!savedString) return normalizeAiSettings(DEFAULT_SETTINGS);

    let saved = null;
    try {
        saved = JSON.parse(savedString);
    } catch (e) {
        console.error('Failed to parse AI settings:', e);
    }
    if (!saved || typeof saved !== 'object') return normalizeAiSettings(DEFAULT_SETTINGS);

    return normalizeAiSettings(saved);
}

export function saveAiSettings(settings) {
    try {
        localStorage.setItem(AI_SETTINGS_KEY, JSON.stringify(normalizeAiSettings(settings)));
    } catch (e) {
        console.error('Failed to persist AI settings:', e);
    }
}

// ---------------------------------------------------------------------------
// Shared LLM config (tc-shared-llm-config-v1) accessors/mutators used by
// SettingsPanel/Onboarding for the providers/presets editors and the network
// room id. All mutations go through the vendored ensureProvider/ensurePreset
// (append-only) or direct array edits followed by saveLlmConfig.
// ---------------------------------------------------------------------------

export function getSharedLlmConfig() {
    return loadLlmConfig() ?? emptyLlmConfig();
}

export function getNetworkRoomId() {
    return loadLlmConfig()?.network?.roomId || '';
}

export function setNetworkRoomId(roomId) {
    const config = getSharedLlmConfig();
    config.network = { roomId: (roomId || '').trim() };
    saveLlmConfig(config);
}

export function addLlmProvider({ label, baseUrl, apiKey }) {
    const config = getSharedLlmConfig();
    const id = ensureProvider(config, { label, baseUrl, apiKey: apiKey || '' });
    saveLlmConfig(config);
    return id;
}

export function updateLlmProvider(id, patch) {
    const config = getSharedLlmConfig();
    const provider = config.providers.find((p) => p.id === id);
    if (!provider) return;
    if (patch.label !== undefined) provider.label = patch.label;
    if (patch.baseUrl !== undefined) provider.baseUrl = normalizeBaseUrl(patch.baseUrl);
    if (patch.apiKey !== undefined) provider.apiKey = patch.apiKey;
    saveLlmConfig(config);
}

// Removes a provider and any presets that reference it (a preset whose
// provider no longer exists can't be resolved). Returns the ids of the
// presets that were removed so the caller can clear any local task/default
// references to them.
export function removeLlmProvider(id) {
    const config = getSharedLlmConfig();
    config.providers = config.providers.filter((p) => p.id !== id);
    const removedPresetIds = config.presets.filter((p) => p.providerId === id).map((p) => p.id);
    config.presets = config.presets.filter((p) => p.providerId !== id);
    if (removedPresetIds.includes(config.defaultPresetId)) config.defaultPresetId = '';
    saveLlmConfig(config);
    return removedPresetIds;
}

export function addLlmPreset({ label, providerId, model, temperature, reasoningEffort }) {
    const config = getSharedLlmConfig();
    const id = ensurePreset(config, { label, providerId, model, temperature, reasoningEffort });
    saveLlmConfig(config);
    return id;
}

export function updateLlmPreset(id, patch) {
    const config = getSharedLlmConfig();
    const preset = config.presets.find((p) => p.id === id);
    if (!preset) return;
    if (patch.label !== undefined) preset.label = patch.label;
    if (patch.providerId !== undefined) preset.providerId = patch.providerId;
    if (patch.model !== undefined) preset.model = patch.model;
    if (patch.reasoningEffort !== undefined) {
        if (patch.reasoningEffort) preset.reasoningEffort = patch.reasoningEffort;
        else delete preset.reasoningEffort;
    }
    if (patch.temperature !== undefined) {
        if (patch.temperature !== null && patch.temperature !== '') preset.temperature = Number(patch.temperature);
        else delete preset.temperature;
    }
    saveLlmConfig(config);
}

export function removeLlmPreset(id) {
    const config = getSharedLlmConfig();
    config.presets = config.presets.filter((p) => p.id !== id);
    if (config.defaultPresetId === id) config.defaultPresetId = '';
    saveLlmConfig(config);
}

export function setDefaultLlmPresetId(id) {
    const config = getSharedLlmConfig();
    config.defaultPresetId = id || '';
    saveLlmConfig(config);
}

export function setDefaultLlmPresetIdIfEmpty(id) {
    const config = getSharedLlmConfig();
    if (config.defaultPresetId) return;
    config.defaultPresetId = id;
    saveLlmConfig(config);
}

// Resolves the connection/model to use for `task`, falling back to the
// 'chat' task's preset and then the shared default preset (see
// docs/data-contracts/docs/llm-config.md "解決規則").
function resolveTaskTarget(settings, task) {
    const config = getSharedLlmConfig();
    return (
        resolvePreset(config, settings.taskPresetIds?.[task]) ||
        resolvePreset(config, settings.taskPresetIds?.chat) ||
        resolvePreset(config)
    );
}

// Resolves the 'chat' task's target; used by the LLM network provider role
// (see hooks/useNetworkProvider.js) and by Onboarding to prefill/test.
export function resolveUpstreamProviderTarget() {
    return resolveTaskTarget(getAiSettings(), 'chat');
}

const explanationCache = new Map();
const EXPLANATION_CONTEXT_MAX_CHARS = 12000;

function hashText(value) {
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
        hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
    }
    return hash.toString(36);
}

function buildExplanationPrompt(text, { contextMarkdown = '', pdfName = '' } = {}) {
    const trimmedContext = (contextMarkdown || '').trim();
    if (!trimmedContext) {
        const settings = getAiSettings();
        return settings.promptTemplate.replace('{text}', text);
    }

    const clippedContext = trimmedContext.length > EXPLANATION_CONTEXT_MAX_CHARS
        ? `${trimmedContext.slice(0, EXPLANATION_CONTEXT_MAX_CHARS)}\n\n[OCR Markdown truncated]`
        : trimmedContext;

    return [
        '以下はPDFをOCR化したMarkdownです。この文脈を優先して、選択された用語や文章を簡潔かつ専門的に解説してください。',
        pdfName ? `PDF: ${pdfName}` : '',
        '',
        '選択テキスト:',
        `"${text}"`,
        '',
        'OCR Markdown:',
        clippedContext
    ].filter(Boolean).join('\n');
}

export async function explainText(text, options = {}) {
    const contextMarkdown = (options.contextMarkdown || '').trim();
    const cacheKey = contextMarkdown
        ? `context:${options.pdfName || ''}:${text}:${hashText(contextMarkdown)}`
        : text;
    if (explanationCache.has(cacheKey)) return explanationCache.get(cacheKey);

    if (!contextMarkdown) {
        try {
            const persistent = await getExplanation(text);
            if (persistent) {
                explanationCache.set(cacheKey, persistent);
                return persistent;
            }
        } catch (e) {
            console.warn('Persistent cache unavailable:', e);
        }
    }

    const prompt = buildExplanationPrompt(text, {
        contextMarkdown,
        pdfName: options.pdfName || ''
    });
    const result = await chatAi([{ role: 'user', content: prompt }], 'explain');

    explanationCache.set(cacheKey, result);
    if (!contextMarkdown) {
        saveExplanation(text, result).catch(e => console.error('Failed to save to Mist:', e));
    }

    return result;
}

export async function translateText(text, targetLanguage = '日本語') {
    const prompt = [
        `Translate into ${targetLanguage}. Output only the translation.`,
        '',
        text
    ].join('\n');
    return await chatAi(buildTranslationMessages(prompt, targetLanguage), 'translate');
}

const OCR_SUMMARY_MAX_CHARS = 12000;

export async function summarizeOcrMarkdown(markdown, { fileName = 'document.pdf', signal = null } = {}) {
    const trimmedMarkdown = (markdown || '').trim();
    if (!trimmedMarkdown) return '';

    const clippedMarkdown = trimmedMarkdown.length > OCR_SUMMARY_MAX_CHARS
        ? `${trimmedMarkdown.slice(0, OCR_SUMMARY_MAX_CHARS)}\n\n[OCR Markdown truncated]`
        : trimmedMarkdown;
    const prompt = [
        `PDF "${fileName}" のOCR Markdownを読み、サイドバーのプレビュー用に日本語で短く概要化してください。`,
        '出力は3から5個の短い項目にしてください。',
        'Markdownの表は使わないでください。',
        '各項目は「**ラベル**」の次の行に、2スペース以上インデントして詳細を書く形式にしてください。',
        '本文にないことは推測しないでください。',
        '',
        clippedMarkdown
    ].join('\n');

    return await chatAi([{ role: 'user', content: prompt }], 'chat', { timeoutMs: 120000, signal });
}

const MARKDOWN_TRANSLATION_CHUNK_SIZE = 4500;
const MARKDOWN_TRANSLATION_MIN_RETRY_CHUNK_SIZE = 1200;
const MARKDOWN_TRANSLATION_CONCURRENCY = 2;

function throwIfAborted(signal) {
    if (signal?.aborted) {
        const error = new Error('Request cancelled.');
        error.name = 'AbortError';
        throw error;
    }
}

export async function translateMarkdown(markdown, targetLanguage = '日本語', onProgress = null, options = {}) {
    const { signal = null } = options;
    throwIfAborted(signal);
    const chunks = splitMarkdownForTranslation(markdown);
    const translatedChunks = Array(chunks.length).fill('');
    const completedChunks = Array(chunks.length).fill(false);
    let completed = 0;
    let nextIndex = 0;
    let failed = false;

    const notifyProgress = () => {
        const visibleChunks = [];
        for (let i = 0; i < translatedChunks.length; i++) {
            if (!translatedChunks[i] && !completedChunks[i]) break;
            visibleChunks.push(translatedChunks[i]);
            if (!completedChunks[i]) break;
        }

        onProgress?.({
            done: completed,
            total: chunks.length,
            translatedMarkdown: visibleChunks.join('\n\n')
        });
    };

    const translateNextChunk = async () => {
        while (!failed && nextIndex < chunks.length) {
            throwIfAborted(signal);
            const index = nextIndex;
            nextIndex += 1;

            try {
                const translated = await translateMarkdownChunkWithRetry(chunks[index], targetLanguage, {
                    chunkNumber: index + 1,
                    totalChunks: chunks.length,
                    signal,
                    onPartial: (partial) => {
                        translatedChunks[index] = partial;
                        notifyProgress();
                    }
                });
                translatedChunks[index] = translated.trim();
                completedChunks[index] = true;
                completed += 1;
                notifyProgress();
            } catch (err) {
                failed = true;
                throw err;
            }
        }
    };

    notifyProgress();
    throwIfAborted(signal);
    const workerCount = Math.min(MARKDOWN_TRANSLATION_CONCURRENCY, chunks.length);
    await Promise.all(Array.from({ length: workerCount }, () => translateNextChunk()));

    return translatedChunks.map(chunk => chunk.trim()).join('\n\n');
}

async function translateMarkdownChunkWithRetry(markdown, targetLanguage, { chunkNumber = 1, totalChunks = 1, onPartial = null, signal = null } = {}) {
    throwIfAborted(signal);
    try {
        return await translateMarkdownChunk(markdown, targetLanguage, { chunkNumber, totalChunks, onPartial, signal });
    } catch (err) {
        throwIfAborted(signal);
        if (!isTimeoutError(err) || markdown.length <= MARKDOWN_TRANSLATION_MIN_RETRY_CHUNK_SIZE) {
            throw err;
        }

        const smallerChunks = splitMarkdownForTranslation(
            markdown,
            Math.max(MARKDOWN_TRANSLATION_MIN_RETRY_CHUNK_SIZE, Math.floor(markdown.length / 2))
        );
        if (smallerChunks.length <= 1 && smallerChunks[0] === markdown) {
            throw err;
        }

        const translatedChunks = [];
        onPartial?.('');
        for (let i = 0; i < smallerChunks.length; i++) {
            const translated = await translateMarkdownChunkWithRetry(smallerChunks[i], targetLanguage, {
                chunkNumber: `${chunkNumber}.${i + 1}`,
                totalChunks,
                signal,
                onPartial: (partial) => {
                    const nextChunks = [...translatedChunks, partial];
                    onPartial(nextChunks.join('\n\n'));
                }
            });
            translatedChunks.push(translated.trim());
            onPartial?.(translatedChunks.join('\n\n'));
        }
        return translatedChunks.join('\n\n');
    }
}

async function translateMarkdownChunk(markdown, targetLanguage, { chunkNumber = 1, totalChunks = 1, onPartial = null, signal = null } = {}) {
    throwIfAborted(signal);
    const prompt = [
        `Translate this Markdown chunk into ${targetLanguage}. Chunk ${chunkNumber}/${totalChunks}.`,
        'Preserve Markdown. Translate prose and table text. Do not translate code fences.',
        'Output only the translated Markdown.',
        '',
        markdown
    ].join('\n');

    return await chatAi(buildTranslationMessages(prompt, targetLanguage), 'translate', {
        stream: true,
        timeoutMs: 120000,
        signal,
        onDelta: (_delta, content) => onPartial?.(content)
    });
}

function buildTranslationMessages(prompt, targetLanguage) {
    return [
        {
            role: 'system',
            content: `Translate into ${targetLanguage}. Return only the translation; no source text, bilingual pairs, or commentary.`
        },
        { role: 'user', content: prompt }
    ];
}

function splitMarkdownForTranslation(markdown, maxChars = MARKDOWN_TRANSLATION_CHUNK_SIZE) {
    if (!markdown || markdown.length <= maxChars) return [markdown || ''];

    const chunks = [];
    const lines = markdown.split('\n');
    let current = [];
    let currentLength = 0;
    let inFence = false;

    const flush = () => {
        if (!current.length) return;
        chunks.push(current.join('\n'));
        current = [];
        currentLength = 0;
    };

    for (const line of lines) {
        const lineLength = line.length + 1;
        const isFenceLine = /^\s*(```|~~~)/.test(line);
        const isBoundary = line.trim() === '' || /^#{1,6}\s+/.test(line) || /^<!--\s*Page\s+\d+\s*-->$/.test(line.trim());

        if (!inFence && currentLength + lineLength > maxChars && isBoundary) {
            flush();
        } else if (!inFence && currentLength > maxChars) {
            flush();
        }

        current.push(line);
        currentLength += lineLength;

        if (isFenceLine) {
            inFence = !inFence;
        }
    }

    flush();
    return chunks.filter(chunk => chunk.trim().length > 0);
}

function isTimeoutError(err) {
    return err?.name === 'AbortError' || /タイムアウト|timeout/i.test(err?.message || '');
}

// ライブラリのUPSTREAM_HTTP_ERRORメッセージは「... (status): {レスポンスボディ}」の形で
// 上流のボディを含むので、OpenAI互換の error.message を従来どおり取り出して表示する。
// 取り出せない（JSONでない・切り詰められている）場合はnullを返す。
function extractUpstreamApiErrorMessage(err) {
    const separator = '): ';
    const bodyIndex = (err.message || '').indexOf(separator);
    if (bodyIndex < 0) return null;
    try {
        const body = JSON.parse(err.message.slice(bodyIndex + separator.length));
        return body?.error?.message || null;
    } catch {
        return null;
    }
}

// MistaiErrorを、このモジュールが従来投げていた日本語メッセージのErrorへ変換する。
// それ以外のエラーはそのまま返す。
function localizeUpstreamError(err) {
    if (!(err instanceof MistaiError)) return err;
    if (err.code === 'UPSTREAM_HTTP_ERROR') {
        const upstreamMessage = extractUpstreamApiErrorMessage(err);
        const status = err.details?.status;
        return new Error(upstreamMessage || (status ? `APIリクエストに失敗しました: ${status}` : formatMistaiError(err, MESSAGES_JA)));
    }
    if (err.code === 'UPSTREAM_REQUEST_FAILED' && err.message.includes('Failed to fetch')) {
        return new Error('API通信エラー（CORSまたはMixed Contentの可能性があります）');
    }
    return new Error(formatMistaiError(err, MESSAGES_JA));
}
async function chatAiViaMistllm(settings, messages, task, options) {
    const roomId = getNetworkRoomId();
    if (!roomId) throw new Error('Mist LLM Room IDが設定されていません。');

    const consumer = getMistllmConsumer();
    if (consumer.roomId !== roomId || consumer.status === 'idle' || consumer.status === 'error') {
        await consumer.connect(roomId);
    }
    // chat() internally awaits waitForProvider() (10s timeout) if a provider
    // hasn't announced itself yet, so no extra wait is needed here.

    const resolved = resolveTaskTarget(settings, task);
    const result = await consumer.chat(messages, {
        model: resolved?.model || undefined,
        onChunk: options.onDelta,
        signal: options.signal,
        timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
    });
    return result.trim();
}

const DEFAULT_TIMEOUT_MS = 30000;

export async function chatAi(messages, task = 'chat', options = {}) {
    const settings = getAiSettings();

    if (settings.backend === 'mistllm') {
        return await chatAiViaMistllm(settings, messages, task, options);
    }

    const resolved = resolveTaskTarget(settings, task);
    if (!resolved) throw new Error('AIモデルが設定されていません。AI設定でプリセットを選択してください。');
    if (!resolved.baseUrl) throw new Error('AI Base URLが設定されていません。');
    if (!resolved.apiKey) throw new Error('APIキーが設定されていません。');
    if (!resolved.model) throw new Error('AIモデルが設定されていません。AI設定でモデルを選択してください。');

    if (options.signal?.aborted) {
        const error = new Error('Request cancelled.');
        error.name = 'AbortError';
        throw error;
    }

    // streamChatCompletionはAbortSignalを受け取らないため、タイムアウトと外部からの
    // キャンセルは、fetchFn差し込みで自前のsignalを注入して実現する。
    const controller = new AbortController();
    let didTimeout = false;
    const timeoutId = setTimeout(() => {
        didTimeout = true;
        controller.abort();
    }, options.timeoutMs || DEFAULT_TIMEOUT_MS);
    const handleExternalAbort = () => controller.abort();
    options.signal?.addEventListener('abort', handleExternalAbort, { once: true });

    let content = '';
    const handleDelta = (delta) => {
        content += delta;
        options.onDelta?.(delta, content);
    };

    try {
        const result = await streamChatCompletion(
            {
                baseUrl: resolved.baseUrl,
                apiKey: resolved.apiKey,
                model: resolved.model,
                reasoningEffort: resolved.reasoningEffort || 'none',
                ...(resolved.temperature !== undefined ? { temperature: resolved.temperature } : {}),
            },
            messages,
            options.onDelta ? handleDelta : undefined,
            (url, init) => fetch(url, { ...init, signal: controller.signal })
        );
        return result.trim();
    } catch (err) {
        console.error(`AI Request to ${resolved.baseUrl}/chat/completions failed:`, err);
        if (didTimeout) {
            throw new Error('リクエストがタイムアウトしました。');
        }
        if (options.signal?.aborted) {
            const error = new Error('Request cancelled.');
            error.name = 'AbortError';
            throw error;
        }
        throw localizeUpstreamError(err);
    } finally {
        clearTimeout(timeoutId);
        options.signal?.removeEventListener('abort', handleExternalAbort);
    }
}

export async function ocrImagesToMarkdown(images, { fileName = 'document.pdf', signal = null } = {}) {
    if (!images?.length) throw new Error('OCR対象の画像がありません。');
    throwIfAborted(signal);

    const content = [
        {
            type: 'text',
            text: [
                `The attached images are pages from "${fileName}".`,
                'OCR every visible page and return raw Markdown only.',
                'Recreate the document structure with Markdown headings, paragraphs, lists, tables, captions, and page breaks.',
                'Preserve reading order and all visible text. Do not summarize, explain, or add commentary.',
                'Do not wrap the output in code fences.',
                'Mark uncertain text with [?]. Insert <!-- Page N --> before each page.'
            ].join('\n')
        },
        ...images.flatMap(image => ([
            { type: 'text', text: `Page ${image.pageNumber}` },
            {
                type: 'image_url',
                image_url: {
                    url: image.dataUrl,
                    detail: 'high'
                }
            }
        ]))
    ];

    return await chatAi([{ role: 'user', content }], 'ocr', { signal });
}

// Fetches the model list for a given (baseUrl, apiKey) connection, used by
// the providers/presets editors in SettingsPanel/Onboarding.
export async function getAvailableModels({ baseUrl, apiKey } = {}) {
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl || '');
    if (!normalizedBaseUrl) {
        console.warn('AI Base URL is empty.');
        return [];
    }
    if (!apiKey) return [];

    try {
        const models = await fetchModels({ baseUrl: normalizedBaseUrl, apiKey });
        return [...models].sort();
    } catch (err) {
        console.error(`Failed to fetch models from ${normalizedBaseUrl}/models:`, err);
        // Special hint for CORS/Mixed Content
        if (err instanceof MistaiError && err.code === 'UPSTREAM_REQUEST_FAILED' && err.message.includes('Failed to fetch')) {
            console.error('This is likely a CORS or Mixed Content (HTTPS to HTTP) error. Check your API endpoint and browser console.');
        }
        return [];
    }
}

/**
 * Streaming upstream chat completion used by the LLM network provider role
 * (see hooks/useNetworkProvider.js) to forward llm_request traffic to the
 * user's own configured HTTP AI backend, regardless of which backend
 * ('http' | 'mistllm') is currently selected for this device's own use —
 * the provider always calls out over HTTP, never routes through itself.
 * The upstream call itself is the shared streamChatCompletion; this wrapper
 * resolves the connection/model from the shared config's 'chat' task preset.
 */
export async function streamUpstreamChatCompletion(messages, model, onDelta) {
    const resolved = resolveUpstreamProviderTarget();
    if (!resolved || !resolved.baseUrl) throw new Error('AI Base URLが設定されていません。');
    if (!resolved.apiKey) throw new Error('APIキーが設定されていません。');

    const resolvedModel = (model || resolved.model || '').trim();
    if (!resolvedModel) throw new Error('AIモデルが設定されていません。');

    let result;
    try {
        result = await streamChatCompletion(
            {
                baseUrl: resolved.baseUrl,
                apiKey: resolved.apiKey,
                model: resolvedModel,
                reasoningEffort: resolved.reasoningEffort || 'none',
                ...(resolved.temperature !== undefined ? { temperature: resolved.temperature } : {}),
            },
            messages,
            (delta) => onDelta?.(delta)
        );
    } catch (err) {
        throw localizeUpstreamError(err);
    }

    if (!result.trim()) throw new Error('プロバイダの応答が空でした。');
    return result;
}

export async function testAiConnection({ baseUrl, apiKey } = {}) {
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl || '');
    if (!normalizedBaseUrl) throw new Error('AI Base URLが設定されていません。');
    if (!apiKey) throw new Error('APIキーが設定されていません。');

    try {
        const models = await fetchModels({ baseUrl: normalizedBaseUrl, apiKey });
        return {
            ok: true,
            modelCount: models.length
        };
    } catch (err) {
        if (err instanceof MistaiError) {
            // モデル一覧が空・想定外の形式でも、従来どおり接続自体は成功として扱う。
            if (err.code === 'MODEL_LIST_EMPTY' || err.code === 'UPSTREAM_BAD_RESPONSE') {
                return { ok: true, modelCount: 0 };
            }
            if (err.code === 'UPSTREAM_HTTP_ERROR') {
                const upstreamMessage = extractUpstreamApiErrorMessage(err);
                const status = err.details?.status;
                throw new Error(`API応答エラー: ${upstreamMessage || status || formatMistaiError(err, MESSAGES_JA)}`);
            }
            if (err.code === 'UPSTREAM_REQUEST_FAILED') {
                throw new Error('APIに到達できません。Base URL、ネットワーク、CORS、Mixed Content（HTTPSページからHTTP API）を確認してください。');
            }
        }
        throw err;
    }
}
