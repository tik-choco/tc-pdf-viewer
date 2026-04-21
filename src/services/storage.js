import { storage_add, storage_get } from '../lib/mistlib/index.js';
import { getMistNode } from '../utils/mist.js';
import { readDeviceId } from '../utils/device.js';

export async function initMist() {
    return await getMistNode();
}

function getFilesIndex() {
    const saved = localStorage.getItem('mist_files_index');
    return saved ? JSON.parse(saved) : [];
}

function saveFileToIndex(name, cid) {
    const index = getFilesIndex();
    const existing = index.find(f => f.name === name);
    if (existing) {
        existing.cid = cid;
        existing.updatedAt = Date.now();
    } else {
        index.push({ name, cid, folder: 'Default', createdAt: Date.now(), updatedAt: Date.now() });
    }
    localStorage.setItem('mist_files_index', JSON.stringify(index));
}

function getOcrMarkdownIndex() {
    return JSON.parse(localStorage.getItem('mist_ocr_markdown_index') || '{}');
}

function saveOcrMarkdownIndex(index) {
    localStorage.setItem('mist_ocr_markdown_index', JSON.stringify(index));
}

export async function savePdf(name, data) {
    await initMist();
    const cid = await storage_add(name, data);
    console.log(`Stored ${name} with CID: ${cid}`);
    
    saveFileToIndex(name, cid);
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
}

export async function updatePdfFolder(name, folder) {
    const index = getFilesIndex();
    const file = index.find(f => f.name === name);
    if (file) {
        file.folder = folder;
        localStorage.setItem('mist_files_index', JSON.stringify(index));
    }
}

export async function updatePdfList(newIndex) {
    localStorage.setItem('mist_files_index', JSON.stringify(newIndex));
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
    const cid = await storage_add(`${pdfName}.ocr.md`, new TextEncoder().encode(markdown));

    const index = getOcrMarkdownIndex();
    index[pdfName] = {
        cid,
        updatedAt: Date.now(),
    };
    saveOcrMarkdownIndex(index);
    return cid;
}

export async function getOcrMarkdown(pdfName) {
    if (!pdfName) return null;

    await initMist();
    const index = getOcrMarkdownIndex();
    const entry = index[pdfName];
    const cid = typeof entry === 'string' ? entry : entry?.cid;
    if (!cid) return null;

    try {
        const data = await storage_get(cid);
        return new TextDecoder().decode(data);
    } catch (e) {
        return null;
    }
}

export function getOcrMarkdownIndexSnapshot() {
    return getOcrMarkdownIndex();
}
