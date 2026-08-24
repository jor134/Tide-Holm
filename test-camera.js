/* Camera + input regression tests.
   The board vanishing off the bottom-right corner and drags dying over the
   middle of the screen were both silent geometry/CSS faults, so both are
   checked here against real numbers rather than by eye. */
var fs = require('fs');
var HTML = process.argv[2] || '/home/claude/tideholm/index.html';
var src = fs.readFileSync(HTML, 'utf8');
var css = src.slice(src.indexOf('<style>'), src.indexOf('</style>'));

var pass = 0, fail = 0, fails = [];
function ok(c, m) { if (c) pass++; else { fail++; fails.push(m); } }

/* ---------- 1. the canvas must be told to stretch ----------
   <canvas> is a replaced element. `position:fixed; inset:0` leaves it at its
   intrinsic (attribute) size anchored top-left; it does NOT fill the viewport.
   An explicit width/height is required. */
var canvasRule = (css.match(/(^|\n)canvas\s*\{([^}]*)\}/) || [])[2] || '';
ok(/width\s*:\s*(100%|100vw)/.test(canvasRule), 'canvas declares an explicit width (got: ' + canvasRule.trim() + ')');
ok(/height\s*:\s*(100%|100vh)/.test(canvasRule), 'canvas declares an explicit height');

/* ---------- 2. nothing invisible may swallow board drags ----------
   `#hud > *{pointer-events:auto}` hands auto to every direct child, including
   the empty flex spacer that fills the middle of the screen. */
function ruleFor(sel) {
  var re = new RegExp('(^|[\\n,])\\s*' + sel.replace('#', '#') + '\\s*\\{([^}]*)\\}');
  var m = css.match(re);
  return m ? m[2] : null;
}
var spacer = ruleFor('#spacer');
ok(spacer !== null, '#spacer has a rule');
ok(/pointer-events\s*:\s*none/.test(spacer || ''), '#spacer does not intercept touches (got: ' + String(spacer).trim() + ')');
var status = ruleFor('#status');
ok(/pointer-events\s*:\s*none/.test(status || ''), '#status does not intercept touches');

/* ---------- 3. camera framing ----------
   Runs the client's own boardBox() — lifted verbatim out of index.html — so the
   test cannot drift from what actually renders. */
var BOARD_R = parseFloat((src.match(/var BOARD_R = ([\d.]+)/) || [])[1]);
ok(BOARD_R > 5 && BOARD_R < 8, 'BOARD_R is a plausible board radius (' + BOARD_R + ')');

var pStart = src.indexOf('/* PROJECT-START'), pEnd = src.indexOf('/* PROJECT-END */');
ok(pStart > 0 && pEnd > pStart, 'the projection block is present and delimited');
var projSrc = src.slice(pStart, pEnd);
projSrc = projSrc.slice(projSrc.indexOf('function boardBox'));
var vm = require('vm');
var sandbox = { Math: Math };
vm.createContext(sandbox);
vm.runInContext(projSrc, sandbox);
var boardBox = vm.runInContext('boardBox', sandbox);

function fov(w, h) { return (w / h < 0.75) ? 58 : 46; }
function fitDist(w, h, iT, iB, phi) {
  var freeH = Math.max(160, h - iT - iB);
  function fits(d) {
    var b = boardBox(d, phi, 0, fov(w, h), w / h, w, h, BOARD_R);
    return (b.maxX - b.minX) <= w * 0.98 && (b.maxY - b.minY) <= freeH * 0.97;
  }
  var lo = 2, hi = 240;
  for (var i = 0; i < 44; i++) { var m = (lo + hi) / 2; if (fits(m)) hi = m; else lo = m; }
  return hi;
}
function shiftFor(d, w, h, iT, iB, phi) {
  var b = boardBox(d, phi, 0, fov(w, h), w / h, w, h, BOARD_R);
  return (b.minY + b.maxY) / 2 - (iT + (h - iT - iB) / 2);
}

var VIEWPORTS = [
  ['iPhone SE portrait', 375, 667, 74, 190], ['iPhone 15 portrait', 393, 852, 92, 210],
  ['iPhone 15 Pro Max portrait', 430, 932, 96, 215], ['iPhone 15 landscape', 852, 393, 70, 165],
  ['Pixel 8 portrait', 412, 915, 88, 210], ['iPad Mini portrait', 744, 1133, 90, 205],
  ['iPad Pro landscape', 1366, 1024, 86, 200], ['desktop', 1440, 900, 84, 195],
  ['very narrow', 320, 900, 90, 230], ['very wide', 1600, 500, 70, 160],
  ['tall sheet, trade open', 393, 852, 92, 300]
];
var TILTS = [0.5, 0.86, 1.2, 1.4];

VIEWPORTS.forEach(function (vp) {
  var name = vp[0], w = vp[1], h = vp[2], iT = vp[3], iB = vp[4];
  var freeH = Math.max(160, h - iT - iB);

  TILTS.forEach(function (phi) {
    var d = fitDist(w, h, iT, iB, phi);
    var shift = shiftFor(d, w, h, iT, iB, phi);
    var b = boardBox(d, phi, 0, fov(w, h), w / h, w, h, BOARD_R);
    var top = b.minY - shift, bot = b.maxY - shift;   // positive shift moves content up
    var tag = name + ' @tilt ' + phi;

    ok(bot <= h - iB + 1.5, tag + ': bottom of the board clears the sheet (' +
      bot.toFixed(0) + ' <= ' + (h - iB) + ')');
    ok(top >= iT - 1.5, tag + ': top of the board clears the rail (' +
      top.toFixed(0) + ' >= ' + iT + ')');
    ok(b.maxX - b.minX <= w + 1, tag + ': board fits the width');
    ok(d > 0 && d < 200, tag + ': distance is sane (' + d.toFixed(1) + ')');

    // it should fill the space it has, not sit as a speck in the middle
    var fill = Math.max((b.maxX - b.minX) / w, (b.maxY - b.minY) / freeH);
    ok(fill > 0.9, tag + ': board fills the space available (' + (fill * 100).toFixed(0) + '%)');
  });
});

/* The reported symptom: zooming in pushed the bottom of the board under the
   sheet. It still leaves the frame when zoomed — that is what zoom does — but
   the framing must be centred on the free band so it is symmetric, and pan must
   exist to recover. */
(function () {
  var w = 393, h = 852, iT = 92, iB = 210, phi = 0.86;
  var d = fitDist(w, h, iT, iB, phi);
  var shift = shiftFor(d, w, h, iT, iB, phi);
  var b = boardBox(d, phi, 0, fov(w, h), w / h, w, h, BOARD_R);
  var centred = (b.minY + b.maxY) / 2 - shift;
  var freeCentre = iT + (h - iT - iB) / 2;
  ok(Math.abs(centred - freeCentre) < 1.5, 'the board is centred in the free band, not the canvas (' +
    centred.toFixed(0) + ' vs ' + freeCentre.toFixed(0) + ')');

  // without the shift it sat below centre, so zooming ate the bottom first
  var uncentred = (b.minY + b.maxY) / 2;
  ok(uncentred > freeCentre + 20, 'uncentred, the board sat well below the free band centre (' +
    uncentred.toFixed(0) + ' vs ' + freeCentre.toFixed(0) + ')');

  // headroom above and below is now even
  var above = (centred - (b.maxY - b.minY) / 2) - iT;
  var below = (h - iB) - (centred + (b.maxY - b.minY) / 2);
  ok(Math.abs(above - below) < 3, 'headroom is even above and below (' +
    above.toFixed(0) + 'px / ' + below.toFixed(0) + 'px)');

  // and a pan of the clamped maximum can bring any edge back into view
  var zoomed = d * 0.30;
  var bz = boardBox(zoomed, phi, 0, fov(w, h), w / h, w, h, BOARD_R);
  var overhang = (bz.maxY - shiftFor(zoomed, w, h, iT, iB, phi)) - (h - iB);
  ok(overhang < h * 0.55, 'at full zoom the overhang is inside the pan range (' +
    overhang.toFixed(0) + 'px vs ' + (h * 0.55).toFixed(0) + 'px of pan)');
})();

/* ---------- 3b. gesture mapping ----------
   One finger pans, two fingers pinch, twist and tilt. These are string checks on
   the handler, but the twist SIGN is verified against the real projection below,
   which is the part that is easy to get backwards and impossible to eyeball. */
ok(/setViewOffset\(/.test(src), 'the board is shifted by biasing the projection, not by moving the camera');
ok(/cam\.panX/.test(src) && /cam\.panY/.test(src), 'a manual pan offset exists');
ok(/function recentre\(\)/.test(src), 'centring on the free band is its own function');
ok(/function resetView\(\)/.test(src), 'there is a single reset used by the button and the double tap');
ok(/uiInsets\(\)/.test(src), 'the HUD insets are measured rather than assumed');
var insetsBody = src.slice(src.indexOf('function uiInsets()'), src.indexOf('function resize('));
ok(/getBoundingClientRect/.test(insetsBody), 'insets come from the real element boxes');
ok(/sheet/.test(insetsBody) && /rail/.test(insetsBody), 'both the rail and the sheet are measured');

var bind = src.slice(src.indexOf('function bindCamera('), src.indexOf('function resetView('));

// one finger pans, and the board must follow the finger rather than flee it
ok(/cam\.panX -= dx;/.test(bind) && /cam\.panY -= dy;/.test(bind),
  'one finger pans, and the board tracks the finger');
ok(!/if \(!one\) return;[\s\S]{0,200}cam\.theta -=/.test(bind),
  'one finger no longer rotates');

// two fingers do all three
ok(/two\.dist \* two\.g\.dist \/ Math\.max\(1, g\.dist\)/.test(bind), 'two fingers pinch to zoom');
ok(/cam\.theta = two\.theta \+ da;/.test(bind), 'two fingers twist to rotate');
ok(/cam\.phi = Math\.max\(0\.42, Math\.min\(1\.4, two\.phi/.test(bind), 'two fingers slide to tilt');
ok(/while \(da > Math\.PI\) da -= Math\.PI \* 2;/.test(bind),
  'the twist wraps correctly instead of jumping at +/-pi');
ok(/e\.touches\.length === 1.*two = null/s.test(bind) || /if \(two && e\.touches && e\.touches\.length === 1\)/.test(bind),
  'lifting one finger of two does not snap the view');
ok(/moved < 12/.test(bind), 'a tap is still distinguished from a pan');
ok(/shiftKey \|\| e\.button === 2/.test(bind), 'desktop orbits with shift-drag or the right button');

var lim = src.match(/lim = \{ x: W \* ([\d.]+), y: H \* ([\d.]+) \}/);
ok(!!lim, 'the pan is clamped so the board cannot be lost off screen');

/* ---------- 3c. twist direction, measured ----------
   Reproduces the two-finger handler and confirms the board turns the same way
   the fingers do. Getting this backwards is invisible in code review. */
(function () {
  var W = 393, H = 852, d = 24, phi = 0.86, f = 58;
  function screenAngleOf(theta) {
    var edge = boardBox(d, phi, theta, f, W / H, W, H, 0.001);   // effectively the centre
    var cx = (edge.minX + edge.maxX) / 2, cy = (edge.minY + edge.maxY) / 2;
    var mark = boardBox(d, phi, theta, f, W / H, W, H, 4);
    // take the rightmost sample of the rim as a marker
    return { cx: cx, cy: cy, mx: mark.maxX, my: (mark.minY + mark.maxY) / 2 };
  }
  // measure directly with a single projected point instead
  function project(px, pz, theta) {
    var C = [d * Math.sin(phi) * Math.sin(theta), d * Math.cos(phi), d * Math.sin(phi) * Math.cos(theta)];
    var L = Math.hypot(C[0], C[1], C[2]);
    var z = [C[0] / L, C[1] / L, C[2] / L];
    var x = [z[2], 0, -z[0]]; var xl = Math.hypot(x[0], x[2]) || 1; x = [x[0] / xl, 0, x[2] / xl];
    var y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    var p = [px, 0, pz], r = [p[0] - C[0], p[1] - C[1], p[2] - C[2]];
    var vx = r[0] * x[0] + r[1] * x[1] + r[2] * x[2];
    var vy = r[0] * y[0] + r[1] * y[1] + r[2] * y[2];
    var vz = r[0] * z[0] + r[1] * z[1] + r[2] * z[2];
    var t = Math.tan(f * Math.PI / 180 / 2);
    return { x: (1 + (vx / -vz) / (t * (W / H))) / 2 * W, y: (1 - (vy / -vz) / t) / 2 * H };
  }
  function markerAngle(theta) {
    var c = project(0, 0, theta), m = project(4, 0, theta);
    return Math.atan2(m.y - c.y, m.x - c.x);   // y is down, so increasing means clockwise
  }
  var delta = markerAngle(0.10) - markerAngle(0);
  ok(delta > 0, 'increasing theta turns the board clockwise on screen (' + delta.toFixed(4) + ')');

  // the handler sets theta = start + da, where da is the clockwise finger twist
  var handlerAddsTwist = /cam\.theta = two\.theta \+ da;/.test(bind);
  ok(handlerAddsTwist && delta > 0,
    'a clockwise finger twist turns the board clockwise — the board follows the fingers');

  // and the twist is measured with screen y down, matching that sign
  ok(/Math\.atan2\(b\.y - a\.y, b\.x - a\.x\)/.test(bind),
    'the finger angle is measured in screen coordinates (y down)');
})();

/* ---------- 4. zoom clamps must not undo the fit ---------- */
var minMul = parseFloat((src.match(/cam\.min = d \* ([\d.]+)/) || [])[1]);
var maxMul = parseFloat((src.match(/cam\.max = d \* ([\d.]+)/) || [])[1]);
ok(maxMul >= 1, 'zoom-out limit is at or beyond the fitted distance (' + maxMul + ')');
ok(minMul > 0 && minMul < 1, 'zoom-in limit is closer than the fitted distance (' + minMul + ')');
ok(!/Math\.min\(20,/.test(src), 'no hardcoded 20-unit zoom ceiling remains');
ok(!/cam\.dist = h > w \? /.test(src), 'no hardcoded per-orientation distance remains');

/* ---------- 5. fog must follow the fitted distance ---------- */
ok(/scene\.fog\.near = d \*/.test(src), 'fog near scales with camera distance');
ok(/scene\.fog\.far = d \*/.test(src), 'fog far scales with camera distance');
var fogFar = parseFloat((src.match(/scene\.fog\.far = d \* ([\d.]+)/) || [])[1]);
VIEWPORTS.forEach(function (vp) {
  TILTS.forEach(function (phi) {
    var d = fitDist(vp[1], vp[2], vp[3], vp[4], phi);
    // farthest visible point of the board from the camera
    ok(d * fogFar > d + BOARD_R, vp[0] + ' @tilt ' + phi + ': fog does not grey out the far edge');
  });
});

/* ---------- 6. hit testing must use the canvas box, not the window ---------- */
ok(/getBoundingClientRect\(\)/.test(src.slice(src.indexOf('function tap('), src.indexOf('function tap(') + 400)),
  'tap() maps pointers through the canvas bounding box');
ok(!/p\.x \/ innerWidth/.test(src), 'tap() no longer assumes the canvas equals the window');

/* ---------- 7. there is a way back if the player gets lost ---------- */
ok(/id="fit"/.test(src), 'a fit-to-screen control exists');
ok(/#fit\{/.test(css), 'the fit control is styled');
var fitRule = ruleFor('#fit') || (css.match(/#fit\{([^}]*)\}/) || [])[1] || '';
var fitZ = parseInt((fitRule.match(/z-index\s*:\s*(\d+)/) || [])[1], 10);
var titleZ = parseInt(((css.match(/#title\{([^}]*)\}/) || [])[1] || '').match(/z-index\s*:\s*(\d+)/)[1], 10);
ok(fitZ > 0 && fitZ < titleZ, 'the fit control sits above the board but below the title screen');

console.log('\nPASS ' + pass + '   FAIL ' + fail);
if (fail) { fails.slice(0, 20).forEach(function (f) { console.log('  ✗ ' + f); }); process.exit(1); }
