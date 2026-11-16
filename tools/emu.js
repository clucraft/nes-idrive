'use strict';
/**
 * The live emulator on the app (no car, no BMW SDK):
 *
 *   node tools/emu.js [--port 8077] [--no-touch] [--bg screenshot.png] [--no-phone]   ->  http://localhost:8077
 *
 * Runs the kit's emulator (vendor/idrive7-apps kit/tools/emu.js) on app/. A save in app/ rebuilds
 * and restarts the app; games dropped into app/roms/ are packed in by that build.
 *
 * The NES game loader runs beside it (tools/loader-dev.js), so "Add games from a phone" works here too:
 * a phone on the PC's network can scan the code. --no-phone leaves it out.
 */
const path = require('path');
const { spawn } = require('child_process');
const { setup, ROOT, KIT, APP_ID } = require('./setup');

setup();
console.log('emu: app data (saves, settings, games copied over) in ' + path.relative(ROOT, path.join(KIT, 'preview', 'emu', APP_ID)));
const args = process.argv.slice(2).filter((a) => a !== '--no-phone');
let loader = null;
if (args.length === process.argv.length - 2) {
    try {
        loader = require('./loader-dev').start();
        process.env.NES_LOADER_SOCK = loader.socket;         // (the app the emulator starts gets it)
        console.log('emu: the NES game loader runs here too: "Add games from a phone" shows a code for a phone on this network');
    } catch (e) { console.log('emu: the NES game loader did not start (' + e.message + '): "Add games from a phone" will say it is missing'); }
}
const child = spawn(process.execPath, [path.join(KIT, 'kit', 'tools', 'emu.js'), APP_ID].concat(args), { cwd: KIT, stdio: 'inherit' });
const stop = (code) => { try { child.kill(); } catch (e) { /* gone */ } if (loader) loader.stop(); process.exit(code || 0); };
child.on('exit', (code) => stop(code));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
