# 038 — Plan

## Enfoque

Tres piezas **independientes**, cada una con su fase y su commit: tamaños del toque, funding, y
velas para quien las declare. Se pueden parar en cualquier punto sin dejar nada a medias, porque
las tres son **aditivas y opcionales**: lo que no llega es `undefined`, y hoy nadie las lee.

### Decisiones de diseño

**Por qué opcionales y no `'0'`.** Un cero en `bidSize` es un libro sin compradores, que es un
estado real y distinto de «este venue no publica tamaños». Colapsarlos obligaría a cada consumidor
a adivinar cuál de los dos está viendo. `undefined` lo dice sin ambigüedad, y TypeScript obliga a
tratarlo.

**Por qué `nextFundingAt` absoluto.** El ticker se cachea un segundo, se guarda en `feed.last`, se
republica a Redis con 30 s de vida y lo lee un tick posterior. Un «faltan N ms» llegaría caducado
por construcción. Absoluto es además lo que publica el venue.

**Por qué las velas van por declaración y no por configuración.** Que las reciba quien las pide
—`Strategy.candles`, una constante del código, no un campo del usuario— mantiene intacto el
principio del motor para las siete estrategias actuales y hace imposible que un usuario encienda
por error un sondeo de velas en un bot que no las usa.

**Por qué solo cerradas.** `plan()` es pura por contrato. La vela en curso cambia dentro del mismo
minuto: entregarla haría que dos llamadas con el mismo estado dieran planes distintos.

**Alternativas descartadas.** (a) Un `MarketSnapshot` nuevo al lado del `Ticker`: duplica el
transporte, la caché y la republicación por no añadir cuatro campos opcionales a un tipo que ya
viaja por ahí. (b) Pedir el libro de Lighter con `orderBookOrders`: una petición por símbolo y
tick contra un cupo de 60/min por IP, que es justo el problema que el spec 036 acaba de aliviar.

## Ficheros afectados

| Fichero | Qué cambia | Tests |
|---|---|---|
| `packages/shared/src/market.ts` | `Ticker` + `bidSize`, `askSize`, `fundingRate`, `nextFundingAt` | — |
| `packages/shared/src/bot.ts` | `BotContext.candles?` | — |
| `packages/strategy-core/src/types.ts` | `Strategy.candles?` | `strategies.spec.ts` |
| `packages/exchange-core/src/adapters/hyperliquid.ts` | `getTicker` (l2Book `sz`, `assetCtx.funding`) y `streamTicker` (`bbo` `sz`, `activeAssetCtx`) | `hyperliquid.spec.ts` |
| `packages/exchange-core/src/adapters/aster.ts` | `getTicker` (`bidQty`/`askQty`, `lastFundingRate`/`nextFundingTime`) y el stream combinado (`B`/`A`, `r`/`T`) | `aster.spec.ts` |
| `packages/exchange-core/src/adapters/lighter.ts` | **nada**: no publica ninguno de los cuatro | `lighter.spec.ts` (que siga verde) |
| `packages/strategy-core/src/testing.ts` | `makeTicker` acepta los campos nuevos | — |
| `packages/backtest/src/ticks.ts`, `warnings.ts` | `undefined` declarado como hueco de paridad | `backtest` |
| `apps/worker/src/marketdata/market-data.service.ts` | caché de velas por `(venue, símbolo, intervalo)` | `market-data.spec.ts` |
| `apps/worker/src/engine/{bot-runner,account-hub.service}.ts` | `buildContext` sirve velas a quien las declare | `bot-runner.strategies.spec.ts` |

## Fases

| Fase | Qué | Criterio de salida |
|---|---|---|
| 0 | Línea base sobre `main` con el 037 ya dentro | Verde anotado |
| 1 | **R-1, R-3, R-4**: tamaños del toque en los tres adaptadores y el simulador | CA-1, CA-2 (tamaños), CA-3 (tamaños), CA-4, CA-5 |
| 2 | **R-2**: funding | CA-1, CA-2, CA-3 (funding) |
| 3 | **R-5**: simulador y backtest | El backtest declara el hueco |
| 4 | **R-6..R-9**: velas al motor | CA-7, CA-8, CA-9 |
| 5 | Cierre: índice, docs de venues, memoria | CA-6, CA-10 |

## Verificación

```bash
pnpm build:packages
pnpm test:adapters                        # el paquete que más se toca
pnpm test:strategies
pnpm --filter worker test
pnpm test:backtest
pnpm --filter api test                    # `shared` lo consume todo
pnpm lint
pnpm test
pnpm --filter app exec ng build           # el typecheck real de la app
```

**CA-6 es el criterio que protege a los bots en marcha** y se comprueba solo: los ~330 tests de
`strategy-core` fijan precios y cantidades concretos. Si alguno se mueve, es que este spec ha
cambiado conducta y no debía.

Sin sondas contra venues: los nombres de campo de Aster salen de su documentación oficial, citados
en `spec.md`, y los de Hyperliquid de los tipos del SDK instalado.
