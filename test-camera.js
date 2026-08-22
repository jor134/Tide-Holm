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

/* ---------- 3. camera fit maths ----------
   Reimplements fitCamera() and checks the board's bounding sphere actually
   lands inside the frustum on real device viewports. */
var BOARD_R = parseFloat((src.match(/var BOARD_R = ([\d.]+)/) || [])[1]);
ok(BOARD_R > 5 && BOARD_R < 8, 'BOARD_R is a plausible board radius (' + BOARD_R + ')');

function fov(w, h) { return (w / h < 0.75) ? 58 : 46; }
function fit(w, h) {
  var aspect = w / h;
  var vFov = fov(w, h) * Math.PI / 180;
  var hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  return Math.max(BOARD_R / Math.sin(vFov / 2), BOARD_R / Math.sin(hFov / 2));
}
// half-extent visible at distance d, on each axis
function visible(w, h, d) {
  var aspect = w / h;
  var vFov = fov(w, h) * Math.PI / 180;
  var hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  return { v: d * Math.tan(vFov / 2), h: d * Math.tan(hFov / 2) };
}

var VIEWPORTS = [
  ['iPhone SE portrait', 375, 667], ['iPhone 15 portrait', 393, 852],
  ['iPhone 15 Pro Max portrait', 430, 932], ['iPhone 15 landscape', 852, 393],
  ['Pixel 8 portrait', 412, 915], ['iPad Mini portrait', 744, 1133],
  ['iPad Pro landscape', 1366, 1024], ['desktop', 1440, 900],
  ['very narrow', 320, 900], ['very wide', 1600, 500]
];
VIEWPORTS.forEach(function (vp) {
  var name = vp[0], w = vp[1], h = vp[2];
  var d = fit(w, h);
  var vis = visible(w, h, d);
  ok(vis.h >= BOARD_R - 1e-6, name + ': board fits horizontally (' + vis.h.toFixed(2) + ' >= ' + BOARD_R + ')');
  ok(vis.v >= BOARD_R - 1e-6, name + ': board fits vertically (' + vis.v.toFixed(2) + ' >= ' + BOARD_R + ')');
  // and it should not be so far away that the board is a speck
  var fill = BOARD_R / Math.min(vis.h, vis.v);
  ok(fill > 0.9, name + ': board fills the tight axis (' + (fill * 100).toFixed(0) + '%)');
  ok(d > 0 && d < 60, name + ': distance is sane (' + d.toFixed(1) + ')');
});

// the old hardcoded distance is proven insufficient in portrait
var oldD = 13.5;
var visOld = visible(393, 852, oldD);
ok(visOld.h < BOARD_R, 'the previous hardcoded distance really did clip the board horizontally (' +
  visOld.h.toFixed(2) + ' < ' + BOARD_R + ')');

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
  var d = fit(vp[1], vp[2]);
  // farthest visible point of the board from the camera
  ok(d * fogFar > d + BOARD_R, vp[0] + ': fog does not grey out the far edge of the board');
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
