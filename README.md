# Raven to Pandas - Key Broker Backend

Minimal backend built with **Elysia.js** on **Bun** to issue short-lived OpenRouter keys from a Management API key.

This service is intentionally **not** a translation proxy.
The mobile app calls OpenRouter directly for completions.

## What this backend does

- Issues one-time `challenge` values
- Exchanges a challenge for a short-lived `sessionToken`
- Creates OpenRouter API keys via Management API (`/api/v1/keys`)
- Revokes/rotates issued keys
- Exposes a cron reconciliation endpoint

## Why this design

- Lower latency: translation traffic does not pass through your backend
- Better security: Management key stays server-side
- Better abuse control: per-install key leasing, revocation, and rate limits

## Endpoints

Base prefix is configurable with `API_PREFIX` (default `/api/v1`).

- `GET /api/v1/health`
  - liveness check
- `POST /api/v1/challenge`
  - input: `{ installId, platform, appVersion? }`
  - output: `{ challengeId, nonce, expiresInSec }`
  - note: `platform` must be `android`
- `POST /api/v1/session/issue`
  - input: `{ challengeId, installId, platform, attestationToken }`
  - output: `{ sessionToken, expiresInSec, riskLevel }`
- `POST /api/v1/openrouter/lease` (Bearer session token)
  - input: `{ installId, reason: "bootstrap" | "refresh" }`
  - output: `{ apiKey, keyHash, expiresAt, rotateAfterSec }`
- `POST /api/v1/openrouter/revoke` (Bearer session token)
  - input: `{ keyHash, reason? }`
  - output: `{ revoked, keyHash, status }`
- `GET /api/v1/cron/reconcile` (Bearer cron secret)
  - expires keys and garbage-collects old challenge/session/rate-limit records

## Attestation mode

Current implementation supports two modes:

- `ENABLE_STRICT_ATTESTATION=true` (default): backend verifies Android tokens with Play Integrity API (`decodeIntegrityToken`)
- `ENABLE_STRICT_ATTESTATION=false`: basic token presence check

For iOS strict attestation, you can still delegate to `ATTESTATION_VERIFIER_URL`.

### Play Integrity policy

When strict mode is enabled on Android, backend validates:

- `requestPackageName` matches `PLAY_INTEGRITY_PACKAGE_NAME`
- `requestHash`/`nonce` matches the one-time challenge from `/challenge`
- token age (`PLAY_INTEGRITY_MAX_TOKEN_AGE_MS`) and clock skew (`PLAY_INTEGRITY_MAX_CLOCK_SKEW_MS`)
- `appRecognitionVerdict` is `PLAY_RECOGNIZED`
- device verdict includes one of `PLAY_INTEGRITY_ALLOWED_DEVICE_VERDICTS`
- optional licensing check (`PLAY_INTEGRITY_REQUIRE_LICENSED=true` requires `LICENSED`)

Local setup shortcut with service-account file:

```bash
PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON_PATH=./play-integrity
```

## Storage mode

By default, backend uses in-memory storage.

- Good for local development
- Not reliable for serverless production

For Vercel production, configure Upstash Redis:

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

When these vars are present, backend switches to Redis-backed stores.

For GCE VM with Docker, pick either SQLite (default) or Valkey (Redis fork, BSD) — see `docs/08-portabilidad.md`:

- `DATABASE_URL=sqlite:./data/org.db` — single file, WAL, no extra service
- `REDIS_URL=redis://:pass@valkey:6379` + `valkey` service in `docker-compose.yml` — parity with Upstash prod

Priority in `src/services/storeFactory.ts`: `Upstash → Redis/Valkey → SQLite → Memory`.

All stores implement the same `KeyBrokerStore` interface (`challenge`, `session`, `lease`, `rateLimit`, `invite`, `membership`) with atomic `takeInvite` (Lua on Upstash/Redis, `BEGIN IMMEDIATE` transaction on SQLite) and TTL-aware `cleanupExpired` for invites/memberships.

## Organization mode (membership & invites — Parte 02–04)

When `ORG_ADMIN_SECRET` is set, `/openrouter/lease` additionally requires an active membership. Organization flow:

1. Admin creates invite: `POST /api/v1/admin/invites` (Bearer `ORG_ADMIN_SECRET`)
2. Member joins: `POST /api/v1/organization/join { inviteCode, installId }` → creates membership `budgetCents=ORG_DEFAULT_BUDGET_CENTS`, `expiresAt = now + ORG_DEFAULT_TTL_DAYS`
3. Each successful lease increments `spentCents += ORG_COST_PER_GENERATION_CENTS` (default 5). When `spentCents >= budgetCents` the next lease returns `429 budget_exhausted` until refill.
4. Cron (`GET /api/v1/cron/reconcile` Bearer `CRON_SECRET`) expires `invite:*` and `membership:*` with `expiresAt < now` and cleans leases.

### Org env vars

- `ORG_ADMIN_SECRET` — required to enable org mode; Bearer token for all `/admin/*` routes (use `openssl rand -hex 32`)
- `ORG_ID` — logical org identifier (default `default`)
- `ORG_NAME` — display name returned in health
- `ORG_DEFAULT_TTL_DAYS` — membership TTL after join (default 30)
- `ORG_DEFAULT_BUDGET_CENTS` — budget per membership (default 100 = $1)
- `ORG_COST_PER_GENERATION_CENTS` — cost deducted per lease (default 5)
- `ORG_INVITE_TTL_DAYS` — invite TTL (default 7)
- `ORG_MAX_CHARS` — max input chars exposed to app (default 2000)
- `RATE_LIMIT_ADMIN_PER_MIN` — rate limit for `/admin/*` (default 60)
- `ENABLE_STRICT_ATTESTATION=false` by default for org (no Play Integrity service account needed; set `ATTESTATION_VERIFIER_URL` if strict required)

### Admin endpoints (all require `Authorization: Bearer $ORG_ADMIN_SECRET`)

- `POST /api/v1/admin/invites { ttlDays?:7, maxUses?:1, note? }` → `201 { code, codeHash, expiresAt, maxUses }` — `code` shown once, stored as `sha256(code)`. Batch: `?count=5` or body `count` (1..10)
- `GET /api/v1/admin/invites?status=&limit=50&cursor=` → `{ invites, total, nextCursor }`
- `DELETE /api/v1/admin/invites/:codeHash` — revokes unused invite; `codeHash` can be full sha256 or raw code
- `GET /api/v1/admin/members?status=&limit=50&cursor=` → `{ members, total, nextCursor }` — `installHash` truncated for privacy
- `GET /api/v1/admin/members/:hash` — single membership detail
- `GET /api/v1/admin/members/:hash/usage` → `{ budgetCents, spentCents, remainingCents, status, history:[{date,generations,spentCents}] }`
- `POST /api/v1/admin/members/:hash/refill { addCents:100, extendDays?:30 }` → resets `spentCents = max(0, spent - addCents)`, extends `expiresAt = max(expiresAt, now)+extendDays`, re-activates
- `POST /api/v1/admin/members/:hash/revoke { reason? }` → `status=revoked` + revokes active lease
- `GET /api/v1/admin/usage/summary` → `{ totalMembers, active, expired, revoked, totalSpentCents, totalBudgetCents, invitesPending }`
- `GET /api/v1/admin/export.csv` → `text/csv` with `installHash,orgId,joinedAt,expiresAt,budgetCents,spentCents,...` for billing

### Member endpoints

- `POST /api/v1/organization/join { inviteCode, installId, platform? }` → `200 { ok, installHash, orgId, expiresAt, budgetCents }` — `takeInvite` atomic via Lua (`Upstash`/`Redis`) or `BEGIN IMMEDIATE` (`Sqlite`)
- `GET /api/v1/organization/status?installId=` → `{ status, expiresAt, expiresInDays, budgetCents, spentCents, remainingCents }`

### Observability

- Structured logs: `[org] invite_created codeHash=…`, `[org] membership_joined`, `[org] membership_refill`, `[org] membership_revoked`, `[org] lease_blocked reason=budget|membership_*`, `[org] spent_increment`, `[org] cron_cleanup`, `[org] export_csv`
- Health: `GET /api/v1/health` now includes `org: { membersActive, membersTotal, invitesPending, invitesTotal, totalSpentCents, orgId, orgName, maxChars }`

### Rotación de ORG_ADMIN_SECRET sin invalidar membresías (punto 6)

`ORG_ADMIN_SECRET` solo autentica `Authorization: Bearer` en `POST /admin/*` (`src/plugins/auth.ts:40` `safeStringEqual`). **No** firma `membership` ni `lease`: las membresías se guardan como `membership:{installHash}` con `spentCents/budgetCents/expiresAt` en `brokerStore` (`src/services/store.ts:43`) y las sesiones usan `JWT_SIGNING_SECRET` (`src/config.ts:127`). Por eso rotar `ORG_ADMIN_SECRET` **no borra** invites canjeados ni membresías activas y no obliga a re-emitir códigos.

Procedimiento (GCE VM con Docker):

```bash
# 1. Generar nuevo secreto
openssl rand -hex 32  # → nuevo

# 2. Actualizar .env en OrgBackend/.env
# ORG_ADMIN_SECRET=<nuevo>
# (mantener ORG_ADMIN_SECRET_PREVIOUS opcional si necesitan ventana sin downtime — ver abajo)

# 3. Reiniciar (30s downtime aceptable para org pequeña)
docker compose up -d --build
curl -H "Authorization: Bearer <nuevo>" http://localhost:3000/api/v1/admin/usage/summary  # 200
curl -H "Authorization: Bearer <viejo>" http://localhost:3000/api/v1/admin/usage/summary  # 401

# 4. Verificar que membresías siguen: la app sigue con lease ok (GET /organization/status sigue activo)
```

Ventana cero-downtime (opcional, org grande): implementar `ORG_ADMIN_SECRET_PREVIOUS` en `src/config.ts` y `src/plugins/auth.ts:45` que acepte `safeStringEqual(token, secret) || safeStringEqual(token, previousSecret)` durante 5 min, luego quitar `PREVIOUS` y redeploy. No rotar `JWT_SIGNING_SECRET` a la vez (invalidaría `sessionToken` de miembros activos, forzarían re-`challenge` pero no pierden membresía). Documentado también en `docs/organizacion/parte-05-manual-usuario.md:7`.

## OpenRouter key management notes

This backend uses OpenRouter Management API documented here:
- https://openrouter.ai/docs/guides/overview/auth/management-api-keys

It creates keys using `POST /api/v1/keys` and disables keys with `PATCH /api/v1/keys/{hash}`.

## Local setup

1. Copy env file:

```bash
cp .env.example .env
```

2. Install dependencies:

```bash
bun install
```

3. Run local server:

```bash
bun run dev
```

4. Type-check:

```bash
bun run typecheck
```

## Vercel setup

Use this folder (`EdgeBackend/`) as the Vercel project root.

- `vercel.json` already includes:
  - Bun runtime (`bunVersion: 1.x`)
  - region `gru1`
  - `maxDuration` for `api/**/*.ts`
  - cron trigger for `/api/v1/cron/reconcile`

Configure these env vars in Vercel:

- `JWT_SIGNING_SECRET`
- `CRON_SECRET`
- `OPENROUTER_MANAGEMENT_KEY`
- `OPENROUTER_MANAGEMENT_BASE_URL` (default `https://openrouter.ai/api/v1`)
- `OPENROUTER_KEY_LIMIT`
- `OPENROUTER_KEY_LIMIT_RESET`
- `OPENROUTER_REQUEST_TIMEOUT_MS`
- `KEY_ROTATE_AFTER_SECONDS`
- `KEY_HARD_EXPIRES_SECONDS`
- attestation vars:
  - `ENABLE_STRICT_ATTESTATION`
  - `PLAY_INTEGRITY_PACKAGE_NAME`
  - `PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON` (recommended in production)
  - `PLAY_INTEGRITY_ALLOWED_DEVICE_VERDICTS`
  - `PLAY_INTEGRITY_REQUIRE_LICENSED`
  - `PLAY_INTEGRITY_MAX_TOKEN_AGE_MS`
  - `PLAY_INTEGRITY_MAX_CLOCK_SKEW_MS`
  - optional `PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON_PATH` (mainly local/dev, accepts file or directory with one JSON)
  - optional `ATTESTATION_VERIFIER_URL` (iOS strict fallback)
- optional durable store vars (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`)
- optional org vars (see “Organization mode” above): `ORG_ADMIN_SECRET`, `ORG_ID`, `ORG_NAME`, `ORG_DEFAULT_TTL_DAYS`, `ORG_DEFAULT_BUDGET_CENTS`, `ORG_COST_PER_GENERATION_CENTS`, `ORG_INVITE_TTL_DAYS`, `ORG_MAX_CHARS`, `RATE_LIMIT_ADMIN_PER_MIN`

## Security checklist

- Never ship `OPENROUTER_MANAGEMENT_KEY` to clients
- Keep `JWT_SIGNING_SECRET` and `CRON_SECRET` long and random
- Enable strict attestation before production scale
- Keep endpoint rate limits enabled
- Rotate or disable suspicious keys quickly via revoke + cron

## Implementation references

Elysia patterns were aligned with Context7 docs for `/elysiajs/elysia`:

- grouped routes
- schema validation with `t.Object`
- auth guard via plugin/derive
- cross-runtime fetch handler export for serverless
