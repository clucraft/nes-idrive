'use strict';
/**
 * sound.js - the app's side of a game's sound.
 *
 * The app has no sound device. The NES game loader (loader/ in the repository; "NES game loader" in the MGU
 * Store) starts a small program that plays into the head unit's sound mixer (loader/sound.js, nes-sound), and
 * takes the game's samples over the socket the app also asks for a gamepad and for "Add games from a phone"
 * on: a connection of its own, which after one line and its answer carries nothing but the sound. That the
 * mixer's input is heard on the speakers is caraudio.js's part.
 *
 *   const sound = new Sound({ socket, log, onChange });
 *   sound.start(48000);      a game runs: ask the loader to play its sound, and keep asking while it does
 *   sound.write(bytes)       a frame's sound, signed 16-bit little-endian, left and right; false: not sent
 *                            (no loader yet, or it is behind: sound that is late is worth nothing)
 *   sound.stop();            the game stopped: the loader's player ends
 *   sound.state              { step: 'off' | 'asking' | 'on' | 'missing' | 'failed',
 *                              player: 'starting' | 'open' | 'playing' | 'waiting' | 'busy' | 'error' | null, error }
 *                            player 'waiting': the head unit takes none of it (the speakers are not this app's)
 */
const net = require('net');

const SOCKET = '/run/clucraft-nes-loader.sock';
const RETRY_MS = 5000;
const AHEAD = 48 * 1024;        // bytes that may wait for the loader (a quarter of a second): more are not sent
const waiting = (s) => (s.writableLength != null ? s.writableLength : s._writableState ? s._writableState.length : 0);

class Sound {
    constructor(opts) {
        this.o = opts || {};
        this.log = this.o.log || console;
        this.socket = this.o.socket || SOCKET;
        this.state = { step: 'off', player: null, error: null };
        this.wanted = false;
        this.rate = 0;
        this.conn = null;
        this.ready = false;             // the loader said yes: the connection carries the sound from now
        this.retry = null;
        this.given = false;             // the loader plays no sound (an older one, or not on this head unit): not asked again
        this.said = '';
    }

    _say(s) { if (s !== this.said) { this.said = s; this.log.info('sound: ' + s); } }

    _set(step, player, error) {
        const before = JSON.stringify(this.state);
        this.state = { step, player: player || null, error: error || null };
        if (JSON.stringify(this.state) !== before && this.o.onChange) { try { this.o.onChange(this.state); } catch (e) { this.log.error('sound: onChange', e); } }
    }

    start(rate) {
        if (this.wanted && rate === this.rate) return;
        if (this.wanted) this.stop();
        this.wanted = true;
        this.rate = rate;
        this.given = false;
        this._connect();
    }

    stop() {
        if (!this.wanted) return;
        this.wanted = false;
        clearTimeout(this.retry);
        const c = this.conn;
        this.conn = null;
        this.ready = false;
        if (c) { try { c.end(); } catch (e) { /* gone */ } setTimeout(() => c.destroy(), 300); }
        this._set('off');
    }

    /** a frame's sound (a Buffer or Uint8Array, copied here: the core's memory is its own) */
    write(bytes) {
        const c = this.conn;
        if (!c || !this.ready || !bytes || !bytes.length) return false;
        if (waiting(c) > AHEAD) return false;
        c.write(Buffer.from(bytes));
        return true;
    }

    _again() {
        clearTimeout(this.retry);
        if (this.wanted && !this.given) this.retry = setTimeout(() => this._connect(), RETRY_MS);
    }

    _connect() {
        if (!this.wanted || this.conn || this.given) return;
        if (this.state.step === 'off') this._set('asking');
        let c;
        try { c = net.connect(this.socket); } catch (e) { this._set('missing'); return this._again(); }
        this.conn = c;
        let text = '';
        c.setEncoding('utf8');
        c.on('connect', () => c.write(JSON.stringify({ cmd: 'sound', rate: this.rate }) + '\n'));
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
                // a loader from before it played sound says "unknown"; one that cannot play here says why
                if (m.ok === false) {
                    const why = String(m.error || 'the NES game loader refused');
                    const told = /^unknown/.test(why) ? 'this NES game loader plays no sound yet: update it in the MGU Store' : why;
                    this._say(told);
                    this.given = true;
                    this.ready = false;
                    this._set('failed', null, told);
                    c.destroy();
                    return;
                }
                const s = m.sound;
                if (!s || !s.on) continue;
                this.ready = true;
                this._set('on', s.state, s.error);
                this._say(s.state + (s.error ? ': ' + s.error : ''));
            }
        });
        const gone = (missing) => {
            if (this.conn !== c) return;
            this.conn = null;
            this.ready = false;
            if (this.wanted && !this.given) this._set(missing ? 'missing' : 'asking');
            this._again();
        };
        // (no socket: the loader is not installed; it is asked again in case it is on its way)
        c.on('error', (e) => gone(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' || e.code === 'ENOTSOCK'));
        c.on('close', () => gone(false));
    }
}

module.exports = { Sound, SOCKET, AHEAD };
