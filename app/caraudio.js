'use strict';
/**
 * caraudio.js - the game's sound on the car's speakers. The NES game loader's player (nes-sound) plays into
 * SmartXbar's CarLife input, source 287 (no CarLife phone uses it outside China); the GENIVI audio manager routes a
 * source to a sink on request: this module marks 287 available
 * (RoutingControlObserver.hookSourceAvailablityStatusChange), connects it to the front speakers, MediaSink_Front
 * (1024), with CommandControl.connect, and disconnects that connection when the sound is no longer wanted. (The
 * route is Moonride's, JustAnotherPU, as aurelmarius' TVH Player and M850i-amn's IPTV use it. This file is
 * M850i-amn/idrive7-apps' apps/amn_iptv/lib/car_audio.js, MIT, as clucraft/plex-idrive carries it, where it is
 * heard on a car; unchanged below this comment: see NOTICE.)
 *
 * Other apps (myAirPlay, TVH Player, IPTV, Drive-In) use 287 too. This app's own connection id is kept in a file
 * with the boot it was made in, and on stop only that one is disconnected. When a game is started and 287 already
 * has a connection this app cannot claim, it is disconnected and this app connects its own: the user chose this
 * app's sound.
 *
 * While 287 is connected the head unit plays it in place of what it played before (the radio, a phone's music).
 *
 *   const audio = createCarAudio(ctx.signals, log, file);
 *   audio.want(true | false)       the sound on (a game runs) or off
 *   audio.state()                  { on, connected, taken, error }
 *
 * Node 8.
 */
const fs = require('fs');
const AM = 'org.genivi.am.commandinterface.CommandControl';
const AMR = 'org.genivi.am.routinginterface.RoutingControlObserver';
const SRC = 287, SINK = 1024;

function createCarAudio(signals, log, file, o) {
    const RETRY_MS = (o && o.retryMs) || 5000;
    const st = { on: false, connected: false, taken: false, error: null };
    let p = null, r = null, id = null, q = Promise.resolve(), retry = null;
    const boot = () => { try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch (e) { return null; } };
    const save = (v) => { try { if (v == null) fs.unlinkSync(file); else fs.writeFileSync(file, JSON.stringify({ mainConnectionID: v, bootId: boot() })); } catch (e) { /* none */ } };
    const saved = () => { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j.bootId && j.bootId === boot() ? j.mainConnectionID : null; } catch (e) { return null; } };
    async function proxies() {
        if (!p) p = await signals.proxy(AM, '1');
        if (!r) r = await signals.proxy(AMR, '1');
    }
    const avail = (on) => signals.call(r, 'hookSourceAvailablityStatusChange',
        { sourceID: SRC, availability: { availability: on ? 'A_AVAILABLE' : 'A_UNAVAILABLE', availabilityReason: 0 } });
    async function on287() {
        const v = await signals.call(p, 'getListMainConnections', {});
        const list = Array.isArray(v) ? v : (v && Object.keys(v).map((k) => v[k]).filter(Array.isArray)[0]) || [];
        return list.filter((x) => x && x.sourceID === SRC);
    }
    async function connect() {
        await proxies();
        const left = saved();
        if (left != null && (await on287()).some((c) => c.mainConnectionID === left)) id = left;   // ours, from before a crash of the app
        if (id != null) { st.connected = true; return; }
        // a connection nobody here can claim: the user just chose a channel in this app, so it is taken over. On the
        // car (0.1.4) one was left by an earlier run of this app (replaced by an update or gone before it hung up)
        // and kept every channel silent, saying "another app has the speakers" with no other app installed
        const other = await on287();
        for (const c of other) {
            log.info('car audio: taking over the speakers from connection ' + c.mainConnectionID);
            await signals.call(p, 'disconnect', { mainConnectionID: c.mainConnectionID });
        }
        st.taken = false;
        await avail(true);
        const res = await signals.call(p, 'connect', { sourceID: SRC, sinkID: SINK });
        if (res && (res.amError === 'E_OK' || res.amError === 0) && res.mainConnectionID != null) {
            id = res.mainConnectionID; save(id); st.connected = true;
            log.info('car audio: on (' + id + ')');
        } else throw new Error('connect refused: ' + JSON.stringify(res));
    }
    async function disconnect() {
        await proxies();
        const mine = id != null ? id : saved();
        if (mine == null) { st.connected = false; return; }
        if ((await on287()).some((c) => c.mainConnectionID === mine)) await signals.call(p, 'disconnect', { mainConnectionID: mine });
        id = null; save(null); st.connected = false;
        if (!(await on287()).length) await avail(false);
        log.info('car audio: off');
    }
    let said = null;
    function step() {
        q = q.then(() => (st.on ? connect() : disconnect())).then(() => { st.error = null; said = null; }, (e) => {
            st.error = String(e.message || e);
            // (a failure that repeats is logged once: it is tried again every 5 s for as long as the film plays)
            if (st.error !== said) { said = st.error; log.warn('car audio: ' + st.error); }
        });
        return q;
    }
    const settled = () => (st.on ? st.connected : !st.connected);
    function want(on) {
        on = !!on;
        // asked on every poll of the app: only a change starts something (a call that failed is the retry's)
        if (on === st.on) return;
        st.on = on;
        clearInterval(retry);
        // while another app holds the speakers (or a call failed), look again every 5 s
        retry = setInterval(() => {
            if (!settled()) step();
            else if (!st.on) { clearInterval(retry); retry = null; }      // off and hung up: nothing left to look at
        }, RETRY_MS);
        if (retry.unref) retry.unref();
        step();
    }
    return { want, state: () => Object.assign({}, st) };
}

module.exports = { createCarAudio, SRC, SINK };
