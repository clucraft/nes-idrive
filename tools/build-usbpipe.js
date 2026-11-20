'use strict';
/**
 * Builds loader/nes-usbpipe, the program of the NES game loader that reads a USB gamepad's packets
 * (loader/src/nes-usbpipe/main.go; loader/pad.js says what it is for):
 *
 *   node tools/build-usbpipe.js        (npm run build:usbpipe)
 *
 * It needs Go (https://go.dev), 1.21 or later, and nothing else, on any computer: the result is a
 * Linux program for the head unit's processor (x86-64) with no library it depends on. The file is
 * committed, as app/nes.wasm is: the MGU Store installs the loader as it is in the repository. Run
 * this after a change to main.go and commit loader/nes-usbpipe with it.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'loader', 'src', 'nes-usbpipe');
const OUT = path.join(ROOT, 'loader', 'nes-usbpipe');

try {
    const env = Object.assign({}, process.env, { GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0', GOFLAGS: '-buildvcs=false' });
    execFileSync('go', ['vet', '.'], { cwd: SRC, env, stdio: 'inherit' });
    // (no paths of this computer and no build id in it: the same source and Go give the same file)
    execFileSync('go', ['build', '-trimpath', '-ldflags', '-s -w -buildid=', '-o', OUT, '.'], { cwd: SRC, env, stdio: 'inherit' });
    const file = fs.readFileSync(OUT);
    console.log('build-usbpipe: loader/nes-usbpipe (' + Math.round(file.length / 1024) + ' KiB, sha256 ' + crypto.createHash('sha256').update(file).digest('hex').slice(0, 16) + '...). Commit it with its source.');
} catch (e) {
    console.error('build-usbpipe: ' + (e.code === 'ENOENT' ? 'Go is not installed (https://go.dev)' : e.message));
    process.exit(1);
}
