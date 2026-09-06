# 023 — Limpieza: docs desfasadas, tests que faltaban y menores por venue y estrategia

Estado: `hecho` (2026-09-06) · Tipo: `cambio` · Rama: `spec/023-limpieza-docs-y-tests`

## Objetivo

Cerrar el lote de hallazgos Bajos y Medios menores del 001 que quedaban: un `Number` en un camino de precio,
`Resume.MD` contando cosas que ya no existen, la ausencia de tests sobre el cuerpo de `placeOrder`, el tope
de cantidad de las órdenes a mercado de Aster, la naturaleza condicional que `VenueOrder` perdía, el precio
de referencia distinto entre la app y la API, y una lista de menores de Aster y de las estrategias. Lo que
exige una decisión de producto queda anotado como tal.

## Contexto

| F | Título | Sev. |
|---|---|---|
| F-19 | Mid de Binance calculado con `Number` | Baja |
| F-20 | `Resume.MD` y un comentario de `venue-weights.ts` desfasados | Baja |
| F-21 | Sin tests del cuerpo de `placeOrder`, de la firma de Aster ni del nonce de Lighter | Media |
| F-22 | Aster: se ignora `MARKET_LOT_SIZE`, más estrecho que `LOT_SIZE` | Media |
| F-23 | Aster: `MAX_NUM_ORDERS` 200 por símbolo no se modela | Media |
| F-29 | `VenueOrder` no distingue una orden condicional de una límite | Media |
| F-66 | La app previsualiza con `ticker.last` y la API con `ticker.mark` | Baja |
| F-79 | Aster, menores | Baja |
| F-94 | Grids, Martingale y TDCA, menores | Baja |

## Alcance

- `apps/worker/src/marketdata/price-source.service.ts`; `Resume.MD`; `packages/exchange-core/src/venue-weights.ts`;
  adaptadores `aster`, `hyperliquid` y sus specs; `packages/shared/src/{market,orders}.ts`;
  `apps/worker/src/engine/bot-runner.ts`; `apps/app/src/app/features/bots/bot-create.page.ts`;
  `packages/strategy-core/src/strategies/neutral-grid.ts`, `testing.ts`; `apps/app/src/app/core/content/martingale.guide.ts`.
- Tests: `price-source.service.spec.ts`, `hyperliquid.spec.ts`, `aster.spec.ts`, `bot-runner.spec.ts`,
  `strategies.spec.ts`.

## Fuera de alcance (decisiones del usuario o aceptadas, anotadas en las fichas)

- F-79: `ASSUMED_MAX_LEVERAGE = 50` (el real exige `leverageBracket` firmado), `Ticker.last` como mid (evita
  una petición más por ticker), `used` con `crossUnPnl`, `ACCOUNT_UPDATE`/`MARGIN_CALL` sin consumir.
- F-94: etiquetas `GRID_BUY`/`GRID_SELL` en corto (nombran el papel del nivel; documentado), el mínimo de
  `takeProfitPct` (0,05 %) y el valor de fábrica de `cooldownMinutes` en GridMart (valores de fábrica y rangos:
  decisión del usuario), el reloj del venue frente al del motor en TDCA (B-22), `targetLeverage` (F-12).
- F-21 en Lighter: la firma y el nonce ya tienen `lighter-signer.spec.ts` (spec 013); aquí se cubren los
  cuerpos de `placeOrder` de Hyperliquid y Aster.

## Requisitos

- **R-1** (F-19) El mid de Binance se calcula con `Decimal` y viaja como cadena exacta.
- **R-2** (F-20) `Resume.MD` deja de citar `reconciler.ts`, columnas de lease en `bots`, `stopRequested()`,
  «doce controles», «18 tablas» y `maxLeverage` solo al crear; el mapa de la API incluye los módulos y rutas
  que faltaban; el comentario de `venue-weights.ts` no cita una constante que no existe.
- **R-3** (F-21) Tests que construyen la petición de `placeOrder` de Hyperliquid (cuerpo enviado al SDK) y de
  Aster (parámetros firmados).
- **R-4** (F-22) `MarketSpec.maxMarketQty` (Aster: `MARKET_LOT_SIZE.maxQty`); el cierre a mercado del motor
  se trocea en órdenes de como mucho ese tamaño. (El campo llega al motor por la fila de `markets`: spec 024.)
- **R-5** (F-23) El tope de 200 órdenes por símbolo ya vive en `maxActiveOrders` (spec 013) y la vista previa
  avisa; el bloque de la guía se retira y la ficha lo cierra (las 10 condicionales: una por bot).
- **R-6** (F-29) `VenueOrder.triggerPrice`; Hyperliquid mapea `isTrigger`/`triggerPx` y el tipo real de la
  orden (`Stop Market` → MARKET con disparador) en las órdenes abiertas.
- **R-7** (F-66) La app manda a la API, como `refPrice`, el mismo precio con el que pintó la escalera: panel y
  servidor calculan sobre el mismo número. (La app no recibe el precio de marca en lote —el ticker de 24 h y el
  flujo en vivo traen el último negociado— y al crear el bot el servidor sigue usando la marca del venue.)
- **R-8** (F-79) Una orden no a mercado sin precio se rechaza antes de firmar; `-4047`/`-4048` al fijar el
  modo de margen no abortan el apalancamiento; el comentario sobre modificar órdenes dice la verdad.
- **R-9** (F-94) La banda de rearme de Neutral Grid es la mitad del **paso local** de cada línea (con espaciado
  geométrico el paso no es uniforme); la guía in-app de Martingala distingue margen y notional; el comentario
  de `testing.ts` no promete un uso que ya no existe.

## Criterios de aceptación

- **CA-1** Tests de R-1, R-3, R-4, R-6, R-8 y R-9 en verde; `pnpm test`, `pnpm lint`, `pnpm check:env`; typecheck
  y lint de la app.
- **CA-2** Las nueve fichas del 001 llevan la decisión; los bloques de F-23 y F-94 en `docs/` se retiran o se
  reescriben con lo que queda.

## Riesgos

- R-4 cambia cómo se cierra a mercado una posición mayor que el tope de Aster: antes el venue rechazaba la
  orden entera; ahora salen varias. Solo alcanzable con posiciones de millones de dólares.
- R-9 mueve el umbral de rearme de la neutral con espaciado geométrico: más pronto en las líneas juntas, más
  tarde en las separadas.

## Referencias oficiales

- Aster, `exchangeInfo` → `filters[]`: `MARKET_LOT_SIZE` («the quantity of MARKET orders»), `MAX_NUM_ORDERS`,
  `MAX_NUM_ALGO_ORDERS`.
- Hyperliquid, `frontendOpenOrders`: `isTrigger`, `triggerPx`, `orderType`.
