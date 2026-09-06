# 023 — Plan

## Enfoque

Protocolo de `specs/README.md`: test en rojo primero, diff mínimo, un commit por hallazgo (F-21 son solo
tests y va aparte; F-20 es documentación y va aparte). Nueve hallazgos Bajos y Medios menores que no
cambian ningún valor de fábrica ni la semántica de un parámetro de usuario.

Decisiones de diseño tomadas aquí:

- **F-22: trocear, no vetar.** El tope de las órdenes a mercado se lleva a `MarketSpec.maxMarketQty` y el
  cierre a mercado del motor emite tantas órdenes como haga falta (índices 999, 998, …). Vetar el cierre
  habría dejado abierta justo la posición que el usuario quiere cerrar. Hoy el campo lo conoce el adaptador;
  la fila de `markets` que lee el motor lo guarda a partir del spec 024.
- **F-29: información, no decisión.** `VenueOrder.triggerPrice` es opcional y ningún consumidor cambia de
  conducta: el reconciliador sigue emparejando por `clientOrderId`. El evento del WebSocket de Hyperliquid
  trae la orden básica (sin tipo ni disparador), así que allí solo se conserva el reduce-only y se anota.
- **F-66: el mismo número en los dos lados.** La app no recibe el precio de marca en lote (el ticker de
  24 h y el flujo en vivo traen el último negociado); llevar la marca a `MarketTicker` habría tocado los
  tres adaptadores y el flujo para una Baja. Se manda `refPrice` con el precio que pintó el panel.
- **F-94: banda por paso local.** Con espaciado geométrico el paso no es uniforme; cada línea rearma a la
  mitad de la distancia a su vecina más próxima. Con espaciado aritmético no cambia nada.
- **F-79 y F-94, lo que queda.** Lo que exige una lectura firmada (`leverageBracket`), una petición más por
  ticker o una decisión sobre valores de fábrica se anota como aceptado o del usuario en la ficha.

## Ficheros afectados

| Hallazgo | Fichero | Qué cambia | Tests | Commit |
|---|---|---|---|---|
| F-19 | `worker/src/marketdata/price-source.service.ts` | mid con `Decimal`, `decimalOrNull` | `price-source.service.spec.ts` | `78ac4be` |
| F-21 | `exchange-core/src/adapters/{hyperliquid,aster}.spec.ts` | cinco tests del cuerpo de `placeOrder` | — | `911294c` |
| F-29 | `shared/src/orders.ts`, `exchange-core/src/adapters/hyperliquid.ts` | `triggerPrice`; tipo real y disparador en `getOpenOrders`; reduce-only en el WS | `hyperliquid.spec.ts` | `e7034d9` |
| F-22 | `shared/src/market.ts`, `aster.ts`, `worker/src/engine/bot-runner.ts` | `maxMarketQty`; `MARKET_LOT_SIZE`; cierre troceado | `aster.spec.ts`, `bot-runner.spec.ts` | `da174bb` |
| F-79 | `aster.ts` | precio obligatorio fuera de MARKET; `-4047`/`-4048`; comentario de `modifyOrder` | `aster.spec.ts` | `404948d` |
| F-94 | `strategy-core/src/strategies/neutral-grid.ts`, `testing.ts`, `app/.../martingale.guide.ts` | banda por paso local; textos | `strategies.spec.ts` | `19f47f5` |
| F-20 | `Resume.MD`, `exchange-core/src/venue-weights.ts`, `CLAUDE.md` | al día | enlaces | `2b8621a` |
| F-66 | `app/.../bot-create.page.ts` | `refPrice` en la vista previa del servidor | typecheck + lint de la app | `5c6b6ba` |
| F-23 | `docs/venues-y-minimos.md` | el bloque se retira; el tope ya vive en `maxActiveOrders` (spec 013) | enlaces | cierre |

## Verificación

```bash
pnpm --filter worker test && pnpm --filter exchange-core test && pnpm test:strategies
pnpm --filter app exec tsc -p tsconfig.app.json --noEmit && pnpm --filter app lint
pnpm build:packages && pnpm test && pnpm lint && pnpm check:env
node scratchpad/comprobar-enlaces.cjs docs README.md CLAUDE.md Resume.MD
```
