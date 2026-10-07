#!/usr/bin/env node
// The prebuilt mirror behind the launcher's store (Simple Notch builds extensions only from the MIT-licensed raycast/extensions source): the extensions of
// github.com/raycast/extensions, built the way the app builds them (Scripts/raycast-compat/build-source.js), one zip
// per extension, uploaded as assets of the rolling GitHub release `raycast-mirror`. The app downloads a zip, checks
// its sha256 and installs it; an extension without a package (or whose download fails) is still built from source.
//
//   node mirror.js --catalog <raycast-catalog.json> --index <raycast-mirror.json> --out <folder>
//                  --node <node> --esbuild <esbuild cli> [--repo <owner/name>] [--limit 300] [--minutes 240]
//                  [--priority <docs/raycast-compat.md>] [--dry-run]
//
// What gets built this run: every catalog entry whose directory tree differs from the package in the index (new or
// changed), the compatibility targets first (the well-known extensions), then the rest alphabetically, up to --limit
// and while --minutes allow. A build that fails is remembered with its tree and not retried until the tree changes.
// After each batch the zips are uploaded (`gh release upload --clobber`), superseded assets deleted and the index
// rewritten, so an interrupted run loses little. The index is published next to the catalog, and the catalog gets
// its `prebuilt` fields (annotate.js). Nothing from Raycast's servers is used.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { annotate, emptyIndex } = require('./annotate');

const args = { limit: 300, minutes: 240, repo: process.env.GITHUB_REPOSITORY || 'HanlunWang/simple-notch-extensions', release: 'raycast-mirror', batch: 20 };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--dry-run') args.dryRun = true;
  else if (a.startsWith('--')) args[a.slice(2)] = process.argv[++i];
}
for (const key of ['catalog', 'index', 'out', 'node', 'esbuild']) {
  if (!args[key]) {
    console.error('usage: mirror.js --catalog <json> --index <json> --out <folder> --node <node> --esbuild <esbuild> [--limit n] [--minutes n]');
    process.exit(2);
  }
}
// Absolute: build-source.js and zip run with other working directories.
for (const key of ['catalog', 'index', 'out', 'node', 'esbuild', 'priority']) if (args[key]) args[key] = path.resolve(args[key]);
const limit = Number(args.limit), minutes = Number(args.minutes), batchSize = Number(args.batch);
const deadline = Date.now() + minutes * 60 * 1000;
const scripts = __dirname;

const catalog = JSON.parse(fs.readFileSync(args.catalog, 'utf8'));
let index = emptyIndex();
if (fs.existsSync(args.index)) {
  try { index = Object.assign(emptyIndex(), JSON.parse(fs.readFileSync(args.index, 'utf8'))); } catch (error) { console.error(`index unreadable, starting over: ${error.message}`); }
}
// A failure to pack or upload is the run's, not the extension's: those are tried again next time.
for (const [dir, failure] of Object.entries(index.failures)) if (/^(zip|upload):/.test(failure.error || '')) delete index.failures[dir];
index.release = args.release;
index.base = `https://github.com/${args.repo}/releases/download/${args.release}/`;
fs.mkdirSync(args.out, { recursive: true });

const log = (...m) => console.error(...m);
const writeIndex = () => {
  index.updatedAt = new Date().toISOString();
  fs.writeFileSync(args.index, JSON.stringify(index));
};

// MARK: - What to build

// The compatibility list's targets (`| n | Title | `dir` | … |`) come first: they are the well-known extensions and
// the ones the app is checked against. Popularity data would need Raycast's store API, which is not used.
const priority = [];
if (args.priority && fs.existsSync(args.priority)) {
  for (const line of fs.readFileSync(args.priority, 'utf8').split('\n')) {
    const m = /^\| \d+ \| [^|]* \| `([^`]+)`/.exec(line);
    if (m) priority.push(m[1]);
  }
}
const byDir = new Map(catalog.extensions.map((e) => [e.dir, e]));
const rank = new Map(priority.map((d, i) => [d, i]));
const stale = catalog.extensions
  .filter((e) => {
    const pkg = index.extensions[e.dir];
    if (pkg && pkg.tree === e.tree) return false;
    const failure = index.failures[e.dir];
    return !(failure && failure.tree === e.tree);
  })
  .sort((a, b) => (rank.get(a.dir) ?? 1e9) - (rank.get(b.dir) ?? 1e9) || a.dir.localeCompare(b.dir))
  .slice(0, limit);

// Packages for extensions the catalog no longer lists go away with their assets.
const gone = Object.keys(index.extensions).filter((dir) => !byDir.has(dir));
for (const dir of Object.keys(index.failures)) if (!byDir.has(dir)) delete index.failures[dir];

const upToDate = catalog.extensions.filter((e) => index.extensions[e.dir] && index.extensions[e.dir].tree === e.tree).length;
log(`${catalog.extensions.length} extensions in the catalog, ${upToDate} prebuilt and current, ${Object.keys(index.failures).length} known failures, ${gone.length} gone; building ${stale.length} (limit ${limit}, ${minutes} min)`);

// MARK: - Tools

const commit = catalog.commit;
const gh = (...argv) => {
  if (args.dryRun) { log('  gh', argv.join(' ')); return ''; }
  return execFileSync('gh', argv, { encoding: 'utf8', env: Object.assign({ GH_REPO: args.repo }, process.env), stdio: ['ignore', 'pipe', 'pipe'] });
};
function ensureRelease() {
  try {
    gh('release', 'view', args.release, '--json', 'tagName');
  } catch {
    log(`creating release ${args.release}`);
    gh('release', 'create', args.release, '--title', 'Raycast extension mirror', '--latest=false', '--prerelease', '--notes',
      'Prebuilt packages of github.com/raycast/extensions for the Simple Notch launcher, one zip per extension, rebuilt daily when the source changes. ' +
      'Each zip carries the extension\'s own package.json and the repository\'s MIT license (LICENSE.raycast-extensions). ' +
      'Index: the raycast-mirror.json file on the raycast-catalog branch. Not a release of Simple Notch itself.');
  }
}
function upload(files) {
  if (!files.length) return;
  // In groups: one `gh release upload` call per 20 files keeps a failed upload from undoing a whole batch.
  for (let i = 0; i < files.length; i += 20) gh('release', 'upload', args.release, ...files.slice(i, i + 20), '--clobber');
}
function deleteAsset(name) {
  try { gh('release', 'delete-asset', args.release, name, '--yes'); } catch (error) { log(`  could not delete ${name}: ${String(error.message).split('\n')[0]}`); }
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

// MARK: - Source

const repo = path.join(args.out, 'upstream');
let license = '';
function checkout(dirs) {
  if (!fs.existsSync(path.join(repo, '.git'))) {
    execFileSync('git', ['init', '--quiet', repo]);
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/raycast/extensions'], { cwd: repo });
    execFileSync('git', ['sparse-checkout', 'init', '--cone'], { cwd: repo });
    execFileSync('git', ['-c', 'protocol.version=2', 'fetch', '--quiet', '--depth', '1', '--filter=blob:none', 'origin', commit], { cwd: repo, stdio: 'inherit' });
  }
  execFileSync('git', ['sparse-checkout', 'set', ...dirs.map((d) => `extensions/${d}`)], { cwd: repo, stdio: 'inherit' });
  execFileSync('git', ['checkout', '--quiet', '--force', commit], { cwd: repo, stdio: 'inherit' });
  if (!license) license = execFileSync('git', ['show', `${commit}:LICENSE`], { cwd: repo, encoding: 'utf8' });
}

// MARK: - Build, pack, upload

if (gone.length && !args.dryRun) {
  for (const dir of gone) { deleteAsset(index.extensions[dir].file); delete index.extensions[dir]; }
  writeIndex();
}
if (stale.length) ensureRelease();

const builds = path.join(args.out, 'builds');
const zips = path.join(args.out, 'zips');
fs.mkdirSync(zips, { recursive: true });
let built = 0, failed = 0;
for (let start = 0; start < stale.length; start += batchSize) {
  if (Date.now() > deadline) { log(`time budget spent after ${built + failed} extensions`); break; }
  const batch = stale.slice(start, start + batchSize);
  const dirs = batch.map((e) => e.dir);
  log(`\nbatch ${start / batchSize + 1}: ${dirs.join(' ')}`);
  checkout(dirs);
  // build-source.js prints one built dist folder per line; its own problems go to stderr (shown).
  const result = spawnSync(args.node, [path.join(scripts, '..', 'raycast-compat', 'build-source.js'), '--node', args.node, '--esbuild', args.esbuild,
    '--out', builds, '--repo', repo, ...dirs], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
  const errors = new Map();
  for (const line of (result.stderr || '').split('\n')) {
    const m = /^✗ ([\w.-]+): (.*)$/.exec(line);
    if (m) errors.set(m[1], m[2]);
    else if (line.trim()) log('  ' + line.trim());
  }
  const dists = new Set((result.stdout || '').split('\n').filter(Boolean));
  const uploads = [];
  const superseded = [];
  for (const entry of batch) {
    const dist = path.join(builds, entry.dir, 'dist');
    if (!dists.has(dist) || !fs.existsSync(path.join(dist, 'package.json'))) {
      failed++;
      index.failures[entry.dir] = { tree: entry.tree, error: (errors.get(entry.dir) || 'not built').slice(0, 300), at: new Date().toISOString() };
      continue;
    }
    fs.writeFileSync(path.join(dist, 'LICENSE.raycast-extensions'), license);
    const file = `${entry.dir}-${entry.tree.slice(0, 12)}.zip`;
    const zip = path.join(zips, file);
    fs.rmSync(zip, { force: true });
    const zipped = spawnSync('zip', ['-qrX', zip, '.'], { cwd: dist, encoding: 'utf8' });
    if (zipped.status !== 0) {
      failed++;
      log(`  ✗ ${entry.dir}: zip exited ${zipped.status} ${(zipped.stderr || '').trim().slice(0, 200)}`);
      continue;
    }
    const previous = index.extensions[entry.dir];
    if (previous && previous.file !== file) superseded.push(previous.file);
    index.extensions[entry.dir] = {
      tree: entry.tree, commit, file, sha256: sha256(zip), size: fs.statSync(zip).size, license: 'MIT',
      commands: (entry.commands || []).length, builtAt: new Date().toISOString(),
    };
    delete index.failures[entry.dir];
    uploads.push(zip);
    built++;
    log(`  ✓ ${entry.dir} ${(fs.statSync(zip).size / 1024).toFixed(0)} KB`);
  }
  if (!args.dryRun) {
    upload(uploads);
    for (const name of superseded) deleteAsset(name);
    writeIndex();
  }
  // The work folders are not needed again (the next batch has other directories); the clone stays.
  for (const dir of dirs) fs.rmSync(path.join(builds, dir), { recursive: true, force: true });
  for (const zip of uploads) fs.rmSync(zip, { force: true });
}

writeIndex();
const prebuilt = annotate(catalog, index);
fs.writeFileSync(args.catalog, JSON.stringify(catalog));
log(`\nbuilt ${built}, failed ${failed}; ${Object.keys(index.extensions).length} packages in the mirror, ${prebuilt} catalog entries prebuilt and current`);
