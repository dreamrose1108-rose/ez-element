-- First create a dedicated LOGIN role called ez_api through the platform's
-- account management (or your DBA). Set its password outside source control.
-- Run this script as DDL administrator, never with the client/public API key.
BEGIN;
GRANT USAGE ON SCHEMA public TO ez_api;
GRANT SELECT, INSERT, UPDATE ON public."ez_users" TO ez_api;
DROP POLICY IF EXISTS ez_api_access ON public."ez_users";
CREATE POLICY ez_api_access ON public."ez_users" FOR ALL TO ez_api USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON public."ez_sessions" TO ez_api;
DROP POLICY IF EXISTS ez_api_access ON public."ez_sessions";
CREATE POLICY ez_api_access ON public."ez_sessions" FOR ALL TO ez_api USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON public."ez_memberPackages" TO ez_api;
DROP POLICY IF EXISTS ez_api_access ON public."ez_memberPackages";
CREATE POLICY ez_api_access ON public."ez_memberPackages" FOR ALL TO ez_api USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON public."ez_bookings" TO ez_api;
DROP POLICY IF EXISTS ez_api_access ON public."ez_bookings";
CREATE POLICY ez_api_access ON public."ez_bookings" FOR ALL TO ez_api USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON public."ez_scheduleLocks" TO ez_api;
DROP POLICY IF EXISTS ez_api_access ON public."ez_scheduleLocks";
CREATE POLICY ez_api_access ON public."ez_scheduleLocks" FOR ALL TO ez_api USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON public."ez_creditLedger" TO ez_api;
DROP POLICY IF EXISTS ez_api_access ON public."ez_creditLedger";
CREATE POLICY ez_api_access ON public."ez_creditLedger" FOR ALL TO ez_api USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON public."ez_purchaseRecords" TO ez_api;
DROP POLICY IF EXISTS ez_api_access ON public."ez_purchaseRecords";
CREATE POLICY ez_api_access ON public."ez_purchaseRecords" FOR ALL TO ez_api USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON public."ez_inbox" TO ez_api;
DROP POLICY IF EXISTS ez_api_access ON public."ez_inbox";
CREATE POLICY ez_api_access ON public."ez_inbox" FOR ALL TO ez_api USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON public."ez_requestKeys" TO ez_api;
DROP POLICY IF EXISTS ez_api_access ON public."ez_requestKeys";
CREATE POLICY ez_api_access ON public."ez_requestKeys" FOR ALL TO ez_api USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON public."ez_auditLogs" TO ez_api;
DROP POLICY IF EXISTS ez_api_access ON public."ez_auditLogs";
CREATE POLICY ez_api_access ON public."ez_auditLogs" FOR ALL TO ez_api USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON public."ez_settings" TO ez_api;
DROP POLICY IF EXISTS ez_api_access ON public."ez_settings";
CREATE POLICY ez_api_access ON public."ez_settings" FOR ALL TO ez_api USING (true) WITH CHECK (true);
COMMIT;

