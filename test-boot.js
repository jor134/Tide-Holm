/* Loads the client script in Node against a stubbed DOM, so we can see exactly
   which top-level statement kills handler attachment. */
var fs = require('fs'), vm = require('vm'), path = require('path');
var HTML = process.argv[3] || '/home/claude/tideholm/index.html';

function fakeEl(id) {
  var e = {
    id: id, tagName: 'DIV', _children: [], style: {}, dataset: {}, value: '',
    textContent: '', innerHTML: '', disabled: false, className: '', onclick: null,
    classList: {
      _s: {}, add: function () { for (var i = 0; i < arguments.length; i++) this._s[arguments[i]] = 1; },
      remove: function () { for (var i = 0; i < arguments.length; i++) delete this._s[arguments[i]]; },
      contains: function (c) { return !!this._s[c]; }
    },
    appendChild: function (c) { this._children.push(c); return c; },
    removeChild: function (c) { var i = this._children.indexOf(c); if (i >= 0) this._children.splice(i, 1); return c; },
    addEventListener: function () {}, removeEventListener: function () {},
    setAttribute: function () {}, getAttribute: function () { return null; },
    focus: function () {}, click: function () { if (this.onclick) this.onclick({}); },
    getContext: function () {
      return {
        fillRect: function () {}, fillText: function () {}, beginPath: function () {},
        arc: function () {}, fill: function () {}, stroke: function () {}, measureText: function () { return { width: 10 }; },
        set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {}, set font(v) {},
        set textAlign(v) {}, set textBaseline(v) {}
      };
    },
    getBoundingClientRect: function () { return { left: 0, top: 0, width: 100, height: 100 }; }
  };
  Object.defineProperty(e, 'children', { get: function () { return this._children; } });
  return e;
}

function makeThree() {
  function Obj() {
    this.position = { set: function () {}, x: 0, y: 0, z: 0, multiplyScalar: function () {} };
    this.rotation = { x: 0, y: 0, z: 0 };
    this.scale = { x: 1, y: 1, z: 1, setScalar: function () {}, multiplyScalar: function () {} };
    this.userData = {}; this.children = [];
    this.add = function (c) { this.children.push(c); };
    this.remove = function (c) { var i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); };
    this.lookAt = function () {}; this.updateProjectionMatrix = function () {};
    this.setFromCamera = function () {}; this.intersectObjects = function () { return []; };
    this.setPixelRatio = function () {}; this.setSize = function () {}; this.render = function () {};
  }
  var handler = {
    get: function (t, k) {
      if (k === 'BackSide') return 1;
      if (k === 'DoubleSide') return 2;
      if (k === 'NearestFilter') return 3;
      if (!t[k]) t[k] = function () { Obj.call(this); };
      return t[k];
    }
  };
  return new Proxy({}, handler);
}

function run(opts) {
  var html = fs.readFileSync(HTML, 'utf8');
  var blocks = html.match(/<script>([\s\S]*?)<\/script>/g);
  var code = blocks[blocks.length - 1].replace(/^<script>/, '').replace(/<\/script>$/, '');

  var els = {};
  ['cv', 'hud', 'rail', 'spacer', 'status', 'dice', 'stxt', 'sheet', 'hand', 'acts',
    'toast', 'modal', 'mbox', 'curtain', 'title', 'tHost', 'tJoin', 'tLocal', 'install',
    'fatal', 'fatalTitle', 'fatalMsg', 'fatalRetry', 'logbox'].forEach(function (id) { els[id] = fakeEl(id); });
  // mirror the class="hide" that these carry in the markup
  ['hud', 'modal', 'curtain', 'fatal', 'install'].forEach(function (id) { els[id].classList.add('hide'); });

  var doc = {
    getElementById: function (id) { return els[id] || null; },
    createElement: function (t) { var e = fakeEl(null); e.tagName = t.toUpperCase(); return e; },
    addEventListener: function () {}, hidden: false, body: fakeEl('body'),
    documentElement: fakeEl('html'), head: fakeEl('head')
  };

  var win = {
    innerWidth: 390, innerHeight: 844, devicePixelRatio: 2,
    addEventListener: function () {}, removeEventListener: function () {},
    matchMedia: function () { return { matches: false, addListener: function () {} }; },
    requestAnimationFrame: function () { return 1; },
    setTimeout: function () { return 1; }, clearTimeout: function () {},
    setInterval: function () { return 1; }, clearInterval: function () {},
    localStorage: { getItem: function () { return null; }, setItem: function () {} },
    navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', standalone: false },
    performance: { now: function () { return 0; } },
    fetch: function () { return Promise.resolve({ json: function () { return Promise.resolve({}); } }); },
    location: { reload: function () {} },
    console: { log: function () {}, warn: function () {}, error: function () {} },
    Promise: Promise, Math: Math, JSON: JSON, Date: Date, isNaN: isNaN, parseInt: parseInt
  };
  win.window = win;
  win.document = doc;
  win.self = win;
  win.THREE = opts.three ? makeThree() : undefined;
  win.ENGINE = opts.engine ? require('/home/claude/tideholm/engine.js') : undefined;

  var thrown = null;
  try { vm.createContext(win); vm.runInContext(code, win, { filename: 'client.js' }); }
  catch (e) { thrown = e; }

  // simulate the user tapping each title button
  var tapErrors = [];
  ['tHost', 'tJoin', 'tLocal'].forEach(function (id) {
    try { if (els[id].onclick) els[id].onclick({}); } catch (e) { tapErrors.push(id + ': ' + e.message); }
  });
  return {
    thrown: thrown,
    handlers: ['tHost', 'tJoin', 'tLocal'].map(function (id) { return typeof els[id].onclick; }),
    fatalShown: !els.fatal.classList.contains('hide'),
    fatalText: els.fatalTitle.textContent,
    modalShown: !els.modal.classList.contains('hide'),
    tapErrors: tapErrors,
    els: els
  };
}

var pass = 0, fail = 0, fails = [];
function ok(c, m) { if (c) pass++; else { fail++; fails.push(m); } }

console.log('--- scenario A: three.js and engine.js both load ---');
var a = run({ three: true, engine: true });
console.log('  threw:', a.thrown ? a.thrown.message : 'no');
console.log('  handlers:', a.handlers.join(', '), '| overlay:', a.fatalShown ? a.fatalText : 'none', '| sheet opened:', a.modalShown);
ok(a.handlers.every(function (h) { return h === 'function'; }), 'A: all three title buttons are wired');
ok(a.tapErrors.length === 0, 'A: tapping each button throws nothing (' + a.tapErrors.join('; ') + ')');
ok(a.modalShown, 'A: tapping opens a sheet');
ok(!a.fatalShown, 'A: no error overlay on the happy path');

console.log('--- scenario B: three.js fails to load (blocked CDN / offline) ---');
var b = run({ three: false, engine: true });
console.log('  threw:', b.thrown ? b.thrown.message : 'no');
console.log('  handlers:', b.handlers.join(', '), '| overlay:', b.fatalShown ? b.fatalText : 'none');
ok(b.handlers.every(function (h) { return h === 'function'; }), 'B: buttons still wired without three.js');
ok(b.tapErrors.length === 0, 'B: tapping throws nothing without three.js (' + b.tapErrors.join('; ') + ')');
ok(b.fatalShown, 'B: missing three.js shows an on-screen explanation');
ok(/3D library/.test(b.fatalText), 'B: the message names three.js as the problem');

console.log('--- scenario C: engine.js fails to load (missing from the commit) ---');
var c = run({ three: true, engine: false });
console.log('  threw:', c.thrown ? c.thrown.message : 'no');
console.log('  handlers:', c.handlers.join(', '), '| overlay:', c.fatalShown ? c.fatalText : 'none');
ok(c.handlers.every(function (h) { return h === 'function'; }), 'C: buttons still wired without engine.js');
ok(c.tapErrors.length === 0, 'C: tapping throws nothing without engine.js (' + c.tapErrors.join('; ') + ')');
ok(c.fatalShown, 'C: missing engine.js shows an on-screen explanation');
ok(/engine\.js/.test(c.fatalText), 'C: the message names engine.js as the problem');

/* ---- CSS stacking order ----
   A stubbed DOM cannot see paint order, so this reads the real stylesheet.
   The original bug: the modal opened correctly but sat behind the opaque
   title screen, so every tap looked like it did nothing. */
console.log('--- scenario D: overlay stacking order ---');
var css = fs.readFileSync(HTML, 'utf8');
css = css.slice(css.indexOf('<style>'), css.indexOf('</style>'));

function zOf(sel) {
  var re = new RegExp('\\' + '#' + sel.slice(1) + '\\s*\\{([^}]*)\\}');
  var m = css.match(re);
  if (!m) return null;
  var z = m[1].match(/z-index\s*:\s*(-?\d+)/);
  return z ? parseInt(z[1], 10) : 0;
}
var z = {
  title: zOf('#title'), modal: zOf('#modal'), curtain: zOf('#curtain'),
  toast: zOf('#toast'), fatal: zOf('#fatal')
};
console.log('  ', JSON.stringify(z));

ok(z.modal > z.title, 'D: the modal sheet sits above the title screen (' + z.modal + ' > ' + z.title + ')');
ok(z.curtain > z.modal, 'D: the pass-and-play curtain covers the modal (' + z.curtain + ' > ' + z.modal + ')');
ok(z.toast > z.modal, 'D: toasts are readable over the modal (' + z.toast + ' > ' + z.modal + ')');
ok(z.fatal > z.curtain && z.fatal > z.toast, 'D: the error overlay outranks everything');
ok(z.title < z.modal && z.title < z.curtain && z.title < z.fatal,
   'D: nothing the title screen can hide is ever opened over it');

// every fullscreen fixed overlay must declare an explicit z-index, or DOM order decides
var overlays = ['#title', '#modal', '#curtain', '#fatal'];
overlays.forEach(function (sel) {
  ok(zOf(sel) !== null && zOf(sel) !== 0, 'D: ' + sel + ' declares an explicit z-index');
});

console.log('\nPASS ' + pass + '   FAIL ' + fail);
fails.forEach(function (f) { console.log('  ✗ ' + f); });
if (fail) process.exit(1);
