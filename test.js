var E = require('./engine.js');
var pass = 0, fail = 0, fails = [];
function ok(c, m) { if (c) pass++; else { fail++; fails.push(m); } }
function eq(a, b, m) { ok(a === b, m + ' (got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b) + ')'); }

function newGame(n, seed) {
  var g = E.createGame({ code: 'TEST', seed: seed || 12345 });
  for (var i = 0; i < n; i++) E.addPlayer(g, 'P' + i, 'id' + i);
  E.startGame(g);
  return g;
}

/* ---- board ---- */
(function () {
  for (var s = 0; s < 40; s++) {
    var g = E.createGame({ code: 'B', seed: s });
    var b = g.board;
    eq(b.hexes.length, 19, 'seed ' + s + ': 19 hexes');
    eq(Object.keys(b.verts).length, 54, 'seed ' + s + ': 54 vertices');
    eq(Object.keys(b.edges).length, 72, 'seed ' + s + ': 72 edges');
    eq(b.ports.length, 9, 'seed ' + s + ': 9 ports');
    var counts = {};
    b.hexes.forEach(function (h) { counts[h.terrain] = (counts[h.terrain] || 0) + 1; });
    eq(counts.forest, 4, 'seed ' + s + ': 4 forest');
    eq(counts.pit, 3, 'seed ' + s + ': 3 pit');
    eq(counts.pasture, 4, 'seed ' + s + ': 4 pasture');
    eq(counts.field, 4, 'seed ' + s + ': 4 field');
    eq(counts.mountain, 3, 'seed ' + s + ': 3 mountain');
    eq(counts.waste, 1, 'seed ' + s + ': 1 waste');
    var nums = b.hexes.filter(function (h) { return h.num > 0; });
    eq(nums.length, 18, 'seed ' + s + ': 18 tokens');
    ok(nums.every(function (h) { return h.num !== 7; }), 'seed ' + s + ': no 7 tokens');
    // no adjacent 6/8
    var bad = 0;
    b.hexes.forEach(function (h) {
      if (h.num !== 6 && h.num !== 8) return;
      h.nb.forEach(function (nid) { var n = b.hexes[nid]; if (n.num === 6 || n.num === 8) bad++; });
    });
    eq(bad, 0, 'seed ' + s + ': no adjacent 6/8');
    // robber starts on waste
    eq(b.hexes[g.robber].terrain, 'waste', 'seed ' + s + ': robber on waste');
    // ports not on same edge twice, and all coastal
    var pk = {};
    b.ports.forEach(function (p) { pk[p.edge] = (pk[p.edge] || 0) + 1; ok(b.edges[p.edge].hexes.length === 1, 'seed ' + s + ': port coastal'); });
    eq(Object.keys(pk).length, 9, 'seed ' + s + ': ports on distinct edges');
    var types = b.ports.map(function (p) { return p.type; }).sort().join(',');
    eq(types, 'any,any,any,any,clay,fleece,grain,ore,timber', 'seed ' + s + ': port type mix');
    // every vertex has 2 or 3 adjacent vertices
    ok(Object.keys(b.verts).every(function (k) { var a = b.verts[k].adj.length; return a >= 2 && a <= 3; }), 'seed ' + s + ': vertex degree');
    // every vertex touches 1-3 hexes
    ok(Object.keys(b.verts).every(function (k) { var a = b.verts[k].hexes.length; return a >= 1 && a <= 3; }), 'seed ' + s + ': vertex hex count');
  }
})();

/* ---- setup ---- */
(function () {
  var g = newGame(4);
  eq(g.phase, 'setup', 'setup phase');
  var order = E.setupOrder(g).join(',');
  eq(order, '0,1,2,3,3,2,1,0', 'snake order');

  // wrong player cannot place
  var r = E.applyAction(g, 1, { type: 'setupPlace', vert: Object.keys(g.board.verts)[0], edge: Object.keys(g.board.edges)[0] });
  ok(!r.ok, 'out-of-order setup rejected');

  // play out full setup greedily
  function doSetup(g) {
    var guard = 0;
    while (g.phase === 'setup' && guard++ < 40) {
      var pi = E.setupCurrent(g);
      var spots = E.legalSettlementSpots(g, pi, true);
      var placed = false;
      for (var i = 0; i < spots.length && !placed; i++) {
        var v = g.board.verts[spots[i]];
        for (var j = 0; j < v.adj.length; j++) {
          var ek = E.ekey(spots[i], v.adj[j]);
          if (g.roads[ek] != null) continue;
          var res = E.applyAction(g, pi, { type: 'setupPlace', vert: spots[i], edge: ek });
          if (res.ok) { placed = true; break; }
        }
      }
      if (!placed) break;
    }
  }
  doSetup(g);
  eq(g.phase, 'roll', 'setup completes into roll phase');
  eq(Object.keys(g.buildings).length, 8, '8 settlements after setup');
  eq(Object.keys(g.roads).length, 8, '8 roads after setup');
  g.players.forEach(function (p, i) {
    eq(p.settLeft, 3, 'p' + i + ' settlements left');
    eq(p.roadsLeft, 13, 'p' + i + ' roads left');
  });
  // second placement gave resources; first did not
  var totals = g.players.map(function (p) { return E.handSize(p.hand); });
  ok(totals.every(function (t) { return t >= 1 && t <= 3; }), 'starting hands 1-3 cards');
  // bank conserved
  var total = { timber: 19, clay: 19, fleece: 19, grain: 19, ore: 19 };
  E.RES.forEach(function (r) {
    var sum = g.bank[r];
    g.players.forEach(function (p) { sum += p.hand[r]; });
    eq(sum, total[r], 'bank conservation ' + r);
  });
})();

/* ---- distance rule ---- */
(function () {
  var g = newGame(2);
  var vk = Object.keys(g.board.verts)[10];
  var v = g.board.verts[vk];
  var ek = E.ekey(vk, v.adj[0]);
  E.applyAction(g, 0, { type: 'setupPlace', vert: vk, edge: ek });
  ok(!E.vertexOpen(g, vk), 'occupied vertex closed');
  ok(!E.vertexOpen(g, v.adj[0]), 'neighbour vertex closed');
  var far = g.board.verts[v.adj[0]].adj.filter(function (k) { return k !== vk; })[0];
  ok(E.vertexOpen(g, far), 'two-away vertex open');
  var r = E.applyAction(g, 1, { type: 'setupPlace', vert: v.adj[0], edge: E.ekey(v.adj[0], far) });
  ok(!r.ok, 'adjacent settlement rejected');
})();

/* ---- costs, roads, connectivity ---- */
(function () {
  var g = newGame(2);
  // hand-place a settlement + road for p0
  var vk = Object.keys(g.board.verts)[20], v = g.board.verts[vk];
  g.buildings[vk] = { p: 0, type: 'settlement' };
  g.phase = 'main'; g.turn = 0;
  var p = g.players[0];

  var legal = E.legalRoadSpots(g, 0);
  ok(legal.length >= 2, 'roads legal from a lone settlement');
  var far = Object.keys(g.board.edges).filter(function (k) {
    var e = g.board.edges[k]; return e.a !== vk && e.b !== vk && v.adj.indexOf(e.a) < 0 && v.adj.indexOf(e.b) < 0;
  })[0];
  p.hand = { timber: 5, clay: 5, fleece: 5, grain: 5, ore: 5 };
  var r = E.applyAction(g, 0, { type: 'buildRoad', edge: far });
  ok(!r.ok, 'disconnected road rejected');
  r = E.applyAction(g, 0, { type: 'buildRoad', edge: legal[0] });
  ok(r.ok, 'connected road accepted');
  eq(p.hand.timber, 4, 'road spends timber');
  eq(p.hand.clay, 4, 'road spends clay');
  eq(g.bank.timber, 20, 'road returns timber to bank');

  // settlement needs a road
  var openFar = E.legalSettlementSpots(g, 0, true).filter(function (k) { return !E.legalSettlementSpots(g, 0, false).includes(k); })[0];
  if (openFar) {
    r = E.applyAction(g, 0, { type: 'buildSettlement', vert: openFar });
    ok(!r.ok, 'settlement without road rejected');
  }

  // city upgrade
  p.hand = { timber: 0, clay: 0, fleece: 0, grain: 2, ore: 3 };
  r = E.applyAction(g, 0, { type: 'buildCity', vert: vk });
  ok(r.ok, 'city upgrade accepted');
  eq(g.buildings[vk].type, 'city', 'vertex is now a city');
  eq(p.cityLeft, 3, 'city piece spent');
  eq(p.settLeft, 6, 'settlement piece returned');
  r = E.applyAction(g, 0, { type: 'buildCity', vert: vk });
  ok(!r.ok, 'cannot city a city');
})();

/* ---- production ---- */
(function () {
  var g = newGame(2);
  g.phase = 'main';
  var hex = g.board.hexes.filter(function (h) { return h.terrain === 'field' && h.id !== g.robber; })[0];
  var vk = Object.keys(g.board.verts).filter(function (k) { return g.board.verts[k].hexes.indexOf(hex.id) >= 0; })[0];
  g.buildings[vk] = { p: 0, type: 'settlement' };
  g.rollSeq = 0;
  // force the roll
  var before = g.players[0].hand.grain;
  g.phase = 'roll';
  // call produce indirectly by faking the dice sum
  var Eng = require('./engine.js');
  // use applyAction roll repeatedly until we hit hex.num, else call produce via a crafted state
  var g2 = JSON.parse(JSON.stringify(g));
  // direct: simulate via engine's internal path by rolling until match
  var got = false;
  for (var i = 0; i < 400 && !got; i++) {
    var gg = JSON.parse(JSON.stringify(g));
    gg.rollSeq = i;
    gg.phase = 'roll';
    var rr = Eng.applyAction(gg, 0, { type: 'roll' });
    if (gg.dice && gg.dice[0] + gg.dice[1] === hex.num) {
      eq(gg.players[0].hand.grain, before + 1, 'settlement produces 1 grain on its number');
      got = true;
      // city produces 2
      var gc = JSON.parse(JSON.stringify(g));
      gc.buildings[vk].type = 'city';
      gc.rollSeq = i; gc.phase = 'roll';
      Eng.applyAction(gc, 0, { type: 'roll' });
      eq(gc.players[0].hand.grain, before + 2, 'city produces 2 grain');
      // robber blocks
      var gr = JSON.parse(JSON.stringify(g));
      gr.robber = hex.id; gr.rollSeq = i; gr.phase = 'roll';
      Eng.applyAction(gr, 0, { type: 'roll' });
      eq(gr.players[0].hand.grain, before, 'robber blocks production');
    }
  }
  ok(got, 'found a roll matching the target hex');
})();

/* ---- seven: discard + robber ---- */
(function () {
  var Eng = require('./engine.js');
  var g = newGame(3);
  g.phase = 'main'; g.turn = 0;
  g.players[1].hand = { timber: 4, clay: 4, fleece: 0, grain: 0, ore: 0 }; // 8 cards
  g.players[2].hand = { timber: 3, clay: 3, fleece: 0, grain: 0, ore: 0 }; // 6 cards
  // find a rollSeq producing 7
  var seq = -1;
  for (var i = 0; i < 500; i++) {
    var gg = JSON.parse(JSON.stringify(g)); gg.rollSeq = i; gg.phase = 'roll';
    Eng.applyAction(gg, 0, { type: 'roll' });
    if (gg.dice[0] + gg.dice[1] === 7) { seq = i; break; }
  }
  ok(seq >= 0, 'found a 7');
  g.rollSeq = seq; g.phase = 'roll';
  Eng.applyAction(g, 0, { type: 'roll' });
  eq(g.phase, 'discard', 'seven forces discard phase');
  eq(g.pendingDiscard.join(','), '1', 'only the 8-card player discards');
  var r = Eng.applyAction(g, 1, { type: 'discard', cards: { timber: 3 } });
  ok(!r.ok, 'wrong discard count rejected');
  r = Eng.applyAction(g, 1, { type: 'discard', cards: { timber: 4 } });
  ok(r.ok, 'correct discard accepted');
  eq(g.players[1].hand.timber, 0, 'discard removes cards');
  eq(g.phase, 'robber', 'discard clears into robber phase');
  r = Eng.applyAction(g, 0, { type: 'moveRobber', hex: g.robber });
  ok(!r.ok, 'robber must move');
  var target = g.board.hexes.filter(function (h) { return h.id !== g.robber; })[0];
  r = Eng.applyAction(g, 0, { type: 'moveRobber', hex: target.id });
  ok(r.ok, 'robber move accepted');
  eq(g.phase, 'main', 'robber resolves into main phase');
})();

/* ---- robbing ---- */
(function () {
  var g = newGame(2);
  var hex = g.board.hexes.filter(function (h) { return h.id !== g.robber; })[0];
  var vk = Object.keys(g.board.verts).filter(function (k) { return g.board.verts[k].hexes.indexOf(hex.id) >= 0; })[0];
  g.buildings[vk] = { p: 1, type: 'settlement' };
  g.players[1].hand = { timber: 3, clay: 0, fleece: 0, grain: 0, ore: 0 };
  g.phase = 'robber'; g.turn = 0;
  var vics = E.robberVictims(g, hex.id, 0);
  eq(vics.join(','), '1', 'victim identified');
  var r = E.applyAction(g, 0, { type: 'moveRobber', hex: hex.id, victim: 1 });
  ok(r.ok, 'rob accepted');
  eq(g.players[1].hand.timber, 2, 'victim loses a card');
  eq(g.players[0].hand.timber, 1, 'robber gains a card');
  // empty-handed players are not victims
  g.players[1].hand = { timber: 0, clay: 0, fleece: 0, grain: 0, ore: 0 };
  eq(E.robberVictims(g, hex.id, 0).length, 0, 'empty hand is not a valid victim');
})();

/* ---- bank + port trading ---- */
(function () {
  var g = newGame(2);
  g.phase = 'main'; g.turn = 0;
  var p = g.players[0];
  p.hand = { timber: 4, clay: 0, fleece: 0, grain: 0, ore: 0 };
  eq(E.tradeRate(g, 0, 'timber'), 4, 'default rate 4:1');
  var r = E.applyAction(g, 0, { type: 'bankTrade', give: 'timber', get: 'ore' });
  ok(r.ok, '4:1 trade accepted');
  eq(p.hand.timber, 0, '4:1 spends 4');
  eq(p.hand.ore, 1, '4:1 gains 1');

  p.ports = ['any'];
  eq(E.tradeRate(g, 0, 'timber'), 3, 'generic port rate 3:1');
  p.ports = ['any', 'timber'];
  eq(E.tradeRate(g, 0, 'timber'), 2, 'specific port rate 2:1');
  eq(E.tradeRate(g, 0, 'clay'), 3, 'specific port does not apply to other resources');
  p.hand = { timber: 2, clay: 0, fleece: 0, grain: 0, ore: 0 };
  r = E.applyAction(g, 0, { type: 'bankTrade', give: 'timber', get: 'grain' });
  ok(r.ok, '2:1 trade accepted');
  eq(p.hand.timber, 0, '2:1 spends 2');
  p.hand = { timber: 1, clay: 0, fleece: 0, grain: 0, ore: 0 };
  r = E.applyAction(g, 0, { type: 'bankTrade', give: 'timber', get: 'grain' });
  ok(!r.ok, 'insufficient trade rejected');
})();

/* ---- port acquisition ---- */
(function () {
  var g = newGame(2);
  var port = g.board.ports[0];
  g.buildings[port.a] = { p: 0, type: 'settlement' };
  // recompute via a legal path
  g.phase = 'main'; g.turn = 0;
  var E2 = require('./engine.js');
  // recomputePorts is internal; trigger through a city build
  g.players[0].hand = { timber: 0, clay: 0, fleece: 0, grain: 2, ore: 3 };
  E2.applyAction(g, 0, { type: 'buildCity', vert: port.a });
  // city build does not recompute ports, so check via settlement path instead
  var g2 = newGame(2);
  var pt = g2.board.ports[1];
  var v = g2.board.verts[pt.a];
  E2.applyAction(g2, 0, { type: 'setupPlace', vert: pt.a, edge: E2.ekey(pt.a, v.adj[0]) });
  ok(g2.players[0].ports.indexOf(pt.type) >= 0, 'settling a port grants its rate');
})();

/* ---- development cards ---- */
(function () {
  var g = newGame(2);
  g.phase = 'main'; g.turn = 0;
  var p = g.players[0];
  eq(g.dev.length, 25, 'dev deck is 25 cards');
  var counts = {};
  g.dev.forEach(function (c) { counts[c] = (counts[c] || 0) + 1; });
  eq(counts.knight, 14, '14 knights');
  eq(counts.point, 5, '5 point cards');
  eq(counts.roads, 2, '2 road building');
  eq(counts.plenty, 2, '2 year of plenty');
  eq(counts.monopoly, 2, '2 monopoly');

  p.hand = { timber: 0, clay: 0, fleece: 1, grain: 1, ore: 1 };
  var r = E.applyAction(g, 0, { type: 'buyDev' });
  ok(r.ok, 'buy dev accepted');
  eq(p.newDev.length, 1, 'card lands in the new pile');
  eq(p.dev.length, 0, 'card not playable yet');
  r = E.applyAction(g, 0, { type: 'playDev', card: p.newDev[0] });
  ok(!r.ok, 'cannot play a card bought this turn');

  // knight
  var g2 = newGame(2); g2.phase = 'main'; g2.turn = 0;
  g2.players[0].dev = ['knight', 'knight'];
  r = E.applyAction(g2, 0, { type: 'playDev', card: 'knight' });
  ok(r.ok, 'knight played');
  eq(g2.phase, 'robber', 'knight opens robber phase');
  eq(g2.players[0].knights, 1, 'knight counted');
  var t = g2.board.hexes.filter(function (h) { return h.id !== g2.robber; })[0];
  E.applyAction(g2, 0, { type: 'moveRobber', hex: t.id });
  r = E.applyAction(g2, 0, { type: 'playDev', card: 'knight' });
  ok(!r.ok, 'second dev card in one turn rejected');

  // monopoly
  var g3 = newGame(3); g3.phase = 'main'; g3.turn = 0;
  g3.players[0].dev = ['monopoly'];
  g3.players[1].hand.ore = 3; g3.players[2].hand.ore = 2; g3.players[0].hand.ore = 1;
  r = E.applyAction(g3, 0, { type: 'playDev', card: 'monopoly', res: 'ore' });
  ok(r.ok, 'monopoly played');
  eq(g3.players[0].hand.ore, 6, 'monopoly collects all ore');
  eq(g3.players[1].hand.ore, 0, 'opponent stripped');

  // year of plenty
  var g4 = newGame(2); g4.phase = 'main'; g4.turn = 0;
  g4.players[0].dev = ['plenty'];
  r = E.applyAction(g4, 0, { type: 'playDev', card: 'plenty', picks: ['ore', 'ore'] });
  ok(r.ok, 'year of plenty played');
  eq(g4.players[0].hand.ore, 2, 'plenty grants two cards');
  eq(g4.bank.ore, 17, 'plenty draws from bank');

  // road building
  var g5 = newGame(2); g5.phase = 'main'; g5.turn = 0;
  var vk = Object.keys(g5.board.verts)[15];
  g5.buildings[vk] = { p: 0, type: 'settlement' };
  g5.players[0].dev = ['roads'];
  g5.players[0].hand = E.emptyHand();
  r = E.applyAction(g5, 0, { type: 'playDev', card: 'roads' });
  eq(g5.freeRoads, 2, 'road building grants two free roads');
  var spots = E.legalRoadSpots(g5, 0);
  r = E.applyAction(g5, 0, { type: 'buildRoad', edge: spots[0] });
  ok(r.ok, 'free road built with an empty hand');
  eq(g5.freeRoads, 1, 'free road counter decrements');

  // point cards cannot be played
  var g6 = newGame(2); g6.phase = 'main'; g6.turn = 0;
  g6.players[0].dev = ['point'];
  r = E.applyAction(g6, 0, { type: 'playDev', card: 'point' });
  ok(!r.ok, 'point cards cannot be played');
})();

/* ---- longest road ---- */
(function () {
  var g = newGame(2);
  // build a straight chain of 6 roads for p0 by walking the vertex graph
  var start = Object.keys(g.board.verts)[27];
  var cur = start, prev = null, chain = [];
  for (var i = 0; i < 6; i++) {
    var v = g.board.verts[cur];
    var next = v.adj.filter(function (k) { return k !== prev; })[0];
    if (!next) break;
    var ek = E.ekey(cur, next);
    g.roads[ek] = 0; chain.push(ek);
    prev = cur; cur = next;
  }
  eq(E.longestRoadFor(g, 0), chain.length, 'chain length measured correctly');
  eq(E.longestRoadFor(g, 1), 0, 'other player has no road');

  // an enemy settlement mid-chain breaks it
  var g2 = JSON.parse(JSON.stringify(g));
  var e3 = g2.board.edges[chain[2]];
  g2.buildings[e3.b] = { p: 1, type: 'settlement' };
  ok(E.longestRoadFor(g2, 0) < chain.length, 'enemy settlement breaks the chain');

  // own settlement does not break it
  var g3 = JSON.parse(JSON.stringify(g));
  g3.buildings[g3.board.edges[chain[2]].b] = { p: 0, type: 'settlement' };
  eq(E.longestRoadFor(g3, 0), chain.length, 'own settlement does not break the chain');

  // award threshold
  var g4 = newGame(2);
  var c2 = [], cur2 = Object.keys(g4.board.verts)[27], prev2 = null;
  for (var j = 0; j < 4; j++) {
    var vv = g4.board.verts[cur2];
    var nx = vv.adj.filter(function (k) { return k !== prev2; })[0];
    if (!nx) break;
    g4.roads[E.ekey(cur2, nx)] = 0; c2.push(1); prev2 = cur2; cur2 = nx;
  }
  g4.phase = 'main'; g4.turn = 0;
  g4.players[0].hand = { timber: 5, clay: 5, fleece: 0, grain: 0, ore: 0 };
  eq(E.longestRoadFor(g4, 0), 4, 'four roads');
  E.applyAction(g4, 0, { type: 'endTurn' });
  eq(g4.longest.p, -1, 'four roads does not win the award');
})();

/* ---- victory ---- */
(function () {
  var g = newGame(2);
  g.phase = 'main'; g.turn = 0;
  var keys = Object.keys(g.board.verts);
  var placed = 0;
  for (var i = 0; i < keys.length && placed < 4; i++) {
    if (!E.vertexOpen(g, keys[i])) continue;
    g.buildings[keys[i]] = { p: 0, type: 'city' };
    placed++;
  }
  eq(E.vpFor(g, 0, false), 8, 'four cities is 8 points');
  g.players[0].dev = ['point', 'point'];
  eq(E.vpFor(g, 0, true), 10, 'hidden points count toward the target');
  eq(E.vpFor(g, 0, false), 8, 'hidden points excluded from the public total');
  g.players[0].hand = { timber: 1, clay: 1, fleece: 0, grain: 0, ore: 0 };
  E.applyAction(g, 0, { type: 'endTurn' });
  eq(g.winner, 0, 'win detected at end of turn');
  eq(g.phase, 'over', 'game over');
  var r = E.applyAction(g, 0, { type: 'roll' });
  ok(!r.ok, 'no actions after the game ends');
})();

/* ---- redaction ---- */
(function () {
  var g = newGame(3);
  g.players[0].hand = { timber: 2, clay: 1, fleece: 0, grain: 0, ore: 0 };
  g.players[1].hand = { timber: 5, clay: 5, fleece: 5, grain: 0, ore: 0 };
  g.players[1].dev = ['knight', 'point'];
  var view = E.redact(g, 'id0');
  eq(view.me, 0, 'redaction identifies the viewer');
  ok(view.players[0].hand !== null, 'own hand visible');
  eq(view.players[0].hand.timber, 2, 'own hand accurate');
  eq(view.players[1].hand, null, 'opponent hand hidden');
  eq(view.players[1].dev, null, 'opponent dev cards hidden');
  eq(view.players[1].handCount, 15, 'opponent hand count visible');
  eq(view.players[1].devCount, 2, 'opponent dev count visible');
  eq(view.dev, undefined, 'dev deck contents stripped');
  eq(view.devLeft, 25, 'dev deck size visible');
  var s = JSON.stringify(view);
  ok(s.indexOf('"knight"') < 0, 'no opponent card names leak in the payload');

  // at game over everything is revealed
  g.phase = 'over';
  var v2 = E.redact(g, 'id0');
  ok(v2.players[1].hand !== null, 'hands revealed after the game ends');
})();

/* ---- trade offers ---- */
(function () {
  var g = newGame(3);
  g.phase = 'main'; g.turn = 0;
  g.players[0].hand = { timber: 3, clay: 0, fleece: 0, grain: 0, ore: 0 };
  g.players[1].hand = { timber: 0, clay: 0, fleece: 0, grain: 0, ore: 2 };
  var r = E.applyAction(g, 0, { type: 'offerTrade', give: { timber: 2 }, get: { ore: 1 } });
  ok(r.ok, 'trade offer opened');
  eq(g.trade.to.join(','), '1,2', 'offer goes to both opponents');
  r = E.applyAction(g, 2, { type: 'respondTrade', accept: true });
  ok(!r.ok, 'player who cannot pay is rejected');
  r = E.applyAction(g, 1, { type: 'respondTrade', accept: true });
  ok(r.ok, 'trade accepted');
  eq(g.players[0].hand.timber, 1, 'offerer gives cards');
  eq(g.players[0].hand.ore, 1, 'offerer receives cards');
  eq(g.players[1].hand.ore, 1, 'accepter gives cards');
  eq(g.players[1].hand.timber, 2, 'accepter receives cards');
  eq(g.trade, null, 'offer clears after acceptance');

  // cannot offer what you do not hold
  var g2 = newGame(2); g2.phase = 'main'; g2.turn = 0;
  r = E.applyAction(g2, 0, { type: 'offerTrade', give: { ore: 5 }, get: { timber: 1 } });
  ok(!r.ok, 'cannot offer cards you do not hold');
})();

/* ---- turn order and phase gating ---- */
(function () {
  var g = newGame(3);
  g.phase = 'roll'; g.turn = 0;
  var r = E.applyAction(g, 1, { type: 'roll' });
  ok(!r.ok, 'only the current player rolls');
  r = E.applyAction(g, 0, { type: 'buildRoad', edge: Object.keys(g.board.edges)[0] });
  ok(!r.ok, 'cannot build before rolling');
  r = E.applyAction(g, 0, { type: 'endTurn' });
  ok(!r.ok, 'cannot end turn before rolling');
  E.applyAction(g, 0, { type: 'roll' });
  if (g.phase === 'main') {
    E.applyAction(g, 0, { type: 'endTurn' });
    eq(g.turn, 1, 'turn advances');
    eq(g.phase, 'roll', 'next player must roll');
  }
  // wrap-around
  g.turn = 2; g.phase = 'main';
  E.applyAction(g, 2, { type: 'endTurn' });
  eq(g.turn, 0, 'turn wraps to the first player');
})();

/* ---- full random game soak ---- */
(function () {
  var Eng = require('./engine.js');
  function rand(n, seedv) { var x = seedv; return function () { x = (x * 1103515245 + 12345) & 0x7fffffff; return x / 0x7fffffff; }; }
  var completed = 0, errors = [];
  for (var s = 0; s < 24; s++) {
    var rng = rand(0, s * 7919 + 13);
    var g = E.createGame({ code: 'SOAK', seed: s });
    for (var i = 0; i < 4; i++) E.addPlayer(g, 'P' + i, 'id' + i);
    E.startGame(g);
    var guard = 0;
    try {
      while (g.phase !== 'over' && guard++ < 8000) {
        if (g.phase === 'setup') {
          var pi = E.setupCurrent(g);
          var spots = E.legalSettlementSpots(g, pi, true);
          var v = spots[Math.floor(rng() * spots.length)];
          var vv = g.board.verts[v];
          var done = false;
          for (var j = 0; j < vv.adj.length; j++) {
            var ek = E.ekey(v, vv.adj[j]);
            if (g.roads[ek] != null) continue;
            if (E.applyAction(g, pi, { type: 'setupPlace', vert: v, edge: ek }).ok) { done = true; break; }
          }
          if (!done) { errors.push('seed ' + s + ': setup stuck'); break; }
          continue;
        }
        if (g.phase === 'discard') {
          var d = g.pendingDiscard[0];
          var pl = g.players[d], need = Math.floor(E.handSize(pl.hand) / 2), cards = {};
          E.RES.forEach(function (r) {
            while (need > 0 && (cards[r] || 0) < pl.hand[r]) { cards[r] = (cards[r] || 0) + 1; need--; }
          });
          var dr = E.applyAction(g, d, { type: 'discard', cards: cards });
          if (!dr.ok) { errors.push('seed ' + s + ': discard failed — ' + dr.error); break; }
          continue;
        }
        var cp = E.currentPlayer(g);
        if (g.phase === 'roll') { E.applyAction(g, cp, { type: 'roll' }); continue; }
        if (g.phase === 'robber') {
          var cand = g.board.hexes.filter(function (h) { return h.id !== g.robber; });
          var h = cand[Math.floor(rng() * cand.length)];
          var vics = E.robberVictims(g, h.id, cp);
          var rr = E.applyAction(g, cp, { type: 'moveRobber', hex: h.id, victim: vics.length ? vics[0] : null });
          if (!rr.ok) { errors.push('seed ' + s + ': robber failed — ' + rr.error); break; }
          continue;
        }
        if (g.phase === 'main') {
          var p = g.players[cp];
          // greedy: city > settlement > dev > road > end
          var acted = false;
          var mine = Object.keys(g.buildings).filter(function (k) { return g.buildings[k].p === cp && g.buildings[k].type === 'settlement'; });
          if (mine.length && E.canPay(p.hand, E.COST.city)) acted = E.applyAction(g, cp, { type: 'buildCity', vert: mine[0] }).ok;
          if (!acted && E.canPay(p.hand, E.COST.settlement)) {
            var ss = E.legalSettlementSpots(g, cp, false);
            if (ss.length) acted = E.applyAction(g, cp, { type: 'buildSettlement', vert: ss[0] }).ok;
          }
          if (!acted && E.canPay(p.hand, E.COST.road) && rng() < 0.6) {
            var rs = E.legalRoadSpots(g, cp);
            if (rs.length) acted = E.applyAction(g, cp, { type: 'buildRoad', edge: rs[Math.floor(rng() * rs.length)] }).ok;
          }
          if (!acted && E.canPay(p.hand, E.COST.dev) && g.dev.length) acted = E.applyAction(g, cp, { type: 'buyDev' }).ok;
          if (!acted && p.dev.indexOf('knight') >= 0 && !g.playedDevThisTurn) acted = E.applyAction(g, cp, { type: 'playDev', card: 'knight' }).ok;
          if (!acted) {
            // try a bank trade toward something useful
            var surplus = E.RES.filter(function (r) { return p.hand[r] >= E.tradeRate(g, cp, r); })[0];
            if (surplus && rng() < 0.5) {
              var want = E.RES[Math.floor(rng() * 5)];
              acted = E.applyAction(g, cp, { type: 'bankTrade', give: surplus, get: want }).ok;
            }
          }
          if (!acted) E.applyAction(g, cp, { type: 'endTurn' });
          continue;
        }
        errors.push('seed ' + s + ': unhandled phase ' + g.phase);
        break;
      }
    } catch (e) { errors.push('seed ' + s + ': threw ' + e.message); }
    if (g.phase === 'over') {
      completed++;
      // invariants at end of game
      E.RES.forEach(function (r) {
        var sum = g.bank[r];
        g.players.forEach(function (p) { sum += p.hand[r]; });
        if (sum !== 19) errors.push('seed ' + s + ': bank leak on ' + r + ' (' + sum + ')');
        if (g.bank[r] < 0) errors.push('seed ' + s + ': negative bank ' + r);
      });
      g.players.forEach(function (p, i) {
        if (p.roadsLeft < 0 || p.settLeft < 0 || p.cityLeft < 0) errors.push('seed ' + s + ': negative pieces p' + i);
        E.RES.forEach(function (r) { if (p.hand[r] < 0) errors.push('seed ' + s + ': negative hand p' + i + ' ' + r); });
      });
      if (E.vpFor(g, g.winner, true) < g.target) errors.push('seed ' + s + ': winner below target');
    } else if (guard >= 8000) {
      errors.push('seed ' + s + ': did not finish in 8000 steps');
    }
  }
  eq(errors.length, 0, 'soak errors: ' + errors.slice(0, 5).join(' | '));
  ok(completed >= 20, 'at least 20 of 24 soak games reach a winner (got ' + completed + ')');
})();

console.log('\nPASS ' + pass + '   FAIL ' + fail);
if (fail) { fails.slice(0, 25).forEach(function (f) { console.log('  ✗ ' + f); }); process.exit(1); }
