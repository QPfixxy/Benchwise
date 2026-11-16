# Developing Benchwise

## Setup

Requires Node.js 20 or later.

```bash
npm install
npm start
```

Always start Electron through `npm start` (`scripts/electron.js`). VS Code sets `ELECTRON_RUN_AS_NODE`, which makes Electron run as plain Node, and the launcher clears it.

## Checks

```bash
npm test            # unit tests: normalization, applicability, reports, ports, stress, settings
npm run smoke       # headless: real hardware scan on this machine plus a JSON/PDF report
npm run check:ui    # hidden window: visits every page, runs short CPU/memory stress tests,
                    # saves a report through the UI, fails on any console error,
                    # and writes screenshots to out/ui-check
```

CI runs all three on Windows, macOS and Linux and uploads the reports and screenshots as build artifacts. CI machines report a Desktop chassis, so the UI check presses "Run this test anyway" on the Keyboard and Display pages.

To check behaviour as another unit type, set `BENCHWISE_FORM_FACTOR` (e.g. `desktop`). To keep test runs out of your real settings and reports, set `BENCHWISE_DATA_DIR`.

## Architecture

- **Main process (Node):** scans the hardware, saves reports and starts the stress tests.
- **Renderer:** the UI, in plain ES modules with no framework. It's sandboxed, and only reaches the system through the small API in `preload.js`.
- **Work that might block runs off the main thread:**
  - Each hardware probe has its own worker thread.
  - Stress tests run in a separate utility process.
  - CPU telemetry has its own worker.

  The OS commands behind `systeminformation` are often synchronous and can be slow on some firmware. Kept off the main thread, they can only delay their own result.

```
src/
  main/
    main.js               window, app:// protocol, IPC, permissions, smoke/UI checks
    preload.js            the only bridge to the UI (window.benchwise)
    settings.js           settings and data-folder resolution (portable mode, Qudit migration)
    elevation.js          admin detection; Linux pkexec relaunch
    hardware/
      collect.js          probe pool, timeouts, timings, direct NIC reads, fallbacks
      probe-worker.js     runs one systeminformation probe on its own thread
      normalize.js        pure functions: raw data -> report schema (incl. unit type)
      usbtree.js          per-OS USB tree with port locations and link speeds
    ports/
      testdrive.js        test-drive prep, read/write benchmark, port watcher, eject
    stress/
      manager.js          runs one stress test at a time; turns results into a verdict
      host.js             utility process; runs the CPU/memory workers
      kernels.js          deterministic CPU workloads (answers in golden.json)
      memory-patterns.js  memory test patterns
      verdict.js          pure pass/fail rules and profiles
      telemetry*.js       temperature/clock sampling on a worker
    reports/
      store.js            audit record building, atomic save, listing
      template.js         PDF report HTML (all values escaped, QR codes generated locally)
  renderer/
    app.js                session state, routing, sidebar
    applicability.js      which tests apply to this unit
    devices.js            built-in vs external/phone/virtual devices
    views/                overview, finish, reports, settings
    tests/                one module per functional test
test/                     node:test unit tests
build/                    icons (SVG sources and PNGs) and Mac entitlements
```

Worker and utility-process scripts must be real files on disk in a packaged app. They're listed under `asarUnpack` in `package.json`, and their paths are rewritten to `app.asar.unpacked`.
