'use strict';
// A stand-in for loader/nes-sound, for test/run.js: a program that "plays" what it is sent.
//
//   node fake-sound.js <log file> <device> <rate>
//
// The log gets "args <device> <rate>" at the start and "end" when its input ends (the loader's way to stop it);
// what it was sent is in <log file>.pcm. It says it is open at once, that it waits (nothing connected to the
// speakers) with the first sound, and that it plays once more than 4000 bytes came.
const fs = require('fs');
const logFile = process.argv[2];
const note = (s) => fs.appendFileSync(logFile, s + '\n');
const tell = (o) => process.stdout.write(JSON.stringify(o) + '\n');
note('args ' + process.argv.slice(3).join(' '));
tell({ ev: 'open', device: process.argv[3] });
let got = 0, said = null;
process.stdin.on('data', (d) => {
    fs.appendFileSync(logFile + '.pcm', d);
    got += d.length;
    const now = got > 4000 ? 'playing' : 'waiting';
    if (now !== said) { said = now; tell({ ev: now }); }
});
process.stdin.on('end', () => { note('end'); process.exit(0); });
