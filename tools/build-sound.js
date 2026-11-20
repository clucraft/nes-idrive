'use strict';
/**
 * Builds loader/nes-sound, the program of the NES game loader that plays a game's sound on the head unit
 * (loader/src/nes-sound/main.go; loader/sound.js says what it is for):
 *
 *   node tools/build-sound.js        (npm run build:sound)
 *
 * It needs Go (https://go.dev), 1.25 or later, on any computer, and no C compiler. The first build fetches the
 * one library the program has beside Go's own, github.com/ebitengine/purego, at the version and checksum
 * go.mod and go.sum name. The result is a Linux program for the head unit's processor (x86-64) that needs the
 * head unit's C library and, when it plays, its libasound: it names /lib/ld-linux-x86-64.so.2 as its loader,
 * the only place the head unit has one, and asks for no version of any C library function, so the head unit's
 * older one will do (checked here). The file is committed, as loader/nes-usbpipe is: the MGU Store installs the
 * loader as it is in the repository. Run this after a change to main.go and commit loader/nes-sound with it.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'loader', 'src', 'nes-sound');
const OUT = path.join(ROOT, 'loader', 'nes-sound');
const LOADER = '/lib/ld-linux-x86-64.so.2';

/** what a 64-bit ELF file asks of the computer it runs on: { loader, needs: [libraries], versions: [C library versions asked for] } */
function asks(file) {
    const b = fs.readFileSync(file);
    if (b.readUInt32BE(0) !== 0x7f454c46 || b[4] !== 2 || b[5] !== 1) throw new Error('not a 64-bit little-endian ELF file');
    const u64 = (at) => b.readUInt32LE(at) + b.readUInt32LE(at + 4) * 4294967296;
    const phoff = u64(32), phsize = b.readUInt16LE(54), phnum = b.readUInt16LE(56);
    const segs = [];
    for (let i = 0; i < phnum; i++) { const p = phoff + i * phsize; segs.push({ type: b.readUInt32LE(p), off: u64(p + 8), vaddr: u64(p + 16), size: u64(p + 32) }); }
    const at = (vaddr) => { const s = segs.find((x) => x.type === 1 && vaddr >= x.vaddr && vaddr < x.vaddr + x.size); if (!s) throw new Error('address outside the file'); return s.off + vaddr - s.vaddr; };
    const str = (p) => b.toString('latin1', p, b.indexOf(0, p));
    const interp = segs.find((s) => s.type === 3), dyn = segs.find((s) => s.type === 2);
    const out = { loader: interp ? str(interp.off) : null, needs: [], versions: [] };
    if (!dyn) return out;
    const tags = [];
    for (let p = dyn.off; p < dyn.off + dyn.size; p += 16) { const tag = u64(p); if (!tag) break; tags.push([tag, u64(p + 8)]); }
    const one = (t) => { const e = tags.find((x) => x[0] === t); return e ? e[1] : null; };
    const strtab = at(one(5));
    tags.filter((x) => x[0] === 1).forEach((x) => out.needs.push(str(strtab + x[1])));
    // DT_VERNEED (0x6ffffffe), DT_VERNEEDNUM (0x6fffffff): the versions of library functions it asks for
    const need = one(0x6ffffffe), count = one(0x6fffffff);
    if (need !== null) {
        let p = at(need);
        for (let i = 0; i < count; i++) {
            let a = p + b.readUInt32LE(p + 8);
            for (let k = 0; k < b.readUInt16LE(p + 2); k++) { out.versions.push(str(strtab + b.readUInt32LE(a + 8))); a += b.readUInt32LE(a + 12); }
            p += b.readUInt32LE(p + 12);
        }
    }
    return out;
}

if (require.main === module) {
    try {
        const env = Object.assign({}, process.env, { GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0', GOFLAGS: '-buildvcs=false' });
        execFileSync('go', ['vet', '.'], { cwd: SRC, env, stdio: 'inherit' });
        // (no paths of this computer and no build id in it: the same source and Go give the same file)
        execFileSync('go', ['build', '-trimpath', '-ldflags', '-s -w -buildid= -I ' + LOADER, '-o', OUT, '.'], { cwd: SRC, env, stdio: 'inherit' });
        const a = asks(OUT);
        if (a.loader !== LOADER) throw new Error('its loader is ' + a.loader + ', not ' + LOADER);
        if (a.versions.length) throw new Error('it asks for versions of library functions (' + a.versions.join(', ') + '): the head unit\'s C library may be older');
        const file = fs.readFileSync(OUT);
        console.log('build-sound: loader/nes-sound (' + Math.round(file.length / 1024) + ' KiB, sha256 ' + crypto.createHash('sha256').update(file).digest('hex').slice(0, 16) + '...; needs ' + a.needs.join(', ') + '). Commit it with its source.');
    } catch (e) {
        console.error('build-sound: ' + (e.code === 'ENOENT' ? 'Go is not installed (https://go.dev)' : e.message));
        process.exit(1);
    }
}

module.exports = { asks, LOADER };
