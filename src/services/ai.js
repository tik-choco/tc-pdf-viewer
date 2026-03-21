import { getExplanation, saveExplanation } from './storage';

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
    
    let saved = JSON.parse(savedString);
    
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

    const model = settings.models?.[task] || settings.models?.chat || 'gpt-4o';
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
        const response = await fetch(`${settings.baseUrl}/chat/completions`, {
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
            throw new Error(error.error?.message || `APIリクエストに失敗しました: ${response.status}`);
        }

        const data = await response.json();
        return data.choices[0].message.content.trim();
    } catch (err) {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError') throw new Error('リクエストがタイムアウトしました。');
        throw err;
    }
}

export async function getAvailableModels() {
    const settings = getAiSettings();
    if (!settings.apiKey) return [];

    try {
        const response = await fetch(`${settings.baseUrl}/models`, {
            headers: {
                'Authorization': `Bearer ${settings.apiKey}`
            }
        });
        if (!response.ok) return [];
        const data = await response.json();
        return data.data.map(m => m.id).sort();
    } catch (err) {
        console.error('Failed to fetch models:', err);
        return [];
    }
}
