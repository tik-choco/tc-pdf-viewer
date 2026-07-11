// Implements the family's neutral encrypted-bundle crypto (see
// protocol/docs/data-contracts/docs/encrypted-bundle.md). Output format must
// stay byte-compatible with any app implementing that contract: AES-GCM 256,
// PBKDF2-SHA256 with 210000 iterations, 16-byte salt, 12-byte iv,
// base64-encoded fields. Ported from tc-travel/src/lib/drive/crypto.ts.

/**
 * @typedef {object} EncryptedPayload
 * @property {1} version
 * @property {'AES-GCM'} algorithm
 * @property {'PBKDF2-SHA256'} kdf
 * @property {number} iterations
 * @property {string} salt base64
 * @property {string} iv base64
 * @property {string} cipherText base64
 */

const encoder = new TextEncoder();
const webCryptoIterations = 210000;

/** @param {Uint8Array} bytes @returns {string} */
export function bytesToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
        const chunk = bytes.slice(index, index + chunkSize);
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
}

/** 24 random bytes, base64url-encoded — matches the family's folder-key
 *  format, so any drive-implementing app can use it under its own
 *  folder-key flow. */
export function generateFolderKey() {
    const cryptoApi = globalThis.crypto;
    if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
        throw new Error('tc-pdf-viewer: secure random generation is unavailable for folder key generation');
    }
    const bytes = new Uint8Array(24);
    cryptoApi.getRandomValues(bytes);
    return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * @param {unknown} value
 * @param {string} passphrase
 * @returns {Promise<EncryptedPayload>}
 */
export async function encryptJson(value, passphrase) {
    const phrase = passphrase.trim();
    if (!phrase) throw new Error('tc-pdf-viewer: an encryption passphrase is required');
    if (!globalThis.crypto?.subtle) throw new Error('tc-pdf-viewer: encryption requires the Web Crypto API (HTTPS or localhost)');
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = await deriveWebCryptoKey(phrase, salt);
    const data = encoder.encode(JSON.stringify(value));
    const encrypted = await subtleCrypto().encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv) }, key, toArrayBuffer(data));
    return {
        version: 1,
        algorithm: 'AES-GCM',
        kdf: 'PBKDF2-SHA256',
        iterations: webCryptoIterations,
        salt: bytesToBase64(salt),
        iv: bytesToBase64(iv),
        cipherText: bytesToBase64(new Uint8Array(encrypted)),
    };
}

/** @param {Uint8Array} bytes @returns {Promise<string>} sha256 hex digest */
export async function sha256Hex(bytes) {
    const digest = await subtleCrypto().digest('SHA-256', toArrayBuffer(bytes));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** @param {string} passphrase @param {Uint8Array} salt */
async function deriveWebCryptoKey(passphrase, salt) {
    const baseKey = await subtleCrypto().importKey('raw', toArrayBuffer(encoder.encode(passphrase)), 'PBKDF2', false, ['deriveKey']);
    return subtleCrypto().deriveKey(
        { name: 'PBKDF2', salt: toArrayBuffer(salt), iterations: webCryptoIterations, hash: 'SHA-256' },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
}

/** @param {number} length @returns {Uint8Array} */
function randomBytes(length) {
    const cryptoApi = globalThis.crypto;
    if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
        throw new Error('tc-pdf-viewer: secure random generation is unavailable for encryption');
    }
    const bytes = new Uint8Array(length);
    cryptoApi.getRandomValues(bytes);
    return bytes;
}

function subtleCrypto() {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) throw new Error('tc-pdf-viewer: Web Crypto API is unavailable');
    return subtle;
}

/** @param {Uint8Array} bytes @returns {ArrayBuffer} */
function toArrayBuffer(bytes) {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return copy.buffer;
}
