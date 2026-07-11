// Self-reported per-app manifest for the tik-choco app family, vendored
// identically (modulo TS/JS syntax) into every family app. See
// protocol/docs/data-contracts/docs/app-manifest.md for the full spec.
// Contract version: v1
//
// Design: this module does NOT depend on mistlib or sharedBus.js. It only
// reads/writes a small JSON record at a per-app localStorage key so other
// apps can cheaply check "has this app ever run on this origin, and what
// topics does it know about" without needing the app itself to be open.
// This is a self-reported cache for UX guidance, not a trust/security
// boundary — see app-manifest.md for the caveats.
//
// This is the JS+JSDoc rendering of the canonical reference copy
// (protocol/docs/data-contracts/reference/appManifest.ts). Don't hand-edit
// the vendored per-app copies directly — regenerate them with
// protocol/scripts/sync-vendored.mjs instead. Unlike sharedBus.js, this file
// has no per-app placeholder to substitute: the app name is a runtime
// argument, so the vendored copy is byte-identical everywhere.

/**
 * @typedef {object} AppManifestV1
 * @property {1} v
 * @property {string} app "tc-note" など
 * @property {string} [version]
 * @property {number} [busVersion] vendored sharedBus の BUS_VERSION(診断用)
 * @property {string[]} publishes 書き込む sharedBus トピック
 * @property {string[]} consumes 購読/取り込みするトピック
 * @property {string[]} reads 契約に基づき直読みする他アプリの localStorage キー(完全一致文字列)
 * @property {string} updatedAt ISO 8601(最終起動時刻を兼ねる)
 */

function manifestKey(app) {
    return `tc-app-manifest:${app}`;
}

function isAppManifestV1(value) {
    if (value === null || typeof value !== 'object') return false;
    return (
        value.v === 1 &&
        typeof value.app === 'string' &&
        (value.version === undefined || typeof value.version === 'string') &&
        (value.busVersion === undefined || typeof value.busVersion === 'number') &&
        Array.isArray(value.publishes) &&
        value.publishes.every((item) => typeof item === 'string') &&
        Array.isArray(value.consumes) &&
        value.consumes.every((item) => typeof item === 'string') &&
        Array.isArray(value.reads) &&
        value.reads.every((item) => typeof item === 'string') &&
        typeof value.updatedAt === 'string'
    );
}

/**
 * Writes this app's manifest to `tc-app-manifest:<app>`, stamping `v: 1` and
 * `updatedAt` with the current time. Never throws: storage failures (quota,
 * disabled storage, etc.) are swallowed after a console.warn.
 *
 * @param {Omit<AppManifestV1, "v" | "updatedAt">} input
 */
export function writeAppManifest(input) {
    const manifest = {
        ...input,
        v: 1,
        updatedAt: new Date().toISOString(),
    };

    try {
        localStorage.setItem(manifestKey(input.app), JSON.stringify(manifest));
    } catch (error) {
        console.warn(`tc-app-manifest: failed to persist manifest for "${input.app}"`, error);
    }
}

/**
 * Reads and validates the manifest for `app`. Returns null if the key is
 * missing, the JSON is malformed, or the shape doesn't match `AppManifestV1`
 * (never throws).
 *
 * @param {string} app
 * @returns {AppManifestV1 | null}
 */
export function readAppManifest(app) {
    try {
        const raw = localStorage.getItem(manifestKey(app));
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return isAppManifestV1(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * Scans localStorage for all `tc-app-manifest:*` keys and returns the valid
 * manifests found (skipping any that fail to parse/validate). Never throws.
 *
 * @returns {AppManifestV1[]}
 */
export function listAppManifests() {
    const manifests = [];
    try {
        for (let i = 0; i < localStorage.length; i += 1) {
            const key = localStorage.key(i);
            if (!key || !key.startsWith('tc-app-manifest:')) continue;
            const app = key.slice('tc-app-manifest:'.length);
            const manifest = readAppManifest(app);
            if (manifest) manifests.push(manifest);
        }
    } catch {
        return manifests;
    }
    return manifests;
}
