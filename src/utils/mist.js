import { MistNode } from '../lib/mistlib/index.js';
import { readDeviceId } from './device.js';

// Presence event types emitted by mistlib's onEvent callback. Not exported as
// named constants by the mistlib build in this repo, so mirrored here as
// numeric literals. Confirmed against tc-translate's vendored copy of the same
// mistlib-wasm build (src/vendor/mistlib/wrappers/web/index.js), which hand-
// authors the full enum: EVENT_RAW=0, EVENT_OVERLAY=1, EVENT_NEIGHBORS=2,
// EVENT_AOI_ENTERED=3, EVENT_AOI_LEFT=4, EVENT_PEER_CONNECTED=5,
// EVENT_PEER_DISCONNECTED=6, EVENT_AOI_NODES=7. useSync.js's
// PRESENCE_EVENT_TYPES = {2, 3, 4} is unrelated: it tracks NEIGHBORS/
// AOI_ENTERED/AOI_LEFT for peer-count refresh, not connect/disconnect — do
// not copy those values here again.
export const EVENT_PEER_CONNECTED = 5;
export const EVENT_PEER_DISCONNECTED = 6;

const MISTLLM_NODE_ID_KEY = 'tc-pdf-viewer-mistllm-node-id-v1';

// crypto.randomUUID is only available in secure contexts (HTTPS/localhost);
// fall back to getRandomValues when served over plain HTTP on the LAN.
// Mirrors tc-translate's src/lib/mistllm/node.ts:16-27.
export function randomId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// NOTE: MistNode in this app is a single global instance shared by pdf-sync
// and mistllm (mistlib supports only one node/room at a time), so its actual
// wire identity is `deviceId` (see below), not this id. This separate
// mistllm-scoped id exists only for display in the network provider UI panel,
// mirroring tc-translate's persisted node id without touching the app-wide
// device identity used elsewhere.
export function getOrCreateMistllmNodeId() {
  const existing = localStorage.getItem(MISTLLM_NODE_ID_KEY);
  if (existing) return existing;
  const id = randomId();
  localStorage.setItem(MISTLLM_NODE_ID_KEY, id);
  return id;
}

const deviceId = readDeviceId();
const sysNode = new MistNode(deviceId);
let _initPromise = null;
let _dispatcherInstalled = false;
const _eventListeners = new Set();

export async function getMistNode() {
  if (!_initPromise) {
    _initPromise = sysNode.initWithConfig();
  }
  await _initPromise;
  if (!_dispatcherInstalled) {
    _dispatcherInstalled = true;
    sysNode.onEvent((eventType, fromId, payload) => {
      _eventListeners.forEach((listener) => {
        try {
          listener(eventType, fromId, payload);
        } catch (err) {
          console.error('mist event listener failed:', err);
        }
      });
    });
  }
  return sysNode;
}

/**
 * Registers an event listener on the shared MistNode. MistNode.onEvent is a
 * single slot, so all consumers must go through this multiplexer instead of
 * calling node.onEvent directly. Returns an unsubscribe function.
 */
export function addMistEventListener(handler) {
  _eventListeners.add(handler);
  return () => {
    _eventListeners.delete(handler);
  };
}

// mistlib supports only one room per node globally, so features that join a
// room (pdf-sync, mistllm) are mutually exclusive. They must claim the room
// before joinRoom and release it after leaveRoom.
let _roomOwner = null;
let _roomId = null;

/**
 * Claims the (single) room slot for `owner`. Throws if another owner holds it.
 */
export function claimRoom(owner, roomId) {
  if (_roomOwner !== null && _roomOwner !== owner) {
    throw new Error(
      owner === 'mistllm'
        ? '同期セッション使用中はLLMネットワークに接続できません'
        : 'LLMネットワーク接続中は同期セッションを開始できません',
    );
  }
  _roomOwner = owner;
  _roomId = roomId;
}

/** Releases the room slot if `owner` currently holds it. */
export function releaseRoom(owner) {
  if (_roomOwner === owner) {
    _roomOwner = null;
    _roomId = null;
  }
}

/** Returns the current room owner ('pdf-sync' | 'mistllm' | null). */
export function getRoomOwner() {
  return _roomOwner;
}
