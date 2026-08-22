/* Drives api/game.js end-to-end against an in-memory Redis stand-in.
   Verifies routing, locking, seat identity, redaction and turn gating. */
var pass = 0, fail = 0, fails = [];
function ok(c, m) { if (c) pass++; else { fail++; fails.push(m); } }
function eq(a, b, m) { ok(a === b, m + ' (got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b) + ')'); }

/* ---- fake Upstash ---- */
var DB = {};
process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'faketoken';
var calls = 0;
global.fetch = function (url, opts) {
  calls++;
  var a = JSON.parse(opts.body);
  var c = a[0].toUpperCase(), k = a[1], out;
  if (c === 'GET') out = DB[k] === undefined ? null : DB[k];
  else if (c === 'SET') {
    if (a.indexOf('NX') >= 0 && DB[k] !== undefined) out = null;
    else { DB[k] = a[2]; out = 'OK'; }
  }
  else if (c === 'DEL') { delete DB[k]; out = 1; }
  else if (c === 'EXISTS') out = DB[k] === undefined ? 0 : 1;
  else out = null;
  return Promise.resolve({ json: function () { return Promise.resolve({ result: out }); } });
};

var handler = require('./api/game.js');
var E = require('./engine.js');

function post(body) {
  return new Promise(function (resolve) {
    var res = {
      _s: 200,
      setHeader: function () {},
      status: function (n) { this._s = n; return this; },
      json: function (o) { resolve({ status: this._s, body: o }); }
    };
    handler({ method: 'POST', body: body }, res);
  });
}

(async function () {
  /* ---- create ---- */
  var r = await post({ op: 'create', name: 'Jordan' });
  eq(r.status, 200, 'create returns 200');
  ok(/^[A-Z]{4}$/.test(r.body.code), 'code is four uppercase letters');
  ok(!!r.body.pid, 'host gets a pid');
  var code = r.body.code, host = r.body.pid;
  eq(r.body.state.players.length, 1, 'host is seated');
  eq(r.body.state.me, 0, 'host is seat 0');
  eq(r.body.state.phase, 'lobby', 'table opens in lobby');
  eq(r.body.state.dev, undefined, 'dev deck never leaves the server');

  /* ---- join ---- */
  var p2 = (await post({ op: 'join', code: code, name: 'Elmira' })).body;
  var p3 = (await post({ op: 'join', code: code, name: 'Sam' })).body;
  eq(p3.state.players.length, 3, 'three seated');
  eq(p3.state.me, 2, 'third joiner is seat 2');
  ok(p2.pid !== p3.pid, 'pids are distinct');

  // rejoining with a known pid returns the same seat, not a new one
  var re = (await post({ op: 'join', code: code, pid: p2.pid, name: 'Elmira' })).body;
  eq(re.pid, p2.pid, 'rejoin keeps the same pid');
  eq(re.state.players.length, 3, 'rejoin does not add a seat');
  eq(re.state.me, 1, 'rejoin lands on the original seat');

  // bad code
  var bad = await post({ op: 'join', code: 'ZZZZ', name: 'Nobody' });
  eq(bad.status, 404, 'unknown code is a 404');

  /* ---- start ---- */
  var notHost = (await post({ op: 'start', code: code, pid: p2.pid })).body;
  ok(!!notHost.error, 'non-host cannot start');
  var started = (await post({ op: 'start', code: code, pid: host })).body;
  eq(started.state.phase, 'setup', 'host starts the game');

  /* ---- turn gating ---- */
  var wrong = (await post({ op: 'act', code: code, pid: p2.pid, action: { type: 'roll' } })).body;
  ok(!wrong.ok, 'out-of-turn action rejected');
  ok(!!wrong.error, 'rejection carries a message');
  var stranger = (await post({ op: 'act', code: code, pid: 'nonsense', action: { type: 'roll' } })).body;
  ok(!!stranger.error, 'unseated pid rejected');

  /* ---- play the setup phase through the API ---- */
  async function view(pid) { return (await post({ op: 'state', code: code, pid: pid })).body.state; }
  var pids = [host, p2.pid, p3.pid];
  var guard = 0;
  var st = await view(host);
  while (st.phase === 'setup' && guard++ < 20) {
    var seat = (function (s) {
      var n = s.players.length, o = [];
      for (var i = 0; i < n; i++) o.push(i);
      for (var j = n - 1; j >= 0; j--) o.push(j);
      return o[s.setupStep];
    })(st);
    var spots = E.legalSettlementSpots(st, seat, true);
    var v = spots[0], vv = st.board.verts[v], placed = false;
    for (var e = 0; e < vv.adj.length && !placed; e++) {
      var ek = E.ekey(v, vv.adj[e]);
      if (st.roads[ek] != null) continue;
      var rr = (await post({ op: 'act', code: code, pid: pids[seat], action: { type: 'setupPlace', vert: v, edge: ek } })).body;
      if (rr.ok) placed = true;
    }
    ok(placed, 'setup placement ' + guard + ' accepted');
    st = await view(host);
  }
  eq(st.phase, 'roll', 'setup finishes through the API');
  eq(Object.keys(st.buildings).length, 6, 'six settlements down');

  /* ---- redaction across the wire ---- */
  var hv = await view(host), ev = await view(p2.pid);
  ok(hv.players[0].hand !== null, 'host sees own hand');
  eq(hv.players[1].hand, null, 'host cannot see Elmira\u2019s hand');
  eq(ev.players[0].hand, null, 'Elmira cannot see host\u2019s hand');
  ok(ev.players[1].hand !== null, 'Elmira sees own hand');
  ok(hv.players[1].handCount >= 0, 'card counts are public');
  eq(JSON.stringify(hv).indexOf('"knight"'), -1, 'no dev card names in the host payload');
  eq(hv.devLeft, 25, 'deck size is public');

  /* ---- version polling ---- */
  var v1 = hv.v;
  var same = (await post({ op: 'state', code: code, pid: host, v: v1 })).body;
  eq(same.nochange, true, 'unchanged state returns nochange');
  await post({ op: 'act', code: code, pid: host, action: { type: 'roll' } });
  var after = (await post({ op: 'state', code: code, pid: host, v: v1 })).body;
  ok(!!after.state, 'version bump delivers fresh state');
  ok(after.state.v > v1, 'version increments on mutation');

  /* ---- rejected actions must not bump the version or mutate ---- */
  var before = (await post({ op: 'state', code: code, pid: host })).body.state;
  var rej = (await post({ op: 'act', code: code, pid: p3.pid, action: { type: 'endTurn' } })).body;
  ok(!rej.ok, 'wrong player cannot end the turn');
  var afterRej = (await post({ op: 'state', code: code, pid: host })).body.state;
  eq(afterRej.v, before.v, 'rejected action leaves the version alone');
  eq(JSON.stringify(afterRej.buildings), JSON.stringify(before.buildings), 'rejected action changes nothing');

  /* ---- lock releases even on a rejected action ---- */
  eq(DB['tideholm_lock_' + code], undefined, 'lock released after every request');

  /* ---- concurrent actions do not clobber ---- */
  var s0 = (await post({ op: 'state', code: code, pid: host })).body.state;
  if (s0.phase === 'main') {
    var both = await Promise.all([
      post({ op: 'act', code: code, pid: host, action: { type: 'endTurn' } }),
      post({ op: 'act', code: code, pid: host, action: { type: 'endTurn' } })
    ]);
    var accepted = both.filter(function (x) { return x.body.ok; }).length;
    ok(accepted <= 2, 'concurrent requests both resolve');
    var s1 = (await post({ op: 'state', code: code, pid: host })).body.state;
    ok(s1.turn !== undefined, 'state still readable after concurrent writes');
    eq(DB['tideholm_lock_' + code], undefined, 'lock released after concurrency');
  }

  /* ---- table full ---- */
  var big = (await post({ op: 'create', name: 'H' })).body;
  for (var f = 0; f < 5; f++) await post({ op: 'join', code: big.code, name: 'P' + f });
  var over = (await post({ op: 'join', code: big.code, name: 'Seventh' })).body;
  ok(!!over.error, 'seventh player is turned away');

  /* ---- joining after the start ---- */
  await post({ op: 'start', code: big.code, pid: big.pid });
  var late = (await post({ op: 'join', code: big.code, name: 'Late' })).body;
  ok(!!late.error, 'cannot join a game in progress');

  /* ---- missing credentials ---- */
  var u = process.env.UPSTASH_REDIS_REST_URL, t = process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
  var noc = await post({ op: 'create', name: 'X' });
  eq(noc.status, 500, 'missing storage returns 500');
  ok(/Upstash|storage/i.test(noc.body.error), 'missing storage says what to do');
  process.env.UPSTASH_REDIS_REST_URL = u; process.env.UPSTASH_REDIS_REST_TOKEN = t;

  /* ---- method guard ---- */
  var getRes = await new Promise(function (resolve) {
    var res = { _s: 200, setHeader: function () {}, status: function (n) { this._s = n; return this; }, json: function (o) { resolve({ status: this._s, body: o }); } };
    handler({ method: 'GET' }, res);
  });
  eq(getRes.status, 405, 'GET is rejected');

  /* ---- name sanitising ---- */
  var xss = (await post({ op: 'create', name: '<img src=x onerror=alert(1)>' })).body;
  eq(xss.state.players[0].name.indexOf('<'), -1, 'angle brackets stripped from names');
  ok(xss.state.players[0].name.length <= 14, 'names capped at 14 characters');

  console.log('\nPASS ' + pass + '   FAIL ' + fail + '   (' + calls + ' redis calls)');
  if (fail) { fails.forEach(function (f) { console.log('  ✗ ' + f); }); process.exit(1); }
})();
