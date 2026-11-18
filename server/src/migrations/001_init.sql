-- Benchwise Server: initial schema (site server and Hub share it).
-- Runs as benchwise_server_owner. The service connects as benchwise_server_app,
-- which gets only the privileges granted at the end of this file.
--
-- Built for ~13,500 records a day and 7+ years of retention:
--   audits         one narrow row per record: everything that's searched on
--   audit_records  the full record (JSON), partitioned by year, compressed

CREATE TABLE sites (
  id          serial PRIMARY KEY,
  code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{1,15}$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  time_zone   text NOT NULL DEFAULT 'America/Chicago',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stations (
  id               serial PRIMARY KEY,
  site_id          int NOT NULL REFERENCES sites(id),
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  key_prefix       text NOT NULL,
  key_hash         bytea NOT NULL UNIQUE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz,
  last_app_version text,
  revoked_at       timestamptz,
  UNIQUE (site_id, name)
);

-- One row per saved Benchwise record. Append-only: a re-test is a new row.
CREATE TABLE audits (
  id              uuid PRIMARY KEY,                 -- the record's own id (uploads are idempotent on it)
  seq             bigserial NOT NULL UNIQUE,        -- arrival order: export cursor and chain order
  site_id         int NOT NULL REFERENCES sites(id),
  station_id      int NOT NULL REFERENCES stations(id),
  schema          text NOT NULL,
  schema_version  int NOT NULL,
  serial          text,
  uuid            text,
  asset_tag       text,
  manufacturer    text,
  model           text,
  profile         text,
  overall         text,
  mdm_status      text,
  malware_status  text,
  technician      text,
  app_version     text,
  completed_at    timestamptz NOT NULL,
  received_at     timestamptz NOT NULL DEFAULT now(),
  record_year     smallint NOT NULL,                -- which audit_records partition holds the full record
  record_sha256   text NOT NULL,
  prev_hash       text,                             -- previous link in this site's chain
  hash            text NOT NULL                     -- sha256(prev_hash + record_sha256)
);
CREATE INDEX audits_serial     ON audits (upper(serial));
CREATE INDEX audits_uuid       ON audits (lower(uuid));
CREATE INDEX audits_site_time  ON audits (site_id, completed_at DESC);
CREATE INDEX audits_site_seq   ON audits (site_id, seq);
CREATE INDEX audits_overall    ON audits (overall, completed_at DESC);

-- The full records, one partition per year (dropped or moved to cheaper
-- storage as a whole once past retention).
CREATE TABLE audit_records (
  record_year  smallint NOT NULL,
  audit_id     uuid NOT NULL,
  record       jsonb NOT NULL,
  PRIMARY KEY (record_year, audit_id)
) PARTITION BY RANGE (record_year);

-- lz4 compresses JSON well and fast; fall back to the default where the
-- server wasn't built with it.
DO $$ BEGIN
  ALTER TABLE audit_records ALTER COLUMN record SET COMPRESSION lz4;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'lz4 not available; using default compression';
END $$;

-- Creates the yearly partitions from 2020 through `through_year` (idempotent).
-- Run by the daily maintenance job so the coming years always exist.
CREATE FUNCTION benchwise_add_year_partitions(through_year int) RETURNS int LANGUAGE plpgsql AS $$
DECLARE y int; made int := 0;
BEGIN
  FOR y IN 2020..through_year LOOP
    IF to_regclass(format('audit_records_%s', y)) IS NULL THEN
      EXECUTE format('CREATE TABLE audit_records_%s PARTITION OF audit_records FOR VALUES FROM (%s) TO (%s)', y, y, y + 1);
      made := made + 1;
    END IF;
  END LOOP;
  RETURN made;
END $$;
SELECT benchwise_add_year_partitions(extract(year FROM now())::int + 5);
-- Anything outside the created years still has a home.
CREATE TABLE audit_records_other PARTITION OF audit_records DEFAULT;

CREATE FUNCTION benchwise_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME;
END $$;
CREATE TRIGGER audits_append_only BEFORE UPDATE OR DELETE ON audits
  FOR EACH ROW EXECUTE FUNCTION benchwise_append_only();
CREATE TRIGGER audit_records_append_only BEFORE UPDATE OR DELETE ON audit_records
  FOR EACH ROW EXECUTE FUNCTION benchwise_append_only();

CREATE TABLE users (
  id             serial PRIMARY KEY,
  username       text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9._-]{3,40}$'),
  password_hash  text NOT NULL,
  role           text NOT NULL CHECK (role IN ('admin', 'lead', 'viewer')),
  origin         text NOT NULL DEFAULT 'local' CHECK (origin IN ('local', 'hub', 'entra', 'ad')),
  all_sites      boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  disabled_at    timestamptz
);

CREATE TABLE user_sites (
  user_id  int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id  int NOT NULL REFERENCES sites(id),
  PRIMARY KEY (user_id, site_id)
);

CREATE TABLE sessions (
  id_hash       bytea PRIMARY KEY,
  user_id       int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_expires ON sessions (expires_at);

-- Integration keys (WMS, Tableau): read access, optionally limited to sites.
CREATE TABLE api_clients (
  id            serial PRIMARY KEY,
  name          text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 80),
  key_prefix    text NOT NULL,
  key_hash      bytea NOT NULL UNIQUE,
  scopes        text[] NOT NULL DEFAULT ARRAY['audits:read'],
  site_ids      int[],                              -- NULL = all sites
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);

-- Every administrative change. Append-only too.
CREATE TABLE admin_log (
  id      bigserial PRIMARY KEY,
  at      timestamptz NOT NULL DEFAULT now(),
  actor   text NOT NULL,
  action  text NOT NULL,
  detail  jsonb NOT NULL DEFAULT '{}'
);
CREATE TRIGGER admin_log_append_only BEFORE UPDATE OR DELETE ON admin_log
  FOR EACH ROW EXECUTE FUNCTION benchwise_append_only();

-- Least privilege for the service's role: no schema changes, and records and
-- the admin log can only be added to.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'benchwise_server_app') THEN
    GRANT SELECT, INSERT ON audits, audit_records, admin_log TO benchwise_server_app;
    GRANT SELECT ON sites TO benchwise_server_app;
    GRANT SELECT, INSERT, UPDATE ON stations, users, api_clients TO benchwise_server_app;
    GRANT SELECT, INSERT, DELETE ON user_sites, sessions TO benchwise_server_app;
    GRANT UPDATE (last_seen_at) ON sessions TO benchwise_server_app;
    GRANT INSERT ON sites TO benchwise_server_app;
    GRANT UPDATE (name, time_zone) ON sites TO benchwise_server_app;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO benchwise_server_app;
  END IF;
END $$;
