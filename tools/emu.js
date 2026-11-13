'use strict';
/**
 * The live emulator on the app (no car, no BMW SDK):
 *
 *   node tools/emu.js [--port 8077] [--no-touch] [--bg screenshot.png]   ->  http://localhost:8077
 *
 * Runs the kit's emulator (vendor/idrive7-apps kit/tools/emu.js) on app/. A save in app/ rebuilds
 * and restarts the app; games dropped into app/roms/ are packed in by that build.
 */
const path = require('path');
const { spawn } = require('child_process');
const { setup, ROOT, KIT, APP_ID } = require('./setup');

setup();
console.log('emu: app data (saves, settings, games copied over) in ' + path.relative(ROOT, path.join(KIT, 'preview', 'emu', APP_ID)));
const child = spawn(process.execPath, [path.join(KIT, 'kit', 'tools', 'emu.js'), APP_ID].concat(process.argv.slice(2)), { cwd: KIT, stdio: 'inherit' });
const stop = (code) => { try { child.kill(); } catch (e) { /* gone */ } process.exit(code || 0); };
child.on('exit', (code) => process.exit(code || 0));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
