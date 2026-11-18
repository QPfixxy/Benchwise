# Benchwise Roadmap

Benchwise (then called Qudit) 2.0 replaced the local web server with a desktop app. It also fixed the inventory data and made every functional test produce a recorded result. This document is the plan for what is still missing. It covers the former placeholders (stress tests, port detection, the Tools page) and the features that turn Benchwise from a bench tool into a shop-wide system.

Guiding rules for everything below:

1. **Measured over judged.** Where a machine can decide pass/fail objectively, it should. The operator confirms, and their verdict is recorded alongside the measurement.
2. **Same procedure every time.** Durations, thresholds and test order come from a profile, not from whoever is at the bench.
3. **Non-destructive by default.** Nothing writes to a customer drive or changes firmware unless a profile explicitly allows it.
4. **Every result is data.** New tests add fields to the JSON record (bumping `schemaVersion` when the shape changes), not just lines in the PDF.

---

## Phase 1: Stress and stability tests (replaces the old fake "Hardware" page)

The old page returned `Math.random()`. The real versions share one architecture:

- **Runner:** each stress test runs in an Electron `utilityProcess`, so a crash or hang can't freeze or kill the UI. The runner streams progress over a `MessagePort` and can be cancelled.
- **Profiles:** "Quick (2 min)", "Standard (10 min)" and "Burn-in (30+ min)" set durations and thresholds.
- **Telemetry:** a sampler records temperature, clock speed and load every second where the OS exposes them. It stores a downsampled series in the report, so throttling is visible after the fact.

| Test | Method | Pass criteria | Notes |
|---|---|---|---|
| ✅ **CPU** (done) | One worker per logical core running deterministic integer and floating-point workloads (hash chains, sieve, matrix math) with known answers | No computation mismatches, no crash; clock stays above a % of base under load; temp below threshold | Silent computation errors are the real signal of bad CPU/VRM/cooling. `si.cpuTemperature()` works on Linux and some Windows machines; Apple Silicon needs `powermetrics` (root) or none |
| ✅ **Memory** (done) | Allocate a configurable % of free RAM in chunks and run pattern passes: walking ones/zeros, address-in-address, seeded random. Verify every pass | Zero mismatches | A user-space test can't reach memory the OS reserves. The report says so and recommends MemTest86 (bootable) for full coverage on suspect units |
| **Storage health** | Bundle `smartctl` (smartmontools, GPL-2) per OS; read SMART/NVMe health logs | No reallocated/pending sectors above threshold; NVMe "percentage used" and spare above threshold; overall SMART PASSED | Needs admin/root. Adds power-on hours and SSD wear to the inventory, which buyers ask about |
| **Storage performance** | Sequential and random read/write on a temporary file in free space, verified by checksum, then deleted | Throughput above the profile minimum for the drive type; no verify errors | Non-destructive. A raw-device read scan is an opt-in variant (needs admin) |
| **GPU** | WebGPU/WebGL2 render loop full-screen for N minutes; periodically render a fixed reference frame, read pixels back, and compare to the first frame's hash | No frame mismatches (artifacting), no context loss, stable FPS | Uses the same bundled Chromium on every OS, so results are comparable |
| **Battery** | Run a fixed load for 5–10 min while sampling capacity; then prompt to plug and unplug the charger | Measured discharge rate gives estimated runtime; charging is detected on plug-in | Confirms the AC adapter and charging circuit as well as health |

**Deliverable order:** ~~runner and telemetry framework → CPU → memory~~ (done) → SMART (in progress, `feature/drive-health`) → storage performance → GPU → battery.

The framework (isolated host process, worker threads, telemetry sampler, profile-driven verdicts in `src/main/stress/`) is in place. New stress tests add a worker script, a verdict function and a renderer page that calls `mountStress`.

## Phase 2: Smarter port and peripheral tests

| Item | Plan |
|---|---|
| ~~**USB ports by physical location**~~ | **Done (2.0):** test-drive port test with location ID, link speed, throughput and integrity check. Next: ask whether each port is USB 2 or 3 and fail a USB 3 port that only links at USB 2; on Windows, read link speed from the USB driver stack (only throughput is available there today) |
| **Speaker → mic loopback** | Play a tone sequence (left, right, specific frequencies) and detect it through the built-in mic with an FFT. This gives an automatic objective pass for both speakers and mic, with the operator listening only for rattle |
| **Camera auto-check** | Analyze frames for all-black, frozen or single-color output and require variance when the lens is uncovered. Catches dead sensors automatically |
| **Video outputs** | Prompt "connect a monitor to each video port"; Electron `screen` `display-added` events log each port (HDMI/DP/USB-C alt mode) |
| **Ethernet** | Prompt for a cable; watch `operstate` and link speed change on the wired adapter |
| **Wi-Fi / Bluetooth** | `si.wifiNetworks()` must see ≥1 network; Bluetooth scan via Web Bluetooth or the OS |
| **SD card reader** | Detect a new removable block device appearing (`si.blockDevices()` diff) |
| **Trackpad / mouse** | Coverage of the pointer area, left/right/middle click, two-finger scroll, all recorded |
| **Manual checklist items** | Hinge, lid sensor, keyboard backlight, fans, chassis damage: configurable yes/no items so they're in the record |

## Phase 3: Workflow

- **Test profiles by device type:** Laptop, Desktop, All-in-one, Mac and Tablet profiles, auto-selected from chassis type. Each test is required or optional per profile; "Finish" can be blocked until required tests are done.
- **Cosmetic grading:** a configurable A/B/C/D checklist (lid, palm rest, screen, bezel) stored as structured data.
- **Sanitization record:** fields for wipe method (NIST 800-88 Clear/Purge), tool, verification result and operator, for a certificate of sanitization. Benchwise records these; it doesn't perform wipes, at least initially.
- **Label printing:** print an asset label with QR code to a thermal label printer at save time.
- **Tools page, done properly:** a configurable list of links and commands in Settings (internal portals, vendor warranty lookup by serial, BIOS update pages).
- **Barcode-first entry:** the asset tag field already accepts a scanner with Enter. Add an optional second scan to verify the serial sticker matches the firmware serial.

## Phase 4: Central server (reports are already shaped for this)

1. **Outbox sync:** each saved JSON is also queued in an `outbox/` folder. A background task POSTs it to a configurable endpoint with an API key, retries while offline, and marks it sent. Local saving never depends on the network.
2. **Server:** a small service that validates `qudit.audit` records by schema version and stores them in a database. It serves a dashboard: search by asset tag or serial, fail rates by model, technician throughput, and units awaiting retest.
3. **Station config from the server:** profiles, asset tag format and enabled tests are pulled centrally, so every bench runs the same procedure.

Phase 4 is the groundwork for the Benchwise Hub (3.0) below: the outbox and the versioned `qudit.audit` records are what the Hub ingests.

## Phase 5: Distribution and quality

- **Code signing:** Windows (avoids SmartScreen warnings) and macOS notarization (needed for camera/mic permission prompts on distributed builds).
- **Bootable Benchwise:** see [Bootable Benchwise](#bootable-benchwise-near-term) below.
- **Hardware fixtures:** add `--dump-raw` to save unprocessed `systeminformation` output from real machines into `test/fixtures/`. Every odd machine you meet becomes a regression test for `normalize.js`.
- **Linting/types:** ESLint plus `tsc --checkJs` with JSDoc types on the main process.
- **Updates:** optional `electron-updater`, off by default for offline benches.

## Intake checks: MDM / Autopilot lock and malware (Windows), in progress

Brings in the OOBE intake gate from the separate `benchwise-intake` project. Work happens on the `feature/intake-checks` branch and is merged to `main` only once it has been proven on real units. Its PowerShell checks (v1) are proven in production during Windows setup (OOBE, opened with Shift+F10), and v1 stays in production until this is ready. Benchwise is confirmed to launch in OOBE as Administrator, read the hardware and record audio (tested in a VM).

**Verified in a Windows 11 OOBE VM so far:**
- OOBE detection: on Windows 11 the setup registry flags are already 0 on the setup screens, so OOBE is detected by Windows' temporary setup account (`defaultuser0`).
- The full MDM check: a Microsoft-confirmed Clean in 29 seconds.
- The Defender scan: definitions updated and a quick scan in about 3 minutes. Tamper Protection blocked audit mode in the VM.

**Step 3 is built:** the Intake profile, an optional asset tag, the stick launcher (`LAUNCH.CMD` with `site.cmd`), saving to the stick or share, and the Shut down / Exit buttons. Intake reports **save themselves** when both checks have a result and the report goes to the stick or a share. The launcher was tested in the OOBE VM.

**Still needs real hardware:** a locked unit, a ghost-profile unit, and Defender audit mode.

**Build order:**
1. Environment detection and the MDM / Autopilot test.
2. The Defender malware scan.
3. The Intake profile, and `boot.cmd` launching Benchwise in OOBE.

**MDM / Autopilot test.** It ports v1's detection logic exactly and is offered only when Benchwise is running in OOBE. Anywhere else it reads "run during Windows setup".
- **Network gate:** before checking, it must reach `8.8.8.8` plus Microsoft's Autopilot, sign-in and device-registration services, with 4 tries. If it can't, the result is "Can't verify: fix the network and retry", with no verdict, because a locked unit could otherwise look clean.
- **Detection:** it polls the Autopilot `TenantId` registry values for about 30 seconds, exactly as v1 does.
- **Safety nets on top of v1,** which can only make a result more cautious:
  - The registry must be readable, and is always read in its 64-bit view.
  - Any other sign of a tenant (`CloudAssigned*`, `ProfileAvailable`, the cached Autopilot profile, forced enrollment, or Microsoft's "registered, no profile assigned" answer) makes it a **possible lock**, checked by hand.
  - **Clean is confirmed** only by Microsoft's own "not registered" answer (807) from this boot, read from Windows' Autopilot policy cache. Without it, the result is "clean, unconfirmed" with no verdict.
- **Results:**
  - **Clean** (Pass): no tenant.
  - **Locked** (Fail by default): the tenant is in the known-tenants list, or is a domain. It shows "Locked to <tenant>: send to salvage". Whether Locked fails the audit will become a site setting, because other organisations treat it differently.
  - **Ghost Profile** (no automatic verdict): only an unknown tenant ID. The tech checks by hand by running the setup process with Wi-Fi to see whether it forces a corporate sign-in, because a ghost profile isn't always a lock.
- **Known tenants:** read from a `KnownTenants.txt` (`GUID=Name`) on the share or stick until the Hub serves it. Tenant names are client data and never go into this repository.

**Malware scan test.** It ports v1's Defender audit and runs in the background, like the stress tests.
- It **always updates definitions first**, then sets Defender to audit mode (PUA audit, and "no action" for every threat level) and runs a **quick scan**.
- **Report only:** nothing is removed, and the settings stay in audit mode afterwards, as in v1. Units are wiped by separate software before Windows is reinstalled.
- Any detection in Defender's history counts as infected, as in v1. The report separates new and older detections, and records the file count, duration, engine and definition versions, and whether Tamper Protection blocked audit mode.
- An infected unit is **recorded, not failed**, by default. This will also become a site setting.

**Also in scope:**
- **Security inventory (Windows):** TPM, Secure Boot, BitLocker status and the Defender version.
- **Environment detection:** the scan records where Benchwise is running (OOBE, audit mode, full Windows, live USB) and which Windows installs and drives it found.
- **Intake profile:** identity, MDM and malware only. Benchwise opens straight into it in OOBE, and the full audit can still be run in the same session. When done, the tech can shut down or exit back to OOBE.
- **Asset tag becomes optional** (possibly removed). Records are keyed on the manufacturer serial, ready for integration with Tableau and other reporting tools.
- **Results:** saved to the stick and copied to the intake server's share until the Hub exists. The intake server learns to read Benchwise records, so there is one format.
- **USB sticks carry the unpacked app folder**, for fast starts.

**Standalone or networked:** Benchwise must work on its own, and as part of a facility. When networked, it reads its settings from the server before testing (verdict rules, known tenants, enabled tests). **Real production deployment waits for the central server (Hub).**

## Bootable Benchwise (near term)

Boot any unit from a USB stick, with or without a working OS or a drive.

- A minimal Linux live image that autostarts the Benchwise AppImage as root: full DMI and SMART access, hardware and functional tests, and drive health.
- It detects whether a drive is present, whether Windows is installed on it, and whether it's BitLocker-encrypted.
- Reports are saved to the stick (portable mode) or synced to the Hub.
- No MDM check here: that needs Windows setup to contact Microsoft. See below.

## Future: MDM check for units without a drive or Windows

A locked unit stays locked with its drive removed, because Autopilot registration follows the hardware. Two candidate approaches, in order of preference:

1. **Portable OOBE:** a USB SSD holding a generalized Windows that always boots into setup (OOBE). The unit then downloads its own Autopilot profile through Windows' normal, supported process, and the existing MDM test runs unchanged. To test first: does Autopilot still recognize the unit when Windows runs from an external disk? One known-locked unit with its drive pulled answers it.
2. **Hardware hash lookup (research only):** compute the Windows hardware hash and query Microsoft directly, as commercial tools such as BitRaser and D-Secure appear to do. The service involved isn't documented for third-party use, so this is fragile and a poor fit for an open-source project.

## 3.0 and later: Benchwise Hub (site server)

A self-hosted server for a site, quick to deploy, that every bench and Benchwise USB stick connects to. The goals are one source of truth for every unit tested, no stale copies of the app on the floor, and proof that every unit went through the full procedure.

**Deployment: up in minutes on hardware you already have**
- Ships as a single Docker image *and* as a bootable installer (USB/ISO) that turns a spare desktop, mini PC or VM into a dedicated Hub appliance. No database or web server to configure by hand.
- First-run setup in the browser: site name, admin account, storage location. Sensible defaults for everything else.
- Runs fully on the local network with no internet dependency. Backups go to a second disk, a NAS or an off-site target.
- Benches find it automatically on the LAN (mDNS/zero-config), with a manual address as a fallback.

**Connection and enrollment**
- Stations and USB sticks are enrolled with a short pairing code shown on the Hub. Each gets its own revocable key.
- All traffic is encrypted (TLS with a Hub-generated certificate that stations pin at enrollment).
- Live station view: which benches are online, what version they run, who is logged in, what unit is on the bench.

**Central records: every test recorded**
- Every audit (JSON + PDF) syncs to the Hub through the station outbox. Benches keep working offline and catch up when reconnected.
- Records are append-only and hash-chained, so edits and deletions are visible. Re-tests are linked to the original audit, not overwritten.
- Completeness checks: units seen but never fully tested, incomplete audits, failed units awaiting retest, and gaps against an imported intake list or lot manifest.
- Search and dashboard: serial, asset tag, lot, model, technician, MDM and malware results, fail rates, throughput. Integration with reporting tools such as Tableau. CSV/JSON export, and an API for an ERP or inventory system.
- Optional SMB/network-share view of reports for teams and tools that expect a plain folder.

**Log and diagnostics sync**
- Station app logs, crash reports and raw hardware dumps (`--dump-raw`) upload to the Hub. Problems on one bench can be diagnosed from the office, and odd machines become regression fixtures.

**Fleet updates for benches and USB sticks**
- The Hub hosts approved Benchwise releases. Stations update from it, never straight from the internet, so a site can pin, stage or roll back a version.
- Plugging a Benchwise USB stick (portable app or live-USB image) into any enrolled station or the Hub checks it and brings it up to the approved version: app, test profiles and settings. The stick's version is recorded in every audit it produces.
- Pushes test profiles, asset tag rules and enabled tests to every bench, so the whole site runs the same procedure.

**Site policy and intake data**
- Verdict rules per site: whether an MDM/Autopilot lock fails the audit, and whether malware fails it or is only recorded.
- The known-tenants list (tenant ID to client name), served to stations and never stored in the app or the repository.
- Benchwise fetches these settings before testing when it's networked, and uses its local defaults when standalone.
- Imports the old intake history from a CSV upload when wanted, using the importer logic from `benchwise-intake`.

**Later**
- Multi-site: several Hubs reporting to one organization view.
- Roles and permissions (technician, lead, auditor, admin), and audit-ready exports for certifications (e.g. R2/e-Stewards evidence).

---

### Known limitations today

- Fn keys and some OS-reserved keys (Win, Cmd+Tab, PrintScreen on Windows) never reach applications. The keyboard test asks the operator to exclude them and verify by hand.
- On Windows the USB port test has no negotiated link speed (throughput only), and physical port locations are best-effort. These paths are unit-tested but haven't been verified on real Windows hardware yet.
- SMART status depends on the OS: unavailable on Linux without `smartmontools` and limited on some Windows drivers (fixed by bundling `smartctl` in Phase 1).
- CPU temperature isn't available on Apple Silicon without root (`powermetrics`), and on many Windows machines without a vendor driver; the CPU test shows "n/a" there and relies on throughput-based throttle detection.
- macOS CPU base clock is reported as the OS exposes it, which isn't always the marketed number on Apple Silicon.
