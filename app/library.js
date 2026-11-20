'use strict';
/**
 * library.js - the games (ROM files) the app can start, and what it keeps for each of them.
 *
 * Games come from these places, a later one's file winning over an earlier one's of the same name:
 *   games.pack         app/games/*.nes: the free games that come with the app (games/ has their source)
 *   roms.pack          app/roms/*.nes on the PC: your own, packed into the app by a build for your car
 *                      (kit/tools/pack_data.py); never in a package that is published
 *   <data>/roms/       .nes files copied to the app's data folder on the head unit (and any folder
 *                      listed in app.json config.romDirs)
 *   a USB stick        .nes files in a folder "nes" at the top of a stick that is plugged in
 *                      (usbFolders; they are played from the stick, not copied)
 *
 * Kept per game in <data>/saves/: <game>.srm (the cartridge's battery memory) and <game>.state (where
 * the game stood when it was last left). <data>/last.json names the game played last.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAGIC = 'MGUPACK1';
const ROM_RE = /\.nes$/i;
const MAX_ROM = 8 << 20;

function mkdirp(dir) {
    // (Node 8's mkdirSync has no { recursive })
    if (fs.existsSync(dir)) return;
    mkdirp(path.dirname(dir));
    try { fs.mkdirSync(dir); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}

/** a short stable number for a name (FNV-1a), as 8 hex digits */
function hash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
}

/** "Some Game (USA) (Rev 1).nes" -> "Some Game": the name shown in the menu */
function titleOf(file) {
    const base = path.basename(file).replace(ROM_RE, '');
    const t = base.replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
    return (t || base).slice(0, 48);
}

/** the files of a data pack: { names: [...], read(name) -> Buffer } (pack_data.py's format), or null */
function openPack(file) {
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch (e) { return null; }
    try {
        const head = Buffer.alloc(12);
        fs.readSync(fd, head, 0, 12, 0);
        if (head.toString('latin1', 0, 8) !== MAGIC) throw new Error('not a data pack');
        const ilen = head.readUInt32LE(8), ibuf = Buffer.alloc(ilen);
        fs.readSync(fd, ibuf, 0, ilen, 12);
        const index = JSON.parse(zlib.inflateRawSync(ibuf).toString('utf8'));
        const base = 12 + ilen;
        return {
            names: Object.keys(index.files || {}),
            read(name) {
                const e = index.files[name];
                if (!e) return null;
                const b = Buffer.alloc(e[1]);
                fs.readSync(fd, b, 0, e[1], base + e[0]);
                return zlib.inflateRawSync(b);
            },
        };
    } catch (e) {
        try { fs.closeSync(fd); } catch (e2) { /* ignore */ }
        return null;
    }
}

/**
 * The games folders of the USB sticks plugged in: <root>/<stick>/<name> for the first of names that
 * is there on each stick. The head unit mounts a stick at /media/<its label>.
 * -> { dirs: [folders], errors: [what could not be read, e.g. the app may not look there] }
 */
function usbFolders(roots, names) {
    const dirs = [], errors = [];
    (roots || []).forEach((root) => {
        let sticks = [];
        try { sticks = fs.readdirSync(root); } catch (e) { if (e.code !== 'ENOENT') errors.push(root + ': ' + (e.code || e.message)); return; }
        sticks.forEach((stick) => {
            for (let i = 0; i < names.length; i++) {
                const dir = path.join(root, stick, names[i]);
                try {
                    if (!fs.statSync(dir).isDirectory()) continue;
                    fs.readdirSync(dir);                       // (it can be read)
                    dirs.push(dir);
                    return;
                } catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') errors.push(dir + ': ' + (e.code || e.message)); }
            }
        });
    });
    return { dirs, errors };
}

class Library {
    /**
     * opts: { packs: [data packs with .nes files, the app's own], dirs: [folders with .nes files],
     *         more: () => [folders that come and go, looked up at each scan], dataDir, log }
     */
    constructor(opts) {
        this.o = opts;
        this.log = opts.log || console;
        this.saveDir = path.join(opts.dataDir, 'saves');
        this.lastFile = path.join(opts.dataDir, 'last.json');
        this.games = [];
        this.packs = null;
    }

    /** Look for games: [{ id, title, file, dir | null, pack | null }] by title. */
    scan() {
        const found = new Map();                 // lower-case file name -> game
        const add = (file, dir, pack) => {
            const name = path.basename(file);
            found.set(name.toLowerCase(), { id: name.replace(ROM_RE, '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) + '-' + hash(name.toLowerCase()), title: titleOf(name), file, dir, pack });
        };
        if (!this.packs) this.packs = (this.o.packs || []).map(openPack).filter(Boolean);
        this.packs.forEach((pack) => pack.names.filter((n) => ROM_RE.test(n)).forEach((n) => add(n, null, pack)));
        (this.o.dirs || []).concat(this.o.more ? this.o.more() : []).forEach((dir) => {
            let list = [];
            try { list = fs.readdirSync(dir); } catch (e) { return; }
            list.filter((n) => ROM_RE.test(n)).forEach((n) => add(n, dir, null));
        });
        this.games = Array.from(found.values()).sort((a, b) => a.title.toLowerCase() < b.title.toLowerCase() ? -1 : a.title.toLowerCase() > b.title.toLowerCase() ? 1 : 0);
        return this.games;
    }
    byId(id) { return this.games.find((g) => g.id === id) || null; }

    /** the ROM file's bytes, or null */
    read(g) {
        try {
            if (g.dir) {
                const f = path.join(g.dir, g.file);
                if (fs.statSync(f).size > MAX_ROM) return null;
                return fs.readFileSync(f);
            }
            const b = g.pack && g.pack.read(g.file);
            return b && b.length <= MAX_ROM ? b : null;
        } catch (e) { this.log.warn('nes: ' + g.file + ': ' + e.message); return null; }
    }

    /* ---------- what is kept per game ---------- */
    _file(g, ext) { return path.join(this.saveDir, g.id + ext); }
    _get(g, ext) { try { return fs.readFileSync(this._file(g, ext)); } catch (e) { return null; } }
    /** written to a temporary file first: a save cut short (the head unit going down) leaves the old one */
    _put(g, ext, data) {
        try {
            mkdirp(this.saveDir);
            const f = this._file(g, ext);
            fs.writeFileSync(f + '.tmp', data);
            fs.renameSync(f + '.tmp', f);
            return true;
        } catch (e) { this.log.warn('nes: saving ' + g.id + ext + ': ' + e.message); return false; }
    }
    state(g) { return this._get(g, '.state'); }
    setState(g, b) { return this._put(g, '.state', b); }
    dropState(g) { try { fs.unlinkSync(this._file(g, '.state')); } catch (e) { /* none */ } }
    sram(g) { return this._get(g, '.srm'); }
    setSram(g, b) { return this._put(g, '.srm', b); }

    /** the game played last (still there), or null */
    last() {
        try { return this.byId(JSON.parse(fs.readFileSync(this.lastFile, 'utf8')).id); } catch (e) { return null; }
    }
    setLast(g) {
        try { mkdirp(this.o.dataDir); fs.writeFileSync(this.lastFile, JSON.stringify({ id: g.id, title: g.title })); } catch (e) { /* not kept */ }
    }
}

module.exports = { Library, titleOf, mkdirp, openPack, usbFolders };
