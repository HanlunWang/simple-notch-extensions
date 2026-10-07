'use strict';
// Marks the catalog entries the mirror has a prebuilt package for: `prebuilt: {url, sha256, size, license}` on an
// entry whose directory tree is exactly the one the package was built from. Shared by build.js (so a catalog
// published before the day's mirror run still carries yesterday's packages) and mirror.js.

const BASE = (index) => index.base || `https://github.com/${process.env.GITHUB_REPOSITORY || 'HanlunWang/simple-notch-extensions'}/releases/download/${index.release || 'raycast-mirror'}/`;

function annotate(catalog, index) {
  const packages = (index && index.extensions) || {};
  const base = BASE(index || {});
  let count = 0;
  for (const entry of catalog.extensions) {
    delete entry.prebuilt;
    const pkg = packages[entry.dir];
    if (!pkg || pkg.tree !== entry.tree) continue;
    entry.prebuilt = { url: base + encodeURIComponent(pkg.file), sha256: pkg.sha256, size: pkg.size };
    if (pkg.license) entry.prebuilt.license = pkg.license;
    count++;
  }
  return count;
}

function emptyIndex() {
  return { version: 1, updatedAt: new Date(0).toISOString(), release: 'raycast-mirror', extensions: {}, failures: {} };
}

module.exports = { annotate, emptyIndex, BASE };
