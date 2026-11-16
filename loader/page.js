'use strict';
/**
 * page.js - the page a phone opens to send games to the car.
 *
 * The service starts this as its own process, as the NES app's user and not as root: what the page can do
 * is what the app can, write into the app's own folder. It serves, under an address only the QR code on the
 * car's screen tells (http://<car Wi-Fi address>:<port>/<token>/):
 *
 *   GET    /<token>/                 the page
 *   GET    /<token>/games            the games in the app's folder
 *   POST   /<token>/games?name=...   a game (the file as the request's body)
 *   DELETE /<token>/games?name=...   takes one out again
 *
 * Anything else is "not found". It talks to the service over the channel fork() gives a child:
 *   from it   { op: 'listen', addresses: [...] }     the car Wi-Fi's addresses to serve on, whenever they change
 *   to it     { event: 'listening', addresses }, { event: 'saved', name, size, replaced }, { event: 'removed', name },
 *             { event: 'refused', name, why }, { event: 'strangers' } (many requests without the token)
 *
 *   node page.js '{"token": "...", "port": 8493, "dir": "<the games folder>"}'
 *
 * Part of the NES game loader (nes-idrive, GPL-2.0-or-later). Runs on the head unit's Node 8.
 */
const http = require('http');
const crypto = require('crypto');
const querystring = require('querystring');
const games = require('./games');

const STRANGERS = 100;              // requests without the token before the page is closed

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NES games for the car</title>
<style>
  body { font: 17px/1.4 -apple-system, system-ui, sans-serif; margin: 0; padding: 20px; background: #111418; color: #e8eaed; }
  h1 { font-size: 24px; margin: 0 0 6px; }
  h2 { font-size: 18px; margin: 28px 0 8px; color: #aab1ba; }
  p { margin: 6px 0 16px; color: #aab1ba; }
  .pick { display: block; background: #c8102e; color: #fff; text-align: center; padding: 16px; border-radius: 12px; font-weight: 600; }
  .pick input { display: none; }
  ul { list-style: none; margin: 12px 0 0; padding: 0; }
  li { padding: 10px 0; border-bottom: 1px solid #2a3038; display: flex; justify-content: space-between; align-items: center; word-break: break-word; }
  li.ok { color: #7ddc8a; } li.bad { color: #ff8f8f; }
  li small { color: #8c939c; margin-left: 8px; white-space: nowrap; }
  button { font: inherit; background: none; color: #ff8f8f; border: 1px solid #5a3038; border-radius: 8px; padding: 4px 10px; margin-left: 10px; }
</style>
</head>
<body>
<h1>NES games for the car</h1>
<p>Pick .nes files on this phone. They go straight to the NES app.</p>
<label class="pick">Choose games<input id="files" type="file" multiple></label>
<ul id="sent"></ul>
<h2>In the car</h2>
<ul id="games"></ul>
<p id="note">This page works while "Add games" is open on the car's screen.</p>
<script>
(function () {
  var base = location.pathname.replace(/\\/+$/, '') + '/';
  var sent = document.getElementById('sent'), list = document.getElementById('games'), note = document.getElementById('note');
  function size(n) { return n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
  function item(parent, text, cls) { var li = document.createElement('li'); li.textContent = text; if (cls) li.className = cls; parent.appendChild(li); return li; }
  function answer(x) { try { return JSON.parse(x.responseText) || {}; } catch (e) { return {}; } }
  function gone() { note.textContent = 'The page is closed. Open "Add games" in the NES app again and scan the new code.'; }
  function refresh() {
    var x = new XMLHttpRequest();
    x.open('GET', base + 'games');
    x.onload = function () {
      if (x.status !== 200) return gone();
      var a = answer(x);
      list.textContent = '';
      (a.games || []).forEach(function (g) {
        var li = item(list, g.name), s = document.createElement('small'), b = document.createElement('button');
        s.textContent = size(g.size);
        b.textContent = 'Remove';
        b.onclick = function () {
          if (!confirm('Remove ' + g.name + ' from the car?')) return;
          var d = new XMLHttpRequest();
          d.open('DELETE', base + 'games?name=' + encodeURIComponent(g.name));
          d.onload = refresh; d.onerror = gone;
          d.send();
        };
        var right = document.createElement('span');
        right.appendChild(s); right.appendChild(b);
        li.appendChild(right);
      });
      if (!(a.games || []).length) item(list, 'None of your own yet.');
    };
    x.onerror = gone;
    x.send();
  }
  function send(files, i) {
    if (i >= files.length) return refresh();
    var f = files[i], li = item(sent, f.name + ' ...');
    var x = new XMLHttpRequest();
    x.open('POST', base + 'games?name=' + encodeURIComponent(f.name));
    x.upload.onprogress = function (e) { if (e.lengthComputable) li.textContent = f.name + ' ... ' + Math.round(100 * e.loaded / e.total) + ' %'; };
    x.onload = function () {
      var a = answer(x);
      li.className = a.ok ? 'ok' : 'bad';
      li.textContent = a.ok ? a.name + ' is in the car' + (a.replaced ? ' (replaced)' : '') : f.name + ': ' + (a.error || 'not taken');
      send(files, i + 1);
    };
    x.onerror = function () { li.className = 'bad'; li.textContent = f.name + ': the car did not answer'; gone(); };
    x.send(f);
  }
  document.getElementById('files').onchange = function () {
    var files = Array.prototype.slice.call(this.files || []);
    this.value = '';
    send(files, 0);
  };
  refresh();
})();
</script>
</body>
</html>
`;

const CLOSED = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>NES</title></head>' +
    '<body style="font: 17px sans-serif; padding: 20px">Nothing here. Open "Add games" in the NES app on the car\'s screen and scan the code it shows.</body></html>\n';

const HEADERS = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
};

/** opts: { token, port, dir, tell(message) } -> { handle(req, res), listen(addresses), close() } */
function createPage(opts) {
    const tell = opts.tell || (() => {});
    const token = Buffer.from(String(opts.token));
    const servers = new Map();          // address -> http.Server
    let strangers = 0;

    const send = (res, code, type, body) => {
        const data = Buffer.from(body);
        res.writeHead(code, Object.assign({ 'Content-Type': type, 'Content-Length': data.length }, HEADERS));
        res.end(data);
    };
    const json = (res, code, o) => send(res, code, 'application/json; charset=utf-8', JSON.stringify(o) + '\n');

    /** what follows /<token> in the path, or null without the token */
    function inside(pathname) {
        const given = Buffer.from(pathname.slice(1, 1 + token.length));
        if (pathname[0] !== '/' || given.length !== token.length || !crypto.timingSafeEqual(given, token)) return null;
        const rest = pathname.slice(1 + token.length);
        return rest === '' || rest[0] === '/' ? rest : null;
    }

    function receive(req, res, name) {
        if (!games.safeName(name)) { tell({ event: 'refused', name: String(name || '').slice(0, 80), why: 'not a .nes file' }); return json(res, 400, { ok: false, error: 'not a .nes file' }); }
        if (Number(req.headers['content-length']) > games.MAX_GAME) { tell({ event: 'refused', name: games.safeName(name), why: 'too big' }); return json(res, 413, { ok: false, error: 'bigger than ' + (games.MAX_GAME >> 20) + ' MB' }); }
        const parts = [];
        let size = 0, over = false;
        req.on('data', (d) => {
            if (over) return;
            size += d.length;
            if (size > games.MAX_GAME) { over = true; parts.length = 0; json(res, 413, { ok: false, error: 'bigger than ' + (games.MAX_GAME >> 20) + ' MB' }); req.destroy(); return; }
            parts.push(d);
        });
        req.on('error', () => { over = true; });
        req.on('end', () => {
            if (over) return;
            try {
                const saved = games.save(opts.dir, name, Buffer.concat(parts, size));
                tell(Object.assign({ event: 'saved' }, saved));
                json(res, 200, Object.assign({ ok: true }, saved));
            } catch (e) {
                if (e.refused) tell({ event: 'refused', name: games.safeName(name), why: e.message });
                else console.error('nes loader page: saving ' + games.safeName(name) + ': ' + e.message);
                json(res, e.refused ? 400 : 500, { ok: false, error: e.refused ? e.message : 'the car could not save it (' + (e.code || 'error') + ')' });
            }
        });
    }

    function handle(req, res) {
        const url = String(req.url || ''), q = url.indexOf('?');
        const rest = inside(q < 0 ? url : url.slice(0, q));
        if (rest === null) {
            if (++strangers === STRANGERS) tell({ event: 'strangers' });
            return send(res, 404, 'text/html; charset=utf-8', CLOSED);
        }
        const name = q < 0 ? '' : querystring.parse(url.slice(q + 1)).name;
        if (rest === '' && req.method === 'GET') { res.writeHead(302, Object.assign({ Location: '/' + opts.token + '/', 'Content-Length': 0 }, HEADERS)); return res.end(); }
        if (rest === '/' && req.method === 'GET') return send(res, 200, 'text/html; charset=utf-8', HTML);
        if (rest !== '/games') return send(res, 404, 'text/html; charset=utf-8', CLOSED);
        if (req.method === 'GET') return json(res, 200, { games: games.list(opts.dir) });
        if (req.method === 'POST') return receive(req, res, Array.isArray(name) ? name[0] : name);
        if (req.method === 'DELETE') {
            let removed = false;
            try { removed = games.remove(opts.dir, Array.isArray(name) ? name[0] : name); } catch (e) { return json(res, 500, { ok: false, error: 'the car could not remove it (' + (e.code || 'error') + ')' }); }
            if (removed) tell({ event: 'removed', name: games.safeName(name) });
            return json(res, removed ? 200 : 404, { ok: removed });
        }
        res.writeHead(405, Object.assign({ Allow: 'GET, POST, DELETE', 'Content-Length': 0 }, HEADERS));
        res.end();
    }

    /** serves on these addresses, and on no others any more */
    function listen(addresses) {
        const want = (addresses || []).filter((a, i, all) => typeof a === 'string' && all.indexOf(a) === i);
        Array.from(servers.keys()).filter((a) => want.indexOf(a) < 0).forEach((a) => { servers.get(a).close(); servers.delete(a); });
        want.filter((a) => !servers.has(a)).forEach((a) => {
            const server = http.createServer(handle);
            server.maxConnections = 16;
            server.setTimeout(60000);
            server.on('error', (e) => {
                if (servers.get(a) === server) servers.delete(a);
                console.error('nes loader page: ' + a + ':' + opts.port + ': ' + e.message);
                tell({ event: 'listening', addresses: Array.from(servers.keys()).filter((x) => servers.get(x).listening), error: a + ': ' + (e.code || e.message) });
            });
            server.listen(opts.port, a, () => tell({ event: 'listening', addresses: Array.from(servers.keys()).filter((x) => servers.get(x).listening) }));
            servers.set(a, server);
        });
    }

    function close() { servers.forEach((s) => s.close()); servers.clear(); }

    games.sweep(opts.dir);
    return { handle, listen, close };
}

if (require.main === module) {
    let config = null;
    try { config = JSON.parse(process.argv[2]); } catch (e) { /* below */ }
    if (!config || !/^[0-9a-f]{16,64}$/.test(config.token || '') || !(config.port > 0) || typeof config.dir !== 'string') {
        console.error('nes loader page: started without its token, port and folder');
        process.exit(2);
    }
    const page = createPage({ token: config.token, port: config.port, dir: config.dir, tell: (m) => { if (process.connected) process.send(m); } });
    process.on('message', (m) => { if (m && m.op === 'listen') page.listen(m.addresses); });
    // the service is gone: so is the page
    process.on('disconnect', () => { page.close(); process.exit(0); });
    process.on('SIGTERM', () => { page.close(); process.exit(0); });
}

module.exports = { createPage, HTML };
