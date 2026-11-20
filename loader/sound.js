'use strict';
/**
 * sound.js - a game's sound on the head unit's speakers: the program that plays it, for the service.
 *
 * An app has no sound device. The head unit's sound goes through its own mixer (SmartXbar), whose inputs are
 * ALSA devices open to the group mgu_alsa, and the mixer's input for CarLife (a phone system no phone outside
 * China uses) is free: "plug:smartx:CarLifeMedia_CF_48_STEREO", the audio manager's source 287. Other apps for
 * this head unit play there and are heard on a car (aurelmarius/bmw-apps, M850i-amn/idrive7-apps,
 * clucraft/plex-idrive); this does as they do. Two things make a sound: the app asks the head unit's audio
 * manager to connect that source to the speakers (app/caraudio.js), and nes-sound, started here, plays the
 * game's samples into the device (src/nes-sound/main.go says how).
 *
 * nes-sound is not root: it runs as "nobody" in the group mgu_alsa. Node gives a child one group, which is
 * all it needs.
 *
 *   ids()                    -> { uid, gid }: nobody and mgu_alsa as this head unit numbers them
 *   const s = open({ pipe: [program, arguments before its own...], device, rate, as: { uid, gid }, env, log,
 *                    onState({ state, error }) });
 *       state: 'open', 'playing', 'waiting' (the device takes none: nothing is connected to the speakers),
 *              'busy' (another program has the device), 'error', and 'ended' ({ code, signal }) when it is gone
 *   s.write(buffer)          the game's sound as it comes, S16LE stereo; false: dropped (the program is behind)
 *   s.close()                its input ends: it closes the device and goes
 *
 * Part of the NES game loader (nes-idrive, GPL-2.0-or-later). Runs on the head unit's Node 8.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEVICE = 'plug:smartx:CarLifeMedia_CF_48_STEREO';
const RUN_AS = { user: 'nobody', group: 'mgu_alsa' };
const AHEAD = 64 * 1024;            // bytes that may wait for the program (a third of a second): more are dropped
const TERM_MS = 1000, KILL_MS = 6000;   // (a player killed with the device open can leave it busy: it is given time)

/** the number a name has in a passwd or group file, or null */
function numberOf(file, name) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
    const line = text.split('\n').find((l) => l.split(':')[0] === name);
    const n = line ? Number(line.split(':')[2]) : NaN;
    return n >= 0 ? n : null;
}

/** whom nes-sound runs as: { uid, gid }. Throws when the head unit has no such user or group. */
function ids(etc) {
    const dir = etc || '/etc';
    const uid = numberOf(path.join(dir, 'passwd'), RUN_AS.user), gid = numberOf(path.join(dir, 'group'), RUN_AS.group);
    if (uid === null || uid === 0) throw new Error('This head unit has no user "' + RUN_AS.user + '" to play sound as');
    if (gid === null || gid === 0) throw new Error('This head unit has no group "' + RUN_AS.group + '": its sound devices are not known');
    return { uid, gid };
}

const waiting = (s) => (s.writableLength != null ? s.writableLength : s._writableState ? s._writableState.length : 0);

function open(o) {
    const log = o.log || (() => {});
    const onState = (st) => { try { if (o.onState) o.onState(st); } catch (e) { log('onState: ' + e.message); } };
    const args = o.pipe.slice(1).concat([o.device || DEVICE, String(o.rate)]);
    let child = null, ended = false, dropped = 0, timers = [];
    const done = (code, signal, why) => {
        if (ended) return;
        ended = true;
        timers.forEach(clearTimeout);
        if (dropped) log(dropped + ' bytes were dropped: the player was behind');
        onState({ state: 'ended', code, signal, error: why || null });
    };
    try {
        child = spawn(o.pipe[0], args, Object.assign({ cwd: fs.existsSync('/tmp') ? '/tmp' : undefined,
            env: o.env || { HOME: '/tmp', PATH: process.env.PATH || '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] }, o.as || {}));
    } catch (e) {
        setImmediate(() => done(null, null, 'the player did not start: ' + (e.code || e.message)));
        return { write: () => false, close() {} };
    }
    const lines = (stream, fn) => {
        let text = '';
        stream.setEncoding('utf8');
        stream.on('data', (d) => {
            text += d;
            for (let nl = text.indexOf('\n'); nl >= 0; nl = text.indexOf('\n')) { fn(text.slice(0, nl)); text = text.slice(nl + 1); }
            if (text.length > 65536) text = '';
        });
    };
    lines(child.stdout, (l) => {
        let ev = null;
        try { ev = JSON.parse(l); } catch (e) { return; }
        if (!ev || typeof ev.ev !== 'string') return;
        if (ev.ev === 'stat') { log('played ' + ev.played + ' samples, silence for ' + ev.silent + ', ran dry ' + ev.ranDry + ' times, dropped ' + ev.dropped); return; }
        onState({ state: ev.ev, error: ev.error ? String(ev.error).slice(0, 200) : null });
    });
    lines(child.stderr, (l) => { if (l.trim()) log(l.slice(0, 300)); });
    child.stdin.on('error', () => { /* the player went: its exit says so */ });
    child.on('error', (e) => done(null, null, 'the player did not start: ' + (e.code || e.message)));
    child.on('exit', (code, signal) => done(code, signal));
    return {
        write(d) {
            if (ended || !child.stdin.writable) return false;
            if (waiting(child.stdin) > AHEAD) { dropped += d.length; return false; }
            child.stdin.write(d);
            return true;
        },
        close() {
            if (ended) return;
            try { child.stdin.end(); } catch (e) { /* gone */ }
            timers.push(setTimeout(() => { try { child.kill('SIGTERM'); } catch (e) { /* gone */ } }, TERM_MS));
            timers.push(setTimeout(() => { log('the player did not end: SIGKILL'); try { child.kill('SIGKILL'); } catch (e) { /* gone */ } }, KILL_MS));
        },
    };
}

module.exports = { open, ids, DEVICE, RUN_AS, AHEAD };
