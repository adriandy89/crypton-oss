# 016 — Tareas

- [x] Rama `spec/016-parciales-y-reconcile` desde `spec/015-liquidaciones-y-streams-por-venue`
- [x] Tests rojos: `reconcile.spec.ts` «una linea de tamaño fijo con ejecucion parcial no se recoloca completa», «si la cantidad deseada no casa ni con la original ni con el resto, se reemplaza»; `cycle-accounting.spec.ts` «un parcial no marca el escalon ni cuenta la entrada; el trozo final si»
- [x] Diff en `reconcile.ts` y `cycle-accounting.ts` · strategy-core 234 · `81fe4ab`
- [x] Diff en `bot-store.ts` (suma del ledger, `levelComplete`) y `bot-runner.ts` (posición en `onFill`) · build · worker 298 · backtest 26 · `b575a62`
- [x] Cierre: bloques de F-83 fuera de `docs/`; fichas del 001; tabla; índice
- [x] `pnpm test`, `pnpm lint`, `pnpm check:env`
