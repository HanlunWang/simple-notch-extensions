#!/usr/bin/env node
// Builds the Raycast extension catalog the launcher's store searches: one JSON file made from the package.json
// of every extension in a checkout of github.com/raycast/extensions (a partial clone that only has those files
// is enough, see Scripts/raycast-catalog.sh). Nothing from Raycast's own store API is used.
//
//   node build.js --repo <checkout> --out <file.json> [--mirror <raycast-mirror.json>]
//
// With --mirror, entries the mirror (mirror.js) has a prebuilt package for carry `prebuilt: {url, sha256, size}`.
//
// Each entry carries the directory name (what the store installs), the manifest fields the store shows, and the
// git tree hash of the directory, so the app can tell an installed extension has changed without any history.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { annotate } = require('./annotate');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
if (!args.repo || !args.out) {
  console.error('usage: build.js --repo <raycast/extensions checkout> --out <catalog.json>');
  process.exit(2);
}
const repo = path.resolve(args.repo);
const root = path.join(repo, 'extensions');

const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const commit = git('rev-parse', 'HEAD').trim();
// One `ls-tree` gives every extension directory's tree hash.
const trees = new Map();
for (const line of git('ls-tree', 'HEAD', 'extensions/').split('\n')) {
  const m = /^\d+ tree ([0-9a-f]{40})\textensions\/(.+)$/.exec(line);
  if (m) trees.set(m[2], m[1]);
}

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string').map((s) => s.trim()).filter(Boolean) : []);

const extensions = [];
const problems = [];
for (const dir of fs.readdirSync(root).sort()) {
  const file = path.join(root, dir, 'package.json');
  if (!fs.existsSync(file)) continue;
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    problems.push(`${dir}: ${error.message}`);
    continue;
  }
  if (!Array.isArray(manifest.commands) || !text(manifest.name)) continue;
  const platforms = strings(manifest.platforms);
  if (platforms.length && !platforms.includes('macOS')) continue;
  const commands = manifest.commands
    .filter((c) => c && text(c.name))
    .map((c) => {
      const command = { name: text(c.name), title: text(c.title) || text(c.name), mode: text(c.mode) || 'view' };
      if (text(c.subtitle)) command.subtitle = text(c.subtitle);
      if (text(c.description)) command.description = text(c.description);
      if (text(c.icon)) command.icon = text(c.icon);
      const keywords = strings(c.keywords);
      if (keywords.length) command.keywords = keywords;
      if (c.disabledByDefault === true) command.disabledByDefault = true;
      return command;
    });
  if (!commands.length) continue;
  const entry = { dir, name: text(manifest.name), title: text(manifest.title) || text(manifest.name), description: text(manifest.description), commands };
  if (text(manifest.icon)) entry.icon = text(manifest.icon);
  if (text(manifest.author)) entry.author = text(manifest.author);
  if (text(manifest.owner)) entry.owner = text(manifest.owner);
  const categories = strings(manifest.categories);
  if (categories.length) entry.categories = categories;
  if (platforms.length) entry.platforms = platforms;
  const dependencies = Object.keys(manifest.dependencies || {}).filter((d) => d !== '@raycast/api');
  if (dependencies.length) entry.dependencies = dependencies.length;
  const preferences = (manifest.preferences || []).filter((p) => p && p.required && p.default === undefined).length;
  if (preferences) entry.requiredPreferences = preferences;
  if (manifest.tools && manifest.tools.length) entry.tools = manifest.tools.length;
  const tree = trees.get(dir);
  if (!tree) {
    problems.push(`${dir}: no tree hash`);
    continue;
  }
  entry.tree = tree;
  extensions.push(entry);
}

const catalog = { version: 1, generatedAt: new Date().toISOString(), commit, repository: 'raycast/extensions', extensions };
let prebuilt = 0;
if (args.mirror && fs.existsSync(args.mirror)) {
  try {
    prebuilt = annotate(catalog, JSON.parse(fs.readFileSync(args.mirror, 'utf8')));
  } catch (error) {
    problems.push(`mirror index: ${error.message}`);
  }
}
fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
fs.writeFileSync(args.out, JSON.stringify(catalog));
console.error(`${extensions.length} extensions at ${commit.slice(0, 10)}, ${prebuilt} prebuilt → ${args.out} (${(fs.statSync(args.out).size / 1024).toFixed(0)} KB)`);
for (const problem of problems.slice(0, 20)) console.error('  skipped ' + problem);
if (problems.length > 20) console.error(`  … ${problems.length - 20} more`);
