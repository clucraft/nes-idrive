'use strict';
/**
 * NES - Nintendo Entertainment System games on the iDrive, for when you're parked (setting
 * "Parked only", on by default).
 *
 * The emulator is FCEUmm (GPL-2, see LICENSE / NOTICE in this folder) compiled to WebAssembly
 * (nes.wasm, built by core/build.sh) and run here at the console's 60 frames a second
 * (nes-core.js). Each frame is the console's own 256 x 240 picture (224 lines with the edges hidden),
 * handed to the GPU renderer as a pixel image and shown three times as big, pixel for pixel. No
 * sound yet: nothing on the head unit takes an app's samples.
 *
 * Screens:
 *   MAIN  the main menu, an HMI list: Continue, Restart, the games, every setting.
 *   GAME  the game on the whole screen ("chrome": false). BACK (the HMI's own) returns to the menu.
 *
 * Games are .nes files (library.js): app/roms/ on the PC goes into the app at build time, and
 * <the app's data folder>/roms/ on the head unit is read as well. None come with the app.
 *
 * Controls (controls.js): push the controller for the D-pad, press it for A, turn it right for B and
 * left for Start; Select, Start, B and A are also buttons on the touchscreen, beside the picture.
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
const { Library, mkdirp } = require('./library');

const W = 1600, H = 520, IMG = 1;
const SLOTS = 10;                                   // game buttons in the menu (app.json BTN_ROM_0..9), a page of them
const BAR = ['BTN_SELECT', 'BTN_START', 'BTN_B', 'BTN_A'];
const MAX_STEP = 6;                                 // frames run at once at most, to catch up
const KEEP_MS = 30000;                              // while playing: battery memory and state saved this often
const NAMES = { a: 'A', b: 'B', start: 'Start', select: 'Select' };
const C = { bg: '#000000', text: '#e8eaed', dim: '#8c939c', key: '#ffffff', btn: '#1a1e24', edge: '#4a525c', lit: '#c8102e' };
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
        const extra = (ctx.spec.config && ctx.spec.config.romDirs) || [];
        const lib = new Library({ pack: path.join(__dirname, 'roms.pack'), dirs: [romDir].concat(extra), dataDir: ctx.dataDir, log });
        lib.scan();
        log.info('nes: ' + lib.games.length + ' game(s); more go into ' + romDir);

        /* ---------- the console ---------- */
        const nes = new Nes({ wasm: path.join(__dirname, 'nes.wasm'), log });
        let game = null;                 // the game in the console (a library entry)
        let err = null;                  // what went wrong, for the menu
        let starting = false, going = false;
        let frames = 0;                  // pictures of this game so far
        let keptSram = null, keptT = 0;
        const pic = { px: null, w: 0, h: 0 };
        // compiled in the background from the start (a few seconds on the head unit): ready by the time a game is picked
        nes.compile().catch((e) => { err = 'The emulator did not start: ' + (e.message || e); log.error('nes: compile', e); menu(); });
        nes.onDead = () => { err = (game ? game.title : 'The game') + ' stopped: the emulator crashed'; game = null; frames = 0; menu(); ui.open('MAIN'); };

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
                await ui.open('GAME');
            } catch (e) {
                err = 'The emulator did not start: ' + (e.message || e);
                log.error('nes: play', e);
            } finally { starting = false; menu(); }
        }

        /* ---------- main menu ---------- */
        let page = 0;
        const pages = () => Math.max(1, Math.ceil(lib.games.length / SLOTS));
        // a row's text and whether it shows go to the HMI only when they change (and all of them again
        // each time the menu comes on screen)
        const sent = new Map();
        const put = (name, text) => { if (sent.get('t' + name) !== text) { sent.set('t' + name, text); ui.text(name, text); } };
        const show = (name, on) => { if (sent.get('v' + name) !== on) { sent.set('v' + name, on); ui.visible(name, on); } };
        ui.onVisible((name, on) => { if (name === 'MAIN' && on) { sent.clear(); menu(); } });
        function menu() {
            const cur = game || lib.last();
            let info;
            if (err) info = err;
            else if (driving()) info = 'Parked only - the game waits while you drive (Settings: Parked only)';
            else if (!lib.games.length) info = 'No games yet: put .nes files into app/roms/ and build again, or copy them to ' + romDir;
            else info = lib.games.length + (lib.games.length === 1 ? ' game' : ' games') + '. In a game, BACK returns here and saves';
            put('BTN_PLAY', cur ? 'Continue: ' + cur.title : 'Continue');
            put('BTN_RESET', cur ? 'Restart: ' + cur.title : 'Restart');
            put('MENU_INFO', info);
            if (page >= pages()) page = 0;
            for (let i = 0; i < SLOTS; i++) {
                const g = lib.games[page * SLOTS + i];
                put('BTN_ROM_' + i, g ? g.title : '-');
                show('BTN_ROM_' + i, !!g);
            }
            put('BTN_MORE', 'More games (' + (page + 1) + ' of ' + pages() + ')');
            show('BTN_MORE', pages() > 1);
        }
        /** the game the console already holds goes back on screen as it is; any other is put in */
        const pick = (g) => {
            if (driving()) { menu(); return null; }
            return g && game && nes.loaded && game.id === g.id ? ui.open('GAME') : play(g);
        };
        ui.onClick('BTN_PLAY', () => pick(game || lib.last()));
        ui.onClick('BTN_RESET', () => play(game || lib.last(), true));
        for (let i = 0; i < SLOTS; i++) ui.onClick('BTN_ROM_' + i, () => pick(lib.games[page * SLOTS + i]));
        ui.onClick('BTN_MORE', () => { page = (page + 1) % pages(); menu(); });
        menu();
        // (games copied over while the app runs show up; the texts follow the car standing or driving)
        setInterval(() => { if (ui.isVisible('MAIN') && !starting) { if (!going) lib.scan(); menu(); } }, 3000);

        /* ---------- controls ---------- */
        const ctl = new Controls({
            log, press: () => settings.get('press'), turnR: () => settings.get('turnR'), turnL: () => settings.get('turnL'),
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

        /* ---------- run while the game screen is up; save when it stops ---------- */
        const shown = () => ui.isVisible('GAME') && (!ui.hasFocus || ui.hasFocus('GAME'));
        let lastT = 0, acc = 0;
        function sync() {
            const go = !!game && nes.loaded && shown() && !driving();
            if (go !== going) {
                // driving off with the game on screen: back to the menu, which says why it waits
                if (!go && shown() && driving()) { log.info('car moving: game paused'); ui.open('MAIN'); }
                going = go;
                // the controller to the game alone while it runs (the HMI's pull-down / back on a
                // push stay away); BACK and MENU still work. Needs mgu-inputgate.so (deploy-car.sh)
                if (ctx.controller) ctx.controller.grab(go);
                ctl.enable(go);
                if (go) { lastT = 0; acc = 0; keptT = Date.now(); } else { keep(true); menu(); }
            }
            if (going) { applyOptions(); if (Date.now() - keptT > KEEP_MS) keep(true); }
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
                ['BACK', 'Menu (the game is saved)']].filter((q) => q[1]);
            rows.forEach((q, i) => {
                const y = 176 + i * 54;
                r.text(q[0], x, y, 30, C.key, { font: 'bold' });
                r.text(q[1], x + 230, y, 30, C.dim);
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
        log.info('nes app started');
    },
});
