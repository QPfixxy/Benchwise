# Benchwise servers: design

Benchwise keeps a durable, provable record of every unit it tests. Two kinds of server do that:

- **A site server at each facility** holds that facility's records, serves its benches and USB sticks, and makes the sticks.
- **One Hub** collects every site's records into one place for search, reporting and the WMS, and watches the health of every site.

The priorities, in order, are **redundancy, retention and scalability**, then **frictionless deployment**: servers are set up by the operations team through an installer and a browser wizard, with no Linux knowledge needed.

## The shape

```
                         ┌───────────────────────────────────┐
                         │ HUB  (company network)            │  every site's records (copy, verified)
                         │ PostgreSQL · admin · WMS API      │  users, policies, versions, site health
                         └─────────────────┬─────────────────┘
                     company network: sites call out over HTTPS (the Hub never calls in)
          ┌────────────────────────────────┼────────────────────────────────┐
┌─────────┴──────────┐           ┌─────────┴──────────┐           ┌─────────┴──────────┐
│ SITE SERVER  (DAL) │           │ SITE SERVER  (PHX) │           │ SITE SERVER  (…)   │   Ubuntu, or Windows
│ PostgreSQL         │           │                    │           │                    │   at smaller sites
│ original records   │           │                    │           │                    │
│ stick maker        │           │                    │           │                    │
└─────────┬──────────┘           └────────────────────┘           └────────────────────┘
          │ floor / test network (DHCP + internet, no company access)
   benches · USB sticks · units under test
```

Each site server sits between two networks, like the Aiken server does today:
- **Company side:** sends records and health reports up to the Hub; staff use its web interface.
- **Floor side:** benches and sticks upload records and download sticks and updates.

The site server never routes traffic between the two sides, so units that may carry malware never reach the company network. The installer checks that forwarding is off and binds each service to the right side.

## Roles

| | Site server (one per facility) | Hub (one, on the company network) |
|---|---|---|
| Database | PostgreSQL: **the original** records of this site, full history | PostgreSQL: a **verified copy** of every site's records |
| Receives | Reports from benches and sticks over the floor network | Records pushed by site servers |
| Works when the other is down | **Yes, fully.** Testing, saving, searching and stick-making carry on; records queue for the Hub | Yes; it shows which sites are behind |
| Users | A copy of the Hub's users (works offline from its last copy); a local admin for first setup and emergencies | Users, roles, site access. Later also sign-in with Entra ID / Active Directory |
| Integrations | Local search and CSV exports for the facility | **WMS and Tableau API** across all sites |
| Watches | Its own disk, database, queue | **Every site:** online, last record, records behind, parity, disk, version |
| Sticks | **Makes them** (see below) and serves Benchwise updates to them | Sets the approved Benchwise version and site policies |

A site server works on its own with no Hub at all. That's how the first deployment starts: one warehouse, alongside Aiken. A Hub can be added later and the site enrolled into it, with no change to the site.

## Getting records from sites to the Hub: push over the API, with proof of parity

Sites send their records to the Hub over HTTPS. Nothing else connects between buildings: there are no database connections or database credentials on the network, and the Hub never needs to reach into a site.

- **The site is the writer.** When a record is saved at a site, the site adds it to that site's **hash chain**: `hash = SHA-256(previous hash + record)`.
- **The site pushes records to the Hub in chain order.** The Hub accepts a record only if its previous hash equals the Hub's latest hash for that site, so a gap or a changed record is refused, not silently stored.
- **Parity is a single comparison.** Same latest hash and same count at both ends means identical copies. The site reports its head hash with every health report, and the Hub shows parity per site: green, behind by N, or **diverged**, which raises an alert.
- **Catching up is automatic.** After an outage the site sends its backlog in order; resending is harmless because uploads are idempotent.
- **Tampering shows.** Changing a record undetected would need both copies, and both chains, altered identically.

Settings flow the other way: site servers **pull** users, site policy (does a lock fail, does malware fail, known tenants, enabled tests) and the approved Benchwise version from the Hub, and keep the last copy for when the Hub is unreachable.

## Retention and redundancy

- **Two live copies of every record** (site and Hub), each with **nightly backups** kept 14 days locally. Copying backups off the server is recommended, for example to a NAS or the company backup system.
- **Retention:** sites keep everything by default; the Hub keeps at least **7 years**, which meets R2 and e-Stewards record-keeping. Records are append-only everywhere: a re-test is a new record, never an overwrite.
- **If the Hub is lost,** restore last night's backup and the sites re-send anything newer. **If a site server is lost,** restore its backup, then fill any gap from the Hub's copy.
- **Scale (upper end):** 9 facilities × 25 people × ~60 units a day ≈ **13,500 records a day**.

  | | Per year | 7 years at the Hub |
  |---|---|---|
  | Records | ~3.5–5 million | ~25–35 million |
  | Record data (JSON, ~10–15 KB each, compressed in the database) | ~50 GB | ~350 GB |
  | Report PDFs (~70 KB each) | ~250 GB | ~1.7 TB |

  The write rate (a record every few seconds) is easy. **Storage over years** is what's designed for:
  - **A narrow index table plus the full records in monthly partitions.**
    - The searchable table (one row per audit: serial, site, results, times) stays small enough to keep fast at tens of millions of rows.
    - The full JSON records live in a separate table **partitioned by month** and compressed (lz4).
    - Old months can be moved to cheaper storage, or dropped once past retention, without slowing anything else.
  - **No PDFs are stored on servers** (decided). Only records are kept, so the PDF row of the table above doesn't apply. See *Compliance exports* below.
  - **Each site server** handles about 1,500 records a day (~400,000 a year, a few GB of record data a year), comfortable for one modest VM.

## Compliance exports (PDF on demand)

Servers store records, never PDFs. When a PDF is needed for compliance (a client's lot, an audit, a dispute), the server **draws it from the stored record on request**:
- **One record:** a PDF from the record page, or `GET /api/v1/audits/{id}/report.pdf`.
- **Many records:** a ZIP of PDFs plus a CSV summary, for a date range, a site, or a list of serials.

The PDF is generated inside the server by a small PDF library, so it works the same on Ubuntu and Windows. It's always drawn from the hash-checked record, so an export can be traced back to the original. Benchwise still makes its own PDF on the bench or stick at the time of testing.

## Making USB sticks: both ways

The same stick-making code is used in both places:

1. **At the site server:** plug the stick into the server, then click **Make stick** in its web interface. This is how it's done today. It suits Windows site servers and accessible Ubuntu machines.
2. **From any PC, with the Stick Maker app:** a small desktop program, and the first piece of the future manager app. It connects to the facility's site server, signs in, and fetches the stick's setup.

Either way, the stick gets:
- Benchwise (the approved version) and `LAUNCH.CMD`;
- a `site.cmd` filled in with the floor Wi-Fi, the site server's floor address and its certificate fingerprint;
- **its own station key**, so each stick appears in the station list and a lost stick can be revoked alone.

## Deployment: installer plus browser wizard

| | Ubuntu (most site servers; the Hub) | Windows (smaller sites; optional Hub) |
|---|---|---|
| Install | One command, or a `.deb` package | **`Benchwise Site Setup.exe`** / **`Benchwise Hub Setup.exe`**: Next → Next → Finish |
| Bundled | PostgreSQL, Node.js 22, nginx (HTTPS) | PostgreSQL, Node.js 22; HTTPS served by Benchwise itself |
| Runs as | A sandboxed systemd service | A Windows service under a virtual service account |
| Then | **A browser setup wizard** (from any PC on the company network) | The same wizard; it opens by itself |

The wizard, by role:
- **Site server:** facility name and code; which network card is company and which is floor; certificate (self-signed or the company's); floor Wi-Fi details for sticks; a local admin. Optionally, **enroll with the Hub** by typing a pairing code shown in the Hub's admin page.
- **Hub:** organisation name, admin account, certificate, then create pairing codes for sites.

Upgrades: run the new installer, or approve a version at the Hub and the site servers update themselves (later phase). Command-line tools stay available for automation.

## Security

- **TLS everywhere.**
  - Self-signed certificates are pinned by fingerprint: sticks pin the site server; sites pin the Hub at enrollment.
  - Company certificates are supported when an internal certificate authority exists.
- **Keys:**
  - Station and site keys are random 256-bit values, stored only as hashes.
  - Each key is revocable and limited to its site.
  - Pairing codes are single-use and expire after 24 hours.
- **Staff sign-in:** scrypt passwords, sign-in rate limiting, `HttpOnly` / `Secure` / `SameSite=Strict` session cookies, CSRF header, and an admin log.
- **Input:** strict request validation (unknown fields rejected), parameterised queries only, and a strict Content Security Policy in the web interface.
- **Least privilege:**
  - The service runs sandboxed and unprivileged.
  - Database roles can't change the schema; records and the admin log are append-only, enforced by a trigger.
  - There's no routing between the floor and company networks.
- **No personal data in records** beyond the technician field.

## Build order

**Phase A: first deployment** (one warehouse, alongside Aiken, standalone)
1. Server roles: the existing server becomes the **site server**. Its interfaces are bound to the company and floor sides, and records are chained at the site.
2. **Ubuntu installer + setup wizard** for the site server.
3. **Stick making at the site server** (plug in, click), with per-stick station keys.
4. **Windows `Benchwise Site Setup.exe`.**

**Phase B: central records**
1. Hub role: pairing-code enrollment; chain-checked push from sites; parity and health dashboard.
2. Users and site policy synced from the Hub to sites.

**Phase C: later**
- The **Stick Maker / manager app** for lead PCs: records, exports, sticks.
- Sign-in with Entra ID and Active Directory.
- Fleet updates: the Hub serves approved Benchwise versions to sites and sticks.
- Webhooks and database views for the WMS if its integration needs them.
- A standby Hub, if nightly backups ever stop being enough.

## Status

- **Built and tested on Ubuntu (Phase A, step 1):**
  - The server core, now under `server/` (one codebase, site and hub roles):
    - records and per-site hash chain;
    - station API, search and export API, web interface;
    - users, keys, admin log.
  - The database for the 13,500/day scale: a narrow search table; full records in yearly lz4 partitions; batched chain verification; and a daily `maintain` job.
  - **Two-network mode:** staff side and floor side on separate addresses, with forwarding off, verified from outside. One-network mode for servers on a single network.
  - The Ubuntu installer (fresh install, upgrade and network switching tested).
  - Benchwise's outbox: records only (no PDFs), with fingerprint pinning.
  - Direct HTTPS for Windows.
  - **Compliance PDFs on demand:** one record, or a ZIP batch (date range, site or serial list, up to 5,000 records, logged), drawn from the stored record and never stored.
  - **Phase A step 2, the browser setup wizard:**
    - a one-time setup code;
    - facility, networks (picked from a list of network cards), certificate, floor Wi-Fi and admin;
    - network and certificate changes applied by a root-only helper (systemd path unit), which re-validates every request and rolls back if nginx refuses.
  - Tested by a fresh install on the Ubuntu VM, the wizard clicked through in a browser, and two networks applied and verified from outside.
  - **Floor Wi-Fi for sticks:**
    - set in the wizard, and editable later under Administration (write-only password, changes logged without it);
    - name, security type (WPA2/WPA3/open) and hidden flag;
    - turned into the Windows Wi-Fi profile the launcher loads;
    - stations fetch the current one, so sticks pick up changes.
  - **Phase A step 3, making USB sticks at the site server:**
    - the Benchwise build comes from the latest GitHub release (SHA-256 checked against GitHub's digest), or an uploaded `-win-x64.zip` (checked to be a stick build, with no unsafe paths);
    - Administration lists only removable drives, and never system disks or a drive the server booted from;
    - **Make stick** erases the drive (exFAT, label BENCHWISE) and writes Benchwise, `site.cmd` (server address, its own station key, fingerprint, Wi-Fi name), `wifi.xml` and a README;
    - the root helper checks the drive again before erasing (it must still be removable and non-system, with the same serial), and refuses, erasing nothing, a drive another program has open, naming that program;
    - a stick that fails leaves no working key: its station is revoked.
  - Tested on the Ubuntu VM with a real USB stick passed through: build fetched from GitHub, stick made in about 15 seconds, its key uploads, and a busy drive is refused.
- **Next:** Phase A step 4, the Windows site-server setup; then Phase B, the Hub role.
