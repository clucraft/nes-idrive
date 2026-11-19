'use strict';
/**
 * pad.js - the app's side of a USB gamepad.
 *
 * The app cannot read one itself: the head unit's kernel has no gamepad driver, and its USB devices are not
 * an app's to open. The NES game loader (loader/ in the repository; "NES game loader" in the MGU Store) reads
 * the pad and tells its buttons over the socket the app also asks for "Add games from a phone" on
 * (loader/service.js, loader/pad.js). This is the asking, and the pad's buttons as the NES pad's.
 *
 *   const pad = new Pad({ socket, log, onMask });
 *   pad.start();         a game runs: ask for a pad's buttons, and keep asking while it does
 *   pad.stop();          it stopped: the loader lets go of the pad
 *   onMask(mask)         the NES pad's buttons the gamepad holds now (BTN masks; 0 when it lets go or is gone)
 *   pad.name             the pad's name while one is plugged in, else null
 *
 * Xbox pad -> NES pad: D-pad and left stick the D-pad, A and B the A, X and Y the B, Menu the Start, View
 * the Select.
 */
const net = require('net');
const { BTN } = require('./nes-core');

const SOCKET = '/run/clucraft-nes-loader.sock';
const RETRY_MS = 5000;
/** a pad's buttons as the loader tells them (loader/pad.js has the same) */
const PAD = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8, A: 0x10, B: 0x20, X: 0x40, Y: 0x80, START: 0x100, SELECT: 0x200, L: 0x400, R: 0x800 };

/** the gamepad's buttons -> the NES pad's */
function toNes(b) {
    let m = 0;
    if (b & PAD.UP) m |= BTN.UP;
    if (b & PAD.DOWN) m |= BTN.DOWN;
    if (b & PAD.LEFT) m |= BTN.LEFT;
    if (b & PAD.RIGHT) m |= BTN.RIGHT;
    if (b & (PAD.A | PAD.B)) m |= BTN.A;
    if (b & (PAD.X | PAD.Y)) m |= BTN.B;
    if (b & PAD.START) m |= BTN.START;
    if (b & PAD.SELECT) m |= BTN.SELECT;
    return m;
}

class Pad {
    constructor(opts) {
        this.o = opts || {};
        this.log = this.o.log || console;
        this.socket = this.o.socket || SOCKET;
        this.wanted = false;
        this.conn = null;
        this.retry = null;
        this.mask = 0;
        this.name = null;
        this.given = false;             // the loader has no gamepads (an older one), or cannot read this one: not asked again
        this.said = '';
    }

    _say(s) { if (s !== this.said) { this.said = s; this.log.info('gamepad: ' + s); } }

    _mask(m) {
        if (m === this.mask) return;
        this.mask = m;
        if (this.o.onMask) { try { this.o.onMask(m); } catch (e) { this.log.error('gamepad: onMask', e); } }
    }

    start() {
        if (this.wanted) return;
        this.wanted = true;
        this.given = false;
        this._connect();
    }

    stop() {
        if (!this.wanted) return;
        this.wanted = false;
        clearTimeout(this.retry);
        const c = this.conn;
        this.conn = null;
        if (c) c.destroy();
        this.name = null;
        this._mask(0);
    }

    _again() {
        clearTimeout(this.retry);
        if (this.wanted && !this.given) this.retry = setTimeout(() => this._connect(), RETRY_MS);
    }

    _connect() {
        if (!this.wanted || this.conn || this.given) return;
        let c;
        try { c = net.connect(this.socket); } catch (e) { return this._again(); }
        this.conn = c;
        let text = '';
        c.setEncoding('utf8');
        c.on('connect', () => c.write('{"cmd":"pad"}\n'));
        c.on('data', (d) => {
            if (this.conn !== c) return;
            text += d;
            if (text.length > 65536) { c.destroy(); return; }
            for (let nl = text.indexOf('\n'); nl >= 0; nl = text.indexOf('\n')) {
                const line = text.slice(0, nl);
                text = text.slice(nl + 1);
                let m = null;
                try { m = JSON.parse(line); } catch (e) { continue; }
                if (!m) continue;
                const p = m.pad;
                // a loader from before it read gamepads says "unknown"; one that cannot read this pad says why
                if (m.ok === false || (p && p.error)) {
                    const why = String((p && p.error) || m.error || 'the NES game loader refused');
                    this._say(/^unknown/.test(why) ? 'this NES game loader reads no gamepads yet: update it in the MGU Store' : why);
                    this.given = true;
                    this.name = null;
                    this._mask(0);
                    c.destroy();
                    return;
                }
                if (!p || !p.on) continue;
                this.name = typeof p.name === 'string' ? p.name : null;
                this._say(this.name ? this.name + ' plugged in' : 'none plugged in');
                this._mask(this.name ? toNes(p.buttons | 0) : 0);
            }
        });
        const gone = () => {
            if (this.conn !== c) return;
            this.conn = null;
            this.name = null;
            this._mask(0);
            this._again();
        };
        // (no socket: the loader is not installed, and a pad needs it; it is asked again in case it is on its way)
        c.on('error', gone);
        c.on('close', gone);
    }
}

module.exports = { Pad, PAD, toNes, SOCKET };
