#!/usr/bin/env bash
# =========================================================================
#  Benchwise Server installer for Ubuntu Server (22.04, 24.04, 26.04).
#
#    sudo ./deploy/install.sh                       one network
#    sudo ./deploy/install.sh --company-ip 10.1.0.20 --floor-ip 172.16.0.2
#                                                   two networks: staff pages on the
#                                                   company side, station uploads on
#                                                   the floor side, no routing between
#
#  Run from the server/ folder. Safe to run again: existing passwords, keys,
#  certificates and data are kept; the app is updated and migrations run.
#
#  To use your own certificate, put it in /etc/benchwise-server/tls/server.crt
#  and server.key (full chain, PEM) before running, or replace them later and
#  run: sudo systemctl reload nginx
# =========================================================================
set -euo pipefail

APP=/opt/benchwise-server
ETC=/etc/benchwise-server
DATA=/var/lib/benchwise-server
BACKUPS=/var/backups/benchwise-server
SVC_USER=benchwise-server
DB=benchwise_server
SRC="$(cd "$(dirname "$0")/.." && pwd)"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Run with sudo."
. /etc/os-release
[ "${ID:-}" = ubuntu ] || die "This installer is for Ubuntu Server."
[ -f "$SRC/src/server.js" ] || die "Run from the server/ folder of the Benchwise repository."

randpw() { openssl rand -base64 36 | tr -dc 'A-Za-z0-9' | head -c 40; }

# Network sides. Remembered in $ETC/install.conf, so upgrades keep them.
COMPANY_IP=""; FLOOR_IP=""
[ -f "$ETC/install.conf" ] && . "$ETC/install.conf"
while [ $# -gt 0 ]; do
  case "$1" in
    --company-ip) COMPANY_IP="$2"; shift 2 ;;
    --floor-ip)   FLOOR_IP="$2"; shift 2 ;;
    --one-network) COMPANY_IP=""; FLOOR_IP=""; shift ;;
    *) die "Unknown option $1" ;;
  esac
done
if [ -n "$FLOOR_IP$COMPANY_IP" ]; then
  [ -n "$FLOOR_IP" ] && [ -n "$COMPANY_IP" ] || die "Give both --company-ip and --floor-ip (or neither)."
  [ "$FLOOR_IP" != "$COMPANY_IP" ] || die "The company and floor addresses must differ."
  for ip in "$COMPANY_IP" "$FLOOR_IP"; do
    hostname -I | tr ' ' '\n' | grep -qx "$ip" || die "$ip is not an address of this server."
  done
fi

# ------------------------------------------------------------------ packages
say "Installing packages (PostgreSQL, nginx, Node.js 22)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq postgresql nginx openssl ca-certificates curl gnupg >/dev/null

node_major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0; }
if [ "$(apt-cache policy nodejs | awk '/Candidate/{print $2}' | sed -E 's/^([0-9]+).*/\1/')" -ge 22 ] 2>/dev/null; then
  apt-get install -y -qq nodejs >/dev/null
fi
if [ "$(node_major)" -lt 22 ] 2>/dev/null || ! command -v node >/dev/null; then
  # Older Ubuntu: the official NodeSource repository for Node 22 LTS.
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs >/dev/null
fi
[ "$(node_major)" -ge 22 ] || die "Node.js 22 or newer is required (found $(node -v 2>/dev/null || echo none))."
command -v npm >/dev/null || apt-get install -y -qq npm >/dev/null
echo "Node $(node -v), $(psql --version), $(nginx -v 2>&1)"

# ------------------------------------------------------------------ user and folders
say "Service account and folders"
id "$SVC_USER" >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin "$SVC_USER"
install -d -m 0750 -o root -g "$SVC_USER" "$ETC"
install -d -m 0700 -o root -g root "$ETC/tls"
install -d -m 0750 -o "$SVC_USER" -g "$SVC_USER" "$DATA"
install -d -m 0700 -o postgres -g postgres "$BACKUPS"

# ------------------------------------------------------------------ database
say "Database"
# Passwords are created once and kept in root-only files.
OWNER_ENV="$ETC/owner.env"
BW_ENV="$ETC/server.env"
if [ -f "$OWNER_ENV" ]; then
  OWNER_PW=$(sed -nE 's#^BW_OWNER_DATABASE_URL=postgres://benchwise_server_owner:([^@]+)@.*#\1#p' "$OWNER_ENV")
else
  OWNER_PW=$(randpw)
fi
if [ -f "$BW_ENV" ]; then
  APP_PW=$(sed -nE 's#^BW_DATABASE_URL=postgres://benchwise_server_app:([^@]+)@.*#\1#p' "$BW_ENV")
else
  APP_PW=$(randpw)
fi

sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'benchwise_server_owner') THEN
    CREATE ROLE benchwise_server_owner LOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'benchwise_server_app') THEN
    CREATE ROLE benchwise_server_app LOGIN;
  END IF;
END \$\$;
ALTER ROLE benchwise_server_owner PASSWORD '$OWNER_PW';
ALTER ROLE benchwise_server_app PASSWORD '$APP_PW' NOSUPERUSER NOCREATEDB NOCREATEROLE;
SQL
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB'" | grep -q 1; then
  sudo -u postgres createdb -O benchwise_server_owner "$DB"
fi
sudo -u postgres psql -v ON_ERROR_STOP=1 -q -d "$DB" <<SQL
ALTER SCHEMA public OWNER TO benchwise_server_owner;
REVOKE ALL ON DATABASE $DB FROM PUBLIC;
GRANT CONNECT ON DATABASE $DB TO benchwise_server_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO benchwise_server_app;
SQL

umask 077
cat > "$OWNER_ENV" <<EOF
# Schema owner: used only by "benchwise-server migrate". Root-only.
BW_OWNER_DATABASE_URL=postgres://benchwise_server_owner:$OWNER_PW@127.0.0.1:5432/$DB
EOF
chmod 0600 "$OWNER_ENV"
cat > "$BW_ENV" <<EOF
# Benchwise Server service settings (read by systemd). Keep private.
BW_DATABASE_URL=postgres://benchwise_server_app:$APP_PW@127.0.0.1:5432/$DB
BW_ROLE=site
BW_LISTEN=127.0.0.1:8080
${FLOOR_IP:+BW_FLOOR_LISTEN=127.0.0.1:8081}
BW_SESSION_HOURS=12
EOF
cat > "$ETC/install.conf" <<EOF
COMPANY_IP="$COMPANY_IP"
FLOOR_IP="$FLOOR_IP"
EOF
chmod 0600 "$ETC/install.conf"
chown root:"$SVC_USER" "$BW_ENV"
chmod 0640 "$BW_ENV"
umask 022

# ------------------------------------------------------------------ application
say "Application"
rm -rf "$APP.new"
install -d -m 0755 "$APP.new"
cp -a "$SRC/src" "$SRC/public" "$SRC/package.json" "$SRC/package-lock.json" "$APP.new/"
(cd "$APP.new" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
chown -R root:root "$APP.new"
rm -rf "$APP.old"
[ -d "$APP" ] && mv "$APP" "$APP.old"
mv "$APP.new" "$APP"

cat > /usr/local/bin/benchwise-server <<'EOF'
#!/usr/bin/env bash
# Benchwise Server administration (run with sudo). See: benchwise-server help
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo." >&2; exit 1; }
set -a
. /etc/benchwise-server/server.env
case "${1:-}" in migrate|maintain) . /etc/benchwise-server/owner.env ;; esac
set +a
exec /usr/bin/node /opt/benchwise-server/src/cli.js "$@"
EOF
chmod 0755 /usr/local/bin/benchwise-server

say "Database migrations"
benchwise-server migrate

# ------------------------------------------------------------------ TLS
say "TLS certificate"
if [ ! -f "$ETC/tls/server.crt" ] || [ ! -f "$ETC/tls/server.key" ]; then
  HOST=$(hostname -f 2>/dev/null || hostname)
  SAN="DNS:$HOST,DNS:localhost"
  for ip in $(hostname -I); do SAN="$SAN,IP:$ip"; done
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 825 \
    -subj "/CN=$HOST/O=Benchwise Server" -addext "subjectAltName=$SAN" \
    -keyout "$ETC/tls/server.key" -out "$ETC/tls/server.crt" 2>/dev/null
  echo "Created a self-signed certificate for $SAN."
else
  echo "Keeping the existing certificate."
fi
chmod 0600 "$ETC/tls/server.key"
chmod 0644 "$ETC/tls/server.crt"
FINGERPRINT=$(openssl x509 -in "$ETC/tls/server.crt" -noout -fingerprint -sha256 | cut -d= -f2)

# ------------------------------------------------------------------ nginx and service
say "Web server and service"
if [ -n "$FLOOR_IP" ]; then
  sed -e "s/__COMPANY_IP__/$COMPANY_IP/g" -e "s/__FLOOR_IP__/$FLOOR_IP/g" "$SRC/deploy/nginx-two-networks.conf" > /etc/nginx/sites-available/benchwise-server
  chmod 0644 /etc/nginx/sites-available/benchwise-server
  # Never route between the floor (units under test) and the company network.
  printf 'net.ipv4.ip_forward = 0\nnet.ipv6.conf.all.forwarding = 0\n' > /etc/sysctl.d/90-benchwise-no-forwarding.conf
  sysctl -q --system >/dev/null
  echo "Two networks: staff pages on $COMPANY_IP, station uploads on $FLOOR_IP; forwarding off."
else
  install -m 0644 "$SRC/deploy/nginx.conf" /etc/nginx/sites-available/benchwise-server
fi
ln -sf /etc/nginx/sites-available/benchwise-server /etc/nginx/sites-enabled/benchwise-server
rm -f /etc/nginx/sites-enabled/default
nginx -t -q
install -m 0644 "$SRC/deploy/benchwise-server.service" /etc/systemd/system/benchwise-server.service
systemctl daemon-reload
systemctl enable -q benchwise-server nginx
systemctl restart benchwise-server
# Restart (not reload): the addresses nginx listens on may have changed.
systemctl restart nginx

# Firewall: only if ufw is already on (we never turn it on for you).
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null
fi

# ------------------------------------------------------------------ backups
say "Nightly backups"
install -m 0755 "$SRC/deploy/backup.sh" /usr/local/sbin/benchwise-server-backup
cat > /etc/cron.d/benchwise-server-backup <<'EOF'
# Benchwise Server: nightly database backup (kept 14 days) and daily upkeep.
30 2 * * * root /usr/local/sbin/benchwise-server-backup
15 3 * * * root /usr/local/bin/benchwise-server maintain >/dev/null
EOF
chmod 0644 /etc/cron.d/benchwise-server-backup

# ------------------------------------------------------------------ health and first admin
say "Checking the service"
for i in $(seq 1 30); do
  curl -fsk "https://${COMPANY_IP:-127.0.0.1}/healthz" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsk "https://${COMPANY_IP:-127.0.0.1}/healthz" || die "The service did not start: journalctl -u benchwise-server -n 50"
echo

ADMIN_MSG="Administrator account already exists."
if [ "$(sudo -u postgres psql -d "$DB" -tAc 'SELECT count(*) FROM users')" = 0 ]; then
  ADMIN_MSG=$(benchwise-server create-admin admin)
fi

say "Benchwise Server is running"
cat <<EOF

  Web:          https://${COMPANY_IP:-$(hostname -I | awk '{print $1}')}/
  $ADMIN_MSG

  Certificate SHA-256 fingerprint (for stations: BENCHWISE_SERVER_FINGERPRINT):
    $FINGERPRINT

  Next:  sudo benchwise-server create-site DAL "Dallas"
         sudo benchwise-server create-station DAL "Bench 1"
  Logs:  journalctl -u benchwise-server -f
EOF
