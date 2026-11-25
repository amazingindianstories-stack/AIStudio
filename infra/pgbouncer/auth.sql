-- One-time setup of the pooler's login lookup, run by the database owner in the application database ("railway").
-- Nothing here changes an application role, table or privilege.
--
--   psql "$OWNER_URL" -v auth_password="'$PGBOUNCER_AUTH_PASSWORD'" -f infra/pgbouncer/auth.sql
--
-- PgBouncer verifies each client against the live role (auth_query), so a password rotation in PostgreSQL needs no
-- PgBouncer change. The lookup is limited to the application's own roles (goal4_*), never superusers or others.
CREATE ROLE pgbouncer_auth LOGIN PASSWORD :auth_password CONNECTION LIMIT 2
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE SCHEMA IF NOT EXISTS pgbouncer;
REVOKE ALL ON SCHEMA pgbouncer FROM PUBLIC;
GRANT USAGE ON SCHEMA pgbouncer TO pgbouncer_auth;

CREATE OR REPLACE FUNCTION pgbouncer.get_auth(requested name)
RETURNS TABLE (usename name, passwd text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
    SELECT rolname, rolpassword
    FROM pg_authid
    WHERE rolname = requested AND rolcanlogin AND NOT rolsuper AND rolname ~ '^goal4_[a-z0-9_]+$'
$$;
REVOKE ALL ON FUNCTION pgbouncer.get_auth(name) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pgbouncer.get_auth(name) TO pgbouncer_auth;
