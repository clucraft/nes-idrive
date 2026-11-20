'use strict';
/**
 * service.js - the NES game loader: lets the NES app open a page on the car Wi-Fi that takes games from a phone.
 *
 * An app cannot do this itself: the head unit's firewall drops every connection to it. This service runs as
 * root for these things only: the rule for the page's port in the firewall while the page is open (nft.js),
 * starting the page as the NES app's own user (page.js), which is the process that listens on the car Wi-Fi
 * and writes the games, into the app's own folder, and starting the program that reads a USB gamepad, as that
 * user too (further down).
 *
 * Started by the app's connection to /run/clucraft-nes-loader.sock (systemd socket activation, never at
 * boot); that socket is open to the NES app's group alone (sockgroup.js). A JSON object a line:
 *
 *   {"cmd":"status"}   -> {"ok":true,"version":"...","app":true,"page":{...}}
 *   {"cmd":"open"}     -> the same, with the page open: {"open":true,"url":"http://172.16.222.97:8493/<token>/",
 *                         "urls":[...],"until":<ms>,"firewall":"...","saved":[{"name","size","replaced"}],"note":"..."}
 *                         and {"event":"page","page":{...}} to that connection whenever the page changes
 *   {"cmd":"close"}    -> closes the page
 *
 * The page belongs to the connection that opened it: when the app closes it or goes, the page and its
 * firewall rules go too; after PAGE_MINUTES without a game they go as well. With no connection and no page
 * for a while the service ends, until the app's next connection.
 *
 * A third thing an app cannot do: read a USB gamepad. The head unit's kernel has no driver for one, and its
 * USB devices are not an app's to open (pad.js). While a game runs the app may ask for one:
 *
 *   {"cmd":"pad"}              -> the same answer, with "pad":{"on":true,"name":"Controller" or null,"buttons":<bits>}
 *                                 and {"event":"pad","pad":{...}} to that connection whenever a pad is plugged in
 *                                 or pulled out, and whenever its buttons change (the bits: pad.js, PAD)
 *   {"cmd":"pad","on":false}   -> no more of it
 *
 * The pad is read for the connection that asked, and no longer. The program that reads it (nes-usbpipe) runs as
 * the NES app's user in the group the head unit gives its USB devices to, not as root, and no port and no
 * firewall rule comes with it.
 *
 * Part of nes-idrive (GPL-2.0-or-later). Runs on the head unit's Node 8.
 */
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { fork } = require('child_process');
const games = require('./games');
const firewall = require('./nft');
const pads = require('./pad');

const VERSION = '0.2.1';
const PORT = 8493;                  // (the MGU Store's own page is 8470; other apps' pages 8490 to 8492)
const PAGE_MINUTES = 15;
const REFRESH_MS = 5000;            // the car Wi-Fi's addresses and the firewall rules are looked at this often
const IDLE_MS = 2 * 60 * 1000;
const KEPT = 30;                    // games named in the page's status
const PAD_SCAN_MS = 2000;           // a gamepad plugged in while a game runs is found within this
const PAD_SHORT_MS = 3000;          // a gamepad's helper that ends sooner than this did not work...
const PAD_TRIES = 5;                // ...and after this many in a row it is not started again for this game

/**
 * The car Wi-Fi: the interfaces a phone reaches the head unit on, [{ name, address }], the hotspot's first.
 * That is the hotspot's bridge (wlan_bridge, 172.16.222.x), which wireless CarPlay's phone is on too, and an
 * access point of the head unit's own. Not wlan0 / wlan1: there the head unit is a guest on someone's network.
 * `only` names the interfaces instead (a test; "*" is every one, a PC's own network first: the emulator).
 */
function carWifi(only) {
    const all = os.networkInterfaces(), out = [], every = !!only && only.indexOf('*') >= 0;
    Object.keys(all).forEach((name) => (all[name] || []).forEach((a) => {
        if (a.family !== 'IPv4' && a.family !== 4) return;
        const wanted = every ? true : only ? only.indexOf(name) >= 0
            : !a.internal && (name === 'wlan_bridge' || /^(uap|ap)\d/.test(name) || /^172\.16\.222\./.test(a.address));
        if (wanted) out.push({ name, address: a.address, internal: !!a.internal });
    }));
    return out.sort((a, b) => (b.name === 'wlan_bridge') - (a.name === 'wlan_bridge') || a.internal - b.internal);
}

/**
 * opts: { listen: a path or { fd }, oapDir, port, interfaces: [names] (else the car Wi-Fi's), nft: the program
 *         (null: the firewall is left alone), asSelf: the page and the gamepad's helper run as this process's
 *         user, pageMinutes, idleMs, refreshMs, exit: false to stay (tests), log,
 *         padPipe: [the gamepad's helper program, arguments...], padFind(): the pads plugged in, padScanMs,
 *         padEnv: the helper's environment }
 */
function createService(opts) {
    const o = Object.assign({ port: PORT, nft: 'nft', pageMinutes: PAGE_MINUTES, idleMs: IDLE_MS, refreshMs: REFRESH_MS,
        padPipe: [path.join(__dirname, 'nes-usbpipe')], padFind: pads.find, padScanMs: PAD_SCAN_MS }, opts || {});
    const log = o.log || ((s) => console.log(s));
    const connections = new Set();
    let page = null, pad = null, lastUse = Date.now(), stopping = false, whyClosed = null;

    const view = () => (page
        ? { open: true, url: page.urls[0] || null, urls: page.urls, until: page.until, firewall: page.firewall, saved: page.saved, note: page.note }
        : { open: false, why: whyClosed });
    const padView = () => (pad ? { on: true, name: pad.dev ? pad.dev.name : null, buttons: pad.buttons, error: pad.error } : { on: false });
    const status = () => ({ ok: true, version: VERSION, app: !!games.findApp(o.oapDir), page: view(), pad: padView() });
    const say = (c, obj) => { if (c && !c.destroyed) { try { c.write(JSON.stringify(obj) + '\n'); } catch (e) { /* gone */ } } };
    const changed = () => { if (page) say(page.owner, { event: 'page', page: view() }); };
    const padChanged = () => { if (pad) say(pad.owner, { event: 'pad', pad: padView() }); };

    /** the car Wi-Fi as it is now: the port open on it, the page listening on it, its address for the code */
    function refresh() {
        if (!page) return;
        const wifi = carWifi(o.interfaces);
        // (an interface with two addresses is one interface to the firewall)
        const names = wifi.map((i) => i.name).filter((n, i, all) => all.indexOf(n) === i);
        const before = JSON.stringify([page.urls, page.firewall, page.note]);
        if (o.nft) {
            const r = firewall.open(names, o.port, { program: o.nft, last: page.signature });
            page.signature = r.errors.length ? null : r.signature;
            page.firewall = r.errors.length ? 'failed: ' + r.errors[0] : names.length ? 'open on ' + names.join(', ') : 'nothing to open';
            if (r.changed || r.errors.length) log('firewall: ' + page.firewall);
        } else page.firewall = 'left alone';
        try { page.child.send({ op: 'listen', addresses: wifi.map((i) => i.address) }); } catch (e) { /* it is going */ }
        page.urls = wifi.map((i) => 'http://' + i.address + ':' + o.port + '/' + page.token + '/');
        page.note = wifi.length ? null : 'The car\'s Wi-Fi is off: switch on its hotspot, or connect the phone for wireless CarPlay';
        // (for whoever reads the journal: what the head unit has, when none of it looks like the car Wi-Fi)
        const seen = wifi.length ? '' : carWifi(['*']).map((i) => i.name + ' ' + i.address).join(', ');
        if (seen !== page.seen) { page.seen = seen; if (seen) log('no car Wi-Fi among the interfaces: ' + seen); }
        if (JSON.stringify([page.urls, page.firewall, page.note]) !== before) changed();
    }

    function openPage(owner) {
        const app = games.findApp(o.oapDir);
        if (!app) return { ok: false, error: 'The NES app is not installed' };
        if (page) {                                  // open already: it is this connection's now, for its full time
            page.owner = owner;
            page.until = Date.now() + o.pageMinutes * 60000;
            return status();
        }
        // the page runs as the app's user; if that were root (it never is on a head unit), there is no page
        if (!o.asSelf && !(app.uid > 0 && app.gid > 0)) return { ok: false, error: 'The NES app\'s folder belongs to root: no page as root' };
        const token = crypto.randomBytes(10).toString('hex');
        const as = o.asSelf ? {} : { uid: app.uid, gid: app.gid };
        let child;
        try {
            child = fork(path.join(__dirname, 'page.js'), [JSON.stringify({ token, port: o.port, dir: app.games })],
                Object.assign({ cwd: '/', env: { PATH: process.env.PATH || '/usr/bin:/bin' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], execArgv: [] }, as));
        } catch (e) {
            log('the page did not start: ' + e.message);
            return { ok: false, error: 'The page did not start: ' + (e.code || e.message) };
        }
        const mine = page = { token, child, owner, until: Date.now() + o.pageMinutes * 60000, urls: [], firewall: null, saved: [], note: null, signature: null, timer: null };
        child.on('message', (m) => {
            if (page !== mine || !m) return;
            if (m.event === 'saved' || m.event === 'removed' || m.event === 'refused') {
                lastUse = Date.now();
                mine.until = Date.now() + o.pageMinutes * 60000;
                mine.saved = mine.saved.concat([{ name: String(m.name || '').slice(0, 80), size: m.size | 0, replaced: !!m.replaced, removed: m.event === 'removed', refused: m.event === 'refused' ? String(m.why || 'not taken').slice(0, 120) : null }]).slice(-KEPT);
                log(m.event === 'saved' ? 'saved ' + m.name + ' (' + m.size + ' bytes)' : m.event === 'removed' ? 'removed ' + m.name : 'refused ' + m.name + ': ' + m.why);
                changed();
            } else if (m.event === 'listening') {
                if (m.error) log('the page cannot listen on ' + m.error);
            } else if (m.event === 'strangers') closePage('too many requests without the code');
        });
        child.on('error', (e) => log('the page: ' + e.message));
        child.on('exit', (code, signal) => { if (page === mine) { mine.child = null; closePage('the page ended (' + (signal || code) + ')'); } });
        mine.timer = setInterval(() => {
            if (page !== mine) return;
            if (Date.now() > mine.until) return closePage(o.pageMinutes + ' minutes without a game');
            refresh();
        }, o.refreshMs);
        log('page open for ' + app.games + (o.asSelf ? '' : ', as user ' + app.uid));
        refresh();
        return status();
    }

    function closePage(why) {
        if (!page) return;
        const was = page;
        page = null;
        whyClosed = why || null;
        clearInterval(was.timer);
        if (was.child) { try { was.child.kill('SIGTERM'); } catch (e) { /* gone */ } }
        if (o.nft) { const n = firewall.shut({ program: o.nft }); if (n) log('firewall: ' + n + ' rule(s) taken out'); }
        log('page closed' + (why ? ': ' + why : ''));
        say(was.owner, { event: 'page', page: view() });
        lastUse = Date.now();
    }

    /* ---------- a USB gamepad, for as long as the app asks ---------- */
    /** the pad that is plugged in, when one is and none is read yet: its buttons to the app from now on */
    function padScan() {
        if (!pad || pad.reader || pad.error) return;
        const mine = pad;
        let dev = null, as = {};
        try { dev = (o.padFind() || [])[0] || null; } catch (e) { log('gamepad: ' + e.message); }
        if (!dev) return;
        if (!o.asSelf) {
            // its helper is not root: the NES app's user, in the group that may open the head unit's USB devices
            try { as = { uid: mine.app.uid, gid: fs.statSync(dev.node).gid }; } catch (e) { log('gamepad: ' + dev.node + ': ' + (e.code || e.message)); return; }
        }
        const startT = Date.now();
        mine.dev = dev;
        log('gamepad: ' + dev.name + ' (' + ('000' + dev.vid.toString(16)).slice(-4) + ':' + ('000' + dev.pid.toString(16)).slice(-4) + ') at ' + dev.node);
        mine.reader = pads.open(dev, {
            pipe: o.padPipe, as, env: o.padEnv, log: (s) => log('gamepad: ' + s),
            onButtons: (b) => { if (pad === mine && mine.buttons !== b) { mine.buttons = b; padChanged(); } },
            onClose: (why, unplugged) => {
                if (pad !== mine) return;
                mine.reader = null; mine.dev = null; mine.buttons = 0;
                mine.fails = !unplugged && Date.now() - startT < PAD_SHORT_MS ? mine.fails + 1 : 0;
                if (mine.fails >= PAD_TRIES) mine.error = 'The gamepad cannot be read: ' + why;
                log('gamepad: ' + why + (mine.error ? ' (' + PAD_TRIES + ' times: not tried again for this game)' : ''));
                padChanged();
            },
        });
        padChanged();
    }

    function padOn(owner) {
        const app = o.asSelf ? null : games.findApp(o.oapDir);
        if (!o.asSelf && !(app && app.uid > 0)) return { ok: false, error: 'The NES app is not installed' };
        if (pad) { pad.owner = owner; return status(); }        // asked already: it is this connection's now
        const mine = pad = { owner, app, reader: null, dev: null, buttons: 0, fails: 0, error: null, timer: null };
        mine.timer = setInterval(padScan, o.padScanMs);
        log('gamepad: the app asks for one');
        padScan();
        return status();
    }

    function padOff(why) {
        if (!pad) return;
        const was = pad;
        pad = null;
        clearInterval(was.timer);
        if (was.reader) was.reader.close();
        log('gamepad: no longer read' + (why ? ': ' + why : ''));
        lastUse = Date.now();
    }

    function onLine(c, line) {
        let m = null;
        try { m = JSON.parse(line); } catch (e) { /* below */ }
        lastUse = Date.now();
        if (!m || typeof m.cmd !== 'string') return say(c, { ok: false, error: 'a JSON object with "cmd" a line' });
        if (m.cmd === 'status') return say(c, status());
        if (m.cmd === 'open') return say(c, openPage(c));
        if (m.cmd === 'close') { if (page && page.owner === c) closePage('closed by the app'); return say(c, status()); }
        if (m.cmd === 'pad') {
            if (m.on !== false) return say(c, padOn(c));
            if (pad && pad.owner === c) padOff('the app says so');
            return say(c, status());
        }
        say(c, { ok: false, error: 'unknown: ' + m.cmd.slice(0, 20) });
    }

    const server = net.createServer((c) => {
        connections.add(c);
        lastUse = Date.now();
        let text = '';
        c.setEncoding('utf8');
        c.on('data', (d) => {
            text += d;
            if (text.length > 4096) { c.destroy(); return; }
            for (let nl = text.indexOf('\n'); nl >= 0; nl = text.indexOf('\n')) { const line = text.slice(0, nl); text = text.slice(nl + 1); if (line.trim()) onLine(c, line); }
        });
        c.on('error', () => {});
        c.on('close', () => {
            connections.delete(c);
            lastUse = Date.now();
            if (page && page.owner === c) closePage('the app left');
            if (pad && pad.owner === c) padOff('the app left');
        });
    });
    server.on('error', (e) => { log('socket: ' + e.message); stop(1); });

    const idle = setInterval(() => {
        if (!page && !pad && !connections.size && Date.now() - lastUse > o.idleMs) { log('nothing to do: ending until the app asks again'); stop(0); }
    }, Math.min(10000, Math.max(50, o.idleMs / 2)));

    function stop(code) {
        if (stopping) return;
        stopping = true;
        clearInterval(idle);
        closePage('the service ends');
        padOff('the service ends');
        connections.forEach((c) => c.destroy());
        try { server.close(); } catch (e) { /* not listening */ }
        if (o.exit !== false) setTimeout(() => process.exit(code || 0), 100);
    }

    if (o.listen) server.listen(o.listen);
    return { server, stop, status, closePage, carWifi: () => carWifi(o.interfaces) };
}

if (require.main === module) {
    const env = process.env;
    const systemd = Number(env.LISTEN_FDS) >= 1;
    const socket = env.NES_LOADER_SOCK || '/run/clucraft-nes-loader.sock';
    if (!systemd) { try { fs.unlinkSync(socket); } catch (e) { /* none */ } }
    const service = createService({
        listen: systemd ? { fd: 3 } : socket,
        oapDir: env.NES_LOADER_OAP,
        port: Number(env.NES_LOADER_PORT) || PORT,
        interfaces: env.NES_LOADER_IFACES ? env.NES_LOADER_IFACES.split(',') : null,
        nft: env.NES_LOADER_NFT === 'none' ? null : env.NES_LOADER_NFT || 'nft',
        asSelf: env.NES_LOADER_AS_SELF === '1',
        log: (s) => console.log('clucraft-nes-loader: ' + s),
    });
    console.log('clucraft-nes-loader ' + VERSION + ': listening for the NES app');
    // the NES app may have been installed after the socket was made: the socket is its group's from now
    if (systemd) { try { require('./sockgroup').give(socket, env.NES_LOADER_OAP); } catch (e) { console.log('clucraft-nes-loader: socket: ' + e.message); } }
    process.on('SIGTERM', () => service.stop(0));
    process.on('SIGINT', () => service.stop(0));
    process.on('uncaughtException', (e) => {
        console.error('clucraft-nes-loader: ' + ((e && e.stack) || e));
        try { service.closePage('an error'); } catch (e2) { /* the unit's ExecStopPost clears the firewall */ }
        process.exit(1);
    });
}

module.exports = { createService, carWifi, VERSION, PORT };
