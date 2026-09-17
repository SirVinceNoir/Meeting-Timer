# Meeting Timer

An interval timer for parents' evenings and other back-to-back appointment
sessions. It shows the current time, a large countdown to the end of the
current appointment, and a progress bar, and sounds a chime between
appointments.

It runs either as a standalone Windows app or as a single HTML page in a
browser.

---

## Running it

### As a Windows app (no install)

Double-click **`Meeting Timer 2.0.0.exe`**. Nothing is installed and nothing is
written outside the app's own settings; it can be run from a memory stick or a
network share.

To produce that file from source, see [Building](#building) below.

### In a browser

Open `index.html`. Everything it needs is in the folder, so it works with no
network connection. Two things behave slightly worse than in the app:

- The chime cannot play until you have clicked the page at least once. The
  setup panel tells you when this is still outstanding.
- Fullscreen cannot be entered automatically, because browsers only allow it in
  response to a click or key press. Press `F` or double-click the background.

---

## Using it

1. Enter a name for the session, the length of one appointment, and the start
   and end times.
2. Either leave it: the timer starts by itself at the start time; or press
   **Manual Start** to begin immediately.
3. At the end of each appointment the chime sounds and the "please make your
   way to your next appointment" message appears.
4. The session stops on its own at the end time.

Settings are remembered, so the next time it opens everything is as you left
it.

### Controls

Move the mouse to show the control bar, or use the keyboard:

| Key | Action |
| --- | --- |
| `Space` | Pause / resume |
| `N` | Skip to the next appointment |
| `F` | Toggle fullscreen |
| `Esc` | Leave fullscreen; press again to return to the settings panel |

The **+1 min** button extends the current appointment, for when a conversation
overruns. It does not move the end of the session, which stays at the wall-clock
time you set.

Pausing freezes the appointment countdown but not the session end time, for the
same reason.

### Sessions that run past midnight

If the end time is earlier than the start time it is taken as the following day,
so a 22:00–00:30 session works as expected.

---

## Building

Requires [Node.js](https://nodejs.org/) 18 or newer.

```sh
npm install
npm run build          # -> dist/Meeting Timer <version>.exe   (portable, no install)
npm run build:installer # -> dist/Meeting Timer Setup <version>.exe
```

`npm start` runs the app from source without packaging.

The portable `.exe` is about 88 MB because it bundles the Chromium runtime.
That is the cost of it being a genuine standalone app with no dependencies.

> The build is unsigned, so Windows SmartScreen will warn the first time it is
> run on a new machine ("More info" → "Run anyway"). Signing it requires a code
> signing certificate.

---

## Tests

```sh
npm test
```

This runs two things:

- `test/check-packaging.js` — checks that everything the app requires or
  references at runtime is in the `build.files` allow-list in `package.json`.
  Anything missing from that list silently vanishes from the packaged `.exe`,
  and the app then fails only once someone double-clicks it. This also runs
  automatically before `npm run build`.
- `test/smoke.js` — drives the real page inside the real Electron bridge. It
  patches `Date.now` inside the page, so the automatic start, interval
  rollover, catch-up and end-of-session paths are all tested in a few seconds
  rather than over an evening.

---

## How it is put together

| File | Purpose |
| --- | --- |
| `index.html` | The whole timer: markup, styling and logic. No dependencies, no build step. |
| `main.js` | Electron entry point — creates the window. |
| `shell-bridge.js` | Main-process half of the bridge: fullscreen, keep-awake, shared window options. |
| `preload.js` | Exposes `window.timerHost` to the page. |
| `fonts/` | Poppins, bundled so the app works offline. |
| `Old Versions/` | Previous releases, kept for reference. |

`index.html` checks for `window.timerHost` and falls back to the equivalent web
APIs when it is absent, which is what lets the same file work both inside the
app and in a plain browser.

The countdown is derived from `Date.now()` on every tick rather than from a
counter that accumulates. If ticks are delayed, throttled or skipped entirely
— which Chromium does to hidden windows — the display is still correct on the
next tick, and intervals that went by while the window was hidden are collapsed
into a single chime instead of a burst of them.

---

## What changed in 2.0

Fixes:

- The automatic start needed a tick to land exactly on second zero of the start
  minute. Timer drift meant it could miss that moment and never start at all.
  It now fires on the first tick at or after the start time.
- The chime was silent on an automatic start, because browsers block audio
  until the user has interacted with the page.
- Fullscreen was requested on automatic start, where browsers refuse it for the
  same reason. The app now does this natively.
- Stopping the timer, and reaching the end of the session, reloaded the page and
  discarded every setting. Nothing reloads now, and settings persist.
- Starting when the end time had already passed blanked the screen. It is now
  refused with an explanation.
- An interval of zero silently did nothing, so the start button looked broken.
  All rejections now say why.
- The screen wake lock was requested once and silently lost whenever the window
  was hidden. It is now re-acquired, and the packaged app uses a power-save
  block that does not have this problem.
- A hidden window paused the countdown loop and then fired several chimes in a
  row on return.
- The font was fetched from Google Fonts, so it fell back to a generic sans
  whenever there was no network — precisely the situation a standalone app is
  for. It is now bundled.
- Layout no longer overflows in a small window.

Added:

- Settings are remembered between runs.
- Pause / resume, skip to next, and +1 minute.
- A countdown to the automatic start, shown on the setup panel.
- A session line showing the window and how much of it is left.
- Sessions may run past midnight.
