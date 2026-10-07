# simple-notch-extensions

The extension catalog and prebuilt mirror that the Simple Notch launcher's store reads. Everything here is built
from [raycast/extensions](https://github.com/raycast/extensions) (MIT); nothing comes from Raycast's store API.

- **Catalog**: `raycast-catalog.json` on the `raycast-catalog` branch, one entry per extension (name, commands,
  author, the folder's tree hash), rebuilt daily by `.github/workflows/raycast-catalog.yml` with
  `Scripts/raycast-catalog/build.js`.
- **Mirror**: extensions whose source changed are built the way the app builds them
  (`Scripts/raycast-compat/build-source.js`, esbuild) and uploaded as one zip each to the rolling release
  `raycast-mirror`. The index `raycast-mirror.json` (file name, SHA-256, size, license per extension) sits next to
  the catalog, and catalog entries that have a package carry `prebuilt`. The app checks the SHA-256 and falls back
  to building from source when a package is missing or does not match.
- `priority.md`: the extensions prebuilt first.

Each zip includes the extension's own `package.json` and raycast/extensions' license as `LICENSE.raycast-extensions`.
These are not Raycast's or Simple Notch's releases.

The scripts in this repository are MIT licensed (`LICENSE`).
