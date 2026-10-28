import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SourceTextModule, SyntheticModule } from 'node:vm';
import * as mist from '@tik-choco/mistlib-web';

// Run with: node --experimental-vm-modules --test scripts/*.test.mjs
test('sync handles neighbor and AOI events without confusing peer events', async () => {
    const states = [];
    const refs = [];
    let stateIndex = 0;
    let refIndex = 0;
    const hooks = {
        useState(initial) {
            const index = stateIndex++;
            if (!(index in states)) states[index] = initial;
            return [states[index], value => {
                states[index] = typeof value === 'function' ? value(states[index]) : value;
            }];
        },
        useRef(initial) {
            const index = refIndex++;
            return refs[index] ??= { current: initial };
        },
        useMemo: fn => fn(),
        useCallback: fn => fn,
        useEffect() {},
    };
    const sent = [];
    let nodes = [{ id: 'self' }];
    let reads = 0;
    const node = {
        async init() {},
        onEvent(handler) { this.handler = handler; },
        async joinRoom(roomId) { this.roomId = roomId; },
        getAllNodes() { reads++; return nodes; },
        sendMessage(...args) { sent.push(args); },
        leaveRoom() { this.left = true; },
    };
    const imports = {
        'preact/hooks': hooks,
        '@tik-choco/mistlib-web': mist,
        '../utils/device.js': { readDeviceId: () => 'self' },
        '../services/mistllm.js': { createSyncNode: roomId => {
            assert.equal(roomId, 'pdf-sync-team');
            return node;
        } },
    };
    const module = new SourceTextModule(await readFile(new URL('../src/hooks/useSync.js', import.meta.url), 'utf8'));
    await module.link(specifier => {
        const exports = imports[specifier];
        assert.ok(exports, `Unexpected import: ${specifier}`);
        return new SyntheticModule(Object.keys(exports), function () {
            for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
        });
    });
    await module.evaluate();

    const previousWindow = globalThis.window;
    globalThis.window = {
        location: { search: '?room=team', href: 'https://example.test/?room=team' },
        setTimeout: () => 1,
        clearTimeout() {},
    };
    try {
        const render = () => {
            stateIndex = 0;
            refIndex = 0;
            return module.namespace.useSync({ state: { page: 1 }, onReplaceState() {}, isEditing: false });
        };
        const sync = render();
        assert.equal(sync.startSync(), 'team');
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(node.roomId, 'pdf-sync-team');
        assert.equal(render().peerCount, 0);

        const bytes = text => new TextEncoder().encode(text);
        nodes = [{ id: 'self' }, { id: 'peer-1' }];
        node.handler(mist.EVENT_NEIGHBORS, 'peer-1', bytes('[]'));
        assert.equal(render().peerCount, 1);
        assert.equal(sent.length, 1);
        assert.equal(sent[0][1].type, 'snapshot');
        assert.equal(sent[0][2], mist.DELIVERY_RELIABLE);

        nodes = [...nodes, { id: 'peer-2' }];
        const readsBeforePeer = reads;
        node.handler(mist.EVENT_PEER_CONNECTED, 'peer-2', bytes('joined'));
        assert.equal(reads, readsBeforePeer);
        assert.equal(render().peerCount, 1);
        assert.equal(sent.length, 1);
        node.handler(mist.EVENT_AOI_ENTERED, 'peer-2', bytes('entered'));
        assert.equal(render().peerCount, 2);
        assert.equal(sent.length, 1);

        nodes = [{ id: 'self' }, { id: 'peer-1' }];
        node.handler(mist.EVENT_AOI_LEFT, 'peer-2', bytes('left'));
        assert.equal(render().peerCount, 1);
        nodes = [{ id: 'self' }];
        const readsBeforeDisconnect = reads;
        node.handler(mist.EVENT_PEER_DISCONNECTED, 'peer-1', bytes('left'));
        assert.equal(reads, readsBeforeDisconnect);
        assert.equal(render().peerCount, 1);
        assert.equal(sent.length, 1);
        sync.disconnect();
        assert.equal(node.left, true);
    } finally {
        globalThis.window = previousWindow;
    }
});
