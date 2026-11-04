-- Bootstrap roles + database for compose / VPS rehearsal (synthetic passwords only).
CREATE USER daypi_migrator WITH PASSWORD 'daypi_migrator_dev' LOGIN;
CREATE USER daypi_app WITH PASSWORD 'daypi_app_dev' LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE DATABASE daypi OWNER daypi_migrator;
GRANT CONNECT ON DATABASE daypi TO daypi_app;

\c daypi
GRANT USAGE ON SCHEMA public TO daypi_app;
GRANT CREATE ON SCHEMA public TO daypi_migrator;
ALTER DEFAULT PRIVILEGES FOR ROLE daypi_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO daypi_app;
ALTER DEFAULT PRIVILEGES FOR ROLE daypi_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO daypi_app;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
