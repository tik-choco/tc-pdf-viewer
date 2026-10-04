import { createRoomConsumers, createSharedNodeScope } from '@tik-choco/mistai';
import { MistNode } from '../lib/mistlib/index.js';
import { captureMistBuildInfo, markMistLoadError } from '../lib/mistBuildInfo.js';
import { readDeviceId } from '../utils/device.js';
import { mistSignalingConfig } from './mistSignaling.js';

// Pattern B: storage, PDF sync, consumers and providers all use this one node.
const deviceId = readDeviceId();
const node = new MistNode(deviceId, mistSignalingConfig());
let ready;

export async function getMistNode() {
    ready ??= node.init().catch(error => {
        ready = undefined;
        markMistLoadError();
        throw error;
    });
    await ready;
    captureMistBuildInfo();
    return node;
}

export const createSharedMistNode = createSharedNodeScope(() => ({
    init: async () => { await getMistNode(); },
    onEvent: handler => node.onEvent(handler),
    joinRoom: room => node.joinRoom(room),
    joinRoomAsync: room => node.joinRoomAsync(room),
    leaveRoom: room => node.leaveRoom(room),
    sendMessage: (to, payload, delivery, room) => node.sendMessage(to, payload, delivery, room),
}));

export const rooms = createRoomConsumers(createSharedMistNode, {
    nodeIdStorageKey: 'tc-pdf-viewer-device-id',
    requestTimeoutMs: 120000,
    providerWaitTimeoutMs: 20000,
});

/** A PDF-sync handle owns only its own room, even while AI rooms are active. */
export function createSyncNode(roomId) {
    const handle = createSharedMistNode(deviceId);
    handle.getAllNodes = () => node.getAllNodes(roomId);
    return handle;
}
