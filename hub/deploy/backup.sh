#!/usr/bin/env bash
# Benchwise Hub nightly backup: database dump + report files, kept 14 days.
# Installed as /usr/local/sbin/benchwise-hub-backup; run by cron as root.
set -euo pipefail
DEST=${BENCHWISE_BACKUP_DIR:-/var/backups/benchwise-hub}
KEEP_DAYS=${BENCHWISE_BACKUP_DAYS:-14}
STAMP=$(date +%Y%m%d-%H%M%S)
install -d -m 0700 -o postgres -g postgres "$DEST"
sudo -u postgres pg_dump --format=custom benchwise_hub > "$DEST/db-$STAMP.dump"
tar -C /var/lib/benchwise-hub -czf "$DEST/files-$STAMP.tar.gz" files
chmod 0600 "$DEST/db-$STAMP.dump" "$DEST/files-$STAMP.tar.gz"
find "$DEST" -maxdepth 1 -type f \( -name 'db-*.dump' -o -name 'files-*.tar.gz' \) -mtime +"$KEEP_DAYS" -delete
