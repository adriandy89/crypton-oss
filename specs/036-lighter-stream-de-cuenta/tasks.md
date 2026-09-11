# 036 — Tareas

## Fase 1 — El canal

- [x] `LighterWsTrade` y `listaDe()`
- [x] `tradeToFill()` extraído de `getRecentFills`: una sola traducción para las dos vías
- [x] `subscribe(..., auth?)`, `authChannels` y `subscribePayload()` (token también al reconectar)
- [x] `ensureAccountStream()`, `emitTrade`, `emitOrder`, `symbolOfMarketId`
- [x] `accountStreamUp` mutable y `accountStreamDown()` enganchado a la salud del socket

## Fase 2 — Tests

- [x] Ocho casos en `lighter-transport.spec.ts` contra un `WebSocketServer` local
- [x] `pnpm test:adapters` y `pnpm test` en verde

## Fase 3 — Documentación

- [x] `docs/market-maker.md`: F-54 pasa de «limitación» a «resuelto», y se dice que la frase era falsa
- [x] `docs/buenas-practicas.md`, `venues-y-minimos.md`, `neutral-grid.md`, `market-maker-v2.md`
- [x] Guía de comprobación en el scratchpad (no entra en el repositorio)

## Cierre

- [x] Criterios repasados (CA-8 es manual del usuario)
- [x] Índice de `specs/README.md`
- [ ] **CA-8**: la comprobación con credenciales reales, del usuario
