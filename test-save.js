/* Save tests.
   A save is plain text sitting in localStorage where anyone can edit it, and it
   outlives the code that wrote it. Both of those are checked here. */
var E = require('./engine.js');
var B = require('./bot.js');
var S = require('./save.js');

var pass = 0, fail = 0, fails = [];
function ok(c, m) { if (c) pass++; else { fail++; fails.push(m); } }
function eq(a, b, m) { ok(a === b, m + ' (got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b) + ')'); }

/* ---------- fake storage ---------- */
function fakeStore(opts) {
  opts = opts || {};
  var db = {};
  return {
    _db: db,
    getItem: function (k) { return db[k] === undefined ? null : db[k]; },
    setItem: function (k, v) {
      if (opts.full) { var e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
      db[k] = String(v);
    },
    removeItem: function (k) { delete db[k]; }
  };
}
S.attach(fakeStore());

/* ---------- build a game partway through ---------- */
function midGame(seed, specs, turns) {
  var g = E.createGame({ code: 'LOCAL', mode: 'local', seed: seed });
  specs.forEach(function (sp, i) { E.addPlayer(g, sp.name, 'L' + i, { bot: sp.bot, level: sp.level }); });
  E.startGame(g);
  var guard = 0;
  while (g.phase !== 'over' && guard++ < (turns || 400)) {
    var acted = false;
    for (var s = 0; s < g.players.length && !acted; s++) {
      var a = B.act(E.redact(g, g.players[s].id), s, g.players[s].level || 'steady');
      if (!a) continue;
      var r = E.applyAction(g, s, a);
      if (!r.ok && g.phase === 'main' && g.turn === s) E.applyAction(g, s, { type: 'endTurn' });
      acted = true;
    }
    if (!acted) break;
  }
  return g;
}

var SPECS = [
  { name: 'You', bot: false },
  { name: 'Marn', bot: true, level: 'steady' },
  { name: 'Ossic', bot: true, level: 'sharp' },
  { name: 'Vell', bot: true, level: 'casual' }
];

/* ---------- 1. round trip is lossless ---------- */
(function () {
  for (var seed = 0; seed < 8; seed++) {
    S.attach(fakeStore());
    var g = midGame(seed, SPECS, 60 + seed * 30);
    var w = S.write(g);
    ok(w.ok, 'seed ' + seed + ': save written');

    var r = S.read();
    ok(r.ok, 'seed ' + seed + ': save read back' + (r.ok ? '' : ' — ' + r.message));
    if (!r.ok) continue;
    var back = r.game;

    // every field except the rebuilt board must be identical
    var fields = Object.keys(g).filter(function (k) { return k !== 'board'; });
    var diffs = fields.filter(function (k) { return JSON.stringify(g[k]) !== JSON.stringify(back[k]); });
    eq(diffs.length, 0, 'seed ' + seed + ': no field changed across a save/load (' + diffs.join(', ') + ')');

    // the rebuilt board must be identical too
    eq(JSON.stringify(back.board), JSON.stringify(g.board), 'seed ' + seed + ': rebuilt board matches exactly');

    // hidden state survives — the dev deck order matters for future draws
    eq(JSON.stringify(back.dev), JSON.stringify(g.dev), 'seed ' + seed + ': development deck order preserved');
    back.players.forEach(function (p, i) {
      eq(JSON.stringify(p.hand), JSON.stringify(g.players[i].hand), 'seed ' + seed + ': player ' + i + ' hand preserved');
      eq(JSON.stringify(p.dev), JSON.stringify(g.players[i].dev), 'seed ' + seed + ': player ' + i + ' cards preserved');
      eq(p.bot, g.players[i].bot, 'seed ' + seed + ': player ' + i + ' bot flag preserved');
      eq(p.level, g.players[i].level, 'seed ' + seed + ': player ' + i + ' difficulty preserved');
    });
    eq(back.rollSeq, g.rollSeq, 'seed ' + seed + ': dice stream position preserved');
  }
})();

/* ---------- 2. a resumed game plays on identically ---------- */
(function () {
  for (var seed = 0; seed < 5; seed++) {
    S.attach(fakeStore());
    var g = midGame(100 + seed, SPECS, 80);
    if (g.phase === 'over') continue;
    S.write(g);
    var resumed = S.read().game;

    function runOn(state, steps) {
      var log = [];
      for (var n = 0; n < steps && state.phase !== 'over'; n++) {
        var acted = false;
        for (var s = 0; s < state.players.length && !acted; s++) {
          var a = B.act(E.redact(state, state.players[s].id), s, state.players[s].level || 'steady');
          if (!a) continue;
          var r = E.applyAction(state, s, a);
          if (!r.ok && state.phase === 'main' && state.turn === s) E.applyAction(state, s, { type: 'endTurn' });
          log.push(s + ':' + a.type + ':' + (state.dice ? state.dice.join('') : ''));
          acted = true;
        }
        if (!acted) break;
      }
      return log;
    }
    var a1 = runOn(g, 80).join('|');
    var a2 = runOn(resumed, 80).join('|');
    eq(a2, a1, 'seed ' + (100 + seed) + ': resumed game continues move for move identically');
  }
})();

/* ---------- 3. corrupted and tampered saves are refused ---------- */
(function () {
  function loadWith(mutate) {
    var st = fakeStore();
    S.attach(st);
    var g = midGame(42, SPECS, 70);
    S.write(g);
    var entry = JSON.parse(st.getItem(S.KEY));
    mutate(entry, g);
    st.setItem(S.KEY, JSON.stringify(entry));
    return S.read();
  }

  var cases = [
    ['truncated json', function (e) {}, null],
    ['wrong format version', function (e) { e.format = 99; }, 'format'],
    ['tampered board fingerprint', function (e) { e.fp = 'zzzz'; }, 'drift'],
    ['missing players', function (e) { delete e.game.players; }, 'invalid'],
    ['turn out of range', function (e) { e.game.turn = 9; }, 'invalid'],
    ['unknown phase', function (e) { e.game.phase = 'banana'; }, 'invalid'],
    ['raider off the board', function (e) { e.game.robber = 99; }, 'invalid'],
    ['negative hand', function (e) { e.game.players[0].hand.ore = -3; }, 'invalid'],
    ['invented resources', function (e) { e.game.players[0].hand.ore += 7; }, 'invalid'],
    ['settlement on a place that does not exist', function (e) { e.game.buildings['999:999'] = { p: 0, type: 'city' }; }, 'invalid'],
    ['road that does not exist', function (e) { e.game.roads['a|b'] = 0; }, 'invalid'],
    ['one player only', function (e) { e.game.players = [e.game.players[0]]; }, 'invalid'],
    ['bad seed', function (e) { e.game.seed = 'hello'; }, 'invalid']
  ];
  cases.forEach(function (c) {
    if (c[0] === 'truncated json') {
      var st = fakeStore(); S.attach(st);
      S.write(midGame(42, SPECS, 70));
      st.setItem(S.KEY, st.getItem(S.KEY).slice(0, 120));
      var r0 = S.read();
      ok(!r0.ok, 'refuses a truncated save');
      return;
    }
    var r = loadWith(c[1]);
    ok(!r.ok, 'refuses: ' + c[0]);
    if (c[2]) eq(r.reason, c[2], c[0] + ' is reported as "' + c[2] + '"');
    if (!r.ok && r.reason !== 'none') ok(!!r.message && r.message.length > 20, c[0] + ' explains itself to the player');
  });

  // the cheat that matters: hand yourself a winning position
  var st2 = fakeStore(); S.attach(st2);
  var g2 = midGame(43, SPECS, 70);
  S.write(g2);
  var e2 = JSON.parse(st2.getItem(S.KEY));
  e2.game.players[0].hand = { timber: 20, clay: 20, fleece: 20, grain: 20, ore: 20 };
  st2.setItem(S.KEY, JSON.stringify(e2));
  var r2 = S.read();
  ok(!r2.ok, 'refuses a save where someone has given themselves resources');
  ok(/add up/.test(r2.message || ''), 'and says the resources do not add up');
})();

/* ---------- 4. storage that is missing, full, or empty ---------- */
(function () {
  S.attach(fakeStore());
  eq(S.exists(), false, 'no save reported when storage is empty');
  eq(S.read().reason, 'none', 'reading an empty store reports "none" rather than an error');

  S.attach(fakeStore({ full: true }));
  var w = S.write(midGame(7, SPECS, 40));
  eq(w.ok, false, 'a full quota is reported, not thrown');
  ok(/full|unavailable/i.test(w.error), 'and explains why');

  S.attach(null);
  // with no storage attached and no localStorage in Node, everything degrades quietly
  eq(S.exists(), false, 'no storage at all reports no save');
  eq(S.write(midGame(8, SPECS, 40)).ok, false, 'writing with no storage fails cleanly');
  ok(S.clear() === false, 'clearing with no storage fails cleanly');
})();

/* ---------- 5. only local games are saved ---------- */
(function () {
  S.attach(fakeStore());
  var remote = E.createGame({ code: 'ABCD', mode: 'remote', seed: 3 });
  E.addPlayer(remote, 'A', 'a'); E.addPlayer(remote, 'B', 'b');
  E.startGame(remote);
  eq(S.write(remote).ok, false, 'remote games are not written to local storage');
})();

/* ---------- 6. clear, and the summary shown on the title screen ---------- */
(function () {
  S.attach(fakeStore());
  var g = midGame(11, SPECS, 90);
  S.write(g);
  ok(S.exists(), 'save exists after writing');
  var m = S.describe();
  eq(m.players, 4, 'summary counts the players');
  eq(m.humans, 1, 'summary counts the humans');
  eq(m.bots, 3, 'summary counts the bots');
  eq(m.solo, true, 'summary recognises a solo game');
  ok(m.levels.length >= 1, 'summary lists the difficulty levels in play');
  ok(m.bytes < 6000, 'a save is small (' + m.bytes + ' bytes, board rebuilt from the seed)');
  ok(/just now|min ago/.test(m.when), 'summary says when it was saved (' + m.when + ')');
  ok(m.names.indexOf('You') >= 0, 'summary lists player names');

  S.clear();
  eq(S.exists(), false, 'clear removes the save');
  eq(S.read().reason, 'none', 'reading after clear reports none');
})();

/* ---------- 7. pass-and-play games save too ---------- */
(function () {
  S.attach(fakeStore());
  var g = midGame(21, [{ name: 'A' }, { name: 'B' }, { name: 'C' }], 70);
  ok(S.write(g).ok, 'a pass-and-play game can be saved');
  var m = S.describe();
  eq(m.bots, 0, 'summary shows no bots');
  eq(m.solo, false, 'summary does not call it solo');
  ok(S.read().ok, 'a pass-and-play game reloads');
})();

/* ---------- 8. a finished game round-trips without breaking ---------- */
(function () {
  S.attach(fakeStore());
  var g = midGame(31, SPECS, 20000);
  if (g.phase === 'over') {
    ok(S.write(g).ok, 'a finished game can be written');
    var r = S.read();
    ok(r.ok, 'a finished game reloads');
    eq(r.game.winner, g.winner, 'the winner survives the round trip');
    eq(r.game.phase, 'over', 'the finished phase survives');
  } else { ok(true, 'skipped: game did not finish in the step budget'); }
})();

/* ---------- 9. saving mid-interrupt ----------
   Closing the tab during a discard, an open trade offer, the raider step or
   setup is the case a naive save gets wrong: those phases carry state outside
   the normal turn loop. */
(function () {
  var wanted = { discard: 0, robber: 0, setup: 0, trade: 0 };
  var checked = { discard: 0, robber: 0, setup: 0, trade: 0 };

  for (var seed = 0; seed < 30; seed++) {
    var g = E.createGame({ code: 'LOCAL', mode: 'local', seed: 500 + seed });
    SPECS.forEach(function (sp, i) { E.addPlayer(g, sp.name, 'L' + i, { bot: sp.bot, level: sp.level }); });
    E.startGame(g);
    var guard = 0;
    while (g.phase !== 'over' && guard++ < 600) {
      var tag = g.trade ? 'trade' : (g.phase === 'discard' ? 'discard' :
        g.phase === 'robber' ? 'robber' : g.phase === 'setup' ? 'setup' : null);

      if (tag && checked[tag] < 6) {
        checked[tag]++;
        S.attach(fakeStore());
        var w = S.write(g);
        ok(w.ok, 'save written during ' + tag);
        var r = S.read();
        ok(r.ok, 'save read back during ' + tag + (r.ok ? '' : ' — ' + r.message));
        if (r.ok) {
          var back = r.game;
          eq(back.phase, g.phase, tag + ': phase preserved');
          eq(JSON.stringify(back.pendingDiscard), JSON.stringify(g.pendingDiscard), tag + ': outstanding discards preserved');
          eq(JSON.stringify(back.trade), JSON.stringify(g.trade), tag + ': open trade offer preserved');
          eq(back.setupStep, g.setupStep, tag + ': setup position preserved');
          eq(back.robber, g.robber, tag + ': raider position preserved');
          eq(back.freeRoads, g.freeRoads, tag + ': unspent free roads preserved');
          eq(back.playedDevThisTurn, g.playedDevThisTurn, tag + ': dev-card-this-turn flag preserved');
          eq(back.offersThisTurn, g.offersThisTurn, tag + ': trade offer count preserved');

          // and the resumed game must accept the very next move the original does
          var seat = -1, action = null;
          for (var q = 0; q < g.players.length && !action; q++) {
            var a = B.act(E.redact(g, g.players[q].id), q, g.players[q].level || 'steady');
            if (a) { seat = q; action = a; }
          }
          if (action) {
            var r1 = E.applyAction(g, seat, JSON.parse(JSON.stringify(action)));
            var r2 = E.applyAction(back, seat, JSON.parse(JSON.stringify(action)));
            eq(r2.ok, r1.ok, tag + ': the next move is judged the same after resuming');
            eq(JSON.stringify(back.buildings), JSON.stringify(g.buildings), tag + ': boards agree after the next move');
            eq(back.phase, g.phase, tag + ': phases agree after the next move');
            wanted[tag]++;
            continue;
          }
        }
      }

      var acted = false;
      for (var sI = 0; sI < g.players.length && !acted; sI++) {
        var act2 = B.act(E.redact(g, g.players[sI].id), sI, g.players[sI].level || 'steady');
        if (!act2) continue;
        var rr = E.applyAction(g, sI, act2);
        if (!rr.ok && g.phase === 'main' && g.turn === sI) E.applyAction(g, sI, { type: 'endTurn' });
        acted = true;
      }
      if (!acted) break;
    }
  }
  ok(checked.setup >= 3, 'exercised saving during setup (' + checked.setup + ')');
  ok(checked.robber >= 3, 'exercised saving during the raider step (' + checked.robber + ')');
  ok(checked.discard >= 1, 'exercised saving during a discard (' + checked.discard + ')');
  ok(checked.trade >= 1, 'exercised saving with a trade offer open (' + checked.trade + ')');
})();

console.log('\nPASS ' + pass + '   FAIL ' + fail);
if (fail) { fails.slice(0, 25).forEach(function (f) { console.log('  ✗ ' + f); }); process.exit(1); }
