import { MESSAGES_JA, MistaiError, formatMistaiError, streamChatCompletion } from '@tik-choco/mistai';
import { isNetworkProviderBaseUrl, resolveModel, roomIdFromBaseUrl } from '@tik-choco/mistai/llm-config';
import { getExplanation, saveExplanation } from './storage';
import { rooms } from './mistllm';
import { aiMessages } from '../i18n/ai.js';
import { getAiSettings, getSharedLlmConfig } from './aiSettings';
export { getAiSettings, saveAiSettings } from './aiSettings';

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

/**
 * Explains `text`, optionally streaming the answer as it arrives.
 *
 * @param {string} text
 * @param {{contextMarkdown?: string, pdfName?: string, onDelta?: (delta: string, full: string) => void}} [options]
 *   `onDelta` receives each token plus the text so far, so the tooltip can
 *   render a partial answer instead of spinning until the whole reply lands.
 *   A cache hit answers instantly and never calls it.
 */
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
    const result = await chatAi([{ role: 'user', content: prompt }], 'explain', {
        onDelta: options.onDelta,
    });

    explanationCache.set(cacheKey, result);
    if (!contextMarkdown) {
        saveExplanation(text, result).catch(e => console.error('Failed to save to Mist:', e));
    }

    return result;
}

/**
 * @param {string} text
 * @param {string} [targetLanguage]
 * @param {{onDelta?: (delta: string, full: string) => void}} [options] see explainText
 */
export async function translateText(text, targetLanguage = '日本語', options = {}) {
    const prompt = [
        `Translate into ${targetLanguage}. Output only the translation.`,
        '',
        text
    ].join('\n');
    return await chatAi(buildTranslationMessages(prompt, targetLanguage), 'translate', {
        onDelta: options.onDelta,
    });
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
    const { signal = null, initialChunks = null, onChunkComplete = null } = options;
    throwIfAborted(signal);
    const chunks = splitMarkdownForTranslation(markdown);
    const translatedChunks = Array(chunks.length).fill('');
    const completedChunks = Array(chunks.length).fill(false);
    let completed = 0;
    let nextIndex = 0;
    const failures = [];

    // Prefill from a previous (interrupted) run's checkpoint: mark those
    // indices completed up front so the worker pool below skips them
    // entirely (never calls the LLM for them) and progress/done counts
    // include them from the very first notifyProgress().
    if (initialChunks) {
        for (const key of Object.keys(initialChunks)) {
            const index = Number(key);
            const value = initialChunks[key];
            if (!Number.isInteger(index) || index < 0 || index >= chunks.length) continue;
            if (typeof value !== 'string' || !value) continue;
            translatedChunks[index] = value;
            completedChunks[index] = true;
            completed += 1;
        }
    }

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
        while (nextIndex < chunks.length) {
            throwIfAborted(signal);
            const index = nextIndex;
            nextIndex += 1;
            if (completedChunks[index]) continue; // prefilled from initialChunks - skip the LLM call

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
                if (onChunkComplete) {
                    try {
                        await onChunkComplete(index, translatedChunks[index], chunks.length);
                    } catch (callbackErr) {
                        console.warn('onChunkComplete failed:', callbackErr);
                    }
                }
                notifyProgress();
            } catch (err) {
                throwIfAborted(signal);
                if (err?.name === 'AbortError') throw err;
                failures.push({ index, error: err });
            }
        }
    };

    notifyProgress();
    throwIfAborted(signal);
    const workerCount = Math.min(MARKDOWN_TRANSLATION_CONCURRENCY, chunks.length);
    await Promise.all(Array.from({ length: workerCount }, () => translateNextChunk()));

    if (failures.length) {
        failures.sort((a, b) => a.index - b.index);
        const firstMessage = failures[0].error?.message || String(failures[0].error);
        throw new Error(`${failures.length}/${chunks.length} チャンクの翻訳に失敗しました。翻訳を再実行すると続きから再開できます。（${firstMessage}）`);
    }

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

export function splitMarkdownForTranslation(markdown, maxChars = MARKDOWN_TRANSLATION_CHUNK_SIZE) {
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
const DEFAULT_TIMEOUT_MS = 30000;

export async function chatAi(messages, task = 'chat', options = {}) {
    const settings = getAiSettings();
    const resolved = resolveModel(getSharedLlmConfig(), settings.tasks[task]?.ref);
    if (!resolved) throw new Error(aiMessages(settings.locale).noModel);
    if (options.signal?.aborted) {
        const error = new Error('Request cancelled.');
        error.name = 'AbortError';
        throw error;
    }
    const reasoningEffort = settings.tasks[task]?.reasoningEffort ?? 'none';

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
        // The text-only chat wire cannot carry vision content or task effort.
        // The mistai OpenAI tunnel carries both and buffers the room response.
        if (isNetworkProviderBaseUrl(resolved.baseUrl)) {
            const request = rooms.requestRoomOpenAi(roomIdFromBaseUrl(resolved.baseUrl), {
                path: '/chat/completions', method: 'POST', contentType: 'application/json',
                body: JSON.stringify({ model: resolved.model, messages, reasoning_effort: reasoningEffort, stream: false }),
            });
            let abort;
            const cancelled = new Promise((_, reject) => {
                abort = () => reject(new DOMException('Request cancelled.', 'AbortError'));
                controller.signal.addEventListener('abort', abort, { once: true });
                if (controller.signal.aborted) abort();
            });
            let response;
            try { response = await Promise.race([request, cancelled]); }
            finally { controller.signal.removeEventListener('abort', abort); }
            const payload = JSON.parse(response.body);
            if (response.status < 200 || response.status >= 300) throw new Error(payload?.error?.message || `HTTP ${response.status}`);
            const answer = payload?.choices?.[0]?.message?.content;
            if (typeof answer !== 'string') throw new MistaiError('UPSTREAM_BAD_RESPONSE', 'Unexpected chat response');
            options.onDelta?.(answer, answer);
            return answer.trim();
        }
        const result = await streamChatCompletion(
            {
                baseUrl: resolved.baseUrl,
                apiKey: resolved.apiKey,
                model: resolved.model,
                reasoningEffort,
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

    return await chatAi([{ role: 'user', content }], 'ocr', { signal, timeoutMs: 120000 });
}
