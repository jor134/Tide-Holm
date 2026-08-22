/* TIDEHOLM — bot opponents.
   Loaded by the browser via <script src="bot.js"> and by the tests via require().

   Bots reason from E.redact(state, ownId) — the same censored view a human
   player gets. They cannot see opponents' hands or development cards, and they
   do not get bonus resources at any level. Everything below is heuristic; a
   Sharp bot plays a coherent game and an attentive human should still beat it. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.BOT = factory(root.ENGINE);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  var RES = E.RES, TERRAIN = E.TERRAIN, COST = E.COST;

  var LEVELS = {
    casual: {
      name: 'Casual',
      blurb: 'Builds whatever it can afford. Takes most fair trades. Does not watch the leader.',
      lookahead: 0,      // does not save toward a target
      tradeMargin: 1.0,  // accepts anything not actively bad
      leaderAware: false,
      initiates: false,
      banks: false,          // does not convert a surplus at the stores
      placementNoise: 0.6,
      robberSpite: 0
    },
    steady: {
      name: 'Steady',
      blurb: 'Saves toward a build target, trades for what it needs, robs the strongest hex.',
      lookahead: 1,
      tradeMargin: 1.08,
      leaderAware: false,
      initiates: true,
      banks: true,
      placementNoise: 0.26,
      robberSpite: 1
    },
    sharp: {
      name: 'Sharp',
      blurb: 'Tracks who is winning, refuses trades that help them, and robs to slow them down.',
      lookahead: 2,
      tradeMargin: 1.3,
      leaderAware: true,
      initiates: true,
      banks: true,
      placementNoise: 0,
      robberSpite: 2
    }
  };

  function lv(level) { return LEVELS[level] || LEVELS.steady; }
  function pips(n) { return n ? 6 - Math.abs(7 - n) : 0; }
  function emptyRes() { return { timber: 0, clay: 0, fleece: 0, grain: 0, ore: 0 }; }
  function total(o) { var n = 0; for (var k in o) n += o[k]; return n; }

  /* deterministic jitter so bots differ from each other without needing rng state */
  function jitter(v, seat, salt) {
    var h = ((v.seed ^ Math.imul(seat + 1, 2246822519)) ^ Math.imul(salt || 1, 3266489917)) >>> 0;
    h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13;
    return ((h >>> 0) % 1000) / 1000;
  }

  /* ---------- board reading ---------- */

  // pips per resource that a player's buildings currently earn
  function production(v, me) {
    var p = emptyRes();
    Object.keys(v.buildings).forEach(function (k) {
      var b = v.buildings[k];
      if (b.p !== me) return;
      var mult = b.type === 'city' ? 2 : 1;
      v.board.verts[k].hexes.forEach(function (hid) {
        var h = v.board.hexes[hid], res = TERRAIN[h.terrain];
        if (res && h.num && hid !== v.robber) p[res] += pips(h.num) * mult;
      });
    });
    return p;
  }

  function leaderOf(v, me) {
    var best = -1, bestVp = -1;
    v.players.forEach(function (p, i) {
      if (i === me) return;
      var vp = p.vp + (p.devCount || 0) * 0.35;   // unseen cards might be points
      if (vp > bestVp) { bestVp = vp; best = i; }
    });
    return { seat: best, vp: bestVp };
  }

  /* What one card of each resource is worth to this bot right now.
     Scarcity in its own production, plus how much the current build target
     still needs. Cards it already has a surplus of are worth less. */
  function values(v, me, L, target) {
    var prod = production(v, me);
    var hand = v.players[me].hand || emptyRes();
    var need = target ? shortfall(hand, target.cost) : emptyRes();
    var out = {};
    RES.forEach(function (r) {
      var scarcity = 3 / (1 + prod[r] * 0.6);       // no production => expensive
      var wanted = 1 + (need[r] || 0) * (0.7 + L.lookahead * 0.5);
      var glut = hand[r] > 4 ? 0.6 : hand[r] > 2 ? 0.85 : 1;
      out[r] = scarcity * wanted * glut;
    });
    return out;
  }

  function shortfall(hand, cost) {
    var s = emptyRes();
    for (var k in cost) s[k] = Math.max(0, cost[k] - (hand[k] || 0));
    return s;
  }

  /* ---------- opening placement ---------- */

  function vertexScore(v, me, L, vk, second) {
    var vert = v.board.verts[vk];
    var byRes = emptyRes(), sum = 0, distinct = {};
    vert.hexes.forEach(function (hid) {
      var h = v.board.hexes[hid], res = TERRAIN[h.terrain];
      if (!res || !h.num) return;
      var p = pips(h.num);
      byRes[res] += p; sum += p; distinct[res] = 1;
    });
    if (sum === 0) return -1;   // all desert / no numbers

    // resource weights: ore and grain carry the late game, clay and timber the early one
    var W = { timber: 1.0, clay: 1.05, fleece: 0.8, grain: 1.15, ore: 1.1 };
    var score = 0;
    RES.forEach(function (r) { score += byRes[r] * W[r]; });

    // three distinct resources beats a double on one
    score += Object.keys(distinct).length * 1.6;

    // complement what the bot already owns
    if (second) {
      var prod = production(v, me);
      RES.forEach(function (r) { if (byRes[r] > 0 && prod[r] === 0) score += 3.2; });
    }

    // ports
    v.board.ports.forEach(function (p) {
      if (p.a !== vk && p.b !== vk) return;
      if (p.type === 'any') score += 1.4;
      else score += 1.0 + byRes[p.type] * 0.5;   // a 2:1 is only good if you produce it
    });

    // deny the strongest remaining spot to everyone else
    if (L.leaderAware) score += Math.min(sum, 12) * 0.12;

    if (L.placementNoise) score *= 1 - L.placementNoise / 2 + jitter(v, me, vk.length + sum) * L.placementNoise;
    return score;
  }

  function setupMove(v, me, L) {
    var second = v.setupStep >= v.players.length;
    var spots = E.legalSettlementSpots(v, me, true);
    if (!spots.length) return null;
    var best = null, bestScore = -Infinity;
    spots.forEach(function (vk) {
      var s = vertexScore(v, me, L, vk, second);
      if (s > bestScore) { bestScore = s; best = vk; }
    });

    // road points at the best open vertex two steps away
    var vert = v.board.verts[best], bestEdge = null, bestNext = -Infinity;
    vert.adj.forEach(function (nb) {
      var ek = E.ekey(best, nb);
      if (v.roads[ek] != null) return;
      var onward = 0;
      var nbv = v.board.verts[nb];
      nbv.adj.forEach(function (n2) {
        if (n2 === best) return;
        if (!E.vertexOpen(v, n2)) return;
        onward = Math.max(onward, vertexScore(v, me, L, n2, true));
      });
      if (onward > bestNext) { bestNext = onward; bestEdge = ek; }
    });
    if (!bestEdge) {
      for (var i = 0; i < vert.adj.length; i++) {
        var k = E.ekey(best, vert.adj[i]);
        if (v.roads[k] == null) { bestEdge = k; break; }
      }
    }
    if (!bestEdge) return null;
    return { type: 'setupPlace', vert: best, edge: bestEdge };
  }

  /* ---------- what to build next ---------- */

  function bestSettlementSpot(v, me, L) {
    var spots = E.legalSettlementSpots(v, me, false);
    var best = null, bestScore = -Infinity;
    spots.forEach(function (vk) {
      var s = vertexScore(v, me, L, vk, true);
      if (s > bestScore) { bestScore = s; best = vk; }
    });
    return best ? { vert: best, score: bestScore } : null;
  }

  function bestCitySpot(v, me, L) {
    var mine = Object.keys(v.buildings).filter(function (k) {
      return v.buildings[k].p === me && v.buildings[k].type === 'settlement';
    });
    var best = null, bestScore = -Infinity;
    mine.forEach(function (vk) {
      var s = 0;
      v.board.verts[vk].hexes.forEach(function (hid) {
        var h = v.board.hexes[hid];
        if (TERRAIN[h.terrain] && h.num) s += pips(h.num);
      });
      if (s > bestScore) { bestScore = s; best = vk; }
    });
    return best ? { vert: best, score: bestScore } : null;
  }

  // a road is only worth building if it opens a settlement spot soon
  function bestRoad(v, me, L) {
    var spots = E.legalRoadSpots(v, me);
    if (!spots.length) return null;
    var best = null, bestScore = -Infinity;
    spots.forEach(function (ek) {
      var e = v.board.edges[ek];
      var s = 0;
      [e.a, e.b].forEach(function (vk) {
        if (E.vertexOpen(v, vk)) s = Math.max(s, vertexScore(v, me, L, vk, true) * 0.9);
        v.board.verts[vk].adj.forEach(function (n) {
          if (E.vertexOpen(v, n)) s = Math.max(s, vertexScore(v, me, L, n, true) * 0.45);
        });
      });
      // chasing the Long Road is worth something once the network is real
      if (L.lookahead > 0 && v.longest.p !== me) s += Math.min(E.longestRoadFor(v, me), 6) * 0.35;
      if (s > bestScore) { bestScore = s; best = ek; }
    });
    return best ? { edge: best, score: bestScore } : null;
  }

  function plan(v, me, L) {
    var p = v.players[me];
    var options = [];
    var city = p.cityLeft > 0 ? bestCitySpot(v, me, L) : null;
    if (city) options.push({ kind: 'city', cost: COST.city, vert: city.vert, worth: 10 + city.score * 0.9 });

    var sett = p.settLeft > 0 ? bestSettlementSpot(v, me, L) : null;
    if (sett) options.push({ kind: 'settlement', cost: COST.settlement, vert: sett.vert, worth: 9 + sett.score * 0.7 });

    if (p.roadsLeft > 0) {
      var road = bestRoad(v, me, L);
      if (road && road.score > 3) options.push({ kind: 'road', cost: COST.road, edge: road.edge, worth: road.score * 0.5 });
    }

    if (v.devLeft > 0) {
      var devWorth = 5.5;
      if (L.lookahead > 0 && p.knights >= 1 && v.army.p !== me) devWorth += 1.6;   // chase the guard
      if (!sett && !city) devWorth += 2;                                            // nothing else to do
      options.push({ kind: 'dev', cost: COST.dev, worth: devWorth });
    }

    if (!options.length) return null;
    options.sort(function (a, b) { return b.worth - a.worth; });
    // Casual bots do not save; they take the best thing they can afford right now
    if (L.lookahead === 0) {
      var affordable = options.filter(function (o) { return E.canPay(v.players[me].hand, o.cost); });
      return affordable.length ? affordable[0] : options[0];
    }
    return options[0];
  }

  function buildAction(target) {
    if (target.kind === 'city') return { type: 'buildCity', vert: target.vert };
    if (target.kind === 'settlement') return { type: 'buildSettlement', vert: target.vert };
    if (target.kind === 'road') return { type: 'buildRoad', edge: target.edge };
    return { type: 'buyDev' };
  }

  /* ---------- development cards ---------- */

  function devMove(v, me, L, target) {
    var p = v.players[me];
    var dev = p.dev || [];
    if (v.playedDevThisTurn) return null;

    // Monopoly: only when it actually collects something worth having
    if (dev.indexOf('monopoly') >= 0) {
      var need = target ? shortfall(p.hand, target.cost) : emptyRes();
      var pick = null, bestN = 0;
      RES.forEach(function (r) {
        // estimate: opponents' hand sizes weighted by how much of that resource they produce
        var est = 0;
        v.players.forEach(function (o, i) {
          if (i === me) return;
          var prod = production(v, i);
          var share = prod[r] / (1 + total(prod));
          est += (o.handCount || 0) * share;
        });
        var worth = est * (1 + (need[r] || 0));
        if (worth > bestN) { bestN = worth; pick = r; }
      });
      if (pick && bestN >= (L.lookahead > 1 ? 2.5 : 1.8)) return { type: 'playDev', card: 'monopoly', res: pick };
    }

    // Bounty: take exactly what completes the target
    if (dev.indexOf('plenty') >= 0 && target) {
      var s = shortfall(p.hand, target.cost), picks = [];
      RES.forEach(function (r) { for (var i = 0; i < s[r] && picks.length < 2; i++) picks.push(r); });
      if (picks.length === 2) return { type: 'playDev', card: 'plenty', picks: picks };
      if (picks.length === 1) {
        var val = values(v, me, L, target), second = null, bv = -1;
        RES.forEach(function (r) { if (val[r] > bv) { bv = val[r]; second = r; } });
        picks.push(second);
        return { type: 'playDev', card: 'plenty', picks: picks };
      }
    }

    // Road Building: only with somewhere worth going
    if (dev.indexOf('roads') >= 0 && v.players[me].roadsLeft >= 2) {
      var r2 = bestRoad(v, me, L);
      if (r2 && r2.score > 4) return { type: 'playDev', card: 'roads' };
    }

    // Knight: to unblock our own hexes, or to take the Standing Guard
    if (dev.indexOf('knight') >= 0) {
      var blocked = blockedByRobber(v, me);
      var wouldTakeGuard = L.lookahead > 0 && p.knights + 1 >= 3 &&
        (v.army.p !== me) && (v.army.p < 0 || p.knights + 1 > v.players[v.army.p].knights);
      if (blocked > 2 || wouldTakeGuard) return { type: 'playDev', card: 'knight' };
    }
    return null;
  }

  function blockedByRobber(v, me) {
    var n = 0;
    Object.keys(v.buildings).forEach(function (k) {
      var b = v.buildings[k];
      if (b.p !== me) return;
      if (v.board.verts[k].hexes.indexOf(v.robber) >= 0) {
        var h = v.board.hexes[v.robber];
        n += pips(h.num) * (b.type === 'city' ? 2 : 1);
      }
    });
    return n;
  }

  /* ---------- the raider ---------- */

  function robberMove(v, me, L) {
    var lead = leaderOf(v, me);
    var best = null, bestScore = -Infinity;
    v.board.hexes.forEach(function (h) {
      if (h.id === v.robber) return;
      var score = 0, hitsSelf = false;
      Object.keys(v.board.verts).forEach(function (k) {
        if (v.board.verts[k].hexes.indexOf(h.id) < 0) return;
        var b = v.buildings[k];
        if (!b) return;
        var weight = pips(h.num) * (b.type === 'city' ? 2 : 1);
        if (b.p === me) { score -= weight * 6; hitsSelf = true; }
        else {
          var mult = 1;
          if (L.robberSpite && b.p === lead.seat) mult += 0.6 * L.robberSpite;
          if (L.leaderAware && v.players[b.p].vp >= v.target - 3) mult += 0.8;
          score += weight * mult + (v.players[b.p].handCount || 0) * 0.25;
        }
      });
      if (!hitsSelf) score += 0.5;
      if (score > bestScore) { bestScore = score; best = h.id; }
    });
    if (best == null) best = v.board.hexes.filter(function (h) { return h.id !== v.robber; })[0].id;

    var vics = E.robberVictims(v, best, me);
    var victim = null;
    if (vics.length) {
      var bv = -Infinity;
      vics.forEach(function (i) {
        var s = (v.players[i].handCount || 0);
        if (L.leaderAware && i === lead.seat) s += 4;
        if (s > bv) { bv = s; victim = i; }
      });
    }
    return { type: 'moveRobber', hex: best, victim: victim };
  }

  /* ---------- discarding ---------- */

  function chooseDiscard(v, me, L) {
    var p = v.players[me];
    var need = Math.floor(E.handSize(p.hand) / 2);
    var target = plan(v, me, L);
    var val = values(v, me, L, target);
    var pool = [];
    RES.forEach(function (r) { for (var i = 0; i < p.hand[r]; i++) pool.push(r); });
    // shed the cheapest cards first; duplicates get cheaper as we go
    var taken = emptyRes();
    pool.sort(function (a, b) { return val[a] - val[b]; });
    var cards = {};
    for (var i = 0; i < need && i < pool.length; i++) {
      var r = pool[i];
      cards[r] = (cards[r] || 0) + 1;
      taken[r]++;
    }
    return cards;
  }

  /* ---------- trading ---------- */

  function judgeTrade(v, me, L) {
    var t = v.trade, p = v.players[me];
    if (!t) return false;
    var give = t.get, get = t.give;              // from this bot's side of the table
    if (!E.canPay(p.hand, give)) return false;

    if (L.leaderAware) {
      var them = v.players[t.from];
      if (them.vp >= v.target - 2) return false;             // do not help them close it out
      if (them.vp >= v.target - 4 && total(get) <= total(give)) return false;
    }

    var target = plan(v, me, L);
    var val = values(v, me, L, target);
    var gain = 0, loss = 0;
    for (var g in get) gain += val[g] * get[g];
    for (var l in give) loss += val[l] * give[l];

    // never trade away the last card of something scarce
    var prod = production(v, me);
    for (var k in give) {
      if (p.hand[k] - give[k] < 0) return false;
      if (prod[k] === 0 && p.hand[k] - give[k] === 0 && L.lookahead > 0) loss *= 1.6;
    }
    return gain > loss * L.tradeMargin;
  }

  function offerTrade(v, me, L, target) {
    if (!L.initiates || !target) return null;
    if (v.trade) return null;
    if ((v.offersThisTurn || 0) >= 1) return null;
    var p = v.players[me];
    var need = shortfall(p.hand, target.cost);
    var wantRes = null;
    RES.forEach(function (r) { if (need[r] > 0 && (!wantRes || need[r] > need[wantRes])) wantRes = r; });
    if (!wantRes) return null;

    var val = values(v, me, L, target);
    var spare = null, bestSpare = -Infinity;
    RES.forEach(function (r) {
      if (r === wantRes) return;
      var surplus = p.hand[r] - (target.cost[r] || 0);
      if (surplus < 1) return;
      var s = surplus * 2 - val[r];
      if (s > bestSpare) { bestSpare = s; spare = r; }
    });
    if (!spare) return null;

    var give = {}, get = {};
    // Sharp bots ask for a better rate; Steady offers straight one for one
    give[spare] = L.lookahead > 1 ? 1 : 1;
    get[wantRes] = 1;
    if (p.hand[spare] >= 3 && L.lookahead <= 1) give[spare] = 2;   // sweeten it to get a yes
    return { type: 'offerTrade', give: give, get: get };
  }

  function bankTrade(v, me, L, target) {
    if (!target || L.banks === false) return null;
    var p = v.players[me];
    var need = shortfall(p.hand, target.cost);
    var wantRes = null;
    RES.forEach(function (r) { if (need[r] > 0 && (!wantRes || need[r] > need[wantRes])) wantRes = r; });
    if (!wantRes || v.bank[wantRes] <= 0) return null;
    var best = null, bestSurplus = 0;
    RES.forEach(function (r) {
      if (r === wantRes) return;
      var rate = E.tradeRate(v, me, r);
      var surplus = p.hand[r] - (target.cost[r] || 0);
      if (p.hand[r] >= rate && surplus >= rate && surplus > bestSurplus) { bestSurplus = surplus; best = r; }
    });
    if (!best) return null;
    return { type: 'bankTrade', give: best, get: wantRes };
  }

  /* ---------- main entry point ---------- */

  /* Returns one action, or null when the bot has nothing to do.
     The driver calls this repeatedly until it returns null or the seat changes. */
  function act(v, me, level) {
    var L = lv(level);
    if (v.phase === 'over' || v.phase === 'lobby') return null;
    var p = v.players[me];
    if (!p) return null;

    // out-of-turn duties first
    if (v.phase === 'discard' && v.pendingDiscard.indexOf(me) >= 0) {
      return { type: 'discard', cards: chooseDiscard(v, me, L) };
    }
    if (v.trade) {
      if (v.trade.to.indexOf(me) >= 0 && v.trade.declined.indexOf(me) < 0) {
        return { type: 'respondTrade', accept: judgeTrade(v, me, L) };
      }
      if (v.trade.from === me && v.trade.declined.length >= v.trade.to.length) {
        return { type: 'cancelTrade' };
      }
      return null;   // someone else is deciding
    }

    if (v.phase === 'setup') {
      if (E.setupCurrent(v) !== me) return null;
      return setupMove(v, me, L);
    }
    if (v.turn !== me) return null;

    if (v.phase === 'roll') {
      var target0 = plan(v, me, L);
      var pre = devMove(v, me, L, target0);
      // only a knight makes sense before the dice
      if (pre && pre.card === 'knight') return pre;
      return { type: 'roll' };
    }

    if (v.phase === 'robber') return robberMove(v, me, L);

    if (v.phase === 'main') {
      var target = plan(v, me, L);

      var dev = devMove(v, me, L, target);
      if (dev) return dev;

      // free roads from Road Building must be spent
      if (v.freeRoads > 0) {
        var fr = bestRoad(v, me, L);
        if (fr) return { type: 'buildRoad', edge: fr.edge };
      }

      if (target && E.canPay(p.hand, target.cost)) return buildAction(target);

      var bank = bankTrade(v, me, L, target);
      if (bank) return bank;

      var offer = offerTrade(v, me, L, target);
      if (offer) return offer;

      // nothing to save for: spend down rather than risk a seven
      if (E.handSize(p.hand) > 7) {
        var fallback = plan(v, me, { lookahead: 0, tradeMargin: 1, leaderAware: false, initiates: false, banks: L.banks, placementNoise: 0, robberSpite: 0 });
        if (fallback && E.canPay(p.hand, fallback.cost)) return buildAction(fallback);
      }

      return { type: 'endTurn' };
    }
    return null;
  }

  return {
    LEVELS: LEVELS, act: act, values: values, production: production,
    vertexScore: vertexScore, plan: plan, judgeTrade: judgeTrade,
    chooseDiscard: chooseDiscard, robberMove: robberMove, leaderOf: leaderOf, pips: pips
  };
});
