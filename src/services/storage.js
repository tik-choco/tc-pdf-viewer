import { storage_add, storage_get } from '../lib/mistlib/index.js';
import { getMistNode } from '../utils/mist.js';
import { readDeviceId } from '../utils/device.js';
import { publishShared } from './sharedBus.js';
import { scheduleDriveExport } from './driveExport.js';

export async function initMist() {
    return await getMistNode();
}

function getFilesIndex() {
    const saved = localStorage.getItem('mist_files_index');
    return saved ? JSON.parse(saved) : [];
}

function saveFileToIndex(name, cid, folder) {
    const index = getFilesIndex();
    const existing = index.find(f => f.name === name);
    if (existing) {
        existing.cid = cid;
        if (folder !== undefined) existing.folder = folder;
        existing.updatedAt = Date.now();
    } else {
        index.push({ name, cid, folder: folder ?? 'Default', createdAt: Date.now(), updatedAt: Date.now() });
    }
    localStorage.setItem('mist_files_index', JSON.stringify(index));
}

function getOcrMarkdownIndex() {
    return JSON.parse(localStorage.getItem('mist_ocr_markdown_index') || '{}');
}

// Persists the index locally (small pointer records only, per-entry bodies
// are content-addressed separately via saveOcrMarkdown), then publishes the
// whole index snapshot to the shared bus as a CID so other apps (e.g.
// tc-note) can read it without duplicating the body inline. `meta` stays a
// small summary ({count, updatedAt}) - see
// protocol/docs/data-contracts/docs/SHARED_BUS.md for the rationale.
export async function saveOcrMarkdownIndex(index) {
    try {
        localStorage.setItem('mist_ocr_markdown_index', JSON.stringify(index));
    } catch (error) {
        console.warn('failed to persist mist_ocr_markdown_index', error);
    }

    try {
        await initMist();
        const cid = await storage_add('mist_ocr_markdown_index', new TextEncoder().encode(JSON.stringify(index)));
        publishShared('ocr-markdown-index', cid, {
            count: Object.keys(index).length,
            updatedAt: new Date().toISOString(),
        });
    } catch (error) {
        console.warn('failed to publish shared ocr-markdown-index update', error);
    }
}

function getTranslatedMarkdownIndex() {
    return JSON.parse(localStorage.getItem('mist_translated_markdown_index') || '{}');
}

export async function saveTranslatedMarkdownIndex(index) {
    try {
        localStorage.setItem('mist_translated_markdown_index', JSON.stringify(index));
    } catch (error) {
        console.warn('failed to persist mist_translated_markdown_index', error);
    }
}

export async function savePdf(name, data, folder) {
    await initMist();
    const cid = await storage_add(name, data);
    console.log(`Stored ${name} with CID: ${cid}`);
    
    saveFileToIndex(name, cid, folder);
    scheduleDriveExport();
    return cid;
}

export async function renamePdf(oldName, newName) {
    const index = getFilesIndex();
    const file = index.find(f => f.name === oldName);
    if (file) {
        file.name = newName;
        file.updatedAt = Date.now();
        localStorage.setItem('mist_files_index', JSON.stringify(index));

        const ocrIndex = getOcrMarkdownIndex();
        if (ocrIndex[oldName] && !ocrIndex[newName]) {
            ocrIndex[newName] = ocrIndex[oldName];
            delete ocrIndex[oldName];
            await saveOcrMarkdownIndex(ocrIndex);
        }

        const translatedIndex = getTranslatedMarkdownIndex();
        if (translatedIndex[oldName] && !translatedIndex[newName]) {
            translatedIndex[newName] = translatedIndex[oldName];
            delete translatedIndex[oldName];
            await saveTranslatedMarkdownIndex(translatedIndex);
        }

        scheduleDriveExport();
        return true;
    }
    return false;
}

export async function deletePdf(name) {
    const index = getFilesIndex();
    const newIndex = index.filter(f => f.name !== name);
    localStorage.setItem('mist_files_index', JSON.stringify(newIndex));

    const ocrIndex = getOcrMarkdownIndex();
    if (ocrIndex[name]) {
        delete ocrIndex[name];
        await saveOcrMarkdownIndex(ocrIndex);
    }

    const translatedIndex = getTranslatedMarkdownIndex();
    if (translatedIndex[name]) {
        delete translatedIndex[name];
        await saveTranslatedMarkdownIndex(translatedIndex);
    }

    await clearChatMessages(name);

    scheduleDriveExport();
}

export async function updatePdfFolder(name, folder) {
    const index = getFilesIndex();
    const file = index.find(f => f.name === name);
    if (file) {
        file.folder = folder;
        localStorage.setItem('mist_files_index', JSON.stringify(index));
        scheduleDriveExport();
    }
}

export async function updatePdfList(newIndex) {
    localStorage.setItem('mist_files_index', JSON.stringify(newIndex));
    scheduleDriveExport();
}

export async function getPdfList() {
    return getFilesIndex();
}

export async function loadPdf(name) {
    await initMist();
    const index = getFilesIndex();
    const file = index.find(f => f.name === name);

    if (!file || !file.cid) {
        throw new Error(`CID not found locally for PDF: ${name}`);
    }

    return await storage_get(file.cid);
}

export async function prefetchPdf(name) {
    try {
        await loadPdf(name);
    } catch {
    }
}

export async function saveExplanation(text, explanation) {
    await initMist();
    const cid = await storage_add(text, new TextEncoder().encode(explanation));
    
    const index = JSON.parse(localStorage.getItem('mist_explanations_index') || '{}');
    index[text] = cid;
    localStorage.setItem('mist_explanations_index', JSON.stringify(index));
}

export async function getExplanation(text) {
    await initMist();
    const index = JSON.parse(localStorage.getItem('mist_explanations_index') || '{}');
    const cid = index[text];
    if (!cid) return null;
    
    try {
        const data = await storage_get(cid);
        return new TextDecoder().decode(data);
    } catch (e) {
        return null;
    }
}

export async function saveOcrMarkdown(pdfName, markdown) {
    if (!pdfName) throw new Error('PDF name is required to save OCR Markdown.');

    await initMist();
    const cid = await storage_add(`ocr:${pdfName}`, new TextEncoder().encode(markdown));

    const index = getOcrMarkdownIndex();
    index[pdfName] = {
        ...(typeof index[pdfName] === 'object' ? index[pdfName] : {}),
        cid,
        content: undefined, // new writes are CID-only; JSON.stringify drops undefined
        updatedAt: Date.now(),
    };
    await saveOcrMarkdownIndex(index);
}

export async function getOcrMarkdown(pdfName) {
    if (!pdfName) return null;

    const index = getOcrMarkdownIndex();
    const entry = index[pdfName];
    if (!entry) return null;

    // 旧フォーマット（本文インライン）との dual-read: content があればそれを使い、
    // 無ければ CID（新フォーマット、または更に古い「エントリ自体が文字列のCID」形式）から取得する。
    if (entry.content != null) return entry.content;

    const cid = typeof entry === 'string' ? entry : entry?.cid;
    if (!cid) return null;

    try {
        await initMist();
        const data = await storage_get(cid);
        return new TextDecoder().decode(data);
    } catch (e) {
        return null;
    }
}

export async function saveOcrMarkdownSummary(pdfName, summary) {
    if (!pdfName) throw new Error('PDF name is required to save OCR Markdown summary.');

    const index = getOcrMarkdownIndex();
    index[pdfName] = {
        ...(typeof index[pdfName] === 'object' ? index[pdfName] : {}),
        summary,
        summaryUpdatedAt: Date.now(),
    };
    await saveOcrMarkdownIndex(index);
}

export function getOcrMarkdownSummary(pdfName) {
    if (!pdfName) return '';

    const entry = getOcrMarkdownIndex()[pdfName];
    return typeof entry === 'object' ? (entry.summary || '') : '';
}

export function getOcrMarkdownIndexSnapshot() {
    return getOcrMarkdownIndex();
}

export async function saveTranslatedMarkdown(pdfName, targetLanguage, markdown) {
    if (!pdfName) throw new Error('PDF name is required to save translated Markdown.');
    if (!targetLanguage) throw new Error('Target language is required to save translated Markdown.');

    await initMist();
    const cid = await storage_add(`translated:${pdfName}:${targetLanguage}`, new TextEncoder().encode(markdown));

    const index = getTranslatedMarkdownIndex();
    index[pdfName] = {
        ...(index[pdfName] || {}),
        [targetLanguage]: {
            cid,
            content: undefined, // new writes are CID-only; JSON.stringify drops undefined
            updatedAt: Date.now(),
        },
    };
    await saveTranslatedMarkdownIndex(index);
}

export async function getTranslatedMarkdown(pdfName, targetLanguage) {
    if (!pdfName || !targetLanguage) return null;

    const index = getTranslatedMarkdownIndex();
    const entry = index[pdfName]?.[targetLanguage];
    if (!entry) return null;

    // 旧フォーマット（本文インライン）との dual-read: content があればそれを使い、
    // 無ければ CID（新フォーマット、または更に古い「エントリ自体が文字列のCID」形式）から取得する。
    if (entry.content != null) return entry.content;

    const cid = typeof entry === 'string' ? entry : entry?.cid;
    if (!cid) return null;

    try {
        await initMist();
        const data = await storage_get(cid);
        return new TextDecoder().decode(data);
    } catch (e) {
        return null;
    }
}

export function getTranslatedMarkdownIndexSnapshot() {
    return getTranslatedMarkdownIndex();
}

async function migrateInlineEntryToCid(entry, seedName) {
    const cid = await storage_add(seedName, new TextEncoder().encode(entry.content));
    return { ...entry, cid, content: undefined };
}

// One-time, best-effort migration of legacy inline `content` entries (still
// present from before this app wrote `cid`s) into mistlib CID storage. Safe
// to call repeatedly - entries that already have a `cid` (or no `content`)
// are left untouched, and a failed storage_add for one entry just leaves
// that entry's inline content in place rather than losing data.
export async function migrateMarkdownIndexesToCid() {
    try {
        await initMist();
    } catch (error) {
        console.warn('failed to init mist for markdown index CID migration', error);
        return;
    }

    try {
        const ocrIndex = getOcrMarkdownIndex();
        let changed = false;
        for (const pdfName of Object.keys(ocrIndex)) {
            const entry = ocrIndex[pdfName];
            if (entry && typeof entry === 'object' && typeof entry.content === 'string' && !entry.cid) {
                try {
                    ocrIndex[pdfName] = await migrateInlineEntryToCid(entry, `ocr:${pdfName}`);
                    changed = true;
                } catch (error) {
                    console.warn(`failed to migrate OCR markdown for "${pdfName}" to CID`, error);
                }
            }
        }
        if (changed) await saveOcrMarkdownIndex(ocrIndex);
    } catch (error) {
        console.warn('failed to migrate mist_ocr_markdown_index to CID form', error);
    }

    try {
        const translatedIndex = getTranslatedMarkdownIndex();
        let changed = false;
        for (const pdfName of Object.keys(translatedIndex)) {
            const langs = translatedIndex[pdfName];
            if (!langs || typeof langs !== 'object') continue;
            for (const lang of Object.keys(langs)) {
                const entry = langs[lang];
                if (entry && typeof entry === 'object' && typeof entry.content === 'string' && !entry.cid) {
                    try {
                        langs[lang] = await migrateInlineEntryToCid(entry, `translated:${pdfName}:${lang}`);
                        changed = true;
                    } catch (error) {
                        console.warn(`failed to migrate translated markdown for "${pdfName}/${lang}" to CID`, error);
                    }
                }
            }
        }
        if (changed) await saveTranslatedMarkdownIndex(translatedIndex);
    } catch (error) {
        console.warn('failed to migrate mist_translated_markdown_index to CID form', error);
    }
}

// --- Per-PDF chat history -------------------------------------------------
//
// Chat transcripts can grow unbounded (many turns of full AI responses), so
// like the OCR/translation indexes above, only a small CID pointer per PDF
// lives in localStorage; the message array itself is content-addressed via
// mistlib storage_add/storage_get. This vendored mistlib build doesn't
// expose the storage_kv_set/get KV API yet, so the pointer index reuses the
// same storage_add/storage_get + small-index pattern as
// mist_ocr_markdown_index above rather than adding a new mistlib import.
const CHAT_INDEX_KEY = 'tc-pdf-viewer-chat-index-v1';
const CHAT_LEGACY_KEY_PREFIX = 'mist_chat_';

function getChatIndex() {
    try {
        return JSON.parse(localStorage.getItem(CHAT_INDEX_KEY) || '{}');
    } catch (error) {
        console.warn('failed to read tc-pdf-viewer-chat-index-v1', error);
        return {};
    }
}

export async function saveChatMessages(pdfName, messages) {
    if (!pdfName) return;

    await initMist();
    const cid = await storage_add(`chat:${pdfName}`, new TextEncoder().encode(JSON.stringify(messages)));

    const index = getChatIndex();
    index[pdfName] = { cid, updatedAt: Date.now() };
    try {
        localStorage.setItem(CHAT_INDEX_KEY, JSON.stringify(index));
    } catch (error) {
        console.warn('failed to persist tc-pdf-viewer-chat-index-v1', error);
        return; // index write failed - keep the legacy key around, don't lose data
    }

    // Migration to the CID pointer succeeded; the legacy inline copy (if
    // any) is now redundant.
    try {
        localStorage.removeItem(`${CHAT_LEGACY_KEY_PREFIX}${pdfName}`);
    } catch (error) {
        console.warn(`failed to remove legacy chat key for "${pdfName}"`, error);
    }
}

export async function loadChatMessages(pdfName) {
    if (!pdfName) return [];

    const index = getChatIndex();
    const entry = index[pdfName];
    if (entry?.cid) {
        try {
            await initMist();
            const data = await storage_get(entry.cid);
            return JSON.parse(new TextDecoder().decode(data));
        } catch (error) {
            console.warn(`failed to load chat history for "${pdfName}" from CID store`, error);
            return [];
        }
    }

    // 旧フォーマット（localStorageインライン格納）との dual-read。見つかった場合は
    // 一回きりでCIDストアへ移行する（失敗しても旧キーはそのまま残るのでデータは失われない）。
    let legacyRaw;
    try {
        legacyRaw = localStorage.getItem(`${CHAT_LEGACY_KEY_PREFIX}${pdfName}`);
    } catch (error) {
        console.warn(`failed to read legacy chat key for "${pdfName}"`, error);
        return [];
    }
    if (!legacyRaw) return [];

    let legacyMessages;
    try {
        legacyMessages = JSON.parse(legacyRaw);
    } catch (error) {
        console.warn(`failed to parse legacy chat key for "${pdfName}"`, error);
        return [];
    }

    saveChatMessages(pdfName, legacyMessages).catch((error) => {
        console.warn(`failed to migrate chat history for "${pdfName}" to CID storage`, error);
    });

    return legacyMessages;
}

export async function clearChatMessages(pdfName) {
    if (!pdfName) return;

    const index = getChatIndex();
    if (index[pdfName]) {
        delete index[pdfName];
        try {
            localStorage.setItem(CHAT_INDEX_KEY, JSON.stringify(index));
        } catch (error) {
            console.warn('failed to persist tc-pdf-viewer-chat-index-v1', error);
        }
    }

    try {
        localStorage.removeItem(`${CHAT_LEGACY_KEY_PREFIX}${pdfName}`);
    } catch (error) {
        console.warn(`failed to remove legacy chat key for "${pdfName}"`, error);
    }
}
