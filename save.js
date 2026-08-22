/* TIDEHOLM — saving local games.
   Loaded by the browser via <script src="save.js"> and by the tests via require().

   The board is fully determined by the seed, so it is not stored: only the seed
   plus a fingerprint of what the board should look like. On load the board is
   regenerated and checked against that fingerprint. If board generation ever
   changes, old saves are rejected out loud instead of silently loading a game
   whose settlements sit on the wrong hexes. That drops a save from 18 KB to
   about 1.5 KB, which also keeps it well clear of storage quotas. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.SAVE = factory(root.ENGINE);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  var KEY = 'tideholm_save';
  var FORMAT = 1;

  /* Fields that are NOT part of the saved snapshot. `board` is rebuilt from the
     seed; everything else in the game object is stored verbatim. */
  var DERIVED = { board: 1 };

  var store = null;   // injected, so tests can run without a browser
  function storage() {
    if (store) return store;
    try {
      if (typeof localStorage === 'undefined') return null;
      localStorage.setItem('tideholm_probe', '1');
      localStorage.removeItem('tideholm_probe');
      return localStorage;
    } catch (e) { return null; }   // private mode, or storage disabled
  }
  function attach(s) { store = s; }

  /* ---------- board fingerprint ---------- */
  function fingerprint(board) {
    var parts = [];
    board.hexes.forEach(function (h) { parts.push(h.q + ',' + h.r + ',' + h.terrain + ',' + h.num); });
    board.ports.forEach(function (p) { parts.push(p.edge + ',' + p.type); });
    var str = parts.join(';');
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }

  /* ---------- shape validation ----------
     A save is user-editable text in localStorage. Everything below is checked
     before the state is handed to the engine. */
  var REQUIRED = ['seed', 'code', 'mode', 'target', 'players', 'buildings', 'roads',
    'robber', 'bank', 'dev', 'phase', 'turn'];

  function validate(g) {
    if (!g || typeof g !== 'object') return 'not an object';
    for (var i = 0; i < REQUIRED.length; i++) {
      if (g[REQUIRED[i]] === undefined) return 'missing field: ' + REQUIRED[i];
    }
    if (!Array.isArray(g.players) || g.players.length < 2 || g.players.length > 6) return 'bad player count';
    if (!Array.isArray(g.dev)) return 'bad development deck';
    if (typeof g.seed !== 'number' || !isFinite(g.seed)) return 'bad seed';
    if (typeof g.turn !== 'number' || g.turn < 0 || g.turn >= g.players.length) return 'turn out of range';
    if (typeof g.robber !== 'number' || g.robber < 0 || g.robber > 18) return 'raider off the board';

    var okPhase = ['lobby', 'setup', 'roll', 'main', 'robber', 'discard', 'over'];
    if (okPhase.indexOf(g.phase) < 0) return 'unknown phase: ' + g.phase;

    for (var p = 0; p < g.players.length; p++) {
      var pl = g.players[p];
      if (!pl || typeof pl.name !== 'string' || !pl.hand) return 'player ' + p + ' is malformed';
      for (var r = 0; r < E.RES.length; r++) {
        var n = pl.hand[E.RES[r]];
        if (typeof n !== 'number' || n < 0 || n > 60) return 'player ' + p + ' has an impossible hand';
      }
      if (!Array.isArray(pl.dev) || !Array.isArray(pl.newDev)) return 'player ' + p + ' has malformed cards';
    }

    // resources are conserved: 19 of each across bank and all hands
    for (var k = 0; k < E.RES.length; k++) {
      var res = E.RES[k], sum = g.bank[res];
      if (typeof sum !== 'number') return 'bank is malformed';
      g.players.forEach(function (pl2) { sum += pl2.hand[res]; });
      if (sum !== 19) return res + ' does not add up (' + sum + ' of 19) — the save has been edited or corrupted';
    }
    return null;
  }

  /* ---------- write ---------- */
  function snapshot(g) {
    var out = {};
    for (var k in g) if (!DERIVED[k]) out[k] = g[k];
    return out;
  }

  function write(g) {
    var s = storage();
    if (!s) return { ok: false, error: 'This browser will not let the game store anything.' };
    if (!g || g.mode !== 'local') return { ok: false, error: 'Only local games are saved.' };
    var entry = {
      format: FORMAT,
      ts: Date.now(),
      fp: fingerprint(g.board),
      game: snapshot(g)
    };
    try {
      s.setItem(KEY, JSON.stringify(entry));
      return { ok: true, bytes: JSON.stringify(entry).length };
    } catch (e) {
      return { ok: false, error: 'Storage is full or unavailable.' };
    }
  }

  /* ---------- read ---------- */
  function raw() {
    var s = storage();
    if (!s) return null;
    try {
      var txt = s.getItem(KEY);
      if (!txt) return null;
      return JSON.parse(txt);
    } catch (e) { return null; }
  }

  function read() {
    var entry = raw();
    if (!entry) return { ok: false, reason: 'none' };
    if (entry.format !== FORMAT) {
      return { ok: false, reason: 'format', message: 'That saved game is from an older version of Tideholm and cannot be opened.' };
    }
    var g = entry.game;
    var bad = validate(g);
    if (bad) return { ok: false, reason: 'invalid', message: 'That saved game could not be read: ' + bad };

    // rebuild the board from the seed and prove it is the same board
    var fresh;
    try { fresh = E.createGame({ code: g.code, seed: g.seed, mode: g.mode, target: g.target }); }
    catch (e) { return { ok: false, reason: 'invalid', message: 'That saved game could not be rebuilt.' }; }

    if (fingerprint(fresh.board) !== entry.fp) {
      return {
        ok: false, reason: 'drift',
        message: 'That saved game was made by a different version of the board generator, so its settlements no longer line up. It cannot be opened.'
      };
    }

    var out = fresh;
    for (var k in g) if (!DERIVED[k]) out[k] = g[k];

    // final sanity: every building and road must sit on a real place
    var keys = Object.keys(out.buildings);
    for (var i = 0; i < keys.length; i++) {
      if (!out.board.verts[keys[i]]) return { ok: false, reason: 'invalid', message: 'That saved game refers to a place that is not on the board.' };
    }
    var ekeys = Object.keys(out.roads);
    for (var j = 0; j < ekeys.length; j++) {
      if (!out.board.edges[ekeys[j]]) return { ok: false, reason: 'invalid', message: 'That saved game refers to a road that is not on the board.' };
    }
    return { ok: true, game: out, meta: describe(entry) };
  }

  /* ---------- summary for the title screen ---------- */
  function describe(entry) {
    entry = entry || raw();
    if (!entry || !entry.game) return null;
    var g = entry.game;
    var humans = [], bots = [];
    g.players.forEach(function (p) { (p.bot ? bots : humans).push(p); });
    var leader = null, best = -1;
    g.players.forEach(function (p) {
      var vp = 0;
      for (var k in g.buildings) if (g.buildings[k].p === g.players.indexOf(p)) vp += g.buildings[k].type === 'city' ? 2 : 1;
      if (vp > best) { best = vp; leader = p; }
    });
    var levels = {};
    bots.forEach(function (b) { levels[b.level] = 1; });
    return {
      ts: entry.ts,
      when: relative(entry.ts),
      players: g.players.length,
      humans: humans.length,
      bots: bots.length,
      levels: Object.keys(levels),
      phase: g.phase,
      solo: humans.length === 1 && bots.length > 0,
      names: g.players.map(function (p) { return p.name; }),
      leader: leader ? leader.name : null,
      leaderPoints: best,
      bytes: JSON.stringify(entry).length
    };
  }

  function relative(ts) {
    var d = Date.now() - ts;
    if (d < 60000) return 'just now';
    if (d < 3600000) return Math.round(d / 60000) + ' min ago';
    if (d < 86400000) { var h = Math.round(d / 3600000); return h + (h === 1 ? ' hour ago' : ' hours ago'); }
    var days = Math.round(d / 86400000);
    return days + (days === 1 ? ' day ago' : ' days ago');
  }

  function clear() {
    var s = storage();
    if (!s) return false;
    try { s.removeItem(KEY); return true; } catch (e) { return false; }
  }

  function exists() { return !!raw(); }

  return {
    KEY: KEY, FORMAT: FORMAT,
    attach: attach, write: write, read: read, clear: clear, exists: exists,
    describe: describe, validate: validate, fingerprint: fingerprint, snapshot: snapshot
  };
});
