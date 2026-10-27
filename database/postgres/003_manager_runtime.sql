-- Runtime bridge for shared CloudBase PostgreSQL clusters. ExecutePGSql runs
-- one statement at a time, so this function makes each optimistic write batch
-- atomic while the TypeScript service keeps the existing Store contract.
BEGIN;

CREATE TABLE IF NOT EXISTS public."ez_store_meta" (
  id text PRIMARY KEY,
  version bigint NOT NULL CHECK (version >= 0)
);
ALTER TABLE public."ez_store_meta" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public."ez_store_meta" FROM PUBLIC;
INSERT INTO public."ez_store_meta" (id, version) VALUES ('store', 0)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public."ez_apply_writes"(p_expected bigint, p_writes jsonb)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  current_version bigint;
  item jsonb;
  table_name text;
  record_id text;
  record_data jsonb;
BEGIN
  IF jsonb_typeof(p_writes) <> 'array' OR jsonb_array_length(p_writes) > 100 THEN
    RAISE EXCEPTION 'invalid write batch';
  END IF;

  SELECT version INTO current_version
    FROM public."ez_store_meta" WHERE id = 'store' FOR UPDATE;
  IF current_version IS NULL THEN
    RAISE EXCEPTION 'store metadata missing';
  END IF;
  IF current_version <> p_expected THEN
    RETURN -1;
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(p_writes) LOOP
    table_name := item->>'table';
    record_id := item->>'id';
    record_data := item->'data';
    IF table_name IS NULL OR NOT (table_name = ANY (ARRAY[
      'users', 'sessions', 'memberPackages', 'bookings', 'scheduleLocks',
      'creditLedger', 'purchaseRecords', 'inbox', 'requestKeys', 'auditLogs', 'settings'
    ])) OR record_id IS NULL OR record_data IS NULL OR jsonb_typeof(record_data) <> 'object'
      OR record_data->>'id' IS DISTINCT FROM record_id THEN
      RAISE EXCEPTION 'invalid write record';
    END IF;
    EXECUTE format(
      'INSERT INTO public.%I (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data',
      'ez_' || table_name
    ) USING record_id, record_data;
  END LOOP;

  UPDATE public."ez_store_meta" SET version = version + 1 WHERE id = 'store'
    RETURNING version INTO current_version;
  RETURN current_version;
END;
$$;

REVOKE ALL ON FUNCTION public."ez_apply_writes"(bigint, jsonb) FROM PUBLIC;
COMMIT;
