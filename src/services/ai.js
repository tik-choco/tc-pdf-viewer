import { getExplanation, saveExplanation } from './storage';

export const DEFAULT_MODELS = [];

const DEFAULT_SETTINGS = {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    models: {
        explain: '',
        translate: '',
        chat: '',
        ocr: ''
    },
    promptTemplate: '以下の用語や文章を簡潔に、かつ専門的に解説してください:\n\n"{text}"',
    targetLanguages: ['日本語', 'English', '中国語', '韓国語', 'スペイン語']
};

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
    
    return { ...DEFAULT_SETTINGS, ...saved, models: { ...DEFAULT_SETTINGS.models, ...saved.models } };
}

export function saveAiSettings(settings) {
    localStorage.setItem('ai_settings', JSON.stringify(settings));
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
    const prompt = `以下の文章を自然な「${targetLanguage}」に翻訳してください。専門用語が含まれる場合は、その分野に即した適切な訳語を使用してください:\n\n"${text}"`;
    return await chatAi([{ role: 'user', content: prompt }], 'translate');
}

const MARKDOWN_TRANSLATION_CHUNK_SIZE = 4500;
const MARKDOWN_TRANSLATION_MIN_RETRY_CHUNK_SIZE = 1200;

export async function translateMarkdown(markdown, targetLanguage = '日本語', onProgress = null) {
    const chunks = splitMarkdownForTranslation(markdown);
    const translatedChunks = [];

    const notifyProgress = () => {
        onProgress?.({
            done: translatedChunks.length,
            total: chunks.length,
            translatedMarkdown: translatedChunks.join('\n\n')
        });
    };

    for (let i = 0; i < chunks.length; i++) {
        notifyProgress();

        try {
            const translated = await translateMarkdownChunk(chunks[i], targetLanguage, {
                chunkNumber: i + 1,
                totalChunks: chunks.length
            });
            translatedChunks.push(translated.trim());
            notifyProgress();
        } catch (err) {
            if (!isTimeoutError(err) || chunks[i].length <= MARKDOWN_TRANSLATION_MIN_RETRY_CHUNK_SIZE) {
                throw err;
            }

            const smallerChunks = splitMarkdownForTranslation(
                chunks[i],
                Math.max(MARKDOWN_TRANSLATION_MIN_RETRY_CHUNK_SIZE, Math.floor(chunks[i].length / 2))
            );
            if (smallerChunks.length <= 1 && smallerChunks[0] === chunks[i]) {
                throw err;
            }
            chunks.splice(i, 1, ...smallerChunks);
            i -= 1;
        }
    }

    return translatedChunks.join('\n\n');
}

async function translateMarkdownChunk(markdown, targetLanguage, { chunkNumber = 1, totalChunks = 1 } = {}) {
    const prompt = [
        `Translate the following Markdown document chunk into ${targetLanguage}.`,
        `This is chunk ${chunkNumber} of ${totalChunks}; translate only this chunk.`,
        'Preserve the Markdown structure, headings, lists, tables, code fences, links, page comments, and reading order.',
        'Translate prose and table text. Do not translate code inside code fences. Do not summarize. Do not add commentary outside the translated Markdown.',
        '',
        markdown
    ].join('\n');

    return await chatAi([{ role: 'user', content: prompt }], 'translate');
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
export async function chatAi(messages, task = 'chat') {
    const settings = getAiSettings();
    if (!settings.apiKey) throw new Error('APIキーが設定されていません。');

    const baseUrl = (settings.baseUrl || '').replace(/\/$/, '');
    if (!baseUrl) throw new Error('AI Base URLが設定されていません。');

    const model = settings.models?.[task] || settings.models?.chat;
    if (!model) throw new Error('AIモデルが設定されていません。AI設定でモデルを選択してください。');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    const url = `${baseUrl}/chat/completions`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            signal: controller.signal,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${settings.apiKey}`
            },
            body: JSON.stringify({
                model: model,
                messages: messages
            })
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            const msg = error.error?.message || `APIリクエストに失敗しました: ${response.status} ${response.statusText}`;
            console.error(`AI Error from ${url}:`, msg);
            throw new Error(msg);
        }

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
                'Perform OCR on every visible page and convert the result to clean Markdown.',
                'Preserve headings, paragraphs, lists, tables, captions, page breaks, and reading order as accurately as possible.',
                'Do not summarize. Do not add commentary. If text is uncertain, mark it with [?].',
                'Insert a Markdown comment before each page in the form: <!-- Page N -->.'
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
    if (!settings.apiKey) return [];

    // Ensure baseUrl has no trailing slash and isn't empty
    const baseUrl = (settings.baseUrl || '').replace(/\/$/, '');
    if (!baseUrl) {
        console.warn('AI Base URL is empty. Please set it in settings.');
        return [];
    }

    const url = `${baseUrl}/models`;
    try {
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${settings.apiKey}`
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

export async function testAiConnection(settingsOverride = null) {
    const settings = settingsOverride || getAiSettings();
    if (!settings.apiKey) throw new Error('APIキーが設定されていません。');

    const baseUrl = (settings.baseUrl || '').replace(/\/$/, '');
    if (!baseUrl) throw new Error('AI Base URLが設定されていません。');

    const url = `${baseUrl}/models`;
    try {
        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${settings.apiKey}`
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

