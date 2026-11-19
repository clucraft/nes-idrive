'use strict';
// A stand-in for loader/usbpipe, for test/run.js: a USB gamepad that is switched on by what the loader sends
// it, and then presses buttons.
//
//   node fake-usbpipe.js <log file> <what the pad does> <device node> <interface> <IN> <OUT> <packet bytes>
//
// What the pad does, once it is switched on, separated by commas: a packet in hex is sent, "ms<n>" waits that
// long, "pulled" waits for the test to pull the pad out (a file <log file>.pull) and ends as usbpipe does then
// (exit 1). The log gets "args ..." at the start, every packet for the pad as "out <hex>", "gone" when it is
// pulled out, and "end" when stdin ends (the loader lets go of the pad).
const fs = require('fs');
const logFile = process.argv[2], steps = process.argv[3].split(',');
const note = (s) => fs.appendFileSync(logFile, s + '\n');
note('args ' + process.argv.slice(4).join(' '));

function next() {
    const s = steps.shift();
    if (s === undefined) return;
    if (s === 'pulled') {
        if (fs.existsSync(logFile + '.pull')) { note('gone'); process.exit(1); }
        steps.unshift(s);
        setTimeout(next, 20);
        return;
    }
    const wait = /^ms(\d+)$/.exec(s);
    if (wait) { setTimeout(next, Number(wait[1])); return; }
    process.stdout.write(s + '\n');
    setTimeout(next, 15);
}

let text = '', on = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
    text += d;
    for (let nl = text.indexOf('\n'); nl >= 0; nl = text.indexOf('\n')) {
        const line = text.slice(0, nl);
        text = text.slice(nl + 1);
        note('out ' + line);
        // "authenticated" is the last of the packets that switch an Xbox pad on (loader/pad.js, GIP_INIT)
        if (!on && /^0620/.test(line)) { on = true; setTimeout(next, 10); }
    }
});
process.stdin.on('end', () => { note('end'); process.exit(0); });
