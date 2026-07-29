// Shared cross-app pointer/notification bus for the tik-choco app family,
// deployed to the same origin in production (https://tik-choco.github.io/<app>/)
// and already sharing localStorage (and, for apps that vendor mistlib, the
// mistlib OPFS block store).
//
// IMPORTANT: this file is vendored identically (modulo TS/JS syntax) into
// every family app. Keep the contract in sync when editing. See also
// protocol/docs/data-contracts/docs/SHARED_BUS.md for the full spec.
// Contract version: v1
//
// Design: this module does NOT depend on mistlib. It only stores/reads a
// "pointer" (a CID string produced by the caller via storage_add/storage_get,
// or "" when the payload is inlined in `meta`) plus small metadata, and fans
// out a same-origin notification when a topic is published. Resolving the
// CID to actual bytes is the caller's job.
//
// This is the JS+JSDoc rendering of the canonical reference copy
// (protocol/docs/data-contracts/reference/sharedBus.ts). Don't hand-edit the
// vendored per-app copies directly — regenerate them with
// protocol/scripts/sync-vendored.mjs instead, so drift doesn't creep back in.

/**
 * Diagnostic-only version tag for this vendored module (e.g. for logging
 * "which vendored copy is this app running"). It is NOT the compatibility
 * contract — the wire format (`SharedBusMessage`) and the localStorage record
 * shape (`SharedRecord`) are. A breaking change to either of those bumps the
 * `-v1` key/channel name suffixes below, independently of this constant.
 */
export const BUS_VERSION = 1;

/** @typedef {"tc-note"|"tc-storage"|"tc-pdf-viewer"|"tc-translate"|"tc-chat"|"tc-news"|"tc-town"|"tc-travel"|"tc-vrm-viewer"|"tc-books"|"tc-lingo"|"tc-presenter"} SharedAppName */

/** This vendored copy's app name, used as `SharedRecord.from`/`SharedBusMessage.from`.
 * Substituted per app by protocol/scripts/sync-vendored.mjs — do not edit by hand.
 * @type {SharedAppName} */
const APP_NAME = 'tc-pdf-viewer';

/**
 * @typedef {object} SharedRecord localStorage record stored at `tc-shared-<topic>-v1`.
 * @property {string} cid mistlib storage_add CID for the payload, or "" if
 *   this topic doesn't (yet) content-address its data and instead inlines
 *   everything in `meta`.
 * @property {Record<string, unknown>} meta Free-form per-topic metadata
 *   (e.g. an index snapshot, filenames, etc).
 * @property {string} updatedAt ISO 8601 timestamp of when this record was published.
 * @property {SharedAppName} from Which app published this record.
 */

/**
 * @typedef {object} SharedBusMessage BroadcastChannel message shape,
 *   broadcast on channel `tc-shared-bus-v1`.
 * @property {1} v
 * @property {"updated"} type
 * @property {string} topic
 * @property {string} cid
 * @property {SharedAppName} from
 * @property {string} updatedAt
 */

const CHANNEL_NAME = 'tc-shared-bus-v1';
const LOCAL_EVENT_NAME = 'tc-shared-bus-local-update';

function sharedKey(topic) {
    return `tc-shared-${topic}-v1`;
}

function isSharedRecord(value) {
    if (value === null || typeof value !== 'object') return false;
    return (
        typeof value.cid === 'string' &&
        typeof value.updatedAt === 'string' &&
        typeof value.from === 'string' &&
        value.meta !== null &&
        typeof value.meta === 'object' &&
        !Array.isArray(value.meta)
    );
}

function isSharedBusMessage(value) {
    if (value === null || typeof value !== 'object') return false;
    return (
        value.v === 1 &&
        value.type === 'updated' &&
        typeof value.topic === 'string' &&
        typeof value.cid === 'string' &&
        typeof value.from === 'string' &&
        typeof value.updatedAt === 'string'
    );
}

function openChannel() {
    if (typeof BroadcastChannel === 'undefined') return null;
    try {
        return new BroadcastChannel(CHANNEL_NAME);
    } catch {
        return null;
    }
}

/**
 * Publishes a pointer update for `topic`. Writes the localStorage contract
 * key, then notifies same-origin listeners: other tabs/apps via
 * BroadcastChannel, and same-tab subscribers via a local CustomEvent
 * (BroadcastChannel does not deliver to the sender's own tab).
 *
 * @param {string} topic
 * @param {string} cid
 * @param {Record<string, unknown>} meta
 */
export function publishShared(topic, cid, meta) {
    const record = {
        cid,
        meta,
        updatedAt: new Date().toISOString(),
        from: APP_NAME,
    };

    try {
        localStorage.setItem(sharedKey(topic), JSON.stringify(record));
    } catch (error) {
        console.warn(`tc-shared-bus: failed to persist topic "${topic}"`, error);
    }

    const message = {
        v: 1,
        type: 'updated',
        topic,
        cid,
        from: APP_NAME,
        updatedAt: record.updatedAt,
    };

    try {
        window.dispatchEvent(new CustomEvent(LOCAL_EVENT_NAME, { detail: message }));
    } catch (error) {
        console.warn(`tc-shared-bus: failed to dispatch local event for topic "${topic}"`, error);
    }

    const channel = openChannel();
    try {
        channel?.postMessage(message);
    } catch (error) {
        console.warn(`tc-shared-bus: failed to broadcast topic "${topic}"`, error);
    } finally {
        channel?.close();
    }
}

/**
 * Reads the current pointer for `topic`. Never throws; returns null if the
 * key is missing or malformed.
 *
 * @param {string} topic
 * @returns {SharedRecord | null}
 */
export function readShared(topic) {
    try {
        const raw = localStorage.getItem(sharedKey(topic));
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return isSharedRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Subscribes to updates for `topic`. Listens on both the BroadcastChannel
 * (cross-tab/cross-app) and the `storage` window event (cross-tab fallback,
 * also same-origin only), plus the same-tab local CustomEvent dispatched by
 * `publishShared` (BroadcastChannel never delivers to its own sender).
 * Returns an unsubscribe function.
 *
 * @param {string} topic
 * @param {(record: SharedRecord) => void} callback
 * @returns {() => void}
 */
export function subscribeShared(topic, callback) {
    const key = sharedKey(topic);
    const channel = openChannel();

    function notifyFromRecord() {
        const record = readShared(topic);
        if (record) callback(record);
    }

    function onChannelMessage(event) {
        const message = event.data;
        if (!isSharedBusMessage(message) || message.topic !== topic) return;
        notifyFromRecord();
    }

    function onLocalEvent(event) {
        const message = event.detail;
        if (!isSharedBusMessage(message) || message.topic !== topic) return;
        notifyFromRecord();
    }

    function onStorageEvent(event) {
        if (event.key !== key) return;
        notifyFromRecord();
    }

    channel?.addEventListener('message', onChannelMessage);
    window.addEventListener(LOCAL_EVENT_NAME, onLocalEvent);
    window.addEventListener('storage', onStorageEvent);

    return () => {
        channel?.removeEventListener('message', onChannelMessage);
        channel?.close();
        window.removeEventListener(LOCAL_EVENT_NAME, onLocalEvent);
        window.removeEventListener('storage', onStorageEvent);
    };
}
