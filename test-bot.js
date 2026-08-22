/* Bot tests.
   The three things that matter: bots never produce an illegal action, they only
   ever see a redacted view, and the difficulty levels are actually different. */
var E = require('./engine.js');
var B = require('./bot.js');

var pass = 0, fail = 0, fails = [];
function ok(c, m) { if (c) pass++; else { fail++; fails.push(m); } }
function eq(a, b, m) { ok(a === b, m + ' (got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b) + ')'); }

/* ---------- shared driver: mirrors the one in index.html ---------- */
function playGame(seed, levels, opts) {
  opts = opts || {};
  var g = E.createGame({ code: 'BOT', seed: seed });
  levels.forEach(function (l, i) { E.addPlayer(g, 'B' + i, 'b' + i, { bot: true, level: l }); });
  E.startGame(g);

  var guard = 0, illegal = [], leaks = [], actions = 0;
  var counts = { offerTrade: 0, respondTrade: 0, bankTrade: 0, buyDev: 0, playDev: 0, buildCity: 0, buildSettlement: 0, buildRoad: 0, discard: 0, moveRobber: 0 };
  var acceptedTrades = 0;

  while (g.phase !== 'over' && guard++ < 30000) {
    var acted = false;
    for (var seat = 0; seat < g.players.length && !acted; seat++) {
      var view = E.redact(g, g.players[seat].id);

      // information hygiene: the view handed to a bot must hide everyone else
      if (opts.checkLeaks !== false) {
        view.players.forEach(function (p, i) {
          if (i === seat) return;
          if (p.hand !== null) leaks.push('seat ' + seat + ' can see seat ' + i + ' hand');
          if (p.dev !== null) leaks.push('seat ' + seat + ' can see seat ' + i + ' dev cards');
        });
        if (view.dev !== undefined) leaks.push('seat ' + seat + ' can see the dev deck');
      }

      var a = B.act(view, seat, g.players[seat].level);
      if (!a) continue;
      actions++;
      if (counts[a.type] !== undefined) counts[a.type]++;
      var before = g.trade;
      var r = E.applyAction(g, seat, a);
      if (!r.ok) {
        illegal.push('seat ' + seat + ' (' + g.players[seat].level + ') phase ' + g.phase +
          ' action ' + a.type + ' -> ' + r.error);
        // break the loop rather than spin forever on a rejected move
        if (g.phase === 'main' && g.turn === seat) E.applyAction(g, seat, { type: 'endTurn' });
        else { acted = true; break; }
      }
      if (a.type === 'respondTrade' && a.accept && before && !g.trade) acceptedTrades++;
      acted = true;
    }
    if (!acted) { illegal.push('nobody could act in phase ' + g.phase); break; }
  }

  return {
    game: g, steps: guard, illegal: illegal, leaks: leaks, actions: actions,
    counts: counts, acceptedTrades: acceptedTrades,
    finished: g.phase === 'over', winner: g.winner
  };
}

/* ---------- 1. legality and termination across levels and table sizes ---------- */
var TABLES = [
  ['casual', 'casual'],
  ['steady', 'steady', 'steady'],
  ['sharp', 'sharp', 'sharp', 'sharp'],
  ['casual', 'steady', 'sharp'],
  ['sharp', 'casual'],
  ['steady', 'steady', 'sharp', 'casual', 'steady'],
  ['sharp', 'sharp', 'steady', 'casual', 'casual', 'steady']
];
var allIllegal = [], allLeaks = [], finishedCount = 0, totalGames = 0, maxSteps = 0;
var aggregate = { offerTrade: 0, respondTrade: 0, bankTrade: 0, buyDev: 0, playDev: 0, buildCity: 0, buildSettlement: 0, buildRoad: 0, discard: 0, moveRobber: 0 };
var tradesAccepted = 0;

TABLES.forEach(function (levels, ti) {
  for (var s = 0; s < 6; s++) {
    var r = playGame(ti * 100 + s, levels);
    totalGames++;
    if (r.finished) finishedCount++;
    maxSteps = Math.max(maxSteps, r.steps);
    allIllegal = allIllegal.concat(r.illegal);
    allLeaks = allLeaks.concat(r.leaks);
    tradesAccepted += r.acceptedTrades;
    Object.keys(aggregate).forEach(function (k) { aggregate[k] += r.counts[k]; });

    // invariants at the end
    if (r.finished) {
      var g = r.game;
      E.RES.forEach(function (res) {
        var sum = g.bank[res];
        g.players.forEach(function (p) { sum += p.hand[res]; });
        ok(sum === 19, 'seed ' + (ti * 100 + s) + ': ' + res + ' conserved (' + sum + ')');
        ok(g.bank[res] >= 0, 'seed ' + (ti * 100 + s) + ': bank ' + res + ' not negative');
      });
      g.players.forEach(function (p, i) {
        ok(p.roadsLeft >= 0 && p.settLeft >= 0 && p.cityLeft >= 0, 'seed ' + (ti * 100 + s) + ': p' + i + ' piece counts sane');
        E.RES.forEach(function (res) { ok(p.hand[res] >= 0, 'seed ' + (ti * 100 + s) + ': p' + i + ' ' + res + ' not negative'); });
      });
      ok(E.vpFor(g, g.winner, true) >= g.target, 'seed ' + (ti * 100 + s) + ': winner actually reached the target');
    }
  }
});

eq(allIllegal.length, 0, 'bots never produce an illegal action: ' + allIllegal.slice(0, 4).join(' | '));
eq(allLeaks.length, 0, 'bots never see hidden information: ' + allLeaks.slice(0, 3).join(' | '));
eq(finishedCount, totalGames, 'every bot game reaches a winner (' + finishedCount + '/' + totalGames + ')');
ok(maxSteps < 30000, 'no game hit the step ceiling (worst ' + maxSteps + ')');

/* ---------- 2. bots actually use the whole rule set ---------- */
ok(aggregate.buildSettlement > 0, 'bots found settlements');
ok(aggregate.buildCity > 0, 'bots build cities');
ok(aggregate.buildRoad > 0, 'bots build roads');
ok(aggregate.buyDev > 0, 'bots buy development cards');
ok(aggregate.playDev > 0, 'bots play development cards');
ok(aggregate.bankTrade > 0, 'bots trade with the stores');
ok(aggregate.moveRobber > 0, 'bots move the raider');
ok(aggregate.discard > 0, 'bots discard on a seven');
ok(aggregate.offerTrade > 0, 'bots open trades with each other (' + aggregate.offerTrade + ')');
ok(aggregate.respondTrade > 0, 'bots answer trade offers (' + aggregate.respondTrade + ')');
ok(tradesAccepted > 0, 'some bot-to-bot trades are actually accepted (' + tradesAccepted + ')');

/* ---------- 3. casual bots must not initiate; sharp and steady must ---------- */
(function () {
  var casualOnly = 0;
  for (var s = 0; s < 8; s++) casualOnly += playGame(9000 + s, ['casual', 'casual', 'casual']).counts.offerTrade;
  eq(casualOnly, 0, 'casual bots never open a trade');
  var steadyOnly = 0;
  for (var t = 0; t < 8; t++) steadyOnly += playGame(9100 + t, ['steady', 'steady', 'steady']).counts.offerTrade;
  ok(steadyOnly > 0, 'steady bots open trades (' + steadyOnly + ')');
})();

/* ---------- 4. difficulty must actually be a difference in strength ----------
   Sample size matters here. An earlier 40-game version of this test reported
   steady vs casual as 20-20 purely by luck, which is exactly the kind of result
   that would have shipped three levels with only two of them distinct.
   120 games per pairing, spread over three seed ranges so no single set of
   boards can dominate. At the measured rates a 55% floor sits roughly 2.5
   standard deviations clear of a false failure. */
function duel(a, b, perBase) {
  var wins = [0, 0], played = 0;
  [20000, 40000, 60000].forEach(function (base) {
    for (var s = 0; s < perBase; s++) {
      var order = s % 2 === 0 ? [a, b] : [b, a];   // alternate seats: first player has an edge
      var r = playGame(base + s, order, { checkLeaks: false });
      if (!r.finished) continue;
      played++;
      wins[order[r.winner] === a ? 0 : 1]++;
    }
  });
  return { wins: wins, played: played, rate: wins[0] / Math.max(1, played) };
}

var LADDER = [['sharp', 'casual'], ['steady', 'casual'], ['sharp', 'steady']];
var rates = {};
LADDER.forEach(function (pair) {
  var d = duel(pair[0], pair[1], 40);
  rates[pair[0] + '>' + pair[1]] = d.rate;
  console.log('  ' + (pair[0] + ' vs ' + pair[1]).padEnd(20) +
    d.wins[0] + '-' + d.wins[1] + '   ' + (d.rate * 100).toFixed(0) + '%');
  ok(d.played >= 100, pair.join(' vs ') + ': enough games completed (' + d.played + ')');
  ok(d.rate > 0.55, pair[0] + ' beats ' + pair[1] + ' clearly (' + (d.rate * 100).toFixed(0) + '%, need >55%)');
});
// the ladder must be ordered, not just pairwise winning
ok(rates['sharp>steady'] > 0.5 && rates['steady>casual'] > 0.5,
  'the ladder is transitive: sharp > steady > casual');

/* ---------- 4b. and it must hold at a real table, not only in duels ----------
   Leader awareness barely matters heads-up; it matters with three opponents. */
function tableTest(target, filler, n) {
  var w = 0, played = 0;
  for (var s = 0; s < n; s++) {
    var levels = [filler, filler, filler, filler];
    levels[s % 4] = target;                       // rotate the seat so position cancels
    var r = playGame(77000 + s, levels, { checkLeaks: false });
    if (!r.finished) continue;
    played++;
    if (levels[r.winner] === target) w++;
  }
  return { rate: w / Math.max(1, played), w: w, played: played };
}
var t1 = tableTest('sharp', 'steady', 40);
console.log('  one sharp vs three steady: ' + t1.w + '/' + t1.played + '   ' + (t1.rate * 100).toFixed(0) + '% (chance 25%)');
ok(t1.rate > 0.25, 'a sharp bot beats chance at a table of steady bots');
var t2 = tableTest('steady', 'casual', 40);
console.log('  one steady vs three casual: ' + t2.w + '/' + t2.played + '   ' + (t2.rate * 100).toFixed(0) + '% (chance 25%)');
ok(t2.rate > 0.4, 'a steady bot dominates a table of casual bots');

/* ---------- 5. no bot cheats: every level plays by the same resource rules ---------- */
(function () {
  var g = E.createGame({ code: 'FAIR', seed: 5 });
  ['casual', 'steady', 'sharp'].forEach(function (l, i) { E.addPlayer(g, 'B' + i, 'b' + i, { bot: true, level: l }); });
  E.startGame(g);
  g.players.forEach(function (p, i) {
    eq(E.handSize(p.hand), 0, 'level ' + p.level + ' starts with no cards');
    eq(p.roadsLeft, 15, 'level ' + p.level + ' starts with the standard road pieces');
    eq(p.settLeft, 5, 'level ' + p.level + ' starts with the standard settlement pieces');
    eq(p.cityLeft, 4, 'level ' + p.level + ' starts with the standard city pieces');
  });
  var src = require('fs').readFileSync(__dirname + '/bot.js', 'utf8');
  ok(!/\.hand\[[^\]]+\]\s*(\+\+|\+=)/.test(src), 'bot.js never adds cards to a hand directly');
  ok(!/\.bank\[/.test(src) || !/\.bank\[[^\]]+\]\s*(--|-=)/.test(src), 'bot.js never draws from the bank directly');
  ok(!/g\.dev|\.newDev\s*=/.test(src), 'bot.js never touches the development deck');
})();

/* ---------- 6. specific judgement checks ---------- */
(function () {
  // a sharp bot refuses to help a player who is one move from winning
  var g = E.createGame({ code: 'JUDGE', seed: 11 });
  E.addPlayer(g, 'Leader', 'l', {});
  E.addPlayer(g, 'Bot', 'b', { bot: true, level: 'sharp' });
  E.startGame(g);
  g.phase = 'main'; g.turn = 0;
  // give the leader 9 points
  var keys = Object.keys(g.board.verts), placed = 0;
  for (var i = 0; i < keys.length && placed < 4; i++) {
    if (!E.vertexOpen(g, keys[i])) continue;
    g.buildings[keys[i]] = { p: 0, type: 'city' }; placed++;
  }
  g.players[1].hand = { timber: 3, clay: 3, fleece: 3, grain: 3, ore: 3 };
  g.players[0].hand = { timber: 1, clay: 0, fleece: 0, grain: 0, ore: 0 };
  E.applyAction(g, 0, { type: 'offerTrade', give: { timber: 1 }, get: { ore: 1 } });
  var view = E.redact(g, 'b');
  ok(view.players[0].vp >= view.target - 2, 'leader is within two points of the target (' + view.players[0].vp + ')');
  eq(B.judgeTrade(view, 1, B.LEVELS.sharp), false, 'sharp bot refuses to trade with a player about to win');
  eq(typeof B.judgeTrade(view, 1, B.LEVELS.casual), 'boolean', 'casual bot still evaluates the same offer');

  // a bot will not accept an offer it cannot cover
  var g2 = E.createGame({ code: 'JUDGE2', seed: 12 });
  E.addPlayer(g2, 'A', 'a', {}); E.addPlayer(g2, 'Bot', 'b2', { bot: true, level: 'steady' });
  E.startGame(g2); g2.phase = 'main'; g2.turn = 0;
  g2.players[0].hand = { timber: 5, clay: 0, fleece: 0, grain: 0, ore: 0 };
  g2.players[1].hand = { timber: 0, clay: 0, fleece: 0, grain: 0, ore: 0 };
  E.applyAction(g2, 0, { type: 'offerTrade', give: { timber: 1 }, get: { ore: 2 } });
  eq(B.judgeTrade(E.redact(g2, 'b2'), 1, B.LEVELS.steady), false, 'bot refuses an offer it cannot pay for');

  // discard must hand back exactly half, rounded down
  var g3 = E.createGame({ code: 'DISC', seed: 13 });
  E.addPlayer(g3, 'Bot', 'b3', { bot: true, level: 'sharp' });
  E.addPlayer(g3, 'X', 'x', {});
  E.startGame(g3);
  g3.players[0].hand = { timber: 4, clay: 3, fleece: 2, grain: 1, ore: 1 };   // 11 cards
  var cards = B.chooseDiscard(E.redact(g3, 'b3'), 0, B.LEVELS.sharp);
  var n = 0; for (var k in cards) n += cards[k];
  eq(n, 5, 'bot discards exactly half its hand, rounded down');
  var overdrawn = false;
  for (var k2 in cards) if (cards[k2] > g3.players[0].hand[k2]) overdrawn = true;
  ok(!overdrawn, 'bot never discards more of a resource than it holds');

  // the raider should not be parked on the bot's own best hex
  var g4 = E.createGame({ code: 'ROB', seed: 14 });
  E.addPlayer(g4, 'Bot', 'b4', { bot: true, level: 'sharp' });
  E.addPlayer(g4, 'Y', 'y', {});
  E.startGame(g4);
  var best = g4.board.hexes.filter(function (h) { return h.num === 6 || h.num === 8; })[0];
  var vk = Object.keys(g4.board.verts).filter(function (k) { return g4.board.verts[k].hexes.indexOf(best.id) >= 0; })[0];
  g4.buildings[vk] = { p: 0, type: 'city' };
  g4.phase = 'robber'; g4.turn = 0;
  var mv = B.robberMove(E.redact(g4, 'b4'), 0, B.LEVELS.sharp);
  ok(mv.hex !== best.id, 'bot does not put the raider on its own best hex');
  ok(E.applyAction(g4, 0, mv).ok, 'the bot raider move is legal');
})();

console.log('\nPASS ' + pass + '   FAIL ' + fail +
  '\n  games ' + totalGames + ', trades opened ' + aggregate.offerTrade +
  ', accepted ' + tradesAccepted + ', dev cards played ' + aggregate.playDev);
if (fail) { fails.slice(0, 20).forEach(function (f) { console.log('  ✗ ' + f); }); process.exit(1); }
