import { getExplanation, saveExplanation } from './storage';

export const DEFAULT_MODELS = [];
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

const DEFAULT_SETTINGS = {
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
    promptTemplate: '以下の用語や文章を簡潔に、かつ専門的に解説してください:\n\n"{text}"',
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

    Object.keys(DEFAULT_SETTINGS.models).forEach((task) => {
        const taskBaseUrl = normalizeBaseUrl(modelBaseUrls[task]);
        modelBaseUrls[task] = baseUrls.includes(taskBaseUrl) ? taskBaseUrl : baseUrl;
    });

    return {
        ...merged,
        baseUrl,
        baseUrls,
        baseUrlConfigs,
        models: { ...DEFAULT_SETTINGS.models, ...merged.models },
        modelBaseUrls
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

export async function explainText(text) {
    if (explanationCache.has(text)) return explanationCache.get(text);

    try {
        const persistent = await getExplanation(text);
        if (persistent) {
            explanationCache.set(text, persistent);
            return persistent;
        }
    } catch (e) {
        console.warn('Persistent cache unavailable:', e);
    }

    const settings = getAiSettings();
    const prompt = settings.promptTemplate.replace('{text}', text);
    const result = await chatAi([{ role: 'user', content: prompt }], 'explain');
    
    explanationCache.set(text, result);
    saveExplanation(text, result).catch(e => console.error('Failed to save to Mist:', e));
    
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

const MARKDOWN_TRANSLATION_CHUNK_SIZE = 4500;
const MARKDOWN_TRANSLATION_MIN_RETRY_CHUNK_SIZE = 1200;
const MARKDOWN_TRANSLATION_CONCURRENCY = 2;

export async function translateMarkdown(markdown, targetLanguage = '日本語', onProgress = null) {
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
            const index = nextIndex;
            nextIndex += 1;

            try {
                const translated = await translateMarkdownChunkWithRetry(chunks[index], targetLanguage, {
                    chunkNumber: index + 1,
                    totalChunks: chunks.length,
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
    const workerCount = Math.min(MARKDOWN_TRANSLATION_CONCURRENCY, chunks.length);
    await Promise.all(Array.from({ length: workerCount }, () => translateNextChunk()));

    return translatedChunks.map(chunk => chunk.trim()).join('\n\n');
}

async function translateMarkdownChunkWithRetry(markdown, targetLanguage, { chunkNumber = 1, totalChunks = 1, onPartial = null } = {}) {
    try {
        return await translateMarkdownChunk(markdown, targetLanguage, { chunkNumber, totalChunks, onPartial });
    } catch (err) {
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

async function translateMarkdownChunk(markdown, targetLanguage, { chunkNumber = 1, totalChunks = 1, onPartial = null } = {}) {
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
export async function chatAi(messages, task = 'chat', options = {}) {
    const settings = getAiSettings();

    const baseUrl = getBaseUrlForTask(settings, task);
    if (!baseUrl) throw new Error('AI Base URLが設定されていません。');

    const apiKey = getApiKeyForBaseUrl(settings, baseUrl);
    if (!apiKey) throw new Error('APIキーが設定されていません。');

    const model = settings.models?.[task] || settings.models?.chat;
    if (!model) throw new Error('AIモデルが設定されていません。AI設定でモデルを選択してください。');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || 30000);

    const url = `${baseUrl}/chat/completions`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: model,
                messages: messages,
                ...(options.stream ? { stream: true } : {})
            })
        });

        if (!response.ok) {
            clearTimeout(timeoutId);
            const error = await response.json().catch(() => ({}));
            const msg = error.error?.message || `APIリクエストに失敗しました: ${response.status} ${response.statusText}`;
            console.error(`AI Error from ${url}:`, msg);
            throw new Error(msg);
        }

        if (options.stream) {
            const result = await readChatCompletionStream(response, options.onDelta);
            clearTimeout(timeoutId);
            return result.trim();
        }

        clearTimeout(timeoutId);
        const data = await response.json();
        return data.choices[0].message.content.trim();
    } catch (err) {
        clearTimeout(timeoutId);
        console.error(`AI Request to ${url} failed:`, err);
        if (err.name === 'AbortError') throw new Error('リクエストがタイムアウトしました。');
        if (err.name === 'TypeError' && err.message === 'Failed to fetch') {
            throw new Error('API通信エラー（CORSまたはMixed Contentの可能性があります）');
        }
        throw err;
    }
}

export async function ocrImagesToMarkdown(images, { fileName = 'document.pdf' } = {}) {
    if (!images?.length) throw new Error('OCR対象の画像がありません。');

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

    return await chatAi([{ role: 'user', content }], 'ocr');
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

    const url = `${baseUrl}/models`;
    try {
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${apiKey}`
            }
        });
        if (!response.ok) {
            console.error(`Failed to fetch models from ${url}: ${response.status} ${response.statusText}`);
            return [];
        }
        const data = await response.json();
        return data.data.map(m => m.id).sort();
    } catch (err) {
        console.error(`Failed to fetch models from ${url}:`, err);
        // Special hint for CORS/Mixed Content
        if (err.name === 'TypeError' && err.message === 'Failed to fetch') {
            console.error('This is likely a CORS or Mixed Content (HTTPS to HTTP) error. Check your API endpoint and browser console.');
        }
        return [];
    }
}

async function readChatCompletionStream(response, onDelta = null) {
    if (!response.body) throw new Error('ストリーミングレスポンスを読み取れません。');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';

    const handleEvent = (eventText) => {
        const dataLines = eventText
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trim());

        for (const data of dataLines) {
            if (!data || data === '[DONE]') continue;

            const payload = JSON.parse(data);
            const delta = payload.choices?.[0]?.delta?.content || '';
            if (!delta) continue;

            content += delta;
            onDelta?.(delta, content);
        }
    };

    while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';
        for (const eventText of events) {
            handleEvent(eventText);
        }
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
        handleEvent(buffer);
    }

    return content;
}

export async function testAiConnection(settingsOverride = null) {
    const settings = settingsOverride || getAiSettings();

    const baseUrl = normalizeBaseUrl(settings.baseUrl);
    if (!baseUrl) throw new Error('AI Base URLが設定されていません。');

    const apiKey = getApiKeyForBaseUrl(settings, baseUrl);
    if (!apiKey) throw new Error('APIキーが設定されていません。');

    const url = `${baseUrl}/models`;
    try {
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${apiKey}`
            }
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            const msg = error.error?.message || `${response.status} ${response.statusText}`;
            throw new Error(`API応答エラー: ${msg}`);
        }

        const data = await response.json();
        return {
            ok: true,
            modelCount: Array.isArray(data.data) ? data.data.length : 0
        };
    } catch (err) {
        if (err.name === 'TypeError' && err.message === 'Failed to fetch') {
            throw new Error('APIに到達できません。Base URL、ネットワーク、CORS、Mixed Content（HTTPSページからHTTP API）を確認してください。');
        }
        throw err;
    }
}

