import { storage_add, storage_get, MistNode } from '../lib/mistlib/index.js';

let node = null;

export async function initMist() {
    if (node) return node;
    
    let nodeId = localStorage.getItem('mist_node_id');
    if (!nodeId) {
        nodeId = "pdf-user-" + Math.random().toString(36).substr(2, 9);
        localStorage.setItem('mist_node_id', nodeId);
    }
    
    node = new MistNode(nodeId);
    await node.init();
    return node;
}

// Manage index in localStorage since CID changes on every file addition
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
        return true;
    }
    return false;
}

export async function deletePdf(name) {
    const index = getFilesIndex();
    const newIndex = index.filter(f => f.name !== name);
    localStorage.setItem('mist_files_index', JSON.stringify(newIndex));
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

    // storage_get requires CIDv1
    return await storage_get(file.cid);
}

export async function saveExplanation(text, explanation) {
    await initMist();
    // Mist storage_add returns CID
    const cid = await storage_add(text, new TextEncoder().encode(explanation));
    
    // Save to explanation index
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
