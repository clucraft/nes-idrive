'use strict';
/**
 * pad.js - a USB gamepad for the NES app.
 *
 * The head unit's kernel has no driver for one (no HID, no evdev, no joystick driver): a pad that is plugged
 * in is listed on the USB bus, and that is all. So its packets are read here, through usbfs: usbpipe, a small
 * program beside this file (src/usbpipe/main.go), hands them over as lines of hex and takes lines of hex for
 * the pad. What the packets mean is known here, where it can be tested without a pad.
 *
 * Pads known: Xbox One and Xbox Series pads on a cable, and other makes' pads that speak their protocol
 * ("GIP": an interface of class ff, subclass 47, protocol d0). The packets that switch such a pad on and the
 * layout of its input report are the Linux kernel's (drivers/input/joystick/xpad.c).
 *
 *   find()             the pads plugged in: [{ kind, node, iface, epIn, epOut, packet, vid, pid, name }]
 *   open(dev, opts)    reads one: opts.onButtons(bits) whenever they change, opts.onClose(why, unplugged) when
 *                      it ends by itself; -> { close() }
 *   PAD                the bits: UP DOWN LEFT RIGHT A B X Y START SELECT L R, as the Xbox pad names its buttons
 *                      (START its Menu button, SELECT its View button; the left stick counts as the D-pad too)
 *
 * Part of the NES game loader (nes-idrive, GPL-2.0-or-later). Runs on the head unit's Node 8.
 */
const fs = require('fs');
const { spawn } = require('child_process');

const SYS_USB = '/sys/bus/usb/devices';
const DEV_USB = '/dev/bus/usb';
/** (app/pad.js has the same: this is what goes over the loader's socket) */
const PAD = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8, A: 0x10, B: 0x20, X: 0x40, Y: 0x80, START: 0x100, SELECT: 0x200, L: 0x400, R: 0x800 };
const STICK = 16000;                // of 32767: the left stick this far out is a direction
const REANNOUNCE_MS = 1000;         // a pad that says hello again after this was not switched on: once more

/* ---------- the Xbox pads' protocol ---------- */
const GIP = { ACK: 0x01, ANNOUNCE: 0x02, KEY: 0x07, INPUT: 0x20, OPT_ACK: 0x10, OPT_INTERNAL: 0x20 };
const HORI_ACK = [0x01, 0x20, 0x00, 0x09, 0x00, 0x04, 0x20, 0x3a, 0x00, 0x00, 0x00, 0x80, 0x00];
const RUMBLE_ON = [0x09, 0x00, 0x00, 0x09, 0x00, 0x0f, 0x00, 0x00, 0x1d, 0x1d, 0xff, 0x00, 0x00];
const RUMBLE_OFF = [0x09, 0x00, 0x00, 0x09, 0x00, 0x0f, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
/**
 * What switches a pad on: [vendor, product, packet], in the kernel's order (xpad.c, xboxone_init_packets);
 * vendor and product 0 is every pad. Byte 2 of each is a count, filled in when it is sent.
 */
const GIP_INIT = [
    [0x0e6f, 0x0165, HORI_ACK],
    [0x0f0d, 0x0067, HORI_ACK],
    [0, 0, [0x05, 0x20, 0x00, 0x01, 0x00]],                       // power on
    [0x045e, 0x02ea, [0x05, 0x20, 0x00, 0x0f, 0x06]],             // Xbox One S: it may have been on Bluetooth last
    [0x045e, 0x0b00, [0x05, 0x20, 0x00, 0x0f, 0x06]],
    [0x045e, 0x0b00, [0x4d, 0x10, 0x01, 0x02, 0x07, 0x00]],
    [0, 0, [0x0a, 0x20, 0x00, 0x03, 0x00, 0x01, 0x14]],           // its light on: some pads report nothing before
    [0, 0, [0x06, 0x20, 0x00, 0x02, 0x01, 0x00]],                 // "authenticated": the same
    [0x24c6, 0x541a, RUMBLE_ON], [0x24c6, 0x542a, RUMBLE_ON], [0x24c6, 0x543a, RUMBLE_ON],
    [0x24c6, 0x541a, RUMBLE_OFF], [0x24c6, 0x542a, RUMBLE_OFF], [0x24c6, 0x543a, RUMBLE_OFF],
];

class Gip {
    /** dev: { vid, pid }; now(): milliseconds (a test's clock) */
    constructor(dev, now) {
        this.vid = (dev && dev.vid) | 0; this.pid = (dev && dev.pid) | 0;
        this.now = now || Date.now;
        this.count = 0;
        this.startT = -1e9;
    }

    /** the packets that switch the pad on */
    start() {
        this.startT = this.now();
        return GIP_INIT.filter((p) => (!p[0] || p[0] === this.vid) && (!p[1] || p[1] === this.pid)).map((p) => {
            const b = Buffer.from(p[2]);
            b[2] = this.count++ & 0xff;
            return b;
        });
    }

    /** one packet from the pad -> { buttons } when it tells them, { send: [packets] } when it wants an answer */
    packet(d) {
        if (!d || d.length < 4) return {};
        if (d[0] === GIP.INPUT) {
            if (d.length < 6) return {};
            let b = 0;
            if (d[4] & 0x04) b |= PAD.START;
            if (d[4] & 0x08) b |= PAD.SELECT;
            if (d[4] & 0x10) b |= PAD.A;
            if (d[4] & 0x20) b |= PAD.B;
            if (d[4] & 0x40) b |= PAD.X;
            if (d[4] & 0x80) b |= PAD.Y;
            if (d[5] & 0x01) b |= PAD.UP;
            if (d[5] & 0x02) b |= PAD.DOWN;
            if (d[5] & 0x04) b |= PAD.LEFT;
            if (d[5] & 0x08) b |= PAD.RIGHT;
            if (d[5] & 0x10) b |= PAD.L;
            if (d[5] & 0x20) b |= PAD.R;
            if (d.length >= 14) {                                 // the left stick: up is the greater number
                const x = d.readInt16LE(10), y = d.readInt16LE(12);
                if (x > STICK) b |= PAD.RIGHT; else if (x < -STICK) b |= PAD.LEFT;
                if (y > STICK) b |= PAD.UP; else if (y < -STICK) b |= PAD.DOWN;
            }
            return { buttons: b };
        }
        if (d[0] === GIP.KEY) {
            // the Xbox button: an Xbox One S pad sends its report again and again until it is acknowledged
            if (d[1] !== (GIP.OPT_ACK | GIP.OPT_INTERNAL)) return {};
            return { send: [Buffer.from([GIP.ACK, GIP.OPT_INTERNAL, d[2], 0x09, 0x00, GIP.KEY, GIP.OPT_INTERNAL, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00])] };
        }
        // hello: at the start every pad says it (it is being switched on already); later, a pad that started anew
        if (d[0] === GIP.ANNOUNCE && this.now() - this.startT > REANNOUNCE_MS) return { buttons: 0, send: this.start() };
        return {};
    }
}

/* ---------- the pads that are plugged in ---------- */
const disk = {
    list(dir) { try { return fs.readdirSync(dir); } catch (e) { return []; } },
    read(file) { try { return fs.readFileSync(file, 'utf8').trim(); } catch (e) { return null; } },
    has(file) { try { fs.lstatSync(file); return true; } catch (e) { return false; } },
};

/**
 * The pads on the USB bus, as sysfs lists them. opts: { sys, dev: the two folders, io: { list, read, has } in
 * place of the disk (a test) }. A pad a kernel driver has is left to that driver (a PC; never the head unit).
 */
function find(opts) {
    const o = opts || {}, sys = o.sys || SYS_USB, nodes = o.dev || DEV_USB, io = o.io || disk, out = [];
    const three = (n) => ('00' + n).slice(-3);
    io.list(sys).filter((n) => /^\d+-\d+(\.\d+)*:\d+\.\d+$/.test(n)).sort().forEach((n) => {
        const dir = sys + '/' + n, hex = (file) => { const v = io.read(file); return v === null ? NaN : parseInt(v, 16); };
        if (hex(dir + '/bInterfaceClass') !== 0xff || hex(dir + '/bInterfaceSubClass') !== 0x47 || hex(dir + '/bInterfaceProtocol') !== 0xd0) return;
        if (hex(dir + '/bInterfaceNumber') !== 0) return;         // (the buttons; a pad's other interfaces are a headset's)
        if (io.has(dir + '/driver')) return;
        let epIn = null, epOut = null;
        io.list(dir).filter((e) => /^ep_[0-9a-f]{2}$/.test(e)).sort().forEach((e) => {
            const addr = hex(dir + '/' + e + '/bEndpointAddress'), attr = hex(dir + '/' + e + '/bmAttributes');
            if (!(addr > 0) || (attr & 3) !== 3) return;          // interrupt endpoints
            const size = hex(dir + '/' + e + '/wMaxPacketSize') & 0x7ff;
            if (addr & 0x80) { if (!epIn) epIn = { addr, size }; } else if (!epOut) epOut = { addr, size };
        });
        if (!epIn || !epOut) return;
        const usb = sys + '/' + n.split(':')[0];
        const bus = parseInt(io.read(usb + '/busnum'), 10), num = parseInt(io.read(usb + '/devnum'), 10);
        if (!(bus > 0 && bus < 1000 && num > 0 && num < 1000)) return;
        out.push({
            kind: 'gip', node: nodes + '/' + three(bus) + '/' + three(num), iface: 0, epIn: epIn.addr, epOut: epOut.addr,
            packet: Math.min(1024, Math.max(8, epIn.size || 64)), vid: hex(usb + '/idVendor') || 0, pid: hex(usb + '/idProduct') || 0,
            name: String(io.read(usb + '/product') || '').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 40) || 'Gamepad',
        });
    });
    return out;
}

/* ---------- reading one ---------- */
/**
 * opts: { pipe: [the usbpipe program, arguments before its own...], as: { uid, gid } to run it as, env,
 *         onButtons(bits), onClose(why), log(line) }
 */
function open(dev, opts) {
    const o = opts || {}, log = o.log || (() => {}), gip = new Gip(dev);
    const args = o.pipe.slice(1).concat([dev.node, String(dev.iface), dev.epIn.toString(16), dev.epOut.toString(16), String(dev.packet)]);
    let child = null, buttons = 0, text = '', errText = '', lastErr = '', over = false, said = 0;
    const end = (why, unplugged) => { if (over) return; over = true; if (o.onClose) o.onClose(why, !!unplugged); };
    try {
        child = spawn(o.pipe[0], args, Object.assign({ cwd: '/', env: o.env || { PATH: process.env.PATH || '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] }, o.as || {}));
    } catch (e) {
        setImmediate(() => end('its helper did not start: ' + (e.code || e.message)));
        return { close() { over = true; } };
    }
    const send = (packets) => packets.forEach((b) => { try { child.stdin.write(b.toString('hex') + '\n'); } catch (e) { /* it is going */ } });
    const stop = () => {
        try { child.stdin.end(); } catch (e) { /* gone */ }
        const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } }, 1000);
        child.on('exit', () => clearTimeout(t));
    };
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (s) => {
        if (over) return;
        text += s;
        for (let nl = text.indexOf('\n'); nl >= 0; nl = text.indexOf('\n')) {
            const line = text.slice(0, nl).trim();
            text = text.slice(nl + 1);
            if (!/^([0-9a-f]{2}){1,1024}$/.test(line)) continue;
            const r = gip.packet(Buffer.from(line, 'hex'));
            if (r.send) send(r.send);
            if (r.buttons !== undefined && r.buttons !== buttons) { buttons = r.buttons; if (o.onButtons) o.onButtons(buttons); }
        }
        if (text.length > 4096) { stop(); end('its helper sent no packets but ' + text.length + ' characters'); }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (s) => {
        errText = (errText + s).slice(-2048);
        for (let nl = errText.indexOf('\n'); nl >= 0; nl = errText.indexOf('\n')) {
            lastErr = errText.slice(0, nl).replace(/[^\x20-\x7e]/g, ' ').trim().slice(0, 200);
            errText = errText.slice(nl + 1);
            if (lastErr && said++ < 10) log(lastErr);
        }
    });
    child.on('error', (e) => end('its helper did not start: ' + (e.code || e.message)));
    // (when all it wrote is read: usbpipe ends with 1 when the pad is gone, and says on stderr what else ended it)
    child.on('close', (code, signal) => end(code === 1 ? 'unplugged' : 'its helper ended (' + (signal || code) + ')' + (lastErr ? ': ' + lastErr : ''), code === 1));
    send(gip.start());
    return { close() { if (over) return; over = true; stop(); } };
}

module.exports = { PAD, STICK, Gip, find, open };
