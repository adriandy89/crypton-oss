# 009 — Tareas

Protocolo por corrección: test que falla por el motivo declarado → diff mínimo → tests del paquete y
dependientes → lint → un commit `fix(<área>): … (spec 009 F-NN)`. Los diffs se enseñan al usuario en el
cierre con la salida de cada test antes y después; lo que rechace se revierte con `git revert`.

## Fase 0 — Línea base

- [x] Rama `spec/009-protecciones-y-cierre` desde `spec/008-guia-de-uso` (`eaca059`)
- [x] `pnpm build:packages`; baterías en verde (strategy-core 223, worker 268, exchange-core 276, backtest 26, shared 73)

## Fase 1 — F-33 (STOP_AND_CLOSE / PANIC / kill-switch)

- [x] Test rojo: «STOP_AND_CLOSE que no consigue cerrar no dice que ha cerrado» (antes: sl-1 cancelado, sin CRITICAL)
- [x] Reescrito «se lleva el stop por delante» → «cancela el stop solo despues de cerrar» (antes: la última cancelación iba antes del cierre)
- [x] Diff: cancelar conservando el stop → cerrar → cancelar todo; fallo → `PAUSED`, `ACTION_FAILED` CRITICAL; `place()` devuelve el acuse; el cierre manual se salta la cuarentena
- [x] Worker en verde (57) · commit `6d4c734`

## Fase 2 — F-35 (reemplazo del stop)

- [x] Tests rojos: «un corte pasajero al colocar el stop se reintenta en el mismo tick» (1 intento) y «si tampoco sale al reintentar, se avisa en CRITICAL» (solo INFO)
- [x] Diff: reintento inmediato del `STOP_LOSS` en `RETRYABLE`; CRITICAL si tampoco sale. Reponer antes de cancelar queda fuera (ficha)
- [x] Worker en verde (274, suite completa) · commit `efaf9a8`

## Fase 3 — F-02 (aplanado de los market makers)

- [x] Test rojo: `strategies.spec.ts` «el aplanado no reutiliza el id del stop loss» (antes: `…SL0` en los dos)
- [x] Diff: `TAKE_PROFIT#999` en `market-maker.ts` y `market-maker-v2.ts`; `withStopLoss` mira `immediate`
- [x] `pnpm build:packages` → strategy-core 227, backtest 26, typecheck app ok · commit `2917523`

## Fase 4 — F-36 y F-37 (contabilidad de órdenes)

- [x] Test rojo F-36: «una orden aceptada por el venue no se marca REJECTED porque falle la base» (antes: `rejectOrder` llamado)
- [x] Diff F-36: `anotarAcuse` fuera del `try` del venue, reintento y WARN · worker 58 · commit `67a61bb`
- [x] Test rojo F-37: «una PENDING sin acuse de hace mas de cinco minutos vence y el nivel se recoloca» (antes: vetada) + guarda «una PENDING reciente sigue vetando»
- [x] Diff F-37: `PENDING_ORPHAN_MS` (5 min), `pendienteVencida`, `ORDER_RETRY` INFO · worker 60 · commit `846e81e`

## Fase 5 — F-91 (mínimo del stop al mark)

- [x] Test rojo: `order-gate.spec.ts` «un stop de 10,5 USDC a -10 % sale aunque al disparo valga 9,45» (antes: no compilaba: la firma no admitía el mark)
- [x] Diff en `order-gate.ts` (parámetro `markPrice`, solo para `STOP_LOSS`) y en `bot-runner.ts` (pasa `lastTicker.mark`) · commit `ea3c505`

## Fase 6 — F-13 (parte: `stopLossPct`, `maxDailyLossPct`)

- [x] Test rojo: «validateCommon rechaza un stop loss imposible y una pérdida diaria no positiva, en las siete» (antes: todo aceptado)
- [x] Diff en `common.ts` · strategy-core 227, backtest 26, typecheck app ok · commit `6115bca`

## Cierre

- [x] Criterios de aceptación repasados uno a uno (ver `spec.md`)
- [x] `docs/`: bloques de F-33, F-02, F-35, F-36, F-37 y F-91 borrados; §7 de `riesgo-y-liquidacion.md` y la tabla de comandos describen la conducta nueva; F-13 solo queda para los campos sin acotar
- [x] Fichas del 001: `Decisión` de F-02, F-13 (parcial), F-33, F-35 (mitigado), F-36, F-37, F-91 (mitigado)
- [x] Índice de `specs/README.md`: 009 `hecho`
- [ ] Memoria de usuario actualizada (al cerrar la tanda 008-010)
