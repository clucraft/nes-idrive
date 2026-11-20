'use strict';
/**
 * qr.js - a QR code for a short text: the address a phone scans from the "Add games" screen.
 *
 * What a short address needs and no more: bytes as they are (byte mode), error correction level L,
 * versions 1 to 5 (21 to 37 modules a side, up to 106 bytes), each of which is a single block.
 *
 *   qr(text) -> { size, modules, version, mask }     modules[y * size + x] is 1 for a dark module
 *
 * It throws for a text of more than 106 bytes. A code needs four light modules around it on screen.
 */

/** data and error correction codewords of versions 1 to 5 at level L */
const VERSIONS = [null, { data: 19, ec: 7 }, { data: 34, ec: 10 }, { data: 55, ec: 15 }, { data: 80, ec: 20 }, { data: 108, ec: 26 }];

/* the field the error correction counts in: 256 elements, x^8 + x^4 + x^3 + x^2 + 1 */
const EXP = new Uint8Array(510), LOG = new Uint8Array(256);
(() => {
    let x = 1;
    for (let i = 0; i < 255; i++) { EXP[i] = EXP[i + 255] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
})();
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

/** the n error correction codewords of data (Reed-Solomon: the remainder by the generator polynomial) */
function correction(data, n) {
    let gen = [1];                                   // (x + 1)(x + 2)(x + 4)...: highest power first
    for (let i = 0; i < n; i++) {
        const next = new Array(gen.length + 1).fill(0);
        for (let j = 0; j < gen.length; j++) { next[j] ^= gen[j]; next[j + 1] ^= mul(gen[j], EXP[i]); }
        gen = next;
    }
    const rem = new Array(n).fill(0);
    data.forEach((b) => {
        const f = b ^ rem.shift();
        rem.push(0);
        for (let j = 0; j < n; j++) rem[j] ^= mul(gen[j + 1], f);
    });
    return rem;
}

/** the data codewords: "bytes follow", how many, the bytes, an end mark, filled up to the version's count */
function codewords(bytes, version) {
    const count = VERSIONS[version].data, bits = [];
    const put = (value, n) => { for (let i = n - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
    put(4, 4);
    put(bytes.length, 8);
    bytes.forEach((b) => put(b, 8));
    put(0, Math.min(4, count * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    const out = [];
    for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    for (let fill = 0xec; out.length < count; fill ^= 0xec ^ 0x11) out.push(fill);
    return out;
}

/** the eight masks: a data module at column x, row y is turned over where its mask says so */
const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
    (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0,
    (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
];

/** the code's modules for these codewords (data, then correction) under one mask */
function build(version, words, mask) {
    const n = 17 + 4 * version;
    const dark = new Uint8Array(n * n), fixed = new Uint8Array(n * n);
    const set = (x, y, d) => { if (x >= 0 && y >= 0 && x < n && y < n) { dark[y * n + x] = d ? 1 : 0; fixed[y * n + x] = 1; } };

    // the three corner squares, each with a light line around it
    const corner = (cx, cy) => {
        for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const d = Math.max(Math.abs(dx), Math.abs(dy)); set(cx + dx, cy + dy, d !== 2 && d !== 4); }
    };
    corner(3, 3); corner(n - 4, 3); corner(3, n - 4);
    // the small square near the fourth corner (not in version 1)
    if (version >= 2) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(n - 7 + dx, n - 7 + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    // the dotted lines between the corner squares
    for (let i = 8; i < n - 8; i++) { set(i, 6, i % 2 === 0); set(6, i, i % 2 === 0); }

    // level and mask, 15 bits with their own error correction, twice
    const info = (1 << 3) | mask;                    // (level L is 01)
    let rem = info;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const format = ((info << 10) | rem) ^ 0x5412;
    const bit = (i) => (format >>> i) & 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(n - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, n - 15 + i, bit(i));
    set(8, n - 8, 1);

    // the codewords' bits, in two-module columns from the right, up and down in turn
    const total = words.length * 8;
    let k = 0;
    for (let right = n - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;                  // (the dotted column is skipped)
        for (let i = 0; i < n; i++) {
            for (let j = 0; j < 2; j++) {
                const x = right - j, y = ((right + 1) & 2) === 0 ? n - 1 - i : i;
                if (fixed[y * n + x]) continue;
                let d = k < total ? (words[k >>> 3] >>> (7 - (k & 7))) & 1 : 0;
                k++;
                if (MASKS[mask](x, y)) d ^= 1;
                dark[y * n + x] = d;
            }
        }
    }
    return dark;
}

/** how hard a code is to read: long runs, blocks, shapes like a corner square, an uneven share of dark */
function penalty(m, n) {
    let p = 0, darks = 0;
    for (let dir = 0; dir < 2; dir++) {
        for (let a = 0; a < n; a++) {
            let run = 0, colour = -1, line = '';
            for (let b = 0; b < n; b++) {
                const d = dir ? m[b * n + a] : m[a * n + b];
                line += d;
                if (d === colour) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else { colour = d; run = 1; }
            }
            ['10111010000', '00001011101'].forEach((shape) => { for (let i = line.indexOf(shape); i >= 0; i = line.indexOf(shape, i + 1)) p += 40; });
        }
    }
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const d = m[y * n + x];
            darks += d;
            if (x < n - 1 && y < n - 1 && d === m[y * n + x + 1] && d === m[(y + 1) * n + x] && d === m[(y + 1) * n + x + 1]) p += 3;
        }
    }
    return p + Math.floor(Math.abs(darks * 20 - n * n * 10) / (n * n)) * 10;
}

/**
 * The QR code of text. opts.mask (0..7) takes that mask; without it the one that reads best is chosen.
 */
function qr(text, opts) {
    const bytes = Array.prototype.slice.call(Buffer.from(String(text), 'utf8'));
    let version = 1;
    while (version < VERSIONS.length && bytes.length > VERSIONS[version].data - 2) version++;
    if (version >= VERSIONS.length) throw new Error('too long for this QR code: ' + bytes.length + ' bytes (106 at most)');
    const data = codewords(bytes, version), words = data.concat(correction(data, VERSIONS[version].ec));
    const size = 17 + 4 * version;
    let best = null;
    for (let mask = 0; mask < 8; mask++) {
        if (opts && opts.mask != null && opts.mask !== mask) continue;
        const modules = build(version, words, mask), score = penalty(modules, size);
        if (!best || score < best.score) best = { size, modules, version, mask, score };
    }
    return best;
}

module.exports = { qr, correction, codewords };
