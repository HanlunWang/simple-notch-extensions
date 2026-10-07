#!/usr/bin/env node
// Builds Raycast extensions from the raycast/extensions source the way the app's store does (RaycastStore.swift):
// a partial clone that only fetches the wanted directories, `npm install` without `@raycast/api` (the shim stands
// in for it), and one esbuild bundle per command with react and `@raycast/api` left external. The output folders
// hold what `ray build -e dist` would have produced (package.json, <command>.js, assets/), ready for compat.js or
// for the app's "添加已构建的扩展".
//
//   node build-source.js --node <node> --esbuild <esbuild cli> --out <folder> [--repo <existing clone>] <dir>...
//
// Prints one built folder per line on stdout; progress and problems go to stderr. A directory that is not in the
// repository or fails to build is reported and skipped.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const args = { dirs: [] };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--node' || a === '--esbuild' || a === '--out' || a === '--repo') args[a.slice(2)] = process.argv[++i];
  else args.dirs.push(a);
}
if (!args.node || !args.esbuild || !args.out || args.dirs.length === 0) {
  console.error('usage: build-source.js --node <node> --esbuild <esbuild> --out <folder> [--repo <clone>] <dir>...');
  process.exit(2);
}
const dirs = [...new Set(args.dirs.map((d) => d.trim()).filter((d) => /^[\w.-]+$/.test(d)))];
fs.mkdirSync(args.out, { recursive: true });

// MARK: - Source

let repo = args.repo;
if (!repo) {
  repo = path.join(args.out, '.upstream');
  if (!fs.existsSync(path.join(repo, '.git'))) {
    console.error(`克隆 raycast/extensions（只取 ${dirs.length} 个目录）…`);
    fs.rmSync(repo, { recursive: true, force: true });
    execFileSync('git', ['clone', '--quiet', '--filter=blob:none', '--no-checkout', '--depth', '1', 'https://github.com/raycast/extensions', repo], { stdio: 'inherit' });
    execFileSync('git', ['sparse-checkout', 'init', '--cone'], { cwd: repo, stdio: 'inherit' });
  } else {
    execFileSync('git', ['fetch', '--quiet', '--depth', '1', 'origin'], { cwd: repo, stdio: 'inherit' });
    execFileSync('git', ['reset', '--quiet', '--hard', 'origin/HEAD'], { cwd: repo, stdio: 'ignore' });
  }
  execFileSync('git', ['sparse-checkout', 'set', ...dirs.map((d) => `extensions/${d}`)], { cwd: repo, stdio: 'inherit' });
  execFileSync('git', ['checkout', '--quiet'], { cwd: repo, stdio: 'inherit' });
}
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
console.error(`raycast/extensions@${commit.slice(0, 10)}`);

// MARK: - Build

const npm = path.join(path.dirname(args.node), 'npm');
// No NODE_ENV here: npm reads NODE_ENV=production as --omit=dev, which would defeat the dev-dependency retry below;
// the bundles get their production flag from esbuild's --define instead.
const env = Object.assign({}, process.env, { PATH: `${path.dirname(args.node)}:${process.env.PATH || '/usr/bin:/bin'}` });
delete env.NODE_ENV;

function run(file, argv, cwd) {
  const result = spawnSync(file, argv, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(gist(result.stderr || result.stdout || `${path.basename(file)} 退出码 ${result.status}`));
  return result.stdout;
}

// The tool's own error lines (esbuild's `✘ [ERROR]`, npm's `npm error`) when it printed any, else the last lines: the
// esbuild CLI run through Node ends with Node's own stack dump, which says nothing about the build.
function gist(stderr) {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  const errors = lines.filter((l) => l.includes('[ERROR]') || l.startsWith('npm error') || l.startsWith('Error:') || l.startsWith('error:'));
  return (errors.length ? errors.slice(0, 4) : lines.slice(-5)).join(' ');
}

// MARK: - Native modules
//
// `import { f } from "rust:../rust"` (and `swift:`) makes `ray build` compile a crate and call its binary; we cannot, and
// Raycast itself rejects Rust calls on macOS. The imports are pointed at a stub module at the extension's root whose
// functions reject, so the command bundles and runs, and only the native call fails. Mirrors RaycastNativeModules.swift.
const NATIVE = /(["'])(rust|swift):[^"'\n]*\1/g;
const NATIVE_IMPORT = /import\s+([^;'"]*?)\s*from\s*["'](rust|swift):/g;
const NATIVE_DYNAMIC = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*["'](rust|swift):/g;

function importedNames(clause) {
  const names = new Set();
  let rest = clause.replace(/^\s*type\s+/, '');
  const open = rest.indexOf('{'), close = rest.indexOf('}', open);
  if (open >= 0 && close > open) {
    for (const part of rest.slice(open + 1, close).split(',')) {
      const words = part.trim().split(/[\s:]+/).filter(Boolean);
      if (words[0] === 'type') words.shift();
      if (words[0]) names.add(words[0]);
    }
    rest = rest.slice(0, open) + rest.slice(close + 1);
  }
  const outside = rest.split(/[,\s]+/).filter(Boolean);
  if (outside[0] && outside[0] !== '*' && outside[0] !== 'as') names.add('default');
  return names;
}

function stubNativeModules(source) {
  const names = {};
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(tsx?|jsx?|mjs|cjs)$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (!/["'](rust|swift):/.test(text)) continue;
      for (const m of text.matchAll(NATIVE_IMPORT)) {
        names[m[2]] = names[m[2]] || new Set();
        for (const n of importedNames(m[1])) names[m[2]].add(n);
      }
      // `const { pickColor } = await import("swift:../swift")`
      for (const m of text.matchAll(NATIVE_DYNAMIC)) {
        names[m[2]] = names[m[2]] || new Set();
        for (const n of importedNames(`{${m[1]}}`)) names[m[2]].add(n);
      }
      const depth = path.relative(source, full).split(path.sep).length - 1;
      const prefix = depth === 0 ? './' : '../'.repeat(depth);
      fs.writeFileSync(full, text.replace(NATIVE, (_, quote, kind) => {
        names[kind] = names[kind] || new Set(); // every imported kind gets its stub file
        return `${quote}${prefix}__raycast_native_${kind}.js${quote}`;
      }));
    }
  };
  walk(source);
  for (const [kind, set] of Object.entries(names)) {
    const sorted = [...set].filter((n) => n !== 'default').sort();
    const lines = [
      `// ${kind} 原生模块的替身：Simple Notch 无法编译扩展自带的 ${kind} 代码，这些函数会直接报错。`,
      `const reject = (name) => (...args) => Promise.reject(new Error(\`\${name}：这个扩展的 ${kind} 原生模块在 Simple Notch 里不可用\`));`,
      ...sorted.map((n) => `export const ${n} = reject("${n}");`),
      `export default { ${sorted.join(', ')} };`,
    ];
    fs.writeFileSync(path.join(source, `__raycast_native_${kind}.js`), lines.join('\n') + '\n');
  }
  return Object.keys(names).sort();
}

function entryFile(source, command) {
  for (const ext of ['tsx', 'ts', 'jsx', 'js']) {
    for (const candidate of [`src/${command}.${ext}`, `src/${command}/index.${ext}`]) {
      if (fs.existsSync(path.join(source, candidate))) return candidate;
    }
  }
  return null;
}

function copySource(from, to) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const name = path.basename(src);
      if (name === 'node_modules' || name === 'metadata' || name === 'media' || name === 'screenshots' || name.startsWith('.')) return false;
      // The lockfile describes a tree with `@raycast/api` in it; npm trips over the difference ("reading 'edgesOut'").
      if (name === 'package-lock.json' || name === 'yarn.lock' || name === 'pnpm-lock.yaml' || name.endsWith('.lock')) return false;
      return true;
    },
  });
}

for (const dir of dirs) {
  const from = path.join(repo, 'extensions', dir);
  if (!fs.existsSync(path.join(from, 'package.json'))) {
    console.error(`✗ ${dir}: 仓库里没有这个目录（或没有 package.json）`);
    continue;
  }
  const work = path.join(args.out, dir);
  const source = path.join(work, 'source');
  const dist = path.join(work, 'dist');
  const started = Date.now();
  try {
    const original = fs.readFileSync(path.join(from, 'package.json'), 'utf8');
    const manifest = JSON.parse(original);
    const stamp = path.join(work, 'commit');
    if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === commit && fs.existsSync(path.join(dist, 'package.json'))) {
      console.error(`= ${dir}: 已按 ${commit.slice(0, 10)} 构建过`);
      console.log(dist);
      continue;
    }
    copySource(from, source);
    const pkg = JSON.parse(original);
    pkg.dependencies = Object.assign({}, pkg.dependencies || {});
    delete pkg.dependencies['@raycast/api'];
    pkg.devDependencies = Object.assign({}, pkg.devDependencies || {});
    delete pkg.devDependencies['@raycast/api'];
    delete pkg.devDependencies['@raycast/eslint-config'];
    delete pkg.scripts;
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify(pkg, null, 2));
    const npmInstall = (...flags) => run(args.node, [npm, 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', '--loglevel=error', ...flags], source);
    if (Object.keys(pkg.dependencies).length) {
      try {
        npmInstall('--omit=dev');
      } catch (error) {
        // A peer-dependency conflict in the extension's own tree: npm 7+ refuses, `ray build` (npm 6 rules) did not.
        // npm 10 also crashes on some peer sets of omitted dev dependencies ("reading 'edgesOut'"); the old rules skip them.
        if (!/ERESOLVE|edgesOut/.test(String(error.message))) throw error;
        console.error(`  ${dir}: 依赖树有冲突，按旧规则（--legacy-peer-deps）再装一次`);
        npmInstall('--omit=dev', '--legacy-peer-deps');
      }
    }
    const stubbed = stubNativeModules(source);
    if (stubbed.length) console.error(`  ${dir}: 替换原生模块 ${stubbed.join('、')}`);
    fs.rmSync(dist, { recursive: true, force: true });
    fs.mkdirSync(dist, { recursive: true });
    let withDev = false;
    for (const command of manifest.commands || []) {
      const entry = entryFile(source, command.name);
      if (!entry) throw new Error(`找不到命令 ${command.name} 的源码（src/${command.name}.tsx）`);
      const bundle = () => run(args.node, [args.esbuild, entry, '--bundle', '--platform=node', '--format=cjs', '--target=node22',
        '--external:react', '--external:react/jsx-runtime', '--external:react-dom', '--external:@raycast/api',
        '--jsx=automatic', '--define:process.env.NODE_ENV="production"', '--minify', '--log-level=error',
        `--outfile=${path.join(dist, `${command.name}.js`)}`], source);
      try {
        bundle();
      } catch (error) {
        // A package reached only through a dev dependency (`ray build` installs those): install them once and retry.
        if (withDev || !/Could not resolve/.test(String(error.message))) throw error;
        console.error(`  ${dir}: ${gist(String(error.message))}，补装开发依赖后重试`);
        withDev = true;
        npmInstall('--include=dev', '--legacy-peer-deps');
        bundle();
      }
    }
    fs.writeFileSync(path.join(dist, 'package.json'), original);
    if (fs.existsSync(path.join(source, 'assets'))) fs.cpSync(path.join(source, 'assets'), path.join(dist, 'assets'), { recursive: true });
    fs.writeFileSync(stamp, commit);
    console.error(`✓ ${dir}: ${(manifest.commands || []).length} 个命令，${((Date.now() - started) / 1000).toFixed(1)} s`);
    console.log(dist);
  } catch (error) {
    console.error(`✗ ${dir}: ${String(error && error.message || error).slice(0, 400)}`);
  }
}
