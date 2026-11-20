'use strict';

// NES app: the emulator (app/nes.wasm through nes-core.js) on a small test program made here,
// the controller -> pad mapping (controls.js), the games / saves on disk (library.js) and the two
// games that come with the app (app/games/), played in the emulator. "Add games from a phone": the QR
// code (qr.js) and the NES game loader (loader/) from the app's request to a game sent over HTTP, with a
// stand-in for the head unit's firewall program. A USB gamepad: what its packets mean (loader/pad.js), and
// its buttons from a stand-in for the program that reads it (test/fake-usbpipe.js) through the loader to the app.
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
const { Controls, TAP, GAP, SEEN } = require(path.join(ROOT, 'app/controls'));
const { Library, titleOf, openPack, usbFolders } = require(path.join(ROOT, 'app/library'));
const { unpack } = require(path.join(ROOT, 'tools/tar'));
const { spawnSync } = require('child_process');
const http = require('http');
const net = require('net');
const { qr } = require(path.join(ROOT, 'app/qr'));
const { Phone } = require(path.join(ROOT, 'app/phone'));
const { Pad, PAD, toNes } = require(path.join(ROOT, 'app/pad'));
const loader = { games: require(path.join(ROOT, 'loader/games')), nft: require(path.join(ROOT, 'loader/nft')), service: require(path.join(ROOT, 'loader/service')), pad: require(path.join(ROOT, 'loader/pad')) };

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
/** the picture after n more frames, as a copy (the core's own is only good until it runs again) */
const shot = (nes, n, pad) => { const f = frames(nes, n, pad); return { w: f.w, h: f.h, px: new Uint8Array(f.px) }; };
/** a copy of the tiles from column x, row y of the picture (8 x 8 pixels each), n of them in a row */
const tiles = (f, x, y, n) => { const out = []; for (let r = y * 8; r < y * 8 + 8; r++) out.push(Buffer.from(f.px.buffer, f.px.byteOffset + (r * f.w + x * 8) * 4, n * 32)); return Buffer.concat(out); };
/** the colour in the middle of the tile at column x, row y */
const middle = (f, x, y) => { const i = ((y * 8 + 4) * f.w + x * 8 + 4) * 4; return [f.px[i], f.px[i + 1], f.px[i + 2]]; };
/** the games that come with the app, and no others */
const BUNDLED = ['Pad_Test.nes', 'Snake.nes'];
/** a data pack as kit/tools/pack_data.py writes it */
function writePack(file, files) {
    const index = {}, blobs = [];
    let off = 0;
    Object.keys(files).forEach((n) => { const z = zlib.deflateRawSync(files[n]); index[n] = [off, z.length]; off += z.length; blobs.push(z); });
    const ix = zlib.deflateRawSync(Buffer.from(JSON.stringify({ files: index, split: {} }))), len = Buffer.alloc(4);
    len.writeUInt32LE(ix.length, 0);
    fs.writeFileSync(file, Buffer.concat([Buffer.from('MGUPACK1'), len, ix].concat(blobs)));
}

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
    await check('controls: a push or press that is over before the next frame still reaches the game, for ' + SEEN + ' frames', () => {
        const c = mk();
        c.raw(ev(10, 0, 0), true);
        c.raw(ev(10, 1, 0), true); c.raw(ev(10, 0, 0), true);  // pressed and let go between two frames
        for (let i = 0; i < SEEN; i++) assert.strictEqual(c.mask(), BTN.A, 'frame ' + i);
        assert.strictEqual(c.mask(), 0);
        c.raw(ev(10, 0, 1), true); c.raw(ev(10, 0, 0), true);  // and a push
        for (let i = 0; i < SEEN; i++) assert.strictEqual(c.mask(), BTN.UP, 'frame ' + i);
        assert.strictEqual(c.mask(), 0);
        c.raw(ev(10, 0, 4), true); c.raw(ev(10, 0, 7), true);  // one direction, then another held on: the one held wins
        assert.strictEqual(c.mask(), BTN.DOWN);
        c.enable(false);
        c.raw(ev(10, 1, 0), true); c.raw(ev(10, 0, 0), true);  // a press while the game is stopped is not kept for its start
        c.enable(true);
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
        c.setExternal(BTN.B);
        c.enable(false); c.enable(true);                       // its buttons are let go with the game: no button stuck at the next start
        assert.strictEqual(c.mask(), 0);
    });

    /* ---------- a USB gamepad: what its packets mean (loader/pad.js), and its buttons as the NES pad's (app/pad.js) ---------- */
    /** an Xbox pad's input report: its two button bytes and its left stick */
    const report = (b4, b5, x, y) => { const d = Buffer.alloc(18); d[0] = 0x20; d[3] = 0x0e; d[4] = b4; d[5] = b5; d.writeInt16LE(x || 0, 10); d.writeInt16LE(y || 0, 12); return d; };
    /** the same with its triggers and its right stick too */
    const whole = (b4, b5, lt, rt, x, y, rx, ry) => { const d = report(b4, b5, x, y); d.writeUInt16LE(lt, 6); d.writeUInt16LE(rt, 8); d.writeInt16LE(rx, 14); d.writeInt16LE(ry, 16); return d; };
    const XBOX_ONE_S = { vid: 0x045e, pid: 0x02ea };
    await check('gamepad: an Xbox One S pad is switched on by the kernel driver\'s four packets, counted; another make\'s pad by three', () => {
        const hexes = (list) => list.map((b) => b.toString('hex'));
        const g = new loader.pad.Gip(XBOX_ONE_S);
        assert.deepStrictEqual(hexes(g.start()), ['0520000100', '0520010f06', '0a200203000114', '062003020100']);
        assert.deepStrictEqual(hexes(g.start()), ['0520040100', '0520050f06', '0a200603000114', '062007020100'], 'asked again: the count goes on');
        assert.deepStrictEqual(hexes(new loader.pad.Gip({ vid: 0x0e6f, pid: 0x02a4 }).start()), ['0520000100', '0a200103000114', '062002020100']);
    });
    await check('gamepad: an Xbox pad\'s report is its buttons; the left stick is the D-pad too; anything else is no report', () => {
        const g = new loader.pad.Gip(XBOX_ONE_S), P = loader.pad.PAD, far = loader.pad.STICK + 1;
        const b = (d) => g.packet(d).buttons;
        assert.strictEqual(b(report(0, 0)), 0);
        [[0x04, 0, P.START], [0x08, 0, P.SELECT], [0x10, 0, P.A], [0x20, 0, P.B], [0x40, 0, P.X], [0x80, 0, P.Y], [0, 0x01, P.UP], [0, 0x02, P.DOWN],
            [0, 0x04, P.LEFT], [0, 0x08, P.RIGHT], [0, 0x10, P.L], [0, 0x20, P.R], [0x01, 0xc0, 0]].forEach((t) => assert.strictEqual(b(report(t[0], t[1])), t[2], 'bytes ' + t[0] + ' ' + t[1]));
        assert.strictEqual(b(report(0x50, 0x09)), P.A | P.X | P.UP | P.RIGHT);
        assert.strictEqual(b(report(0, 0, far, 0)), P.RIGHT);
        assert.strictEqual(b(report(0, 0, -far, far)), P.LEFT | P.UP, 'up is the greater number');
        assert.strictEqual(b(report(0, 0, 0, -far)), P.DOWN);
        assert.strictEqual(b(report(0, 0, far - 2, 2 - far)), 0, 'a stick at rest, or not far out');
        assert.strictEqual(b(report(0x10, 0).slice(0, 8)), P.A, 'a report without the sticks');
        [Buffer.alloc(0), Buffer.from([0x20, 0, 1]), Buffer.from([0x20, 0, 1, 2, 0x10]), Buffer.from([0x03, 0x20, 1, 4, 0x80, 0, 0, 0]), null].forEach((d) => assert.deepStrictEqual(g.packet(d), {}));
        // what an Xbox One S pad sent, read through nes-usbpipe, once it was switched on: its report with nothing held and
        // the sticks where they rest (a little off the middle), and every 20 seconds a packet that is no report
        assert.strictEqual(b(Buffer.from('20000c0e0000000000004906a7027c020cf8', 'hex')), 0);
        assert.deepStrictEqual(g.packet(Buffer.from('0320430480010000', 'hex')), {});
    });
    await check('gamepad: the packets a real Xbox One S pad sent for its buttons and its left stick are read as those', () => {
        // (captured through loader/nes-usbpipe with tools/pad-try.js --raw, a button or a direction held at a time)
        const g = new loader.pad.Gip(XBOX_ONE_S), P = loader.pad.PAD;
        const sent = {
            '2000230e8000000000004906a7027c020cf8': P.Y, '2000410e0400000000004906a7027c020cf8': P.START, '2000470e0800000000004906a7027c020cf8': P.SELECT,
            '20002f0e0002000000004906a7027c020cf8': P.DOWN, '20004f0e00100000000049062c027c020cf8': P.L, '20005e0e10080000000049062c027c020cf8': P.A | P.RIGHT,
            '2000ee0e0000000000004800004f6e051cfa': P.UP, '2000550e0000000000005f05dda86e051cfa': P.DOWN,           // the stick: up, down,
            '20009f0e0000000000009c8f79fd6e051cfa': P.LEFT, '2000d50e000000000000f84954036e051cfa': P.RIGHT,        // left, right
        };
        Object.keys(sent).forEach((hex) => assert.strictEqual(g.packet(Buffer.from(hex, 'hex')).buttons, sent[hex], hex));
        // its Xbox button, pressed and let go: each wants its own answer, and got it
        assert.strictEqual(g.packet(Buffer.from('07300102015b', 'hex')).send[0].toString('hex'), '01200109000720020000000000');
        assert.strictEqual(g.packet(Buffer.from('07300202005b', 'hex')).send[0].toString('hex'), '01200209000720020000000000');
    });
    await check('gamepad: the whole pad, for a program that wants it: both sticks, both triggers, the sticks pressed in, and the D-pad apart from the stick', () => {
        const g = new loader.pad.Gip(XBOX_ONE_S), P = loader.pad.PAD, F = loader.pad.PAD_FULL, far = loader.pad.STICK + 1;
        Object.keys(P).forEach((k) => assert.strictEqual(F[k], P[k], k + ' is the same bit in both'));
        assert(F.LS && F.RS && F.LS !== F.RS && !Object.keys(P).some((k) => P[k] & (F.LS | F.RS)), 'the sticks pressed in are bits of their own');
        let r = g.packet(whole(0x10, 0xc1, 300, 1023, -far, far, 32767, -32768));
        assert.deepStrictEqual(r.state, { buttons: P.A | P.UP | F.LS | F.RS, lt: 300, rt: 1023, lx: -far, ly: far, rx: 32767, ry: -32768 });
        assert.strictEqual(r.buttons, P.A | P.UP | P.LEFT, 'the NES app\'s buttons: the left stick is the D-pad too, a stick pressed in is nothing');
        r = g.packet(whole(0, 0, 0, 0, far, -far, 0, 0));
        assert.strictEqual(r.state.buttons, 0, 'a stick held out is no button of the whole pad');
        assert.strictEqual(r.buttons, P.RIGHT | P.DOWN);
        r = g.packet(whole(0, 0, 0xffff, 2000, 0, 0, 0, 0));
        assert(r.state.lt === loader.pad.TRIGGER_MAX && r.state.rt === loader.pad.TRIGGER_MAX && loader.pad.TRIGGER_MAX === 1023, 'a trigger is never more than all the way');
        // a report cut short tells what it has
        assert.deepStrictEqual(g.packet(whole(0x20, 0, 5, 6, 7, 8, 9, 10).slice(0, 8)).state, { buttons: P.B, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 });
        assert.deepStrictEqual(g.packet(whole(0x20, 0, 5, 6, 7, 8, 9, 10).slice(0, 14)).state, { buttons: P.B, lt: 5, rt: 6, lx: 7, ly: 8, rx: 0, ry: 0 });
        // what a real Xbox One S pad sent (tools/pad-try.js --raw): its right trigger pulled all the way; its right
        // stick full right, and far out another way; its left stick at each of its four ends; A with the D-pad's
        // right. Its left trigger and its sticks pressed in were not among what it sent.
        const sent = {
            '20007d0e00000000ff03610c46020f05d9f8': { buttons: 0, lt: 0, rt: 1023, lx: 3169, ly: 582, rx: 1295, ry: -1831 },
            '2000400e000000000000610c4602ff7fca03': { buttons: 0, lt: 0, rt: 0, lx: 3169, ly: 582, rx: 32767, ry: 970 },
            '2000620e000000000000610c4602c16a5fa1': { buttons: 0, lt: 0, rt: 0, lx: 3169, ly: 582, rx: 27329, ry: -24225 },
            '2000fa0e000000000000ff7fdbf86e051cfa': { buttons: 0, lt: 0, rt: 0, lx: 32767, ly: -1829, rx: 1390, ry: -1508 },
            '2000a00e00000000000000802cfd6e051cfa': { buttons: 0, lt: 0, rt: 0, lx: -32768, ly: -724, rx: 1390, ry: -1508 },
            '2000f10e00000000000014fdff7f6e051cfa': { buttons: 0, lt: 0, rt: 0, lx: -748, ly: 32767, rx: 1390, ry: -1508 },
            '2000570e000000000000820000806e051cfa': { buttons: 0, lt: 0, rt: 0, lx: 130, ly: -32768, rx: 1390, ry: -1508 },
            '20005e0e10080000000049062c027c020cf8': { buttons: P.A | P.RIGHT, lt: 0, rt: 0, lx: 1609, ly: 556, rx: 636, ry: -2036 },
        };
        Object.keys(sent).forEach((hex) => assert.deepStrictEqual(g.packet(Buffer.from(hex, 'hex')).state, sent[hex], hex));
    });
    await check('gamepad: the Xbox button\'s report is acknowledged; a pad that says hello later is switched on again, its buttons let go', () => {
        let t = 0;
        const g = new loader.pad.Gip(XBOX_ONE_S, () => t);
        g.start();
        assert.deepStrictEqual(g.packet(Buffer.from('07302a02015b', 'hex')).send.map((b) => b.toString('hex')), ['01202a09000720020000000000']);
        assert.deepStrictEqual(g.packet(Buffer.from('07202a02005b', 'hex')), {}, 'one that asks for no acknowledgement');
        const hello = Buffer.from('02200a1c7eed8be0', 'hex');
        assert.deepStrictEqual(g.packet(hello), {}, 'hello at the start: it is being switched on');
        t += 5000;
        const r = g.packet(hello);
        assert(r.buttons === 0 && r.send.length === 4 && r.send[0].toString('hex') === '0520040100', JSON.stringify(r));
        assert.deepStrictEqual(r.state, { buttons: 0, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 }, 'and its sticks and triggers');
        assert.deepStrictEqual(g.packet(hello), {}, 'and not again at once');
    });
    await check('gamepad: found on the USB bus as the head unit lists an Xbox One S pad; one a kernel driver has, or another device, is not', () => {
        // (as read on a head unit with the pad plugged in: probe-controller.txt)
        const iface = (cls, sub, proto, n) => ({ bInterfaceClass: cls, bInterfaceSubClass: sub, bInterfaceProtocol: proto, bInterfaceNumber: n });
        const tree = {
            usb1: { busnum: '1', devnum: '1', idVendor: '1d6b', idProduct: '0002', product: 'xHCI Host Controller' },
            '1-0:1.0': Object.assign(iface('09', '00', '00', '00'), { driver: '' }),
            '1-3': { busnum: '1', devnum: '2', idVendor: '0424', idProduct: '4502' },
            '1-3:1.0': Object.assign(iface('09', '00', '01', '00'), { driver: '' }),
            '1-3.1': { busnum: '1', devnum: '4', idVendor: '045e', idProduct: '02ea', product: 'Controller', manufacturer: 'Microsoft' },
            '1-3.1:1.0': Object.assign(iface('ff', '47', 'd0', '00'), { 'ep_02/bEndpointAddress': '02', 'ep_02/bmAttributes': '03', 'ep_02/wMaxPacketSize': '0040', 'ep_82/bEndpointAddress': '82', 'ep_82/bmAttributes': '03', 'ep_82/wMaxPacketSize': '0040' }),
            '1-3.1:1.1': iface('ff', '47', 'd0', '01'),
            '1-3.1:1.2': iface('ff', '47', 'd0', '02'),
            '1-3.3': { busnum: '1', devnum: '3', idVendor: '0424', idProduct: '2530', product: 'Bridge device' },
            '1-3.3:1.0': iface('ff', '00', '00', '00'),
        };
        const SYS = '/sys/bus/usb/devices';
        const entry = (file) => { const rel = file.slice(SYS.length + 1), i = rel.indexOf('/'); return [tree[i < 0 ? rel : rel.slice(0, i)], i < 0 ? null : rel.slice(i + 1)]; };
        const io = {
            list: (dir) => { if (dir === SYS) return Object.keys(tree); const e = entry(dir)[0]; return e ? Object.keys(e).map((k) => k.split('/')[0]).filter((k, i, all) => all.indexOf(k) === i) : []; },
            read: (file) => { const e = entry(file); return e[0] && e[0][e[1]] !== undefined ? e[0][e[1]] : null; },
            has: (file) => { const e = entry(file); return !!e[0] && e[0][e[1]] !== undefined; },
        };
        assert.deepStrictEqual(loader.pad.find({ io }), [{ kind: 'gip', node: '/dev/bus/usb/001/004', iface: 0, epIn: 0x82, epOut: 0x02, packet: 64, vid: 0x045e, pid: 0x02ea, name: 'Controller' }]);
        tree['1-3.1:1.0'].driver = '';                         // (a PC: its kernel's own driver has the pad)
        assert.deepStrictEqual(loader.pad.find({ io }), []);
        delete tree['1-3.1:1.0'].driver;
        delete tree['1-3.1:1.0']['ep_02/bEndpointAddress'];
        assert.deepStrictEqual(loader.pad.find({ io }), [], 'a pad that takes no packets cannot be switched on');
        assert.deepStrictEqual(loader.pad.find({ sys: path.join(os.tmpdir(), 'nes-test-no-such-folder') }), [], 'no USB bus to look at (a PC that is not Linux)');
    });
    await check('gamepad: the app knows the loader\'s buttons, and makes the NES pad of an Xbox pad\'s', () => {
        assert.deepStrictEqual(PAD, loader.pad.PAD);
        assert.strictEqual(toNes(PAD.UP | PAD.A), BTN.UP | BTN.A);
        assert.strictEqual(toNes(PAD.B), BTN.A);
        assert.strictEqual(toNes(PAD.X), BTN.B);
        assert.strictEqual(toNes(PAD.Y | PAD.LEFT | PAD.DOWN), BTN.B | BTN.LEFT | BTN.DOWN);
        assert.strictEqual(toNes(PAD.START | PAD.SELECT | PAD.RIGHT), BTN.START | BTN.SELECT | BTN.RIGHT);
        assert.strictEqual(toNes(PAD.L | PAD.R), 0);
    });

    /* ---------- games and saves ---------- */
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nes-test-'));
    const other = Buffer.concat([rom, Buffer.from('another')]);
    await check('library: games from the app\'s packs and from the data folder, by title; a later place wins', () => {
        writePack(path.join(tmp, 'games.pack'), { 'Snake.nes': rom, 'alpha_run.nes': rom });
        writePack(path.join(tmp, 'roms.pack'), { 'Zebra Quest (USA).nes': rom, 'alpha_run.nes': other, 'README.txt': Buffer.from('x') });
        fs.mkdirSync(path.join(tmp, 'roms'));
        fs.writeFileSync(path.join(tmp, 'roms', 'Middle Game [!].NES'), rom);
        fs.writeFileSync(path.join(tmp, 'roms', 'SNAKE.NES'), other);
        fs.writeFileSync(path.join(tmp, 'roms', 'notes.txt'), 'x');
        const lib = new Library({ packs: [path.join(tmp, 'games.pack'), path.join(tmp, 'roms.pack'), path.join(tmp, 'no.pack')], dirs: [path.join(tmp, 'roms'), path.join(tmp, 'none')], dataDir: tmp, log });
        assert.deepStrictEqual(lib.scan().map((g) => g.title), ['alpha run', 'Middle Game', 'SNAKE', 'Zebra Quest']);
        assert.deepStrictEqual(lib.games.map((g) => lib.read(g).equals(other)), [true, false, true, false], 'the same name in a later pack or a folder was not the one read');
        assert(lib.read(lib.games[1]).equals(rom) && lib.read(lib.games[3]).equals(rom));
        assert.strictEqual(titleOf('Some Game (Europe) (Rev 1) [b2].nes'), 'Some Game');
    });
    await check('library: games in a folder "nes" on a USB stick are there while the stick is', () => {
        const media = path.join(tmp, 'media'), mk = (p) => { p.split('/').reduce((d, part) => { const n = path.join(d, part); if (!fs.existsSync(n)) fs.mkdirSync(n); return n; }, media); };
        fs.mkdirSync(media);
        mk('STICK/nes'); mk('MUSIC/albums'); mk('OTHER/NES'); mk('OTHER/nes2');
        fs.writeFileSync(path.join(media, 'STICK', 'nes', 'Stick Game.nes'), rom);
        fs.writeFileSync(path.join(media, 'OTHER', 'NES', 'Other Game.nes'), rom);
        fs.writeFileSync(path.join(media, 'MUSIC', 'nes'), 'a file, not a folder');
        const names = ['nes', 'NES', 'Nes'], roots = [media, path.join(tmp, 'no-such-root')];
        const found = usbFolders(roots, names);
        assert.deepStrictEqual(found.dirs.map((d) => path.relative(media, d).replace(/\\/g, '/')).sort(), ['OTHER/NES', 'STICK/nes']);
        assert.deepStrictEqual(found.errors, [], 'a stick without the folder, or no stick at all, is no error');
        const lib = new Library({ packs: [], dirs: [], more: () => usbFolders(roots, names).dirs, dataDir: tmp, log });
        assert.deepStrictEqual(lib.scan().map((g) => g.title), ['Other Game', 'Stick Game']);
        assert(lib.read(lib.games[1]).equals(rom));
        fs.unlinkSync(path.join(media, 'STICK', 'nes', 'Stick Game.nes'));
        fs.rmdirSync(path.join(media, 'STICK', 'nes'));
        assert.deepStrictEqual(lib.scan().map((g) => g.title), ['Other Game'], 'the stick is out: its games are still listed');
    });
    await check('library: state, battery memory and the game played last are kept per game', () => {
        const lib = new Library({ packs: [path.join(tmp, 'roms.pack')], dirs: [path.join(tmp, 'roms')], dataDir: tmp, log });
        const a = lib.scan()[0], b = lib.games[1];
        assert(lib.state(a) === null && lib.sram(a) === null && lib.last() === null);
        assert(lib.setState(a, Buffer.from('state-a')) && lib.setSram(b, Buffer.from('sram-b')));
        lib.setLast(b);
        const again = new Library({ packs: [path.join(tmp, 'roms.pack')], dirs: [path.join(tmp, 'roms')], dataDir: tmp, log });
        again.scan();
        assert.strictEqual(String(again.state(again.byId(a.id))), 'state-a');
        assert.strictEqual(String(again.sram(again.byId(b.id))), 'sram-b');
        assert(again.state(again.byId(b.id)) === null);
        assert.strictEqual(again.last().id, b.id);
        again.dropState(again.byId(a.id));
        assert(again.state(again.byId(a.id)) === null);
        assert(!fs.readdirSync(path.join(tmp, 'saves')).some((f) => /\.tmp$/.test(f)), 'a temporary file was left');
    });

    /* ---------- the games that come with the app (app/games/, built from games/ by games/build.sh) ---------- */
    const bundled = (n) => fs.readFileSync(path.join(ROOT, 'app/games', n));
    await check('games: app/games/ holds the two games written for the app, and nothing else to play', () => {
        assert.deepStrictEqual(fs.readdirSync(path.join(ROOT, 'app/games')).filter((f) => !/^(README\.txt|\.packignore)$/.test(f)).sort(), BUNDLED);
        BUNDLED.forEach((n) => assert(isRom(bundled(n)) && bundled(n).length === 16 + 16384 + 8192, n + ' is not a 16 KB cartridge'));
        ['games/src/pad_test.s', 'games/src/snake.s', 'games/src/common.inc', 'games/src/nrom.cfg', 'games/mkchr.js', 'games/build.sh'].forEach((f) => assert(fs.existsSync(path.join(ROOT, f)), 'their source: ' + f));
    });
    await check('games: Pad Test lights each button while it is held, counts its presses, and its clock runs', () => {
        assert(nes.load(bundled('Pad_Test.nes')), 'did not load');
        nes.setCrop(0, 0, 0, 0);
        const rows = { UP: 8, DOWN: 10, LEFT: 12, RIGHT: 14, SELECT: 16, START: 18, B: 20, A: 22 };
        const lit = (f, b) => { const c = middle(f, 16, rows[b]); return c[1] > c[0] + 60 && c[1] > c[2] + 60; };       // green between its brackets
        const count = (f, b) => tiles(f, 20, rows[b], 3);
        const idle = shot(nes, 30);
        Object.keys(rows).forEach((b) => assert(!lit(idle, b), b + ' is lit with nothing held'));
        Object.keys(rows).forEach((b) => {
            const held = shot(nes, 3, BTN[b]);
            Object.keys(rows).forEach((o) => assert.strictEqual(lit(held, o), o === b, o + (o === b ? ' is not lit while held' : ' is lit while ' + b + ' is held')));
            const after = shot(nes, 3);
            assert(!lit(after, b), b + ' stays lit');
            assert(!count(after, b).equals(count(idle, b)), b + ': a press did not count');
            Object.keys(rows).forEach((o) => assert(o === b || rows[o] < rows[b] || count(after, o).equals(count(idle, o)), o + ' counted a press of ' + b));
        });
        const once = shot(nes, 1);
        assert(count(once, 'A').equals(count(once, 'B')) && !count(once, 'A').equals(count(idle, 'A')), 'one press each: the counts differ');
        shot(nes, 3, BTN.A);
        assert(count(shot(nes, 3, BTN.A), 'A').equals(count(shot(nes, 3), 'A')) && !count(shot(nes, 1), 'A').equals(count(once, 'A')), 'held on: one press, not one a frame');
        const clock = (f) => tiles(f, 13, 24, 7), t0 = shot(nes, 1);
        assert(!clock(shot(nes, 70)).equals(clock(t0)), 'the clock stands');
    });
    await check('games: Snake starts on a push, turns, eats an apple, pauses, ends at the wall and starts again', () => {
        assert(nes.load(bundled('Snake.nes')), 'did not load');
        const green = (c) => c[1] > c[0] + 60 && c[1] > c[2] + 60, score = (f) => tiles(f, 16, 2, 3), best = (f) => tiles(f, 26, 2, 3);
        const field = (f) => { const rows = []; for (let y = 5; y <= 26; y++) rows.push(tiles(f, 2, y, 28)); return Buffer.concat(rows); };
        const ready = shot(nes, 30);
        assert(green(middle(ready, 16, 15)) && green(middle(ready, 14, 15)) && !green(middle(ready, 17, 15)), 'the snake is not where a new game has it');
        assert(field(shot(nes, 40)).equals(field(ready)), 'it moves before a button');
        shot(nes, 2, BTN.RIGHT);                               // starts it; a step every 12 frames
        let f = shot(nes, 108, BTN.DOWN);                      // nine steps down
        assert(green(middle(f, 16, 24)) && green(middle(f, 16, 22)) && !green(middle(f, 16, 21)) && !green(middle(f, 16, 15)), 'it did not turn down, three long');
        assert(score(f).equals(score(ready)), 'a score without an apple');
        // the apple is where chance put it at the start: find it (red) and steer there
        let apple = null;
        for (let y = 5; y <= 26 && !apple; y++) for (let x = 2; x <= 29; x++) { const c = middle(f, x, y); if (c[0] > c[1] + 60 && c[0] > c[2] + 60) { apple = [x, y]; break; } }
        assert(apple, 'no apple on the field');
        const go = (b, n) => { for (let i = 0; i < n; i++) f = shot(nes, 12, BTN[b]); };
        const dx = apple[0] - 16, dy = apple[1] - 24;
        if (dx) go(dx < 0 ? 'LEFT' : 'RIGHT', Math.abs(dx));   // along its row to the apple's column,
        else if (dy < 0) go('LEFT', 1);                        // (or round its own body, with the apple straight above)
        if (dy) go(dy < 0 ? 'UP' : 'DOWN', Math.abs(dy));      // then up or down to it
        if (!dx && dy < 0) go('RIGHT', 1);
        assert(!score(f).equals(score(ready)), 'the apple at ' + apple + ' did not count');
        const paused = shot(nes, 3, BTN.START);
        assert(field(shot(nes, 40)).equals(field(paused)), 'it moves while paused');
        shot(nes, 3, BTN.START);
        assert(!field(shot(nes, 40, BTN.UP)).equals(field(paused)), 'it stands after the pause');
        f = shot(nes, 400, BTN.UP);                            // into a wall
        assert(field(shot(nes, 60)).equals(field(f)), 'it moves after the end');
        assert(!best(f).equals(best(ready)) && best(f).equals(score(f)), 'the best score is not this game\'s');
        shot(nes, 3, BTN.A);
        f = shot(nes, 20);
        assert(green(middle(f, 16, 15)) && score(f).equals(score(ready)) && !best(f).equals(best(ready)), 'no new game with the best score kept');
    });

    /* ---------- games from a phone: the code on the screen, the loader, the page ---------- */
    await check('phone: a QR code is, module for module, what a reference encoder makes of the same text', () => {
        // (from python-qrcode: byte mode, level L, the mask named; rows from the top, 8 modules a byte)
        const known = [
            ['A', 1, 0, 'fe5bfc13906eb6bb74a5dba2aec10507faafe01b00eff6258411979a22b1844368aa804aabfaddf05fb8bad76dd311aeb22305046feeab80'],
            ['http://172.16.222.97:8493/0123456789abcdef0123', 3, 6, 'fe9e4bfc1334d06e8becbb741ae5dba521aec1167107faaaafe016c100da726a0dea5ce5bacde82828f6b3143d9360f063b56d8d7f61bb1a6125ca6db505c1ceafbfe55fc38bf945cf6036ff006dc463f8f5eb10410910ba933f85d6e88b6e895c270517665fed7aec00'],
            ['m'.repeat(106), 5, 1, 'fea22223fc155555506e955554bb74eeeee5dbaa22222ec155555507faaaaaafe015555500e6e8888f9e46eeeedb7da555542a5bd5555bafb08888b4509eeeedb6cdd55542a3015555ba03e8888b4689eeeedb418d55542a8355555ba5f08888b4746eeeedb69a555542ba215555ba7ac8888b4222eeeedb7e8d55542a52d5555bacf48888fc006eeee477f8d5552ab05d555719ba48889fd5d2eeeea76ead55512b0515555e8fe88888a480'],
        ];
        known.forEach((k) => {
            const q = qr(k[0], { mask: k[2] });
            assert(q.version === k[1] && q.size === 17 + 4 * k[1] && q.modules.length === q.size * q.size, 'version ' + q.version + ' for ' + k[0].slice(0, 20));
            const bytes = Buffer.alloc(Math.ceil(q.modules.length / 8));
            q.modules.forEach((d, i) => { if (d) bytes[i >> 3] |= 0x80 >> (i & 7); });
            assert.strictEqual(bytes.toString('hex'), k[3], 'the code of ' + k[0].slice(0, 30));
        });
        const best = qr('http://172.16.222.97:8493/0123456789abcdef0123/');
        assert(best.version === 3 && best.mask >= 0 && best.mask < 8, 'the page\'s address is a version 3 code');
        assert.throws(() => qr('n'.repeat(107)), /too long/);
    });
    const game = bundled('Snake.nes');
    const spec0 = JSON.parse(fs.readFileSync(path.join(ROOT, 'app/app.json'), 'utf8'));
    await check('loader: a name is made safe; what is no NES game is refused', () => {
        const names = { 'Super Game (USA).nes': 'Super Game (USA).nes', '../../etc/passwd': null, '../../evil.nes': 'evil.nes', 'C:\\roms\\Zelda.NES': 'Zelda.nes', '.hidden.nes': 'hidden.nes',
            '   .nes': null, 'game.zip': null, 'a\u0000b\n.nes': 'a_b_.nes', '': null, 'G\u00e4nse & Co [!].nes': 'G_nse & Co [!].nes' };
        Object.keys(names).forEach((n) => assert.strictEqual(loader.games.safeName(n), names[n], JSON.stringify(n)));
        assert(loader.games.safeName('x'.repeat(300) + '.nes').length <= 80);
        assert.strictEqual(loader.games.refuse(game), null);
        assert(/too small/.test(loader.games.refuse(game.slice(0, 5000))) && /not an NES game/.test(loader.games.refuse(Buffer.alloc(30000, 7))));
        assert(/bigger/.test(loader.games.refuse(Buffer.concat([game.slice(0, 16), Buffer.alloc(loader.games.MAX_GAME)]))));
    });
    await check('loader: a game goes into the games folder whole, under its safe name, and out again', () => {
        const dir = path.join(tmp, 'loader-games');
        const saved = loader.games.save(dir, '../My Game.NES', game);
        assert.deepStrictEqual(saved, { name: 'My Game.nes', size: game.length, replaced: false });
        assert(fs.readFileSync(path.join(dir, 'My Game.nes')).equals(game));
        assert.strictEqual(loader.games.save(dir, 'my game.nes', game).replaced, true, 'the same name in other letters is the same game');
        assert.deepStrictEqual(fs.readdirSync(dir), ['my game.nes'], 'one file, and none half written');
        assert.throws(() => loader.games.save(dir, 'notes.txt', game), (e) => e.refused === true);
        assert.throws(() => loader.games.save(dir, 'broken.nes', Buffer.alloc(20000)), (e) => e.refused === true && /not an NES game/.test(e.message));
        if (process.platform !== 'win32') {
            // a link someone left under the game's name is replaced, never written through
            const outside = path.join(tmp, 'outside.txt');
            fs.writeFileSync(outside, 'untouched');
            fs.symlinkSync(outside, path.join(dir, 'Trap.nes'));
            loader.games.save(dir, 'Trap.nes', game);
            assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'untouched');
            assert(fs.lstatSync(path.join(dir, 'Trap.nes')).isFile());
        }
        assert.deepStrictEqual(loader.games.list(dir).map((g) => g.name).filter((n) => n !== 'Trap.nes'), ['my game.nes']);
        assert(loader.games.remove(dir, 'MY GAME.nes') && !loader.games.remove(dir, 'my game.nes') && !loader.games.remove(dir, '../outside.txt'));
    });
    await check('loader: the page is on the car\'s own Wi-Fi; on a Wi-Fi the car has joined only when the app asks, and that one is first then; never on the car\'s other networks', () => {
        const v4 = (address, internal) => [{ address, family: 'IPv4', internal: !!internal }, { address: 'fe80::1', family: 'IPv6', internal: !!internal }];
        // (as a head unit had them, on its owner's home Wi-Fi: its /sys/class/net and /proc/net/fib_trie)
        const unit = { lo: v4('127.0.0.1', true), 'p2p-wlan0-0': [], socnet0: v4('160.48.199.99'), vlan65: v4('160.48.199.119'), vlan73: v4('160.48.199.161'), wlan0: v4('192.168.1.173'), wlan_bridge: v4('172.16.222.97') };
        const pick = (only, joined, all) => loader.service.carWifi(only, joined, all).map((i) => i.kind + ' ' + i.name + ' ' + i.address);
        const but = (name) => { const o = Object.assign({}, unit); delete o[name]; return o; };
        assert.deepStrictEqual(pick(null, false, unit), ['car wlan_bridge 172.16.222.97']);
        assert.deepStrictEqual(pick(null, true, unit), ['joined wlan0 192.168.1.173', 'car wlan_bridge 172.16.222.97']);
        // it has joined nothing, or has no address there yet
        assert.deepStrictEqual(pick(null, true, but('wlan0')), ['car wlan_bridge 172.16.222.97']);
        assert.deepStrictEqual(pick(null, true, Object.assign({}, unit, { wlan0: v4('169.254.10.7') })), ['car wlan_bridge 172.16.222.97']);
        // it has no Wi-Fi of its own (no hotspot, no CarPlay): the one it joined, when asked, and nothing else
        assert.deepStrictEqual(pick(null, true, but('wlan_bridge')), ['joined wlan0 192.168.1.173']);
        assert.deepStrictEqual(pick(null, false, but('wlan_bridge')), []);
        // an access point of its own under another name, a second Wi-Fi joined, a cable
        assert.deepStrictEqual(pick(null, true, { uap0: v4('192.168.50.1'), wlan1: v4('10.0.0.12'), eth0: v4('10.1.1.1') }), ['joined wlan1 10.0.0.12', 'car uap0 192.168.50.1']);
        // a test's own choice, and the emulator's
        assert.deepStrictEqual(pick(['lo'], false, unit), ['car lo 127.0.0.1']);
        assert.deepStrictEqual(pick(['*'], true, { lo: v4('127.0.0.1', true), eth0: v4('192.168.1.20') }), ['joined eth0 192.168.1.20', 'joined lo 127.0.0.1']);
    });
    await check('loader: the firewall listing is read as the head unit prints it; a rule names one interface, the port and our mark', () => {
        const listing = ['table ip filter { # handle 1', '\tchain INPUT { # handle 1', '\t\ttype filter hook input priority filter; policy drop;',
            '\t\tiifname "wlan_bridge" tcp dport 8470 accept comment "mgu-updater-web" # handle 77',
            '\t\tiifname "wlan_bridge" tcp dport 8493 accept comment "clucraft-nes-loader" # handle 91', '\t\tct state established,related accept # handle 5', '\t}',
            '\tchain OUTPUT { # handle 2', '\t\ttype filter hook output priority filter; policy drop;', '\t}', '\tchain helper { # handle 3', '\t\ttcp dport 22 accept # handle 12', '\t}', '}',
            'table inet mgu_uplink { # handle 4', '\tchain in { # handle 1', '\t\ttype filter hook input priority 10; policy accept;', '\t}', '}'].join('\n');
        assert.deepStrictEqual(loader.nft.chains(listing), [
            { family: 'ip', table: 'filter', chain: 'INPUT', hook: 'input', mine: ['91'] }, { family: 'ip', table: 'filter', chain: 'OUTPUT', hook: 'output', mine: [] },
            { family: 'ip', table: 'filter', chain: 'helper', hook: null, mine: [] }, { family: 'inet', table: 'mgu_uplink', chain: 'in', hook: 'input', mine: [] }]);
        assert.deepStrictEqual(loader.nft.rulesFor('input', ['wlan_bridge', 'x"; drop'], 8493).map((r) => r.join(' ')), ['iifname "wlan_bridge" tcp dport 8493 accept comment "clucraft-nes-loader"']);
        assert.deepStrictEqual(loader.nft.rulesFor('output', ['uap0'], 8493).map((r) => r.join(' ')), ['oifname "uap0" tcp sport 8493 accept comment "clucraft-nes-loader"']);
        assert.deepStrictEqual(loader.nft.rulesFor('forward', ['uap0'], 8493), []);
        assert.strictEqual(loader.nft.rulesFor('input', ['uap0', 'wlan_bridge', 'uap0'], 8493).length, 2, 'an interface with two addresses is named twice: one rule for it');
    });
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const until = async (what, fn) => { for (let i = 0; i < 100; i++) { if (fn()) return; await sleep(50); } throw new Error('never: ' + what); };
    if (process.platform === 'win32') console.log('skip loader: the service with a firewall and the app (a head unit runs Linux: these need its kind of sockets and a shell)');
    else {
        // the head unit in small: an app's folder as MainApp lays it out, and a firewall that drops what no rule accepts
        const oap = path.join(tmp, 'oap'), appRoot = path.join(oap, 'oap_12345'), state = path.join(tmp, 'nft.json'), nftProgram = path.join(tmp, 'nft');
        [oap, appRoot, path.join(appRoot, 'source'), path.join(appRoot, 'data'), path.join(oap, 'oap_12201'), path.join(oap, 'oap_12201', 'source')].forEach((d) => fs.mkdirSync(d));
        fs.writeFileSync(path.join(oap, 'oap_12201', 'source', 'package.json'), JSON.stringify({ name: 'mainapp' }));
        const ruleset = () => JSON.parse(fs.readFileSync(state, 'utf8'));
        const rules = (family, table, chain) => ruleset().tables.find((t) => t.family === family && t.name === table).chains.find((c) => c.name === chain).rules.map((r) => r.text);
        const fresh = () => fs.writeFileSync(state, JSON.stringify({ next: 100, tables: [
            { family: 'ip', name: 'filter', chains: [{ name: 'INPUT', hook: 'input', policy: 'drop', rules: [{ text: 'ct state established,related accept', handle: 5 }] }, { name: 'OUTPUT', hook: 'output', policy: 'drop', rules: [] }, { name: 'side', rules: [] }] },
            { family: 'inet', name: 'mgu_uplink', chains: [{ name: 'in', hook: 'input', rules: [{ text: 'iifname "vethuplink" drop', handle: 9 }] }, { name: 'fwd', hook: 'forward', rules: [] }] },
            { family: 'ip6', name: 'filter', chains: [{ name: 'INPUT', hook: 'input', rules: [] }] }] }));
        fs.writeFileSync(nftProgram, '#!/bin/sh\nFAKE_NFT_STATE="' + state + '" exec "' + process.execPath + '" "' + path.join(ROOT, 'test', 'fake-nft.js') + '" "$@"\n');
        fs.chmodSync(nftProgram, 0o755);
        const mark = 'comment "clucraft-nes-loader"';
        await check('loader: the port is opened in every chain packets come in and go out through, once, and closed without a trace', () => {
            fresh();
            let r = loader.nft.open(['wlan_bridge'], 8493, { program: nftProgram });
            assert(r.changed && r.chains === 3 && !r.errors.length, JSON.stringify(r));
            assert.deepStrictEqual(rules('ip', 'filter', 'INPUT'), ['iifname "wlan_bridge" tcp dport 8493 accept ' + mark, 'ct state established,related accept'], 'our rule is first: before what drops');
            assert.deepStrictEqual(rules('ip', 'filter', 'OUTPUT'), ['oifname "wlan_bridge" tcp sport 8493 accept ' + mark]);
            assert.deepStrictEqual(rules('inet', 'mgu_uplink', 'in'), ['iifname "wlan_bridge" tcp dport 8493 accept ' + mark, 'iifname "vethuplink" drop']);
            assert(!rules('ip', 'filter', 'side').length && !rules('inet', 'mgu_uplink', 'fwd').length && !rules('ip6', 'filter', 'INPUT').length, 'a chain that is not on the way got a rule');
            r = loader.nft.open(['wlan_bridge'], 8493, { program: nftProgram, last: r.signature });
            assert(!r.changed && r.chains === 3 && rules('ip', 'filter', 'INPUT').length === 2, 'asked again: rules were added again');
            r = loader.nft.open(['wlan_bridge', 'uap0'], 8493, { program: nftProgram, last: r.signature });
            assert(r.changed && !r.errors.length);
            assert.deepStrictEqual(rules('ip', 'filter', 'INPUT'), ['iifname "wlan_bridge" tcp dport 8493 accept ' + mark, 'iifname "uap0" tcp dport 8493 accept ' + mark, 'ct state established,related accept'], 'a second interface');
            assert.strictEqual(loader.nft.shut({ program: nftProgram }), 6);
            assert.deepStrictEqual([rules('ip', 'filter', 'INPUT'), rules('ip', 'filter', 'OUTPUT'), rules('inet', 'mgu_uplink', 'in')], [['ct state established,related accept'], [], ['iifname "vethuplink" drop']], 'the firewall is not as it was');
            assert.strictEqual(loader.nft.shut({ program: nftProgram }), 0);
            assert.strictEqual(loader.nft.open(['wlan_bridge'], 8493, { program: path.join(tmp, 'no-such-nft') }).errors.length, 1, 'no nft: an error to show, nothing thrown');
        });
        const request = (method, address, body) => new Promise((resolve, reject) => {
            const u = require('url').parse(address);
            const r = http.request({ method, hostname: u.hostname, port: u.port, path: u.path }, (m) => { const parts = []; m.on('data', (d) => parts.push(d)); m.on('end', () => resolve({ status: m.statusCode, type: m.headers['content-type'], body: Buffer.concat(parts).toString() })); });
            r.on('error', reject);
            r.end(body);
        });
        const socket = path.join(tmp, 'loader.sock');
        const said = [];
        const service = loader.service.createService({ listen: socket, oapDir: oap, port: 18493, interfaces: ['lo'], nft: nftProgram, asSelf: true, exit: false, refreshMs: 100, idleMs: 1e9, log: (s) => said.push(s) });
        const phone = new Phone({ socket, log });
        try {
            await check('loader: without the NES app on the head unit there is no page; without the loader the app says it is missing', async () => {
                phone.open();
                await until('an answer', () => phone.state.step === 'failed');
                assert(/not installed/.test(phone.state.error), phone.state.error);
                phone.close();
                const lost = new Phone({ socket: path.join(tmp, 'no-loader.sock'), log });
                lost.open();
                await until('missing', () => lost.state.step === 'missing');
                lost.close();
                assert.strictEqual(lost.state.step, 'off');
            });
            fs.writeFileSync(path.join(appRoot, 'source', 'package.json'), JSON.stringify({ name: 'clucraft_nes', version: spec0.version }));
            let base = null;
            await check('loader: the app asks, and gets a page on the car Wi-Fi behind an address nobody can guess, its port open in the firewall', async () => {
                fresh();
                phone.open();
                await until('the page', () => phone.state.step === 'open' && phone.state.page.url);
                base = phone.state.page.url;
                assert(/^http:\/\/127\.0\.0\.1:18493\/[0-9a-f]{20}\/$/.test(base), base);
                assert(phone.state.page.nets[0].url === base && phone.state.page.nets.every((n) => n.kind === 'car' && n.name === 'lo'), JSON.stringify(phone.state.page.nets));
                assert.strictEqual(qr(base).version, 3, 'the address fits a small code');
                await until('the rules', () => rules('ip', 'filter', 'INPUT').length === 2);
                assert.deepStrictEqual(rules('ip', 'filter', 'INPUT')[0], 'iifname "lo" tcp dport 18493 accept ' + mark);
                let r = null;
                for (let i = 0; i < 40 && !r; i++) { r = await request('GET', base).catch(() => null); if (!r) await sleep(50); }
                assert(r && r.status === 200 && /^text\/html/.test(r.type) && /Choose games/.test(r.body), 'the page: ' + (r && r.status));
                assert.strictEqual((await request('GET', base.slice(0, -1))).status, 302);
                for (const wrong of ['http://127.0.0.1:18493/', base.replace(/[0-9a-f]\/$/, 'x/'), base.replace(/\/$/, 'ff/'), 'http://127.0.0.1:18493/' + '0'.repeat(20) + '/games']) {
                    assert.strictEqual((await request('GET', wrong)).status, 404, wrong);
                }
            });
            await check('loader: a game sent to the page is in the app\'s games folder and on the app\'s screen; what is no game is not', async () => {
                const roms = path.join(appRoot, 'data', 'roms');
                let r = await request('POST', base + 'games?name=' + encodeURIComponent('../../Sent from a phone (v1).nes'), game);
                assert.deepStrictEqual([r.status, JSON.parse(r.body)], [200, { ok: true, name: 'Sent from a phone (v1).nes', size: game.length, replaced: false }]);
                assert(fs.readFileSync(path.join(roms, 'Sent from a phone (v1).nes')).equals(game));
                r = await request('POST', base + 'games?name=notes.txt', game);
                assert(r.status === 400 && JSON.parse(r.body).ok === false);
                r = await request('POST', base + 'games?name=broken.nes', Buffer.alloc(30000, 3));
                assert(r.status === 400 && /not an NES game/.test(JSON.parse(r.body).error));
                r = await request('POST', base + 'games?name=huge.nes', Buffer.concat([game.slice(0, 16), Buffer.alloc(loader.games.MAX_GAME)])).catch((e) => ({ status: 413, body: e.code }));
                assert.strictEqual(r.status, 413, 'more than the app reads is cut off');
                assert.deepStrictEqual(fs.readdirSync(roms), ['Sent from a phone (v1).nes'], 'the games folder');
                assert.deepStrictEqual(fs.readdirSync(path.join(appRoot, 'data')), ['roms'], 'nothing beside the games folder');
                assert.deepStrictEqual(JSON.parse((await request('GET', base + 'games')).body), { games: [{ name: 'Sent from a phone (v1).nes', size: game.length }] });
                await until('the app hearing of it', () => (phone.state.page.saved || []).length >= 3);
                const heard = phone.state.page.saved;
                assert(heard[0].name === 'Sent from a phone (v1).nes' && !heard[0].refused && heard[1].refused && heard[2].refused, JSON.stringify(heard));
                // the app finds it as any game in its folder
                const lib = new Library({ packs: [], dirs: [roms], dataDir: tmp, log });
                assert.deepStrictEqual(lib.scan().map((g) => g.title), ['Sent from a phone']);
                assert.strictEqual((await request('DELETE', base + 'games?name=' + encodeURIComponent('sent from a phone (v1).nes'))).status, 200);
                assert.deepStrictEqual(fs.readdirSync(roms), []);
            });
            await check('loader: when the app leaves the screen the page is gone, and the firewall is as it was', async () => {
                phone.close();
                await until('the rules gone', () => rules('ip', 'filter', 'INPUT').length === 1 && !rules('ip', 'filter', 'OUTPUT').length && rules('inet', 'mgu_uplink', 'in').length === 1);
                await until('the page gone', () => service.status().page.open === false);
                let r = 'answered';
                for (let i = 0; i < 40 && r === 'answered'; i++) { r = await request('GET', base).then(() => 'answered', (e) => e.code); if (r === 'answered') await sleep(50); }
                assert.strictEqual(r, 'ECONNREFUSED', 'the page still answers');
                // and when the app goes without a word (it crashed): the same
                // (this time asked for on a Wi-Fi the head unit has joined, as the app's setting has it: the loader says which kind)
                const gone = new Phone({ socket, log, joined: () => true });
                gone.open();
                await until('a page again', () => gone.state.step === 'open' && rules('ip', 'filter', 'INPUT').length === 2);
                assert.notStrictEqual(gone.state.page.url, base, 'the same address twice');
                assert(gone.state.page.nets.length && gone.state.page.nets.every((n) => n.kind === 'joined'), JSON.stringify(gone.state.page.nets));
                assert(said.some((l) => /page open for .*on a Wi-Fi the head unit has joined too/.test(l)), said.join(' | '));
                gone.conn.destroy();
                gone.wanted = false;
                await until('the rules gone again', () => rules('ip', 'filter', 'INPUT').length === 1);
                assert(said.some((l) => /page closed: the app left/.test(l)), said.join(' | '));
            });
        } finally {
            phone.close();
            service.stop(0);
        }
    }

    /* ---------- a USB gamepad, from the program that reads it to the app (a stand-in for that program: test/fake-usbpipe.js) ---------- */
    {
        // (Windows has pipes of this kind of name where other systems have socket files)
        const sock = (name) => (process.platform === 'win32' ? '\\\\.\\pipe\\nes-test-' + process.pid + '-' + name : path.join(tmp, name + '.sock'));
        const padLog = path.join(tmp, 'pad.log'), wrote = () => (fs.existsSync(padLog) ? fs.readFileSync(padLog, 'utf8').split('\n').filter(Boolean) : []);
        // the pad, once switched on: A; let go and left on the D-pad; the stick right with X; Menu; nothing; the
        // Xbox button, which wants an answer; and then it waits to be pulled out
        const does = [report(0x10, 0), report(0, 0x04), report(0x40, 0, 30000, 0), report(0x04, 0), report(0, 0)].map((b) => b.toString('hex')).concat(['07302a02015b', 'pulled']).join(',');
        const dev = { kind: 'gip', node: '/dev/bus/usb/001/004', iface: 0, epIn: 0x82, epOut: 0x02, packet: 64, vid: 0x045e, pid: 0x02ea, name: 'Controller' };
        const padSaid = [], seen = [];
        let plugged = false;
        const padService = loader.service.createService({ listen: sock('pad'), nft: null, asSelf: true, exit: false, idleMs: 1e9, padScanMs: 40, padFind: () => (plugged ? [dev] : []),
            padPipe: [process.execPath, path.join(ROOT, 'test', 'fake-usbpipe.js'), padLog, does], padEnv: process.env, log: (s) => padSaid.push(s) });
        const pad = new Pad({ socket: sock('pad'), log, onMask: (m) => seen.push(m) });
        try {
            await check('gamepad: the app asks while a game runs; a pad plugged in then is switched on, and its buttons are the NES pad\'s in the app', async () => {
                pad.start();
                await until('the loader\'s answer', () => padService.status().pad.on === true);
                await sleep(150);
                assert(pad.name === null && !seen.length && !wrote().length, 'no pad is plugged in yet');
                plugged = true;
                await until('its buttons', () => seen.length >= 5);
                assert.deepStrictEqual(seen, [BTN.A, BTN.LEFT, BTN.RIGHT | BTN.B, BTN.START, 0]);
                assert.strictEqual(pad.name, 'Controller');
                const log0 = wrote();
                assert.strictEqual(log0[0], 'args /dev/bus/usb/001/004 0 82 2 64', 'what the program is started with');
                assert.deepStrictEqual(log0.slice(1, 5), ['out 0520000100', 'out 0520010f06', 'out 0a200203000114', 'out 062003020100'], 'what switches the pad on');
                await until('the answer to the Xbox button', () => wrote().indexOf('out 01202a09000720020000000000') >= 0);
                assert.strictEqual(padService.status().page.open, false, 'a gamepad opens no page and no port');
            });
            await check('gamepad: pulled out, it is gone for the app; plugged in again, it is read again; the game stopping lets go of it', async () => {
                plugged = false;
                fs.writeFileSync(padLog + '.pull', '');
                await until('the pad gone', () => wrote().indexOf('gone') >= 0 && pad.name === null && padService.status().pad.name === null);
                assert(padSaid.some((l) => /gamepad: unplugged/.test(l)), padSaid.join(' | '));
                assert.strictEqual(seen.length, 5, 'buttons from a pad that is gone');
                fs.unlinkSync(padLog + '.pull');
                plugged = true;
                await until('the pad again', () => wrote().filter((l) => /^args /.test(l)).length === 2 && seen.length >= 6);
                assert.strictEqual(seen[5], BTN.A);
                pad.stop();
                assert.strictEqual(seen[seen.length - 1], 0, 'a button held when the game stops is let go');
                await until('the loader letting go', () => padService.status().pad.on === false && wrote().indexOf('end') >= 0);
                const n = seen.length;
                await sleep(200);
                assert.strictEqual(seen.length, n, 'buttons after the game stopped');
            });
            await check('gamepad: read by a program of one\'s own, the whole pad is told whenever anything of it changes, and its buttons as the loader gets them', async () => {
                const log2 = path.join(tmp, 'pad-whole.log'), states = [], bits = [], P = loader.pad.PAD, F = loader.pad.PAD_FULL;
                const st = (buttons, lt, rt, lx, ly, rx, ry) => ({ buttons, lt, rt, lx, ly, rx, ry });
                // a trigger pulled a little, then all the way; the same again; let go, with A and the right stick
                // pressed in and out to the left; all let go
                const steps = [whole(0, 0, 0, 200, 0, 0, 0, 0), whole(0, 0, 0, 1023, 0, 0, 0, 0), whole(0, 0, 0, 1023, 0, 0, 0, 0), whole(0x10, 0x80, 0, 0, 0, 0, -20000, 9), whole(0, 0, 0, 0, 0, 0, 0, 0)]
                    .map((b) => b.toString('hex')).concat(['pulled']).join(',');
                let closed = null;
                const reader = loader.pad.open(dev, { pipe: [process.execPath, path.join(ROOT, 'test', 'fake-usbpipe.js'), log2, steps], env: process.env,
                    onState: (s) => states.push(s), onButtons: (b) => bits.push(b), onClose: (why) => { closed = why; } });
                try {
                    await until('the pad at rest again', () => states.length >= 4);
                    assert.deepStrictEqual(states, [st(0, 0, 200, 0, 0, 0, 0), st(0, 0, 1023, 0, 0, 0, 0), st(P.A | F.RS, 0, 0, 0, 0, -20000, 9), st(0, 0, 0, 0, 0, 0, 0)]);
                    assert.deepStrictEqual(bits, [P.A, 0], 'a trigger and a stick pressed in are no button of the NES app\'s');
                } finally { reader.close(); }
                await until('the program let go of', () => fs.existsSync(log2) && fs.readFileSync(log2, 'utf8').split('\n').indexOf('end') >= 0);
                assert.strictEqual(closed, null, 'let go of by its reader, it does not say it ended');
            });
            await check('gamepad: a program that cannot read the pad is not started over and over; a loader from before gamepads is asked once', async () => {
                const said = [];
                const broken = loader.service.createService({ listen: sock('pad-broken'), nft: null, asSelf: true, exit: false, idleMs: 1e9, padScanMs: 20, padFind: () => [dev],
                    padPipe: [process.execPath, '-e', 'console.error("nes-usbpipe: interface 0 of /dev/bus/usb/001/004: permission denied"); process.exit(2)'], padEnv: process.env, log: (s) => said.push(s) });
                const p = new Pad({ socket: sock('pad-broken'), log, onMask: (m) => seen.push(m) });
                try {
                    p.start();
                    await until('giving up', () => p.given === true);
                    assert(/cannot be read.*permission denied/.test(p.said), p.said);
                    const tries = said.filter((l) => /Controller \(045e:02ea\)/.test(l)).length;
                    await sleep(200);
                    assert.strictEqual(said.filter((l) => /Controller \(045e:02ea\)/.test(l)).length, tries, 'started again after giving up');
                    assert(tries >= 2 && tries <= 5, tries + ' tries');
                } finally { p.stop(); broken.stop(0); }
                let asked = 0;
                const old = net.createServer((c) => { asked++; c.on('error', () => {}); c.on('data', () => c.write('{"ok":false,"error":"unknown: pad"}\n')); });
                await new Promise((r) => old.listen(sock('pad-old'), r));
                const q = new Pad({ socket: sock('pad-old'), log });
                try {
                    q.start();
                    await until('its answer', () => q.given === true);
                    await sleep(150);
                    assert.strictEqual(asked, 1);
                } finally { q.stop(); old.close(); }
            });
        } finally {
            pad.stop();
            padService.stop(0);
        }
    }

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
    await check('store: the package is an OAP package of that id and version, without an SDK and without games of anyone\'s', () => {
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
        [['app.js', 'main.js'], ['controls.js'], ['library.js'], ['nes-core.js'], ['phone.js'], ['pad.js'], ['qr.js'], ['nes.wasm'], ['LICENSE'], ['NOTICE']].forEach((q) => {
            assert(inPkg(q[0]).equals(fs.readFileSync(path.join(ROOT, 'app', q[1] || q[0]))), 'app/' + (q[1] || q[0]) + ' changed since the package was built');
        });
        // the games in it: the app's own two, as they are in app/games/
        const packed = path.join(tmp, 'store-games.pack');
        fs.writeFileSync(packed, inPkg('games.pack'));
        const pack = openPack(packed);
        assert(pack, 'games.pack is no data pack');
        assert.deepStrictEqual(pack.names.slice().sort(), BUNDLED, 'the games in the package');
        BUNDLED.forEach((n) => assert(pack.read(n).equals(bundled(n)), 'app/games/' + n + ' changed since the package was built'));
        const rt = JSON.parse(inPkg('kit/app-spec.json').toString());
        ['id', 'title', 'version', 'screens', 'settings', 'config'].forEach((k) => assert.deepStrictEqual(rt[k], spec[k], 'app/app.json "' + k + '" changed since the package was built'));
    });
    await check('store: the NES game loader is listed as a tool the Store can pack: its files and units are there, its hooks among them', () => {
        const repo = json('mgu-repo.json');
        assert(Array.isArray(repo.tools) && repo.tools.length === 1, 'one tool');
        const tool = repo.tools[0], c = json(path.join(tool.path, 'component.json'));
        assert(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(tool.id) && tool.id !== spec.id && relPath(tool.path) && tool.build === undefined, 'its entry');
        assert(c.id === tool.id && c.kind === 'tool' && SEMVER.test(c.version) && c.build === undefined, 'component.json names ' + tool.id + ', a tool with a version and no build step');
        assert.strictEqual(c.version, loader.service.VERSION, 'the service says another version than component.json');
        assert(tool.optional === true && tool.uninstallable === true && Array.isArray(tool.mguHmi), 'optional, removable, for named head units');
        assert(Object.keys(c.requires).every((k) => k !== c.id && SEMVER.test(c.requires[k])) && c.requires['mgu-deploy'], 'requires the deploy tool its "deactivate" needs');
        const inFolder = (rel) => relPath(rel) && fs.existsSync(path.join(ROOT, tool.path, rel));
        c.files.forEach((f) => assert(relPath(f.path) && /^[0-7]{3,4}$/.test(f.mode) && inFolder(f.from || f.path), 'file ' + JSON.stringify(f)));
        c.units.forEach((u) => assert(/^[A-Za-z0-9@_.-]+\.(service|socket)$/.test(u.name) && inFolder(u.from || u.name), 'unit ' + JSON.stringify(u)));
        const paths = c.files.map((f) => f.path), units = c.units.map((u) => u.name);
        // every .js the service loads is installed with it
        fs.readdirSync(path.join(ROOT, tool.path)).filter((f) => /\.js$/.test(f)).forEach((f) => assert(paths.indexOf(f) >= 0, f + ' is not among the files'));
        assert(paths.indexOf(c.check[0]) >= 0 && c.deactivate[0] === 'node' && paths.indexOf(c.deactivate[1]) >= 0, 'check and deactivate are files of the tool');
        c.enable.forEach((e) => assert(units.indexOf(e.unit) >= 0, 'enabled: ' + e.unit));
        c.restart.forEach((u) => assert(units.indexOf(u) >= 0, 'restarted: ' + u));
        assert(c.recmgr.every((n) => /^[A-Za-z0-9:._+@-]+$/.test(n)));
        // the units run what the Store installs, where it installs it
        const unitText = (n) => fs.readFileSync(path.join(ROOT, tool.path, c.units.find((u) => u.name === n).from), 'utf8');
        const svc = unitText(tool.id + '.service'), sock = unitText(tool.id + '.socket');
        ['service.js', 'cleanup.js'].forEach((f) => assert(svc.indexOf('/var/opt/' + tool.id + '/current/' + f) >= 0, 'the service unit runs ' + f));
        assert(/^LimitCORE=1$/m.test(svc) && !/^WantedBy=/m.test(svc), 'the service: no core files, and not started at boot');
        assert(sock.indexOf('ListenStream=' + require(path.join(ROOT, 'app/phone')).SOCKET) >= 0 && /^SocketMode=0600$/m.test(sock), 'the socket is the one the app asks at, root\'s alone until sockgroup.js opens it to the app');
        assert.strictEqual(spec.config.loaderSocket, require(path.join(ROOT, 'app/phone')).SOCKET);
        assert.strictEqual(require(path.join(ROOT, 'loader/games')).APP, spec.id, 'the loader looks for another app');
        // the program that reads a gamepad: for the head unit's processor, needing no library of the head unit's
        // (tools/build-usbpipe.js builds it from loader/src/nes-usbpipe/main.go)
        const pipe = fs.readFileSync(path.join(ROOT, tool.path, 'nes-usbpipe'));
        assert(c.files.some((f) => f.path === 'nes-usbpipe' && f.mode === '0755'), 'nes-usbpipe is installed as a program');
        assert(pipe.slice(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) && pipe[4] === 2 && pipe[5] === 1 && pipe.readUInt16LE(16) === 2 && pipe.readUInt16LE(18) === 0x3e, 'nes-usbpipe is a 64-bit x86 Linux program');
        const heads = pipe.readUInt32LE(32), headSize = pipe.readUInt16LE(54), headCount = pipe.readUInt16LE(56);   // (the program headers; none names a loader for libraries: type 3)
        for (let i = 0; i < headCount; i++) assert.notStrictEqual(pipe.readUInt32LE(heads + i * headSize), 3, 'nes-usbpipe needs libraries: build it with tools/build-usbpipe.js');
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
    await check('app: one drawn screen, the game\'s, and every picture goes to it (the GPU renderer shows an app\'s first drawn screen only; a car\'s HMI took no picture for a second)', () => {
        assert.deepStrictEqual(spec.screens.filter((s) => s.kind === 'canvas').map((s) => s.name), ['GAME']);
        const main = fs.readFileSync(path.join(ROOT, 'app/main.js'), 'utf8');
        const to = (main.match(/ui\.image\('[A-Z_]+'/g) || []).filter((v, i, all) => all.indexOf(v) === i);
        assert.deepStrictEqual(to, ['ui.image(\'GAME_GFX\''], 'a picture for another screen');
        assert(!/ui\.open\('(?!MAIN'|GAME')/.test(main), 'a screen opened that is neither the menu nor the game\'s');
        assert(spec.screens[0].items.some((it) => it[1] === 'BTN_ADD'), '"Add games from a phone" is in the menu');
    });

    console.log(failed ? failed + ' failed' : 'nes: all ok');
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
