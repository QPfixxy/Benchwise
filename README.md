# Qudit

Qudit is an open-source, lightweight **ITAD (IT asset disposition) audit tool** for refurb and resale teams. It reads the hardware of the machine it runs on and walks a tester through a repeatable set of functional checks. Each audit is saved as a **PDF** for people and a **JSON record** for systems.

It runs as a single desktop app on **Windows, macOS and Linux**. It needs no server, no browser and no internet connection, and it can run straight off a USB stick.

## What it does

**Hardware inventory (automatic)**
- System make, model, serial (with firmware fallbacks and placeholder detection), chassis, BIOS, OS
- CPU model, core/thread counts (including P/E cores), base and max clock
- Memory: installed total, every slot including empty ones, type, speed, part numbers
- Storage: model, marketed capacity, type (NVMe/SSD/HDD), serial, SMART status
- Graphics: every GPU classified as integrated or dedicated, VRAM, displays
- Battery: **health** (full-charge vs design capacity), cycle count, charge
- Network adapters with burned-in MAC addresses; cameras, microphones, speakers

**Functional tests (operator-guided, each recorded as Pass / Fail / N/A with notes)**

Tests only run when they apply to the unit. A desktop with no camera, or a laptop without a touch digitizer, gets that test auto-recorded as N/A with the reason (the operator can still choose "Run anyway"). Hardware a unit *should* have but that isn't detected (e.g. a laptop camera) is never skipped; it's flagged so a dead module gets failed rather than hidden. Phones (Continuity Camera), headsets, docks and virtual devices are labelled and never treated as part of the unit. If a laptop's lid is closed, Qudit says so.

| Test | How it works |
|---|---|
| Display | Full-screen black/white/RGB/gray/gradient patterns for dead pixels, bleed, banding |
| Keyboard | Visual layout (presets for full-size, TKL, Windows laptop, Mac laptop); auto-passes when every key registers; detects stuck keys. App shortcuts are disabled during the test, so Cmd+W, Alt, Tab etc. can be pressed safely |
| Touchscreen | Grid coverage test to find dead zones; counts only touch/pen input; records max simultaneous touches |
| Camera | Live preview, camera picker, reports actual resolution and frame rate |
| Microphone | 5-second raw recording (no OS noise suppression), level meter, automatic silence detection, playback |
| Speakers | Separate left/right channel tones, frequency sweep, music sample, output device picker |
| USB Ports | Plug a **Qudit test drive** (any flash drive, prepared once in-app; nothing erased) into each port. Per port: physical location, negotiated link speed, uncached read and write speed, and a SHA-256 integrity check of a reference file. Then the drive is auto-ejected. Auto-passes when every expected port is verified; any data corruption fails it |
| CPU Stress | Every core runs integer, floating-point, cache and SHA-256 kernels with known answers; **one wrong answer fails the unit**. Throughput is tracked in 5 s windows to detect thermal throttling; temperature and clock are sampled where the OS exposes them. Profiles: 2 / 10 / 30 min |
| Memory Test | Fills 50–80% of free RAM with 7 patterns (stuck bits, coupling, walking ones, address lines, random), writes every chunk before verifying so data round-trips through DRAM; any mismatch fails with the offset and flipped bits |

Stress tests run in an isolated process, so a crash or out-of-memory can't take down the app. They **keep running while you do other tests**, and the verdict is recorded automatically when they finish.

## Quick start (development)

Requires Node.js 20+.

```bash
npm install
npm start
```

## Running on test machines

Download the build for the platform from the GitHub **Releases** page:

| Platform | File | Notes |
|---|---|---|
| Windows 10/11 | `Qudit-<version>-windows-portable.exe` | Runs from a USB stick, no install. `…-windows-setup.exe` installs it instead |
| macOS (Apple Silicon / Intel) | `Qudit-<version>-mac-arm64.dmg` / `…-mac-x64.dmg` | Signed and notarized when the signing secrets are set up (below); otherwise right-click the app → **Open** the first time |
| Linux (x64) | `Qudit-<version>-linux-x86_64.AppImage` | `chmod +x` it, then run. Also the basis for a live-USB image |

**Administrator access.** Firmware serials, memory-module details and drive health need admin rights on Windows and Linux:
- **Windows:** the app asks for administrator (UAC) every time it starts. Because Windows hides *mapped* drive letters from administrator apps, set a network reports folder as `\\server\share\…`, not `Z:\…`.
- **Linux:** the app offers to restart as administrator (system password prompt). Choosing "limited mode" still works, with those fields missing. Started as root (e.g. from a live USB), it doesn't ask. Reports stay in your normal user folder and owned by you.
- **macOS:** no administrator access needed.

The sidebar shows **✓ Administrator** or **⚠ Limited mode**, so a tester can tell at a glance.

**Portable / USB-stick mode:** create a folder named `qudit-data` next to the executable (the Windows portable build does this automatically). Settings and reports are then kept in that folder instead of the machine's user profile. This lets you carry one stick between machines without leaving files behind. You can also set `QUDIT_DATA_DIR` to any path.

### Making a release

1. Bump `version` in `package.json` and commit.
2. Tag and push: `git tag v2.0.0 && git push origin v2.0.0`
3. The **Release** workflow builds all three platforms, smoke-tests each packaged app on its own OS, and attaches the files to a **draft** release on GitHub. Review it, then click **Publish**.

To build locally instead: `npm run dist:win`, `npm run dist:mac` or `npm run dist:linux` (output in `dist/`). Each platform is best built on its own OS.

### Mac signing and notarization (one-time setup)

Without this, the Mac build is self-signed and testers must right-click → Open the first time. With it, the app opens normally on any Mac. You need a paid Apple Developer account with the **Account Holder** or **Admin** role.

1. **Create a Developer ID certificate.** In Xcode → Settings → Accounts → select your team → **Manage Certificates** → **+** → **Developer ID Application**. (An "Apple Development" certificate won't work: it's only trusted for apps you run yourself.)
2. **Export it.** In Keychain Access → *My Certificates*, right-click **Developer ID Application: …** → Export → save as `.p12` with a password. Then copy it as base64: `base64 -i DeveloperID.p12 | pbcopy`
3. **Create a notarization API key.** In [App Store Connect](https://appstoreconnect.apple.com) → Users and Access → Integrations → App Store Connect API → Team Keys → **+**, with *Developer* access. Download the `AuthKey_XXXXXX.p8` file (it can only be downloaded once) and note the **Key ID** and **Issuer ID**.
4. **Add five repository secrets** in GitHub → repo Settings → Secrets and variables → Actions:

   | Secret | Value |
   |---|---|
   | `MAC_CERT_P12_BASE64` | the base64 text from step 2 |
   | `MAC_CERT_PASSWORD` | the `.p12` password |
   | `APPLE_API_KEY_P8` | the full contents of the `.p8` file |
   | `APPLE_API_KEY_ID` | the Key ID |
   | `APPLE_API_ISSUER` | the Issuer ID |

5. Run **Actions → Release → Run workflow**. The *Verify Mac signature* step should show your Developer ID and `source=Notarized Developer ID`. Notarization adds a few minutes per Mac build.

Local Mac builds without the certificate: `npm run dist:mac:unsigned`.

## Settings

Found on the Settings page and stored in `qudit-settings.json` in the data folder.

- **Station name / default technician:** printed on every report.
- **Asset tag label and format:** name your internal ID (e.g. "Regency Serial") and optionally enforce a format with a regular expression. For example, `\d{7}-\d{7}` was the original Qudit format. Tags are always restricted to filename-safe characters.
- **Reports folder:** can point at a network share so every bench saves to one place.
- **Enabled tests:** turn off tests that never apply at a station.

## Reports

Each saved audit produces `<assetTag>_<YYYYMMDD-HHMMSS>.json` and `.pdf` in the reports folder. Reports are never overwritten. Re-auditing a unit creates a new pair.

The JSON is a versioned record (`"schema": "qudit.audit", "schemaVersion": 1`) containing the full hardware snapshot, every test result with measured details, and the technician, station, app version and timestamps. It is meant to be ingested by a central server or spreadsheet later.

## Development

```bash
npm test            # unit tests (hardware normalization, report store, PDF escaping)
npm run smoke       # headless: real hardware scan on this machine + JSON/PDF report
npm run check:ui    # hidden window: renders every page, saves a report through the UI,
                    # fails on any console error, writes screenshots to out/ui-check
```

CI runs all three on Windows, macOS and Linux and uploads the generated PDFs and screenshots as build artifacts.

```
src/
  main/                 Electron main process (Node)
    main.js             window, app:// protocol, IPC, permissions, smoke/UI checks
    preload.js          the only bridge to the UI (window.qudit API)
    settings.js         settings + data-folder resolution (portable mode)
    hardware/
      collect.js        runs all probes in parallel, OS fallbacks (no shell)
      normalize.js      pure functions: raw data -> report schema (unit-tested)
    reports/
      store.js          audit record building, atomic save, listing
      template.js       PDF report HTML (all values escaped, QR codes local)
  renderer/             UI (plain ES modules, no framework, no CDN)
    app.js              session state, routing, sidebar
    views/              overview, finish, reports, settings
    tests/              one module per functional test
test/                   node:test unit tests
scripts/electron.js     launcher (clears ELECTRON_RUN_AS_NODE set by VS Code)
```

See [ROADMAP.md](ROADMAP.md) for planned work (stress tests, deeper port detection, central server).

## License

GPL-3.0. See [LICENSE](LICENSE).
