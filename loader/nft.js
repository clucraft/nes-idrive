'use strict';
/**
 * nft.js - the page's port through the head unit's firewall, for as long as the page is open.
 *
 * The firewall drops what no rule accepts, and a packet has to get past every table that looks at it: the
 * head unit's own, and the MGU Store's uplink's when that is installed. So while the page is open, each
 * IPv4 chain that packets come in through gets one rule at its top for each car Wi-Fi interface,
 *
 *     iifname "<interface>" tcp dport <port> accept
 *
 * and each chain they leave through gets the same for the answers (oifname, sport). Every rule carries the
 * comment TAG. shut() deletes whatever has that comment, wherever it is, so the firewall is as it was after
 * the page closes, after a crash (the service's ExecStopPost) and when the loader is removed.
 *
 * Part of the NES game loader (nes-idrive, GPL-2.0-or-later). Runs as root on the head unit's Node 8.
 */
const { execFileSync } = require('child_process');

const TAG = 'clucraft-nes-loader';

/** runs nft with these words; no core file if it dies (the head unit restarts for one it does not know) */
function nft(words, program) {
    return execFileSync('/bin/sh', ['-c', 'ulimit -c 1; exec "$0" "$@"', program || 'nft'].concat(words),
        { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * The chains of `nft -a list ruleset` that packets enter or leave through:
 * [{ family, table, chain, hook, mine: [the handles of our rules there] }]
 */
function chains(listing) {
    const found = [];
    let family = null, table = null, chain = null;
    String(listing).split('\n').forEach((raw) => {
        const line = raw.trim();
        let m = /^table\s+(\S+)\s+(\S+)\s*\{/.exec(line);           // ("-a" adds "# handle n" after it)
        if (m) { family = m[1]; table = m[2]; chain = null; return; }
        m = /^chain\s+(\S+)\s*\{/.exec(line);
        if (m && table) { chain = { family, table, chain: m[1], hook: null, mine: [] }; found.push(chain); return; }
        if (!chain) return;
        m = /\bhook\s+(\w+)\b/.exec(line);
        if (m && /^type\s/.test(line)) { chain.hook = m[1]; return; }
        m = /#\s*handle\s+(\d+)$/.exec(line);
        if (m && line.indexOf('comment "' + TAG + '"') >= 0) chain.mine.push(m[1]);
    });
    return found;
}

/** the rules a chain needs for these interfaces and this port, as nft's words (an interface named twice, for its two addresses, gets one) */
function rulesFor(hook, interfaces, port) {
    const way = hook === 'input' ? ['iifname', 'dport'] : hook === 'output' ? ['oifname', 'sport'] : null;
    if (!way || !(port > 0 && port < 65536)) return [];
    return interfaces.filter((i, n) => interfaces.indexOf(i) === n && /^[A-Za-z0-9_.:-]{1,15}$/.test(i)).map((i) => [way[0], '"' + i + '"', 'tcp', way[1], String(port), 'accept', 'comment', '"' + TAG + '"']);
}

const ours = (c) => (c.family === 'ip' || c.family === 'inet') && (c.hook === 'input' || c.hook === 'output');

/**
 * Makes sure the port is open on these interfaces, and on no others: called when the page opens and every few
 * seconds while it is (the uplink writes its table anew when its link changes; an interface comes or goes).
 * -> { chains: how many have our rules, changed: bool, errors: [text] }
 */
function open(interfaces, port, opts) {
    const o = opts || {};
    const want = interfaces.slice().sort().join(',') + ':' + port;
    const result = { chains: 0, changed: false, errors: [] };
    let all;
    try { all = chains(nft(['-a', 'list', 'ruleset'], o.program)).filter(ours); } catch (e) { result.errors.push(firstLine(e)); return result; }
    all.forEach((c) => {
        const rules = rulesFor(c.hook, interfaces, port);
        // as wanted already: the right number of our rules, put there for these interfaces and this port
        if (c.mine.length === rules.length && o.last === want) { if (rules.length) result.chains++; return; }
        try {
            c.mine.forEach((h) => nft(['delete', 'rule', c.family, c.table, c.chain, 'handle', h], o.program));
            rules.slice().reverse().forEach((r) => nft(['insert', 'rule', c.family, c.table, c.chain].concat(r), o.program));
            if (rules.length) result.chains++;
            if (c.mine.length || rules.length) result.changed = true;
        } catch (e) { result.errors.push(c.family + ' ' + c.table + ' ' + c.chain + ': ' + firstLine(e)); }
    });
    result.signature = want;
    return result;
}

/** Deletes every rule of ours; -> how many. Never throws. */
function shut(opts) {
    const o = opts || {};
    let n = 0, all = [];
    try { all = chains(nft(['-a', 'list', 'ruleset'], o.program)); } catch (e) { return 0; }
    all.forEach((c) => c.mine.forEach((h) => {
        try { nft(['delete', 'rule', c.family, c.table, c.chain, 'handle', h], o.program); n++; } catch (e) { /* gone with its chain */ }
    }));
    return n;
}

function firstLine(e) { return String((e && (e.stderr || e.message)) || e).trim().split('\n')[0]; }

module.exports = { TAG, chains, rulesFor, open, shut };
