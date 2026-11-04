#!/usr/bin/env bash
# Dump DayPI Postgres (+ note storage path). Synthetic/pilot safe.
#   MIGRATION_DATABASE_URL=... BACKUP_DIR=/opt/daypi/data/backups ./scripts/hostinger/backup.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
if [[ -f "${ROOT_DIR}/.env" ]]; then
  # shellcheck disable=SC1091
  set -a
  source "${ROOT_DIR}/.env"
  set +a
fi

URL="${MIGRATION_DATABASE_URL:-${DATABASE_URL:-}}"
if [[ -z "${URL}" ]]; then
  echo "MIGRATION_DATABASE_URL or DATABASE_URL required" >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-${ROOT_DIR}/.data/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "${BACKUP_DIR}"
OUT="${BACKUP_DIR}/daypi-${STAMP}.dump"

echo "Writing ${OUT}"
pg_dump --format=custom --file="${OUT}" "${URL}"

if [[ -n "${STORAGE_LOCAL_ROOT:-}" && -d "${STORAGE_LOCAL_ROOT}" ]]; then
  TAR="${BACKUP_DIR}/daypi-storage-${STAMP}.tar.gz"
  echo "Archiving storage ${STORAGE_LOCAL_ROOT} -> ${TAR}"
  tar -czf "${TAR}" -C "$(dirname "${STORAGE_LOCAL_ROOT}")" "$(basename "${STORAGE_LOCAL_ROOT}")"
fi

echo "Backup complete. Verify restore on a scratch database before trusting RPO."
