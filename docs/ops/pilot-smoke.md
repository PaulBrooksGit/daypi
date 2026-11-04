# Pilot smoke script

Runnable synthetic path: **enrol → register → invoice sandbox → document sign → SMS sandbox**.

Script: [`scripts/pilot-smoke.ts`](../../scripts/pilot-smoke.ts)

```bash
npm run smoke:pilot
# or
npx tsx scripts/pilot-smoke.ts
```

## Prerequisites

1. Postgres migrated (`npm run migrate`) and optionally seeded (`npm run seed`).
2. API listening (default `http://127.0.0.1:3001`). Worker optional — the script uses `/v1/messages/:id/sandbox-send` so it does not wait on DayPush.
3. Env from `.env.example` (feature live flags **false**).
4. Seeded owner `owner-a@example.test` / `Passw0rd!dev` (or override via env below).

Against docker compose from `deploy/hostinger`:

```bash
docker compose -f deploy/hostinger/docker-compose.yml up -d --build
# wait for healthy API, then:
BASE_URL=http://127.0.0.1:3001 npm run smoke:pilot
```

## What it exercises

| Step | APIs (all synthetic) |
| --- | --- |
| Auth | `POST /v1/auth/login`, `POST /v1/auth/tenant/select` |
| Enrol | enquiry → child → guardian (with SMS phone) → relationship → enrolment |
| Register | session definition → dated session → booking → confirm → check-in |
| Invoice sandbox | billing account → draft invoice → issue → sandbox payment → Stripe sandbox webhook |
| Document sign | document → consent request → parent `signatures` |
| SMS sandbox | usage top-up → transactional SMS → sandbox-send → Twilio sandbox webhook |

No live Stripe or Twilio calls. Idempotency keys are unique per run.

## Environment overrides

| Env | Default |
| --- | --- |
| `BASE_URL` | `http://127.0.0.1:3001` |
| `SMOKE_OWNER_EMAIL` | `owner-a@example.test` |
| `SMOKE_OWNER_PASSWORD` | `Passw0rd!dev` |
| `SMOKE_PARENT_EMAIL` | `parent-a@example.test` |
| `SMOKE_PARENT_PASSWORD` | `Passw0rd!dev` |

`BASE_URL` hostname must appear in `ALLOWED_HOSTS` (default allowlist includes `127.0.0.1` and `localhost`).

Exit code `0` prints a JSON summary of created IDs; non-zero prints the failing step.
