# 009 — Plan

## Enfoque

Siete correcciones independientes, cada una con su test que falla primero, su diff mínimo y su commit,
siguiendo el protocolo de `specs/README.md` § corrección. Se enseña cada diff con la salida del test
antes y después; lo que el usuario rechace se revierte con `git revert`. Orden: primero lo que deja una
posición sin red con el bot vivo (F-33, F-35, F-02), después la contabilidad de órdenes (F-36, F-37),
después las puertas (F-91, F-13).

Alternativas descartadas:

- F-33 pasando a `STOPPED` con posición abierta: contradice el estado («parado» no puede tener una posición
  que el bot ya no vigila). `PAUSED` con motivo mantiene la vigilancia de liquidación.
- F-02 con un `LevelKind` nuevo (`FLATTEN`): exige enum en `shared`, Prisma y app; el índice 999 ya está
  reservado a cierres manuales en `reconcile.ts:82` y basta.
- F-35 solo con severidad CRITICAL (sin reponer antes de cancelar): deja la ventana sin stop; se hace lo
  segundo y, además, la severidad.
- F-91 mandando el stop sin revisar: un rechazo del venue por mínimo es CRITICAL desde F-32, pero un stop
  que **sí** cabe al mark y se vetaba al disparo es el caso común; revisar al mark lo arregla sin sonda.

## Ficheros afectados

| Fichero | Qué cambia | Tests que lo cubren |
|---|---|---|
| `apps/worker/src/engine/bot-runner.ts:1329-1340` (`STOP_AND_CLOSE`/`PANIC`), `:639-646` (kill-switch) | cerrar → confirmar → cancelar (incluido el stop); fallo → `cancelOwnOrders(true)`, `PAUSED`, CRITICAL | `bot-runner.spec.ts` «STOP_AND_CLOSE que no consigue cerrar…»; reescritura de `:847` |
| `packages/strategy-core/src/strategies/market-maker.ts:829-842`, `market-maker-v2.ts:1176-1189` | `makeCoid(botId, seq, 'TAKE_PROFIT', 999)` en el aplanado (el id del cierre manual; con kind `STOP_LOSS` el propio `withStopLoss` lo confundiría con la red) | `strategies.spec.ts` «el aplanado no reutiliza el id del stop» |
| `packages/strategy-core/src/stop-loss.ts:48` | mirar `desired.immediate` además de `orders` | ídem + `bot-runner.spec.ts` MM con `stopLossPct` y `CLOSE_ALL` |
| `apps/worker/src/engine/bot-runner.ts` (reconciliación: reemplazo del stop) | reponer antes de cancelar; `RETRYABLE` en `STOP_LOSS` → CRITICAL | `bot-runner.spec.ts` «un fallo al reponer el stop es CRITICAL» |
| `apps/worker/src/engine/bot-runner.ts:908-919` | `confirmOrder` en su propio `try`; reintento; `PENDING` + WARN | «una orden aceptada por el venue no se marca REJECTED…» |
| `apps/worker/src/engine/bot-runner.ts:877-882`, `bot-store.ts` | vencer `PENDING` sin `venue_order_id` a los 5 min; evento al vetar | «una fila PENDING huérfana no deja el nivel muerto…» |
| `packages/strategy-core/src/order-gate.ts` | `STOP_LOSS`: notional al mark | `order-gate.spec.ts` «stop de 10,5 USDC a −10 % sale» |
| `packages/strategy-core/src/common.ts:191-240` | ERROR `stopLossPct` ∉ (0,100), `maxDailyLossPct` < 0 | `strategies.spec.ts` sobre las siete vía registro |
| `docs/*.md`, `specs/001-revision-integral/findings.md` | bloques F-NN, fichas «Decisión» | `comprobar-enlaces.cjs`, grep |

## Fases

| Fase | Qué | Criterio de salida |
|---|---|---|
| 0 | Rama desde `spec/008-guia-de-uso` (lineal); `pnpm build:packages`; baterías | verde |
| 1 | F-33: test rojo → diff → aprobación → commit `fix(worker): STOP_AND_CLOSE cierra antes de retirar el stop y no afirma lo que no hizo (spec 009 F-33)` | CA-1 |
| 2 | F-35 | CA-3 |
| 3 | F-02 (strategy-core + stop-loss) → `pnpm build:packages` → worker, backtest, typecheck app | CA-2 |
| 4 | F-36, F-37 | CA-4, CA-5 |
| 5 | F-91 (order-gate) → build → worker | CA-6 |
| 6 | F-13 parte (validateCommon) → build → api (DTO no cambia), worker, backtest, app | CA-7 |
| 7 | Cierre: docs (bloques), fichas del 001, índice, memoria | CA-8, CA-9 |

## Verificación

```bash
pnpm build:packages
pnpm --filter worker test -- bot-runner.spec.ts
pnpm --filter strategy-core test
pnpm --filter @crypton/backtest test
pnpm --filter app exec tsc -p tsconfig.app.json --noEmit
pnpm test && pnpm lint
grep -rn "F-33\|F-02\|F-35\|F-36\|F-37\|F-91" docs/
```

Manual (usuario, bot simulado con posición): «Parar y cerrar» → en la bitácora, `FILL` del cierre antes de
`ORDERS_CANCELED`, y `BOT_STOPPED`; con el simulador forzado a rechazar el cierre, `PAUSED` y un CRITICAL
que dice que la posición sigue abierta con el stop vivo.
