'use strict';
/**
 * The package the MGU Store installs (https://github.com/robertnisipeanu/mgu-store), with what
 * mgu-repo.json lists it by:
 *
 *   store/<id>@<version>.tgz   the app as the kit builds it, without an SDK and without games
 *   store/app.json             its id, version, title and description (from app/app.json)
 *   store/icon.png             its icon in the Store (app/icon.png)
 *
 *   node tools/build-store.js        (npm run build:store)
 *
 * Run it after a change to app/ (with a new version in app/app.json), then commit store/: the Store
 * installs exactly that file. test/run.js fails while store/ is not what app/ would give.
 *
 * No BMW SDK is published: the kit's build puts one in node_modules/oap-sdk (the emulator's
 * placeholder, or BMW's from your head unit), and it is left out here whichever it is. The head unit
 * generates the module from a BMW app already on it when it installs the package. Games in
 * app/roms/ are left out too.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { pack } = require('./tar');
const { setup, ROOT, KIT, APP_ID } = require('./setup');

const STORE = path.join(ROOT, 'store');
const LICENSE = 'GPL-2.0-or-later';
/** the head units the app is for: mgu-repo.json says so for the Store's list, the package for itself */
const HMI = JSON.parse(fs.readFileSync(path.join(ROOT, 'mgu-repo.json'), 'utf8')).components[0].mguHmi;
/** what of the kit's staged package is never published */
const LEFT_OUT = (rel) => rel.split('/').indexOf('node_modules') >= 0 || rel === 'javascript/roms.pack' || /\.nes$/i.test(rel);

function walk(dir, base, out) {
    fs.readdirSync(dir).sort().forEach((name) => {
        const p = path.join(dir, name), rel = base ? base + '/' + name : name;
        if (fs.statSync(p).isDirectory()) walk(p, rel, out); else out.push(rel);
    });
    return out;
}

function build() {
    setup();
    const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'app', 'app.json'), 'utf8'));
    const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    execFileSync(python, [path.join(KIT, 'kit', 'tools', 'build.py'), APP_ID], { cwd: KIT, stdio: 'inherit' });
    const src = path.join(KIT, 'dist', APP_ID, 'source');
    const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
    if (pkg.name !== APP_ID || pkg.version !== spec.version) throw new Error('the kit built ' + pkg.name + '@' + pkg.version + ', not ' + APP_ID + '@' + spec.version);
    const all = walk(src, '', []), files = all.filter((f) => !LEFT_OUT(f));
    if (files.indexOf('javascript/app.js') < 0 || files.indexOf('rhmiData/application.json') < 0) throw new Error('the kit\'s package in ' + src + ' is not complete');
    // the package says itself what it is for and under which licence (the kit writes "UNLICENSED" and no head unit)
    const meta = Object.assign({}, pkg, { license: LICENSE, mguHmi: HMI });
    const tgz = pack(files.map((f) => ({
        name: 'package/' + f,
        data: f === 'package.json' ? Buffer.from(JSON.stringify(meta, null, 2) + '\n') : fs.readFileSync(path.join(src, f)),
    })));

    fs.mkdirSync(STORE, { recursive: true });
    const name = APP_ID + '@' + spec.version + '.tgz';
    fs.readdirSync(STORE).filter((f) => /\.tgz$/.test(f) && f !== name).forEach((f) => fs.unlinkSync(path.join(STORE, f)));
    fs.writeFileSync(path.join(STORE, name), tgz);
    fs.writeFileSync(path.join(STORE, 'app.json'), JSON.stringify({ id: APP_ID, version: spec.version, title: spec.title, description: spec.description }, null, 2) + '\n');
    fs.copyFileSync(path.join(ROOT, 'app', 'icon.png'), path.join(STORE, 'icon.png'));

    const games = all.indexOf('javascript/roms.pack') >= 0 && fs.readdirSync(path.join(ROOT, 'app', 'roms')).filter((f) => /\.nes$/i.test(f)).length;
    console.log('build-store: store/' + name + ' (' + files.length + ' files, ' + Math.round(tgz.length / 1024) + ' KiB, sha256 ' +
        crypto.createHash('sha256').update(tgz).digest('hex').slice(0, 16) + '...)');
    console.log('build-store: no SDK in it' + (games ? '; the ' + games + ' game(s) in app/roms/ are left out' : '') + '. Commit store/ to publish it.');
}

if (require.main === module) {
    try { build(); } catch (e) { console.error('build-store: ' + e.message); process.exit(1); }
}
module.exports = { LEFT_OUT };
