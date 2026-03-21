import { getExplanation, saveExplanation } from './storage';

export const DEFAULT_MODELS = [
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4-turbo',
    'gpt-3.5-turbo'
];

const DEFAULT_SETTINGS = {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    models: {
        explain: 'gpt-4o',
        translate: 'gpt-4o',
        chat: 'gpt-4o'
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
    const settings = getAiSettings();
    const prompt = `以下の文章を自然な「${targetLanguage}」に翻訳してください。専門用語が含まれる場合は、その文脈に即した適切な訳語を使用してください:\n\n"${text}"`;
    return await chatAi([{ role: 'user', content: prompt }], 'translate');
}

export async function chatAi(messages, task = 'chat') {
    const settings = getAiSettings();
    if (!settings.apiKey) throw new Error('APIキーが設定されていません。');

    const baseUrl = (settings.baseUrl || '').replace(/\/$/, '');
    if (!baseUrl) throw new Error('AI Base URLが設定されていません。');

    const model = settings.models?.[task] || settings.models?.chat || 'gpt-4o';
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

export async function getAvailableModels() {
    const settings = getAiSettings();
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
