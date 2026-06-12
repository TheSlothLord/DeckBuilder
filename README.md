# 🪵 DeckBuilder

**Decking plank layout & cut optimizer.** Enter your deck dimensions, board
spacing, and the plank lengths you have or can buy — DeckBuilder snaps every seam
to the backing-board (joist) grid, minimizes waste with offcut reuse and saw-kerf
accounting, uses your on-hand stock first and lists what to buy for the rest, and
draws a clean, *not-too-structured* seam pattern you can zoom into and export.

Runs as a **web app**, a **Windows desktop app**, and an **Android 15 app** — all
from one React/TypeScript codebase.

![A sample optimized deck plan](docs/sample-plan.svg)

## Features

- **Seams snap to the joist grid** — every butt joint lands on a backing board.
- **Cut optimization** — 1D cutting-stock packing with **saw kerf** and **offcut reuse**.
- **Inventory → shopping list** — uses planks you already own first, then tells you
  exactly which lengths and quantities to buy to finish the job.
- **Five seam patterns** — true random, random-with-rules, jittered brick, staggered,
  max scatter; a seed you can step through, and a waste ↔ looks slider.
- **Multiple decks**, per-deck board spacing with **auto-fit**, **no-seam** mode for
  short decks, and **edge handling** (rip / overhang / gap).
- **Deck shapes** — plain rectangle, **L-shape** (a rectangular notch cut from any
  corner), or a **custom polygon** of N corner points; rows are clipped to the
  outline (non-convex shapes split into multiple runs), seams stay on the joist
  grid, and boundary planks get **angled (bevelled) end cuts** recorded in the cut list.
- **Picture-frame borders** — perimeter rings with mitred or butt corners.
- **Visual plan** — interactive SVG, full-screen **pinch-zoom**, and **PNG export**.
- **Save/Load** projects as `.deck` files (native share sheet on Android).
- **Update check** — on launch the app compares its version against the latest
  GitHub release and shows a banner linking to the download when a newer one exists.

## Download

Grab the latest packaged builds from the [**Releases**](../../releases) page:

| Platform | File |
|---|---|
| Android 15 | `DeckBuilder.apk` (sideload) |
| Windows | `DeckBuilder-<version>-win-x64.zip` (unzip → run `DeckBuilder.exe`) |

See [DESIGN.md](DESIGN.md) for the full design (model, algorithm, math).

## The app — `DeckBuilder-<version>-win-x64.zip`

A standalone Windows desktop app (Electron). **Unzip** `release\DeckBuilder-*-win-x64.zip`
anywhere and run **`DeckBuilder.exe`** inside — its own window, **no console, no Node
install required**.

> **Why a zip and not a single .exe?** A single-file portable build self-extracts to
> `%TEMP%` and runs from there, which Windows Defender's ML heuristic false-flags as
> `Trojan:Win32/Wacatac.H!ml` (it isn't malware — it's the unsigned self-extractor
> pattern). The zipped folder build runs the genuine Electron binary directly and is
> not flagged. To ship a clean *single* .exe you need an Authenticode **code-signing
> certificate** (see below).

First launch may show SmartScreen ("Windows protected your PC") because the exe is
unsigned — click **More info → Run anyway**. Code signing removes this too.

### Build / rebuild

```bash
npm install        # first time only
npm run dist:win   # builds the UI, then packages release\DeckBuilder-<version>-win-x64.zip
```

`npm run dist:win` runs the Vite build and `electron-builder --win` (zip target).

### Code signing (optional, for clean distribution)

To eliminate both the Defender flag on a single-file build and the SmartScreen
warning, sign with an OV/EV code-signing certificate, then set in `package.json`
under `build.win`: `"signAndEditExecutable": true` and provide the cert via
`CSC_LINK` / `CSC_KEY_PASSWORD` env vars (electron-builder picks them up).

### Lightweight alternative — `DeckBuilder.cmd`

`DeckBuilder.cmd` (in the project root) launches the same app in a browser
"app window" without packaging. It needs Node available and leaves a small
background console while open. Handy during development; the `.exe` is the
real deliverable.

## Android app (Android 15)

A native Android wrapper via **Capacitor** (the same React UI in a WebView),
targeting **API 35 (Android 15)**, minSdk 23.

The built app is **`release\DeckBuilder.apk`** (debug-signed, ~4 MB).

On Android, **Save** (`.deck` and the plan PNG) writes the file and opens the
system **share sheet** (save to Files/Drive/email), via Capacitor Filesystem +
Share. Each deck has a 🔍 **View / zoom** button for a full-screen,
pinch-to-zoom plan with **PNG export**.

### Install it on your phone

1. On your phone, open the [**Releases**](../../releases) page and download the
   latest **`DeckBuilder-vX.Y.Z.apk`** (or copy the APK over from a PC).
2. Tap the downloaded file. Android will say installing is blocked — tap
   **Settings**, then enable **Allow from this source** for the app you opened it
   with (your browser or Files app). This is *Settings → Apps → Special access →
   Install unknown apps*.
3. Go back and tap **Install**, then **Open**.
4. To update later: download the newer APK and install it over the top — your
   saved decks are kept.

> The APK is **debug-signed** (fine for sideloading/personal use, not the Play
> Store). Android may warn that it's from an unknown developer — that's expected
> for a self-distributed app; tap through to install.

### Rebuild the APK

Requires a one-time toolchain: **JDK 21** and the **Android SDK** (cmdline-tools,
platform-tools, `platforms;android-35`, `build-tools;35.0.0`). With
`JAVA_HOME` pointing at JDK 21 and `android/local.properties` pointing at the SDK:

```bash
npm run android:apk
# -> android\app\build\outputs\apk\debug\app-debug.apk
```

`npm run android:apk` builds the web app, copies it into the Android project
(`cap copy`), and runs `gradlew assembleDebug`. Open the project in Android
Studio (`npx cap open android`) for a release/Play-Store (signed AAB) build.

## Run it (dev)

Requires **Node 20+** (not installed on the build machine — install from
<https://nodejs.org> first).

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build
npm run typecheck
```

## How it works (pipeline)

1. **Grid** — joist positions from spacing/offset; rows across the width, with the
   leftover strip handled per the chosen edge fit (rip a board / overhang / gap).
2. **Stage A — candidates** (`engine/candidates.ts`): per-row cut plans whose
   segments fit a stock plank and respect the min-piece rule.
3. **Stage B — stagger** (`engine/stagger.ts`): picks one candidate per row for
   the chosen mode (true random / random-with-rules / jittered brick / staggered
   / max scatter), enforcing min seam offset and avoiding alignment, staircases
   and periodicity. Seeded — stepping the seed changes the pattern.
4. **Stage C — cut stock** (`engine/cutstock.ts`): first-fit-decreasing packing
   with kerf and offcut reuse across all decks, drawing from **on-hand inventory
   first, then store** stock — producing a shopping list for the shortfall.
5. **Stats** — kerf loss, scrap, leftover, waste %, planks from inventory vs. to buy, cost.

## Structure

```
src/model/      types + defaults
src/engine/     rng · grid · candidates · stagger · cutstock · optimize  (pure, testable)
src/ui/         App (inputs) · DeckCanvas (SVG plan) · ZoomView · Results
src/platform/   save (native share sheet / browser download)
electron/       desktop main process          android/   Capacitor project
```

## Releasing

CI ([`.github/workflows/build.yml`](.github/workflows/build.yml)) builds the web,
Android, and Windows targets on every push. Pushing a version tag also publishes a
GitHub Release with the APK and Windows zip attached:

```bash
npm version patch        # bumps package.json + creates a vX.Y.Z tag
git push --follow-tags   # triggers the release build
```

## Status

MVP. Engine runs inline; Stage B is greedy + rules. Next: simulated annealing in a
Web Worker, and signed release builds (see DESIGN.md §9).
