// CommonJS — Vercel Node 20 runtime. Do not convert to ESM.
// Authoritative game server. The full game state lives here; each client is
// only ever sent the redacted view it is entitled to see.
var E = require('../engine.js');

/* ---- credential discovery ----
   Upstash exposes its REST pair under several names depending on whether the
   store was attached as "Upstash Redis", "KV", or a custom integration. Scan
   rather than hard-coding one, so attaching the store just works. */
function creds() {
  var env = process.env;
  var url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || null;
  var tok = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || null;
  if (!url || !tok) {
    Object.keys(env).forEach(function (k) {
      if (!url && /REST_(API_)?URL$/.test(k) && /^https?:/.test(env[k] || '')) url = env[k];
      if (!tok && /REST_(API_)?TOKEN$/.test(k)) tok = env[k];
    });
  }
  return url && tok ? { url: url.replace(/\/$/, ''), tok: tok } : null;
}

function cmd(c, args) {
  return fetch(c.url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + c.tok, 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  }).then(function (r) { return r.json(); });
}

var TTL = 60 * 60 * 24 * 2; // tables expire after two days

function load(c, code) {
  return cmd(c, ['GET', 'tideholm_' + code]).then(function (r) {
    if (!r || r.result == null) return null;
    try { return JSON.parse(r.result); } catch (e) { return null; }
  });
}
function save(c, code, g) {
  return cmd(c, ['SET', 'tideholm_' + code, JSON.stringify(g), 'EX', String(TTL)]);
}

/* Short lock so two players tapping at the same instant cannot both read the
   same state and clobber each other. Turn-based traffic makes contention rare. */
function lock(c, code, tries) {
  tries = tries == null ? 12 : tries;
  return cmd(c, ['SET', 'tideholm_lock_' + code, '1', 'NX', 'PX', '4000']).then(function (r) {
    if (r && r.result === 'OK') return true;
    if (tries <= 0) return false;
    return new Promise(function (res) { setTimeout(res, 90); }).then(function () { return lock(c, code, tries - 1); });
  });
}
function unlock(c, code) { return cmd(c, ['DEL', 'tideholm_lock_' + code]); }

function makeCode() {
  var A = 'ABCDEFGHJKLMNPQRSTUVWXYZ', s = '';
  for (var i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
  return s;
}
function makePid() {
  return 'p' + Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
}
function clean(s, n) { return String(s == null ? '' : s).replace(/[<>&"]/g, '').trim().slice(0, n); }

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only.' }); return; }

  var c = creds();
  if (!c) {
    res.status(500).json({ error: 'No storage is connected. Attach an Upstash Redis store to this Vercel project, then redeploy.' });
    return;
  }

  var body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  var op = body.op;
  var code = clean(body.code, 4).toUpperCase();

  try {
    if (op === 'create') {
      var newCode = null;
      for (var attempt = 0; attempt < 6 && !newCode; attempt++) {
        var candidate = makeCode();
        var exists = await cmd(c, ['EXISTS', 'tideholm_' + candidate]);
        if (exists && exists.result === 0) newCode = candidate;
      }
      if (!newCode) { res.status(503).json({ error: 'Could not open a table. Try again.' }); return; }
      var g = E.createGame({ code: newCode, mode: 'remote', seed: (Math.random() * 1e9) | 0 });
      var pid = makePid();
      E.addPlayer(g, clean(body.name, 14) || 'Host', pid);
      await save(c, newCode, g);
      res.status(200).json({ code: newCode, pid: pid, state: E.redact(g, pid) });
      return;
    }

    if (op === 'state') {
      var gs = await load(c, code);
      if (!gs) { res.status(404).json({ error: 'That table has closed.' }); return; }
      if (body.v && gs.v === body.v) { res.status(200).json({ nochange: true }); return; }
      res.status(200).json({ state: E.redact(gs, clean(body.pid, 40)) });
      return;
    }

    // everything below mutates, so take the lock
    var got = await lock(c, code);
    if (!got) { res.status(200).json({ error: 'Someone else is mid-move. Try again in a moment.' }); return; }

    try {
      var g2 = await load(c, code);
      if (!g2) { res.status(404).json({ error: 'That table has closed.' }); return; }
      var mypid = clean(body.pid, 40);
      var result = { ok: true };

      if (op === 'join') {
        var seated = -1;
        for (var i = 0; i < g2.players.length; i++) if (g2.players[i].id === mypid) seated = i;
        if (seated >= 0) {
          // rejoin from the same device
          res.status(200).json({ pid: mypid, state: E.redact(g2, mypid) });
          return;
        }
        var np = makePid();
        var add = E.addPlayer(g2, clean(body.name, 14) || 'Player', np);
        if (!add.ok) { res.status(200).json({ error: add.error }); return; }
        g2.v++;
        await save(c, code, g2);
        res.status(200).json({ pid: np, state: E.redact(g2, np) });
        return;
      }

      if (op === 'start') {
        if (!g2.players.length || g2.players[0].id !== mypid) { res.status(200).json({ error: 'Only the host can start the game.' }); return; }
        var st = E.startGame(g2);
        if (!st.ok) { res.status(200).json({ error: st.error }); return; }
        g2.v++;
        await save(c, code, g2);
        res.status(200).json({ state: E.redact(g2, mypid) });
        return;
      }

      if (op === 'act') {
        var seat = -1;
        for (var j = 0; j < g2.players.length; j++) if (g2.players[j].id === mypid) seat = j;
        if (seat < 0) { res.status(200).json({ error: 'You are not seated at this table.' }); return; }
        var a = body.action || {};
        result = E.applyAction(g2, seat, a);
        if (result.ok) { g2.v++; await save(c, code, g2); }
        var out = { ok: result.ok, error: result.error, state: E.redact(g2, mypid) };
        // the drawn card is the acting player's to see, and only theirs
        if (result.drew) out.drew = result.drew;
        res.status(200).json(out);
        return;
      }

      res.status(400).json({ error: 'Unknown request.' });
    } finally {
      await unlock(c, code);
    }
  } catch (err) {
    res.status(500).json({ error: 'The server hit a problem: ' + (err && err.message ? err.message : 'unknown') });
  }
};
