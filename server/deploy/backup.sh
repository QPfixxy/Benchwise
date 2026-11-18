#!/usr/bin/env bash
# Benchwise Server nightly backup: database dump, kept 14 days (records only;
# servers store no PDFs).
# Installed as /usr/local/sbin/benchwise-server-backup; run by cron as root.
set -euo pipefail
DEST=${BENCHWISE_BACKUP_DIR:-/var/backups/benchwise-server}
KEEP_DAYS=${BENCHWISE_BACKUP_DAYS:-14}
STAMP=$(date +%Y%m%d-%H%M%S)
install -d -m 0700 -o postgres -g postgres "$DEST"
sudo -u postgres pg_dump --format=custom benchwise_server > "$DEST/db-$STAMP.dump"
chmod 0600 "$DEST/db-$STAMP.dump"
find "$DEST" -maxdepth 1 -type f -name 'db-*.dump' -mtime +"$KEEP_DAYS" -delete
