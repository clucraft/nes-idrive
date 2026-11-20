'use strict';
/**
 * games.js - what the loader takes and where it puts it: NES games, into the NES app's own games folder.
 *
 * The folder is found here, by the app's name, never taken from a request: <oap>/oap_<uid>/data/roms, where
 * oap_<uid> is the folder whose source/package.json names the app. Each app on the head unit runs as its own
 * user, and <uid> is that user's number.
 *
 * As read on a car (2026-11-20, the NES app as user 12244, the MGU Store that installed it as 12201):
 *   drwxrwx---  8000:903     /var/opt/public/oap     (903 is a group the head unit gives its apps' processes)
 *   drwxr-x---  12201:12244  oap_12244
 *   drwxrwx---  12201:12244  oap_12244/data
 *   drwxrwx---  12244:12244  oap_12244/data/roms     (made by the app)
 * So the folder's owner is not the app's user, and the app's user alone, without that group, does not get as
 * far as its own folder: whoever saves games as that user is started inside `data` (service.js does that).
 *
 * A game is a file that starts as an iNES file does, with a name made safe to create. Part of the NES game
 * loader (nes-idrive, GPL-2.0-or-later). Runs on the head unit's Node 8.
 */
const fs = require('fs');
const path = require('path');

const APP = 'clucraft_nes';
const OAP_DIR = '/var/opt/public/oap';
const GAMES = 'roms';               // the games folder, in the app's data folder
const MAX_GAME = 8 << 20;           // the app reads no bigger file
const MAX_FOLDER = 64 << 20;        // all of them together: the app's share of the disk is 100 MB
const MAX_GAMES = 1000;
const IS_GAME = /\.nes$/i;

/**
 * Where the app `name` lives: { root, data, games, uid, gid }, or null while it is not installed. uid is the
 * app's own user, the number in its folder's name; gid the folder's group, which is the app's.
 */
function findApp(oapDir, name) {
    const dir = oapDir || OAP_DIR;
    let entries = [];
    try { entries = fs.readdirSync(dir).filter((d) => /^oap_\d+$/.test(d)); } catch (e) { return null; }
    for (let i = 0; i < entries.length; i++) {
        const root = path.join(dir, entries[i]);
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(root, 'source', 'package.json'), 'utf8'));
            if (!pkg || pkg.name !== (name || APP)) continue;
            const st = fs.statSync(root), data = path.join(root, 'data');
            return { root, data, games: path.join(data, GAMES), uid: Number(entries[i].slice(4)), gid: st.gid };
        } catch (e) { /* not an app's folder, or not ours to read */ }
    }
    return null;
}

/** the name a file sent as `raw` gets in the games folder, or null when it cannot be a game's */
function safeName(raw) {
    let name = String(raw == null ? '' : raw).replace(/\\/g, '/').split('/').pop();
    name = name.replace(/[^A-Za-z0-9 ._()[\]!&'+,-]/g, '_').replace(/\s+/g, ' ').trim();
    if (!IS_GAME.test(name)) return null;
    let base = name.slice(0, -4).replace(/^[ .]+/, '').replace(/[ .]+$/, '');
    if (!/[A-Za-z0-9]/.test(base)) return null;
    if (base.length > 76) base = base.slice(0, 76).replace(/[ .]+$/, '');
    return base + '.nes';
}

/** why `data` is no NES game, or null when it is one */
function refuse(data) {
    if (!data || data.length < 16 + 8192) return 'too small to be an NES game';
    if (data.length > MAX_GAME) return 'bigger than ' + (MAX_GAME >> 20) + ' MB';
    if (data[0] !== 0x4e || data[1] !== 0x45 || data[2] !== 0x53 || data[3] !== 0x1a) return 'not an NES game (a .nes file in iNES format)';
    return null;
}

/** the games in the folder: [{ name, size }] by name. None while there is no folder; throws when it cannot be read. */
function list(dir) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const out = [];
    names.filter((n) => IS_GAME.test(n) && n[0] !== '.').forEach((n) => {
        try { const st = fs.lstatSync(path.join(dir, n)); if (st.isFile()) out.push({ name: n, size: st.size }); } catch (e) { /* gone */ }
    });
    return out.sort((a, b) => (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0));
}

/** why this process cannot keep games in the folder (an error's code), or null when it can */
function unusable(dir) {
    try {
        let there = true;
        try { fs.readdirSync(dir); } catch (e) { if (e.code !== 'ENOENT') throw e; there = false; }
        fs.accessSync(there ? dir : path.dirname(dir), fs.constants.W_OK | fs.constants.X_OK);   // (no folder yet: save() makes it)
        return null;
    } catch (e) { return e.code || e.message; }
}

/** an error whose message is for the person at the phone */
function refused(message) { const e = new Error(message); e.refused = true; return e; }

/**
 * Puts a game into the folder: { name, size, replaced }. Throws (refused: true) when it is no game, or the
 * folder is full. The file is written beside its place first and then renamed, so the app never reads half of one.
 */
function save(dir, rawName, data) {
    const name = safeName(rawName);
    if (!name) throw refused('not a .nes file');
    const why = refuse(data);
    if (why) throw refused(why);
    try { fs.mkdirSync(dir); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const have = list(dir), same = have.filter((g) => g.name.toLowerCase() === name.toLowerCase());
    const others = have.filter((g) => g.name.toLowerCase() !== name.toLowerCase());
    if (others.length >= MAX_GAMES) throw refused('there are ' + MAX_GAMES + ' games already');
    if (others.reduce((n, g) => n + g.size, 0) + data.length > MAX_FOLDER) throw refused('no room: the games folder holds ' + (MAX_FOLDER >> 20) + ' MB at most');
    const tmp = path.join(dir, '.' + name + '.' + process.pid + '.part');
    const fd = fs.openSync(tmp, 'wx', 0o644);          // (never through a link someone left there)
    try {
        fs.writeSync(fd, data, 0, data.length, 0);
        fs.fsyncSync(fd);
    } catch (e) {
        try { fs.closeSync(fd); fs.unlinkSync(tmp); } catch (e2) { /* nothing to clear */ }
        throw e;
    }
    fs.closeSync(fd);
    // one file a name, whatever its letters' case (the app takes them as the same game)
    same.filter((g) => g.name !== name).forEach((g) => { try { fs.unlinkSync(path.join(dir, g.name)); } catch (e) { /* gone */ } });
    fs.renameSync(tmp, path.join(dir, name));
    return { name, size: data.length, replaced: same.length > 0 };
}

/** takes a game out of the folder; false when there is none of that name */
function remove(dir, rawName) {
    const name = safeName(rawName);
    if (!name) return false;
    const hit = list(dir).filter((g) => g.name.toLowerCase() === name.toLowerCase());
    hit.forEach((g) => fs.unlinkSync(path.join(dir, g.name)));
    return hit.length > 0;
}

/** files a save that was cut short left behind */
function sweep(dir) {
    try { fs.readdirSync(dir).filter((n) => /^\..*\.part$/.test(n)).forEach((n) => { try { fs.unlinkSync(path.join(dir, n)); } catch (e) { /* gone */ } }); } catch (e) { /* no folder yet */ }
}

module.exports = { APP, OAP_DIR, GAMES, MAX_GAME, MAX_FOLDER, MAX_GAMES, findApp, safeName, refuse, list, unusable, save, remove, sweep };
