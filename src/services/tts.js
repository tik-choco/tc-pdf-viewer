// Text-to-speech for selected text (pronunciation check), ported from
// tc-translate's src/lib/voice.ts + src/hooks/useSpeech.ts.
//
// The engine is DERIVED from the shared llm config's `tts` entry rather than
// stored as a local app setting, exactly like tc-translate's
// deriveVoiceEngine (see services/llmConfig.js resolveVoice):
//   - `tts` absent, or its `model` blank            -> 'browser' (Web Speech API)
//   - its provider's baseUrl is `mist-network://…`  -> 'network' (a room peer synthesizes)
//   - any other baseUrl                             -> 'api' (OpenAI-compatible /audio/speech)
//   - model set but the provider can't be resolved  -> 'api', so the settings UI can
//                                                      warn about the dangling connection
//     (the runtime call then falls back to the browser voice)
//
// Every route degrades rather than failing hard: 'api'/'network' failures fall
// back to the browser voice in hooks/useTts.js, and a browser without
// speechSynthesis just reports the feature as unsupported.

import { getMistllmConsumer } from './mistllm';
import { emptyLlmConfig, loadLlmConfig, resolvePreset, resolveVoice, saveLlmConfig } from './llmConfig';
import { isNetworkProviderBaseUrl, networkVoiceModelParam } from './networkModels';

/** Matches mistai's MAX_TTS_TEXT_CHARS; also the cap applied on the API route so both behave alike. */
export const MAX_TTS_TEXT_CHARS = 4000;

export const DEFAULT_TTS_VOICE = 'alloy';

/**
 * @typedef {object} TtsSettings
 * @property {'browser'|'api'|'network'} engine
 * @property {string} providerId '' = defaultPreset の provider にフォールバック
 * @property {string} model
 * @property {string} voice
 * @property {number|undefined} speed
 * @property {string} baseUrl 解決できなかった場合は ''
 * @property {string} apiKey
 */

/**
 * Derives the TTS engine from a shared llm config. See this module's header
 * for the rules; mirrors tc-translate's deriveVoiceEngine('tts').
 *
 * @param {import('./llmConfig').SharedLlmConfigV1} config
 * @returns {'browser'|'api'|'network'}
 */
export function deriveTtsEngine(config) {
    const cfg = config?.tts;
    if (!cfg || !cfg.model) return 'browser';

    const provider = cfg.providerId
        ? config.providers.find((p) => p.id === cfg.providerId)
        : (() => {
              const defaultTarget = resolvePreset(config);
              return defaultTarget ? config.providers.find((p) => p.id === defaultTarget.providerId) : undefined;
          })();
    if (!provider) return 'api';

    return isNetworkProviderBaseUrl(provider.baseUrl) ? 'network' : 'api';
}

/**
 * Reads the current TTS settings out of the shared llm config. Never throws;
 * an unconfigured/unresolvable config comes back as the browser engine with
 * empty connection fields.
 *
 * @param {import('./llmConfig').SharedLlmConfigV1} [config]
 * @returns {TtsSettings}
 */
export function getTtsSettings(config = loadLlmConfig() ?? emptyLlmConfig()) {
    const cfg = config.tts;
    const engine = deriveTtsEngine(config);
    const resolved = resolveVoice(config, 'tts');
    return {
        engine,
        providerId: cfg?.providerId || '',
        model: cfg?.model || '',
        voice: cfg?.voice || '',
        speed: cfg?.speed,
        baseUrl: resolved?.baseUrl || '',
        apiKey: resolved?.apiKey || '',
    };
}

/**
 * Merges `patch` into the shared llm config's `tts` entry and persists it.
 * Passing a blank `model` clears the entry entirely (= back to the browser
 * voice), which is what the settings UI's "ブラウザ音声" choice does.
 *
 * An omitted key means "leave as is", so clearing an optional field needs an
 * explicit non-undefined value: pass `speed: null` to drop a configured
 * speed back to the provider's default.
 *
 * @param {{providerId?: string, model?: string, voice?: string, speed?: number|null}} patch
 * @returns {TtsSettings} the settings after the write
 */
export function updateTtsSettings(patch) {
    const config = loadLlmConfig() ?? emptyLlmConfig();
    const current = config.tts ?? { model: '' };
    const next = {
        providerId: patch.providerId !== undefined ? patch.providerId : current.providerId,
        model: patch.model !== undefined ? patch.model : current.model,
        voice: patch.voice !== undefined ? patch.voice : current.voice,
        speed: patch.speed !== undefined ? patch.speed : current.speed,
    };

    if (!next.model || !next.model.trim()) {
        delete config.tts;
    } else {
        const entry = { model: next.model.trim() };
        if (next.providerId) entry.providerId = next.providerId;
        if (next.voice) entry.voice = next.voice;
        if (typeof next.speed === 'number' && Number.isFinite(next.speed)) entry.speed = next.speed;
        config.tts = entry;
    }

    saveLlmConfig(config);
    return getTtsSettings(config);
}

/** True when this browser exposes the Web Speech synthesis API. */
export function isBrowserTtsSupported() {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/**
 * Best-effort BCP-47 tag for `text`, used to pick the browser voice (the
 * API/network routes leave language detection to the provider's model). Only
 * the scripts a PDF reader realistically hits are distinguished; anything
 * else — including plain Latin text — reads as English, which is the case
 * this feature exists for.
 *
 * @param {string} text
 * @returns {string}
 */
export function guessSpeechLang(text) {
    const sample = (text || '').slice(0, 400);
    if (/[぀-ヿ]/.test(sample)) return 'ja-JP'; // かな -> 日本語確定
    if (/[가-힯]/.test(sample)) return 'ko-KR';
    if (/[Ѐ-ӿ]/.test(sample)) return 'ru-RU';
    // 漢字のみ(かな無し)は中国語として読む。日本語文なら普通かなが混ざる。
    if (/[一-鿿]/.test(sample)) return 'zh-CN';
    return 'en-US';
}

/**
 * Picks the installed SpeechSynthesisVoice that best matches `lang`: an exact
 * BCP-47 match first, then any voice sharing the primary subtag, else null
 * (the utterance's own `lang` then decides). Voices load asynchronously in
 * some browsers, so an empty list here just means "let the browser choose".
 *
 * @param {string} lang
 * @returns {SpeechSynthesisVoice | null}
 */
export function pickBrowserVoice(lang) {
    if (!isBrowserTtsSupported()) return null;
    let voices = [];
    try {
        voices = window.speechSynthesis.getVoices() || [];
    } catch {
        return null;
    }
    if (voices.length === 0) return null;

    const target = lang.toLowerCase();
    const primary = target.split('-')[0];
    return (
        voices.find((v) => (v.lang || '').toLowerCase().replace('_', '-') === target) ??
        voices.find((v) => (v.lang || '').toLowerCase().split(/[-_]/)[0] === primary) ??
        null
    );
}

/**
 * Chunk size used when a long text is synthesized piece by piece so playback
 * can start on the first sentence instead of the whole paragraph. Small enough
 * that the first request returns quickly, large enough that the seams between
 * chunks stay rare (and each chunk keeps enough context for prosody).
 */
export const SPEECH_CHUNK_CHARS = 140;

/** Text below this length is synthesized in one shot: splitting it only adds round trips. */
export const SPEECH_CHUNK_MIN_CHARS = 200;

/**
 * The first chunk is kept shorter than the rest: synthesis time scales with
 * the text, and this one is the only chunk the listener actually waits for.
 * It is only ever cut at a sentence or clause break, never mid-phrase.
 */
export const SPEECH_FIRST_CHUNK_CHARS = 70;

/** A sentence may run this much past `maxChars` before it is cut mid-phrase. */
const OVERLONG_SENTENCE_FACTOR = 3;

const SENTENCE_ENDERS = '。．！？!?…';
const SENTENCE_TAIL = '"\'”’」』）)]';
const CLAUSE_BREAKS = '、，,；;：:';

/**
 * A line shorter than this fraction of the paragraph's widest line ended
 * because its content ended, not because the page ran out of width — a
 * heading, a label, a list item — so the break after it is a real one.
 */
const SHORT_LINE_RATIO = 0.5;

/**
 * Words whose trailing dot is an abbreviation rather than a sentence end.
 * Only the ones that show up in the documents this viewer is pointed at, and
 * only those a following capital or digit ("Fig. 2", "Dr. Smith") would
 * otherwise fool; a lowercase continuation is already handled without a list.
 */
const ABBREVIATIONS = new Set([
    'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'cf', 'etc', 'al', 'approx',
    'fig', 'figs', 'eq', 'eqs', 'no', 'nos', 'vol', 'vols', 'ch', 'chap', 'sec', 'secs',
    'pp', 'ref', 'refs', 'dept', 'univ', 'inc', 'ltd', 'co',
]);

/**
 * Rebuilds the paragraph structure of text that was hard-wrapped somewhere
 * else — PDF selections in particular, where a line break lands wherever the
 * page column ended, often mid-sentence.
 *
 * Kept separate from the chunking because it matters even for a text short
 * enough to be synthesized in one piece: a stray newline inside a sentence
 * makes both the browser voice and most TTS models pause as if it were a
 * sentence end.
 *
 * A line break survives only where it really ends something (a blank line, or
 * a line ending in sentence punctuation); otherwise the lines are rejoined —
 * with a space where Latin text needs one, and with nothing between CJK, whose
 * words don't take spaces. A word hyphenated across a line break is repaired.
 *
 * @param {string} text
 * @returns {string} paragraphs, one per line
 */
export function normalizeSpeechText(text) {
    return (text || '')
        .replace(/\r\n?/g, '\n')
        .split(/\n[^\S\n]*\n\s*/)
        .map(unwrapParagraph)
        .filter(Boolean)
        .join('\n');
}

function unwrapParagraph(paragraph) {
    const lines = paragraph
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

    // The widest line is the column width the text was wrapped to; anything
    // much shorter than it ended on purpose.
    const bodyWidth = lines.reduce((widest, line) => Math.max(widest, line.length), 0);

    let out = '';
    let previous = '';
    for (const line of lines) {
        if (!out) {
            out = line;
            previous = line;
            continue;
        }
        if (/[A-Za-z]-$/.test(previous) && /^[a-z]/.test(line)) {
            // "informa-" + "tion": a word the page layout broke across lines.
            out = `${out.slice(0, -1)}${line}`;
        } else if (endsSentence(previous) || previous.length < bodyWidth * SHORT_LINE_RATIO) {
            // A real break — kept so the chunker can split here even when the
            // line is a heading or a bullet with no punctuation of its own.
            out = `${out}\n${line}`;
        } else {
            out += needsSpaceBetween(out, line) ? ` ${line}` : line;
        }
        previous = line;
    }
    return out;
}

/** True when `line` ends with sentence punctuation (plus any closing quotes/brackets). */
function endsSentence(line) {
    let i = line.length - 1;
    while (i >= 0 && SENTENCE_TAIL.includes(line[i])) i -= 1;
    return i >= 0 && (SENTENCE_ENDERS.includes(line[i]) || line[i] === '.');
}

/** Latin text needs the word gap that wrapping removed; CJK does not. */
function needsSpaceBetween(left, right) {
    return /[\w)\]"'”’.,!?;:]$/.test(left) && /^[\w("'“‘]/.test(right);
}

/**
 * Splits `text` into speakable chunks of at most `maxChars`, cutting at
 * sentence ends first and clause punctuation second. A sentence is only cut
 * mid-phrase once it runs past three times `maxChars`: a seam inside a phrase
 * is read with a falling, "that was the end" intonation, which costs more than
 * the extra synthesis time of one long chunk.
 *
 * Used by hooks/useTts.js to pipeline synthesis: chunk N plays while chunk N+1
 * is still being synthesized, so the wait before the first sound is set by the
 * first chunk rather than by the whole text.
 *
 * @param {string} text
 * @param {number} [maxChars]
 * @param {number} [firstMaxChars] cap for the first chunk only (see SPEECH_FIRST_CHUNK_CHARS)
 * @returns {string[]} non-empty chunks; `[]` for blank input
 */
export function splitTextForSpeech(text, maxChars = SPEECH_CHUNK_CHARS, firstMaxChars = maxChars) {
    const source = normalizeSpeechText(text).trim();
    if (!source) return [];
    if (source.length <= maxChars) return [source];

    /** @type {string[]} */
    const parts = [];
    for (const sentence of splitIntoSentences(source)) {
        parts.push(...splitOverlongPart(sentence, maxChars));
    }

    /** @type {string[]} */
    const chunks = [];
    let buffer = '';
    const flush = () => {
        if (buffer.trim()) chunks.push(buffer.trim());
        buffer = '';
    };

    for (const part of parts) {
        const glue = needsSpaceBetween(buffer, part) ? ' ' : '';
        if (!buffer) {
            // A part longer than the cap is one splitOverlongPart chose to
            // keep whole; it becomes its own chunk rather than being cut.
            buffer = part;
        } else if (buffer.length + glue.length + part.length <= maxChars) {
            buffer = `${buffer}${glue}${part}`;
        } else {
            flush();
            buffer = part;
        }
    }
    flush();

    return capFirstChunk(chunks, firstMaxChars);
}

/**
 * Cuts the opening chunk down toward `firstMaxChars` so playback starts sooner
 * — but only at a sentence or clause break, and only if one sits far enough
 * in. A first chunk with no natural pause is left alone.
 */
function capFirstChunk(chunks, firstMaxChars) {
    const first = chunks[0];
    if (!first || first.length <= firstMaxChars) return chunks;

    const breakAt = lastNaturalBreak(first.slice(0, firstMaxChars));
    if (breakAt < firstMaxChars * 0.35) return chunks;

    const head = first.slice(0, breakAt + 1).trim();
    const tail = first.slice(breakAt + 1).trim();
    if (!head || !tail) return chunks;
    return [head, tail, ...chunks.slice(1)];
}

/**
 * Cuts `source` after each sentence end, keeping the trailing run of closing
 * quotes/brackets with the sentence it ends (so no chunk starts with 」or ).
 * A full stop ends a sentence only when whitespace or the end of the text
 * follows it — and not after an initial ("J. R. R.") nor before a lowercase
 * word ("e.g. this"), which keeps abbreviations and "3.14" in one piece.
 *
 * Written as a scan rather than a lookbehind regex: lookbehind is missing from
 * older Safari, and a regex literal it can't parse would take the whole module
 * (and with it the app) down at load time.
 */
function splitIntoSentences(source) {
    const sentences = [];
    let start = 0;
    for (let i = 0; i < source.length; i += 1) {
        if (source[i] !== '\n' && !isSentenceEnd(source, i)) continue;

        let end = i + 1;
        while (end < source.length && SENTENCE_TAIL.includes(source[end])) end += 1;

        sentences.push(source.slice(start, end));
        start = end;
        i = end - 1;
    }
    if (start < source.length) sentences.push(source.slice(start));

    return sentences.map((piece) => piece.trim()).filter(Boolean);
}

/** True when the character at `i` closes a sentence (see splitIntoSentences). */
function isSentenceEnd(source, i) {
    const ch = source[i];
    if (SENTENCE_ENDERS.includes(ch)) return true;
    if (ch !== '.') return false;

    let after = i + 1;
    while (after < source.length && SENTENCE_TAIL.includes(source[after])) after += 1;
    if (after < source.length && !/\s/.test(source[after])) return false; // 3.14 / report.txt

    // "e.g. this" / "vs. the": a lowercase continuation isn't a new sentence.
    const next = source.slice(after).match(/\S/);
    if (next && /[a-z]/.test(next[0])) return false;

    const before = source.slice(0, i).match(/[^\s.]+$/);
    if (!before) return true;
    // A single letter before the dot is an initial, not a sentence ("J. Smith").
    if (before[0].length === 1) return false;
    return !ABBREVIATIONS.has(before[0].toLowerCase());
}

/**
 * Breaks a sentence that runs far past `maxChars` at clause punctuation, then
 * at a space, and only hard-cuts a run with no break at all (a long URL, a CJK
 * sentence with no punctuation). A sentence within OVERLONG_SENTENCE_FACTOR of
 * the cap is returned whole.
 */
function splitOverlongPart(part, maxChars) {
    if (part.length <= maxChars) return [part];

    const out = [];
    let rest = part;
    while (rest.length > maxChars) {
        const breakAt = lastClauseBreak(rest.slice(0, maxChars));
        if (breakAt >= maxChars * 0.4) {
            out.push(rest.slice(0, breakAt + 1).trim());
            rest = rest.slice(breakAt + 1).trim();
            continue;
        }
        // No natural pause in reach: keep the phrase together unless it has
        // grown long enough that one chunk would stall playback outright.
        if (rest.length <= maxChars * OVERLONG_SENTENCE_FACTOR) break;
        out.push(rest.slice(0, maxChars).trim());
        rest = rest.slice(maxChars).trim();
    }
    if (rest) out.push(rest);
    return out.filter(Boolean);
}

/**
 * Index of the last sentence end inside `window`, else its last clause break;
 * -1 if neither. Spaces don't count: this decides where the *first* chunk ends
 * early, and a seam between two words of one phrase is exactly the unnatural
 * break the chunker is trying to avoid.
 */
function lastNaturalBreak(window) {
    for (let i = window.length - 1; i >= 0; i -= 1) {
        if (!isSentenceEnd(window, i)) continue;
        let end = i;
        while (end + 1 < window.length && SENTENCE_TAIL.includes(window[end + 1])) end += 1;
        return end;
    }
    return lastClauseBreak(window, { allowSpace: false });
}

/**
 * Index of the last clause break (、, ; :) inside `window`, falling back to
 * the last space. Punctuation is searched for across the whole window first:
 * a space is a far worse place to stop, so a comma anywhere in the window
 * beats a space at its end.
 */
function lastClauseBreak(window, { allowSpace = true } = {}) {
    for (let i = window.length - 1; i >= 0; i -= 1) {
        if (CLAUSE_BREAKS.includes(window[i])) return i;
    }
    return allowSpace ? window.lastIndexOf(' ') : -1;
}

function authHeaders(apiKey) {
    return apiKey && apiKey.trim() ? { Authorization: `Bearer ${apiKey}` } : {};
}

function speechEndpoint(baseUrl) {
    const trimmed = (baseUrl || '').trim().replace(/\/+$/, '');
    return trimmed.endsWith('/audio/speech') ? trimmed : `${trimmed}/audio/speech`;
}

/**
 * POSTs an OpenAI-compatible `/audio/speech` request and resolves with the
 * audio Blob. Throws an Error whose message is already user-facing Japanese.
 *
 * @param {{baseUrl: string, apiKey: string, model: string, voice?: string, speed?: number, text: string, signal?: AbortSignal}} params
 * @returns {Promise<Blob>}
 */
export async function synthesizeSpeechViaApi(params) {
    const body = {
        model: params.model.trim(),
        input: params.text,
        voice: (params.voice || '').trim() || DEFAULT_TTS_VOICE,
        response_format: 'mp3',
    };
    if (typeof params.speed === 'number' && Number.isFinite(params.speed)) body.speed = params.speed;

    let response;
    try {
        response = await fetch(speechEndpoint(params.baseUrl), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders(params.apiKey) },
            signal: params.signal,
            body: JSON.stringify(body),
        });
    } catch (err) {
        if (err?.name === 'AbortError') throw err;
        throw new Error('音声APIへの接続に失敗しました（CORSまたはMixed Contentの可能性があります）');
    }

    if (!response.ok) {
        const payload = await response.json().catch(() => undefined);
        const detail = typeof payload?.error?.message === 'string' ? payload.error.message : '';
        throw new Error(detail || `音声合成に失敗しました（HTTP ${response.status}）`);
    }

    return await response.blob();
}

/**
 * Requests speech synthesis from an AI Network room peer that advertised the
 * "tts" service (see MistllmConsumer.tts in ./mistllm.js). The room id comes
 * from the shared config, the same one the chat consumer joins.
 *
 * @param {{model: string, voice?: string, text: string}} params
 * @returns {Promise<Blob>}
 */
export async function synthesizeSpeechViaNetwork(params) {
    const roomId = (loadLlmConfig()?.network?.roomId || '').trim();
    if (!roomId) throw new Error('AI NetworkのRoom IDが設定されていません。');

    const consumer = getMistllmConsumer();
    if (consumer.roomId !== roomId || consumer.status === 'idle' || consumer.status === 'error') {
        await consumer.connect(roomId);
    }

    return await consumer.tts(params.text, {
        // The `network-auto` sentinel means "use the provider's own default
        // model", so it must not go out on the wire (see ./networkModels.js).
        model: networkVoiceModelParam(params.model),
        voice: (params.voice || '').trim() || undefined,
    });
}

/**
 * Synthesizes `text` through whichever engine the shared config resolves to.
 * Rejects for the 'browser' engine (that route never produces a Blob — the
 * caller speaks it through the Web Speech API instead) and whenever the
 * resolved connection is unusable, so hooks/useTts.js can fall back.
 *
 * @param {string} text
 * @param {{settings?: TtsSettings, signal?: AbortSignal}} [options]
 * @returns {Promise<Blob>}
 */
export async function synthesizeSpeech(text, options = {}) {
    const settings = options.settings ?? getTtsSettings();
    const input = (text || '').trim().slice(0, MAX_TTS_TEXT_CHARS);
    if (!input) throw new Error('読み上げるテキストがありません。');

    if (settings.engine === 'network') {
        return await synthesizeSpeechViaNetwork({ model: settings.model, voice: settings.voice, text: input });
    }

    if (settings.engine === 'api') {
        if (!settings.baseUrl) throw new Error('音声合成の接続先が解決できません（プロバイダー設定を確認してください）。');
        return await synthesizeSpeechViaApi({
            baseUrl: settings.baseUrl,
            apiKey: settings.apiKey,
            model: settings.model,
            voice: settings.voice,
            speed: settings.speed,
            text: input,
            signal: options.signal,
        });
    }

    throw new Error('ブラウザ音声はBlobを生成しません。');
}
