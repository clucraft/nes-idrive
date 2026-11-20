'use strict';
/**
 * A small tar.gz writer and reader for the Store package (tools/build-store.js, test/run.js):
 * regular files only, ustar headers with owner 0:0, mode 0644 and one fixed time, gzip without a
 * name or time and with the OS byte set to Unix. The bytes depend only on the files (and the zlib
 * build), not on the machine or the day.
 *
 *   pack([{ name, data }])  -> Buffer (.tgz)
 *   unpack(Buffer)          -> [{ name, data }]
 */
const zlib = require('zlib');

const MTIME = Math.floor(Date.UTC(2026, 0, 1) / 1000);

function header(name, size) {
    const h = Buffer.alloc(512);
    const octal = (v, width) => (Array(width).join('0') + v.toString(8)).slice(-(width - 1)) + '\0';
    let prefix = '', base = name;
    if (Buffer.byteLength(name) > 100) {
        const cut = name.lastIndexOf('/', 155);
        prefix = name.slice(0, cut); base = name.slice(cut + 1);
        if (cut < 0 || Buffer.byteLength(prefix) > 155 || Buffer.byteLength(base) > 100) throw new Error('tar: name too long: ' + name);
    }
    h.write(base, 0, 100, 'utf8');
    h.write(octal(0o644, 8), 100, 8, 'latin1');
    h.write(octal(0, 8), 108, 8, 'latin1');
    h.write(octal(0, 8), 116, 8, 'latin1');
    h.write(octal(size, 12), 124, 12, 'latin1');
    h.write(octal(MTIME, 12), 136, 12, 'latin1');
    h.write('        ', 148, 8, 'latin1');                // the checksum counts its own field as spaces
    h.write('0', 156, 1, 'latin1');
    h.write('ustar\0' + '00', 257, 8, 'latin1');
    h.write(prefix, 345, 155, 'utf8');
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += h[i];
    h.write((Array(7).join('0') + sum.toString(8)).slice(-6) + '\0 ', 148, 8, 'latin1');
    return h;
}

function pack(entries) {
    const parts = [];
    entries.slice().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).forEach((e) => {
        parts.push(header(e.name, e.data.length), e.data);
        const pad = (512 - (e.data.length % 512)) % 512;
        if (pad) parts.push(Buffer.alloc(pad));
    });
    parts.push(Buffer.alloc(1024));
    const gz = zlib.gzipSync(Buffer.concat(parts), { level: 9 });
    gz.writeUInt32LE(0, 4);                                // no time
    gz[9] = 3;                                             // OS: Unix, whatever this machine is
    return gz;
}

function unpack(buf) {
    const tar = zlib.gunzipSync(buf), out = [];
    const str = (from, len) => { const s = tar.slice(from, from + len); const z = s.indexOf(0); return s.slice(0, z < 0 ? len : z).toString('utf8'); };
    for (let off = 0; off + 512 <= tar.length;) {
        if (tar[off] === 0) break;
        const size = parseInt(str(off + 124, 12).trim() || '0', 8), type = String.fromCharCode(tar[off + 156] || 48);
        const prefix = str(off + 345, 155), name = (prefix ? prefix + '/' : '') + str(off, 100);
        if (type === '0') out.push({ name, data: tar.slice(off + 512, off + 512 + size) });
        off += 512 + Math.ceil(size / 512) * 512;
    }
    return out;
}

module.exports = { pack, unpack, MTIME };
