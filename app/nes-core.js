'use strict';
/**
 * nes-core.js - runs the NES emulator inside the app: FCEUmm (GPL-2, see LICENSE / NOTICE in this
 * folder) compiled to WebAssembly (nes.wasm, built by core/build.sh).
 *
 *   const nes = new Nes({ wasm, log });
 *   nes.compile().then(() => {            // once; compiled off the main thread
 *       nes.load(romBytes);               // an iNES file
 *       nes.setPad(0, BTN.A | BTN.RIGHT);
 *       if (nes.run()) { const f = nes.frame(); ... f.px (RGBA), f.w, f.h }
 *   });
 *
 * The core is a libretro core; core/mgu_libretro.c is its frontend and exports the
 * few calls used here. Node 8 has no WASI, and the core needs no files (the ROM, save states and
 * battery memory go through buffers), so the C library's system calls answer "not there".
 * A crash inside the core (a trap) ends that instance only: the next load() makes a new one.
 */
const fs = require('fs');

/* the joypad: masks of RETRO_DEVICE_ID_JOYPAD_* bits (FCEUmm: X and Y are turbo A and B) */
const BTN = { B: 1 << 0, SELECT: 1 << 2, START: 1 << 3, UP: 1 << 4, DOWN: 1 << 5, LEFT: 1 << 6, RIGHT: 1 << 7, A: 1 << 8 };
const E = { OK: 0, BADF: 8, NOENT: 44, NOSYS: 52, SPIPE: 70 };
const LEVELS = ['debug', 'info', 'warn', 'error'];

/** an iNES / NES 2.0 file? ("NES" 0x1A, then 16 KB program banks) */
function isRom(b) {
    return !!b && b.length >= 16 + 8192 && b[0] === 0x4e && b[1] === 0x45 && b[2] === 0x53 && b[3] === 0x1a;
}

class Nes {
    constructor(opts) {
        this.o = opts;
        this.log = opts.log || console;
        this.mod = null;                 // the compiled module (kept: a new instance needs no compile)
        this.x = null;                   // the instance's exports
        this.mem = null;
        this.loaded = false;
        this.dead = null;                // the error that ended this instance
        this.vars = {};                  // core options, set again on every new instance
        this.crop = [0, 0, 0, 0];
        this.out = '';
        this.onDead = null;
    }

    /** Compile nes.wasm: a Promise. Off the main thread, so the menu stays alive meanwhile. */
    compile() {
        if (this.compiling) return this.compiling;
        const t = Date.now();
        this.compiling = WebAssembly.compile(fs.readFileSync(this.o.wasm)).then((mod) => {
            this.mod = mod;
            this.log.info('nes: emulator compiled in ' + (Date.now() - t) + ' ms');
            return this;
        });
        return this.compiling;
    }
    get ready() { return !!this.mod; }

    /* ---------- memory (views are made fresh: memory.grow detaches them) ---------- */
    get u8() { return new Uint8Array(this.mem.buffer); }
    bytes(p, n) { return new Uint8Array(this.mem.buffer, p, n); }
    str(p, n) { return Buffer.from(this.mem.buffer, p, n).toString('utf8'); }
    /** a C string in the core's memory (freed by the caller with mgu_free) */
    cstr(s) {
        const b = Buffer.from(String(s) + '\0', 'utf8'), p = this.x.mgu_alloc(b.length);
        this.u8.set(b, p);
        return p;
    }

    imports() {
        const self = this;
        const w = {
            fd_close() { return E.OK; },
            fd_fdstat_get(fd, p) {
                if (fd > 2) return E.BADF;
                const u = self.u8;
                for (let i = 0; i < 24; i++) u[p + i] = 0;
                u[p] = 2;                                        // a character device
                return E.OK;
            },
            fd_prestat_get() { return E.BADF; },                // no folders at all
            fd_prestat_dir_name() { return E.BADF; },
            fd_read() { return E.BADF; },
            fd_seek(fd) { return fd <= 2 ? E.SPIPE : E.BADF; },
            fd_tell() { return E.BADF; },
            fd_write(fd, iovs, n, nwritten) {
                if (fd !== 1 && fd !== 2) return E.BADF;
                let total = 0;
                for (let i = 0; i < n; i++) {
                    const dv = new DataView(self.mem.buffer), b = dv.getUint32(iovs + i * 8, true), len = dv.getUint32(iovs + i * 8 + 4, true);
                    self.print(self.str(b, len));
                    total += len;
                }
                new DataView(self.mem.buffer).setUint32(nwritten, total, true);
                return E.OK;
            },
            path_open() { return E.NOENT; },
            path_filestat_get() { return E.NOENT; },
            proc_exit(code) { throw new Error('nes: the emulator exited (' + code + ')'); },
            random_get(p, n) { const u = self.u8; for (let i = 0; i < n; i++) u[p + i] = (Math.random() * 256) | 0; return E.OK; },
        };
        const env = {
            js_log(level, p, n) {
                const s = self.str(p, n).trim();
                if (s) self.log[LEVELS[level] || 'info']('nes: ' + s);
            },
        };
        const imp = { wasi_snapshot_preview1: w, env };
        // anything else a rebuilt core asks for: "not supported"
        WebAssembly.Module.imports(this.mod).forEach((i) => {
            if (i.kind === 'function' && imp[i.module] && !imp[i.module][i.name]) imp[i.module][i.name] = () => E.NOSYS;
        });
        return imp;
    }

    print(s) {
        this.out += s;
        let i;
        while ((i = this.out.indexOf('\n')) >= 0) { const line = this.out.slice(0, i).trim(); this.out = this.out.slice(i + 1); if (line) this.log.info('nes: ' + line); }
    }

    /** a fresh instance of the compiled module (the first, or after a crash) */
    boot() {
        if (!this.mod) throw new Error('nes: the emulator is not compiled yet');
        const inst = new WebAssembly.Instance(this.mod, this.imports());
        this.x = inst.exports;
        this.mem = this.x.memory;
        this.dead = null;
        this.loaded = false;
        if (this.x._initialize) this.x._initialize();
        this.x.mgu_init();
        Object.keys(this.vars).forEach((k) => this._var(k, this.vars[k]));
        this.x.mgu_set_crop(this.crop[0], this.crop[1], this.crop[2], this.crop[3]);
    }

    /** run fn inside the core; a trap ends the instance (onDead) and gives `otherwise` */
    guard(fn, otherwise) {
        if (this.dead || !this.x) return otherwise;
        try { return fn(); } catch (e) {
            this.dead = e;
            this.loaded = false;
            this.log.error('nes: the emulator crashed', e);
            if (this.onDead) try { this.onDead(e); } catch (e2) { this.log.error(e2); }
            return otherwise;
        }
    }

    _var(key, value) {
        const k = this.cstr(key), v = this.cstr(value);
        this.x.mgu_set_var(k, v);
        this.x.mgu_free(k); this.x.mgu_free(v);
    }
    /** a core option (libretro_core_options.h, e.g. 'fceumm_nospritelimit', 'enabled'); kept for later instances */
    setVar(key, value) {
        value = String(value);
        if (this.vars[key] === value) return;
        this.vars[key] = value;
        this.guard(() => this._var(key, value));
    }
    /** pixels cut off each side of the picture: left, top, right, bottom */
    setCrop(l, t, r, b) {
        this.crop = [l | 0, t | 0, r | 0, b | 0];
        this.guard(() => this.x.mgu_set_crop(this.crop[0], this.crop[1], this.crop[2], this.crop[3]));
    }

    /** Start a game from its ROM file's bytes. false: not a ROM the core takes. */
    load(rom) {
        if (!isRom(rom)) return false;
        if (!this.x || this.dead) this.boot();
        const ok = this.guard(() => {
            const p = this.x.mgu_alloc(rom.length);          // (the core frees it with the game)
            if (!p) return false;
            this.u8.set(rom, p);
            return !!this.x.mgu_load(p, rom.length);
        }, false);
        this.loaded = ok;
        if (ok) this.fps = this.x.mgu_fps_milli() / 1000;
        return ok;
    }
    unload() { if (this.loaded) { this.guard(() => this.x.mgu_unload()); this.loaded = false; } }

    /** the pad's buttons held now: an OR of BTN masks (port 0 = player 1) */
    setPad(port, mask) { if (this.loaded) this.guard(() => this.x.mgu_set_pad(port, mask)); }
    /** One video frame. true: a new picture is in frame(). */
    run() { return this.loaded ? !!this.guard(() => this.x.mgu_run(), 0) : false; }
    /** the last picture: { px: RGBA bytes (a view into the core's memory, valid until the next call into it), w, h } */
    frame() {
        if (!this.loaded) return null;
        const w = this.x.mgu_frame_w(), h = this.x.mgu_frame_h(), p = this.x.mgu_frame_ptr();
        return p && w && h ? { px: this.bytes(p, w * h * 4), w, h } : null;
    }
    /** the console's reset button */
    reset() { if (this.loaded) this.guard(() => this.x.mgu_reset()); }

    /** The whole machine as a Buffer (a save state), or null. */
    saveState() {
        if (!this.loaded) return null;
        return this.guard(() => {
            const n = this.x.mgu_state_size();
            if (!n) return null;
            const p = this.x.mgu_alloc(n);
            if (!p) return null;
            const ok = this.x.mgu_state_save(p, n);
            const b = ok ? Buffer.from(this.bytes(p, n)) : null;     // a copy
            this.x.mgu_free(p);
            return b;
        }, null);
    }
    loadState(b) {
        if (!this.loaded || !b || !b.length) return false;
        return this.guard(() => {
            const p = this.x.mgu_alloc(b.length);
            if (!p) return false;
            this.u8.set(b, p);
            const ok = !!this.x.mgu_state_load(p, b.length);
            this.x.mgu_free(p);
            return ok;
        }, false);
    }

    /** the cartridge's battery memory: a copy, or null when the game has none */
    sram() {
        if (!this.loaded) return null;
        return this.guard(() => {
            const n = this.x.mgu_sram_size(), p = this.x.mgu_sram_ptr();
            return n && p ? Buffer.from(this.bytes(p, n)) : null;
        }, null);
    }
    /** put saved battery memory back (right after load(), before the first frame) */
    setSram(b) {
        if (!this.loaded || !b) return false;
        return this.guard(() => {
            const n = this.x.mgu_sram_size(), p = this.x.mgu_sram_ptr();
            if (!n || !p || b.length !== n) return false;
            this.u8.set(b, p);
            return true;
        }, false);
    }
}

module.exports = { Nes, BTN, isRom };
