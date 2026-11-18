-- Server-wide settings: setup state, network choice, floor Wi-Fi for sticks.
-- One row per key; the value is JSON.
CREATE TABLE server_settings (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_.]{1,60}$'),
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'benchwise_server_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON server_settings TO benchwise_server_app;
  END IF;
END $$;
