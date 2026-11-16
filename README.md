# Benchwise

A lightweight hardware audit and test tool for **ITAD (IT asset disposition)**, refurb and resale teams. Run it on a unit and it reads the hardware, walks the tester through a repeatable set of functional tests, and saves the audit as a **PDF** for people and a **JSON record** for systems.

One desktop app for **Windows, macOS and Linux**. No server, no browser and no internet connection needed, and it runs straight off a USB stick.

*Formerly Qudit (renamed in 2.1). Existing settings, reports and USB test drives carry over automatically.*

## Download

Get the latest build from the [Releases](../../releases/latest) page:

| Platform | File |
|---|---|
| Windows 10/11 | `Benchwise-<version>-windows-portable.exe` (no install, runs from a USB stick) or `…-windows-setup.exe` |
| macOS (Apple Silicon / Intel) | `Benchwise-<version>-mac-arm64.dmg` / `…-mac-x64.dmg` |
| Linux (x64) | `Benchwise-<version>-linux-x86_64.AppImage` (`chmod +x`, then run) |

On Windows and Linux, Benchwise asks for administrator access at launch. Firmware serials, memory-module details and drive health need it. The sidebar shows **✓ Administrator** or **⚠ Limited mode**.

## What it checks

**Hardware inventory (automatic):** make, model and serial, unit type (laptop, desktop, all-in-one…), BIOS, CPU, every memory slot, storage with SMART status, GPUs and displays, battery health and cycle count, and network adapters with MAC addresses.

**Functional tests (each recorded as Pass, Fail or N/A, with notes):**

| Test | Checks |
|---|---|
| Display | Full-screen patterns for dead pixels, bleed and banding |
| Keyboard | Every key registers, no stuck keys (full-size, TKL and laptop layouts) |
| Touchscreen | Dead zones across a coverage grid; multi-touch count |
| Camera | Live preview, actual resolution and frame rate |
| Microphone | Raw recording with level meter and silence detection |
| Speakers | Left/right channels, frequency sweep, music sample |
| USB Ports | A prepared flash drive in each port: location, link speed, read/write speed, data integrity |
| CPU Stress | Every core runs workloads with known answers; one wrong answer fails the unit. Detects throttling |
| Memory Test | Seven bit patterns across free RAM; any mismatch fails with the failing address |

Only tests that apply are offered. A desktop's monitor and keyboard are peripherals, so those tests are recorded as N/A. A laptop whose camera isn't detected is flagged for a Fail, never skipped.

## Documentation

- **[User guide](docs/USER-GUIDE.md):** running tests, USB-stick mode, settings, network report folders, and the report format.
- **[Development](docs/DEVELOPMENT.md):** building from source, tests, and the code layout.
- **[Releasing](docs/RELEASING.md):** cutting a release and Mac signing setup.
- **[Roadmap](ROADMAP.md):** what's planned, including the Benchwise Hub site server.

## License

GPL-3.0. See [LICENSE](LICENSE).
