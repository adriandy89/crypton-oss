# 009 — Protecciones y cierre: el stop y el botón rojo no dejan la posición sin red

Estado: `hecho` · Tipo: `cambio` · Rama: `spec/009-protecciones-y-cierre`

## Objetivo

Que ninguna acción del motor deje una posición **sin stop-loss ni aviso** cuando el usuario cree tenerlo:
el cierre de emergencia cierra antes de retirar el stop y dice la verdad si no pudo cerrar; el aplanado
del market maker sale; un fallo pasajero al colocar el stop se reintenta al instante y se grita si no sale;
una orden aceptada nunca se marca rechazada por un fallo de base de datos; una fila pendiente huérfana no
veta un nivel para siempre; el tamaño mínimo del stop no lo deja fuera; y la API no acepta un
`stopLossPct` imposible. Hecho: los diez tests nuevos pasan y los dependientes siguen en verde.

## Contexto

Hallazgos Altos y Medios del spec 001 (`specs/001-revision-integral/findings.md`) que afectan a la red de
una posición abierta en bots **en marcha**, agrupados por la revisión del spec 008
(`specs/008-guia-de-uso/informes/revision-estrategias.md`). Ninguno cambia un valor por defecto ni la
semántica de un parámetro; todos son diffs pequeños en el motor, `strategy-core` y `order-gate`.

| F | Título | Sev. | Efecto que tenía |
|---|---|---|---|
| F-33 | `STOP_AND_CLOSE` y el kill-switch cancelaban el stop **antes** de cerrar y afirmaban haber cerrado | Alta | Si el cierre fallaba: posición abierta, sin stop, bot `STOPPED` y evento «posición cerrada a mercado» |
| F-02 | El aplanado por `limitAction` del market maker reutilizaba el coid del stop inyectado | Alta | Con `stopLossPct`, «Cerrar todo» / «Apagar» **nunca** cerraban |
| F-35 | El reemplazo del stop no era atómico y un `RETRYABLE` al recolocarlo se registraba en INFO | Alta | Hasta minutos sin stop, sin aviso visible |
| F-36 | `confirmOrder` fallido marcaba `REJECTED` una orden que el venue había aceptado | Alta | Órdenes vivas invisibles para `PAUSE`/`PANIC` |
| F-37 | Una fila `PENDING` huérfana vetaba su `clientOrderId` para siempre y en silencio | Alta | Un nivel (incluida la entrada base) que nunca se volvía a colocar |
| F-91 | El stop se revisaba en `order-gate` al precio de disparo | Media | Posición de 10,5 USDC con stop al −10 % → sin stop y solo un WARN |
| F-13 (parte) | `validateCommon` no acotaba `stopLossPct` ni `maxDailyLossPct` | Media | `stopLossPct: 150` vía API → disparo ≤ 0 → sin stop |

## Alcance

- `apps/worker/src/engine/bot-runner.ts` (comandos terminales, `place()`, acuse, `PENDING` vencida,
  reintento del stop) y su spec.
- `packages/strategy-core/src/strategies/market-maker.ts`, `market-maker-v2.ts` (coid del aplanado),
  `stop-loss.ts` (mira también `immediate`), `order-gate.ts` (notional del stop al mark), `common.ts`
  (`validateCommon`), sus specs.
- `docs/`: bloques «Limitación conocida» de F-33, F-02, F-35, F-36, F-37, F-91 borrados; F-13 reescrito
  para la parte que sigue abierta. Fichas del 001 con su `Decisión`.

## Fuera de alcance

- F-47 (MARKET sin holgura en Lighter): spec `013-lighter-mercado-y-cupo`. El cierre que no cruza en
  Lighter seguirá sin cruzar; lo que este spec garantiza es que **no se afirme** que cerró y **no se
  retire el stop** antes.
- Reponer el stop **antes** de cancelar el viejo (parte de F-35): exige un id por encarnación del stop y
  toca la identidad de la reconciliación; se anota en la ficha para un spec posterior.
- F-34 (`ADJUST_MARGIN`, `positionMode`): spec 011, junto con F-71.
- El resto de F-13 (validador genérico sobre `meta.fields`): spec `019-validacion-y-parametros-muertos`.
- Cambios de `defaults()`, `meta.fields` o semántica de parámetros.

## Requisitos

- **R-1** (F-33) `STOP_AND_CLOSE`, `PANIC` y el kill-switch retiran la escalera **conservando el stop**,
  mandan el cierre y cancelan el stop solo con el acuse del venue. Si el cierre falla: el bot queda
  `PAUSED` (no `STOPPED`) con el motivo, y el evento es `ACTION_FAILED` CRITICAL con la coletilla de
  protección. Un cierre pedido a mano se salta la cuarentena por forma.
- **R-2** (F-02) El aplanado de los market makers usa el id del cierre manual (`TAKE_PROFIT#999`, índice
  reservado fuera de la escalera) y `withStopLoss` respeta también un stop emitido en `immediate`.
- **R-3** (F-35) Un fallo pasajero (`RETRYABLE`) al colocar el `STOP_LOSS` se reintenta de inmediato, una
  vez; si tampoco sale, el evento es CRITICAL en ese mismo tick.
- **R-4** (F-36) Un acuse positivo del venue nunca acaba en `rejectOrder`: si `confirmOrder` falla, se
  reintenta una vez y, si no, la fila queda `PENDING` con el `venue_order_id` conocido y un WARN
  (`ACTION_FAILED`).
- **R-5** (F-37) Una fila `PENDING` sin `venue_order_id` **vence** pasados 5 minutos (se marca `REJECTED`,
  `ORDER_RETRY` INFO) y el nivel se recoloca; una `PENDING` reciente sigue vetando.
- **R-6** (F-91) `revisarOrden` evalúa el mínimo de un `STOP_LOSS` con el notional al **precio de marca**
  que le pasa el runner, no al precio de disparo.
- **R-7** (F-13) `validateCommon` devuelve ERROR si `stopLossPct` ∉ (0, 100) o `maxDailyLossPct` ≤ 0;
  vacío o nulo siguen significando «sin stop» / «sin límite».

## Criterios de aceptación

- **CA-1** `bot-runner.spec.ts` «STOP_AND_CLOSE cancela el stop solo despues de cerrar» y «STOP_AND_CLOSE
  que no consigue cerrar no dice que ha cerrado» pasan (el primero sustituye al antiguo «se lleva el stop
  por delante»). ✅
- **CA-2** `strategies.spec.ts` «el aplanado no reutiliza el id del stop loss: los dos conviven» pasa en
  la V1 (la V2 comparte el bloque y el cambio). ✅
- **CA-3** `bot-runner.spec.ts` «un corte pasajero al colocar el stop se reintenta en el mismo tick» y
  «si tampoco sale al reintentar, se avisa en CRITICAL» pasan. ✅
- **CA-4** `bot-runner.spec.ts` «una orden aceptada por el venue no se marca REJECTED porque falle la
  base» pasa. ✅
- **CA-5** `bot-runner.spec.ts` «una PENDING sin acuse de hace mas de cinco minutos vence y el nivel se
  recoloca» y «una PENDING reciente sigue vetando» pasan. ✅
- **CA-6** `order-gate.spec.ts` «un stop de 10,5 USDC a -10 % sale aunque al disparo valga 9,45» y «sin
  precio de marca se sigue midiendo al precio de la orden» pasan. ✅
- **CA-7** `strategies.spec.ts` «validateCommon rechaza un stop loss imposible y una pérdida diaria no
  positiva, en las siete» pasa vía registro. ✅
- **CA-8** `pnpm test` desde la raíz en verde; `pnpm lint` 0 errores; typecheck de la app ok. ✅
- **CA-9** `grep -rn "F-33\|F-02\|F-35\|F-36\|F-37\|F-91" docs/` no devuelve bloques «Limitación
  conocida»; el de F-13 queda solo para los campos que siguen sin acotar. ✅

## Riesgos

- **Bots en marcha**: R-1 cambia el orden de `STOP_AND_CLOSE`; con el cierre en verde el resultado es el
  mismo. R-2 cambia el id del aplanado: el anterior nunca llegaba a salir. R-7 puede rechazar la edición
  de un bot que hoy tenga `stopLossPct ≥ 100` guardado (imposible desde la app).
- **Tests que fijaban conducta discutida**: `bot-runner.spec.ts` «STOP_AND_CLOSE se lleva el stop por
  delante» se reescribió con el nuevo test en rojo primero.
- **F-91 sin sonda firmada**: mitigación; si un venue mide el mínimo al disparo, su rechazo llega como
  CRITICAL (F-32) y no como silencio.

## Referencias oficiales

Ninguna regla de venue nueva. F-91 sigue «por confirmar por venue» (C-2 del 001).
