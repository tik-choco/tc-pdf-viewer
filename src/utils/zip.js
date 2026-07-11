// Minimal client-side ZIP writer (STORE method — no compression, since PDFs
// are already compressed internally and this avoids pulling in a DEFLATE
// dependency for a folder-download feature). Produces a standard ZIP with
// the UTF-8 filename flag set so Japanese file/folder names extract
// correctly in Explorer, macOS Archive Utility, and 7-zip.

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        table[n] = c >>> 0;
    }
    return table;
})();

function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
    const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
    const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
    return { time, day };
}

class ByteWriter {
    constructor() {
        this.chunks = [];
        this.length = 0;
    }

    push(bytes) {
        this.chunks.push(bytes);
        this.length += bytes.length;
    }

    u16(value) {
        this.push(new Uint8Array([value & 0xff, (value >>> 8) & 0xff]));
    }

    u32(value) {
        this.push(new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]));
    }

    toUint8Array() {
        const out = new Uint8Array(this.length);
        let offset = 0;
        for (const chunk of this.chunks) {
            out.set(chunk, offset);
            offset += chunk.length;
        }
        return out;
    }
}

/**
 * @param {{ name: string, data: Uint8Array }[]} entries
 * @returns {Uint8Array} a complete .zip file
 */
export function createZip(entries) {
    const encoder = new TextEncoder();
    const { time, day } = dosDateTime(new Date());
    const UTF8_FLAG = 0x0800;

    const out = new ByteWriter();
    const centralRecords = [];

    for (const entry of entries) {
        const nameBytes = encoder.encode(entry.name);
        const data = entry.data;
        const crc = crc32(data);
        const localHeaderOffset = out.length;

        out.u32(0x04034b50);
        out.u16(20); // version needed
        out.u16(UTF8_FLAG);
        out.u16(0); // method: store
        out.u16(time);
        out.u16(day);
        out.u32(crc);
        out.u32(data.length); // compressed size
        out.u32(data.length); // uncompressed size
        out.u16(nameBytes.length);
        out.u16(0); // extra field length
        out.push(nameBytes);
        out.push(data);

        centralRecords.push({ nameBytes, crc, size: data.length, localHeaderOffset });
    }

    const centralDirStart = out.length;
    for (const record of centralRecords) {
        out.u32(0x02014b50);
        out.u16(20); // version made by
        out.u16(20); // version needed
        out.u16(UTF8_FLAG);
        out.u16(0); // method: store
        out.u16(time);
        out.u16(day);
        out.u32(record.crc);
        out.u32(record.size);
        out.u32(record.size);
        out.u16(record.nameBytes.length);
        out.u16(0); // extra field length
        out.u16(0); // comment length
        out.u16(0); // disk number start
        out.u16(0); // internal file attributes
        out.u32(0); // external file attributes
        out.u32(record.localHeaderOffset);
        out.push(record.nameBytes);
    }
    const centralDirSize = out.length - centralDirStart;

    out.u32(0x06054b50);
    out.u16(0); // disk number
    out.u16(0); // disk with central dir
    out.u16(centralRecords.length);
    out.u16(centralRecords.length);
    out.u32(centralDirSize);
    out.u32(centralDirStart);
    out.u16(0); // comment length

    return out.toUint8Array();
}

/** Sanitizes a folder/file name for use inside a zip archive entry path. */
export function sanitizeZipSegment(name) {
    return name.replace(/[\\/]/g, '_').trim() || 'untitled';
}
