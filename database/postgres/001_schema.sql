-- Execute with the environment's DDL administrator in the SQL editor.
-- No data is deleted. Existing NoSQL collections are not imported by this script.
BEGIN;

CREATE TABLE IF NOT EXISTS public."ez_users" (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  CONSTRAINT "ez_users_identity" CHECK (jsonb_typeof(data) = 'object' AND data ? 'id' AND jsonb_typeof(data->'id') = 'string' AND data->>'id' = id)
);
ALTER TABLE public."ez_users" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."ez_users" FROM PUBLIC;
CREATE INDEX IF NOT EXISTS "ez_users_filter" ON public."ez_users" USING gin (data jsonb_path_ops);

CREATE TABLE IF NOT EXISTS public."ez_sessions" (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  CONSTRAINT "ez_sessions_identity" CHECK (jsonb_typeof(data) = 'object' AND data ? 'id' AND jsonb_typeof(data->'id') = 'string' AND data->>'id' = id)
);
ALTER TABLE public."ez_sessions" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."ez_sessions" FROM PUBLIC;
CREATE INDEX IF NOT EXISTS "ez_sessions_filter" ON public."ez_sessions" USING gin (data jsonb_path_ops);

CREATE TABLE IF NOT EXISTS public."ez_memberPackages" (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  CONSTRAINT "ez_memberPackages_identity" CHECK (jsonb_typeof(data) = 'object' AND data ? 'id' AND jsonb_typeof(data->'id') = 'string' AND data->>'id' = id)
);
ALTER TABLE public."ez_memberPackages" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."ez_memberPackages" FROM PUBLIC;
CREATE INDEX IF NOT EXISTS "ez_memberPackages_filter" ON public."ez_memberPackages" USING gin (data jsonb_path_ops);

CREATE TABLE IF NOT EXISTS public."ez_bookings" (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  CONSTRAINT "ez_bookings_identity" CHECK (jsonb_typeof(data) = 'object' AND data ? 'id' AND jsonb_typeof(data->'id') = 'string' AND data->>'id' = id)
);
ALTER TABLE public."ez_bookings" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."ez_bookings" FROM PUBLIC;
CREATE INDEX IF NOT EXISTS "ez_bookings_filter" ON public."ez_bookings" USING gin (data jsonb_path_ops);

CREATE TABLE IF NOT EXISTS public."ez_scheduleLocks" (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  CONSTRAINT "ez_scheduleLocks_identity" CHECK (jsonb_typeof(data) = 'object' AND data ? 'id' AND jsonb_typeof(data->'id') = 'string' AND data->>'id' = id)
);
ALTER TABLE public."ez_scheduleLocks" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."ez_scheduleLocks" FROM PUBLIC;
CREATE INDEX IF NOT EXISTS "ez_scheduleLocks_filter" ON public."ez_scheduleLocks" USING gin (data jsonb_path_ops);

CREATE TABLE IF NOT EXISTS public."ez_creditLedger" (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  CONSTRAINT "ez_creditLedger_identity" CHECK (jsonb_typeof(data) = 'object' AND data ? 'id' AND jsonb_typeof(data->'id') = 'string' AND data->>'id' = id)
);
ALTER TABLE public."ez_creditLedger" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."ez_creditLedger" FROM PUBLIC;
CREATE INDEX IF NOT EXISTS "ez_creditLedger_filter" ON public."ez_creditLedger" USING gin (data jsonb_path_ops);

CREATE TABLE IF NOT EXISTS public."ez_purchaseRecords" (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  CONSTRAINT "ez_purchaseRecords_identity" CHECK (jsonb_typeof(data) = 'object' AND data ? 'id' AND jsonb_typeof(data->'id') = 'string' AND data->>'id' = id)
);
ALTER TABLE public."ez_purchaseRecords" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."ez_purchaseRecords" FROM PUBLIC;
CREATE INDEX IF NOT EXISTS "ez_purchaseRecords_filter" ON public."ez_purchaseRecords" USING gin (data jsonb_path_ops);

CREATE TABLE IF NOT EXISTS public."ez_inbox" (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  CONSTRAINT "ez_inbox_identity" CHECK (jsonb_typeof(data) = 'object' AND data ? 'id' AND jsonb_typeof(data->'id') = 'string' AND data->>'id' = id)
);
ALTER TABLE public."ez_inbox" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."ez_inbox" FROM PUBLIC;
CREATE INDEX IF NOT EXISTS "ez_inbox_filter" ON public."ez_inbox" USING gin (data jsonb_path_ops);

CREATE TABLE IF NOT EXISTS public."ez_requestKeys" (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  CONSTRAINT "ez_requestKeys_identity" CHECK (jsonb_typeof(data) = 'object' AND data ? 'id' AND jsonb_typeof(data->'id') = 'string' AND data->>'id' = id)
);
ALTER TABLE public."ez_requestKeys" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."ez_requestKeys" FROM PUBLIC;
CREATE INDEX IF NOT EXISTS "ez_requestKeys_filter" ON public."ez_requestKeys" USING gin (data jsonb_path_ops);

CREATE TABLE IF NOT EXISTS public."ez_auditLogs" (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  CONSTRAINT "ez_auditLogs_identity" CHECK (jsonb_typeof(data) = 'object' AND data ? 'id' AND jsonb_typeof(data->'id') = 'string' AND data->>'id' = id)
);
ALTER TABLE public."ez_auditLogs" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."ez_auditLogs" FROM PUBLIC;
CREATE INDEX IF NOT EXISTS "ez_auditLogs_filter" ON public."ez_auditLogs" USING gin (data jsonb_path_ops);

CREATE TABLE IF NOT EXISTS public."ez_settings" (
  id text PRIMARY KEY,
  data jsonb NOT NULL,
  CONSTRAINT "ez_settings_identity" CHECK (jsonb_typeof(data) = 'object' AND data ? 'id' AND jsonb_typeof(data->'id') = 'string' AND data->>'id' = id)
);
ALTER TABLE public."ez_settings" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."ez_settings" FROM PUBLIC;
CREATE INDEX IF NOT EXISTS "ez_settings_filter" ON public."ez_settings" USING gin (data jsonb_path_ops);

-- Platform API roles must not bypass the trusted cloud function.
DO $$
DECLARE role_name text; table_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      FOREACH table_name IN ARRAY ARRAY['ez_users', 'ez_sessions', 'ez_memberPackages', 'ez_bookings', 'ez_scheduleLocks', 'ez_creditLedger', 'ez_purchaseRecords', 'ez_inbox', 'ez_requestKeys', 'ez_auditLogs', 'ez_settings'] LOOP
        EXECUTE format('REVOKE ALL ON public.%I FROM %I', table_name, role_name);
      END LOOP;
    END IF;
  END LOOP;
END $$;
COMMIT;

