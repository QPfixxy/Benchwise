# Benchwise Server

One codebase, two roles: a **site server** at each facility (built first) and the central **Hub** (next phase). See the design.

The central record for every unit Benchwise tests, across facilities: benches and USB sticks send their reports here, staff search them in a browser, and a WMS or Tableau pulls them through the API. Design and decisions: [docs/hub/DESIGN.md](../docs/hub/DESIGN.md).

## Install (Ubuntu Server 22.04, 24.04 or 26.04)

```bash
git clone -b feature/hub https://github.com/QPfixxy/Benchwise.git   # until the server is merged to main
cd Benchwise/server
sudo ./deploy/install.sh
```

The installer sets up PostgreSQL, nginx (HTTPS) and Node.js 22, creates the database and a sandboxed service account, and starts the service. It prints the web address, a **one-time setup code**, and the certificate fingerprint that stations use to trust a self-signed certificate.

**Then finish in a browser.** Open the address from any PC and enter the setup code. The wizard asks for:
1. the facility code, name and time zone;
2. **one network or two**: pick the network cards from a list;
3. the certificate: the generated one, or your company's (paste or upload PEM);
4. the floor Wi-Fi for the USB sticks this server makes: name, security (WPA2, WPA3 or open), password, and whether it's hidden. It can be changed any time under **Administration → Floor Wi-Fi**. The password is never shown or logged;
5. the first administrator account.

Network and certificate changes are applied by a small root-only helper (`benchwise-server-apply`), because the web service itself runs unprivileged. The wizard closes for good once setup is complete.

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
| `GET /api/v1/audits/<id>/report.pdf` | A compliance PDF of one record, drawn on demand |
| `GET /api/v1/export.zip?site=…&from=YYYY-MM-DD&to=…` or `?serials=A,B,C` | A compliance export: one PDF per record plus `summary.csv` (up to 5,000 records; logged) |

## Making USB sticks

Under **Administration → USB sticks**:

1. **Get the Benchwise build** once: *Get latest release* downloads the `-win-x64.zip` from GitHub and checks its SHA-256. Tick *include pre-releases* for betas. Or upload that ZIP yourself, if the server has no internet.
2. **Plug a USB stick into the server** and click *Refresh*. Only removable drives are listed; system disks never are.
3. Click **Make stick** and confirm. **The drive is erased.** It's formatted exFAT (label BENCHWISE) and gets Benchwise, the floor Wi-Fi profile, and a `site.cmd` with this server's address and **its own station key** ("Stick 1", "Stick 2", …). A lost stick can be revoked alone under Stations.

The server address sticks use is the floor address in two-network mode, otherwise this server's address. It can be changed before making a stick, for example to a DNS name.

If a desktop on the server has the stick open (a file manager window), the stick is refused and nothing is erased: close the window and try again. A stick that fails part-way has its key revoked automatically; just make it again.

Stations (with their `bws_` key, on the floor side) can fetch the current floor Wi-Fi as a ready-made Windows Wi-Fi profile from `GET /api/v1/station/wifi`. That's how sticks keep their `wifi.xml` up to date.

Searches also take `from` / `to` (completion date) and `serials` (a comma-separated list).

**PDFs are never stored on the server.** They are drawn from the stored record each time, with its SHA-256 and chain hash printed, so a PDF can always be checked against the server.

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
