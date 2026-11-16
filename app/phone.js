'use strict';
/**
 * phone.js - the app's side of "Add games from a phone".
 *
 * The app cannot take a phone's connection itself: the head unit's firewall drops it. The NES game loader, a
 * small service installed beside the app (loader/ in the repository; "NES game loader" in the MGU Store), opens
 * a page on the car Wi-Fi for as long as the app asks, and puts the games sent there into the app's games folder.
 * This is the asking: a connection to the loader's socket, a JSON object a line (loader/service.js).
 *
 *   const phone = new Phone({ socket, log, onChange });
 *   phone.open();        the "Add games" screen is up: ask for the page, and keep asking while it is
 *   phone.close();       the screen is gone: the page goes with the connection
 *   phone.state          { step, page, error }
 *
 * step:  'off'       not asked
 *        'asking'    connecting to the loader, or waiting for its answer
 *        'open'      page: { url, urls, until, firewall, saved: [{ name, size, replaced, removed, refused }], note }
 *        'missing'   the loader is not installed (or not started yet: the head unit needs a restart after its install)
 *        'refused'   the loader is there but not for this app yet (it was installed before the app: a restart settles it)
 *        'failed'    error says what
 */
const net = require('net');

const SOCKET = '/run/clucraft-nes-loader.sock';
const RETRY_MS = 3000;

class Phone {
    constructor(opts) {
        this.o = opts || {};
        this.log = this.o.log || console;
        this.socket = this.o.socket || SOCKET;
        this.state = { step: 'off', page: null, error: null };
        this.wanted = false;
        this.conn = null;
        this.retry = null;
    }

    _set(step, page, error) {
        const before = JSON.stringify(this.state);
        this.state = { step, page: page || null, error: error || null };
        if (JSON.stringify(this.state) !== before && this.o.onChange) { try { this.o.onChange(this.state); } catch (e) { this.log.error('phone: onChange', e); } }
    }

    open() {
        if (this.wanted) return;
        this.wanted = true;
        this._connect();
    }

    close() {
        this.wanted = false;
        clearTimeout(this.retry);
        const c = this.conn;
        this.conn = null;
        if (c) { try { c.end('{"cmd":"close"}\n'); } catch (e) { /* gone */ } setTimeout(() => c.destroy(), 300); }
        this._set('off');
    }

    _again() {
        clearTimeout(this.retry);
        if (this.wanted) this.retry = setTimeout(() => this._connect(), RETRY_MS);
    }

    _connect() {
        if (!this.wanted || this.conn) return;
        if (this.state.step === 'off') this._set('asking');
        let c;
        try { c = net.connect(this.socket); } catch (e) { this._set('missing'); return this._again(); }
        this.conn = c;
        let text = '';
        c.setEncoding('utf8');
        c.on('connect', () => c.write('{"cmd":"open"}\n'));
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
                if (m.ok === false) { this._set('failed', null, String(m.error || 'the loader refused')); continue; }
                const page = m.page;
                if (page && page.open) this._set('open', page);
                else if (page && (m.event === 'page' || this.state.step === 'open')) {
                    // closed on the loader's side (its time ran out): ask again in a moment, while the screen is still up
                    this._set('asking');
                    c.destroy();
                }
            }
        });
        c.on('error', (e) => {
            if (this.conn !== c) return;
            this.conn = null;
            // no socket: the loader is not installed. Not allowed: it does not know this app yet.
            if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED' || e.code === 'ENOTSOCK') this._set('missing');
            else if (e.code === 'EACCES' || e.code === 'EPERM') this._set('refused');
            else this._set('failed', null, e.code || e.message);
            this._again();
        });
        c.on('close', () => {
            if (this.conn !== c) return;
            this.conn = null;
            if (this.wanted) { if (this.state.step === 'open') this._set('asking'); this._again(); }
        });
    }
}

module.exports = { Phone, SOCKET };
