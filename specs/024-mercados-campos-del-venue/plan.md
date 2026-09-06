# 024 — Plan

## Enfoque

Protocolo de `specs/README.md`: test en rojo primero (API y worker), diff mínimo, un commit (un solo
hallazgo). Es el único spec de la tanda que toca `packages/db/prisma`, y lo hace con una migración
**aditiva**: cuatro columnas NULL, ninguna fila tocada.

Decisiones de diseño tomadas aquí:

- **Columnas, no constantes por venue.** Se valoró rellenar en `getSpec`/`marketSpec` lo que la fila no
  tuviera («Hyperliquid: 5 cifras», «Lighter: 30 órdenes»), pero dos de los cuatro campos son por
  mercado (`maintenanceMarginRate`, `maxMarketQty`) y no se pueden inventar; y la fuente de verdad ya
  existe (el adaptador) y ya se sincroniza cada diez minutos. Una sola fuente, un solo camino.
- **Opcionales de punta a punta.** `MarketSpec` ya los admitía ausentes; la app los declara opcionales en
  `Market` para convivir con un servidor sin actualizar; la fila los admite NULL para convivir con un
  catálogo sin sincronizar. Nada cambia hasta la primera sincronización tras desplegar.
- **La migración se escribe a mano** (sin base de datos en la sesión): un `ALTER TABLE … ADD COLUMN` por
  columna, el mismo formato que las anteriores. `prisma validate` y `prisma generate` la acompañan; el
  despliegue es `pnpm prisma:deploy`.

## Ficheros afectados

| Fichero | Qué cambia | Tests | Commit |
|---|---|---|---|
| `packages/db/prisma/schema.prisma`, `migrations/20260906130000_market_venue_fields` | cuatro columnas opcionales en `Market` | `prisma validate` | `6199b8e` |
| `apps/api/src/modules/markets/markets.service.ts` | `upsertAll` las escribe; `getSpec` y `list` las devuelven | `markets.service.spec.ts` (nuevo, 3) | `6199b8e` |
| `apps/worker/src/engine/bot-store.ts` | `marketSpec` las devuelve | `bot-store.spec.ts` (nuevo, 1) | `6199b8e` |
| `apps/app/src/app/core/{models/index.ts,utils/market-spec.ts}` | `Market` las declara; `toMarketSpec` las mapea | typecheck + lint de la app | `6199b8e` |

## Verificación

```bash
pnpm --filter @crypton/db build                       # prisma generate + tsc
pnpm --filter api test -- markets && pnpm --filter worker test -- bot-store
pnpm --filter app exec tsc -p tsconfig.app.json --noEmit
pnpm build:packages && pnpm test && pnpm lint && pnpm check:env
```

Manual, con la infra levantada (CA-2): `pnpm prisma:deploy`, esperar una sincronización (o `POST
/markets/sync` como ADMIN) y comprobar en `GET /markets` `max_significant_digits: 5` en un par de
Hyperliquid y `max_active_orders: 30` en uno de Lighter.
