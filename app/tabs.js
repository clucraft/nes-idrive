'use strict';
/**
 * tabs.js - the game's screen while no game is on it: three pages under a row of tabs.
 *
 *   Games       every game by title, the one played last first as "Continue". Choosing one plays it;
 *               "Start over", beside the game the focus is on, plays it from power-on.
 *   Add games   the code to scan for the page a phone sends games through (main.js draws it: opts.drawAdd)
 *   Settings    every setting of app.json: a switch, or one value of several
 *
 * It is drawn (the head unit's own lists have no tabs, a fixed number of rows, and nothing a gamepad can
 * steer), on the game's screen (the GPU renderer shows one drawn screen of an app). Nothing here knows the
 * head unit: main.js hands over what was done with whatever is at hand, as one of
 *
 *   { turn: n }       the iDrive controller turned n clicks (+ clockwise): along the tabs, or through the rows
 *   { push: 'N' }     pushed up, 'S' down: a row up or down, and up from the first row to the tabs;
 *                     'E' right, 'W' left: another tab, the row's other button, a setting's other value
 *   { press: true }   pressed: into the page from the tabs; the game, or the setting's next value
 *   { tab: 1 }        the tab to the right (-1: to the left), from wherever the focus is; past the last, the first
 *
 * A USB gamepad's D-pad is the pushes, its A the press, LB and RB the tabs; the four buttons under the
 * page on the touchscreen are the next tab, up, down and the press (main.js).
 *
 *   const tabs = new Tabs({ games: () => [...], current: () => game, settings, onPlay(game, fresh), onTab(name) });
 *   tabs.open('games');  tabs.input({ turn: 1 });  tabs.draw(recorder, x, y, k, height, { notice });
 *   tabs.rev             counts up with everything that changes what draw() shows
 */
const TABS = [['games', 'Games'], ['add', 'Add games'], ['settings', 'Settings']];
const W = 1600;                     // the page is laid out this wide, and as high as it is given
const HEAD = 84;                    // the strip of the tabs
const ROW = 56, GAP = 6;
const C = { text: '#e8eaed', dim: '#8c939c', key: '#ffffff', btn: '#1a1e24', row: '#12151a', edge: '#4a525c', lit: '#c8102e', bad: '#ff8f8f', good: '#7ddc8a' };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

class Tabs {
    constructor(opts) {
        this.o = opts || {};
        this.tab = 0;
        this.zone = 'page';                         // where the focus is: 'tabs', or 'page' (a row of it)
        this.at = { games: 0, settings: 0 };        // the row the focus is on
        this.top = { games: 0, settings: 0 };       // the first row shown
        this.sub = 0;                               // Games: 0 the game itself, 1 its "Start over"
        this.fit = 6;                               // rows a page holds (draw() knows)
        this.rev = 0;
    }

    get name() { return TABS[this.tab][0]; }

    /** the rows of the page the tab shows */
    rows() {
        if (this.name === 'games') {
            const cur = this.o.current ? this.o.current() : null;
            const rows = (this.o.games ? this.o.games() : []).map((g) => ({ game: g }));
            if (cur) rows.unshift({ game: cur, last: true });
            return rows;
        }
        if (this.name === 'settings') {
            const s = this.o.settings;
            return s ? s.schema.filter((it) => (s.shown ? s.shown(it) : !it.hidden)).map((it) => ({ item: it })) : [];
        }
        return [];
    }

    /** shows the page `name`, the focus on its rows (on the tabs, for a page without rows) */
    open(name) {
        const i = TABS.findIndex((t) => t[0] === name);
        if (i < 0) return;
        this.tab = i;
        this.sub = 0;
        if (name === 'games') this.at.games = this.top.games = 0;      // (the game to carry on with)
        this.zone = this.rows().length ? 'page' : 'tabs';
        this.rev++;
    }

    _tab(i) {
        if (i === this.tab) return;
        this.tab = i;
        this.sub = 0;
        if (this.zone === 'page' && !this.rows().length) this.zone = 'tabs';
        if (this.o.onTab) this.o.onTab(this.name);
    }

    /** a setting's value d further along its list (a switch: on to the right, off to the left, the other on a press) */
    _step(item, d, pressed) {
        const s = this.o.settings;
        if (item.type === 'bool') return s.set(item.key, pressed ? !s.get(item.key) : d > 0);
        const list = item.type === 'choice' ? (item.options || []).map((o) => o[0]) : item.steps || [];
        if (!list.length) return null;
        const i = list.indexOf(s.get(item.key));
        // (a press goes round; a push stops at the ends)
        const to = pressed ? ((i < 0 ? 0 : i + 1) % list.length) : clamp((i < 0 ? 0 : i) + d, 0, list.length - 1);
        return to === i ? null : s.set(item.key, list[to]);
    }

    input(ev) {
        if (!ev) return;
        const n = TABS.length, name = this.name;
        if (ev.tab) this._tab((((this.tab + ev.tab) % n) + n) % n);
        else if (this.zone === 'tabs') {
            if (ev.turn) this._tab(clamp(this.tab + ev.turn, 0, n - 1));
            else if (ev.push === 'E') this._tab(clamp(this.tab + 1, 0, n - 1));
            else if (ev.push === 'W') this._tab(clamp(this.tab - 1, 0, n - 1));
            else if ((ev.push === 'S' || ev.press) && this.rows().length) this.zone = 'page';
        } else {
            const rows = this.rows(), last = rows.length - 1;
            if (last < 0) this.zone = 'tabs';
            else {
                const at = clamp(this.at[name], 0, last), row = rows[at];
                if (ev.turn) { this.at[name] = clamp(at + ev.turn, 0, last); this.sub = 0; }
                else if (ev.push === 'N') { if (at === 0) this.zone = 'tabs'; else this.at[name] = at - 1; this.sub = 0; }
                else if (ev.push === 'S') { this.at[name] = clamp(at + 1, 0, last); this.sub = 0; }
                else if (ev.push === 'E' || ev.push === 'W') {
                    if (row.game) this.sub = ev.push === 'E' ? 1 : 0;
                    else this._step(row.item, ev.push === 'E' ? 1 : -1, false);
                } else if (ev.press) {
                    if (row.game) { const fresh = this.sub === 1; this.sub = 0; if (this.o.onPlay) this.o.onPlay(row.game, fresh); }
                    else this._step(row.item, 1, true);
                }
            }
        }
        this.rev++;
    }

    /**
     * Draws the tabs and the page on r (a kit Recorder): laid out 1600 wide and hl high, shown k times as big
     * with its top left corner at x0, y0. info: { notice: a line to tell beside the tabs, bad: it is an error }
     */
    draw(r, x0, y0, k, hl, info) {
        const X = (x) => Math.round(x0 + x * k), Y = (y) => Math.round(y0 + y * k), S = (v) => Math.max(1, Math.round(v * k));
        const text = (t, x, y, size, c, o) => r.text(t, X(x), Y(y), size * k, c, o);
        const width = (t, size, o) => r.textWidth(t, size * k, o) / k;
        const fits = (t, size, max, o) => {
            let s = String(t);
            if (width(s, size, o) <= max) return s;
            while (s.length > 1 && width(s + '...', size, o) > max) s = s.slice(0, -1);
            return s.trim() + '...';
        };
        const name = this.name;

        /* the tabs */
        let x = 40;
        TABS.forEach((t, i) => {
            const w = Math.ceil(width(t[1], 30, { font: 'bold' })) + 72, sel = i === this.tab;
            r.roundRect(X(x), Y(14), S(w), S(52), S(26), sel ? C.lit : C.btn);
            if (!sel) r.strokeRoundRect(X(x), Y(14), S(w), S(52), S(26), S(2), C.edge);
            else if (this.zone === 'tabs') r.strokeRoundRect(X(x - 6), Y(8), S(w + 12), S(64), S(32), S(3), C.key);
            text(t[1], x + w / 2, 51, 30, sel ? C.key : C.text, { align: 'center', font: 'bold' });
            x += w + 18;
        });
        if (info && info.notice) text(fits(info.notice, 24, W - 40 - x - 30, { literal: true }), W - 40, 49, 24, info.bad ? C.bad : C.dim, { align: 'right', literal: true });
        r.fillRect(X(40), Y(HEAD - 4), S(W - 80), S(2), C.edge);

        const top = HEAD + 8;
        if (name === 'add') { if (this.o.drawAdd) this.o.drawAdd(r, x0, y0 + top * k, k, hl - top); return; }

        /* the rows */
        const rows = this.rows(), n = Math.max(1, Math.floor((hl - top - 4 + GAP) / (ROW + GAP)));
        this.fit = n;
        if (!rows.length) {
            if (name === 'games') {
                text('No games yet', 40, top + 60, 40, C.text, { font: 'bold' });
                text('Send your .nes files from a phone: the tab "Add games".', 40, top + 116, 28, C.dim);
                text('Or put them in a folder "nes" on a USB stick.', 40, top + 158, 28, C.dim);
            }
            return;
        }
        const at = this.at[name] = clamp(this.at[name], 0, rows.length - 1);
        let first = clamp(this.top[name], 0, Math.max(0, rows.length - n));
        if (at < first) first = at;
        if (at > first + n - 1) first = at - n + 1;
        this.top[name] = first;
        const more = rows.length > n, right = more ? W - 62 : W - 40;
        for (let i = first; i < Math.min(rows.length, first + n); i++) {
            const row = rows[i], y = top + (i - first) * (ROW + GAP), on = this.zone === 'page' && i === at, mid = y + ROW / 2 + 10;
            r.roundRect(X(40), Y(y), S(right - 40), S(ROW), S(12), on ? C.btn : C.row);
            if (on) { r.strokeRoundRect(X(40), Y(y), S(right - 40), S(ROW), S(12), S(3), C.key); r.roundRect(X(40), Y(y + 10), S(8), S(ROW - 20), S(4), C.lit); }
            if (row.game) {
                // the focus on a game: what a press does, and beside it the way to its beginning
                let end = right - 20;
                if (on) {
                    const chip = (label, lit) => {
                        const w = Math.ceil(width(label, 24, { font: 'bold' })) + 44;
                        end -= w;
                        r.roundRect(X(end), Y(y + 9), S(w), S(ROW - 18), S((ROW - 18) / 2), lit ? C.lit : C.row);
                        if (!lit) r.strokeRoundRect(X(end), Y(y + 9), S(w), S(ROW - 18), S((ROW - 18) / 2), S(2), C.edge);
                        text(label, end + w / 2, y + ROW / 2 + 8, 24, lit ? C.key : C.text, { align: 'center', font: 'bold' });
                        end -= 12;
                    };
                    chip('Start over', this.sub === 1);
                    chip(row.last ? 'Continue' : 'Play', this.sub === 0);
                } else if (row.last) end -= text('played last', end, mid - 2, 22, C.dim, { align: 'right' }) / k + 16;
                text(fits(row.game.title, 30, end - 76, { font: 'bold', literal: true }), 68, mid, 30, on || row.last ? C.key : C.text, { font: 'bold', literal: true });
            } else {
                const it = row.item, s = this.o.settings, v = s.get(it.key);
                let end = right - 24;
                if (it.type === 'bool') {
                    // a switch
                    const sw = 76, sh = 36;
                    r.roundRect(X(end - sw), Y(y + (ROW - sh) / 2), S(sw), S(sh), S(sh / 2), v ? C.lit : C.edge);
                    r.circle(X(v ? end - sh / 2 : end - sw + sh / 2), Y(y + ROW / 2), S(sh / 2 - 5), C.key);
                    end -= sw + 16;
                    end -= text(v ? 'On' : 'Off', end, mid - 2, 24, v ? C.text : C.dim, { align: 'right' }) / k + 20;
                } else {
                    const shown = fits(s.display ? s.display(it.key) : String(v), 26, 560, { literal: true });
                    end -= text(shown, end, mid - 1, 26, on ? C.key : C.text, { align: 'right', literal: true }) / k + 20;
                }
                text(fits(it.label, 28, end - 76), 68, mid - 1, 28, on ? C.key : C.text);
            }
        }
        if (more) {
            // where the page is in the list
            const h = n * (ROW + GAP) - GAP, bar = Math.max(40, h * n / rows.length), off = (h - bar) * first / (rows.length - n);
            r.roundRect(X(W - 50), Y(top), S(8), S(h), S(4), C.row);
            r.roundRect(X(W - 50), Y(top + off), S(8), S(bar), S(4), C.edge);
        }
    }
}

module.exports = { Tabs, TABS, HEAD, ROW, GAP };
