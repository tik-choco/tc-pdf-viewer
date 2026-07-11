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

function saveOcrMarkdownIndex(index) {
    localStorage.setItem('mist_ocr_markdown_index', JSON.stringify(index));

    // This index isn't (yet) content-addressed via mistlib storage_add, so
    // there's no CID to publish. Instead the shared-bus record inlines the
    // whole index snapshot in `meta` (duplicating the legacy key's content)
    // so readShared() alone is enough for other apps, plus notifies
    // subscribers that it changed. `legacyKey` points back at the
    // original key for provenance. See
    // protocol/docs/data-contracts/docs/SHARED_BUS.md for the rationale.
    try {
        publishShared('ocr-markdown-index', '', {
            legacyKey: 'mist_ocr_markdown_index',
            index,
        });
    } catch (error) {
        console.warn('failed to publish shared ocr-markdown-index update', error);
    }
}

function getTranslatedMarkdownIndex() {
    return JSON.parse(localStorage.getItem('mist_translated_markdown_index') || '{}');
}

function saveTranslatedMarkdownIndex(index) {
    localStorage.setItem('mist_translated_markdown_index', JSON.stringify(index));
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
            saveOcrMarkdownIndex(ocrIndex);
        }

        const translatedIndex = getTranslatedMarkdownIndex();
        if (translatedIndex[oldName] && !translatedIndex[newName]) {
            translatedIndex[newName] = translatedIndex[oldName];
            delete translatedIndex[oldName];
            saveTranslatedMarkdownIndex(translatedIndex);
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
        saveOcrMarkdownIndex(ocrIndex);
    }

    const translatedIndex = getTranslatedMarkdownIndex();
    if (translatedIndex[name]) {
        delete translatedIndex[name];
        saveTranslatedMarkdownIndex(translatedIndex);
    }

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

    const index = getOcrMarkdownIndex();
    index[pdfName] = {
        ...(typeof index[pdfName] === 'object' ? index[pdfName] : {}),
        content: markdown,
        updatedAt: Date.now(),
    };
    saveOcrMarkdownIndex(index);
}

export async function getOcrMarkdown(pdfName) {
    if (!pdfName) return null;

    const index = getOcrMarkdownIndex();
    const entry = index[pdfName];
    if (!entry) return null;

    if (entry.content != null) return entry.content;

    // 旧フォーマット（CID）からの移行フォールバック
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
    saveOcrMarkdownIndex(index);
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

    const index = getTranslatedMarkdownIndex();
    index[pdfName] = {
        ...(index[pdfName] || {}),
        [targetLanguage]: {
            content: markdown,
            updatedAt: Date.now(),
        },
    };
    saveTranslatedMarkdownIndex(index);
}

export async function getTranslatedMarkdown(pdfName, targetLanguage) {
    if (!pdfName || !targetLanguage) return null;

    const index = getTranslatedMarkdownIndex();
    const entry = index[pdfName]?.[targetLanguage];
    if (!entry) return null;

    if (entry.content != null) return entry.content;

    // 旧フォーマット（CID）からの移行フォールバック
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
