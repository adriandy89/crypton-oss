# 038 — Tareas

## Fase 0 — Línea base

- [x] Rama `spec/038-los-datos-que-faltan` desde `main` con el 037 ya mergeado
- [x] `pnpm build:packages` · `pnpm test` — resultado anotado

## Fase 1 — Tamaños del toque

- [x] `Ticker.bidSize` / `askSize` opcionales en `packages/shared/src/market.ts`
- [x] Hyperliquid: `l2Book.levels[i][0].sz` en `getTicker`, `sz` del `bbo` en el stream
- [x] Aster: `bidQty`/`askQty` en REST, `B`/`A` en el stream
- [x] Lighter: nada que hacer. No tiene fichero de tests propio; su `undefined` es estructural
- [x] Tests: presentes cuando el venue los da, `undefined` cuando no, sin lanzar

## Fase 2 — Funding

- [x] `Ticker.fundingRate` / `nextFundingAt` opcionales
- [x] Hyperliquid: `assetCtx.funding` (REST y `activeAssetCtx` en el stream); sin `nextFundingAt`
- [x] Aster: `lastFundingRate`/`nextFundingTime` en REST, `r`/`T` en el stream de marca
- [x] Tests de los dos caminos

## Fase 3 — Simulador y backtest

- [x] `DryRunAdapter` arrastra los cuatro campos de su fuente
- [x] `packages/backtest/src/ticks.ts` los deja `undefined`
- [x] `packages/backtest/src/warnings.ts` lo declara como hueco de paridad

## Fase 4 — Velas al motor

- [x] `Strategy.candles?: { interval; bars }` en `strategy-core/src/types.ts`
- [x] `BotContext.candles?: Candle[]` en `shared/src/bot.ts`
- [x] Caché compartida por `(venue, símbolo, intervalo)` en `MarketDataService`
- [x] `buildContext` las sirve solo a quien las declara, solo cerradas
- [x] Tests: N bots = 1 petición · las siete estrategias no piden ninguna · última vela cerrada

## Cierre

- [x] `pnpm test` · `pnpm lint` · `ng build` de la app
- [x] CA-6: ninguna orden de las siete estrategias se ha movido
- [x] `docs/venues-y-minimos.md` (o donde toque) dice qué venue publica qué
- [x] Índice de `specs/README.md`
- [x] Memoria de usuario
