# Development

## Source Setup

The Windows launcher can prepare a source checkout automatically. For a manual setup:

```powershell
npm ci
npm run setup
npm run check
```

Use Node.js 20+, JDK 17+, and Python 3.10+ with Tkinter. `npm run setup` downloads ViaProxy and compiles the included ViaBedrock compatibility sources.

## Useful Checks

```powershell
npm run check:syntax
npm run check:bridge-desktop-gui
npm run check:public-release
npm run check:runtime-package
```

The complete relay suite is `npm run check`. Keep test scope proportional to the protocol behavior being changed.

## Private Runtime Data

Never commit authentication caches, `.env`, runtime status, packet logs, Realm metadata, generated jars, or captures. Before publishing, run:

```powershell
$env:PUBLIC_RELEASE_DENY_TERMS = "private-account-label,private-realm-label"
npm run check:public-release
Remove-Item Env:\PUBLIC_RELEASE_DENY_TERMS
```

The audit hides matched values and reports only category, path, and line number.

## Build the Windows ZIP

```powershell
npm run release:runtime
```

The ZIP is written under `dist/`. Its explicit allowlist includes only launch/runtime source, configuration, and required legal notices. It excludes tests, research notes, history, browser GUI code, dependencies, generated jars, auth data, and logs.

## Source Release

`npm run release:stage` creates a freshly audited source tree with no private Git history. Do not merge a private development history into the public repository.
