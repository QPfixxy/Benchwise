# Benchwise user guide

For testers, and for whoever sets Benchwise up at a site.

## Running an audit

1. Start Benchwise on the unit. It scans the hardware automatically; check the **System Overview** against the physical machine.
2. Enter or scan the **asset tag** and your technician name or ID.
3. Work through the tests in the sidebar. Tests that don't apply to this unit are already marked N/A.
4. Open **Finish & Save**, review the results, add notes (cosmetic grade, missing parts), and save.

The CPU and memory stress tests run in the background. You can do other tests while they run, and their verdicts are recorded automatically when they finish.

## Intake during Windows setup (OOBE)

Run on a unit still at the Windows setup screens, Benchwise goes straight into **Intake checks** with no questions:

1. The **malware scan** starts in the background (it's the slow one, about 3 minutes).
2. The **MDM / Autopilot** check runs (30–60 seconds).
3. When both are done, the **Intake summary** shows one tile per check. Click a tile to open that test, for example to record your decision on a ghost profile.
4. **The report saves itself** when both checks have a result and it's going to the stick or your share. Otherwise, for example while a ghost profile waits for your decision, click **Save report**. Then **Shut down** or **Exit to Windows setup**. Auto-save can be turned off in Settings.

The switch at the top of the sidebar changes between **Intake checks** and the **Full audit**. Results are kept, so you can run the full hardware audit in the same session. The asset tag is optional: records are named and identified by the manufacturer serial. Turn on **Require an asset tag to save** in Settings if your shop wants one.

### The USB stick

Unzip the **`Benchwise-<version>-win-x64.zip`** release file into a `Benchwise` folder on a USB stick. In OOBE, press Shift+F10 and run:

```
D:\Benchwise\LAUNCH
```

(use the stick's drive letter). The launcher:
- joins Wi-Fi from a `wifi.xml` profile;
- waits for the network. If there's none, it offers to retry (e.g. after plugging in Ethernet), to install Wi-Fi drivers from a `WiFi_Drivers` folder, or to start anyway;
- connects your share;
- keeps settings and reports in `benchwise-data` on the stick, then starts Benchwise.

On a read-only disc, reports go to `C:\Users\Public\benchwise-data`, but that's the unit's own disk, so Benchwise warns you to copy them off before the unit is wiped, and doesn't auto-save there. Reports never go to Windows setup's temporary account, which is deleted when setup finishes.

Your site's details go in **`site.cmd`** next to `LAUNCH.CMD`: copy `site.example.cmd` and fill it in.
- **Wi-Fi name**, and the host that must answer before testing starts.
- **The share and its account**, used for saving reports and reading `KnownTenants.txt`. If the share can't be reached, the report is kept on the stick.

`site.cmd` holds passwords: keep it on your sticks only.

## Which tests apply

Benchwise only offers tests that make sense for the unit:

- **Unit type** comes from the firmware's chassis type (Notebook, Desktop, All in One, …), then the model name on Macs, then whether there's a battery.
  - **Desktops and servers:** the monitor and keyboard are peripherals, so Display and Keyboard are N/A.
  - **All-in-ones:** Keyboard is N/A.
  - **Tablets:** Keyboard is N/A.
  - **Laptops, and units whose type is unknown:** everything is tested.
- **Hardware the unit doesn't have** is N/A with the reason. Examples are a camera on a desktop, or touch on a non-touch model.
- **Hardware the unit should have but isn't detected**, such as a laptop camera, is flagged instead of skipped, so a dead module gets failed rather than hidden.
- **Phones (Continuity Camera), headsets, docks and virtual devices** are labelled and never treated as part of the unit.
- **A closed laptop lid** is detected, and you're warned that you may be testing external devices.

Every N/A can be overridden with **Run this test anyway**. If a unit's firmware reports the wrong type, start Benchwise with `BENCHWISE_FORM_FACTOR` set to `laptop`, `desktop`, `all-in-one`, `tablet` or `server`. The report shows the type as "set manually".

## Test details

| Test | How it works |
|---|---|
| Display | Full-screen black, white, RGB, gray and gradient patterns |
| Keyboard | Visual layout with presets: full-size, TKL, Windows laptop, Mac laptop. It auto-passes when every key registers and detects stuck keys. App shortcuts are disabled during the test, so Cmd+W, Alt, Tab etc. are safe to press. Fn and some OS-reserved keys never reach applications; check those by hand |
| Touchscreen | Grid coverage to find dead zones. Counts only touch and pen input, and records the most simultaneous touches |
| Camera | Live preview with a camera picker. Reports the actual resolution and frame rate |
| Microphone | 5-second raw recording without OS noise suppression, with a level meter, silence detection and playback |
| Speakers | Separate left and right tones, a frequency sweep, a music sample, and an output picker |
| USB Ports | See [USB port test](#usb-port-test) |
| Drive Health | See [Drive health](#drive-health) |
| MDM / Autopilot | See [MDM / Autopilot lock check](#mdm--autopilot-lock-check) (Windows setup only) |
| Malware Scan | See [Malware scan](#malware-scan) (Windows setup only) |
| CPU Stress | Every core runs integer, floating-point, cache and SHA-256 workloads with known answers, and one wrong answer fails the unit. Throughput is tracked in 5-second windows to detect thermal throttling. Temperature and clock are sampled where the OS allows. Profiles: 2, 10 or 30 minutes |
| Memory Test | Fills 50–80% of free RAM with 7 patterns: stuck bits, coupling, walking ones, address lines and random. Every chunk is written before any is verified, so data really goes through RAM. A mismatch fails with the address and the flipped bits. It's a user-space test: RAM reserved by the OS isn't covered, so use a bootable tester such as MemTest86 on suspect units |

### USB port test

Any USB flash drive with about 100 MB free can be a **test drive**. Prepare it once from the USB Ports page. This adds a `BENCHWISE-TEST-DRIVE` folder and a marker file, and nothing on the drive is erased. A USB 3 drive lets Benchwise tell USB 3 ports from USB 2 ports by speed.

Then plug the drive into each port in turn. For each port Benchwise records the physical port location, the negotiated link speed, the read and write speed, and a SHA-256 integrity check of a reference file. It then ejects the drive so you can move to the next port. The test passes when every expected port is verified, and any data corruption fails it. Keep the stick labelled as the bench test drive.

### Drive health

Opening the Drive Health page reads every drive's own health records (SMART) with `smartctl`, which ships inside Benchwise. It takes a few seconds per drive and sets the verdict automatically.

| Result | When |
|---|---|
| **Fail** | The drive's SMART self-assessment says failing; any pending or uncorrectable sectors; 100 or more reallocated sectors; an attribute below its failure threshold now; NVMe critical warnings, spare below threshold or media errors; rated write endurance used up; the last self-test failed |
| **Pass, with warnings** | Some reallocated sectors; 80% or more of rated endurance used; interface CRC errors (usually the cable); logged ATA errors; 70°C or hotter |
| **Pass** | None of the above |
| **No automatic verdict** | An internal drive couldn't be read (e.g. no administrator access): judge it and set the result by hand |
| **N/A** | The inventory found no internal drive (pulled drive) |

Each drive shows life remaining, power-on time, temperature, data written and power cycles, and all of it goes into the report. USB drives (including the USB test drive) are listed but not counted. If you suspect a drive the scan reports as healthy, a long self-test or a full surface scan is still the thorough check.

### MDM / Autopilot lock check

Checks whether a Windows unit is still registered to an organisation through Autopilot. It only runs during **Windows setup (OOBE)**: open a command prompt with Shift+F10 and start Benchwise from there. Everywhere else the test is N/A, because the answer can't be trusted.

1. **Connection check:** the unit must reach the internet and Microsoft's Autopilot, sign-in and device-registration services. If it can't, the result is **Can't verify** and there's no verdict, because a locked unit could look clean. Fix the network and press **Run check** again.
2. **Profile check:** for about 30 seconds, Benchwise watches for the Autopilot tenant that Windows downloads during setup. This is the proven logic from the intake toolkit.
3. **Safety nets:** a unit is only called Clean when Windows' own record of asking Microsoft says **"not registered"**, and that answer came during this boot. If any other Windows record shows a tenant, the result is a possible lock for you to check by hand, never Clean.

| Result | Meaning | Verdict |
|---|---|---|
| **Clean** | No Autopilot profile | Pass |
| **Locked** | Registered to a known client, or to a named domain. Send to salvage | Fail (can be changed in Settings) |
| **Ghost profile** | Only an unknown tenant ID, which isn't always a lock. Go through setup with Wi-Fi and see whether it forces a corporate sign-in | You decide |
| **Possible lock** | No tenant in the usual place, but another Windows record shows one, or Microsoft says the unit is registered with no profile yet. Check by hand, as for a ghost profile | You decide |
| **Clean, unconfirmed** | No tenant found, but there's no fresh "not registered" answer from Microsoft. Reconnect the network and run it again | You decide |
| **Can't verify** | Microsoft wasn't reachable | You decide, after fixing the network |

**Known tenants:** to show the client's name on a locked unit, point Settings at a `KnownTenants.txt` file (one `TenantId=Client name` per line), for example on your intake share. Otherwise Benchwise looks for `KnownTenants.txt` in its data folder (the USB stick in portable mode). It's client data, so keep it out of anything public.

### Malware scan

A Microsoft Defender scan of the installed Windows, run during **Windows setup (OOBE)** as part of intake. It runs in the background, so you can do other tests while it works.

1. Updates Defender's definitions. If the update fails, for example with no internet, the scan still runs and the report says the definitions were not updated.
2. Switches Defender to **audit-only mode**, so it takes no action on any threat level, and potentially unwanted apps are only audited. Nothing is removed; the evidence stays on the drive for the record until your wiping software erases it. Defender is left in this mode afterwards.
3. Runs a quick scan, which usually takes a few minutes.

**Results:** every detection in Defender's history is listed with its severity, location, and whether it came from this scan or earlier.
- **By default, a unit with threats still passes this test.** The threats are documented in the report, and the unit gets wiped and reinstalled anyway. Turn on **Malware found fails the audit** in Settings to fail it instead.
- **If Tamper Protection blocked audit mode,** the report says so, because Defender may then have quarantined what it found.

The Overview, and every report from Windows, also shows **TPM, Secure Boot and BitLocker** status.

## Administrator access

| OS | Behaviour |
|---|---|
| Windows | Asks for administrator (UAC) at every start. Windows hides *mapped* drive letters from administrator apps, so give a network reports folder as `\\server\share\…`, not `Z:\…` |
| Linux | Offers to restart as administrator (system password prompt). **Limited mode** still works, but serials, memory details and drive health may be missing. Started as root (e.g. from a live USB), it doesn't ask. Reports stay in your normal user folder, owned by you |
| macOS | Not needed |

## USB-stick (portable) mode

Create a folder named `benchwise-data` next to the executable; the Windows portable build does this automatically. Settings and reports are then kept on the stick, not on the machine being tested. To store them anywhere else, set `BENCHWISE_DATA_DIR`.

## Settings

The Settings page saves to `benchwise-settings.json` in the data folder.

- **Station name and default technician:** printed on every report.
- **Asset tag label and format:** what your shop calls its ID (e.g. "Lot #"), plus an optional regular expression the tag must match, e.g. `\d{7}-\d{7}`. Tags are always limited to characters that are safe in filenames.
- **Reports folder:** can be a network share, so every bench saves to one place.
- **Enabled tests:** turn off tests that never apply at a station.

## Reports

Each saved audit creates `<assetTag>_<YYYYMMDD-HHMMSS>.json` and a matching `.pdf` in the reports folder. Reports are never overwritten; re-auditing a unit creates a new pair. The **Reports** page lists, searches and opens them.

The JSON is a versioned record (`"schema": "qudit.audit"`, `"schemaVersion": 1`). It holds:

- the full hardware snapshot;
- every test result with its measured details;
- the technician, station, app version and timestamps;
- `hardware.diagnostics`: how long each hardware check took. If a unit scans slowly or incompletely, send this file with the bug report.

**No personal data:** reports leave the bench (shares, clients, reporting tools), so they don't record the Windows account name or the computer name. In malware findings, a user folder in a file location is replaced with `<user>`. They do record the unit's identity: serial, UUID and MAC addresses, plus the technician field you enter.
