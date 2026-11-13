'use strict';
/**
 * The MGU Store's "build" of this app on the head unit (mgu-repo.json): there is nothing to build.
 * The package is committed (store/<id>@<version>.tgz, made on a PC by tools/build-store.js), and
 * mgu-repo.json's build "output" names it. This only says so plainly when the package of the listed
 * version is not there. Runs on the head unit's Node 8.
 *
 *   node tools/prebuilt.js <the package's path in the repository>
 */
var fs = require('fs');

var out = process.argv[2];
if (!out || !fs.existsSync(out)) {
    console.error('prebuilt: ' + (out || 'the package') + ' is not in the repository. On a PC, run "npm run build:store" and commit store/');
    process.exit(1);
}
console.log('prebuilt: ' + out + ' (' + fs.statSync(out).size + ' bytes) is committed: nothing to build');
