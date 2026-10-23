'use strict';

/**
 * End-to-end smoke test for the Meeting Timer.
 *
 * Runs the real index.html inside the real Electron bridge (preload and IPC
 * handlers included) and drives it through the DOM. Date.now is patched inside
 * the page so the time-dependent paths — automatic start, interval rollover,
 * catch-up after the window is hidden, end of session — can be tested in a few
 * seconds instead of a few hours.
 *
 *   npm test
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const bridge = require('../shell-bridge');

const ROOT = path.join(__dirname, '..');
const INTERVAL_S = 20;

// A fresh profile for every run. The page restores its settings, including
// an armed timer, before the test can clear them, so state left in a shared
// profile by an earlier run would otherwise leak into this one.
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-timer-test-'));
app.setPath('userData', PROFILE);
app.on('quit', () => {
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* still locked */ }
});

let failures = 0;
let checks = 0;
let lastSection = 'startup';

function check(name, condition, detail) {
  checks++;
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail !== undefined ? `\n          got: ${detail}` : ''}`);
  }
}

function section(title) {
  lastSection = title;
  console.log(`\n${title}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The harness drives a real GUI process, so it gets a hard deadline rather
// than being allowed to hang.
const watchdog = setTimeout(() => {
  console.log(`\nTIMED OUT while in: ${lastSection}`);
  app.exit(1);
}, 90000);

app.whenReady().then(async () => {
  bridge.registerBridge();

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    webPreferences: Object.assign({
      preload: path.join(ROOT, 'preload.js')
    }, bridge.WEB_PREFERENCES)
  });

  bridge.attachWindow(win);

  const run = (code) => win.webContents.executeJavaScript(code, true);

  await win.loadFile(path.join(ROOT, 'index.html'));

  // -- instrumentation -------------------------------------------------------
  const INSTRUMENT = `
    (function () {
      window.__offset = 0;
      var realNow = Date.now.bind(Date);
      Date.now = function () { return realNow() + window.__offset; };
      window.__advance = function (ms) { window.__offset += ms; };

      window.__rings = 0;
      var alarm = document.getElementById('alarmSound');
      alarm.play = function () { window.__rings++; return Promise.resolve(); };

      // Capture the page's AudioContext when the keep-alive next builds its
      // source, so the test can see whether the context is really running.
      window.__audioCtx = null;
      var realCreateSource = AudioContext.prototype.createBufferSource;
      AudioContext.prototype.createBufferSource = function () {
        window.__audioCtx = this;
        return realCreateSource.apply(this, arguments);
      };
      window.__audio = function () {
        return {
          keepAlive: document.body.dataset.audioKeepAlive,
          ctxState: window.__audioCtx ? window.__audioCtx.state : 'none'
        };
      };
      window.__waitForRings = function (n, timeoutMs) {
        return new Promise(function (resolve) {
          var started = performance.now();
          (function poll() {
            if (window.__rings >= n || performance.now() - started > timeoutMs) {
              resolve(window.__rings);
            } else {
              setTimeout(poll, 50);
            }
          })();
        });
      };

      window.__set = function (id, value) {
        var el = document.getElementById(id);
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      window.__click = function (id) { document.getElementById(id).click(); };
      window.__text = function (id) { return document.getElementById(id).textContent; };

      window.__hhmm = function (offsetMinutes) {
        var d = new Date(Date.now() + offsetMinutes * 60000);
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
      };

      // The time fields only carry HH:MM, so the real start instant depends on
      // where in the minute the test happens to run. Tests advance by this
      // rather than by a guessed amount.
      window.__msUntilStart = function () {
        var parts = document.getElementById('startTime').value.split(':');
        var d = new Date(Date.now());
        d.setHours(Number(parts[0]), Number(parts[1]), 0, 0);
        return d.getTime() - Date.now();
      };

      window.__remaining = function () {
        var parts = document.getElementById('timerDisplay').textContent.split(':');
        return Number(parts[0]) * 60 + Number(parts[1]);
      };

      window.__state = function () {
        return {
          cls: document.body.className,
          overlayHidden: document.getElementById('overlay').classList.contains('hidden'),
          display: document.getElementById('timerDisplay').textContent,
          error: document.getElementById('setupError').textContent,
          notice: document.getElementById('autoStartNotice').textContent,
          title: document.getElementById('title').textContent,
          messageShown: document.getElementById('message').classList.contains('show'),
          rings: window.__rings,
          sessionInfo: document.getElementById('sessionInfo').textContent
        };
      };
      try { localStorage.clear(); } catch (e) {}
      return true;
    })();
  `;
  await run(INSTRUMENT);

  const state = () => run(`window.__state()`);
  const remaining = () => run(`window.__remaining()`);
  const between = (v, lo, hi) => v >= lo && v <= hi;

  // =========================================================================
  section('Initial state');
  // =========================================================================
  let s = await state();
  check('setup overlay is visible on load', s.overlayHidden === false);
  check('body starts in the idle state', /\bidle\b/.test(s.cls), s.cls);

  const clockText = await run(`window.__text('clock')`);
  check('clock is showing a real time', /\d/.test(clockText) && clockText !== '--:--:--', clockText);

  // =========================================================================
  section('Validation (bug: a zero interval was a silent no-op)');
  // =========================================================================
  await run(`window.__set('minutes', ''); window.__set('seconds', '');`);
  await run(`window.__click('btnManualStart')`);
  s = await state();
  check('a zero interval is refused with an explanation', /longer than zero/i.test(s.error), JSON.stringify(s.error));
  check('a refused start leaves the setup panel open', s.overlayHidden === false);

  // =========================================================================
  section('Validation (bug: starting after the end time blanked the page)');
  // =========================================================================
  await run(`
    window.__set('minutes', '5');
    window.__set('seconds', '0');
    window.__set('startTime', window.__hhmm(-120));
    window.__set('endTime', window.__hhmm(-60));
  `);
  await run(`window.__click('btnManualStart')`);
  s = await state();
  check('an end time in the past is refused with an explanation', /already passed/i.test(s.error), JSON.stringify(s.error));
  check('the page did not reload or blank', s.overlayHidden === false);
  await sleep(300);
  check('audio keep-alive is off with no session pending',
    (await run(`window.__audio()`)).keepAlive === 'off', JSON.stringify(await run(`window.__audio()`)));

  // =========================================================================
  section('Validation: interval longer than the session');
  // =========================================================================
  await run(`
    window.__set('minutes', '90');
    window.__set('seconds', '0');
    window.__set('startTime', window.__hhmm(1));
    window.__set('endTime', window.__hhmm(31));
  `);
  await run(`window.__click('btnManualStart')`);
  s = await state();
  check('an over-long interval is refused', /longer than the whole session/i.test(s.error), JSON.stringify(s.error));

  // =========================================================================
  section('Validation: arming after the start time');
  // =========================================================================
  await run(`
    window.__set('minutes', '5');
    window.__set('startTime', window.__hhmm(-10));
    window.__set('endTime', window.__hhmm(50));
  `);
  await run(`window.__click('btnArm')`);
  s = await state();
  check('arming is refused once the start time has passed', /start time has already passed/i.test(s.error), JSON.stringify(s.error));
  check('a refused arm leaves the setup panel open', s.overlayHidden === false && /\bidle\b/.test(s.cls), s.cls);

  // =========================================================================
  section('Arming');
  // =========================================================================
  await run(`
    window.__set('timerName', 'Year 9 Parents Evening');
    window.__set('minutes', '0');
    window.__set('seconds', '${INTERVAL_S}');
    window.__set('startTime', window.__hhmm(5));
    window.__set('endTime', window.__hhmm(65));
  `);
  await sleep(300);
  s = await state();
  check('setup panel says the timer is not armed yet', /Not armed/i.test(s.notice), JSON.stringify(s.notice));
  check('keep-awake is not engaged before arming', bridge.isKeepAwakeActive() === false);
  check('audio keep-alive is off before arming', (await run(`window.__audio()`)).keepAlive === 'off');

  // Without Arm, reaching the start time must not start anything.
  const skip = await run(`(function () { var ms = window.__msUntilStart() + 1500; window.__advance(ms); return ms; })()`);
  await sleep(400);
  s = await state();
  check('an unarmed timer does not start by itself', /\bidle\b/.test(s.cls) && s.overlayHidden === false, s.cls);
  await run(`window.__advance(-${skip})`);
  await sleep(300);

  await run(`window.__click('btnArm')`);
  await sleep(300);
  s = await state();
  check('arm switches to the armed state', /\barmed\b/.test(s.cls), s.cls);
  check('arm closes the setup panel', s.overlayHidden === true);
  check('armed display is labelled as the countdown to the first chime',
    (await run(`window.__text('remainingLabel')`)) === 'First Chime In');
  check('armed display counts down to the start time', /^0[45]:\d{2}$/.test(s.display), s.display);
  check('armed state is announced in the session line', /ARMED/.test(s.sessionInfo), s.sessionInfo);
  check('keep-awake engaged while armed', bridge.isKeepAwakeActive() === true);

  await run(`window.__click('btnSettings')`);
  await sleep(300);
  s = await state();
  check('disarming returns to the setup panel', /\bidle\b/.test(s.cls) && s.overlayHidden === false, s.cls);
  check('the setup panel says it is no longer armed', /Not armed/i.test(s.notice), JSON.stringify(s.notice));
  check('keep-awake released on disarm', bridge.isKeepAwakeActive() === false);

  await run(`window.__click('btnArm')`);
  await run(`window.__advance(window.__msUntilStart() - 10000)`);
  await sleep(400);
  s = await state();
  check('countdown reaches the last seconds before the start', /^00:(09|10)$/.test(s.display), s.display);

  // =========================================================================
  section('Audio keep-alive (bug: a sleeping HDMI link clipped the chime)');
  // =========================================================================
  let audio = await run(`window.__audio()`);
  check('audio keep-alive is on while armed', audio.keepAlive === 'on', JSON.stringify(audio));
  check('the keep-alive audio context is actually running', audio.ctxState === 'running', JSON.stringify(audio));

  // =========================================================================
  section('Automatic start (bug: missed when the tick skipped second zero)');
  // =========================================================================
  // Land 1.5s past the start instant, deliberately off a whole second: the old
  // "seconds === 0" check would have missed this entirely.
  await run(`window.__rings = 0; window.__advance(window.__msUntilStart() + 1500)`);
  await sleep(400);
  s = await state();
  check('timer started automatically', /\brunning\b/.test(s.cls), s.cls);
  check('setup panel closed on automatic start', s.overlayHidden === true);
  check('custom timer name is applied to the heading', s.title === 'Year 9 Parents Evening', s.title);
  check('keep-awake engaged while running', bridge.isKeepAwakeActive() === true);

  // Aligned to the session start, so ~1.5s of a 20s interval has been used.
  let left = await remaining();
  check('first interval is aligned to the session start time',
    between(left, INTERVAL_S - 3, INTERVAL_S - 1), `${left}s of ${INTERVAL_S}s`);

  // The start chime may wait out the keep-alive warm-up, so poll for it.
  const startRings = await run(`window.__waitForRings(1, 3000)`);
  check('the chime sounds when the session starts', startRings === 1, `rings=${startRings}`);
  await sleep(300);
  check('the start chime sounds only once', (await run(`window.__rings`)) === 1);
  check('audio keep-alive stays on while running', (await run(`window.__audio()`)).keepAlive === 'on');

  // =========================================================================
  section('Interval rollover and the alarm');
  // =========================================================================
  await run(`window.__rings = 0`);
  await run(`window.__advance(window.__remaining() * 1000 + 800)`);
  await sleep(400);
  s = await state();
  check('alarm rang once at the interval boundary', s.rings === 1, `rings=${s.rings}`);
  check('"make your way" message is shown', s.messageShown === true);
  left = await remaining();
  check('a fresh interval started', between(left, INTERVAL_S - 2, INTERVAL_S), `${left}s of ${INTERVAL_S}s`);

  // =========================================================================
  section('Catch-up (bug: a hidden window fired the alarm repeatedly)');
  // =========================================================================
  await run(`window.__rings = 0`);
  // Skip to 3s past a boundary, six whole intervals later.
  await run(`window.__advance(window.__remaining() * 1000 + ${5 * INTERVAL_S * 1000} + 3000)`);
  await sleep(400);
  s = await state();
  check('six missed intervals ring the alarm only once', s.rings === 1, `rings=${s.rings}`);
  left = await remaining();
  check('display resynchronised to the wall clock',
    between(left, INTERVAL_S - 5, INTERVAL_S - 2), `${left}s of ${INTERVAL_S}s`);

  // =========================================================================
  section('Controls: pause, resume, next, +1 min');
  // =========================================================================
  await run(`window.__click('btnPause')`);
  s = await state();
  check('pause switches to the paused state', /\bpaused\b/.test(s.cls), s.cls);
  check('paused is announced in the session line', /PAUSED/.test(s.sessionInfo), s.sessionInfo);

  const beforePause = await remaining();
  await run(`window.__advance(6000)`);
  await sleep(400);
  const afterPause = await remaining();
  check('the countdown is frozen while paused', beforePause === afterPause, `${beforePause}s -> ${afterPause}s`);

  await run(`window.__click('btnPause')`); // resume
  s = await state();
  check('resume returns to the running state', /\brunning\b/.test(s.cls), s.cls);
  const afterResume = await remaining();
  check('resume continues where it left off, not where the clock went',
    Math.abs(afterResume - beforePause) <= 1, `${beforePause}s -> ${afterResume}s`);

  await run(`window.__rings = 0; window.__click('btnAddMin')`);
  const afterAddMin = await remaining();
  check('+1 min adds a minute to the current appointment',
    between(afterAddMin - afterResume, 59, 61), `${afterResume}s -> ${afterAddMin}s`);

  await run(`window.__click('btnNext')`);
  const afterNext = await remaining();
  s = await state();
  check('next restarts the interval at full length', afterNext === INTERVAL_S, `${afterNext}s`);
  check('next rings the alarm', s.rings === 1, `rings=${s.rings}`);

  // =========================================================================
  section('End of session (bug: reload discarded every setting)');
  // =========================================================================
  await run(`window.__advance(70 * 60000)`); // past the session end
  await sleep(400);
  s = await state();
  check('session finishes when the end time passes', /\bfinished\b/.test(s.cls), s.cls);
  check('setup panel reopens at the end', s.overlayHidden === false);
  check('end of session is announced', /complete/i.test(s.sessionInfo), s.sessionInfo);
  check('keep-awake released at the end of the session', bridge.isKeepAwakeActive() === false);
  await sleep(300);
  audio = await run(`window.__audio()`);
  check('audio keep-alive stops at the end of the session', audio.keepAlive === 'off', JSON.stringify(audio));
  check('the audio device is released at the end of the session', audio.ctxState === 'suspended', JSON.stringify(audio));

  const kept = await run(`({
    name: document.getElementById('timerName').value,
    minutes: document.getElementById('minutes').value,
    seconds: document.getElementById('seconds').value
  })`);
  check('settings survive the end of the session',
    kept.name === 'Year 9 Parents Evening' && kept.minutes === '0' && kept.seconds === String(INTERVAL_S),
    JSON.stringify(kept));

  // =========================================================================
  section('Settings persistence across a restart');
  // =========================================================================
  // Leave it armed for a session in the future, as if the PC restarted while
  // waiting for the evening to begin.
  await run(`
    window.__set('startTime', window.__hhmm(5));
    window.__set('endTime', window.__hhmm(65));
    window.__click('btnArm');
  `);
  win.webContents.reload();
  await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
  await sleep(300);

  const rearmed = await run(`({
    cls: document.body.className,
    overlayHidden: document.getElementById('overlay').classList.contains('hidden')
  })`);
  check('an armed timer re-arms itself after a restart',
    /\barmed\b/.test(rearmed.cls) && rearmed.overlayHidden === true, rearmed.cls);
  await run(`document.getElementById('btnSettings').click()`);
  // Arming went fullscreen; leave it so the bridge checks start from scratch.
  // The hidden test window does not echo the change, so push it as well.
  win.setFullScreen(false);
  win.webContents.send('timer:fullscreen-changed', false);
  await sleep(300);

  const restored = await run(`({
    name: document.getElementById('timerName').value,
    minutes: document.getElementById('minutes').value,
    seconds: document.getElementById('seconds').value,
    startTime: document.getElementById('startTime').value,
    endTime: document.getElementById('endTime').value
  })`);
  check('the timer name is restored after a restart', restored.name === 'Year 9 Parents Evening', restored.name);
  check('the interval is restored after a restart',
    restored.minutes === '0' && restored.seconds === String(INTERVAL_S), JSON.stringify(restored));
  check('the session times are restored after a restart',
    /^\d{2}:\d{2}$/.test(restored.startTime) && /^\d{2}:\d{2}$/.test(restored.endTime),
    JSON.stringify(restored));

  // =========================================================================
  section('Electron bridge');
  // =========================================================================
  const shape = await run(`({
    present: typeof window.timerHost === 'object' && window.timerHost !== null,
    setFullscreen: typeof window.timerHost.setFullscreen,
    isFullscreen: typeof window.timerHost.isFullscreen,
    setKeepAwake: typeof window.timerHost.setKeepAwake,
    initial: window.timerHost.isFullscreen()
  })`);
  check('preload exposes the host bridge', shape.present === true);
  check('bridge exposes setFullscreen', shape.setFullscreen === 'function');
  check('bridge exposes setKeepAwake', shape.setKeepAwake === 'function');
  check('bridge exposes isFullscreen', shape.isFullscreen === 'function');
  check('fullscreen state starts false', shape.initial === false, String(shape.initial));

  // The main process pushes fullscreen changes; the preload caches them so the
  // page can read the state synchronously inside a keydown handler.
  win.webContents.send('timer:fullscreen-changed', true);
  await sleep(150);
  check('pushed fullscreen state reaches the page',
    (await run(`window.timerHost.isFullscreen()`)) === true);

  win.webContents.send('timer:fullscreen-changed', false);
  await sleep(150);
  check('pushed fullscreen state clears again',
    (await run(`window.timerHost.isFullscreen()`)) === false);

  // Reaching the real IPC handlers must not reject or hang.
  const invoked = await run(`
    (async function () {
      await window.timerHost.setKeepAwake(true);
      return 'ok';
    })().catch(function (e) { return 'rejected: ' + e.message; });
  `);
  check('setKeepAwake reaches the main process without error', invoked === 'ok', invoked);
  await sleep(150);
  check('setKeepAwake actually engaged the power-save blocker', bridge.isKeepAwakeActive() === true);
  await run(`window.timerHost.setKeepAwake(false)`);
  await sleep(150);
  check('setKeepAwake releases the power-save blocker', bridge.isKeepAwakeActive() === false);

  // =========================================================================
  section('Offline assets');
  // =========================================================================
  const assets = await run(`
    (async function () {
      var results = {};
      var urls = {
        font400: 'fonts/poppins-400.woff2',
        font600: 'fonts/poppins-600.woff2',
        logo: 'Logo.png',
        ding: 'Timer-Ding.wav'
      };
      for (var key in urls) {
        try {
          var r = await fetch(urls[key]);
          results[key] = r.ok ? (await r.blob()).size : 'HTTP ' + r.status;
        } catch (e) { results[key] = 'error: ' + e.message; }
      }
      results.externalRefs = document.documentElement.outerHTML.match(/https?:\\/\\/[^"'\\s)]+/g) || [];
      await document.fonts.ready;
      results.fontLoaded = document.fonts.check('16px Poppins');
      return results;
    })();
  `);
  check('bundled 400-weight font loads', typeof assets.font400 === 'number' && assets.font400 > 0, String(assets.font400));
  check('bundled 600-weight font loads', typeof assets.font600 === 'number' && assets.font600 > 0, String(assets.font600));
  check('logo loads', typeof assets.logo === 'number' && assets.logo > 0, String(assets.logo));
  check('alarm sound loads', typeof assets.ding === 'number' && assets.ding > 0, String(assets.ding));
  check('Poppins is actually applied', assets.fontLoaded === true);
  check('no remaining external network references',
    assets.externalRefs.length === 0, JSON.stringify(assets.externalRefs));

  // =========================================================================
  console.log(`\n${failures === 0 ? 'ALL PASSED' : 'FAILURES'}: ${checks - failures}/${checks} checks passed.`);
  clearTimeout(watchdog);
  win.destroy();
  app.exit(failures === 0 ? 0 : 1);
}).catch((err) => {
  console.error('Test harness crashed:', err);
  app.exit(1);
});
