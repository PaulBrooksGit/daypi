#!/usr/bin/env bash
# Create DayPI Postgres roles + database on a VPS (synthetic or pilot).
# Usage:
#   POSTGRES_URL=postgresql://postgres:SECRET@127.0.0.1:5432/postgres \
#   APP_PASSWORD=... MIGRATOR_PASSWORD=... DB_NAME=daypi \
#   ./scripts/hostinger/bootstrap-db.sh
set -euo pipefail

POSTGRES_URL="${POSTGRES_URL:-postgresql://postgres:postgres@127.0.0.1:5432/postgres}"
DB_NAME="${DB_NAME:-daypi}"
APP_PASSWORD="${APP_PASSWORD:-daypi_app_dev}"
MIGRATOR_PASSWORD="${MIGRATOR_PASSWORD:-daypi_migrator_dev}"

echo "Bootstrapping database ${DB_NAME} (roles daypi_app / daypi_migrator)"

psql "${POSTGRES_URL}" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'daypi_migrator') THEN
    CREATE ROLE daypi_migrator LOGIN PASSWORD '${MIGRATOR_PASSWORD}';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'daypi_app') THEN
    CREATE ROLE daypi_app LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
\$\$;

SELECT 'CREATE DATABASE ${DB_NAME} OWNER daypi_migrator'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DB_NAME}')\gexec

GRANT CONNECT ON DATABASE ${DB_NAME} TO daypi_app;
SQL

psql "${POSTGRES_URL}" -v ON_ERROR_STOP=1 <<SQL
\c ${DB_NAME}
GRANT USAGE ON SCHEMA public TO daypi_app;
GRANT CREATE ON SCHEMA public TO daypi_migrator;
ALTER DEFAULT PRIVILEGES FOR ROLE daypi_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO daypi_app;
ALTER DEFAULT PRIVILEGES FOR ROLE daypi_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO daypi_app;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SQL

echo "Done. Set DATABASE_URL / MIGRATION_DATABASE_URL then run: npm run migrate"
