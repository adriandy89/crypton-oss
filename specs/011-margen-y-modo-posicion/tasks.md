# 011 — Tareas

## Fase 0 — Línea base

- [x] Rama `spec/011-margen-y-modo-posicion` desde `main` (`9a10361`)
- [x] `pnpm build:packages`; baterías en verde

## Fase 1 — F-71 (veto de HEDGE en Aster) · `0a90bd2`

- [x] Decisión: vetar (opción a); `positionSide` queda para cuando alguien lo pida
- [x] Tests rojos: `strategies.spec.ts` «el modo cobertura se rechaza en Aster en los dos market makers»; `bot-runner.spec.ts` «un bot de Aster con cobertura guardada no cambia el modo de la cuenta»
- [x] Diff en `validateCommon` y en el arranque del runner · strategy-core 231, worker 285 · commit

## Fase 2 — F-34 (`AccountHandle`) · `ba9873a`

- [x] Tests rojos: `paper-accounts.spec.ts` «el handle expone el ajuste de margen y el modo de posicion cuando el adaptador los tiene», «y no los inventa cuando el adaptador no los tiene», «el ajuste de margen llega al adaptador e invalida lo cacheado del simbolo»
- [x] Diff: reexponer `adjustIsolatedMargin` y `setPositionMode` solo si el adaptador los tiene, con `finally { invalidate }` · commit

## Fase 3 — API: el capital sube con el acuse · `c0a65ca`

- [x] Tests rojos: `bots-margin.spec.ts` «el interruptor encendido viaja en el comando y NO toca el capital al encolar» y el bloque `onWorkerEvent` (suma con el acuse, no con el interruptor apagado, no dos veces, ignora otros eventos); `command-inbox.service.spec.ts` «el id del comando viaja en el payload»
- [x] Diff: `bots.service.ts` (`onModuleInit`, `onWorkerEvent`, payload con `countAsBotCapital`, sin subida al encolar), `command-inbox.service.ts` (`commandId`), `bot-runner.ts` (acuse con `commandId`) · api 4202, worker · commit

## Fase 4 — F-08 (idempotencia) · `7d3a702`

- [x] Tests rojos: `command-inbox.service.spec.ts` «no desreclama un comando cuyo worker sigue teniendo el lease del bot», «un comando que mueve dinero se marca ejecutado ANTES de correr», «los demas se marcan al terminar», «un comando que falla queda cerrado con el motivo»
- [x] Diff: `LeaseService.holder`, `CommandInbox.recoverStale(olderThanMs, holderOf)` y `execute`, `engine.service.ts` los usa · worker 290 · commit

## Cierre

- [x] Criterios de aceptación repasados (CA-1: `pnpm test`, `pnpm lint`, `pnpm --filter app build`)
- [x] Bloques F-34, F-71 fuera de `docs/`; fichas in-app de `positionMode` con la conducta nueva
- [x] Fichas del 001 («Decisión») y tabla de specs
- [x] Índice de `specs/README.md`: 011 `hecho`
- [x] Memoria de usuario
- [ ] CA-2 manual (usuario, bot simulado aislado con posición): «Aportar margen 10» → `MARGIN_ADJUSTED` con la liquidación antes y después; con «contar como capital», el capital asignado sube tras el acuse
