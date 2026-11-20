'use strict';
// The MGU Store's check after an install: the service answers on its socket (exit 0), within ten tries.
const net = require('net');
const socket = process.argv[2] || process.env.NES_LOADER_SOCK || '/run/clucraft-nes-loader.sock';
let tries = 0;
function again(why) {
    if (++tries >= 10) { console.error('clucraft-nes-loader: no answer on ' + socket + ': ' + why); process.exit(1); }
    setTimeout(ask, 1000);
}
function ask() {
    const c = net.connect(socket);
    let text = '', done = false;
    const end = (why) => { if (done) return; done = true; clearTimeout(timer); c.destroy(); if (why) again(why); };
    const timer = setTimeout(() => end('it took too long'), 3000);
    c.on('connect', () => c.write('{"cmd":"status"}\n'));
    c.on('error', (e) => end(e.code || e.message));
    c.on('data', (d) => {
        text += d;
        const nl = text.indexOf('\n');
        if (nl < 0) return;
        let answer = null;
        try { answer = JSON.parse(text.slice(0, nl)); } catch (e) { /* not ours */ }
        if (!answer || !answer.ok) return end('an answer that is not the loader\'s');
        end(null);
        console.log('clucraft-nes-loader ' + answer.version + ' answers');
        process.exit(0);
    });
}
ask();
