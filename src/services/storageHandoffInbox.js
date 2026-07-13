// Consumes the shared `pdf-viewer-inbox` topic (published by tc-storage on
// the same origin when the user clicks "open in tc-pdf-viewer" on a PDF
// preview) and imports each new PDF into this app's library via the normal
// savePdf() upload path, so an imported file is checksummed, indexed, and
// mirrored into the drive export exactly like any file added locally.
//
// Each item's bytes live behind mistlib's storage_add, encrypted client-side
// by tc-storage with a fresh AES-256-GCM key carried alongside the CID in
// the item itself (same-origin localStorage is the trust boundary for this
// bus, same as everywhere else — see protocol/docs/data-contracts/docs/
// SHARED_BUS.md). This module fetches the ciphertext via storage_get,
// decrypts it, and verifies the SHA-256 checksum before handing the
// plaintext to savePdf() — it never touches tc-storage's own snapshot
// directly.
//
// Items are deduped by their stable `id` (persisted in localStorage), so a
// republished list never creates duplicates. Items that fail to
// decrypt/verify are unrecoverable (the ciphertext and checksum are fixed at
// publish time) or aren't PDFs at all, so they're marked imported too rather
// than retried forever on every republish. Items that fail to *resolve* for
// a transient reason (mistlib isn't initialized yet, or storage_get itself
// failed — e.g. a network hiccup or the block simply isn't replicated yet)
// are a different story: retrying can succeed later, so those ids are
// deliberately left out of the imported set and get another attempt on the
// next republish/subscription tick or mount.
//
// Mirrors tc-storage's src/app/appDriveInbox.ts consumer (the reverse
// direction: tc-storage -> tc-note there, tc-storage -> tc-pdf-viewer here).
// Contract: topic `pdf-viewer-inbox` (v1); item shape is published by
// tc-storage (src/storage/fileHandoff.ts). See
// protocol/docs/data-contracts/docs/SHARED_BUS.md.

import { savePdf, initMist } from './storage.js';
import { storage_get } from '../lib/mistlib/index.js';
import { sha256Hex } from './driveCrypto.js';

export const inboxTopic = 'pdf-viewer-inbox';

const importedIdsKey = 'tc-pdf-viewer-inbox-imported-v1';
const maxImportedIds = 1000;
const INBOX_FOLDER = 'tc-storageから追加';

/** One file entry in the inbox topic's `meta.items` list. Mirrors
 *  tc-storage's FileHandoffItem (src/storage/fileHandoff.ts). */

/**
 * Parses the current topic record's items, tolerating malformed/missing meta.
 * @param {Record<string, unknown> | undefined} meta
 * @returns {Array<{id: string, name: string, mimeType: string, size: number, checksum: string, cid: string, key: string, iv: string, addedAt: string}>}
 */
export function parseHandoffItems(meta) {
    const rawItems = meta ? meta.items : undefined;
    if (!Array.isArray(rawItems)) return [];
    const items = [];
    for (const raw of rawItems) {
        if (raw === null || typeof raw !== 'object') continue;
        if (typeof raw.id !== 'string' || !raw.id) continue;
        if (typeof raw.name !== 'string' || !raw.name) continue;
        if (typeof raw.mimeType !== 'string') continue;
        if (typeof raw.size !== 'number') continue;
        if (typeof raw.checksum !== 'string' || !raw.checksum) continue;
        if (typeof raw.cid !== 'string' || !raw.cid) continue;
        if (typeof raw.key !== 'string' || !raw.key) continue;
        if (typeof raw.iv !== 'string' || !raw.iv) continue;
        if (typeof raw.addedAt !== 'string') continue;
        items.push({
            id: raw.id,
            name: raw.name,
            mimeType: raw.mimeType,
            size: raw.size,
            checksum: raw.checksum,
            cid: raw.cid,
            key: raw.key,
            iv: raw.iv,
            addedAt: raw.addedAt,
        });
    }
    return items;
}

function isPdfItem(item) {
    return item.mimeType === 'application/pdf' || /\.pdf$/i.test(item.name);
}

function loadImportedIds() {
    try {
        const raw = localStorage.getItem(importedIdsKey);
        if (!raw) return new Set();
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || parsed.v !== 1 || !Array.isArray(parsed.ids)) return new Set();
        return new Set(parsed.ids.filter((id) => typeof id === 'string'));
    } catch {
        return new Set();
    }
}

function saveImportedIds(ids) {
    // Keep only the most recent ids so the dedupe set can't grow unbounded.
    const list = [...ids].slice(-maxImportedIds);
    try {
        localStorage.setItem(importedIdsKey, JSON.stringify({ v: 1, ids: list }));
    } catch (error) {
        console.warn('tc-pdf-viewer: failed to persist pdf-viewer-inbox imported ids', error);
    }
}

/** @param {string} base64 @returns {Uint8Array} */
function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/** @param {Uint8Array} bytes @returns {ArrayBuffer} */
function toArrayBuffer(bytes) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
}

/**
 * Outcome of resolving one item: a usable file, a permanent (unrecoverable)
 * failure, or a transient one worth retrying later.
 * @typedef {{kind: 'resolved', bytes: Uint8Array} | {kind: 'permanent'} | {kind: 'transient'}} ResolveItemResult
 */

/**
 * Fetches, decrypts, and checksum-verifies one item's ciphertext.
 * Distinguishes unrecoverable failures (checksum mismatch, decrypt failure)
 * from transient ones (mist init / storage_get failures) so callers can
 * retry only the latter.
 * @param {ReturnType<typeof parseHandoffItems>[number]} item
 * @returns {Promise<ResolveItemResult>}
 */
async function resolveHandoffItem(item) {
    let cipherText;
    try {
        await initMist();
        cipherText = await storage_get(item.cid);
    } catch (error) {
        console.warn('tc-pdf-viewer: transient failure resolving pdf-viewer-inbox item; will retry later', item.id, item.name, error);
        return { kind: 'transient' };
    }
    try {
        const cryptoKey = await crypto.subtle.importKey('raw', toArrayBuffer(base64ToBytes(item.key)), 'AES-GCM', false, ['decrypt']);
        const iv = base64ToBytes(item.iv);
        const plainBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, cryptoKey, toArrayBuffer(cipherText));
        const plainBytes = new Uint8Array(plainBuffer);
        const checksum = await sha256Hex(plainBytes);
        if (checksum !== item.checksum) {
            console.warn('tc-pdf-viewer: pdf-viewer-inbox checksum mismatch, skipping item', item.id, item.name);
            return { kind: 'permanent' };
        }
        return { kind: 'resolved', bytes: plainBytes };
    } catch (error) {
        console.warn('tc-pdf-viewer: failed to decrypt pdf-viewer-inbox item, skipping', item.id, item.name, error);
        return { kind: 'permanent' };
    }
}

// Serialize imports: subscription ticks and the initial mount read can both
// fire in quick succession, and resolving/saving is async, so we must not
// process overlapping calls concurrently (each reads localStorage's
// imported-ids set, so a race could double-import).
let inFlight = Promise.resolve();

async function runImport(record, { addPdf = savePdf, resolveItem = resolveHandoffItem, onImported } = {}) {
    const items = parseHandoffItems(record?.meta);
    if (!items.length) return;
    const imported = loadImportedIds();
    const fresh = items.filter((item) => !imported.has(item.id));
    if (!fresh.length) return;

    const importedNames = [];
    for (const item of fresh) {
        if (!isPdfItem(item)) {
            console.warn('tc-pdf-viewer: skipping non-PDF pdf-viewer-inbox item', item.id, item.name);
            imported.add(item.id);
            continue;
        }

        const result = await resolveItem(item);
        if (result.kind === 'resolved') {
            try {
                await addPdf(item.name, result.bytes, INBOX_FOLDER);
                imported.add(item.id);
                importedNames.push(item.name);
            } catch (error) {
                // Failed to add to the library (e.g. storage_add/network
                // hiccup) — leave it out of `imported` so it retries on the
                // next republish/subscription tick or mount.
                console.warn('tc-pdf-viewer: failed to add pdf-viewer-inbox item to library; will retry later', item.id, item.name, error);
            }
        } else if (result.kind === 'permanent') {
            imported.add(item.id);
        }
        // 'transient': leave out of `imported` entirely so the next
        // republish/subscription tick or mount retries it.
    }

    saveImportedIds(imported);

    if (importedNames.length > 0) {
        console.info('tc-pdf-viewer: imported files from pdf-viewer-inbox', importedNames.length);
        if (onImported) {
            try {
                onImported(importedNames);
            } catch (error) {
                console.warn('tc-pdf-viewer: pdf-viewer-inbox onImported callback failed', error);
            }
        }
    }
}

/**
 * Imports any not-yet-seen items from an inbox record. Safe to call
 * repeatedly (e.g. once on mount plus once per subscription tick) — calls
 * are serialized and idempotent. Never throws; all failures are logged.
 * @param {import('./sharedBus.js').SharedRecord | null | undefined} record
 * @param {{addPdf?: typeof savePdf, resolveItem?: typeof resolveHandoffItem, onImported?: (names: string[]) => void}} [options]
 * @returns {Promise<void>}
 */
export function importFromHandoffInbox(record, options = {}) {
    inFlight = inFlight
        .then(() => runImport(record, options))
        .catch((error) => console.warn('tc-pdf-viewer: pdf-viewer-inbox import failed', error));
    return inFlight;
}
