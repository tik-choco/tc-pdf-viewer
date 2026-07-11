// Mirrors the whole PDF library (folders + PDFs) into the family's neutral
// encrypted-bundle format: FileBundle/FolderBundle records written to mist
// storage (shared OPFS `mistlib-blocks`) and announced on the shared bus's
// `folder-export` topic. A drive-implementing app (tc-storage) picks the
// bundle up via its own CRDT merge, so the library shows up there as a
// "TC Note" root folder with one subfolder per tc-pdf-viewer folder — with
// zero code dependency in either direction. This app must never write
// tc-storage's own workspace state (`tc-storage-snapshot-v1`) directly.
// Sender pattern copied from tc-travel/src/lib/drive/export.ts; record
// shapes and per-field {updatedAt, nodeId} LWW stamps mirror
// tc-storage/src/storage/domain.ts + crdt.ts.
import { storage_add, storage_get } from '../lib/mistlib/index.js';
import { getMistNode } from '../utils/mist.js';
import { readDeviceId } from '../utils/device.js';
import { publishShared, readShared } from './sharedBus.js';
import { bytesToBase64, encryptJson, generateFolderKey, sha256Hex } from './driveCrypto.js';

const FOLDER_EXPORT_TOPIC = 'folder-export';
const STATE_KEY = 'tc-pdf-viewer-drive-export-v1';
const ROOT_FOLDER_NAME = 'TC Note';
const DEFAULT_FOLDER = 'Default';
const MIME_TYPE = 'application/pdf';
const DEBOUNCE_MS = 1500;

const encoder = new TextEncoder();

/**
 * Persisted exporter state. The records are the drive contract's
 * FolderRecord/FileRecord shapes (dataUrl always stripped from files), kept
 * verbatim between exports so re-exports only re-stamp fields that actually
 * changed — rebuilding them with fresh stamps would make the reading app's
 * per-field LWW merge silently revert edits the user made over there.
 * Tombstoned (deletedAt) records are kept forever so a drive app that was
 * closed during the deletion still learns about it from a later bundle.
 *
 * @typedef {object} DriveExportState
 * @property {string} folderId root FolderRecord id
 * @property {string} passphrase folder key all bundles are encrypted with
 * @property {object} folder root FolderRecord, stamped once at creation
 * @property {object[]} subfolders one FolderRecord per tc-pdf-viewer folder
 * @property {object[]} files one FileRecord per PDF (content stripped)
 * @property {Record<string, string>} sources fileRecordId -> the pdf-viewer
 *   source CID its FileBundle was built from (content-change detection)
 * @property {string} [lastPublishedCid] CID of the last published FolderBundle
 */

/** In-memory mirror of the persisted state: if localStorage writes fail
 *  (quota, private browsing), later exports in this session still reuse the
 *  same folder + passphrase instead of forking into a second folder. */
let memoryState = null;

function loadState() {
    try {
        const raw = localStorage.getItem(STATE_KEY);
        if (!raw) return memoryState;
        return parseState(raw) ?? memoryState;
    } catch {
        return memoryState;
    }
}

function parseState(raw) {
    const parsed = JSON.parse(raw);
    if (
        !parsed ||
        typeof parsed.folderId !== 'string' ||
        typeof parsed.passphrase !== 'string' ||
        !parsed.folder || typeof parsed.folder !== 'object' ||
        !Array.isArray(parsed.subfolders) ||
        !Array.isArray(parsed.files) ||
        !parsed.sources || typeof parsed.sources !== 'object'
    ) {
        return null;
    }
    return parsed;
}

function saveState(state) {
    memoryState = state;
    try {
        localStorage.setItem(STATE_KEY, JSON.stringify(state));
    } catch (error) {
        console.warn('tc-pdf-viewer: failed to persist drive export state', error);
    }
}

// On first creation, every field gets the same fresh stamp (mirrors
// tc-storage's stampAll).
function stampAllFields(record, updatedAt, nodeId) {
    const fieldVersions = {};
    for (const key of Object.keys(record)) {
        if (key !== 'fieldVersions') fieldVersions[key] = { updatedAt, nodeId };
    }
    return { ...record, fieldVersions };
}

// On re-export, only the fields in `patch` get a fresh stamp, so the reading
// app's per-field LWW merge doesn't clobber unrelated fields the user may
// have edited there. A patch value of `undefined` removes the field but
// still stamps it — the reader's merge treats "absent field + newer stamp"
// as a field deletion (used to revive tombstoned records: deletedAt gone,
// stamp fresh).
function stampPatch(record, patch, updatedAt, nodeId) {
    const next = { ...record, updatedAt };
    const fieldVersions = { ...(record.fieldVersions ?? {}) };
    for (const field of Object.keys(patch)) {
        if (patch[field] === undefined) delete next[field];
        else next[field] = patch[field];
        fieldVersions[field] = { updatedAt, nodeId };
    }
    return { ...next, fieldVersions };
}

// Strips raw content (and its meaningless fieldVersions entry) before a
// FileRecord goes into a FolderBundle or the persisted state.
function stripFileContent(file) {
    const { dataUrl: _dataUrl, fieldVersions, ...rest } = file;
    if (!fieldVersions?.dataUrl) return { ...rest, fieldVersions };
    const { dataUrl: _dataUrlVersion, ...versions } = fieldVersions;
    return { ...rest, fieldVersions: versions };
}

// tc-pdf-viewer identifies folders and PDFs by name (no stable internal id),
// so record ids are derived from the name: a rename shows up as a tombstone
// of the old record plus a fresh record, which the diff below produces
// naturally. Names are unique within the app, so ids can't collide.
async function deterministicId(prefix, name) {
    const hash = await sha256Hex(encoder.encode(name));
    return `${prefix}-${hash.slice(0, 24)}`;
}

function buildRootFolder(folderId, now, nodeId) {
    const folder = {
        id: folderId,
        name: ROOT_FOLDER_NAME,
        parentId: null,
        sortOrder: Date.parse(now),
        color: 'teal',
        encrypted: true,
        // shareEnabled matters beyond sharing: the reading app resolves the
        // decryption key for files in SUBfolders via their nearest
        // shareEnabled ancestor (it only receives one key, for this root).
        shareEnabled: true,
        sharedRoomId: `tc-pdf-viewer-${folderId.replace(/^folder-pdfv-/, '')}`,
        createdAt: now,
        updatedAt: now,
    };
    return stampAllFields(folder, now, nodeId);
}

function buildSubfolder(id, name, sortOrder, parentId, now, nodeId) {
    const folder = {
        id,
        name,
        parentId,
        sortOrder,
        color: 'teal',
        encrypted: true,
        shareEnabled: false,
        sharedRoomId: `tc-pdf-viewer-${id.replace(/^folder-pdfv-/, '')}`,
        createdAt: now,
        updatedAt: now,
    };
    return stampAllFields(folder, now, nodeId);
}

function readPdfIndex() {
    try {
        const parsed = JSON.parse(localStorage.getItem('mist_files_index') ?? '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function readCustomFolders() {
    try {
        const parsed = JSON.parse(localStorage.getItem('mist_custom_folders') ?? '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/** Reconciles the drive records with the current library and returns whether
 *  anything changed. Mutates `state` (subfolders/files/sources) in place. */
async function reconcile(state, pdfIndex, customFolders, now, nodeId) {
    let dirty = false;

    const folderNames = [...new Set([
        ...customFolders,
        ...pdfIndex.map((file) => file.folder || DEFAULT_FOLDER),
    ])];
    const folderIdByName = new Map();
    for (let position = 0; position < folderNames.length; position += 1) {
        const name = folderNames[position];
        const id = await deterministicId('folder-pdfv', name);
        folderIdByName.set(name, id);
        const index = state.subfolders.findIndex((folder) => folder.id === id);
        if (index === -1) {
            state.subfolders.push(buildSubfolder(id, name, position, state.folderId, now, nodeId));
            dirty = true;
            continue;
        }
        const existing = state.subfolders[index];
        const patch = {};
        if (existing.sortOrder !== position) patch.sortOrder = position;
        if (existing.deletedAt) patch.deletedAt = undefined;
        if (Object.keys(patch).length > 0) {
            state.subfolders[index] = stampPatch(existing, patch, now, nodeId);
            dirty = true;
        }
    }
    const activeFolderIds = new Set(folderIdByName.values());
    for (let index = 0; index < state.subfolders.length; index += 1) {
        const folder = state.subfolders[index];
        if (activeFolderIds.has(folder.id) || folder.deletedAt) continue;
        state.subfolders[index] = stampPatch(folder, { deletedAt: now }, now, nodeId);
        dirty = true;
    }

    const activeFileIds = new Set();
    for (let position = 0; position < pdfIndex.length; position += 1) {
        const entry = pdfIndex[position];
        if (!entry || typeof entry.name !== 'string' || !entry.name || typeof entry.cid !== 'string' || !entry.cid) continue;
        const id = await deterministicId('file-pdfv', entry.name);
        if (activeFileIds.has(id)) continue;
        activeFileIds.add(id);
        const folderRecordId = folderIdByName.get(entry.folder || DEFAULT_FOLDER);
        const index = state.files.findIndex((file) => file.id === id);
        let record = index === -1 ? null : state.files[index];
        const contentChanged = state.sources[id] !== entry.cid;

        // Bytes are only pulled (and a FileBundle re-encrypted) when the
        // content is new/changed or its bundle was never stored — metadata
        // moves (folder, order, revive) reuse the existing lastCid.
        let bytes = null;
        if (!record || contentChanged || !record.lastCid) {
            try {
                bytes = await storage_get(entry.cid);
            } catch (error) {
                // Bytes not in the local block store yet (e.g. synced from a
                // peer before prefetch finished) — skip and retry on the next
                // export; an existing record still gets its metadata updates.
                console.warn(`tc-pdf-viewer: drive export deferred for ${entry.name} (content unavailable)`, error);
                if (!record) continue;
            }
        }

        if (!record) {
            const checksum = await sha256Hex(bytes);
            record = stampAllFields({
                id,
                folderId: folderRecordId,
                sortOrder: position,
                name: entry.name,
                mimeType: MIME_TYPE,
                size: bytes.byteLength,
                checksum,
                version: 1,
                starred: false,
                createdAt: now,
                updatedAt: now,
            }, now, nodeId);
            dirty = true;
        } else {
            const patch = {};
            if (record.folderId !== folderRecordId) patch.folderId = folderRecordId;
            if (record.sortOrder !== position) patch.sortOrder = position;
            if (record.deletedAt) patch.deletedAt = undefined;
            if (bytes && contentChanged) {
                const checksum = await sha256Hex(bytes);
                if (record.checksum !== checksum) patch.checksum = checksum;
                if (record.size !== bytes.byteLength) patch.size = bytes.byteLength;
                patch.version = record.version + 1;
            }
            if (Object.keys(patch).length > 0) {
                record = stampPatch(record, patch, now, nodeId);
                dirty = true;
            }
        }

        if (bytes) {
            const folderRecord = state.subfolders.find((folder) => folder.id === folderRecordId) ?? state.folder;
            const dataUrl = `data:${MIME_TYPE};base64,${bytesToBase64(bytes)}`;
            const fileBundle = { version: 1, exportedAt: now, originNode: nodeId, folder: folderRecord, file: { ...record, dataUrl } };
            const encrypted = await encryptJson(fileBundle, state.passphrase);
            const fileCid = await storage_add(`${id}.tc-file.enc.json`, encoder.encode(JSON.stringify(encrypted)));
            if (record.lastCid !== fileCid) {
                record = stampPatch(record, { lastCid: fileCid }, new Date().toISOString(), nodeId);
            }
            state.sources[id] = entry.cid;
            dirty = true;
        }

        if (index === -1) state.files.push(stripFileContent(record));
        else state.files[index] = stripFileContent(record);
    }
    for (let index = 0; index < state.files.length; index += 1) {
        const file = state.files[index];
        if (activeFileIds.has(file.id) || file.deletedAt) continue;
        state.files[index] = stampPatch(file, { deletedAt: now }, now, nodeId);
        delete state.sources[file.id];
        dirty = true;
    }

    return dirty;
}

/** Immediate, unserialized export pass. Prefer scheduleDriveExport() in app
 *  code; exported for tests. */
export async function doDriveExport() {
    const pdfIndex = readPdfIndex();
    let state = loadState();
    // Don't create the drive folder until there is at least one PDF to show.
    if (!state && pdfIndex.length === 0) return;

    await getMistNode(); // storage_add/storage_get need the mist runtime initialized
    const nodeId = readDeviceId();
    const now = new Date().toISOString();

    if (!state) {
        const folderId = `folder-pdfv-${crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;
        state = {
            folderId,
            passphrase: generateFolderKey(),
            folder: buildRootFolder(folderId, now, nodeId),
            subfolders: [],
            files: [],
            sources: {},
        };
        // Persist immediately: even if the rest of this export fails, retries
        // reuse the same folder + passphrase instead of forking new folders.
        saveState(state);
    }

    state = { ...state, subfolders: [...state.subfolders], files: [...state.files], sources: { ...state.sources } };
    const dirty = await reconcile(state, pdfIndex, readCustomFolders(), now, nodeId);
    saveState(state);

    // Republish even without changes when another app's record has since
    // overwritten ours on the single-record topic, so a drive app that was
    // closed at the time can still pick our folder up on its next start.
    const busCid = readShared(FOLDER_EXPORT_TOPIC)?.cid;
    if (!dirty && state.lastPublishedCid && busCid === state.lastPublishedCid) return;

    let folderCid = state.lastPublishedCid;
    const exportedAt = new Date().toISOString();
    if (dirty || !folderCid) {
        const folderBundle = {
            version: 1,
            exportedAt,
            originNode: nodeId,
            folder: state.folder,
            folders: [state.folder, ...state.subfolders],
            files: state.files,
        };
        const encrypted = await encryptJson(folderBundle, state.passphrase);
        folderCid = await storage_add(`${state.folderId}.tc-folder.enc.json`, encoder.encode(JSON.stringify(encrypted)));
        saveState({ ...state, lastPublishedCid: folderCid });
    }

    publishShared(FOLDER_EXPORT_TOPIC, folderCid, {
        folderId: state.folderId,
        folderName: state.folder.name,
        passphrase: state.passphrase,
        fileCount: state.files.filter((file) => !file.deletedAt).length,
        exportedAt,
    });
}

let debounceTimer = null;
/** Serializes exports: the whole flow is a read-modify-write over the
 *  persisted state, so two concurrent runs would drop each other's records. */
let exportChain = Promise.resolve();

/**
 * Schedules a (debounced) mirror of the current library into the drive
 * bundle. Call after any write to `mist_files_index` / `mist_custom_folders`;
 * a run that finds nothing changed publishes nothing.
 */
export function scheduleDriveExport(delayMs = DEBOUNCE_MS) {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        debounceTimer = null;
        exportChain = exportChain
            .then(() => doDriveExport())
            .catch((error) => console.warn('tc-pdf-viewer: drive export failed', error));
    }, delayMs);
}
