# Benchwise Server

One codebase, two roles: a **site server** at each facility (built first) and the central **Hub** (next phase). See the design.

The central record for every unit Benchwise tests, across facilities: benches and USB sticks send their reports here, staff search them in a browser, and a WMS or Tableau pulls them through the API. Design and decisions: [docs/hub/DESIGN.md](../docs/hub/DESIGN.md).

## Install (Ubuntu Server 22.04, 24.04 or 26.04)

```bash
git clone https://github.com/QPfixxy/Benchwise.git
cd Benchwise/hub
sudo ./deploy/install.sh
```

The installer sets up PostgreSQL, nginx (HTTPS) and Node.js 22, creates the database and a sandboxed service account, and starts the service. It prints:
- the web address;
- the first administrator's password, shown **once**;
- the certificate fingerprint that stations use to trust a self-signed certificate.

To upgrade, pull the new version and run the same command again. Passwords, certificates and data are kept.

**Two networks** (like the Aiken server: a company side and a floor/test side):

```bash
sudo ./deploy/install.sh --company-ip 10.1.0.20 --floor-ip 172.16.0.2
```

- Staff pages, search and administration answer only on the company address.
- Benches and sticks upload only to the floor address.
- Traffic is never routed between the two networks.

The choice is remembered for upgrades; `--one-network` switches back.

To use your company's certificate, place it at `/etc/benchwise-server/tls/server.crt` and its key at `server.key` (PEM, full chain), then run `sudo systemctl reload nginx`.

## Administration

```bash
sudo benchwise-server create-site DAL "Dallas"        # a facility
sudo benchwise-server create-station DAL "Bench 1"    # a bench or stick; prints its key once
sudo benchwise-server create-admin alice              # another administrator; prints a password once
sudo benchwise-server verify DAL                      # check a site's tamper-evidence chain
journalctl -u benchwise-server -f                     # logs
```

Sites, stations, users and integration keys can also be managed in the web interface under **Administration**.

## For integrations (WMS, Tableau)

Create an integration key under **Administration → Integrations**, optionally limited to one site, and send it as `Authorization: Bearer bwa_…`.

| Request | What it returns |
|---|---|
| `GET /api/v1/audits?since=<cursor>&limit=500` | Everything that arrived after `cursor`, oldest first, with `nextCursor`. Store `nextCursor` and ask again for anything new |
| `GET /api/v1/audits?serial=…` / `?site=DAL&overall=fail` | A search, newest first |
| `GET /api/v1/units/<serial>` | A unit's latest result and its history |
| `GET /api/v1/audits/<id>` and `/pdf` | The full record, and its PDF |
| `GET /api/v1/audits.csv?…` | A search as CSV |

## Files on the server

| Path | What |
|---|---|
| `/opt/benchwise-server` | The application |
| `/etc/benchwise-server/server.env` | Service settings and the database password (readable by the service only) |
| `/etc/benchwise-server/owner.env` | Schema owner's password, used for upgrades (root only) |
| `/etc/benchwise-server/tls/` | Certificate and key |
| `/var/lib/benchwise-server/files` | Report PDFs |
| `/var/backups/benchwise-server` | Nightly database and file backups, kept 14 days |

## Development

```bash
cd hub && npm install
npm test                                          # unit tests
BW_TEST_DATABASE_URL=postgres://… npm test       # plus the integration tests (empty database)
```
