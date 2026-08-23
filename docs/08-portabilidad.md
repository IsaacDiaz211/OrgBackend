# 08 — Portabilidad (Parte 01 recortada)

> Cómo correr el mismo `OrgBackend` en Vercel y en una VM de GCE con Docker. SQLite por defecto, Valkey opcional.

## Modos de storage

Prioridad en `src/services/storeFactory.ts`:

1. **Upstash** si `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` → prod Vercel.
2. **Redis/Valkey** si `REDIS_URL` (ej `redis://:pass@valkey:6379`) → VM con servicio dedicado, paridad con Upstash.
3. **SQLite** si `DATABASE_URL=sqlite:./data/org.db` → VM simple, un archivo `./data/org.db`.
4. **Memory** si nada seteado → solo dev.

Default recomendado para VM sin ops: `DATABASE_URL=sqlite:./data/org.db` (no necesita `valkey`). Para paridad total con prod, descomentar `valkey` en `docker-compose.yml` y usar `REDIS_URL`.

## Opción A — GCE VM con Docker (recomendado para prueba)

```bash
# 1. Crear VM
gcloud compute instances create leyendolo-org --zone=us-central1-a --machine-type=e2-small --image-family=debian-12 --image-project=debian-cloud --tags=leyendolo --metadata startup-script='apt-get update && apt-get install -y docker.io docker-compose-plugin'

# 2. Abrir firewall
gcloud compute firewall-rules create leyendolo-3000 --allow tcp:3000 --target-tags=leyendolo

# 3. SSH
gcloud compute ssh leyendolo-org --zone=us-central1-a

# 4. En VM, clonar y configurar
git clone <tu-repo>/OrgBackend.git && cd OrgBackend
cp .env.example .env
# editar .env:
# JWT_SIGNING_SECRET=$(openssl rand -hex 32)
# CRON_SECRET=$(openssl rand -hex 32)
# OPENROUTER_MANAGEMENT_KEY=sk-or-...
# DATABASE_URL=sqlite:./data/org.db
# (o REDIS_URL=redis://:pass@valkey:6379 + VALKEY_PASSWORD y descomentar valkey)

docker compose up -d --build
curl http://localhost:3000/api/v1/health
```

Exponer con IP `http://35.x.x.x:3000` o Nginx + Let's Encrypt para `https://org.example.com`. Logs: `docker compose logs -f`. Actualizar: `git pull && docker compose up -d --build`.

SQLite usa `bun:sqlite` (WAL), no requiere `better-sqlite3`. Backup: snapshot de disco GCE incluyendo `./data/org.db`; con Valkey/Upstash el backup es del servicio.

## Opción B — Vercel

Setear `UPSTASH_REDIS_REST_URL/TOKEN` + envs de `.env.example` y `vercel --prod`. `api/[...all].ts` y `src/server.ts` comparten `src/app.ts`.

## Alternar SQLite ↔ Valkey

- **A SQLite**: `DATABASE_URL=sqlite:./data/org.db`, `REDIS_URL=` vacío, `valkey` puede quedar definido pero no usado (backend no lo requiere por `required: false`).
- **A Valkey**: descomentar `valkey` si estaba comentado, setear `REDIS_URL=redis://:VALKEY_PASSWORD@valkey:6379` y `VALKEY_PASSWORD`, `DATABASE_URL=` vacío o mantenerlo (factory prioriza `REDIS_URL`).

## Troubleshooting

- `curl /api/v1/health` no responde: `docker compose ps`, `docker compose logs backend`, verificar `PORT 3000` y firewall GCE.
- `bun:sqlite` error: requiere `oven/bun:1` (ya en `Dockerfile`); no instalar `better-sqlite3`.
