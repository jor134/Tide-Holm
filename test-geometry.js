/* Geometry regression tests.
   The rendered hex prisms and the engine's vertex/edge lattice are built by two
   completely separate pieces of code. Nothing forces them to agree, so this
   checks that they do — orientation, tiling, and clearance. */
var fs = require('fs');
var E = require('/home/claude/tideholm/engine.js');
var HTML = process.argv[2] || '/home/claude/tideholm/index.html';
var src = fs.readFileSync(HTML, 'utf8');

var pass = 0, fail = 0, fails = [];
function ok(c, m) { if (c) pass++; else { fail++; fails.push(m); } }
function close(a, b, tol, m) { ok(Math.abs(a - b) < (tol || 1e-6), m + ' (got ' + a.toFixed(5) + ' want ' + b.toFixed(5) + ')'); }

function num(name) {
  // accepts a literal or a simple expression like `Math.PI / 6`
  var m = src.match(new RegExp('var ' + name + ' = ([^;]+);'));
  ok(!!m, name + ' is a named constant in the client');
  if (!m) return NaN;
  var expr = m[1].trim();
  if (!/^[-+*/().\s\d]|^Math\./.test(expr) || /[a-zA-Z_$](?<!Math)/.test(expr.replace(/Math\.\w+/g, ''))) {
    ok(false, name + ' is not a plain numeric expression: ' + expr);
    return NaN;
  }
  var v = Function('"use strict";return (' + expr + ')')();
  ok(typeof v === 'number' && isFinite(v), name + ' evaluates to a finite number (' + v + ')');
  return v;
}
var R = num('HEX_R_DRAW');
var OUT = num('HEX_OUTLINE');
var YAW = num('HEX_YAW');

/* ---------- 1. THREE's cylinder vertex formula, reproduced exactly ----------
   r128 generateTorso: vertex.x = radius * sin(theta); vertex.z = radius * cos(theta);
   with theta = (i / radialSegments) * thetaLength + thetaStart, thetaStart = 0. */
function renderedCorners(radius, yaw) {
  var out = [];
  for (var i = 0; i < 6; i++) {
    var t = (i / 6) * Math.PI * 2 + yaw;
    out.push({ x: radius * Math.sin(t), z: radius * Math.cos(t) });
  }
  return out;
}
function dirsOf(pts) {
  return pts.map(function (p) {
    var L = Math.hypot(p.x, p.z);
    return { x: p.x / L, z: p.z / L };
  }).sort(function (a, b) { return Math.atan2(a.z, a.x) - Math.atan2(b.z, b.x); });
}

/* ---------- 2. engine lattice corner directions ---------- */
var g = E.createGame({ code: 'GEO', seed: 7 });
var board = g.board;
var centre = board.hexes.filter(function (h) { return h.q === 0 && h.r === 0; })[0];
ok(!!centre, 'board has a centre hex at (0,0)');

var engineDirs = dirsOf(Object.keys(board.verts)
  .filter(function (k) { return board.verts[k].hexes.indexOf(centre.id) >= 0; })
  .map(function (k) { return { x: board.verts[k].x - centre.cx, z: board.verts[k].z - centre.cz }; }));
ok(engineDirs.length === 6, 'centre hex has exactly 6 lattice corners');

var drawnDirs = dirsOf(renderedCorners(R, YAW));
for (var i = 0; i < 6; i++) {
  close(drawnDirs[i].x, engineDirs[i].x, 1e-9, 'corner ' + i + ' x direction matches the lattice');
  close(drawnDirs[i].z, engineDirs[i].z, 1e-9, 'corner ' + i + ' z direction matches the lattice');
}

// and prove a 30-degree yaw — the bug — would fail this
var wrong = dirsOf(renderedCorners(R, Math.PI / 6));
var anyOff = wrong.some(function (d, k) { return Math.abs(d.x - engineDirs[k].x) > 0.1; });
ok(anyOff, 'a 30-degree yaw is detected as off-lattice');

/* ---------- 3. tiling: no two rendered hexes may overlap ----------
   Two regular hexagons of circumradius R sharing an orientation clear each other
   when their centres are at least 2*R*cos(30) apart (flat-to-flat width). */
var flatWidth = 2 * R * Math.cos(Math.PI / 6);
var outlineWidth = 2 * R * OUT * Math.cos(Math.PI / 6);

var spacings = [], minSpacing = Infinity;
board.hexes.forEach(function (h) {
  h.nb.forEach(function (nid) {
    var n = board.hexes[nid];
    var d = Math.hypot(n.cx - h.cx, n.cz - h.cz);
    spacings.push(d);
    if (d < minSpacing) minSpacing = d;
  });
});
close(minSpacing, Math.sqrt(3), 1e-9, 'neighbour spacing is sqrt(3)');
ok(spacings.every(function (d) { return Math.abs(d - Math.sqrt(3)) < 1e-9; }), 'all neighbour spacings are equal');

ok(flatWidth < minSpacing, 'hex faces clear their neighbours (' + flatWidth.toFixed(4) + ' < ' + minSpacing.toFixed(4) + ')');
ok(outlineWidth < minSpacing, 'outlines clear their neighbours too (' + outlineWidth.toFixed(4) + ' < ' + minSpacing.toFixed(4) + ')');

// the seam should read as a line, not a canyon
var seam = minSpacing - outlineWidth;
ok(seam > 0 && seam < 0.06, 'the seam between tiles is a thin line, not a gap (' + seam.toFixed(4) + ')');

// what the bug actually did
var pointWidth = 2 * R;
ok(pointWidth > minSpacing, 'the previous 30-degree yaw really did overlap, by ' + (pointWidth - minSpacing).toFixed(4) + ' units');

/* ---------- 4. exhaustive pairwise separating-axis check ----------
   Belt and braces: build every rendered hex polygon and confirm no pair
   intersects, using the separating axis theorem on their 3 unique edge normals. */
function polyFor(h, radius, yaw) {
  return renderedCorners(radius, yaw).map(function (p) { return { x: h.cx + p.x, z: h.cz + p.z }; });
}
function project(poly, ax, az) {
  var lo = Infinity, hi = -Infinity;
  poly.forEach(function (p) { var v = p.x * ax + p.z * az; if (v < lo) lo = v; if (v > hi) hi = v; });
  return [lo, hi];
}
function overlaps(A, B) {
  var axes = [];
  [A, B].forEach(function (P) {
    for (var i = 0; i < P.length; i++) {
      var a = P[i], b = P[(i + 1) % P.length];
      var nx = -(b.z - a.z), nz = (b.x - a.x), L = Math.hypot(nx, nz);
      axes.push([nx / L, nz / L]);
    }
  });
  for (var k = 0; k < axes.length; k++) {
    var pa = project(A, axes[k][0], axes[k][1]);
    var pb = project(B, axes[k][0], axes[k][1]);
    if (pa[1] <= pb[0] + 1e-9 || pb[1] <= pa[0] + 1e-9) return false;   // separating axis found
  }
  return true;
}

function countOverlaps(radius, yaw) {
  var polys = board.hexes.map(function (h) { return polyFor(h, radius, yaw); });
  var n = 0;
  for (var i = 0; i < polys.length; i++)
    for (var j = i + 1; j < polys.length; j++)
      if (overlaps(polys[i], polys[j])) n++;
  return n;
}
ok(countOverlaps(R, YAW) === 0, 'no rendered hex overlaps any other (checked all 171 pairs)');
ok(countOverlaps(R * OUT, YAW) === 0, 'no outline overlaps any other');
var bugOverlaps = countOverlaps(R, Math.PI / 6);
ok(bugOverlaps > 0, 'the 30-degree yaw produced ' + bugOverlaps + ' overlapping pairs');

/* ---------- 5. no stray yaw left in the hex drawing code ---------- */
ok(!/rotation\.y = Math\.PI \/ 6/.test(src), 'no hardcoded 30-degree yaw remains anywhere');
var hexBlock = src.slice(src.indexOf('b.hexes.forEach'), src.indexOf('// ports'));
ok(/rotation\.y = HEX_YAW/.test(hexBlock), 'hex prisms use the shared yaw constant');

/* ---------- 6. terrain decoration must stay on its own tile, and off the number ----------
   Reads the DECOR table straight out of index.html rather than restating the
   placements here, so the test cannot drift from what actually renders. */
function insideHex(px, pz, radius, yaw) {
  var inr = radius * Math.cos(Math.PI / 6);
  for (var i = 0; i < 6; i++) {
    var t = (i / 6) * Math.PI * 2 + yaw + Math.PI / 6;   // edge normals sit between vertices
    if (px * Math.sin(t) + pz * Math.cos(t) > inr + 1e-9) return false;
  }
  return true;
}
renderedCorners(R, YAW).forEach(function (c, i) {
  ok(insideHex(c.x * 0.999, c.z * 0.999, R, YAW), 'hex containment test accepts corner ' + i);
  ok(!insideHex(c.x * 1.02, c.z * 1.02, R, YAW), 'hex containment test rejects just outside corner ' + i);
});

var dStart = src.indexOf('/* DECOR-START'), dEnd = src.indexOf('/* DECOR-END */');
ok(dStart > 0 && dEnd > dStart, 'the DECOR block is present and delimited');
var decorSrc = src.slice(dStart, dEnd);
decorSrc = decorSrc.slice(decorSrc.indexOf('var HEX_TOP'));
var sandbox = { HEX_R_DRAW: R, Math: Math };
var vm = require('vm');
vm.createContext(sandbox);
vm.runInContext(decorSrc + '\n;({HEX_TOP:HEX_TOP,TOKEN_R:TOKEN_R,TOKEN_H:TOKEN_H,TOKEN_Y:TOKEN_Y,TOKEN_LIFT:TOKEN_LIFT,TOKEN_CLEAR:TOKEN_CLEAR,HEX_INRADIUS:HEX_INRADIUS,DECOR:DECOR})', sandbox);
var D = vm.runInContext('({HEX_TOP:HEX_TOP,TOKEN_R:TOKEN_R,TOKEN_H:TOKEN_H,TOKEN_Y:TOKEN_Y,TOKEN_LIFT:TOKEN_LIFT,TOKEN_CLEAR:TOKEN_CLEAR,HEX_INRADIUS:HEX_INRADIUS,DECOR:DECOR})', sandbox);

ok(D.TOKEN_CLEAR > D.TOKEN_R, 'the reserved disc is wider than the number token');
close(D.HEX_INRADIUS, R * Math.cos(Math.PI / 6), 1e-9, 'inradius derived from the rendered hex radius');
ok(D.TOKEN_Y - D.TOKEN_H / 2 > D.HEX_TOP, 'the token sits above the tile surface');
ok(D.TOKEN_LIFT > D.TOKEN_Y, 'the token lifts when its number is rolled');

var terrains = Object.keys(D.DECOR);
ok(terrains.length >= 5, 'every producing terrain has a decoration set (' + terrains.join(', ') + ')');
['forest', 'mountain', 'pasture', 'pit', 'field'].forEach(function (t) {
  ok(terrains.indexOf(t) >= 0, t + ' has decoration defined');
});

terrains.forEach(function (t) {
  D.DECOR[t].forEach(function (p, i) {
    var d = Math.hypot(p.x, p.z);
    var label = t + ' prop ' + i;

    // THE BUG: nothing may sit over the number, at any height above the tile
    ok(d - p.r >= D.TOKEN_CLEAR - 1e-9,
      label + ' clears the number disc (inner edge ' + (d - p.r).toFixed(3) +
      ' >= ' + D.TOKEN_CLEAR.toFixed(3) + ')');

    // and nothing may hang off the tile onto a neighbour
    ok(d + p.r <= D.HEX_INRADIUS + 1e-9,
      label + ' stays on its own tile (outer edge ' + (d + p.r).toFixed(3) +
      ' <= ' + D.HEX_INRADIUS.toFixed(3) + ')');

    // sample the actual footprint against the hexagon, not just a radius
    var bad = 0;
    for (var a = 0; a < 24; a++) {
      var ang = a / 24 * Math.PI * 2;
      if (!insideHex(p.x + Math.cos(ang) * p.r, p.z + Math.sin(ang) * p.r, R, YAW)) bad++;
    }
    ok(bad === 0, label + ' footprint is inside the hexagon (' + bad + ' of 24 points outside)');

    ok(p.top > D.HEX_TOP, label + ' rises above the tile surface');
  });
});

// the exact configuration that was reported: a solid disc over the clay number
(function () {
  var oldPit = { x: 0, z: 0, r: 0.50, top: 0.25 };
  var inner = Math.hypot(oldPit.x, oldPit.z) - oldPit.r;
  ok(inner < D.TOKEN_CLEAR, 'the old centred clay pit would fail this test (inner edge ' + inner.toFixed(2) + ')');
  ok(oldPit.top > 0.19 + 0.07 / 2, 'and it stood above the old resting token, hiding the number');
})();

// the raider must not be buried in the token either
var robberY = parseFloat((src.match(/rg\.position\.set\(rh\.cx, TOKEN_Y \+ TOKEN_H \/ 2 \+ ([\d.]+), rh\.cz\)/) || [])[1]);
ok(isFinite(robberY), 'the raider is positioned relative to the token');
ok(robberY > 0, 'the raider stands on top of the token rather than through it');

// no stray hardcoded token geometry left behind
ok(!/CylinderGeometry\(0\.33, 0\.33, 0\.07/.test(src), 'no hardcoded token geometry remains');
ok(!/tk\.userData\.hot \? 0\.30 : 0\.19/.test(src), 'no hardcoded token heights remain');

console.log('\nR=' + R + '  outline=' + OUT + '  yaw=' + YAW +
  '\nflat width ' + flatWidth.toFixed(4) + ', outline ' + outlineWidth.toFixed(4) +
  ', spacing ' + minSpacing.toFixed(4) + ', seam ' + seam.toFixed(4));
console.log('\nPASS ' + pass + '   FAIL ' + fail);
if (fail) { fails.slice(0, 20).forEach(function (f) { console.log('  ✗ ' + f); }); process.exit(1); }
