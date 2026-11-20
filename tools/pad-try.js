'use strict';
/**
 * A gamepad plugged into this computer, read as the NES game loader reads one on the head unit
 * (loader/pad.js and loader/nes-usbpipe): its buttons as they change, as the pad's own and as the NES pad's.
 *
 *   node tools/pad-try.js [--seconds 60] [--idle 20] [--raw] [--state]
 *                                    --raw: every packet the pad sends, too
 *                                    --state: the whole pad, too, which the NES app does not get: both sticks,
 *                                             the triggers, the sticks pressed in (loader/pad.js, "state")
 *                                    --idle: ends once the buttons, pressed at least once, rest this long
 *
 * tools/emu.js --pad uses the same pad for the emulator's app (forLoader() below).
 *
 * The pad must have no kernel driver, as on the head unit, and nes-usbpipe must be allowed to open it:
 *
 *   Windows  Hand the pad to WSL 2, whose kernel has no driver for it, with usbipd-win
 *            (https://github.com/dorssel/usbipd-win):
 *              usbipd bind --force --hardware-id 045e:02ea    once, as administrator
 *              usbipd attach --wsl --hardware-id 045e:02ea    each time, with WSL running
 *            nes-usbpipe then runs in WSL, as root. An Xbox One S pad needs the --force: without it the pad was
 *            in WSL for half a second each time and gone again. Windows has no use of a pad bound that way,
 *            until "usbipd unbind --hardware-id 045e:02ea" (as administrator) gives it back.
 *   Linux    The kernel's own driver (xpad) has the pad: take it away first, and run this as root:
 *              echo -n '<bus>-<port>:1.0' > /sys/bus/usb/drivers/xpad/unbind
 */
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const pads = require(path.join(ROOT, 'loader', 'pad'));
const { PAD, toNes } = require(path.join(ROOT, 'app', 'pad'));
const { BTN } = require(path.join(ROOT, 'app', 'nes-core'));

const WSL = process.platform === 'win32';
const SYS = '/sys/bus/usb/devices';
const PROGRAM = path.join(ROOT, 'loader', 'nes-usbpipe');

/** WSL's list of USB devices, read in one go, for loader/pad.js to look through as it does the head unit's */
function wslDevices() {
    const script = 'cd ' + SYS + ' 2>/dev/null || exit 0; ' +
        'for f in */bInterfaceClass */bInterfaceSubClass */bInterfaceProtocol */bInterfaceNumber */ep_*/bEndpointAddress */ep_*/bmAttributes */ep_*/wMaxPacketSize ' +
        '*/busnum */devnum */idVendor */idProduct */product; do [ -f "$f" ] && echo "$f=$(cat "$f")"; done; ' +
        'for d in */driver; do [ -e "$d" ] && echo "$d="; done; exit 0';
    const files = {};
    execFileSync('wsl.exe', ['-u', 'root', '-e', 'sh', '-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').forEach((l) => {
        const i = l.indexOf('=');
        if (i > 0) files[l.slice(0, i)] = l.slice(i + 1).trim();
    });
    const rel = (p) => p.slice(SYS.length + 1);
    return {
        list(dir) {
            const under = dir === SYS ? '' : rel(dir) + '/', seen = {};
            Object.keys(files).forEach((f) => { if (f.indexOf(under) === 0) seen[f.slice(under.length).split('/')[0]] = true; });
            return Object.keys(seen);
        },
        read: (file) => (files[rel(file)] !== undefined ? files[rel(file)] : null),
        has: (file) => files[rel(file)] !== undefined,
    };
}

/** the pads of this computer that are free to read, as loader/pad.js finds them on the head unit */
const findHere = () => pads.find(WSL ? { io: wslDevices() } : {});
/** nes-usbpipe, as it is started here: in WSL as root on Windows */
const pipeHere = () => (WSL ? ['wsl.exe', '-u', 'root', '-e', '/mnt/' + PROGRAM[0].toLowerCase() + PROGRAM.slice(2).replace(/\\/g, '/')] : [PROGRAM]);
/** for the loader beside the emulator (tools/loader-dev.js, start({ service })): a real pad in place of none */
const forLoader = () => ({ padFind: () => { try { return findHere(); } catch (e) { return []; } }, padPipe: pipeHere(), padEnv: process.env });

function main() {
    const args = process.argv.slice(2);
    const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : dflt; };
    const SECONDS = Number(opt('--seconds', 60)), IDLE = Number(opt('--idle', 0)), RAW = args.indexOf('--raw') >= 0, STATE = args.indexOf('--state') >= 0;
    const names = (bits, table) => Object.keys(table).filter((k) => bits & table[k]).join(' ') || '-';
    const t0 = Date.now(), stamp = () => ('     ' + ((Date.now() - t0) / 1000).toFixed(2)).slice(-7) + ' s  ';

    let found = [];
    try { found = findHere(); } catch (e) { console.error('pad-try: ' + (WSL ? 'WSL: ' : '') + e.message.split('\n')[0]); process.exit(1); }
    if (!found.length) {
        console.error('pad-try: no gamepad that is free to read' + (WSL ? ' in WSL: hand it over with "usbipd attach --wsl --hardware-id <vendor:product>" (the top of this file says more)'
            : ': plug one in, and take it from the kernel\'s own driver (the top of this file says how)'));
        process.exit(1);
    }
    const dev = found[0], pipe = pipeHere();
    const hex4 = (n) => ('000' + n.toString(16)).slice(-4);
    console.log('pad-try: ' + dev.name + ' (' + hex4(dev.vid) + ':' + hex4(dev.pid) + ') at ' + dev.node + (WSL ? ' in WSL' : '') + ', endpoints ' + dev.epIn.toString(16) + ' in, ' + dev.epOut.toString(16) + ' out, ' + dev.packet + ' bytes');
    console.log('pad-try: press its buttons; ' + SECONDS + ' seconds, or Ctrl-C');

    let changes = 0, changedT = 0, stop = null;
    const told = (b) => { changes++; changedT = Date.now(); console.log(stamp() + 'pad: ' + names(b, PAD) + '    NES: ' + names(toNes(b), BTN)); };
    const done = (why, code) => { console.log('pad-try: ' + why + '; the buttons changed ' + changes + ' time(s)'); process.exit(code); };
    // the whole pad, ten times a second at most: a stick on its way tells a hundred
    let latest = null, shown = null;
    const whole = (s) => { latest = s; changedT = Date.now(); };
    if (STATE) {
        setInterval(() => {
            if (!latest || latest === shown) return;
            shown = latest;
            console.log(stamp() + 'all: ' + names(shown.buttons, pads.PAD_FULL) + '    LT ' + shown.lt + '  RT ' + shown.rt + '    left ' + shown.lx + ' ' + shown.ly + '    right ' + shown.rx + ' ' + shown.ry);
        }, 100);
    }
    setTimeout(() => stop(), SECONDS * 1000);
    if (IDLE > 0) setInterval(() => { if ((changes || shown) && Date.now() - changedT > IDLE * 1000) stop(); }, 500);

    if (!RAW) {
        const reader = pads.open(dev, { pipe, env: process.env, log: (s) => console.log('         ' + s), onButtons: told, onState: STATE ? whole : null, onClose: (why) => done(why, 1) });
        stop = () => { reader.close(); setTimeout(() => done('done', 0), 300); };
        return;
    }
    // every packet, and what loader/pad.js makes of it
    const gip = new pads.Gip(dev);
    const child = spawn(pipe[0], pipe.slice(1).concat([dev.node, String(dev.iface), dev.epIn.toString(16), dev.epOut.toString(16), String(dev.packet)]), { stdio: ['pipe', 'pipe', 'inherit'] });
    const send = (list) => list.forEach((b) => { console.log(stamp() + '-> ' + b.toString('hex')); child.stdin.write(b.toString('hex') + '\n'); });
    let text = '', buttons = 0, packets = 0;
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (s) => {
        text += s;
        for (let nl = text.indexOf('\n'); nl >= 0; nl = text.indexOf('\n')) {
            const line = text.slice(0, nl).trim();
            text = text.slice(nl + 1);
            if (!/^([0-9a-f]{2})+$/.test(line)) continue;
            packets++;
            console.log(stamp() + '<- ' + line);
            const r = gip.packet(Buffer.from(line, 'hex'));
            if (r.send) send(r.send);
            if (r.buttons !== undefined && r.buttons !== buttons) { buttons = r.buttons; told(buttons); }
            if (STATE && r.state) whole(r.state);
        }
    });
    child.on('close', (code, signal) => done((code === 1 ? 'the pad is gone' : 'nes-usbpipe ended (' + (signal || code) + ')') + ', ' + packets + ' packet(s) from the pad', code ? 1 : 0));
    send(gip.start());
    stop = () => { try { child.stdin.end(); } catch (e) { /* gone */ } };
}

module.exports = { findHere, pipeHere, forLoader };
if (require.main === module) main();
