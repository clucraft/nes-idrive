'use strict';
/**
 * NES - Nintendo Entertainment System games on the iDrive, for when you're parked (setting
 * "Parked only", on by default).
 *
 * The emulator is FCEUmm (GPL-2, see LICENSE / NOTICE in this folder) compiled to WebAssembly
 * (nes.wasm, built by core/build.sh) and run here at the console's 60 frames a second
 * (nes-core.js). Each frame is the console's own 256 x 240 picture (224 lines with the edges hidden),
 * handed to the GPU renderer as a pixel image and shown three times as big, pixel for pixel. Its
 * sound goes to the NES game loader, which plays it into the head unit's sound mixer (sound.js), and
 * the head unit's audio manager is asked to put that on the speakers (caraudio.js): setting "Sound".
 *
 * Screens:
 *   MAIN  the main menu, an HMI list of four: Continue, Games, Add games from a phone, Settings. The last
 *         opens the HMI's own screen of the settings (SETTINGS, the kit's): a finger works on its rows,
 *         so they can be reached whatever steers the drawn screen.
 *   GAME  the one drawn screen ("chrome": false). It shows the game on the whole screen, or, while no
 *         game is on it, three pages under a row of tabs (tabs.js): Games, the list to pick from; Add
 *         games, a QR code for the page the NES game loader opens on the car Wi-Fi (phone.js, qr.js;
 *         loader/ in the repository), and what came in; Settings. BACK (the HMI's own) returns to the
 *         menu. All of it is on this one screen because the GPU renderer draws one screen of an app, and
 *         on a car a second drawn screen stayed empty: the HMI took none of its pictures
 *         (INVALID_MODELID). The tabs are steered by the controller, a USB gamepad, and the four
 *         buttons on the touchscreen: a finger on the page itself does not reach an app that draws
 *         pixel pictures (kit renderd.js: claim).
 *
 * Games are .nes files (library.js): two come with the app (app/games/); your own are in
 * <the app's data folder>/roms/ on the head unit (copied there, or sent from a phone), in a folder
 * "nes" on a USB stick, or packed into the app from app/roms/ by a build on a PC.
 *
 * Controls (controls.js): push the controller for the D-pad, press it for A, turn it right for B and
 * left for Start; Select, Start, B and A are also buttons on the touchscreen, beside the picture. With
 * the setting "USB gamepad", an Xbox pad on a cable plays too (pad.js; the NES game loader reads it); its
 * LB and RB together leave the game for the list of games.
 *
 * The game runs only while GAME is on screen - and, with "Parked only" (the default), while the car
 * stands. Whenever it stops (BACK, MENU, a popup or call, driving off, the app closing) the console's
 * state and the cartridge's battery memory are saved, and Continue carries on from there.
 */
const path = require('path');
const mgu = require('./kit/mgu');
const { Recorder, setImage } = require('./kit/record');
const { HMI7 } = require('./kit/display');
const Parked = require('./kit/parked');
const { Nes } = require('./nes-core');
const { Controls } = require('./controls');
const { Library, mkdirp, usbFolders } = require('./library');
const { Phone } = require('./phone');
const { Pad, PAD } = require('./pad');
const { Tabs } = require('./tabs');
const { Sound } = require('./sound');
const { createCarAudio } = require('./caraudio');
const { qr } = require('./qr');

const W = 1600, H = 520, IMG = 1;
const BAR = ['BTN_SELECT', 'BTN_START', 'BTN_B', 'BTN_A'];
const MAX_STEP = 6;                                 // frames run at once at most, to catch up
const KEEP_MS = 30000;                              // while playing: battery memory and state saved this often
const HELD_MS = 400, AGAIN_MS = 90;                 // a gamepad's D-pad held on the tabs: it moves on after, and then every
const BAR_TABS = { BTN_SELECT: 'Tab', BTN_START: 'Up', BTN_B: 'Down', BTN_A: 'OK' };   // the touch buttons while the tabs show
const NAMES = { a: 'A', b: 'B', start: 'Start', select: 'Select' };
const C = { bg: '#000000', text: '#e8eaed', dim: '#8c939c', key: '#ffffff', btn: '#1a1e24', edge: '#4a525c', lit: '#c8102e', good: '#7ddc8a', bad: '#ff8f8f', paper: '#ffffff', ink: '#000000' };
/** milliseconds on a monotonic clock (the wall clock can jump: GPS / network time sync) */
function mono() { const t = process.hrtime(); return t[0] * 1000 + t[1] / 1e6; }

mgu.run({
    async start(ctx) {
        const { ui, settings, log } = ctx;

        /* ---------- parked only (setting, on by default): the game waits while the car drives ---------- */
        const parked = Parked.watch(ctx, log);
        const driving = () => settings.get('parkedOnly') !== false && parked.moving();

        /* ---------- the games ---------- */
        const romDir = path.join(ctx.dataDir, 'roms');
        try { mkdirp(romDir); } catch (e) { log.warn('nes: ' + romDir + ': ' + e.message); }
        const config = ctx.spec.config || {};
        // games on a USB stick, in a folder "nes" at its top: there while the stick is in
        let usbNow = null;
        const usb = () => {
            const u = usbFolders(config.usbRoots || [], ['nes', 'NES', 'Nes']);
            const now = u.dirs.concat(u.errors).join(' | ');
            if (now !== usbNow) {
                usbNow = now;
                log.info('nes: USB sticks: ' + (u.dirs.length ? 'games in ' + u.dirs.join(', ') : 'no folder "nes" on one') + (u.errors.length ? '; cannot read ' + u.errors.join(', ') : ''));
            }
            return u.dirs;
        };
        const lib = new Library({
            packs: [path.join(__dirname, 'games.pack'), path.join(__dirname, 'roms.pack')],
            dirs: [romDir].concat(config.romDirs || []), more: usb, dataDir: ctx.dataDir, log,
        });
        // (libRev counts up when the games found are others than before: the drawn list follows it)
        let libRev = 0, libKey = '';
        const scan = () => { lib.scan(); const k = lib.games.map((g) => g.id).join('/'); if (k !== libKey) { libKey = k; libRev++; } };
        scan();
        log.info('nes: ' + lib.games.length + ' game(s); more go on a USB stick (folder "nes") or into ' + romDir);

        /* ---------- the console ---------- */
        const nes = new Nes({ wasm: path.join(__dirname, 'nes.wasm'), log });
        let game = null;                 // the game in the console (a library entry)
        let err = null;                  // what went wrong, for the menu
        let starting = false, going = false;
        let view = 'games';              // what the game's screen shows: 'play' (the game), or a page of the tabs: 'games', 'add', 'settings'
        let frames = 0;                  // pictures of this game so far
        let keptSram = null, keptT = 0;
        const pic = { px: null, w: 0, h: 0 };
        // compiled in the background from the start (a few seconds on the head unit): ready by the time a game is picked
        nes.compile().catch((e) => { err = 'The emulator did not start: ' + (e.message || e); log.error('nes: compile', e); menu(); });
        nes.onDead = () => { err = (game ? game.title : 'The game') + ' stopped: the emulator crashed'; game = null; frames = 0; if (view === 'play') show('games'); menu(); };

        function applyOptions() {
            const crop = settings.get('edges') === 'full' ? 0 : 8;
            nes.setCrop(0, crop, 0, crop);
            // the whole picture from the core: the edges are cut here
            ['fceumm_overscan_h_left', 'fceumm_overscan_h_right', 'fceumm_overscan_v_top', 'fceumm_overscan_v_bottom'].forEach((k) => nes.setVar(k, '0'));
            nes.setVar('fceumm_nospritelimit', settings.get('flicker') === true ? 'enabled' : 'disabled');
        }

        /** save what the game has: its battery memory (when it changed) and, with state, where it stands */
        function keep(state) {
            if (!game || !nes.loaded) return;
            const sram = nes.sram();
            if (sram && !(keptSram && keptSram.equals(sram)) && lib.setSram(game, sram)) keptSram = sram;
            if (state && frames) { const st = nes.saveState(); if (st) lib.setState(game, st); }
            keptT = Date.now();
        }

        /** Put a game into the console and show it. fresh: from power-on, not from where it was left. */
        async function play(g, fresh) {
            if (starting || !g) return;
            if (driving()) { menu(); return; }
            starting = true; err = null;
            try {
                if (!nes.ready) { put('MENU_INFO', 'Starting the emulator...'); await nes.compile(); }
                // the game in the console is saved first (a game restarted keeps its battery memory, not its state)
                if (game && nes.loaded) keep(!(fresh && game.id === g.id));
                applyOptions();
                const rom = lib.read(g);
                if (!rom || !nes.load(rom)) {
                    game = null; frames = 0;
                    err = g.title + ': not a game this emulator can run';
                    log.warn('nes: ' + g.file + ' did not load');
                    return;
                }
                game = g; frames = 0; pic.w = pic.h = 0;
                // the battery memory saved last time goes back in; it is written again only once the game changes it
                keptSram = lib.sram(g);
                if (!(keptSram && nes.setSram(keptSram))) keptSram = nes.sram();
                let resumed = false;
                if (fresh) lib.dropState(g);
                else if (settings.get('resume') !== false) {
                    const st = lib.state(g);
                    resumed = !!st && nes.loadState(st);
                    if (st && !resumed) log.warn('nes: ' + g.id + ': its saved state did not load, starting from power-on');
                }
                lib.setLast(g);
                log.info('nes: ' + g.file + (resumed ? ' (carrying on)' : ' (from power-on)') + ', ' + (nes.fps || 60).toFixed(2) + ' fps');
                show('play');
                if (!ui.isVisible('GAME')) await ui.open('GAME');
            } catch (e) {
                err = 'The emulator did not start: ' + (e.message || e);
                log.error('nes: play', e);
            } finally { starting = false; menu(); }
        }

        /* ---------- main menu ---------- */
        // a row's text and whether it shows go to the HMI only when they change (and all of them again
        // each time the menu comes on screen)
        const sent = new Map();
        const put = (name, text) => { if (sent.get('t' + name) !== text) { sent.set('t' + name, text); ui.text(name, text); } };
        const shownRow = (name, on) => { if (sent.get('v' + name) !== on) { sent.set('v' + name, on); ui.visible(name, on); } };
        ui.onVisible((name, on) => { if (name === 'MAIN' && on) { sent.clear(); menu(); } });
        function menu() {
            const cur = game || lib.last();
            let info;
            if (err) info = err;
            else if (driving()) info = 'Parked only - the game waits while you drive (Settings: Parked only)';
            else if (!lib.games.length) info = 'No games: put .nes files in a folder "nes" on a USB stick, or copy them to ' + romDir;
            else info = lib.games.length + (lib.games.length === 1 ? ' game' : ' games') + '. In a game, BACK returns here and saves';
            put('BTN_PLAY', cur ? 'Continue: ' + cur.title : 'Continue');
            shownRow('BTN_PLAY', !!cur);
            put('BTN_GAMES', 'Games (' + lib.games.length + ')');
            put('MENU_INFO', info);
        }
        /** what the game's screen shows from now on: the game ('play'), or a page of the tabs */
        function show(v) {
            if (v === view) return;
            // (games sent from a phone are in the list once the page is left)
            if (view === 'add') { phone.close(); scan(); }
            view = v;
            pageKey = null;
            if (v !== 'play' && tabs.name !== v) tabs.open(v);
            sync();
        }
        /** a page of the tabs, from the menu */
        const page = (v) => { show(v); tabs.open(v); return ui.isVisible('GAME') ? null : ui.open('GAME'); };
        /** the game the console already holds goes back on screen as it is; any other is put in */
        const pick = (g) => {
            if (driving()) { menu(); return null; }
            if (!(g && game && nes.loaded && game.id === g.id)) return play(g);
            show('play');
            return ui.isVisible('GAME') ? null : ui.open('GAME');
        };
        ui.onClick('BTN_PLAY', () => pick(game || lib.last()));
        ui.onClick('BTN_GAMES', () => page('games'));
        ui.onClick('BTN_ADD', () => page('add'));
        // (the HMI's own screen of them: the drawn one is the tab "Settings")
        ui.onClick('BTN_SET', () => ui.open('SETTINGS'));
        menu();
        // (games copied over while the app runs show up; the texts follow the car standing or driving)
        setInterval(() => { if ((ui.isVisible('MAIN') || (ui.isVisible('GAME') && view === 'games')) && !starting) { if (!going) scan(); menu(); } }, 3000);

        /* ---------- controls ---------- */
        // (while the tabs show, the same controller and touch buttons steer those: nav)
        const ctl = new Controls({
            log, press: () => settings.get('press'), turnR: () => settings.get('turnR'), turnL: () => settings.get('turnL'),
            nav: (ev) => { if (view !== 'play') tabs.input(ev); },
        });
        // the controller events the HMI didn't get while the game holds the controller (the renderer
        // hands them on from mgu-inputgate.so in the HMI)
        let ccuT = 0;
        if (ctx.controller && ctx.controller.onInput) ctx.controller.onInput((v) => { ccuT = Date.now(); ctl.raw(v, true); });
        ctx.signals.watch('de.bmw.infotainment.controlelements.FrontCCU', '1', {
            // (while the game holds the controller, the same events come from the renderer too: that
            // copy wins, this one is for when it doesn't come)
            statusRotaryEncoderState: (v) => { if (Date.now() - ccuT > 1000) ctl.raw(v, false); },
        }, log).then((s) => log.info('controller ' + (s.error ? 'error: ' + s.error : 'subscribed')));
        BAR.forEach((b) => ui.onClick(b, () => { if (settings.get('touch') !== false) ctl.bar(b); }));
        // a USB gamepad (setting "USB gamepad"): the NES game loader reads it while a game runs (pad.js)
        // On the tabs its D-pad moves as the controller's pushes do, A chooses, LB and RB go to the tab to the
        // left and right. In a game, LB and RB together leave it for the list of games.
        let padWas = 0, again = null;            // the pad's buttons before; a direction held: { ev, bit, at: when it moves on }
        const padSteer = (b) => {
            const down = b & ~padWas;
            padWas = b;
            if (view === 'play') {
                if ((b & PAD.L) && (b & PAD.R) && (down & (PAD.L | PAD.R))) show('games');
                return;
            }
            if (down & PAD.L) tabs.input({ tab: -1 });
            if (down & PAD.R) tabs.input({ tab: 1 });
            [[PAD.UP, 'N'], [PAD.DOWN, 'S'], [PAD.LEFT, 'W'], [PAD.RIGHT, 'E']].forEach((d) => {
                if (!(down & d[0])) return;
                tabs.input({ push: d[1] });
                again = d[1] === 'N' || d[1] === 'S' ? { ev: { push: d[1] }, bit: d[0], at: Date.now() + HELD_MS } : null;
            });
            if (again && !(b & again.bit)) again = null;
            if (down & (PAD.A | PAD.START)) tabs.input({ press: true });
        };
        const pad = new Pad({ socket: process.env.NES_LOADER_SOCK || config.loaderSocket, log, onMask: (m) => ctl.setExternal(m), onButtons: padSteer });
        // The game's sound (setting "Sound", on at first), while it runs: the NES game loader plays it (sound.js),
        // and once its player is up the head unit's audio manager is asked for the speakers (caraudio.js; not
        // before: they would be taken from the radio for nothing). On a PC there is no audio manager to ask.
        const sound = new Sound({ socket: process.env.NES_LOADER_SOCK || config.loaderSocket, log });
        const speakers = ctx.signals.hasNative && ctx.signals.hasNative() ? createCarAudio(ctx.signals, log, path.join(ctx.dataDir, 'speakers.json')) : null;
        const loud = () => going && settings.get('sound') !== false;
        /** the sound's state in a few words, for the panel beside the game; null with the setting off */
        const soundSays = () => {
            if (settings.get('sound') === false) return null;
            const s = sound.state, at = speakers ? speakers.state() : null;
            if (s.step === 'missing') return 'Needs the NES game loader';
            if (s.step === 'failed') return s.error || 'Not here';
            if (s.step !== 'on') return 'Starting...';
            if (s.player === 'busy') return 'Another app has the sound device';
            if (s.player === 'error') return s.error || 'Cannot be played';
            if (at && at.error) return 'No speakers: ' + at.error;
            return s.player === 'playing' ? 'On the car\'s speakers' : 'Waiting for the speakers';
        };

        /* ---------- run while the game screen is up; save when it stops ---------- */
        const shown = () => ui.isVisible('GAME') && (!ui.hasFocus || ui.hasFocus('GAME'));
        let lastT = 0, acc = 0;
        let held = null;
        function sync() {
            const up = shown();
            const go = view === 'play' && !!game && nes.loaded && up && !driving();
            if (go !== going) {
                going = go;
                ctl.enable(go);
                if (go) { lastT = 0; acc = 0; keptT = Date.now(); } else { keep(true); menu(); }
                // driving off with the game on screen: the list of games, which says why it waits
                if (!go && view === 'play' && up && driving()) { log.info('car moving: game paused'); show('games'); }
            }
            // the controller to this screen alone while it shows, the game or the tabs (the HMI's pull-down /
            // back on a push stay away); BACK and MENU still work. Needs mgu-inputgate.so (deploy-car.sh)
            if (up !== held) { held = up; if (ctx.controller) ctx.controller.grab(up); }
            ctl.navigate(up && view !== 'play');
            if (going) { applyOptions(); if (Date.now() - keptT > KEEP_MS) keep(true); }
            // a gamepad is read while the screen shows: it steers the tabs too
            if (up && settings.get('pad') === true) pad.start(); else { pad.stop(); padWas = 0; again = null; }
            if (loud()) sound.start(nes.sampleRate || 48000); else sound.stop();
            if (speakers) speakers.want(loud() && sound.state.step === 'on' && ['open', 'playing', 'waiting'].indexOf(sound.state.player) >= 0);
        }
        setInterval(sync, 200);
        if (ui.onFocus) ui.onFocus(() => sync());
        ui.onVisible(() => sync());
        process.on('exit', () => { try { if (going) keep(true); } catch (e) { /* exiting */ } });

        /** run the console up to now: one frame per 1/60 s (1/50 s for a PAL game), a few at once after a late call */
        let emuN = 0, emuMs = 0;
        function advance() {
            const now = mono(), frameMs = 1000 / (nes.fps > 40 && nes.fps < 75 ? Math.round(nes.fps) : 60);
            let dt = lastT ? now - lastT : frameMs;
            lastT = now;
            if (!(dt > 0) || dt > 500) dt = frameMs;            // after a stall: no catching up
            acc += dt;
            let n = Math.round(acc / frameMs);
            if (n > MAX_STEP) { n = MAX_STEP; acc = 0; } else acc -= n * frameMs;
            let drew = false;
            for (let i = 0; i < n && nes.loaded; i++) {
                nes.setPad(0, ctl.mask());
                if (nes.run()) drew = true;
                if (sound.ready) { const a = nes.audio(); if (a) sound.write(a.bytes); }
            }
            if (n) { emuN += n; emuMs += mono() - now; }
            if (!drew) return;
            const f = nes.frame();
            if (!f) return;
            // a copy: the core's picture is only valid until it runs again
            if (!pic.px || pic.px.length !== f.px.length) pic.px = new Uint8Array(f.px.length);
            pic.px.set(f.px); pic.w = f.w; pic.h = f.h;
            setImage(IMG, pic.w, pic.h, pic.px);
            frames++;
        }
        setInterval(() => {
            if (emuN && going) log.info('game ' + (emuN / 10).toFixed(1) + ' fps, ' + (emuMs / emuN).toFixed(2) + ' ms a frame in the emulator');
            emuN = 0; emuMs = 0;
        }, 10000);

        /* ---------- drawing ---------- */
        const fit = (r, s, size, font, max) => {
            if (r.textWidth(s, size, { font, literal: true }) <= max) return s;
            while (s.length > 1 && r.textWidth(s + '...', size, { font, literal: true }) > max) s = s.slice(0, -1);
            return s.trim() + '...';
        };
        /** the panel left of the picture: the game's name, what the controller does, the touch buttons */
        function panel(r, right, btns) {
            const x = HMI7.btn.x, w = right - x - 40;
            r.text(fit(r, game.title, 46, 'bold', w), x, 92, 46, C.text, { font: 'bold', literal: true });
            const rows = [['Push', 'D-pad'], ['Press', NAMES[settings.get('press')] || 'A'],
                ['Turn right', NAMES[settings.get('turnR')] || null], ['Turn left', NAMES[settings.get('turnL')] || null],
                ['BACK', 'Menu (the game is saved)'], ['LB + RB', pad.name ? 'The list of games' : null], ['Sound', soundSays()]].filter((q) => q[1]);
            rows.forEach((q, i) => {
                const y = 176 + i * 54;
                r.text(q[0], x, y, 30, C.key, { font: 'bold' });
                r.text(fit(r, String(q[1]), 30, null, w - 230), x + 230, y, 30, C.dim, { literal: true });
            });
            const top = HMI7.barTop + 10, bh = r.h - top - 10;
            btns.forEach((b) => {
                const bx = b.x + 6, bw = Math.min(b.x + b.w, right) - b.x - 12, lit = ctl.lit(b.id);
                if (bw < 60) return;
                r.roundRect(bx, top, bw, bh, 16, lit > 0 ? C.lit : C.btn);
                r.strokeRoundRect(bx, top, bw, bh, 16, 2, C.edge);
                r.text(String(b.label).toUpperCase(), bx + bw / 2, top + bh / 2 + 15, 40, C.text, { align: 'center', font: 'bold' });
            });
        }
        let sr = null;
        function render() {
            if (view !== 'play') return tabsFrame();
            if (going) advance();
            const stop = err ? 'The game stopped' : !game ? 'No game: BACK for the menu' : !frames ? 'Loading...' : null;
            const cv = ctx.canvas(W, H);
            const pl = cv.place;
            if (pl && pl.full) {
                // screen pixels: the whole display is ours, but for the HMI's back arrow column
                cv.clear([0, 0, 0, 0]);
                if (!sr || sr.w !== pl.w || sr.h !== pl.h) sr = new Recorder(pl.w, pl.h);
                sr.reset();
                const id7 = pl.w === HMI7.screen.w && pl.h === HMI7.screen.h;
                const left = id7 ? HMI7.left : 0, colEnd = id7 ? HMI7.colEnd : 0;
                sr.fillRect(left, 0, pl.w - left, pl.h, C.bg);
                if (left) sr.fillRect(0, colEnd, left, pl.h - colEnd, C.bg);
                if (stop) sr.text(stop, pl.w / 2, pl.h / 2 + 10, 30, C.text, { align: 'center', font: 'bold' });
                else {
                    // whole screen pixels per console pixel: 3 on the 720 lines of iDrive 7
                    const k = Math.max(1, Math.floor(Math.min(pl.h / pic.h, (pl.w - left) / pic.w)));
                    const pw = pic.w * k, ph = pic.h * k, py = Math.round((pl.h - ph) / 2);
                    // touch buttons: where the HMI's own (hidden) bar buttons are, so the picture goes to the right
                    const btns = id7 && settings.get('touch') !== false ? ctx.display.buttons() : [];
                    const side = btns.length > 0 && btns[btns.length - 1].x + btns[btns.length - 1].w <= pl.w - pw + 40;
                    const px = side ? pl.w - pw : left + Math.round((pl.w - left - pw) / 2);
                    sr.image(IMG, px, py, pw, ph);
                    if (side) panel(sr, px, btns);
                }
                cv.xf(1, 0, 0).append(sr).xf();
            } else {
                // software / standard layout: the game in the app's image area, twice as big
                cv.clear(C.bg);
                if (stop) cv.text(stop, W / 2, H / 2, 28, C.text, { align: 'center', font: 'bold' });
                else {
                    const k = Math.max(1, Math.floor(H / pic.h));
                    cv.image(IMG, Math.round((W - pic.w * k) / 2), Math.round((H - pic.h * k) / 2), pic.w * k, pic.h * k);
                }
            }
            return ui.image('GAME_GFX', cv);
        }
        ctx.loop('GAME', 60, render);

        /* ---------- the tabs: the games, games from a phone, the settings ---------- */
        // On the game's screen, in the game's place (the top of this file says why). The page for a phone is
        // open while its tab shows and the car stands; BACK, which hides GAME, closes it.
        let addRec = null, pageKey = null;       // the tabs as they were last drawn, and what they were drawn from
        // (setting "Add games over the Wi-Fi the car is on", on at first: the page on a Wi-Fi the head unit has joined too)
        const joinedWifi = () => settings.get('joinedWifi') !== false;
        const phone = new Phone({ socket: process.env.NES_LOADER_SOCK || config.loaderSocket, log, joined: joinedWifi, onChange: () => { pageKey = null; } });
        const tabs = new Tabs({
            games: () => lib.games, current: () => game || lib.last(), settings,
            onPlay: (g, fresh) => (fresh ? play(g, true) : pick(g)),
            onTab: (name) => show(name),
            // (the page of a phone's code is laid out 1600 x 520: as much smaller as the tabs leave it room)
            drawAdd: (r, x, y, k, h) => { const s = Math.min(1, h / H); addPage(r, driving(), phone.state, x + 40 * k * (1 - s), y, k * s); },
        });
        ui.onVisible((name, on) => {
            if (name !== 'GAME') return;
            pageKey = null;
            if (!on) { phone.close(); if (view === 'add') scan(); menu(); }
        });
        settings.onChange(() => { pageKey = null; });
        /** a QR code as dark runs on white paper, as big as fits a square of `side` at x, y */
        function code(cv, text, x, y, side) {
            const q = qr(text), k = Math.max(1, Math.floor(side / (q.size + 8))), at = Math.round((side - q.size * k) / 2);
            cv.fillRect(x, y, side, side, C.paper);
            for (let row = 0; row < q.size; row++) {
                for (let col = 0; col < q.size; col++) {
                    if (!q.modules[row * q.size + col]) continue;
                    let end = col;
                    while (end + 1 < q.size && q.modules[row * q.size + end + 1]) end++;
                    cv.fillRect(x + at + col * k, y + at + row * k, (end - col + 1) * k, k, C.ink);
                    col = end;
                }
            }
        }
        /**
         * The page: what to scan, or why there is nothing to. Laid out W x H, and drawn on r k times as big
         * with its top left corner at x0, y0.
         */
        function addPage(r, wait, s, x0, y0, k) {
            const page = s.page;
            const X = (x) => Math.round(x0 + x * k), Y = (y) => Math.round(y0 + y * k);
            const text = (t, x, y, size, colour, opts) => r.text(t, X(x), Y(y), size * k, colour, opts);
            const fits = (t, size, max) => fit(r, t, size * k, null, max * k);
            const lines = (list, x, y, size, colour, step) => list.forEach((t, i) => text(t, x, y + i * (step || size + 14), size, colour, { literal: true }));
            if (wait) {
                text('Parked only', 80, 150, 44, C.text, { font: 'bold' });
                lines(['The code to scan shows when the car stands.', 'Settings: Parked only.'], 80, 220, 30, C.dim);
            } else if (s.step === 'open' && page.url) {
                // which Wi-Fi the code is for: one the head unit has joined, or its own (the loader says: nets)
                const nets = page.nets || [], joined = !!nets[0] && nets[0].kind === 'joined';
                code(r, page.url, X(60), Y(40), Math.round(440 * k));
                text('Scan with your phone', 560, 86, 44, C.text, { font: 'bold' });
                lines([joined ? '1   The phone on the same Wi-Fi as the car (your home Wi-Fi, or the phone\'s own hotspot)'
                    : '1   The phone on the car\'s Wi-Fi (wireless CarPlay, or its hotspot)',
                    '2   Scan the code with the camera and pick your .nes files',
                    '3   The games you send are in the tab "Games"'], 560, 146, 28, C.dim, 44);
                text(fits(page.url, 24, 900), 560, 290, 24, C.dim, { literal: true });
                const recent = (page.saved || []).slice(-4);
                recent.forEach((g, i) => {
                    const y = 346 + i * 40, bad = !!g.refused, side = Math.round(16 * k);
                    r.fillRect(X(560), Y(y - 20), side, side, bad ? C.bad : C.good);
                    text(fits(bad ? g.name + ': ' + g.refused : g.name + (g.removed ? ' removed' : g.replaced ? ' replaced' : ' added'), 28, 880), 592, y, 28, bad ? C.bad : C.good, { literal: true });
                });
                if (!recent.length && /^failed/.test(page.firewall || '')) lines(['The head unit\'s firewall could not be opened:', fits(page.firewall, 24, 900)], 560, 346, 24, C.bad);
                // the car's own Wi-Fi is up as well: a phone on wireless CarPlay is on that one, and this code is not for it
                else if (!recent.length && joined && nets.some((n) => n.kind === 'car')) {
                    lines(['A phone on wireless CarPlay is on the car\'s own Wi-Fi instead. For that, switch off', '"Add games over the Wi-Fi the car is on" in the tab "Settings".'], 560, 346, 24, C.dim);
                }
            } else if (s.step === 'open' && joinedWifi()) {
                text('No Wi-Fi to send over', 80, 150, 44, C.text, { font: 'bold' });
                lines(['Connect the car to the Wi-Fi your phone is on: your home Wi-Fi, or the phone\'s own hotspot.', 'Or connect the phone for wireless CarPlay. The code to scan shows here then.'], 80, 220, 30, C.dim);
            } else if (s.step === 'open') {
                text('The car\'s Wi-Fi is off', 80, 150, 44, C.text, { font: 'bold' });
                lines(['Switch on the car\'s hotspot, or connect the phone for wireless CarPlay.', 'The code to scan shows here then.'], 80, 220, 30, C.dim);
            } else if (s.step === 'missing') {
                text('This needs the NES game loader', 80, 130, 44, C.text, { font: 'bold' });
                lines(['Install "NES game loader" in the MGU Store, from the source this app came from,', 'and restart the head unit once.',
                    '', 'Without it: put your .nes files in a folder "nes" on a USB stick.'], 80, 200, 30, C.dim);
            } else if (s.step === 'refused') {
                text('Restart the head unit once', 80, 150, 44, C.text, { font: 'bold' });
                lines(['The NES game loader was installed before this app and does not know it yet.', 'Settings in the MGU Store: Restart head unit.'], 80, 220, 30, C.dim);
            } else if (s.step === 'failed') {
                text('The page did not open', 80, 150, 44, C.text, { font: 'bold' });
                lines([fits(String(s.error || ''), 30, 1400)], 80, 220, 30, C.bad);
            } else {
                text('Opening the page...', 80, 150, 44, C.text, { font: 'bold' });
            }
        }
        /** the touch buttons under the tabs (the HMI's own, hidden: as beside the game), and what else steers them */
        function strip(r, btns) {
            const top = HMI7.barTop + 10, bh = r.h - top - 10;
            let end = HMI7.btn.x;
            btns.forEach((b) => {
                const bx = b.x + 6, bw = b.w - 12;
                r.roundRect(bx, top, bw, bh, 16, ctl.lit(b.id) > 0 ? C.lit : C.btn);
                r.strokeRoundRect(bx, top, bw, bh, 16, 2, C.edge);
                r.text(String(BAR_TABS[b.id] || b.label).toUpperCase(), bx + bw / 2, top + bh / 2 + 15, 40, C.text, { align: 'center', font: 'bold' });
                end = b.x + b.w;
            });
            if (r.w - end < 560) return;
            r.text('Controller: turn or push to move, press to choose', end + 36, top + 38, 24, C.dim);
            r.text(pad.name ? 'Gamepad: D-pad and A; LB and RB for the tabs' : 'BACK: the menu', end + 36, top + 78, 24, C.dim);
        }
        /** a frame of the game's screen while it shows the tabs (render) */
        function tabsFrame() {
            const now = Date.now();
            // a direction held on the gamepad moves on
            if (again && now >= again.at && (padWas & again.bit)) { tabs.input(again.ev); again.at = now + AGAIN_MS; }
            // the page for a phone is open while its tab is on screen and the car stands
            const wait = driving();
            if (view === 'add' && !wait) phone.open(); else phone.close();
            const cv = ctx.canvas(W, H), pl = cv.place, full = !!(pl && pl.full);
            const id7 = full && pl.w === HMI7.screen.w && pl.h === HMI7.screen.h;
            const btns = id7 && settings.get('touch') !== false ? ctx.display.buttons() : [];
            const notice = err || (wait ? 'Parked only: the games wait while the car moves' : null);
            const cur = game || lib.last();
            const key = [tabs.rev, view, notice, libRev, cur ? cur.id : '', btns.map((b) => (ctl.lit(b.id) > 0 ? 1 : 0)).join(''), pad.name,
                full, pl ? pl.w + 'x' + pl.h + '@' + pl.scale : 'no renderer'].join('|');
            const fresh = key !== pageKey;
            if (fresh) {
                // drawn anew only when what it shows changed (tabs.rev; phone.js and the settings say so too), or where it goes
                pageKey = key;
                const info = { notice, bad: !!err };
                if (full) {
                    // screen pixels, as the game's picture: the whole display but for the HMI's back arrow column
                    addRec = new Recorder(pl.w, pl.h);
                    const left = id7 ? HMI7.left : 0, colEnd = id7 ? HMI7.colEnd : 0;
                    addRec.fillRect(left, 0, pl.w - left, pl.h, C.bg);
                    if (left) addRec.fillRect(0, colEnd, left, pl.h - colEnd, C.bg);
                    // the page ends over the touch buttons, where there are any
                    const bottom = btns.length ? HMI7.barTop - 8 : pl.h - 20;
                    const k = Math.min((pl.w - left - 40) / W, (bottom - 20) / H);
                    tabs.draw(addRec, left + (pl.w - left - W * k) / 2, 20, k, (bottom - 20) / k, info);
                    if (btns.length) strip(addRec, btns);
                } else {
                    addRec = new Recorder(W, H, { textScale: pl ? pl.scale : 1 });
                    tabs.draw(addRec, 0, 0, 1, H, info);
                }
            }
            // without the renderer the HMI keeps the picture it has; the renderer wants a frame every second at least
            if (!pl && !fresh) return null;
            if (full) cv.clear([0, 0, 0, 0]).xf(1, 0, 0).append(addRec).xf(); else cv.clear(C.bg).append(addRec);
            return ui.image('GAME_GFX', cv);
        }
        log.info('nes app started');
    },
});
