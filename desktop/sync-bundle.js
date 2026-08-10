// Copies the live drawing app into bundled/ so it can be packaged inside the
// exe. Run automatically before every build.
const fs = require('fs');
const path = require('path');

// The drawing app is the parent of this folder — the repo root.
const SRC = path.join(__dirname, '..');
const DEST = path.join(__dirname, 'bundled');
const FILES = ['bathroom.html', 'jspdf.umd.min.js', 'icon.ico'];

// The Legal page prints a version, and the drawing app also runs in a plain
// browser where there is no package.json to read it from — so the number is
// written into bathroom.html as well. Two copies of one fact drift the first
// time someone bumps only one of them, so the build stops rather than ship a
// Legal page claiming to be a version that was never released.
{
  const pkg = require('./package.json').version;
  const html = fs.readFileSync(path.join(SRC, 'bathroom.html'), 'utf8');
  const m = html.match(/const APP_VERSION = '([^']+)'/);
  if (!m) {
    console.error('bathroom.html has no APP_VERSION — the Legal page cannot say what it is.');
    process.exit(1);
  }
  if (m[1] !== pkg) {
    console.error(`VERSION MISMATCH: package.json says ${pkg}, bathroom.html says ${m[1]}.`);
    console.error('Set APP_VERSION in bathroom.html to match, then build again.');
    process.exit(1);
  }
  console.log(`version    ${pkg}  (package.json and bathroom.html agree)`);
}

fs.mkdirSync(DEST, { recursive: true });
let missing = [];
FILES.forEach(f => {
  const from = path.join(SRC, f);
  if (!fs.existsSync(from)) { missing.push(f); return; }
  fs.copyFileSync(from, path.join(DEST, f));
  console.log(`bundled  ${f}  ${(fs.statSync(from).size / 1024).toFixed(0)} KB`);
});
// The site-measure drawing surface is a folder, loaded into an iframe by the
// Draw tab, so it has to travel with the app.
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  let n = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name), b = path.join(to, entry.name);
    if (entry.isDirectory()) { n += copyTree(a, b); continue; }
    // A read-only source file makes overwriting in place fail with EPERM —
    // drop the old copy first.
    try { fs.rmSync(b, { force: true }); } catch (_) {}
    fs.copyFileSync(a, b);
    try { fs.chmodSync(b, 0o644); } catch (_) {}
    n++;
  }
  return n;
}
const smFrom = path.join(SRC, 'sitemeasure');
if (fs.existsSync(smFrom)) {
  console.log(`bundled  sitemeasure/  ${copyTree(smFrom, path.join(DEST, 'sitemeasure'))} files`);
} else {
  missing.push('sitemeasure/');
}

if (missing.length) {
  console.error('MISSING from ' + SRC + ': ' + missing.join(', '));
  process.exit(1);
}
