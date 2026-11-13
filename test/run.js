'use strict';

// NES app: the emulator (app/nes.wasm through nes-core.js) on a small test program made here,
// the controller -> pad mapping (controls.js) and the games / saves on disk (library.js).
// Then the MGU Store's view of this repository: mgu-repo.json and the committed package in store/.
// No SDK, head unit or game needed; runs on Node 8 (the head unit's) as on a current one:
//   node test/run.js        (npm test; npm run test:node8 for Node 8)

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..');
const { Nes, BTN, isRom } = require(path.join(ROOT, 'app/nes-core'));
const { Controls, TAP, GAP } = require(path.join(ROOT, 'app/controls'));
const { Library, titleOf } = require(path.join(ROOT, 'app/library'));
const { unpack } = require(path.join(ROOT, 'tools/tar'));
const { spawnSync } = require('child_process');

let failed = 0;
const check = async (name, fn) => {
    try { await fn(); console.log('ok   ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + e.message.split('\n')[0]); }
};
const log = { info() {}, debug() {}, warn() {}, error(s, e) { console.log('     ' + s + ' ' + ((e && e.message) || '')); } };

/**
 * A cartridge of our own (mapper 0, 16 KB program, 8 KB of empty tiles): each frame it reads pad 1 and
 * makes the whole screen light blue ($21), or red ($16) while A is held.
 */
function testRom() {
    const prg = Buffer.alloc(16384, 0xea), code = [
        0x78, 0xd8, 0xa2, 0xff, 0x9a,                         // C000 SEI, CLD, LDX #$FF, TXS
        0xa9, 0x00, 0x8d, 0x00, 0x20, 0x8d, 0x01, 0x20,       // C005 LDA #0, STA $2000, STA $2001 (no NMI, no rendering)
        0x2c, 0x02, 0x20,                                     // C00D BIT $2002
        0x2c, 0x02, 0x20, 0x10, 0xfb,                         // C010 BIT $2002, BPL C010 (vertical blank)
        0x2c, 0x02, 0x20, 0x10, 0xfb,                         // C015 BIT $2002, BPL C015 (the next: the PPU is up)
        0xa9, 0x01, 0x8d, 0x16, 0x40, 0xa9, 0x00, 0x8d, 0x16, 0x40,   // C01A latch the pad
        0xad, 0x16, 0x40, 0x29, 0x01, 0xaa,                   // C024 LDA $4016, AND #1, TAX (A held: 1)
        0x2c, 0x02, 0x20, 0x10, 0xfb,                         // C02A BIT $2002, BPL C02A
        0xa9, 0x3f, 0x8d, 0x06, 0x20, 0xa9, 0x00, 0x8d, 0x06, 0x20,   // C02F PPU address $3F00 (the backdrop colour)
        0xbd, 0x4a, 0xc0, 0x8d, 0x07, 0x20,                   // C039 LDA colours,X, STA $2007
        0xa9, 0x00, 0x8d, 0x06, 0x20, 0x8d, 0x06, 0x20,       // C03F PPU address back to $0000
        0x4c, 0x1a, 0xc0,                                     // C047 JMP C01A
        0x21, 0x16,                                           // C04A colours
        0x40,                                                 // C04C RTI
    ];
    Buffer.from(code).copy(prg, 0);
    [0x4c, 0xc0, 0x00, 0xc0, 0x4c, 0xc0].forEach((b, i) => { prg[0x3ffa + i] = b; });       // NMI, reset, IRQ
    const head = Buffer.alloc(16);
    Buffer.from([0x4e, 0x45, 0x53, 0x1a, 1, 1]).copy(head, 0);
    return Buffer.concat([head, prg, Buffer.alloc(8192)]);
}
/** the picture's one colour as [r, g, b], or null when it has more than one */
function colour(f) {
    for (let i = 4; i < f.px.length; i += 4) if (f.px[i] !== f.px[0] || f.px[i + 1] !== f.px[1] || f.px[i + 2] !== f.px[2]) return null;
    return [f.px[0], f.px[1], f.px[2]];
}
const frames = (nes, n, pad) => { for (let i = 0; i < n; i++) { nes.setPad(0, pad || 0); nes.run(); } return nes.frame(); };

(async () => {
    console.log('node ' + process.version);
    const rom = testRom();
    const nes = new Nes({ wasm: path.join(ROOT, 'app/nes.wasm'), log });

    /* ---------- the emulator ---------- */
    await check('core: nes.wasm compiles and a cartridge loads', async () => {
        await nes.compile();
        assert(isRom(rom) && nes.load(rom), 'the test cartridge did not load');
        assert(Math.abs(nes.fps - 60.1) < 0.1, 'frame rate ' + nes.fps);
    });
    let blue, red;
    await check('core: the picture is 256 x 240 RGBA, one opaque colour from the test program', () => {
        const f = frames(nes, 20);
        assert(f && f.w === 256 && f.h === 240 && f.px.length === 256 * 240 * 4, 'picture ' + (f && f.w + 'x' + f.h));
        blue = colour(f);
        assert(blue, 'more than one colour on the screen');
        assert(f.px[3] === 255, 'alpha ' + f.px[3]);
        assert(blue[2] > blue[0] + 40, 'not blue: ' + blue);
    });
    await check('core: pad 1\'s A reaches the game (the screen turns red), and letting go turns it back', () => {
        red = colour(frames(nes, 6, BTN.A));
        assert(red && red[0] > red[2] + 40, 'not red with A held: ' + red);
        assert.deepStrictEqual(colour(frames(nes, 6, BTN.B | BTN.START | BTN.RIGHT)), blue, 'other buttons are not A');
    });
    await check('core: the edges are cut to 224 lines on request', () => {
        nes.setCrop(0, 8, 0, 8);
        const f = frames(nes, 2);
        assert(f.w === 256 && f.h === 224, 'picture ' + f.w + 'x' + f.h);
        nes.setCrop(0, 0, 0, 0);
    });
    await check('core: a save state brings the same machine back, also into a new instance', async () => {
        frames(nes, 4, BTN.A);
        const st = nes.saveState();
        assert(st && st.length > 500, 'no state');
        assert.deepStrictEqual(colour(frames(nes, 8)), blue);
        assert(nes.loadState(st), 'state did not load');
        assert.deepStrictEqual(colour(frames(nes, 1, BTN.A)), red, 'after the state: the screen it was saved with');
        const other = new Nes({ wasm: path.join(ROOT, 'app/nes.wasm'), log });
        other.mod = nes.mod;                                  // (the compiled module is shared)
        assert(other.load(rom) && other.loadState(st), 'state did not load into a new instance');
        assert.deepStrictEqual(colour(frames(other, 1, BTN.A)), red);
        assert(!nes.loadState(Buffer.alloc(64, 1)), 'garbage was taken for a state');
    });
    await check('core: what is no cartridge is refused; the next game still loads', () => {
        assert(!nes.load(Buffer.from('not a game')) && !nes.load(Buffer.alloc(30000, 7)));
        assert(nes.load(rom) && colour(frames(nes, 20)), 'no picture after loading again');
    });
    await check('core: the memory never grows (12 MiB from the start: Node 8 copies on growth)', () => {
        for (let i = 0; i < 20; i++) { assert(nes.load(rom)); frames(nes, 3); nes.saveState(); }
        assert.strictEqual(nes.mem.buffer.byteLength, 12 << 20);
    });

    /* ---------- controller and buttons -> pad ---------- */
    const ev = (knob, push, tilt) => ({ frontRotaryEncoderOperation: knob, frontRotaryEncoderPushButton: push, frontRotaryEncoderDeflection: tilt });
    let now = 0;
    const set = { press: 'a', turnR: 'b', turnL: 'start' };
    const mk = () => { const c = new Controls({ log, now: () => now, press: () => set.press, turnR: () => set.turnR, turnL: () => set.turnL }); c.enable(true); return c; };
    await check('controls: push holds the D-pad, press holds A (or B, by the setting)', () => {
        const c = mk();
        c.raw(ev(10, 0, 0), true);
        assert.strictEqual(c.mask(), 0);
        c.raw(ev(10, 1, 4), true);
        assert.strictEqual(c.mask(), BTN.RIGHT | BTN.A);
        c.raw(ev(10, 2, 'WEST_LANG_GEDRUECKT'), true);        // (the SDK's names work as the numbers do)
        assert.strictEqual(c.mask(), BTN.LEFT | BTN.A);
        set.press = 'b';
        assert.strictEqual(c.mask(), BTN.LEFT | BTN.B);
        set.press = 'a';
        c.raw(ev(10, 0, 0), true);
        assert.strictEqual(c.mask(), 0);
    });
    await check('controls: each knob click is one tap (' + TAP + ' frames held, ' + GAP + ' let go); the first message only says where the knob stands', () => {
        const c = mk(), seq = () => { const s = []; for (let i = 0; i < 2 * (TAP + GAP) + 2; i++) s.push(c.mask()); return s; };
        c.raw(ev(65535, 0, 0), true);
        assert.strictEqual(c.mask(), 0, 'the first message tapped');
        c.raw(ev(1, 0, 0), true);                             // two clicks to the right, over the counter's wrap
        const s = seq(), want = [];
        for (let k = 0; k < 2; k++) { for (let i = 0; i < TAP; i++) want.push(BTN.B); for (let i = 0; i < GAP; i++) want.push(0); }
        assert.deepStrictEqual(s.slice(0, want.length), want);
        assert.deepStrictEqual(s.slice(want.length), [0, 0]);
        c.raw(ev(0, 0, 0), true);                             // one to the left
        assert.strictEqual(c.mask(), BTN.START);
        set.turnL = 'none';
        c.raw(ev(65535, 0, 0), true);
        for (let i = 0; i < TAP + GAP; i++) c.mask();
        assert.strictEqual(c.mask(), 0, '"Nothing" tapped');
        set.turnL = 'start';
    });
    await check('controls: a touch button taps; the HMI pressing one for the knob\'s own press does not', () => {
        const c = mk();
        assert(c.bar('BTN_SELECT') && c.mask() === BTN.SELECT && c.lit('BTN_SELECT') > 0);
        now += 1000;
        assert.strictEqual(c.lit('BTN_SELECT'), 0);
        c.raw(ev(5, 0, 0), false); c.raw(ev(5, 1, 0), false); // no controller gate: the HMI gets this press too
        assert(!c.bar('BTN_START'), 'the HMI\'s press counted as a tap');
        now += 1000;
        c.raw(ev(5, 0, 0), false);
        assert(c.bar('BTN_START'));
    });
    await check('controls: nothing while the game is stopped; a lost release is let go after 1.5 s', () => {
        const c = mk();
        c.raw(ev(3, 0, 0), true); c.raw(ev(3, 1, 7), true);
        c.enable(false);
        assert.strictEqual(c.mask(), 0);
        assert(!c.bar('BTN_A'));
        c.enable(true);
        assert.strictEqual(c.mask(), BTN.DOWN | BTN.A);
        for (let i = 0; i < 6; i++) c.raw(ev(3, 1, 7), true);  // the car repeats its messages...
        now += 2000;                                           // ...and then none comes
        assert.strictEqual(c.mask(), 0);
        c.setExternal(BTN.LEFT | BTN.RIGHT | BTN.A);           // (another pad: opposite directions cancel)
        assert.strictEqual(c.mask(), BTN.A);
    });

    /* ---------- games and saves ---------- */
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nes-test-'));
    const deflate = (b) => zlib.deflateRawSync(b);
    await check('library: games from the build\'s pack and from the data folder, by title', () => {
        // a pack as kit/tools/pack_data.py writes it
        const files = { 'Zebra Quest (USA).nes': rom, 'alpha_run.nes': rom, 'README.txt': Buffer.from('x') };
        const index = {}, blobs = [];
        let off = 0;
        Object.keys(files).forEach((n) => { const z = deflate(files[n]); index[n] = [off, z.length]; off += z.length; blobs.push(z); });
        const ix = deflate(Buffer.from(JSON.stringify({ files: index, split: {} }))), len = Buffer.alloc(4);
        len.writeUInt32LE(ix.length, 0);
        fs.writeFileSync(path.join(tmp, 'roms.pack'), Buffer.concat([Buffer.from('MGUPACK1'), len, ix].concat(blobs)));
        fs.mkdirSync(path.join(tmp, 'roms'));
        fs.writeFileSync(path.join(tmp, 'roms', 'Middle Game [!].NES'), rom);
        fs.writeFileSync(path.join(tmp, 'roms', 'notes.txt'), 'x');
        const lib = new Library({ pack: path.join(tmp, 'roms.pack'), dirs: [path.join(tmp, 'roms'), path.join(tmp, 'none')], dataDir: tmp, log });
        assert.deepStrictEqual(lib.scan().map((g) => g.title), ['alpha run', 'Middle Game', 'Zebra Quest']);
        lib.games.forEach((g) => assert(lib.read(g).equals(rom), g.file + ' read back differs'));
        assert.strictEqual(titleOf('Some Game (Europe) (Rev 1) [b2].nes'), 'Some Game');
    });
    await check('library: state, battery memory and the game played last are kept per game', () => {
        const lib = new Library({ pack: path.join(tmp, 'roms.pack'), dirs: [path.join(tmp, 'roms')], dataDir: tmp, log });
        const a = lib.scan()[0], b = lib.games[1];
        assert(lib.state(a) === null && lib.sram(a) === null && lib.last() === null);
        assert(lib.setState(a, Buffer.from('state-a')) && lib.setSram(b, Buffer.from('sram-b')));
        lib.setLast(b);
        const again = new Library({ pack: path.join(tmp, 'roms.pack'), dirs: [path.join(tmp, 'roms')], dataDir: tmp, log });
        again.scan();
        assert.strictEqual(String(again.state(again.byId(a.id))), 'state-a');
        assert.strictEqual(String(again.sram(again.byId(b.id))), 'sram-b');
        assert(again.state(again.byId(b.id)) === null);
        assert.strictEqual(again.last().id, b.id);
        again.dropState(again.byId(a.id));
        assert(again.state(again.byId(a.id)) === null);
        assert(!fs.readdirSync(path.join(tmp, 'saves')).some((f) => /\.tmp$/.test(f)), 'a temporary file was left');
    });

    /* ---------- the MGU Store: mgu-repo.json and store/ (the Store's docs/PUBLISHING.md, "Repo tree") ---------- */
    const json = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    const SEMVER = /^\d+\.\d+\.\d+$/, relPath = (p) => typeof p === 'string' && !!p && !path.isAbsolute(p) && p.split('/').indexOf('..') < 0;
    const spec = json('app/app.json');
    let entry = null, output = null, members = [];
    await check('store: mgu-repo.json lists the app with a build script and a committed output', () => {
        const repo = json('mgu-repo.json');
        assert(repo.schema === 1 && Array.isArray(repo.components) && repo.components.length === 1, 'schema 1 with one component');
        entry = repo.components[0];
        assert.strictEqual(entry.id, spec.id);
        assert(/^[a-z0-9]+_[a-z0-9_]+$/.test(entry.id), 'the id has a prefix of its own: ' + entry.id);
        assert(entry.kind === 'app' && relPath(entry.path), 'kind app and a path in the repository');
        const b = entry.build;
        assert(b && relPath(b.node) && b.python === undefined && fs.existsSync(path.join(ROOT, b.node)), 'build.node names a script in the repository');
        assert(Array.isArray(b.args) && b.args.every((a) => typeof a === 'string') && !b.network && !b.sdk, 'args are strings; no network, no SDK folder');
        // (with "shared", an install downloads the app's folder, these and the script, not the whole repository)
        assert(Array.isArray(b.shared) && b.shared.length && b.shared.every((f) => relPath(f) && fs.existsSync(path.join(ROOT, f))), 'build.shared names files in the repository');
        assert(Array.isArray(entry.mguHmi) && entry.mguHmi.length && entry.mguHmi.every((h) => h === 'ID7' || h === 'ID8'), 'mguHmi');
        assert(Array.isArray(entry.needs) && entry.needs.every((n) => /^[a-z][a-z0-9-]*$/.test(n)), 'needs: capabilities');
        assert(Object.keys(entry.requires).every((k) => k !== entry.id && SEMVER.test(entry.requires[k])), 'requires: ids to x.y.z versions');
    });
    await check('store: store/app.json is this version of the app, with a title, a description and an icon', () => {
        const m = json(path.join(entry.path, 'app.json'));
        assert.strictEqual(m.id, entry.id);
        assert.strictEqual(m.version, spec.version, 'store/ is version ' + m.version + ', app/app.json ' + spec.version + ': run "npm run build:store"');
        assert(SEMVER.test(m.version) && m.title === spec.title && m.description === spec.description && m.description.length > 20);
        const icon = fs.readFileSync(path.join(ROOT, entry.path, 'icon.png'));
        assert(icon.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && icon.length <= 128 << 10, 'icon.png: a PNG of at most 128 KiB');
        assert(icon.readUInt32BE(16) === 140 && icon.readUInt32BE(20) === 140, 'icon.png is 140 x 140');
        assert(icon.equals(fs.readFileSync(path.join(ROOT, 'app/icon.png'))), 'it is the app\'s own icon');
        const fill = (t) => t.replace(/\{id\}/g, entry.id).replace(/\{version\}/g, m.version).replace(/\{dir\}/g, entry.path);
        output = fill(entry.build.output);
        assert(relPath(output) && fs.existsSync(path.join(ROOT, output)), 'the build\'s output ' + output + ' is in the repository');
        assert.deepStrictEqual(fs.readdirSync(path.join(ROOT, entry.path)).filter((f) => /\.tgz$/.test(f)), [path.basename(output)], 'one package in store/');
    });
    await check('store: the package is an OAP package of that id and version, without an SDK and without games', () => {
        members = unpack(fs.readFileSync(path.join(ROOT, output)));
        assert(members.length > 50 && members.every((m) => m.name.indexOf('package/') === 0 && m.name.indexOf('..') < 0), 'its files are under package/');
        const bad = members.filter((m) => /node_modules|oap-sdk\/|roms\.pack$|\.nes$/i.test(m.name)).map((m) => m.name);
        assert(!bad.length, 'must not be published: ' + bad.join(' '));
        const pkg = JSON.parse(members.find((m) => m.name === 'package/package.json').data.toString());
        assert(pkg.name === entry.id && pkg.version === spec.version && pkg.main === 'javascript/app.js', pkg.name + '@' + pkg.version);
        assert.deepStrictEqual(pkg.mguHmi, entry.mguHmi);
        assert.strictEqual(pkg.license, 'GPL-2.0-or-later');
        ['package/rhmiData/application.json', 'package/manifest.json', 'package/permissions.json', 'package/javascript/kit/mgu.js'].forEach((n) => assert(members.some((m) => m.name === n), n + ' is missing'));
        // the head unit generates the oap-sdk module for a package whose javascript asks for it and ships none
        assert(/require\(['"]oap-sdk['"]\)/.test(members.find((m) => m.name === 'package/javascript/kit/mgu.js').data.toString()));
    });
    await check('store: the package holds this app/ (else: npm run build:store)', () => {
        const inPkg = (n) => { const m = members.find((x) => x.name === 'package/javascript/' + n); assert(m, n + ' is not in the package'); return m.data; };
        [['app.js', 'main.js'], ['controls.js'], ['library.js'], ['nes-core.js'], ['nes.wasm'], ['LICENSE'], ['NOTICE']].forEach((q) => {
            assert(inPkg(q[0]).equals(fs.readFileSync(path.join(ROOT, 'app', q[1] || q[0]))), 'app/' + (q[1] || q[0]) + ' changed since the package was built');
        });
        const rt = JSON.parse(inPkg('kit/app-spec.json').toString());
        ['id', 'title', 'version', 'screens', 'settings', 'config'].forEach((k) => assert.deepStrictEqual(rt[k], spec[k], 'app/app.json "' + k + '" changed since the package was built'));
    });
    await check('store: the on-unit build passes with only the files an install downloads, and says what is wrong without the package', () => {
        const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'nes-store-'));
        const put = (rel) => {
            const from = path.join(ROOT, rel), to = path.join(copy, rel);
            if (fs.statSync(from).isDirectory()) { fs.mkdirSync(to); fs.readdirSync(from).forEach((f) => put(rel + '/' + f)); return; }
            rel.split('/').slice(0, -1).reduce((d, part) => { const n = path.join(d, part); if (!fs.existsSync(n)) fs.mkdirSync(n); return n; }, copy);
            fs.writeFileSync(to, fs.readFileSync(from));
        };
        [entry.path].concat(entry.build.shared, [entry.build.node]).forEach(put);
        const args = entry.build.args.map((a) => a.replace(/\{id\}/g, entry.id).replace(/\{version\}/g, spec.version).replace(/\{dir\}/g, entry.path));
        const run = () => spawnSync(process.execPath, [entry.build.node].concat(args), { cwd: copy, encoding: 'utf8' });
        let r = run();
        assert(r.status === 0 && fs.statSync(path.join(copy, output)).isFile(), 'the build failed: ' + r.stdout + r.stderr);
        fs.unlinkSync(path.join(copy, output));
        r = run();
        assert(r.status === 1 && /build:store/.test(r.stderr), 'no clear failure without the package: ' + r.status + ' ' + r.stderr);
    });

    console.log(failed ? failed + ' failed' : 'nes: all ok');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
