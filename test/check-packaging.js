'use strict';

/**
 * Guards the `build.files` allow-list in package.json.
 *
 * That list is explicit, so anything the app requires or references at runtime
 * but is not listed simply vanishes from the packaged .exe — and the app then
 * fails only when a user double-clicks it. This walks what main.js requires and
 * what index.html references, and checks each one would actually be packaged.
 *
 *   node test/check-packaging.js
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const patterns = pkg.build.files;

let failures = 0;

function check(name, ok, detail) {
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ''}`);
  }
}

/** Minimal glob match for the shapes used in build.files. */
function matches(pattern, file) {
  const rx = new RegExp('^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/\*/g, '.*')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*') + '$');
  return rx.test(file);
}

const isPackaged = (file) => patterns.some((p) => matches(p, file));

/** Local modules reached from an entry point, followed transitively. */
function localRequires(entry, seen = new Set()) {
  const rel = path.relative(ROOT, entry).replace(/\\/g, '/');
  if (seen.has(rel)) return seen;
  seen.add(rel);

  const source = fs.readFileSync(entry, 'utf8');
  const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    let target = path.resolve(path.dirname(entry), m[1]);
    if (!fs.existsSync(target)) target += '.js';
    if (fs.existsSync(target)) localRequires(target, seen);
  }
  return seen;
}

console.log('\nModules reachable from the Electron entry point');
const entry = path.join(ROOT, pkg.main);
for (const file of localRequires(entry)) {
  check(`${file} is packaged`, isPackaged(file),
    `not matched by build.files: ${JSON.stringify(patterns)}`);
}

console.log('\nAssets referenced by index.html');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const refs = new Set();
// src="...", href="...", and url(...) in CSS
for (const re of [/(?:src|href)\s*=\s*["']([^"':#?]+)["']/g, /url\(\s*['"]?([^'")]+)['"]?\s*\)/g]) {
  let m;
  while ((m = re.exec(html)) !== null) {
    const ref = m[1].trim();
    if (!ref || /^(https?:|data:|mailto:|#)/.test(ref)) continue;
    refs.add(ref.replace(/^\.\//, ''));
  }
}

if (refs.size === 0) {
  check('index.html asset references were found', false, 'the scanner matched nothing, so it is not actually checking anything');
}
for (const ref of refs) {
  const onDisk = fs.existsSync(path.join(ROOT, ref));
  check(`${ref} exists on disk`, onDisk);
  if (onDisk) check(`${ref} is packaged`, isPackaged(ref), `not matched by build.files`);
}

console.log('\nPreload path declared in the entry point');
check('preload.js is packaged', isPackaged('preload.js'));

console.log(`\n${failures === 0 ? 'ALL PASSED' : 'FAILURES'}: packaging manifest check.`);
process.exit(failures === 0 ? 0 : 1);
