/* TIDEHOLM — shared rules engine.
   Loaded by the browser via <script src="engine.js"> and by api/game.js via require().
   The server is authoritative; the client uses this for local pass-and-play and for
   predicting legality so the UI can grey out illegal taps. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ENGINE = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var RES = ['timber', 'clay', 'fleece', 'grain', 'ore'];
  var TERRAIN = {
    forest: 'timber', pit: 'clay', pasture: 'fleece',
    field: 'grain', mountain: 'ore', waste: null
  };
  var COST = {
    road: { clay: 1, timber: 1 },
    settlement: { clay: 1, timber: 1, fleece: 1, grain: 1 },
    city: { grain: 2, ore: 3 },
    dev: { fleece: 1, grain: 1, ore: 1 }
  };
  var COLORS = ['#e8503a', '#2f6fd0', '#f2b333', '#39a06a', '#9b5de5', '#18c5c5'];

  /* ---------- rng ---------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rng) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }
  function hashCode(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  /* ---------- geometry ---------- */
  var HEX_R = 1;
  var SQ3 = Math.sqrt(3);
  function hexCenter(q, r) {
    return { x: HEX_R * SQ3 * (q + r / 2), z: HEX_R * 1.5 * r };
  }
  function corner(cx, cz, i) {
    var a = Math.PI / 180 * (60 * i - 30);
    return { x: cx + HEX_R * Math.cos(a), z: cz + HEX_R * Math.sin(a) };
  }
  function vkey(p) { return Math.round(p.x * 1000) + ':' + Math.round(p.z * 1000); }
  function ekey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }

  /* ---------- board ---------- */
  function genBoard(seed) {
    var rng = mulberry32(seed);
    var hexes = [], id = 0;
    for (var x = -2; x <= 2; x++) {
      for (var y = -2; y <= 2; y++) {
        var z = -x - y;
        if (Math.abs(z) > 2) continue;
        var q = x, r = z;
        var c = hexCenter(q, r);
        hexes.push({ id: id++, q: q, r: r, cx: c.x, cz: c.z, terrain: null, num: 0 });
      }
    }
    // terrain
    var bag = [];
    ['forest', 'forest', 'forest', 'forest', 'pit', 'pit', 'pit', 'pasture', 'pasture',
      'pasture', 'pasture', 'field', 'field', 'field', 'field', 'mountain', 'mountain',
      'mountain', 'waste'].forEach(function (t) { bag.push(t); });
    shuffle(bag, rng);
    hexes.forEach(function (h, i) { h.terrain = bag[i]; });

    // neighbours (cube)
    var byQR = {};
    hexes.forEach(function (h) { byQR[h.q + ',' + h.r] = h; });
    var DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
    hexes.forEach(function (h) {
      h.nb = [];
      DIRS.forEach(function (d) {
        var n = byQR[(h.q + d[0]) + ',' + (h.r + d[1])];
        if (n) h.nb.push(n.id);
      });
    });

    // number tokens, no adjacent 6/8
    var tokens = [5, 2, 6, 3, 8, 10, 9, 12, 11, 4, 8, 10, 9, 4, 5, 6, 3, 11];
    var land = hexes.filter(function (h) { return h.terrain !== 'waste'; });
    var ok = false, guard = 0;
    while (!ok && guard++ < 4000) {
      shuffle(tokens, rng);
      land.forEach(function (h, i) { h.num = tokens[i]; });
      ok = true;
      for (var i = 0; i < hexes.length && ok; i++) {
        var h = hexes[i];
        if (h.num !== 6 && h.num !== 8) continue;
        for (var k = 0; k < h.nb.length; k++) {
          var n = hexes[h.nb[k]];
          if (n.num === 6 || n.num === 8) { ok = false; break; }
        }
      }
    }
    hexes.forEach(function (h) { if (h.terrain === 'waste') h.num = 0; });

    // vertices + edges
    var verts = {}, edges = {};
    hexes.forEach(function (h) {
      var pts = [];
      for (var i = 0; i < 6; i++) {
        var p = corner(h.cx, h.cz, i), k = vkey(p);
        if (!verts[k]) verts[k] = { key: k, x: p.x, z: p.z, hexes: [], adj: [] };
        if (verts[k].hexes.indexOf(h.id) < 0) verts[k].hexes.push(h.id);
        pts.push(k);
      }
      for (var j = 0; j < 6; j++) {
        var a = pts[j], b = pts[(j + 1) % 6], k2 = ekey(a, b);
        if (!edges[k2]) edges[k2] = { key: k2, a: a, b: b, hexes: [] };
        if (edges[k2].hexes.indexOf(h.id) < 0) edges[k2].hexes.push(h.id);
      }
    });
    Object.keys(edges).forEach(function (k) {
      var e = edges[k];
      if (verts[e.a].adj.indexOf(e.b) < 0) verts[e.a].adj.push(e.b);
      if (verts[e.b].adj.indexOf(e.a) < 0) verts[e.b].adj.push(e.a);
    });

    // ports on coastal edges, evenly spaced around the rim
    var coast = Object.keys(edges).filter(function (k) { return edges[k].hexes.length === 1; })
      .map(function (k) { return edges[k]; });
    coast.forEach(function (e) {
      var mx = (verts[e.a].x + verts[e.b].x) / 2, mz = (verts[e.a].z + verts[e.b].z) / 2;
      e.ang = Math.atan2(mz, mx);
    });
    coast.sort(function (p, q2) { return p.ang - q2.ang; });
    var ptypes = shuffle(['any', 'any', 'any', 'any', 'timber', 'clay', 'fleece', 'grain', 'ore'], rng);
    var ports = [];
    for (var pi = 0; pi < 9; pi++) {
      var e2 = coast[Math.round(pi * coast.length / 9) % coast.length];
      ports.push({ edge: e2.key, a: e2.a, b: e2.b, type: ptypes[pi] });
    }

    return { hexes: hexes, verts: verts, edges: edges, ports: ports };
  }

  /* ---------- game creation ---------- */
  function emptyHand() { return { timber: 0, clay: 0, fleece: 0, grain: 0, ore: 0 }; }

  function devDeck(rng) {
    var d = [];
    for (var i = 0; i < 14; i++) d.push('knight');
    for (var j = 0; j < 5; j++) d.push('point');
    for (var k = 0; k < 2; k++) d.push('roads');
    for (var m = 0; m < 2; m++) d.push('plenty');
    for (var n = 0; n < 2; n++) d.push('monopoly');
    return shuffle(d, rng);
  }

  function createGame(opts) {
    var seed = opts.seed != null ? opts.seed : (hashCode(opts.code || 'TIDE') ^ 0x5f3a) >>> 0;
    var board = genBoard(seed);
    var rng = mulberry32(seed ^ 0x9e37);
    var waste = board.hexes.filter(function (h) { return h.terrain === 'waste'; })[0];
    return {
      v: 1,
      code: opts.code || 'LOCAL',
      mode: opts.mode || 'remote',
      seed: seed,
      target: opts.target || 10,
      board: board,
      players: [],
      buildings: {},   // vertKey -> {p, type:'settlement'|'city'}
      roads: {},       // edgeKey -> playerIndex
      robber: waste ? waste.id : 0,
      bank: { timber: 19, clay: 19, fleece: 19, grain: 19, ore: 19 },
      dev: devDeck(rng),
      phase: 'lobby',
      turn: 0,
      dice: null,
      setupStep: 0,
      pendingDiscard: [],
      freeRoads: 0,
      playedDevThisTurn: false,
      offersThisTurn: 0,
      trade: null,
      longest: { p: -1, len: 0 },
      army: { p: -1, n: 0 },
      winner: -1,
      log: []
    };
  }

  function addPlayer(g, name, pid, opts) {
    if (g.players.length >= 6) return { ok: false, error: 'Table is full — six players maximum.' };
    if (g.phase !== 'lobby') return { ok: false, error: 'This game has already started.' };
    opts = opts || {};
    var i = g.players.length;
    g.players.push({
      id: pid, name: name || ('Player ' + (i + 1)), color: COLORS[i],
      hand: emptyHand(), dev: [], newDev: [], knights: 0,
      roadsLeft: 15, settLeft: 5, cityLeft: 4, ports: [], connected: true,
      bot: !!opts.bot, level: opts.bot ? (opts.level || 'steady') : null
    });
    return { ok: true, index: i };
  }

  function startGame(g) {
    if (g.players.length < 2) return { ok: false, error: 'You need at least two players to start.' };
    g.phase = 'setup';
    g.setupStep = 0;
    g.turn = 0;
    log(g, g.players[0].name + ' places first.');
    return { ok: true };
  }

  function log(g, s) { g.log.push(s); if (g.log.length > 60) g.log.shift(); }

  /* ---------- helpers ---------- */
  function canPay(hand, cost) {
    for (var k in cost) if ((hand[k] || 0) < cost[k]) return false;
    return true;
  }
  function pay(g, pl, cost) {
    for (var k in cost) { pl.hand[k] -= cost[k]; g.bank[k] += cost[k]; }
  }
  function handSize(h) { var n = 0; for (var k in h) n += h[k]; return n; }

  function setupOrder(g) {
    // snake: 0..n-1 then n-1..0
    var n = g.players.length, o = [];
    for (var i = 0; i < n; i++) o.push(i);
    for (var j = n - 1; j >= 0; j--) o.push(j);
    return o;
  }
  function setupCurrent(g) {
    var o = setupOrder(g);
    return g.setupStep < o.length ? o[g.setupStep] : -1;
  }
  function currentPlayer(g) {
    if (g.phase === 'setup') return setupCurrent(g);
    return g.turn;
  }

  function vertexOpen(g, vk) {
    if (g.buildings[vk]) return false;
    var v = g.board.verts[vk];
    if (!v) return false;
    for (var i = 0; i < v.adj.length; i++) if (g.buildings[v.adj[i]]) return false;
    return true;
  }
  function playerTouchesVertex(g, pi, vk) {
    var v = g.board.verts[vk];
    for (var i = 0; i < v.adj.length; i++) {
      var e = g.board.edges[ekey(vk, v.adj[i])];
      if (e && g.roads[e.key] === pi) return true;
    }
    return false;
  }
  function legalSettlementSpots(g, pi, setup) {
    var out = [];
    for (var k in g.board.verts) {
      if (!vertexOpen(g, k)) continue;
      if (!setup && !playerTouchesVertex(g, pi, k)) continue;
      out.push(k);
    }
    return out;
  }
  function legalRoadSpots(g, pi, fromVert) {
    var out = [];
    for (var k in g.board.edges) {
      if (g.roads[k] != null) continue;
      var e = g.board.edges[k];
      if (fromVert) { if (e.a === fromVert || e.b === fromVert) out.push(k); continue; }
      var touch = false;
      [e.a, e.b].forEach(function (vk) {
        var b = g.buildings[vk];
        if (b && b.p === pi) touch = true;
        if (b && b.p !== pi) return; // enemy building blocks pass-through
        var v = g.board.verts[vk];
        for (var i = 0; i < v.adj.length; i++) {
          var e2 = g.board.edges[ekey(vk, v.adj[i])];
          if (e2 && g.roads[e2.key] === pi && !(b && b.p !== pi)) touch = true;
        }
      });
      if (touch) out.push(k);
    }
    return out;
  }

  function recomputePorts(g, pi) {
    var pl = g.players[pi], set = {};
    g.board.ports.forEach(function (p) {
      var ba = g.buildings[p.a], bb = g.buildings[p.b];
      if ((ba && ba.p === pi) || (bb && bb.p === pi)) set[p.type] = true;
    });
    pl.ports = Object.keys(set);
  }

  /* ---------- longest road ---------- */
  function longestRoadFor(g, pi) {
    var adj = {};
    Object.keys(g.roads).forEach(function (k) {
      if (g.roads[k] !== pi) return;
      var e = g.board.edges[k];
      (adj[e.a] = adj[e.a] || []).push({ to: e.b, e: k });
      (adj[e.b] = adj[e.b] || []).push({ to: e.a, e: k });
    });
    var best = 0;
    var blocked = function (vk) {
      var b = g.buildings[vk];
      return b && b.p !== pi;
    };
    function dfs(vk, used, len) {
      if (len > best) best = len;
      var list = adj[vk] || [];
      for (var i = 0; i < list.length; i++) {
        var step = list[i];
        if (used[step.e]) continue;
        if (blocked(step.to)) { // may end here but not continue through
          if (len + 1 > best) best = len + 1;
          continue;
        }
        used[step.e] = 1;
        dfs(step.to, used, len + 1);
        used[step.e] = 0;
      }
    }
    Object.keys(adj).forEach(function (vk) {
      if (blocked(vk)) return;
      dfs(vk, {}, 0);
    });
    return best;
  }

  function updateAwards(g) {
    var bestP = -1, bestL = 4;
    for (var i = 0; i < g.players.length; i++) {
      var l = longestRoadFor(g, i);
      if (l > bestL) { bestL = l; bestP = i; }
      else if (l === bestL && g.longest.p === i) { bestP = i; }
    }
    if (bestP >= 0 && bestL >= 5) {
      // incumbent keeps it on a tie
      if (g.longest.p >= 0 && longestRoadFor(g, g.longest.p) >= bestL) {
        g.longest = { p: g.longest.p, len: longestRoadFor(g, g.longest.p) };
      } else {
        if (g.longest.p !== bestP) log(g, g.players[bestP].name + ' takes the Long Road.');
        g.longest = { p: bestP, len: bestL };
      }
    } else if (g.longest.p >= 0 && longestRoadFor(g, g.longest.p) < 5) {
      g.longest = { p: -1, len: 0 };
    }

    var aP = -1, aN = 2;
    for (var j = 0; j < g.players.length; j++) {
      if (g.players[j].knights > aN) { aN = g.players[j].knights; aP = j; }
    }
    if (aP >= 0 && aN >= 3 && g.army.p !== aP) {
      if (g.army.p < 0 || g.players[aP].knights > g.army.n) {
        log(g, g.players[aP].name + ' takes the Standing Guard.');
        g.army = { p: aP, n: aN };
      }
    } else if (aP >= 0) { g.army.n = aN; }
  }

  function vpFor(g, pi, includeHidden) {
    var pl = g.players[pi], vp = 0;
    for (var k in g.buildings) if (g.buildings[k].p === pi) vp += g.buildings[k].type === 'city' ? 2 : 1;
    if (g.longest.p === pi) vp += 2;
    if (g.army.p === pi) vp += 2;
    if (includeHidden) pl.dev.forEach(function (c) { if (c === 'point') vp += 1; });
    return vp;
  }

  function checkWin(g) {
    for (var i = 0; i < g.players.length; i++) {
      if (vpFor(g, i, true) >= g.target) {
        g.winner = i; g.phase = 'over';
        log(g, g.players[i].name + ' reaches ' + g.target + ' points and wins.');
        return true;
      }
    }
    return false;
  }

  /* ---------- production ---------- */
  function produce(g, roll) {
    var gain = {}; // pi -> hand
    g.board.hexes.forEach(function (h) {
      if (h.num !== roll || h.id === g.robber || !TERRAIN[h.terrain]) return;
      var res = TERRAIN[h.terrain];
      for (var k in g.board.verts) {
        var v = g.board.verts[k];
        if (v.hexes.indexOf(h.id) < 0) continue;
        var b = g.buildings[k];
        if (!b) continue;
        gain[b.p] = gain[b.p] || emptyHand();
        gain[b.p][res] += b.type === 'city' ? 2 : 1;
      }
    });
    // bank shortage rule: if demand exceeds supply and more than one player wants it, nobody gets it
    RES.forEach(function (res) {
      var demand = 0, claimants = 0;
      for (var pi in gain) { if (gain[pi][res] > 0) { demand += gain[pi][res]; claimants++; } }
      if (demand <= g.bank[res]) return;
      if (claimants > 1) { for (var p2 in gain) gain[p2][res] = 0; log(g, 'The ' + res + ' stores ran dry — no one collects.'); }
      else { for (var p3 in gain) if (gain[p3][res] > 0) gain[p3][res] = g.bank[res]; }
    });
    for (var pi2 in gain) {
      var pl = g.players[pi2], got = [];
      RES.forEach(function (res) {
        var n = gain[pi2][res];
        if (n > 0) { pl.hand[res] += n; g.bank[res] -= n; got.push(n + ' ' + res); }
      });
      if (got.length) log(g, pl.name + ' collects ' + got.join(', ') + '.');
    }
  }

  function robberVictims(g, hexId, pi) {
    var out = [];
    for (var k in g.board.verts) {
      var v = g.board.verts[k];
      if (v.hexes.indexOf(hexId) < 0) continue;
      var b = g.buildings[k];
      if (b && b.p !== pi && out.indexOf(b.p) < 0 && handSize(g.players[b.p].hand) > 0) out.push(b.p);
    }
    return out;
  }

  function tradeRate(g, pi, res) {
    var pl = g.players[pi];
    if (pl.ports.indexOf(res) >= 0) return 2;
    if (pl.ports.indexOf('any') >= 0) return 3;
    return 4;
  }

  /* ---------- turn flow ---------- */
  function beginTurn(g) {
    g.dice = null;
    g.phase = 'roll';
    g.freeRoads = 0;
    g.playedDevThisTurn = false;
    g.offersThisTurn = 0;
    g.trade = null;
    var pl = g.players[g.turn];
    pl.dev = pl.dev.concat(pl.newDev);
    pl.newDev = [];
  }

  function endTurn(g) {
    updateAwards(g);
    if (checkWin(g)) return;
    g.turn = (g.turn + 1) % g.players.length;
    beginTurn(g);
  }

  /* ---------- actions ---------- */
  function applyAction(g, pi, a) {
    var pl = g.players[pi];
    if (!pl) return { ok: false, error: 'You are not seated at this table.' };
    if (g.phase === 'over') return { ok: false, error: 'The game is finished.' };

    // discard is the one action taken out of turn
    if (a.type === 'discard') {
      var idx = g.pendingDiscard.indexOf(pi);
      if (idx < 0) return { ok: false, error: 'You have nothing to discard.' };
      var need = Math.floor(handSize(pl.hand) / 2), total = 0;
      for (var k in a.cards) {
        if ((pl.hand[k] || 0) < a.cards[k]) return { ok: false, error: 'You do not hold that many cards.' };
        total += a.cards[k];
      }
      if (total !== need) return { ok: false, error: 'Discard exactly ' + need + ' cards.' };
      for (var k2 in a.cards) { pl.hand[k2] -= a.cards[k2]; g.bank[k2] += a.cards[k2]; }
      g.pendingDiscard.splice(idx, 1);
      log(g, pl.name + ' discards ' + need + '.');
      if (g.pendingDiscard.length === 0) g.phase = 'robber';
      return { ok: true };
    }

    if (a.type === 'respondTrade') {
      if (!g.trade) return { ok: false, error: 'There is no offer on the table.' };
      if (g.trade.to.indexOf(pi) < 0) return { ok: false, error: 'That offer is not addressed to you.' };
      if (!a.accept) {
        g.trade.declined.push(pi);
        return { ok: true };
      }
      var from = g.players[g.trade.from];
      if (!canPay(pl.hand, g.trade.get)) return { ok: false, error: 'You cannot cover that trade.' };
      if (!canPay(from.hand, g.trade.give)) { g.trade = null; return { ok: false, error: 'The offer expired — they no longer hold those cards.' }; }
      for (var gk in g.trade.give) { from.hand[gk] -= g.trade.give[gk]; pl.hand[gk] = (pl.hand[gk] || 0) + g.trade.give[gk]; }
      for (var rk in g.trade.get) { pl.hand[rk] -= g.trade.get[rk]; from.hand[rk] = (from.hand[rk] || 0) + g.trade.get[rk]; }
      log(g, from.name + ' trades with ' + pl.name + '.');
      g.trade = null;
      return { ok: true };
    }

    if (currentPlayer(g) !== pi) return { ok: false, error: 'It is not your turn.' };

    switch (a.type) {
      case 'setupPlace': {
        if (g.phase !== 'setup') return { ok: false, error: 'Setup is over.' };
        if (!vertexOpen(g, a.vert)) return { ok: false, error: 'Too close to another settlement.' };
        var e = g.board.edges[a.edge];
        if (!e || g.roads[a.edge] != null) return { ok: false, error: 'That road slot is taken.' };
        if (e.a !== a.vert && e.b !== a.vert) return { ok: false, error: 'The road must touch your new settlement.' };
        g.buildings[a.vert] = { p: pi, type: 'settlement' };
        g.roads[a.edge] = pi;
        pl.settLeft--; pl.roadsLeft--;
        recomputePorts(g, pi);
        var second = g.setupStep >= g.players.length;
        if (second) {
          var v = g.board.verts[a.vert], got = [];
          v.hexes.forEach(function (hid) {
            var h = g.board.hexes[hid], res = TERRAIN[h.terrain];
            if (res && g.bank[res] > 0) { pl.hand[res]++; g.bank[res]--; got.push(res); }
          });
          if (got.length) log(g, pl.name + ' starts with ' + got.join(', ') + '.');
        }
        g.setupStep++;
        if (g.setupStep >= setupOrder(g).length) {
          g.turn = 0; beginTurn(g); log(g, 'Setup complete. ' + g.players[0].name + ' rolls first.');
        }
        updateAwards(g);
        return { ok: true };
      }

      case 'roll': {
        if (g.phase !== 'roll') return { ok: false, error: 'You have already rolled.' };
        var r1 = 1 + Math.floor(nextRand(g) * 6), r2 = 1 + Math.floor(nextRand(g) * 6);
        g.dice = [r1, r2];
        var sum = r1 + r2;
        log(g, pl.name + ' rolls ' + sum + '.');
        if (sum === 7) {
          g.pendingDiscard = [];
          for (var i = 0; i < g.players.length; i++) if (handSize(g.players[i].hand) > 7) g.pendingDiscard.push(i);
          g.phase = g.pendingDiscard.length ? 'discard' : 'robber';
        } else {
          produce(g, sum);
          g.phase = 'main';
        }
        return { ok: true };
      }

      case 'moveRobber': {
        if (g.phase !== 'robber') return { ok: false, error: 'The robber is not in play right now.' };
        if (a.hex === g.robber) return { ok: false, error: 'The robber must move to a new hex.' };
        g.robber = a.hex;
        var vics = robberVictims(g, a.hex, pi);
        if (vics.length === 0) { g.phase = 'main'; log(g, pl.name + ' moves the robber.'); return { ok: true }; }
        var victim = a.victim != null ? a.victim : vics[0];
        if (vics.indexOf(victim) < 0) return { ok: false, error: 'You cannot rob that player from here.', victims: vics };
        var vp2 = g.players[victim], pool = [];
        RES.forEach(function (res) { for (var n = 0; n < vp2.hand[res]; n++) pool.push(res); });
        var pick = pool[Math.floor(nextRand(g) * pool.length)];
        vp2.hand[pick]--; pl.hand[pick]++;
        log(g, pl.name + ' robs ' + vp2.name + '.');
        g.phase = 'main';
        return { ok: true };
      }

      case 'buildRoad': {
        if (g.phase !== 'main') return { ok: false, error: 'Roll the dice first.' };
        if (g.roads[a.edge] != null) return { ok: false, error: 'That road slot is taken.' };
        if (pl.roadsLeft <= 0) return { ok: false, error: 'You have no road pieces left.' };
        if (legalRoadSpots(g, pi).indexOf(a.edge) < 0) return { ok: false, error: 'Roads must extend your own network.' };
        if (g.freeRoads > 0) g.freeRoads--;
        else { if (!canPay(pl.hand, COST.road)) return { ok: false, error: 'Roads cost 1 timber and 1 clay.' }; pay(g, pl, COST.road); }
        g.roads[a.edge] = pi; pl.roadsLeft--;
        updateAwards(g); checkWin(g);
        return { ok: true };
      }

      case 'buildSettlement': {
        if (g.phase !== 'main') return { ok: false, error: 'Roll the dice first.' };
        if (pl.settLeft <= 0) return { ok: false, error: 'You have no settlement pieces left.' };
        if (!vertexOpen(g, a.vert)) return { ok: false, error: 'Too close to another settlement.' };
        if (!playerTouchesVertex(g, pi, a.vert)) return { ok: false, error: 'You need a road running to that corner.' };
        if (!canPay(pl.hand, COST.settlement)) return { ok: false, error: 'Settlements cost timber, clay, fleece and grain.' };
        pay(g, pl, COST.settlement);
        g.buildings[a.vert] = { p: pi, type: 'settlement' };
        pl.settLeft--;
        recomputePorts(g, pi);
        log(g, pl.name + ' founds a settlement.');
        updateAwards(g); checkWin(g);
        return { ok: true };
      }

      case 'buildCity': {
        if (g.phase !== 'main') return { ok: false, error: 'Roll the dice first.' };
        var b2 = g.buildings[a.vert];
        if (!b2 || b2.p !== pi || b2.type !== 'settlement') return { ok: false, error: 'Pick one of your own settlements.' };
        if (pl.cityLeft <= 0) return { ok: false, error: 'You have no city pieces left.' };
        if (!canPay(pl.hand, COST.city)) return { ok: false, error: 'Cities cost 2 grain and 3 ore.' };
        pay(g, pl, COST.city);
        b2.type = 'city'; pl.cityLeft--; pl.settLeft++;
        log(g, pl.name + ' raises a city.');
        checkWin(g);
        return { ok: true };
      }

      case 'buyDev': {
        if (g.phase !== 'main') return { ok: false, error: 'Roll the dice first.' };
        if (!g.dev.length) return { ok: false, error: 'The development deck is empty.' };
        if (!canPay(pl.hand, COST.dev)) return { ok: false, error: 'Development cards cost fleece, grain and ore.' };
        pay(g, pl, COST.dev);
        var c = g.dev.pop();
        pl.newDev.push(c);
        log(g, pl.name + ' buys a development card.');
        checkWin(g);
        return { ok: true, drew: c };
      }

      case 'playDev': {
        if (g.phase !== 'main' && !(g.phase === 'roll' && a.card === 'knight'))
          return { ok: false, error: 'You cannot play that right now.' };
        if (g.playedDevThisTurn) return { ok: false, error: 'One development card per turn.' };
        var ci = pl.dev.indexOf(a.card);
        if (ci < 0) return { ok: false, error: 'That card is not in your hand yet.' };
        if (a.card === 'point') return { ok: false, error: 'Victory point cards stay hidden until you win.' };
        pl.dev.splice(ci, 1);
        g.playedDevThisTurn = true;
        if (a.card === 'knight') {
          pl.knights++;
          g.phase = 'robber';
          log(g, pl.name + ' plays a Knight.');
          updateAwards(g); checkWin(g);
        } else if (a.card === 'roads') {
          g.freeRoads = 2;
          log(g, pl.name + ' plays Road Building.');
        } else if (a.card === 'plenty') {
          var picks = a.picks || [];
          if (picks.length !== 2) return { ok: false, error: 'Choose two resources.' };
          picks.forEach(function (r) { if (g.bank[r] > 0) { pl.hand[r]++; g.bank[r]--; } });
          log(g, pl.name + ' takes ' + picks.join(' and ') + ' from the stores.');
        } else if (a.card === 'monopoly') {
          var res2 = a.res, taken = 0;
          g.players.forEach(function (o, oi) {
            if (oi === pi) return;
            taken += o.hand[res2]; pl.hand[res2] += o.hand[res2]; o.hand[res2] = 0;
          });
          log(g, pl.name + ' monopolises ' + res2 + ' and takes ' + taken + '.');
        }
        return { ok: true };
      }

      case 'bankTrade': {
        if (g.phase !== 'main') return { ok: false, error: 'Roll the dice first.' };
        var rate = tradeRate(g, pi, a.give);
        if (pl.hand[a.give] < rate) return { ok: false, error: 'You need ' + rate + ' ' + a.give + ' for that trade.' };
        if (g.bank[a.get] <= 0) return { ok: false, error: 'The stores are out of ' + a.get + '.' };
        pl.hand[a.give] -= rate; g.bank[a.give] += rate;
        pl.hand[a.get]++; g.bank[a.get]--;
        log(g, pl.name + ' trades ' + rate + ' ' + a.give + ' for 1 ' + a.get + '.');
        return { ok: true };
      }

      case 'offerTrade': {
        if (g.phase !== 'main') return { ok: false, error: 'Roll the dice first.' };
        if (!canPay(pl.hand, a.give)) return { ok: false, error: 'You do not hold what you are offering.' };
        var to = [];
        for (var t = 0; t < g.players.length; t++) if (t !== pi) to.push(t);
        g.trade = { from: pi, give: a.give, get: a.get, to: to, declined: [] };
        g.offersThisTurn = (g.offersThisTurn || 0) + 1;
        log(g, pl.name + ' opens a trade.');
        return { ok: true };
      }

      case 'cancelTrade': { g.trade = null; return { ok: true }; }

      case 'endTurn': {
        if (g.phase !== 'main') return { ok: false, error: 'Roll the dice first.' };
        endTurn(g);
        return { ok: true };
      }
    }
    return { ok: false, error: 'Unknown action.' };
  }

  // Dice and steals draw from a counter-seeded stream so the whole game state
  // stays plain JSON — no rng object to serialise into Redis.
  function nextRand(g) {
    g.rollSeq = (g.rollSeq || 0) + 1;
    var s = (g.seed ^ Math.imul(g.rollSeq, 2654435761)) >>> 0;
    return mulberry32(s)();
  }

  /* ---------- redaction: what a given player is allowed to see ---------- */
  function redact(g, pid) {
    var me = -1;
    for (var i = 0; i < g.players.length; i++) if (g.players[i].id === pid) me = i;
    var out = JSON.parse(JSON.stringify(g));
    out.me = me;
    out.devLeft = g.dev.length;
    delete out.dev;
    out.players.forEach(function (p, i) {
      p.vp = vpFor(g, i, false);
      p.handCount = handSize(p.hand);
      p.devCount = p.dev.length + p.newDev.length;
      if (i !== me && g.phase !== 'over') {
        p.hand = null;
        p.dev = null;
        p.newDev = null;
      }
    });
    return out;
  }

  return {
    RES: RES, TERRAIN: TERRAIN, COST: COST, COLORS: COLORS,
    createGame: createGame, addPlayer: addPlayer, startGame: startGame,
    applyAction: applyAction, redact: redact,
    legalSettlementSpots: legalSettlementSpots, legalRoadSpots: legalRoadSpots,
    robberVictims: robberVictims, longestRoadFor: longestRoadFor,
    vpFor: vpFor, tradeRate: tradeRate, handSize: handSize,
    currentPlayer: currentPlayer, setupCurrent: setupCurrent, setupOrder: setupOrder,
    vertexOpen: vertexOpen, ekey: ekey, canPay: canPay, emptyHand: emptyHand
  };
});
