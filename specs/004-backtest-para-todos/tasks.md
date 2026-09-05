# 004 — Tareas

Una casilla por tarea, agrupadas por fase. Se marcan al terminar, con una nota corta si hubo
sorpresas. Nada se da por hecho sin la verificación de su fase.

## Fase 0 — Línea base

- [x] Rama `spec/004-backtest-para-todos` creada desde `875526d`
- [x] Tests por paquete: `exchange-core` 265 + 3 rojos del 001, `backtest` 24, `worker` 266 + 2 rojos, `api` 4195; lint y build limpios

## Fase 1 — F-45: el simulador y las órdenes condicionales

- [x] Ocho tests en `exchange-core.spec.ts` («órdenes condicionales») que **fallaron** con el código de entonces: 8 de 8 en rojo, el resto de la suite intacto (confirmación, CA-1)
- [x] `dry-run.ts`: condicionales en reposo, disparo por marca, sentido por `intent` o por marca, fill al precio del disparador con taker y deslizamiento, stop antes que la liquidación si está por encima de ella (y nunca por debajo), estado con `triggerDir` opcional — `d6a48ce`
- [x] Suite de `exchange-core`: 273 en verde y los tres rojos deliberados del 001; ninguno nuevo
- [x] **Sorpresa**: `engine.ts` del backtest no pasaba `triggerPrice` ni `intent` al simulador, así que el replay habría seguido cerrando el stop en el acto. Corregido en el mismo commit; `engine.spec.ts` gana dos tests (26 en verde)
- [x] `pnpm --filter worker test` igual que la línea base (266 + 2 rojos del 001)
- [x] F-45 anotado en `specs/001-revision-integral/findings.md` (decisión: corregido en 004)

## Fase 2 — API para todos

- [x] `backtests` sin `RolesGuard`, acotado al usuario en `run/list/detail/fills/remove`; `admin/backtests` desaparece — `f27a5f4`
- [x] Tests del servicio: bot ajeno 404 (con el usuario en el `where`), ejecución ajena 404 sin leer sus fills, borrado ajeno inocuo, lista solo propia — 17 en verde
- [x] `pnpm --filter api test` y lint limpios

## Fase 3 — App

- [x] Pantalla movida a `features/backtest/` (`BacktestPage`), ruta `/backtest` con `authGuard`; enlaces en Cuenta (para todos) y en el detalle de un bot simulado (sin `esAdmin`) — `30b2ee1`
- [x] Reabrir una ejecución guardada: `detail()` + `fills()` recomponen el mismo `BacktestResult` que devuelve `run()`; la pantalla dice «guardada el …»
- [x] Tabla de las últimas 200 operaciones con «Copiar CSV» de todas las que llegaron (`aCsv` del 006)
- [x] Comparar dos ejecuciones guardadas: nueve métricas lado a lado, con la diferencia coloreada en el sentido «B mejor que A»
- [x] `pnpm --filter app build` sin avisos; lint limpio
- [ ] CA-5 a mano: reabrir pinta lo mismo que al lanzar

## Cierre

- [x] Criterios de aceptación repasados — CA-1, CA-2, CA-3, CA-4, CA-6 cumplidos; **CA-5 pendiente de la comprobación manual**
- [ ] Índice de `specs/README.md` a `hecho` — cuando CA-5 esté comprobado
- [x] Memoria de usuario actualizada
