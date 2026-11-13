'use strict';
/**
 * controls.js - the iDrive controller and the screen's buttons -> the NES pad.
 *
 * Controller (the car's FrontCCU.statusRotaryEncoderState, or the same events from the renderer
 * while the game holds the controller):
 *   push up / right / down / left   the D-pad, held while pushed
 *   press                           A, held while pressed            (setting "press")
 *   turn right, one click           a tap of B                       (setting "turnR")
 *   turn left, one click            a tap of Start                   (setting "turnL")
 *
 * Buttons (the HMI's bar buttons under the picture: a finger on the touchscreen): a tap of
 * Select, Start, B or A.
 *
 * A tap holds its button for TAP frames and lets go for GAP frames, so turning the knob several
 * clicks gives that many presses (rapid fire). mask() is asked once for every frame the game runs.
 * setExternal() takes the buttons of another pad (a USB gamepad's helper, one day).
 */
const { BTN } = require('./nes-core');

// FrontRotaryEncoderDeflection / FrontRotaryEncoderPushButton: the SDK hands enums over by name
// (numbers accepted too), as in apps/doom/controls.js
const DEFL = { MITTELSTELLUNG: 0, NORD_KURZ_GEDRUECKT: 1, NORD_LANG_GEDRUECKT: 2, NORD_UNWIRKSAM: 3, OST_KURZ_GEDRUECKT: 4,
    OST_LANG_GEDRUECKT: 5, OST_UNWIRKSAM: 6, SUED_KURZ_GEDRUECKT: 7, SUED_LANG_GEDRUECKT: 8, SUED_UNWIRKSAM: 9,
    WEST_KURZ_GEDRUECKT: 10, WEST_LANG_GEDRUECKT: 11, WEST_UNWIRKSAM: 12, SIGNAL_UNGUELTIG: 15 };
const PUSH = { KEINE_BETAETIGUNG: 0, DREHGEBER_KURZ_GEDRUECKT: 1, DREHGEBER_LANG_GEDRUECKT: 2, UNWIRKSAM: 3, SIGNAL_UNGUELTIG: 15 };
const num = (v, names) => (typeof v === 'number' ? v : v != null && names[v] != null ? names[v] : 15);
const DIR = { 1: BTN.UP, 2: BTN.UP, 4: BTN.RIGHT, 5: BTN.RIGHT, 7: BTN.DOWN, 8: BTN.DOWN, 10: BTN.LEFT, 11: BTN.LEFT };
const BY_NAME = { a: BTN.A, b: BTN.B, start: BTN.START, select: BTN.SELECT, none: 0 };
const BAR = { BTN_SELECT: BTN.SELECT, BTN_START: BTN.START, BTN_B: BTN.B, BTN_A: BTN.A };
const TAPPED = [BTN.A, BTN.B, BTN.START, BTN.SELECT];
const TAP = 5, GAP = 4, QUEUE = 6;         // frames held, frames let go, taps waiting at most
const STALE_MS = 1500, HMI_PRESS_MS = 500;

class Controls {
    /** opts: { log, press(): 'a'|'b', turnR(): 'b'|..., turnL(): 'start'|..., now() } */
    constructor(opts) {
        this.o = opts || {}; this.log = this.o.log || console;
        this.now = this.o.now || Date.now;
        this.live = false;              // controller data arriving
        this.pos = null;                // knob counter
        this.dir = 0;                   // the D-pad button the push holds
        this.pressed = false;
        this.msgT = 0; this.same = 0; this.lastMsg = '';
        this.cyclic = false;            // the car repeats unchanged messages (then a lost release is timed out)
        this.hmiPressT = -1e9;          // a press the HMI saw too (no controller gate)
        this.enabled = false;
        this.logged = 0;
        this.ext = 0;
        this.tap = new Map();           // button -> { hold, gap, wait }
        TAPPED.forEach((b) => this.tap.set(b, { hold: 0, gap: 0, wait: 0 }));
        this.flash = new Map();         // bar button -> when it was tapped (for the picture of it)
    }

    _map(which, dflt) { const v = this.o[which] && this.o[which](); return BY_NAME[v] != null ? BY_NAME[v] : BY_NAME[dflt]; }

    /* ---------- controller ---------- */
    /** v: the controller's state; gated: it came from the renderer (the HMI did not get it) */
    raw(v, gated) {
        if (!v) return;
        const key = JSON.stringify(v);
        if (this.logged < 40 && key !== this.lastMsg) { this.logged++; this.log.info('controller ' + key); }
        const t = this.now();
        if (key === this.lastMsg) { if (++this.same >= 5 && !this.cyclic) { this.cyclic = true; this.log.info('controller: sent cyclically'); } } else this.same = 0;
        this.lastMsg = key; this.msgT = t;
        const pushBtn = num(v.frontRotaryEncoderPushButton, PUSH), defl = num(v.frontRotaryEncoderDeflection, DEFL), pos = v.frontRotaryEncoderOperation;
        // no controller behind it (the VM): everything SIGNAL_UNGUELTIG, counter 65535
        if (pushBtn === 15 && defl === 15) return;
        if (!this.live) { this.live = true; this.log.info('controller: live (push, press and turn drive the pad)'); }
        // knob: a counter, wrapping at 16 bits; big jumps (a reset) are skipped
        if (typeof pos === 'number') {
            if (this.pos !== null) {
                const d = ((pos - this.pos + 32768) & 0xffff) - 32768;
                if (d && Math.abs(d) <= 64 && this.enabled) this.taps(this._map(d > 0 ? 'turnR' : 'turnL', d > 0 ? 'b' : 'start'), Math.abs(d));
            }
            this.pos = pos;
        }
        this.dir = DIR[defl] || 0;
        const p = pushBtn === 1 || pushBtn === 2;
        if (p && !this.pressed && !gated) this.hmiPressT = t;
        this.pressed = p;
    }

    /* ---------- the screen's buttons ---------- */
    /** an HMI bar button was pressed: a tap on the touchscreen (or the HMI acting on the knob's press) */
    bar(name) {
        const b = BAR[name];
        if (!b || !this.enabled) return false;
        // without the controller gate the knob's press reaches the HMI as well, which presses the
        // bar button its focus is on: that press is already A here
        if (this.now() - this.hmiPressT < HMI_PRESS_MS) return false;
        this.flash.set(name, this.now());
        this.taps(b, 1);
        return true;
    }
    /** 0..1: how lit a bar button's picture is (it fades after a tap) */
    lit(name) { const t = this.flash.get(name); return t == null ? 0 : Math.max(0, 1 - (this.now() - t) / 250); }

    /* ---------- the pad ---------- */
    taps(b, n) {
        const s = this.tap.get(b);
        if (s) s.wait = Math.min(QUEUE, s.wait + n);
    }
    /** buttons of another pad, OR-ed in (0: none) */
    setExternal(mask) { this.ext = mask | 0; }

    /** The pad for the next frame of the game (call once per frame: the taps count frames). */
    mask() {
        if (!this.enabled) return 0;
        let m = this.ext;
        if (this.live) {
            // a release lost on the way (UDP) is timed out when the car repeats its messages
            const stale = this.cyclic && this.now() - this.msgT > STALE_MS;
            if (!stale) { m |= this.dir; if (this.pressed) m |= this._map('press', 'a'); }
        }
        this.tap.forEach((s, b) => {
            if (s.hold > 0) { m |= b; if (--s.hold === 0) s.gap = GAP; } else if (s.gap > 0) s.gap--;
            else if (s.wait > 0) { s.wait--; s.hold = TAP - 1; m |= b; if (s.hold === 0) s.gap = GAP; }
        });
        // (the NES pad cannot give left + right or up + down: some games misbehave on it)
        if ((m & BTN.LEFT) && (m & BTN.RIGHT)) m &= ~(BTN.LEFT | BTN.RIGHT);
        if ((m & BTN.UP) && (m & BTN.DOWN)) m &= ~(BTN.UP | BTN.DOWN);
        return m;
    }

    /** game running or not (stopped: everything is let go, waiting taps are dropped) */
    enable(on) {
        this.enabled = !!on;
        if (!on) this.tap.forEach((s) => { s.hold = s.gap = s.wait = 0; });
    }
}

module.exports = { Controls, BAR, TAP, GAP };
