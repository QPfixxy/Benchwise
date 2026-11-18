# Benchwise Hub: design

The Hub is the central record for every unit Benchwise tests: benches and USB sticks send their reports to it, people search and review them in a browser, and other systems (a WMS, Tableau) pull them through an API. It's the gate for production use of Benchwise.

This document covers the first version and the decisions behind it. Later phases are listed at the end so the first version doesn't block them.

## Decisions

| | Decision | Why |
|---|---|---|
| Code | `hub/` in the Benchwise repository, its own `package.json` | One record format shared by app and Hub, versioned together. The Hub is never bundled into the desktop app |
| Runtime | Node.js 22 LTS | Same language as Benchwise |
| Web framework | Fastify | Schema validation on every request, mature, fast |
| Database | PostgreSQL 16 | What the company already runs; scales to many facilities; JSONB for the full record |
| Report PDFs | Files on disk, named by SHA-256 | Keeps the database small; easy to back up; can move to object storage later |
| Deployment | Native Ubuntu Server (22.04 / 24.04) with an install script, systemd and nginx | Matches how the company runs servers. No Docker required |
| Shape | One central Hub; each facility is a **site** inside it | One place to search across facilities. Per-facility Hubs that sync upward can come later on the same API |

## Architecture

```
 Benchwise (bench / USB stick)             Browser (staff)        WMS / Tableau
        | HTTPS, station key                     | HTTPS, session        | HTTPS, API client key
        v                                        v                       v
   +-------------------------------- nginx (TLS) --------------------------------+
                                           |
                              Benchwise Hub (Node, systemd, 127.0.0.1)
                                  |                         |
                           PostgreSQL                /var/lib/benchwise-hub/files
                     (records, sites, users)              (report PDFs)
```

- **One API for everything.** The web interface is a static page that uses the same JSON API as integrations, so anything staff can see, a WMS can fetch.
- The service listens on localhost only; nginx terminates TLS in front of it.

## Data model

| Table | Holds |
|---|---|
| `sites` | Facilities: code, name, time zone |
| `stations` | A bench or stick enrolled at a site: name, key hash, last seen, app version, revoked |
| `audits` | One row per saved report: identity columns for searching, the full record as JSONB, the PDF's hash, and the tamper-evidence chain |
| `users` | Staff accounts: role (`admin`, `lead`, `viewer`) and the sites they can see |
| `sessions` | Web sign-ins |
| `api_clients` | Integration keys (WMS, Tableau): scopes and allowed sites |
| `admin_log` | Every administrative change: who, what, when |

**Audits are append-only.** A re-test is a new row, never an overwrite. The database role the app uses can't update or delete audit rows, and a trigger enforces it. Each audit row stores `hash = SHA-256(previous hash in that site + the canonical record)`. Altering or removing a row breaks the chain, and the Hub can verify the chain on demand.

**Searchable columns** are copied out of the record when it arrives:
- serial, UUID, asset tag;
- manufacturer, model, profile (intake / full), overall result;
- MDM result and malware result;
- technician, completed and received times;
- site and station.

Everything else stays in the JSONB record, so new Benchwise fields arrive without a database change.

## API (v1)

All endpoints are under `/api/v1`, JSON, documented as OpenAPI in `hub/openapi.yaml`.

| Who | Endpoint | What |
|---|---|---|
| Station | `POST /audits` | Upload one report (record + optional PDF). **Idempotent** on the record's `id`: resending is safe and returns the existing result |
| Station | `GET /station` | Checks the key and returns the station and site (used by Benchwise's "Test connection") |
| Integration, staff | `GET /audits?serial=&site=&overall=&profile=&since=&cursor=` | Search and **incremental export**: a WMS pulls everything since its last cursor |
| Integration, staff | `GET /audits/{id}`, `GET /audits/{id}/pdf` | One record, its PDF |
| Integration, staff | `GET /units/{serial}` | A unit's latest result and history |
| Integration, staff | `GET /audits.csv?…` | CSV export of a search |
| Admin | sites, stations, users, API clients | Create, list, revoke. A new key is shown **once** |

## Benchwise side: the outbox

- Every saved report is also queued in `<data folder>/outbox`. A background sender posts it to the Hub, retrying with back-off while offline, and moves it to `sent` on success.
- **Saving locally never waits for the network.** A unit can be tested and shut down with the Hub unreachable; the stick catches up later.
- Configuration: Hub address and station key in Settings, or `BENCHWISE_HUB_URL` / `BENCHWISE_HUB_KEY` in the stick's `site.cmd`. With a self-signed Hub certificate, `BENCHWISE_HUB_FINGERPRINT` pins it.

## Security

- **TLS everywhere.** The installer makes a self-signed certificate if none is supplied, and stations can pin it. Support for the company's own certificates is built in. HTTP only redirects.
- **The service runs as an unprivileged system user**, listens on localhost, and runs under a systemd sandbox (no new privileges, read-only system, private temp).
- **Keys:**
  - Station and integration keys are random 256-bit values, stored only as SHA-256 hashes.
  - Keys are revocable, and each is limited to its site(s) and scopes.
  - A short prefix is kept so a key can be identified without storing it.
- **Passwords and sign-in:**
  - Passwords are hashed with scrypt.
  - Sessions use `HttpOnly`, `Secure`, `SameSite=Strict` cookies.
  - Sign-in and key checks are rate-limited.
  - Admin actions are logged.
- **Input:**
  - Every request is validated against a schema, with size limits on uploads.
  - Queries are parameterised only.
  - The web interface escapes all data and sends a strict Content Security Policy.
- **Least privilege in the database:** the app's role can't change the schema, update audits or delete them.
- **Secrets:** in `/etc/benchwise-hub/hub.env` (mode 0640), never in the repository.
- **Records hold no personal data** beyond the technician field, as in Benchwise.

## Scale

- Indexes on serial, UUID, site + completed time, and overall result. A GIN index on the record allows ad-hoc queries.
- The app keeps no state between requests, so more instances can run behind a load balancer when one isn't enough.
- **Tens of thousands of units a month per facility** is comfortable on one modest VM. If needed later, `audits` can be partitioned by month without changing the API.
- PDF storage goes through one small module, so object storage (S3-compatible) can replace the file system later.

## Install and operations

- `hub/deploy/install.sh` on a fresh Ubuntu server:
  - installs PostgreSQL and Node.js;
  - creates the system user, database, roles and folders;
  - sets up nginx with TLS and the systemd service;
  - creates the first admin account.
- Safe to run again for upgrades: database migrations run in order and are recorded.
- **Backups:** a nightly `pg_dump` plus the files folder, kept for 14 days by default.
- **Health:** a `GET /healthz` endpoint for monitoring.

## Windows (Windows Server or Windows 11 Pro)

Ubuntu is the main platform; Windows is supported for sites that run Windows servers, or a single Windows PC as the Hub. The application code is the same; only the installation differs.

| Piece | Ubuntu | Windows |
|---|---|---|
| Install | `deploy/install.sh` | `deploy/windows/install.ps1` (PowerShell, as Administrator), safe to re-run |
| Node.js 22 | apt / NodeSource | Official MSI (checksum-verified), or winget |
| PostgreSQL | apt | Official EDB installer, unattended, listening on localhost only |
| HTTPS | nginx in front | **The Hub itself** (`HUB_TLS_CERT` / `HUB_TLS_KEY`), on port 443, with port 80 redirecting |
| Running as a service | systemd, sandboxed | A Windows service via WinSW (a small, open-source service wrapper), running as a **virtual service account** (`NT SERVICE\BenchwiseHub`) with no rights beyond its own folders |
| Settings and secrets | `/etc/benchwise-hub` | `C:\ProgramData\BenchwiseHub\config`, readable only by Administrators and the service |
| Report PDFs | `/var/lib/benchwise-hub/files` | `C:\ProgramData\BenchwiseHub\files` |
| Certificate | self-signed if none supplied | the same: self-signed if none supplied, or the company's certificate |
| Firewall | ufw rule if ufw is on | Windows Firewall rule for 443 (and 80) |
| Backups | nightly cron: `pg_dump` + files | nightly Scheduled Task: `pg_dump` + files |
| Administration | `sudo benchwise-hub …` | `benchwise-hub.cmd …` from an Administrator prompt |

The direct-HTTPS mode is already in the server and is tested. The Windows installer will be tested on a Windows 11 VM before it's offered.

## Later phases (not in the first version)

- Pairing codes for enrolling stations, instead of copying keys.
- **Site policy pushed to stations:** verdict rules (does Locked fail, does malware fail), the known-tenants list, enabled tests.
- Fleet updates: the Hub serves approved Benchwise versions to benches and sticks.
- Webhooks for the WMS (push instead of pull).
- Sign-in with the company's identity provider (OIDC / Entra ID).
- Per-facility Hubs syncing to a central one.
- Dashboards: fail rates by model, throughput, units awaiting retest.
