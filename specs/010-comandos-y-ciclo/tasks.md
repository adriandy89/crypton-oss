# 010 — Tareas

Protocolo por corrección: test rojo → diff mínimo → enseñar diff y salida antes/después → tests del
paquete y dependientes → lint → un commit `fix(<área>): … (spec 010 F-NN)`.

## Fase 0 — Línea base

- [x] Rama `spec/010-comandos-y-ciclo` desde `spec/009-protecciones-y-cierre`
- [x] `pnpm build:packages`; baterías en verde

## Fase 1 — F-80 (take profit a mercado con disparador) · `f19567f`

- [x] Test rojo: `strategies.spec.ts` «con tpMode MARKET la salida es condicional: lleva disparador y no se ejecuta al colocarla»
- [x] Test rojo: `bot-runner.strategies.spec.ts` «la salida espera al objetivo en vez de cerrar la posicion en el acto»
- [x] Diff en `martingale.ts` · build → strategy-core 228, worker, backtest 26 · commit

## Fase 2 — F-84 (recentrar la retícula) · `ff5e6e0`

- [x] Test rojo: `bot-runner.spec.ts` «REANCHOR_GRID en Grid Classic con inventario se rechaza y conserva la venta», «… en la rejilla neutral se rechaza y remite a Precio ancla», «… en una martingala recentra y anota el margen que compromete»
- [x] Test rojo: `bots-reanchor.spec.ts` (API): exige `confirm` en escaleras, encola confirmado, rechaza fuera de ellas
- [x] Diff: `bot-runner.ts` (`REANCHOR_NO_APLICA` por estrategia; aviso con el margen), `bots.service.ts` (`confirm` y rechazo), `bot-commands.service.ts` (ocultar y confirmar), `bot-detail.page.ts` y `chart.page.ts` (pasan la estrategia)
- [x] Worker 65, API 15, app typecheck · commit
- [x] Decisión anotada: Neutral Grid **no** lee el ancla del ciclo (ver spec, R-2)

## Fase 3 — F-85 (adelantar seguridad) · `9efd193`

- [x] Tests rojos: «ADD_SAFETY_NOW sale a mercado al precio de marca, no al del escalon», «ADD_SAFETY_NOW sin acuse no anuncia SAFETY_ADDED»
- [x] Diff: precio de marca + evento según acuse · worker 67 · commit

## Fase 4 — F-86 (cooldown en caliente) · `495a3b0`

- [x] Test rojo: «reloadConfig HOT de cooldownMinutes se aplica al cerrar el ciclo»
- [x] Diff en `bot-runner.ts` (pasa el valor vigente) y `bot-store.ts` (lo usa para `cooldownUntil` y el scratch siguiente) · worker 68 · commit

## Fase 5 — F-92 (base LIMIT, una sola conducta) · `0caf764`

- [x] Tests rojos: «la base LIMIT no se recoloca al moverse el precio» (Martingala); «la base LIMIT de GridMart caduca y se recoloca al precio actual»
- [x] Diff: `ladder.ts` (`BASE_LIMIT_TTL_MS`, `baseLimitPrice`), `martingale.ts`, `gridmart.ts` · build → strategy-core 230, worker 281, backtest 26 · commit

## Cierre

- [x] Criterios de aceptación repasados uno a uno (CA-6: `pnpm test`, `pnpm lint`, `pnpm --filter app build`)
- [x] `grep -rn "F-80\|F-84\|F-85\|F-86\|F-92" docs/` → bloques borrados o reescritos; fichas in-app de `tpMode`, `baseOrderType`, `reanchorOnDrift` y `cooldownMinutes` actualizadas
- [x] Fichas del 001: «Decisión» y estado de la tabla de specs
- [x] Índice de `specs/README.md`: 010 `hecho`
- [x] Memoria de usuario actualizada
- [ ] Manual (usuario, bot simulado): Martingala con `tpMode: MARKET` no cierra hasta tocar el objetivo; «Recentrar» en una rejilla clásica → `ACTION_FAILED` con motivo; «Adelantar seguridad» → `SAFETY_ADDED` con el estado del acuse, o `ADD_SAFETY_SKIPPED`
