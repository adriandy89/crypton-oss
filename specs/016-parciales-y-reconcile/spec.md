# 016 — Parciales y reconciliación: una ejecución a trozos no duplica la línea ni deja el escalón a medias

Estado: `hecho` (2026-09-06) · Tipo: `cambio` · Rama: `spec/016-parciales-y-reconcile`

## Objetivo

Definir y aplicar el contrato del parcial entre `plan()`, `reconcile()` y la contabilidad del ciclo: una
línea de tamaño fijo ejecutada a trozos se queda en el libro con su resto (no se cancela y recoloca entera),
un escalón se da por tomado cuando su orden se completa (no con el primer trozo), y el acumulado ejecutado de
una orden es la suma de sus ejecuciones, venga por el stream o por el barrido.

## Contexto

| F | Título | Sev. |
|---|---|---|
| F-83 | El contrato del parcial no está definido: una línea de tamaño fijo con un parcial se recoloca entera (1,0 con 0,3 ejecutado → 1,3) y, al revés, el primer trozo de una seguridad marca el escalón y el resto se cancela | Alta |
| F-17 | `syncOrderState` escribe el acumulado absoluto del venue y `recordFill` incrementa: el mismo trozo se contaba dos veces; `onFill` de la estrategia recibe un contexto sin posición | Media |

## Alcance

- `packages/strategy-core/src/reconcile.ts` (comparación de cantidad), `cycle-accounting.ts`
  (`levelComplete`).
- `apps/worker/src/engine/bot-store.ts` (`recordFill`, `applyFillToCycle`), `bot-runner.ts` (contexto de
  `onFill`).
- Tests: `apps/worker/src/engine/reconcile.spec.ts`, `packages/strategy-core/src/cycle-accounting.spec.ts`.

## Fuera de alcance

- Que el plan pida explícitamente «el resto» de una línea (otro contrato posible): con el criterio de abajo
  no hace falta y ninguna estrategia lo necesita hoy.
- Tests de `bot-store.ts` contra Prisma: el store no tiene arnés; la parte pura (reconciliación y
  contabilidad) queda cubierta y el cableado del store se revisa por lectura y typecheck.

## Requisitos

- **R-1** (F-83) Una orden viva coincide con la deseada si la cantidad pedida es igual a lo que **queda vivo**
  (salidas cuyo tamaño sale de la posición) **o** a la cantidad **original** (líneas de tamaño fijo). Solo si
  no casa con ninguna de las dos hay reemplazo.
- **R-2** (F-83) `cycleAfterFill` acepta `levelComplete` (por defecto verdadero): con un parcial, el escalón
  no se marca en `filledLevelIndexes` ni cuenta como entrada; la posición y el precio medio sí se actualizan.
  El store lo calcula con la fila de la orden (`filled_qty ≥ qty`) tras acumular el trozo.
- **R-3** (F-17) `recordFill` escribe como acumulado la **suma** de las ejecuciones del ledger (deduplicadas
  por id del venue), no un incremento: es idempotente aunque `syncOrderState` haya escrito antes el absoluto.
- **R-4** (F-17) El contexto de `onFill` lleva la posición real del venue.

## Criterios de aceptación

- **CA-1** `reconcile.spec.ts` «una linea de tamaño fijo con ejecucion parcial no se recoloca completa» y
  «si la cantidad deseada no casa ni con la original ni con el resto, se reemplaza» pasan; el test existente
  «compara contra lo que QUEDA vivo» sigue pasando.
- **CA-2** `cycle-accounting.spec.ts` «un parcial no marca el escalon ni cuenta la entrada; el trozo final
  si» pasa.
- **CA-3** `pnpm build:packages`; strategy-core, worker, backtest y `pnpm test`, `pnpm lint` en verde.
- **CA-4** Los bloques de F-83 en `docs/` se reescriben.

## Riesgos

- R-1 relaja el reemplazo: una configuración que cambie la cantidad de una línea a exactamente la cantidad
  original de una orden parcialmente ejecutada no se reemplazaría hasta que esa orden se complete. Es el
  caso de igualdad exacta y es benigno.
- R-2 cambia cuándo TDCA cuenta una compra: al completarse la orden (sus entradas son a mercado, así que
  en la práctica no cambia).

## Referencias oficiales

Ninguna regla de venue nueva: es el contrato interno entre plan, reconciliación y contabilidad.
