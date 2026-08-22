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

/* ---------- 6. terrain decoration must stay on its own tile ----------
   Every prop is sampled around its own footprint and each sample point tested
   against the hexagon, rather than eyeballing the offsets. */
function insideHex(px, pz, radius, yaw) {
  var inr = radius * Math.cos(Math.PI / 6);
  for (var i = 0; i < 6; i++) {
    var t = (i / 6) * Math.PI * 2 + yaw + Math.PI / 6;   // edge normals sit between vertices
    if (px * Math.sin(t) + pz * Math.cos(t) > inr + 1e-9) return false;
  }
  return true;
}
// sanity: the hexagon test itself must agree with the corners
renderedCorners(R, YAW).forEach(function (c, i) {
  ok(insideHex(c.x * 0.999, c.z * 0.999, R, YAW), 'hex containment test accepts corner ' + i);
  ok(!insideHex(c.x * 1.02, c.z * 1.02, R, YAW), 'hex containment test rejects just outside corner ' + i);
});

function circle(cx, cz, r) {
  var pts = [];
  for (var a = 0; a < 32; a++) pts.push([cx + r * Math.cos(a / 32 * 6.2832), cz + r * Math.sin(a / 32 * 6.2832)]);
  return pts;
}
function box(cx, cz, halfX, halfZ) {
  return [[cx - halfX, cz - halfZ], [cx + halfX, cz - halfZ], [cx + halfX, cz + halfZ], [cx - halfX, cz + halfZ]];
}

var props = [];
// mountain peaks: ConeGeometry(0.24 - i*0.03) at ((i-1)*0.36, +/-0.18)
for (var i = 0; i < 3; i++) props.push(['mountain peak ' + i, circle((i - 1) * 0.36, (i % 2 ? 0.18 : -0.16), 0.24 - i * 0.03)]);
// forest: ConeGeometry(0.17) at radius 0.44
for (var j = 0; j < 4; j++) { var a = j * 1.57 + 0.4; props.push(['tree ' + j, circle(Math.cos(a) * 0.44, Math.sin(a) * 0.44, 0.17)]); }
// field rows: BoxGeometry(1.2, .06, .13) at z = k*0.32
for (var k = -1; k <= 1; k++) props.push(['field row ' + k, box(0, k * 0.32, 0.6, 0.065)]);
// pasture: SphereGeometry(0.13) at ((m-1)*0.38, +/-0.22)
for (var m = 0; m < 3; m++) props.push(['sheep ' + m, circle((m - 1) * 0.38, (m % 2 ? 0.22 : -0.2), 0.13)]);
// clay pit: CylinderGeometry(0.42, 0.5) centred
props.push(['clay pit', circle(0, 0, 0.5)]);
// number token
props.push(['number token', circle(0, 0, 0.33)]);

props.forEach(function (pr) {
  var name = pr[0], pts = pr[1];
  var worst = 0, bad = 0;
  pts.forEach(function (pt) {
    if (!insideHex(pt[0], pt[1], R, YAW)) bad++;
    worst = Math.max(worst, Math.hypot(pt[0], pt[1]));
  });
  ok(bad === 0, name + ' stays inside its tile (' + bad + ' of ' + pts.length +
    ' sample points outside, furthest ' + worst.toFixed(3) + ')');
});

console.log('\nR=' + R + '  outline=' + OUT + '  yaw=' + YAW +
  '\nflat width ' + flatWidth.toFixed(4) + ', outline ' + outlineWidth.toFixed(4) +
  ', spacing ' + minSpacing.toFixed(4) + ', seam ' + seam.toFixed(4));
console.log('\nPASS ' + pass + '   FAIL ' + fail);
if (fail) { fails.slice(0, 20).forEach(function (f) { console.log('  ✗ ' + f); }); process.exit(1); }
