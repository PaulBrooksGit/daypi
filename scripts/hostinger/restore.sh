#!/usr/bin/env bash
# Restore a pg_dump custom file onto a target database URL (scratch/pilot only).
#   DUMP=./.data/backups/daypi-....dump TARGET_DATABASE_URL=... ./scripts/hostinger/restore.sh
set -euo pipefail

DUMP="${DUMP:-}"
TARGET="${TARGET_DATABASE_URL:-${MIGRATION_DATABASE_URL:-}}"

if [[ -z "${DUMP}" || ! -f "${DUMP}" ]]; then
  echo "DUMP=path/to/file.dump is required" >&2
  exit 1
fi
if [[ -z "${TARGET}" ]]; then
  echo "TARGET_DATABASE_URL (or MIGRATION_DATABASE_URL) required" >&2
  exit 1
fi

echo "Restoring ${DUMP} -> ${TARGET}"
echo "WARNING: this overwrites objects in the target database."
pg_restore --clean --if-exists --no-owner --role=daypi_migrator --dbname="${TARGET}" "${DUMP}"

echo "Restore finished. Run app health checks and a synthetic read before declaring success."
