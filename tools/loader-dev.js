'use strict';
/**
 * The NES game loader (loader/) on a PC, for the emulator: "Add games from a phone" then works there as on
 * the car, and a phone on the PC's network can scan the code and send games to the emulator's app.
 *
 * tools/emu.js starts it (npm run emu; --no-phone leaves it out). Here the loader runs as you, changes no
 * firewall, and serves on the PC's own addresses while the app's screen is up; the games go into the
 * emulator's data folder (vendor/idrive7-apps/preview/emu/<app>/roms). The PC's own firewall may ask
 * whether Node.js may be reached: the phone needs that.
 *
 * start() -> { socket: what the app connects to (NES_LOADER_SOCK), stop() }
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT, KIT, APP_ID } = require('./setup');

function start(opts) {
    const log = (opts && opts.log) || ((s) => console.log('loader: ' + s));
    const tag = 'clucraft-nes-loader-' + process.pid;
    // (Windows has pipes of this kind of name where other systems have socket files)
    const socket = process.platform === 'win32' ? '\\\\.\\pipe\\' + tag : path.join(os.tmpdir(), tag + '.sock');
    // the loader looks for the app as on the head unit: <oap>/oap_<n>/source/package.json, games in data/roms
    const data = path.join(KIT, 'preview', 'emu', APP_ID);
    const oap = path.join(os.tmpdir(), tag + '-oap'), app = path.join(oap, 'oap_1'), link = path.join(app, 'data');
    data.split(path.sep).reduce((dir, part) => { const next = dir ? dir + path.sep + part : part || path.sep; if (!fs.existsSync(next)) fs.mkdirSync(next); return next; }, '');
    [oap, app, path.join(app, 'source')].forEach((d) => { if (!fs.existsSync(d)) fs.mkdirSync(d); });
    fs.writeFileSync(path.join(app, 'source', 'package.json'), JSON.stringify({ name: APP_ID }) + '\n');
    if (!fs.existsSync(link)) fs.symlinkSync(data, link, 'junction');
    if (process.platform !== 'win32') { try { fs.unlinkSync(socket); } catch (e) { /* none */ } }
    const { createService } = require(path.join(ROOT, 'loader', 'service'));
    const service = createService({ listen: socket, oapDir: oap, interfaces: ['*'], nft: null, asSelf: true, exit: false, idleMs: 1e12, log });
    const stop = () => {
        try { service.stop(0); } catch (e) { /* stopped */ }
        // the link first, as a link: never what it points to
        try { if (process.platform === 'win32') fs.rmdirSync(link); else fs.unlinkSync(link); } catch (e) { /* gone */ }
        try { fs.unlinkSync(path.join(app, 'source', 'package.json')); fs.rmdirSync(path.join(app, 'source')); fs.rmdirSync(app); fs.rmdirSync(oap); } catch (e) { /* left in the temporary folder */ }
        if (process.platform !== 'win32') { try { fs.unlinkSync(socket); } catch (e) { /* gone */ } }
    };
    return { socket, stop };
}

module.exports = { start };
