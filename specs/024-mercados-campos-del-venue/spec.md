# 024 — Mercados: los campos del venue llegan a la fila de `markets`

Estado: `hecho` (2026-09-06) · Tipo: `cambio` · Rama: `spec/024-mercados-campos-del-venue`

## Objetivo

Que lo que el adaptador sabe del mercado y los specs 013, 014, 019 y 023 añadieron a `MarketSpec`
—`maxActiveOrders`, `maxSignificantDigits`, `maintenanceMarginRate`, `maxMarketQty`— llegue a quien toma
las decisiones: el motor, la API y la app leen el mercado de la **fila de `markets`**, y esa fila no
guardaba ninguno de los cuatro. En producción, las cuatro correcciones se quedaban en el adaptador.

## Contexto

Hallazgo de la revisión del spec 023 (2026-09-06), no listado en el 001:

- `apps/api/src/modules/markets/markets.service.ts` (`upsertAll`, `getSpec`, `list`),
  `apps/worker/src/engine/bot-store.ts` (`marketSpec`) y `apps/app/src/app/core/utils/market-spec.ts`
  (`toMarketSpec`) construyen el `MarketSpec` desde las columnas de `markets`, que son las de siempre.
- Consecuencias, por spec:
  - **014 / F-04** sigue vivo en el motor para Hyperliquid: la estrategia redondea al tick sin la regla de
    cinco cifras significativas (`px()` recibe el mercado de la base) y el adaptador sí la aplica
    (`formatPrice`, `maxSignificantDigits ?? 5`): 79 583,5 frente a 79 584, y el reconciliador ve dos precios
    distintos en cada tick.
  - **013 / F-50, F-23**: el WARN de la vista previa por retícula mayor que `maxActiveOrders` (Lighter 30,
    Aster 200) no se emite nunca desde la API ni desde la app.
  - **019 / F-93**: `maintenanceMarginRateOf` cae siempre en la regla por apalancamiento máximo; la tasa real
    de Lighter (`maintenance_margin_fraction`) se pierde. Para Hyperliquid la regla coincide con la realidad.
  - **023 / F-22**: `maxMarketQty` no llega al motor, así que el cierre troceado solo se activa con `maxQty`.

## Alcance

- `packages/db/prisma/schema.prisma` (modelo `Market`) y una migración aditiva; `packages/db` se regenera.
- `apps/api/src/modules/markets/markets.service.ts`; `apps/worker/src/engine/bot-store.ts`;
  `apps/app/src/app/core/{models/index.ts,utils/market-spec.ts}`.
- Tests: `markets.service.spec.ts` (nuevo), `bot-store.spec.ts` (nuevo, solo `marketSpec`).

## Fuera de alcance

- Rellenar por venue lo que la fila no tenga (constantes como «Hyperliquid: 5 cifras»): la fuente es el
  adaptador y la sincronización corre cada diez minutos; un despliegue sin sincronizar se comporta como
  hoy, ni peor ni mejor, y la primera sincronización lo arregla.
- `ASSUMED_MAX_LEVERAGE` de Aster (F-79, aceptado).

## Requisitos

- **R-1** `markets` gana cuatro columnas opcionales: `max_market_qty` (Decimal), `max_active_orders` (Int),
  `max_significant_digits` (Int), `maintenance_margin_rate` (Decimal). Migración aditiva, sin tocar filas.
- **R-2** La sincronización (`upsertAll`) escribe los cuatro campos desde el `MarketSpec` del adaptador;
  `getSpec` (API) y `marketSpec` (worker) los devuelven; `list` los incluye en su `select`.
- **R-3** La app los declara en `Market` (opcionales: un servidor sin actualizar no los manda) y
  `toMarketSpec` los lleva al `MarketSpec` con el que valida y previsualiza en local.

## Criterios de aceptación

- **CA-1** Tests de R-2 en verde (API y worker); `pnpm build:packages`, `pnpm test`, `pnpm lint`,
  `pnpm check:env`; typecheck y lint de la app.
- **CA-2** Tras `pnpm prisma:deploy` y una sincronización, `GET /markets` devuelve los cuatro campos para
  un par de Hyperliquid (`max_significant_digits: 5`) y de Lighter (`max_active_orders: 30`) — comprobación
  manual del usuario con la infra levantada.

## Riesgos

- La migración es aditiva (cuatro columnas NULL): segura con el sistema en marcha. Hasta la siguiente
  sincronización las columnas están vacías y todo se comporta como hoy.
- El motor de Hyperliquid, al recibir por fin `maxSignificantDigits`, dejará de recolocar en cada tick las
  órdenes de los pares con más de cinco cifras: es el efecto buscado, pero se notará en la bitácora como una
  recolocación única al cambiar el precio planificado.

## Referencias oficiales

Ninguna nueva: contratos internos. Las reglas de cada venue están en los specs 013, 014 y 019.
