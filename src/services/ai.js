import {
    MESSAGES_JA,
    MistaiError,
    fetchModels,
    formatMistaiError,
    streamChatCompletion,
} from '@tik-choco/mistai';
import { getExplanation, saveExplanation } from './storage';
import { getMistllmConsumer } from './mistllm';

export const DEFAULT_MODELS = [];
export const REASONING_EFFORT_OPTIONS = ['none', 'minimal', 'low', 'medium', 'high'];
export const AI_BACKENDS = ['http', 'mistllm'];
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

const DEFAULT_SETTINGS = {
    backend: 'http',
    mistllmRoomId: '',
    networkProviderEnabled: false,
    baseUrl: DEFAULT_BASE_URL,
    baseUrls: [DEFAULT_BASE_URL],
    baseUrlConfigs: [{ label: 'OpenAI', url: DEFAULT_BASE_URL, apiKey: '' }],
    apiKey: '',
    models: {
        explain: '',
        translate: '',
        chat: '',
        ocr: ''
    },
    modelBaseUrls: {
        explain: DEFAULT_BASE_URL,
        translate: DEFAULT_BASE_URL,
        chat: DEFAULT_BASE_URL,
        ocr: DEFAULT_BASE_URL
    },
    modelReasoningEfforts: {
        explain: 'none',
        translate: 'none',
        chat: 'none',
        ocr: 'none'
    },
    promptTemplate: '以下の用語や文章を簡潔に、かつ専門的に解説してください:\n\n"{text}"',
    reasoningEffort: 'none',
    targetLanguages: ['日本語', 'English', '中国語', '韓国語', 'スペイン語']
};

function normalizeBaseUrl(baseUrl) {
    return (baseUrl || '').trim().replace(/\/$/, '');
}

function defaultBaseUrlLabel(baseUrl) {
    try {
        return new URL(baseUrl).host || baseUrl;
    } catch {
        return baseUrl;
    }
}

function getBaseUrlList(settings) {
    const urls = [
        ...(Array.isArray(settings?.baseUrls) ? settings.baseUrls : []),
        ...(Array.isArray(settings?.baseUrlConfigs) ? settings.baseUrlConfigs.map((config) => config?.url) : []),
        settings?.baseUrl,
    ]
        .map(normalizeBaseUrl)
        .filter(Boolean);

    return Array.from(new Set(urls));
}

function getBaseUrlConfigs(settings) {
    const configsByUrl = new Map();

    if (Array.isArray(settings?.baseUrlConfigs)) {
        settings.baseUrlConfigs.forEach((config) => {
            const url = normalizeBaseUrl(config?.url);
            if (!url) return;
            const label = (config?.label || '').trim();
            const hasOwnApiKey = Object.prototype.hasOwnProperty.call(config, 'apiKey');
            const existing = configsByUrl.get(url);
            configsByUrl.set(url, {
                label: label || existing?.label || defaultBaseUrlLabel(url),
                url,
                apiKey: hasOwnApiKey ? (config.apiKey || '') : (existing?.apiKey || settings?.apiKey || ''),
            });
        });
    }

    getBaseUrlList(settings).forEach((url) => {
        if (configsByUrl.has(url)) return;
        configsByUrl.set(url, {
            label: defaultBaseUrlLabel(url),
            url,
            apiKey: settings?.apiKey || '',
        });
    });

    return Array.from(configsByUrl.values());
}

function normalizeAiSettings(settings) {
    const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    const baseUrlConfigs = getBaseUrlConfigs(merged);
    const baseUrls = baseUrlConfigs.map((config) => config.url);
    const fallbackBaseUrl = baseUrls[0] || DEFAULT_BASE_URL;
    const baseUrl = baseUrls.includes(normalizeBaseUrl(merged.baseUrl))
        ? normalizeBaseUrl(merged.baseUrl)
        : fallbackBaseUrl;
    const modelBaseUrls = { ...DEFAULT_SETTINGS.modelBaseUrls, ...merged.modelBaseUrls };
    const fallbackReasoningEffort = REASONING_EFFORT_OPTIONS.includes(merged.reasoningEffort)
        ? merged.reasoningEffort
        : DEFAULT_SETTINGS.reasoningEffort;
    const modelReasoningEfforts = {
        ...DEFAULT_SETTINGS.modelReasoningEfforts,
        ...Object.fromEntries(Object.keys(DEFAULT_SETTINGS.models).map((task) => [task, fallbackReasoningEffort])),
        ...(merged.modelReasoningEfforts || {})
    };

    Object.keys(DEFAULT_SETTINGS.models).forEach((task) => {
        const taskBaseUrl = normalizeBaseUrl(modelBaseUrls[task]);
        modelBaseUrls[task] = baseUrls.includes(taskBaseUrl) ? taskBaseUrl : baseUrl;
        if (!REASONING_EFFORT_OPTIONS.includes(modelReasoningEfforts[task])) {
            modelReasoningEfforts[task] = DEFAULT_SETTINGS.modelReasoningEfforts[task];
        }
    });

    const backend = AI_BACKENDS.includes(merged.backend) ? merged.backend : DEFAULT_SETTINGS.backend;
    const mistllmRoomId = typeof merged.mistllmRoomId === 'string' ? merged.mistllmRoomId : DEFAULT_SETTINGS.mistllmRoomId;
    const networkProviderEnabled = typeof merged.networkProviderEnabled === 'boolean'
        ? merged.networkProviderEnabled
        : DEFAULT_SETTINGS.networkProviderEnabled;

    return {
        ...merged,
        backend,
        mistllmRoomId,
        networkProviderEnabled,
        baseUrl,
        baseUrls,
        baseUrlConfigs,
        models: { ...DEFAULT_SETTINGS.models, ...merged.models },
        modelBaseUrls,
        modelReasoningEfforts,
        reasoningEffort: fallbackReasoningEffort
    };
}

export function getAiSettings() {
    const savedString = localStorage.getItem('ai_settings');
    if (!savedString) return DEFAULT_SETTINGS;
    
    let saved = null;
    try {
        saved = JSON.parse(savedString);
    } catch (e) {
        console.error('Failed to parse AI settings:', e);
    }
    
    if (!saved || typeof saved !== 'object') return DEFAULT_SETTINGS;
    
    if (saved.model && !saved.models) {
        saved.models = {
            explain: saved.model,
            translate: saved.model,
            chat: saved.model
        };
        delete saved.model;
    }

    return normalizeAiSettings(saved);
}

export function saveAiSettings(settings) {
    localStorage.setItem('ai_settings', JSON.stringify(normalizeAiSettings(settings)));
}

export function getRegisteredBaseUrls(settingsOverride = null) {
    return getBaseUrlList(settingsOverride || getAiSettings());
}

export function getRegisteredBaseUrlConfigs(settingsOverride = null) {
    return getBaseUrlConfigs(settingsOverride || getAiSettings());
}

function getBaseUrlForTask(settings, task = 'chat') {
    const normalized = normalizeAiSettings(settings);
    return normalized.modelBaseUrls?.[task] || normalized.baseUrl;
}

function getApiKeyForBaseUrl(settings, baseUrl) {
    const normalized = normalizeAiSettings(settings);
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    const config = normalized.baseUrlConfigs.find((item) => item.url === normalizedBaseUrl);
    return config?.apiKey || normalized.apiKey || '';
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
    const roomId = (settings.mistllmRoomId || '').trim();
    if (!roomId) throw new Error('Mist LLM Room IDが設定されていません。');

    const consumer = getMistllmConsumer();
    if (consumer.roomId !== roomId || consumer.status === 'idle' || consumer.status === 'error') {
        await consumer.connect(roomId);
    }
    // chat() internally awaits waitForProvider() (10s timeout) if a provider
    // hasn't announced itself yet, so no extra wait is needed here.

    const model = settings.models?.[task] || settings.models?.chat || undefined;
    const result = await consumer.chat(messages, {
        model,
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

    const baseUrl = getBaseUrlForTask(settings, task);
    if (!baseUrl) throw new Error('AI Base URLが設定されていません。');

    const apiKey = getApiKeyForBaseUrl(settings, baseUrl);
    if (!apiKey) throw new Error('APIキーが設定されていません。');

    const model = settings.models?.[task] || settings.models?.chat;
    if (!model) throw new Error('AIモデルが設定されていません。AI設定でモデルを選択してください。');

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
                baseUrl,
                apiKey,
                model,
                reasoningEffort: settings.modelReasoningEfforts?.[task] || DEFAULT_SETTINGS.modelReasoningEfforts.chat,
            },
            messages,
            options.onDelta ? handleDelta : undefined,
            (url, init) => fetch(url, { ...init, signal: controller.signal })
        );
        return result.trim();
    } catch (err) {
        console.error(`AI Request to ${baseUrl}/chat/completions failed:`, err);
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

export async function getAvailableModels(settingsOverride = null) {
    const settings = settingsOverride || getAiSettings();

    const baseUrl = normalizeBaseUrl(settings.baseUrl);
    if (!baseUrl) {
        console.warn('AI Base URL is empty. Please set it in settings.');
        return [];
    }

    const apiKey = getApiKeyForBaseUrl(settings, baseUrl);
    if (!apiKey) return [];

    try {
        const models = await fetchModels({ baseUrl, apiKey });
        return [...models].sort();
    } catch (err) {
        console.error(`Failed to fetch models from ${baseUrl}/models:`, err);
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
 * resolves the base URL / API key / model from the app settings.
 */
export async function streamUpstreamChatCompletion(messages, model, onDelta) {
    const settings = getAiSettings();
    const baseUrl = getBaseUrlForTask(settings, 'chat');
    if (!baseUrl) throw new Error('AI Base URLが設定されていません。');

    const apiKey = getApiKeyForBaseUrl(settings, baseUrl);
    if (!apiKey) throw new Error('APIキーが設定されていません。');

    const resolvedModel = (model || settings.models?.chat || '').trim();
    if (!resolvedModel) throw new Error('AIモデルが設定されていません。');

    let result;
    try {
        result = await streamChatCompletion(
            {
                baseUrl,
                apiKey,
                model: resolvedModel,
                reasoningEffort: settings.modelReasoningEfforts?.chat || DEFAULT_SETTINGS.modelReasoningEfforts.chat,
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

export async function testAiConnection(settingsOverride = null) {
    const settings = settingsOverride || getAiSettings();

    const baseUrl = normalizeBaseUrl(settings.baseUrl);
    if (!baseUrl) throw new Error('AI Base URLが設定されていません。');

    const apiKey = getApiKeyForBaseUrl(settings, baseUrl);
    if (!apiKey) throw new Error('APIキーが設定されていません。');

    try {
        const models = await fetchModels({ baseUrl, apiKey });
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

