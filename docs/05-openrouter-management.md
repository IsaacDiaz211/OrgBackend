# Integración con OpenRouter Management API

El backend usa la **Management API** de OpenRouter para crear, limitar y revocar claves de API de forma programática. La clave maestra (`OPENROUTER_MANAGEMENT_KEY`) nunca sale del servidor.

## ¿Qué es la Management API?

OpenRouter ofrece endpoints administrativos bajo `/api/v1/keys` que permiten:
- Crear claves derivadas con límites de gasto
- Desactivar (disable) claves existentes
- Listar y monitorear uso

**Importante:** La Management Key **no** se puede usar para hacer chat completions. Es solo para administración.

## Diagrama de Creación de Key

```mermaid
sequenceDiagram
    participant A as App Android
    participant B as Backend
    participant OR as OpenRouter

    A->>B: POST /openrouter/lease<br/>Bearer: sessionToken<br/>{installId, reason}

    B->>B: Verifica sesión activa
    B->>B: ¿Existe lease activa?<br/>→ Elimina anterior (DELETE)

    B->>OR: POST /api/v1/keys<br/>Authorization: Bearer MANAGEMENT_KEY<br/>Content-Type: application/json<br/>Body: {<br/>  name: "r2p-abc123...-timestamp",<br/>  limit: 10,<br/>  limit_reset: "daily",<br/>  include_byok_in_limit: false<br/>}

    OR->>B: {<br/>  data: [{<br/>    key: "sk-or-v1-...",<br/>    hash: "abc123...",<br/>    label: "sk-or-v1-abc...",<br/>    name: "r2p-abc123...",
    limit: 10,<br/>    limit_remaining: 10<br/>  }]<br/>}

    B->>B: Guarda lease en store<br/>(installHash ↔ keyHash)

    B->>A: {<br/>  apiKey: "sk-or-v1-...",<br/>  keyHash: "abc123...",<br/>  expiresAt: "2026-05-13T...",<br/>  rotateAfterSec: 21600<br/>}
```

## Endpoints de la Management API Usados

### Crear Key: `POST /keys`

**Referencia:** `src/services/openrouter.ts:116-151`

Body enviado:
```json
{
  "name": "r2p-a1b2c3d4e5-1715539200000",
  "limit": 10,
  "limit_reset": "daily",
  "include_byok_in_limit": false
}
```

**Campos configurables vía env:**
- `OPENROUTER_KEY_NAME_PREFIX` (default: `r2p`) — prefijo del nombre
- `OPENROUTER_KEY_LIMIT` (default: `10`) — límite de créditos
- `OPENROUTER_KEY_LIMIT_RESET` (default: `daily`) — recuento: `daily`, `weekly`, `monthly`, `null`
- `OPENROUTER_INCLUDE_BYOK_IN_LIMIT` (default: `false`) — incluye BYOK en el límite
- `OPENROUTER_EXTRA_CREATE_PAYLOAD` — JSON extra para la petición

### Eliminar Key: `DELETE /keys/{hash}`

**Referencia:** `src/services/openrouter.ts:153-157`

El backend elimina permanentemente la key de OpenRouter mediante `DELETE /keys/{hash}`.

Esto **revoca y elimina** la key inmediatamente. Las peticiones subsiguientes con esa key fallarán con 401.

**Nota:** El método `disableKey` (PATCH) también existe pero ya no se usa. El backend prefiere `deleteKey` para mantener el dashboard limpio.

## Limitaciones y Comportamientos

### 1. Límite de Gasto por Key

OpenRouter asigna un **límite de créditos** (aproximadamente dólares) a cada key creada.

- **Default:** $10 (muy alto para una app individual)
- **No hay límite de requests:** solo límite monetario
- **El límite se resetea** según `limit_reset` (daily/weekly/monthly)

**Consideración de seguridad:** Un límite de $10 es excesivo si la key se filtra. Considera reducirlo:
```bash
OPENROUTER_KEY_LIMIT=1        # $1 por key
OPENROUTER_KEY_LIMIT_RESET=daily
```

**Nota:** El backend ahora **elimina** las keys en lugar de solo desactivarlas, lo que mantiene el dashboard limpio y evita acumulación.

### 2. No hay Expiración Nativa

Las keys de OpenRouter **no expiran automáticamente**. La columna "Expires" en el dashboard siempre muestra "Never".

El backend implementa expiración **local**:
- `KEY_HARD_EXPIRES_SECONDS` (default: 86400 = 24h)
- El cron job `/cron/reconcile` desactiva keys expiradas periódicamente
- La app recibe `rotateAfterSec` (default: 6h) como recomendación para renovar antes

```mermaid
graph TB
    subgraph "Expiración Local"
    A["Key creada<br/>createdAt = now"]
    B["expiresAt = now + 24h"]
    C["rotateAfter = now + 6h"]
    D["App solicita refresh<br/>antes de 6h"]
    E["Cron job cada 6h<br/>detecta expiradas"]
    F["DELETE /keys/{hash}"]
    A --> B
    A --> C
    C --> D
    B --> E --> F
```

### 3. Una Key por Instalación

El backend garantiza que cada `installHash` tenga **como máximo una key activa**:

```typescript
// src/app.ts:285-293
const activeLease = await brokerStore.getLeaseByInstall(installHash);
if (activeLease?.status === 'active') {
  await openRouterClient.disableKey(activeLease.upstreamHash);  // Revoca en OpenRouter
  await brokerStore.markLeaseRevoked(activeLease.keyHash);       // Marca local
}
```

### 4. Respuesta de la API

```json
{
  "data": [
    {
      "created_at": "2025-02-19T20:52:27.363244+00:00",
      "updated_at": "2025-02-19T21:24:11.708154+00:00",
      "hash": "abc123...",
      "label": "sk-or-v1-abc...123",
      "name": "Customer Key",
      "disabled": false,
      "limit": 10,
      "limit_remaining": 10,
      "limit_reset": "daily",
      "usage": 0,
      "usage_daily": 0
    }
  ]
}
```

## Variables de Entorno

```bash
# Obligatorio
OPENROUTER_MANAGEMENT_KEY=sk-or-v1-mgt-...

# Opcional (con defaults)
OPENROUTER_MANAGEMENT_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_KEY_NAME_PREFIX=r2p
OPENROUTER_KEY_LIMIT=10
OPENROUTER_KEY_LIMIT_RESET=daily
OPENROUTER_INCLUDE_BYOK_IN_LIMIT=false
OPENROUTER_REQUEST_TIMEOUT_MS=7000
KEY_ROTATE_AFTER_SECONDS=21600      # 6 horas
KEY_HARD_EXPIRES_SECONDS=86400      # 24 horas
OPENROUTER_EXTRA_CREATE_PAYLOAD={}  # JSON extra
```

## Referencias

| Concepto | Archivo | Líneas |
|----------|---------|--------|
| Cliente HTTP | `src/services/openrouter.ts` | 66-114 |
| Crear key | `src/services/openrouter.ts` | 116-151 |
| Eliminar key | `src/services/openrouter.ts` | 153-157 |
| Lease endpoint | `src/routes/openrouter.ts` | 12-98 |
| Revoke endpoint | `src/routes/openrouter.ts` | 99-136 |
| Cron reconcile | `src/routes/cron.ts` | 8-37 |
| Configuración | `src/config.ts` | 149-162 |
