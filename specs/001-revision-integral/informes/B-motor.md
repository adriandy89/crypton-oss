# Fase 4 — Línea B: el motor a prueba de fallos (R-4, B-1 … B-22)

Commit base `63e676f`. Revisión **estática y de solo lectura**: no se ha ejecutado nada, no se ha
tocado ni un fichero del repositorio. Todas las referencias son `fichero:línea` sobre ese commit.

Ficheros leídos íntegros: `apps/worker/src/main.ts`, `engine/engine.service.ts`,
`engine/bot-runner.ts` (2159), `engine/bot-store.ts` (1113), `engine/lease.service.ts`,
`engine/command-inbox.service.ts`, `engine/account-hub.service.ts`, `engine/credentials.service.ts`,
`engine/paper-state.store.ts`, `engine/retention.service.ts`, `libs/bus/bus.service.ts`,
`libs/budget/venue-budget.provider.ts`, `libs/audit/audit.service.ts`,
`marketdata/market-data.service.ts`, `marketdata/price-source.service.ts`,
`marketdata/watch.service.ts`, `notifications/notifier.service.ts`, `notifications/telegram-client.ts`,
`packages/strategy-core/src/{reconcile,stop-loss,order-gate,cycle-accounting}.ts`,
`packages/exchange-core/src/{venue-budget,rate-limit,ws,cooldown}.ts`. Consultados por partes:
los tres adaptadores (liquidación, nonce, cooldown, health), `types.ts`, `errors.ts`,
`precision.ts`, `schema.prisma` (`BotOrder`), `apps/api/src/modules/risk/risk.service.ts`,
`apps/api/src/modules/bots/bots.service.ts`, `docker/docker-compose.yml`, `apps/worker/.env.example`
y las cinco suites de tests indicadas.

Convención de severidad: la de `specs/README.md`. **Ninguna Crítica de este informe está
confirmada** (no se ha ejecutado ningún test): las que cumplen (1) y (2) van como
«Crítica (por confirmar)» con el test exacto que las confirmaría, tal y como manda la escala.

---

# 1. Los veintidós modos de fallo

## B-1 — Worker muerto a mitad de tick

**Qué hace el código.** `place()` escribe la fila ANTES de llamar al venue:
`bot-runner.ts:868` `upsertPendingOrder` → `:876` `adapter.placeOrder` → `:892` `confirmOrder`.
El veto de duplicados es `bot-runner.ts:861-866`: si existe fila con ese `client_order_id` y su
estado no es `CANCELED` ni `REJECTED`, se sale sin colocar (con la excepción `allowRefill` +
`FILLED`). La adopción reconstruye el ciclo desde la base (`bot-store.ts:1063` `ensureCycle`),
contrasta la cantidad con el venue (`bot-runner.ts:1469` `checkCycleAgainstVenue` →
`bot-store.ts:1008` `repairCycleFromVenue`) y barre ejecuciones diez minutos hacia atrás
(`bot-runner.ts:463`, `FILL_BACKFILL_MS` en `:73`). `reconcile` reconoce las órdenes propias por
`venue_client_id` leído de la base (`bot-store.ts:242` `ownVenueClientIds`, `bot-runner.ts:579`,
`reconcile.ts:143-171`).

Los dos huecos concretos:

- **Muerte entre `:868` y `:876`** (la orden NO salió): queda una fila `PENDING` sin
  `venue_order_id`. Nada la vence: no hay ningún barrido de `PENDING` en el worker ni en la API
  (`grep 'PENDING'` solo aparece en `bot-store.ts:227,260,328,381` y `bots.service.ts:600`, todos
  lectura o filtro). En el siguiente tick, `reconcile` mete ese nivel en `toPlace` —no está en el
  libro— y `place()` lo veta en `:862` **sin emitir un solo evento** (`return` desnudo en `:864`).
  El nivel queda muerto para siempre dentro de ese `cycleSeq`. Solo lo cura una ruta que llame a
  `cancelOwnOrders` → `markCoidsCanceled` (`bot-store.ts:253`, que sí incluye `PENDING`): PAUSE,
  STOP_KEEP_POSITION, CANCEL_ALL_ORDERS, REANCHOR o una recarga WARM. Es decir: intervención manual.
  El mismo estado se alcanza sin morir el proceso, y por un camino más frecuente: `rejectOrder`
  (`bot-store.ts:356-363`) es *best-effort* (`.catch(() => undefined)`), así que un hipo de la base
  durante un rechazo deja también la fila en `PENDING`.
- **Muerte entre `:876` (aceptada) y `:892`**: la orden vive en el venue y la fila queda `PENDING`
  con `venue_client_id`. Al readoptar, `ownVenueClientIds` la incluye, `reconcile` la reconoce como
  propia y la deja o la cancela según el plan; si era una `MARKET` inmediata, el barrido de fills la
  concilia (`recordFill` la encuentra por `venue_client_id`, `bot-store.ts:430-439`). **No se
  duplica exposición.** Este medio camino está bien resuelto.

**Qué debería.** El primer hueco necesita o bien vencimiento de las `PENDING` sin
`venue_order_id` pasado un tiempo (marcarlas `REJECTED` para que se recoloquen), o bien que
`place()` emita un evento cuando veta por fila viva, para que el hueco deje de ser invisible.

**Veredicto: hallazgo (B-1).** Severidad **Alta**: escalera incompleta y silenciosa, sin pérdida
directa. La segunda mitad, **OK**.

**Test propuesto.** `apps/worker/src/engine/bot-runner.spec.ts`, «una fila PENDING huérfana no deja
el nivel muerto para siempre»: `build({orders:[level(0)], immediate:[]}, {findOrderByCoid: jest.fn()
.mockResolvedValue({status:'PENDING'})})`; `await runner.start()`; hoy `adapter.placed` está vacío y
`store.events` no contiene nada; se espera al menos un evento que lo explique.

---

## B-2 — Redis caído más de un TTL

**Qué hace el código.** `lease.service.ts:192-237`: `renewAll` corre cada `ttlMs/3` (`:96`, 10 s con
el TTL de 30 s). Si el `eval` falla y han pasado más de un TTL desde la última renovación
confirmada (`:215-216`), vacía `held` (`:222`), escribe una entrada de auditoría CRITICAL
(`:227-233`) y llama a `onLeaseLost` (`:234`). `engine.service.ts:73-82` responde soltando el
sandbox de simulación (`accounts.abandonPaper`, `:78`) y encolando el desenganche.

Presupuesto de caudal: `RedisVenueBudget.take` cae al presupuesto **en memoria** si el `eval` falla
(`venue-budget.ts:266-270`). Bus: `store.event` publica con `.catch(() => undefined)`
(`bot-store.ts:189-196`), así que la fila del evento se escribe igual y solo se pierde el empujón al
móvil. `tryLock` devuelve `false` sin Redis (`lease.service.ts:162-167`), así que la purga de
retención y el resumen diario simplemente no corren. `bus.cacheSet`/`cacheGet` del feed de precios
externo: la escritura está **dentro** del `try` de `poll` (`price-source.service.ts:296`), así que un
fallo de Redis incrementa `feed.failures` y fija `feed.cause` aunque el precio se haya obtenido bien
(`feed.last` ya se asignó en `:289`). Cosmético, pero contamina `status()`.

**Veredicto: OK** en lo esencial (soltar bots, presupuesto, bus). **Hallazgo menor (B-2)**,
severidad **Baja**: `price-source.service.ts:296` cuenta un fallo de Redis como fallo de la fuente.

**Test propuesto.** `apps/worker/src/marketdata/price-source.service.spec.ts`, «un fallo de Redis no
marca la fuente como caída»: `bus.cacheSet` que rechaza, `fetch` que responde bien → `status(key)`
debe ser `null`.

---

## B-3 — Base de datos caída

**Qué hace el código.** Dos políticas mezcladas y sin criterio único:

- Escrituras que **sí** propagan: `setStatus` (`bot-store.ts:133`), `touchTick` (`:158`), `event`
  (`:173`, el `create` no está capturado), `upsertPendingOrder` (`:309`), `confirmOrder` (`:345`),
  `saveSnapshot` (`:847`), `saveCycleScratch` (`:822`), `applyFillToCycle` (`:590`).
- Escrituras **best-effort** con `.catch(() => undefined)`: `markCoidsCanceled` (`:264`),
  `rejectOrder` (`:362`), `markOrderCanceled` (`:385`), `syncOrderState` (`:404`), `trackMmPeaks`
  (`:819`); en el inbox, `markExecuted` (`command-inbox.service.ts:87`), `markFailed` (`:102`),
  `releaseUnexecuted` (`:116`).
- `engine.service.ts:269-271`: `claimForBots(...).catch(() => new Map())`. Con la base caída, un
  PANIC encolado **parece «no hay comandos»** y no se distingue de la cola vacía.

Con la base caída, el tick falla en `touchTick`/`event` → `onTickError` (`bot-runner.ts:2093`) →
cinco ticks → `pauseForRisk` (`:2127-2131`), que a su vez es *best-effort*. El bot acaba pausado en
memoria pero su fila en `bots` puede seguir diciendo `RUNNING`.

Dos consecuencias contables concretas:

1. **`confirmOrder` fallido marca REJECTED una orden VIVA.** `bot-runner.ts:875-899`: si
   `placeOrder` tuvo éxito y `confirmOrder` (`:892`) falla por la base, el `catch` de `:896` ejecuta
   `rejectOrder` en `:899`. La fila dice `REJECTED`; la orden está en el libro. A partir de ahí
   `liveOrderCoids` (`bot-store.ts:223-233`, filtra `PENDING|OPEN|PARTIALLY_FILLED`) **no la
   devuelve**, así que un PAUSE o un PANIC no la cancelan. El comentario de `upsertPendingOrder`
   (`bot-store.ts:300-307`) promete justo lo contrario: «lo intolerable sería… haber mandado una
   orden sin ninguna constancia».
2. `rejectOrder` tragado deja la fila en `PENDING` → el veto permanente de B-1.

**Qué debería.** Distinguir «no pude escribir» de «no había nada»: `claimForBots` debe propagar (o
al menos avisar) y `confirmOrder` debe reintentar antes de declarar `REJECTED` una orden aceptada.

**Veredicto: hallazgo (B-3), severidad Alta** (error contable silencioso que alimenta una guarda y
deja órdenes fuera del alcance del PANIC). Confirma y amplía F-18.

**Test propuesto.** `bot-runner.spec.ts`, «una orden aceptada por el venue no se marca REJECTED
porque falle la base»: `store.confirmOrder` que rechaza; se espera que la fila NO acabe en
`rejectOrder` (o que se emita un evento distinto de `ORDER_REJECTED`).

---

## B-4 — WebSocket caído en silencio

**Qué hace el código.** Canal de salud separado del de datos: `ws.ts:88-90` `health()`, `:133-137`
(un `error` del socket **no** cierra el Observable) y `:139-149` (`close` → `scheduleReconnect`,
backoff exponencial con jitter, reinicio del backoff tras 60 s estables, `:147`). Los ganchos van
blindados (`ws.ts:154-160` `guard`), lo que evita que una excepción dentro de un manejador de `ws`
tumbe el proceso. El keepalive no propaga (`:169-178`).

En el runner: `fillsHealthy` arranca en `false` (`bot-runner.ts:327`) y solo lo pone a `true` un
evento `{stream:'fills', status:'UP'}` (`:1200`). `sweepFills` (`:1163-1178`) barre por REST si el
stream no está sano **en cada tick**, y uno de cada cuatro aunque lo esté (`FILL_SWEEP_EVERY_TICKS`
en `:70`). El techo de latencia es `RECONCILE_INTERVAL_MS` (15 s por defecto) más el jitter de
±10 % (`:517`). Los tres adaptadores emiten `stream:'fills'` (`hyperliquid.ts:969,979`,
`lighter.ts:1448,1454`, `aster.ts:937,945`).

**Veredicto: OK.** Es de lo mejor resuelto del motor.

---

## B-5 — Venue THROTTLED o WAF

**Qué hace el código.** `cooldown.ts`: al clasificar un corte se entra en enfriamiento de 60 s
(`CORTE_MS`, `:100`) o 120 s si es veto de IP (`BAN_MS`, `:107`), y `comprobar()` (`:51-61`) lanza
`THROTTLED` **sin tocar la red**. Está cableado en Aster (`aster.ts:268,273,334,337`) y Lighter
(`lighter.ts:511,514,532,535`); **no** en Hyperliquid. Presupuesto por IP con reserva del 20 % para
escrituras (`venue-budget.ts:122,245`). En `place()`, `THROTTLED` se relanza a propósito
(`bot-runner.ts:929`) para que el tick pare de insistir.

Matiz importante para F-08: durante el enfriamiento las llamadas fallan **al instante**, no
despacio. El enfriamiento no alarga la duración de un comando; lo que la alarga es
`VenueBudget.take`, que espera sin tope (`venue-budget.ts:135-143` y `:251-274`).

Pendientes que son de línea C pero afectan al motor: cancelaciones y `setLeverage` con prioridad
`read` (F-10), `SignerClient` de Lighter fuera del limitador.

**Veredicto: OK** en el motor (el cooldown existe, se respeta y no se insiste). El hueco de
Hyperliquid sin `VenueCooldown` y F-10 se dictaminan en la línea C.

---

## B-6 — Credencial revocada

**Qué hace el código.** `onTickError` (`bot-runner.ts:2093-2110`): con `kind === 'AUTH'` marca
`stopped`, escribe `ERROR` en la fila, emite `AUTH_ERROR` CRITICAL y pide el desenganche
(`:2108`). El motor lo suelta en `applyDetachments` (`engine.service.ts:153-167`) liberando el
lease. **Pero** el camino de reemplazo va envuelto en `safely()` (`:753`), que convierte el `AUTH`
relanzado por `place()` (`:929`) en un `ACTION_FAILED` de nivel WARN (`:2081-2091`). Ver el trazado
completo de F-06 en la sección 2.

En Hyperliquid las lecturas son públicas, así que una revocación solo se manifiesta al escribir: un
bot cuyo plan esté estable —nada que colocar— no se entera nunca.

**Veredicto: hallazgo (B-6) = F-06 confirmado por lectura.** Severidad **Alta**.

---

## B-7 — Orden rechazada por reglas o por fondos

**Qué hace el código.** Doble puerta: `revisarOrden` (`order-gate.ts:44-103`) antes de mandar
—distingue entrada inválida, imposible, «espera al mínimo» y «resto incerrable»— y, tras el
rechazo del venue, cuarentena **por forma** (`bot-runner.ts:822,826,845,905,916,964`;
`shapeOf` en `:976`). La cuarentena se levanta sola cuando cambia el precio o la cantidad, y se
limpia entera al cambiar de ciclo (`:1044`), al recargar configuración (`:1398`), en REANCHOR
(`:1307`), en REPAIR (`:1320`) y al cambiar la retícula del mercado (`:2002`). `RETRYABLE` NO entra
en cuarentena (`:931-953`) y tiene su propio tope (`MAX_PLACE_FAILURES = 20`, `:104`, `:947`).

**El agujero está en el STOP_LOSS**, que pasa por las mismas puertas que un nivel cualquiera. Ver
B-21 y el hallazgo B-21a.

**Veredicto: OK para la escalera; hallazgo para el stop-loss (ver B-21).**

---

## B-8 — Fill parcial y tardío

**Qué hace el código.** `recordFill` (`bot-store.ts:429-486`) deduplica por el índice único de
`venue_fill_id` (`:457-462`), **incrementa** `filled_qty` en la base (`:467-471`) y decide
`FILLED`/`PARTIALLY_FILLED` comparando con `qty` (`:473-483`). `syncOrderState`
(`bot-store.ts:389-405`) escribe el `filledQty` **absoluto** que dice el venue, por
`venue_client_id`. Las dos escriben la misma columna, llegan por el mismo WebSocket y **no hay
orden garantizado entre ellas**. `upsertPendingOrder` reinicia `filled_qty` a 0 al reencarnar un
coid (`:341`).

`onFill` construye el contexto de `strategy.onFill` degradado a propósito:
`this.buildContext(ticker, null, [], '0')` (`bot-runner.ts:1054`) — sin posición, sin órdenes y con
saldo cero.

Ver el trazado completo en la sección 2 (F-17), incluida una consecuencia nueva: un fill tardío de
la encarnación anterior de un coid reutilizado marca `FILLED` la encarnación **nueva**, que sigue
viva en el libro y desaparece de `liveOrderCoids`.

**Veredicto: hallazgo (B-8) = F-17 confirmado y ampliado.** Severidad **Alta**.

---

## B-9 — Liquidación total, parcial y de otro símbolo

**Qué hace el código.** Detección por venue:

| Venue | REST (`getRecentFills`) | WebSocket |
|---|---|---|
| Hyperliquid | marca (`hyperliquid.ts:539`) | marca (`:963`) |
| Aster | **no marca** (`aster.ts:560-570`, con el porqué escrito) | marca (`:980,998`) |
| Lighter | **nunca marca** (`lighter.ts:751-757`) | nunca |

En el runner, `onFill` (`bot-runner.ts:1018-1022`) exige **tres** condiciones antes de atribuir una
liquidación: que `recordFill` no la reconozca (`!coid`), la marca `fill.liquidation`, el símbolo
propio y que el ciclo crea tener posición (`cycle.averageEntry != null`). `recordLiquidation`
(`bot-store.ts:515-573`) crea una orden sintética `LIQUIDATION` con coid
`liq:<botShort>:<venueFillId>` y deduplica por la unicidad de `client_order_id` (`:519,570`);
deliberadamente **no** guarda `venue_order_id` (`:527-532`) para que el segundo trozo de la misma
liquidación no se cuele por el camino normal.

`afterLiquidation` (`:1091-1152`): pregunta al VENUE si la posición quedó plana (`:1108-1114`, con
respaldo en el ciclo si no contesta), cancela contra el venue conservando el stop mientras quede
posición (`:1125` `cancelOwnOrders(!plana)`), pausa y avisa **una sola vez** con testigo propio
(`liquidationAnnounced`, `:283`, `:1092-1093`, `:1137`), rearmado en RESUME (`:1244`).

Huecos: (a) una liquidación de Aster que solo llegue por el barrido REST no se contabiliza —está
documentado en `aster.ts:563-569` y es un `Fill` que `recordFill` descarta en silencio;
(b) Lighter nunca (F-05). En ambos casos la posición desaparece del venue y el ciclo sigue contando
la de antes hasta el siguiente `checkCycleAgainstVenue` —que solo corre al adoptar.

**Veredicto: OK en el motor** (dedupe, parcial, otro símbolo, aviso único, todo cubierto por tests
`bot-runner.spec.ts:1262-1550`). **Hallazgo en los adaptadores**: F-05 (Lighter) y el respaldo REST
de Aster.

---

## B-10 — Comandos: duplicado, huérfano, `recoverStale`, idempotencia

**Qué hace el código.** Bandeja duradera en `bot_commands`; el bus solo adelanta
(`engine.service.ts:525-539`, `command-inbox.service.ts:14-26`). El reclamo es un `updateMany`
condicional (`command-inbox.service.ts:66-70`), lo que cierra la carrera entre el aviso del bus y el
barrido. `markExecuted`/`markFailed` cierran siempre (`:84-103`). `releaseUnexecuted` devuelve a la
cola lo que este worker reclamó y no ejecutó (`:110-117`), y se llama al soltar un bot
(`engine.service.ts:164`) y al apagar (`:115-117`).

`recoverStale` (`command-inbox.service.ts:123-133`) **no filtra por `claimed_by`**: desreclama
cualquier comando reclamado hace más de `COMMAND_STALE_MS` (`engine.service.ts:31`, 120 s), esté o
no ejecutándose ahora mismo en este proceso. Ver el trazado de F-08 en la sección 2.

**Hallazgo nuevo y grave de este ítem: `ADJUST_MARGIN` no funciona en producción.** El runner
recibe siempre un `AccountHandle` (`engine.service.ts:467` → `account-hub.service.ts:235`), y
`AccountHandle` (`account-hub.service.ts:621-791`) **no implementa `adjustIsolatedMargin`**, que en
`ExchangeAdapter` es opcional (`packages/exchange-core/src/types.ts:223`). Por tanto
`bot-runner.ts:1901` `if (!adapter.adjustIsolatedMargin)` es SIEMPRE cierto y el comando lanza
«`<venue>` no permite ajustar el margen de una posición desde la API» en los tres venues, que sí lo
implementan (`aster.ts:745`, `hyperliquid.ts:748`, `lighter.ts:1333`). La API, mientras tanto,
valida el importe, comprueba el saldo libre y **sube el capital asignado del bot** si el usuario
marcó `countAsBotCapital` (`bots.service.ts:1038-1040` → `raiseAssignedCapital`, `:1130`). Resultado:
el margen nunca llega a la posición, el `total_investment` sí sube, y de ese denominador sale
`drawdownPct` (`bot-store.ts:885-890`) que alimenta el kill-switch. El test de
`bot-runner.spec.ts:1153-1259` pasa porque `FakeAdapter` **sí** declara el método (`:140-149`): el
fake tapa el fallo.

Lo mismo con `setPositionMode` (`types.ts:201`): `AccountHandle` tampoco lo tiene, así que
`bot-runner.ts:440` cae siempre por la rama del `else` y emite `POSITION_MODE_SKIPPED` diciendo que
el venue «no permite cambiar el modo de posición desde la API» — falso en Aster
(`aster.ts:766-770`). El campo `positionMode` de ambos market makers
(`market-maker.ts:386`, `market-maker-v2.ts:522`) es, hoy, un parámetro muerto.

**Veredicto: dos hallazgos (B-10a y B-10b).** B-10a (`AccountHandle` incompleto) severidad **Alta**;
B-10b (`recoverStale` global) = F-08, severidad **Media**.

**Tests propuestos.**
- `apps/worker/src/engine/paper-accounts.spec.ts` (ya monta `AccountHub` con dobles), test «el
  handle de la cuenta expone el ajuste de margen y el modo de posición del adaptador»: abrir un
  handle sobre un adaptador falso que declare ambos y comprobar
  `typeof handle.adjustIsolatedMargin === 'function'`. Hoy falla.
- `command-inbox` (fichero nuevo `apps/worker/src/engine/command-inbox.spec.ts`), «`recoverStale`
  no desreclama un comando que otro worker sigue ejecutando»: doble de `DbService` que registre el
  `where` del `updateMany` y comprobar que filtra por `claimed_by`. Hoy falla.

---

## B-11 — Dos workers (lease, TTL frente a la duración de un tick)

**Qué hace el código.** `acquire` con `SET NX PX` (`lease.service.ts:119-126`); liberación con
compare-and-delete en Lua (`:24-29`); renovación de todos los leases en un solo script y por lotes
de 200 (`:42-51`, `:201-211`). El punto clave: **la renovación vive en su propio `setInterval`**
(`:96`), independiente del tick del runner. Un tick largo —cuatro lecturas al venue, N colocaciones
con `withWriteRetry` y esperas de presupuesto sin tope— **no** impide renovar mientras el bucle de
eventos gire, porque todo son esperas de E/S. Solo se pierde el lease si Redis falla o si el bucle
se bloquea por CPU más de un TTL.

`dropLostLeases` (`engine.service.ts:175-185`) suelta el runner en cuanto `holds()` deja de ser
cierto, pero `runner.dispose()` (`bot-runner.ts:526-544`) **espera al cerrojo** (`:542`
`await this.gate`): un tick en vuelo termina de colocar su escalera aunque el lease ya sea de otro.
El `halted()` de `:793` mira `stopped` y `paused`, no el lease.

Esa ventana no produce exposición duplicada, y merece decirse: los `clientOrderId` son
deterministas (`makeCoid(botId, cycleSeq, kind, index)`), la fila se escribe antes de mandar y
`findOrderByCoid` veta (`:861`), así que el worker que llegue segundo se encuentra la fila y no
coloca; y si los dos pasaran el veto a la vez, el venue rechaza el coid duplicado. `reconcile` con
`ownIds` de la base reconoce la orden del otro como propia y la deja (`reconcile.ts:160-171`).

**Veredicto: OK.** Con una nota: la ventana de cerebro dividido está acotada por la duración del
tick y la cubre la idempotencia por coid, no el lease.

---

## B-12 — Lease perdido con bot simulado

**Qué hace el código.** `onLeaseLost` llama `accounts.abandonPaper(botId)` **antes** de encolar el
desenganche (`engine.service.ts:78-79`), y `dropLostLeases` hace lo mismo (`:181`).
`abandonPaper` (`account-hub.service.ts:468-478`) marca `abandoned`, tira lo sucio y cancela el
temporizador; `flushPaper` (`:434-453`) se niega a escribir si está abandonado (`:439`);
`release` (`:481-513`) guarda y **cierra** el simulador en el acto para que no se quede casando
órdenes solo. El `epoch` (`paper-state.store.ts:109-150`, `updateMany` con el epoch en el `WHERE`)
protege del reinicio de simulación, y `open()` descarta un sandbox ocioso cuyo epoch cambió
(`account-hub.service.ts:198-215`).

**Veredicto: OK.** Cubierto además por `paper-accounts.spec.ts:394-442`.

---

## B-13 — Bot borrado en marcha

**Qué hace el código.** `reconcileRunners` (`engine.service.ts:215-237`): si la fila del bot ya no
existe, llama `runner.emergencyCancelAll()` y deja constancia en la bitácora de actividad
(`audit.record`, `:225-233`, CRITICAL) — que no tiene clave foránea justo para esto.
`emergencyCancelAll` (`bot-runner.ts:1379-1384`) pausa y llama `adapter.cancelAll(symbol)`, cuyo
alcance real es de **cuenta entera en Lighter**; está asumido y escrito en `:1372-1378`.

**Veredicto: OK**, con la salvedad conocida del alcance de Lighter (semilla menor ya anotada en
`findings.md`).

---

## B-14 — Kill-switch global y guardas por tick

**Kill-switch.** `risk.service.ts:179-188`: `updateMany` a `STOPPING` sobre
`STARTING|RUNNING|PAUSED`. **No publica nada en el bus.** La latencia es la del barrido:
`ENGINE_SCAN_INTERVAL_MS` = 5 s (`engine.service.ts:86`), que lee el estado de sus runners
(`:196-255`) y lanza `STOP_AND_CLOSE`; los bots huérfanos los recoge `adoptPending`, que incluye
`STOPPING` a propósito (`:319`). A esos 5 s hay que sumar la espera del cerrojo del runner
(`handleCommand` → `exclusive`, `:1215-1217`), que puede ser un tick entero.

**Guardas por tick** (`checkRiskGuards`, `bot-runner.ts:1543-1657`), en este orden: apalancamiento
frente al tope del usuario (`:1552-1555`, se mira haya o no posición); notional por bot
(`:1558-1564`); notional total del usuario, al ritmo de la persistencia (`:1570-1577`); distancia a
liquidación con enfriamiento del aviso pero **no** de la acción (`:1579-1610`, y
`liquidationAction` con `ALERT|PAUSE|CLOSE_ALL` en `:1602-1608`); kill-switch de caída
(`:1613-1626`); pérdida diaria del usuario (`:1628-1635`); pérdida diaria por bot en % del capital
(`:1642-1654`). Todas menos `CLOSE_ALL` acaban en `pauseForRisk` (`:1665-1679`), que conserva el
stop (`cancelOwnOrders(true)`, `:1670`) y avisa en CRITICAL con `protectionNote`.

**El hueco: `STOP_AND_CLOSE` con el venue caído.** `runCommand` (`bot-runner.ts:1266-1277`) hace,
en este orden: `paused = true`; `cancelOwnOrders()` **sin** `keepProtective` —se lleva el stop por
delante—; `closePositionAtMarket()`; `setStatus('STOPPED')`; evento «Bot parado y posición cerrada
a mercado».

- Si el cierre **lanza** (`currentPosition` o `markPrice` fallan por red: `:2008`, `:2016`), la
  excepción sale de `runCommand` y la recoge `engine.service.ts:242-244` con un `logger.error`. No
  hay evento en `bot_events`. El bot se desengancha igualmente (`:245`) y el siguiente barrido lo
  readopta y reintenta: bucle cada 5 s. Mientras tanto, **posición abierta y sin stop**, porque la
  cancelación sí salió.
- Si el cierre **no lanza pero no coloca** —`revisarOrden` veta el resto por debajo del mínimo
  (`:840-851`), o el venue rechaza por reglas (`:904-914`)—, se ejecutan igualmente `:1271` y `:1272`:
  el bot queda `STOPPED` y el usuario lee **«Bot parado y posición cerrada a mercado»** con la
  posición abierta y el stop cancelado.

**Veredicto: hallazgo (B-14).** Severidad **Alta**, y roza la Crítica por el criterio (2)
«posición sin el stop-loss configurado»: es alcanzable con configuración válida (kill-switch o
`STOP_AND_CLOSE` durante un corte del venue) y no emite ningún evento CRITICAL. Falta (3).

**Test propuesto.** `bot-runner.spec.ts`, «STOP_AND_CLOSE que no consigue cerrar no dice que ha
cerrado»: `adapter.position = conPos()`, `adapter.placeError = new ExchangeError('RULES', …)`;
`await runner.handleCommand('STOP_AND_CLOSE')`; se espera que el evento final NO afirme el cierre y
que haya un evento de severidad CRITICAL. Hoy falla.

---

## B-15 — Cortacircuitos y cuarentena en memoria

**Qué hace el código.** `MAX_CONSECUTIVE_TICK_ERRORS = 5` (`bot-runner.ts:95`), aplicado en
`:2127-2131`; `markTickOk()` (`:2135-2138`) rompe la racha y también se llama en la rama del bot
pausado (`:622`), lo que es correcto: un bot pausado que habla con el venue está sano.
`MAX_PLACE_FAILURES = 20` (`:104`), contado por ORDEN y reiniciado con la primera colocación buena
(`:894`), cubre el agujero que abría la contención de errores: un venue devolviendo 503 para
siempre ya no tumba el tick, así que sin este tope el bot se quedaría «en marcha» sin colocar nada.

La cuarentena (`:338`) vive en memoria y se pierde al reiniciar: tras un relevo de worker, cada
nivel rechazado se reintenta una vez. Es el compromiso deliberado y está escrito.

**Veredicto: OK.**

---

## B-16 — Promesas sin `catch` y `unhandledRejection`

`main.ts:90-93` registra `unhandledRejection` → `stop()` → `process.exit(0)` (`:76`). Es decir:
**cualquier** promesa rechazada sin manejar mata el worker entero con todos sus bots. El inventario
completo está en la sección 2 (F-07). Lo relevante aquí:

- **`account-hub.service.ts:225` `void pending.finally(() => this.opening.delete(key))`.** La
  promesa `pending` sí se espera en `:227`, pero `pending.finally(...)` devuelve una promesa
  **derivada** que hereda el rechazo y no tiene manejador. Si `create()` (`:238-298`) falla —cuenta
  de exchange borrada (`credentials.service.ts:35` `findUniqueOrThrow`), sobre no descifrable
  (`:72`), `paperStore.load` con `findUniqueOrThrow` (`paper-state.store.ts:46`)— el worker entero
  se va abajo. Es el peor de la lista.
- `notifier.service.ts:130` `events$.subscribe((m) => void this.onEvent(m))`: `onEvent` espera
  `linkOf` (`:210`, consulta a `telegram_link`) y `botLabel` (`:229`, consulta a `bots`) **sin
  captura**. `TelegramClient.sendMessage` sí devuelve `false` en vez de lanzar (`telegram-client.ts:37-53`),
  así que el envío no es el problema; las dos consultas sí.
- `bot-runner.ts:1734` y `:1744`: `void this.event(...)` dentro de `acquireFairPrice`; `store.event`
  no captura el `create` (`bot-store.ts:180`).
- `engine.service.ts:81` y `:505`: `void this.applyDetachments()`. Hoy no rechaza —todo lo que
  espera dentro lleva su propia captura— pero es una garantía prestada.

**Veredicto: hallazgo (B-16), severidad Crítica (por confirmar)** por el punto de `account-hub`:
cumple (1) alcanzable en operación normal —un usuario borra una conexión de exchange con un bot
vivo— y (2) «caída del worker entero». Falta (3).

**Test propuesto.** `apps/worker/src/engine/paper-accounts.spec.ts`, «un fallo al abrir la cuenta no
deja un rechazo sin manejar»: instalar un `process.on('unhandledRejection')` en el test,
`credentials.openAdapter` que rechaza, `await expect(hub.open(...)).rejects.toThrow()`, esperar un
tick de la cola de microtareas y comprobar que el manejador no se disparó. Hoy falla.

---

## B-17 — `/health` y detección de atasco

**Qué hace el código.** `main.ts:35-46` sirve `/health` con 200/503 según `engine.status()`;
`engine.service.ts:586-591` cuenta runners cuyo `msSinceLastTick` supere cuatro latidos
(`RECONCILE_INTERVAL_MS × 4` = 60 s); `:610` `healthy: runners.size === 0 || stalled < runners.size`.

Tres problemas:

1. **Cero runners = sano.** Un worker que no puede hablar con la base (`adoptPending` falla y el
   error se traga en `scan`, `:137-138`) tiene cero runners y se declara sano indefinidamente.
2. **Todo o nada.** Solo se declara enfermo si están atascados TODOS los runners. Está razonado en
   `:603-609`, y para el contenedor es defendible; pero eso deja al `/health` sin señal alguna para
   el caso «199 de 250 atascados».
3. **El healthcheck no reinicia nada.** `docker/docker-compose.yml:280-289` define el healthcheck y
   `:197` `restart: unless-stopped`; en `docker compose` (fuera de Swarm) un contenedor *unhealthy*
   **no** se reinicia. El 503 es solo diagnóstico y no hay ningún `autoheal` en el compose.

**Veredicto: hallazgo (B-17), severidad Media.** Confirma la parte de `/health` de F-18.

**Test propuesto.** No hace falta test: es documentación más una decisión de despliegue. Basta con
que `healthy` sea `false` cuando `runners.size === 0` y el último barrido falló, y anotar en el
compose que el healthcheck no reinicia.

---

## B-18 — Apagado ordenado

**Qué hace el código.** `stop_grace_period: 45s` (`docker-compose.yml:201`) frente a
`SHUTDOWN_TIMEOUT_MS = 30_000` (`main.ts:8`): el tope propio llega antes que el SIGKILL, que es el
orden correcto. `app.enableShutdownHooks()` (`main.ts:31`). El orden de destrucción es el bueno y
está razonado: `EngineService.onModuleDestroy` cierra los runners (`engine.service.ts:103-119`) y
`LeaseService.onApplicationShutdown` libera los leases después (`lease.service.ts:110-116`), porque
Nest ejecuta `onModuleDestroy` antes de `onApplicationShutdown`. Los runners se cierran **sin**
cancelar órdenes (`:108-110`), que es lo correcto para un despliegue. Lo reclamado y no ejecutado
vuelve a la cola (`:115-117`). El sandbox de simulación se vuelca antes de cerrar adaptadores
(`account-hub.service.ts:146-155`) y también en cada `release` (`:502-512`).

Riesgo aceptado y escrito: si el cierre no termina en 30 s, `process.exit(0)` sin soltar leases y el
relevo cuesta un TTL (`main.ts:64-76`). Con 250 bots y esperas de presupuesto, es alcanzable.

**Veredicto: OK.**

---

## B-19 — Retención y crecimiento de tablas

**Qué hace el código.** `retention.service.ts`: `@Cron` horario detrás de un cerrojo de Redis
(`:49`, `:60`), por lotes de 5 000 con tope de 40 lotes por pasada (`:11-14`, `:138-146`), y con
criterio por gravedad en `bot_events` y `activity_log` (`:115-129`, `:87-101`). Purga
`bot_snapshots`, `bot_events` y `activity_log`. **No** purga `bot_orders`, `bot_fills` ni
`bot_cycles` — decisión deliberada y escrita (`:28-31`). Tampoco purga `bot_commands` ni
`bot_config_revisions`, y de eso no se dice nada: `bot_commands` crece con cada comando de usuario
para siempre.

**Veredicto: OK con hallazgo menor (B-19), severidad Baja**: `bot_commands` sin retención ni
mención.

---

## B-20 — `AccountHub`

**Qué hace el código.** Un adaptador por CUENTA en real y uno por BOT en simulación
(`account-hub.service.ts:185`), con una sola fuente de precios por venue+red compartida por todos
los simuladores (`:313-322`). Caché de un segundo con petición única en vuelo
(`:550-574` `shared`, TTL de `ACCOUNT_STATE_TTL_MS`, `:139`) e invalidación tras cada escritura
(`:604-609`, llamada desde `placeOrder`/`cancelOrder`/`cancelOwn`/`cancelAll`/`setLeverage` en
`:713-751` con `finally`, así que invalida también cuando la escritura falla). Single-flight en la
apertura (`:217-228`). Refcount con `close()` idempotente (`:785-790`) y cierre por inactividad con
30 s de gracia (`:515-535`), releyendo `refs` después de cada `await` (`:508`, `:529`) para no
cerrarle el adaptador a un bot que acaba de adoptarlo. En simulación el precio va al **adaptador de
la cuenta** y no al feed compartido, y está razonado (`:640-661`): el simulador casa órdenes en
reposo cuando le pasan precios.

**Lo que falta es lo de B-10a**: `AccountHandle` no reexpone los dos métodos opcionales del
adaptador (`adjustIsolatedMargin`, `setPositionMode`). Tampoco `streamCandles` ni `modifyOrder`,
pero esos no los usa el motor.

**Veredicto: OK salvo B-10a.**

---

## B-21 — Stop loss vivo

Trazado completo en la sección 2. Resumen:

- **Colocación**: `withStopLoss` (`stop-loss.ts:30-73`) lo inyecta en `desired.orders` cuando hay
  `stopLossPct` y posición no nula; el lado sale del SIGNO de la posición (`:50`), no de
  `cfg.direction`. Va como `MARKET` con `triggerPrice` (`:63-67`), así que el venue lo dispara
  aunque el motor esté caído.
- **Reemplazo**: no es atómico. `bot-runner.ts:751-762`: cancelar (`:754`) → marcar (`:759`) →
  colocar (`:760`), todo dentro de `safely()`. Y ocurre **con cada cambio de posición**, porque el
  `qty` deseado es `|position.qty|` y `reconcile` solo tolera medio step (`reconcile.ts:251-253`).
- **Conservación**: `keepProtective` (`bot-store.ts:223-233`) en PAUSE (`:1229`),
  STOP_KEEP_POSITION (`:1257`), REANCHOR (`:1306`), recarga WARM (`:1416`), `pauseForRisk` (`:1670`)
  y liquidación parcial (`:1125`). Correcto y con tests (`bot-runner.spec.ts:821-871`).
- **Cancelación**: STOP_AND_CLOSE, PANIC (`:1269`) y `CANCEL_ALL_ORDERS` (`:1251`).
- **`stopLossVivo`** (`:376`) empieza en `false` y solo lo pone a `true` un `confirmOrder` (`:895`);
  se apaga en cada veto (`:841`) y en cada fallo (`:898`). Alimenta `protectionNote` (`:1520-1526`),
  que solo se pega a los eventos de pausa/parada.

**Veredicto: dos hallazgos.**

- **B-21a — El stop-loss entra en cuarentena como un nivel cualquiera.** `place()` `:840-851` (veto
  de `revisarOrden`) y `:904-923` (RULES / INSUFFICIENT_FUNDS) meten el coid del stop en
  `this.quarantine` con su forma. Mientras la posición no cambie, la forma no cambia
  (`shapeOf` = `side:type:price:qty`, y precio y cantidad derivan de `position.entryPrice` y
  `position.qty`), así que **no se reintenta nunca**. El evento es `EXIT_PENDING_MIN_SIZE` INFO
  (`order-gate.ts:81-90`), `POSITION_BELOW_MINIMUM` WARN (`:95-103`) o `ORDER_REJECTED` WARN
  (`:906-912`). Ninguno CRITICAL. Peor: si ya había un stop vivo y el nuevo cae en cuarentena, el
  camino de `toReplace` **ya lo canceló** en `:754`. Severidad **Crítica (por confirmar)**: cumple
  (1) —una posición por debajo del mínimo del venue, un `PERCENT_PRICE` de Aster, un rechazo de
  reglas del trigger— y (2) «posición sin el stop-loss configurado». Falta (3).
- **B-21b — Reemplazo no atómico con `RETRYABLE` tragado.** En el camino de `toReplace`, si el
  `place()` posterior falla con `RETRYABLE`, `place()` lo maneja **dentro** (`:935-953`): emite
  `ORDER_RETRY` en **INFO**, incrementa `placeFailures` y devuelve normalmente, así que `safely()`
  ni se entera. La posición se queda sin stop y el único rastro es un INFO. El tope
  `MAX_PLACE_FAILURES = 20` puede tardar veinte ticks (≈5 min con el latido por defecto) en pausar
  el bot en una estrategia de pocas órdenes. Severidad **Alta**.

**Tests propuestos.**
- `bot-runner.spec.ts`, «un stop-loss rechazado por reglas no queda en cuarentena en silencio»:
  `configOver {stopLossPct:'10'}`, `adapter.position = conPos()`,
  `adapter.placeError = new ExchangeError('RULES','min notional')`; dos ticks; se espera un evento
  CRITICAL y un segundo intento. Hoy hay un solo intento y un WARN.
- `bot-runner.spec.ts`, «si el stop no se puede reponer tras cancelarlo, se avisa en CRITICAL»:
  plan con un stop vivo que cambia de cantidad para forzar `toReplace`,
  `adapter.placeErrorOnce = new ExchangeError('RETRYABLE','503')`; se espera que el evento no sea
  INFO. Hoy es `ORDER_RETRY` INFO.

---

## B-22 — Relojes

**Qué hace el código.**

- El motor usa `Date.now()` para `ctx.now` (`bot-runner.ts:1691`), para el cooldown de avisos
  (`:1589`, `:1822`) y para `markTickOk` (`:2137`).
- **Comparaciones cruzadas reloj local ↔ reloj del venue**: `currentTicker` compara
  `Date.now() - this.lastTicker.ts < TICKER_MAX_AGE_MS` (`:1958-1961`, 10 s) y `buildContext`
  hace lo mismo con `FAIR_PRICE_STALE_MS` (`:1696`); `MarketDataService.peek` con `STALE_MS`
  (`market-data.service.ts:264`, 20 s). Una deriva del venue **hacia adelante** hace pasar por
  fresco un precio viejo; hacia atrás, obliga a repedirlo. La primera dirección es la peligrosa:
  un cierre a mercado en Hyperliquid es una IOC a `precio × 1,05`.
- `this.lastFillTs = Date.now() - FILL_BACKFILL_MS` (`:463`) es un instante del reloj **local** que
  se manda como `sinceMs` a `getRecentFills`, que lo interpreta en el reloj del **venue**. A partir
  de ahí sí es coherente (`:1003-1005` avanza con `fill.ts`, del venue).
- **Nonce de Aster** (`aster.ts:211-219`): `Math.floor(Date.now()/1000) * 1_000_000 + contador`,
  con el contador reiniciado al cambiar de segundo (`:216-217`). La doc oficial exige una ventana de
  ±60 s frente al reloj del servidor: una deriva mayor tumba **todas** las llamadas firmadas de
  Aster. Y un salto de reloj **hacia atrás** (paso de NTP) puede devolver a un segundo ya usado con
  el contador a cero → nonce duplicado → rechazo, hasta que el reloj vuelva a pasar de largo.

**Veredicto: hallazgo (B-22), severidad Media.** No hay ninguna guarda de deriva ni ningún ajuste
contra el `serverTime` de los venues. El nonce de Aster no es monótono frente a saltos de reloj
hacia atrás.

**Test propuesto.** `packages/exchange-core/src/*.spec.ts`, «el nonce de Aster es estrictamente
creciente aunque el reloj retroceda»: `jest.spyOn(Date,'now')` devolviendo 1000, 1000, 999, 999 y
comprobar que los cuatro nonces son distintos y crecientes. Hoy falla.

---

# 2. Trazado de las semillas

## F-02 — El aplanado del market maker reutiliza el coid del stop inyectado

**CONFIRMO** (por lectura; falta el test).

Traza exacta:

1. `market-maker.ts:829-842` (y `market-maker-v2.ts:1176-1189`) meten en `desired.immediate` una
   `MARKET` reduce-only con `clientOrderId = makeCoid(botId, seq, LevelKind.STOP_LOSS, 0)` y
   `levelKind: STOP_LOSS`. Se dispara cuando el inventario toca el tope y `limitAction` es
   `CLOSE_ALL` o `SHUTDOWN` (`mm-shared.ts:389-417`); ambos son opciones válidas del formulario
   (`market-maker.ts:132-144`).
2. `bot-runner.ts:643` `this.withStopLoss(this.strategy.plan(ctx), position, cycleSeq)`.
   `stop-loss.ts:48` comprueba **solo** `desired.orders.some(o => o.levelKind === 'STOP_LOSS')`.
   El aplanado está en `immediate`, así que no lo ve y añade su propio `STOP_LOSS#0`
   (`stop-loss.ts:59`) — **el mismo `clientOrderId`, bit a bit**. `stopLossPct` es campo común de
   las siete estrategias (`common.ts:108-120`, HOT, min 0,1, max 90).
3. `bot-runner.ts:645-651`: el `scratchPatch` se persiste **antes** de ejecutar nada, y ese patch ya
   contiene `limitActionFiredAt` (`market-maker.ts:840`). Consecuencia: `alreadyFired` queda a
   `true` en la base aunque la orden no salga, y `mm-shared.ts:410` `flatten: !alreadyFired` no
   volverá a dispararla **en todo el ciclo**.
4. `execute()` (`bot-runner.ts:730-783`) recorre, en este orden: `toCancel` (`:739`),
   `toReplace` (`:751`), `toPlace` (`:769`) y por último `desired.immediate` (`:779-782`), este
   con `allowRefill` por defecto **`false`** (`place(order, 'inmediata')`, sin cuarto argumento).
5. El stop inyectado, que está en `desired.orders`, se coloca antes: o bien por `toReplace`
   (cancelar `:754` + `place(..., reusesOrderSlots === true)` `:760`; para MM v1 y v2
   `reusesOrderSlots` es `true`, `market-maker.ts:461`, `market-maker-v2.ts:773`) o bien por
   `toPlace` (`:771`). En cualquiera de los dos casos, al llegar al bucle de inmediatas la fila
   `STOP_LOSS#0` existe con estado `PENDING` u `OPEN`.
6. `place()` del aplanado: `:861` `findOrderByCoid('…SL#0')` → fila viva → `:862` la condición se
   cumple → `:863` `!(false && …)` → **`:864` `return`**. Sin evento, sin log, sin nada.

**¿Llega el aplanado al venue?** No, nunca, siempre que `stopLossPct` esté configurado y haya
posición — que son exactamente las mismas condiciones bajo las que se dispara. Y como
`limitActionFiredAt` ya está persistido, tampoco se reintenta.

**¿Puede sobrescribirse o cancelarse por error la fila del stop vivo?** No por este camino, porque
el veto corta antes de `upsertPendingOrder`. Sí en el caso raro de que la fila del stop esté
`REJECTED` o `CANCELED` en ese instante: entonces `place()` sigue, `upsertPendingOrder`
(`bot-store.ts:338-342`) **actualiza la misma fila** —`client_order_id` es `@unique`
(`schema.prisma:489`), así que el `upsert` pisa— cambiando `kind` a `MARKET`, reiniciando
`filled_qty` y borrando `closed_at`; luego `confirmOrder` (`:892`) sustituye el `venue_order_id`.
Además, como el aplanado declara `levelKind: 'STOP_LOSS'`, `bot-runner.ts:895` pone
`stopLossVivo = true` y `protectionNote` pasa a afirmar «El stop loss sigue vivo en el exchange»
cuando lo que salió fue un cierre a mercado; y `liveOrderCoids(…, {keepProtective:true})` lo
excluye, así que un aplanado atascado en `PENDING` no lo cancela ni un PAUSE.

**Consecuencia para el usuario.** Con `limitAction = CLOSE_ALL`: el tope de inventario se alcanza,
la nota dice «Tope de posición alcanzado: cerrando la posición» y **no se cierra nada**; el bot deja
de poner entradas y se queda con el inventario y su stop condicional. Con `SHUTDOWN` es peor:
`bot-runner.ts:672-676` ejecuta `STOP_KEEP_POSITION` después de `execute()`, así que el bot se
apaga —con `cancelOwnOrders(true)`, conservando el stop— y deja la posición abierta. El usuario
configuró «cerrar y apagar» y obtiene «apagar».

**Severidad propuesta: Alta.** No hay pérdida directa ni exposición duplicada, pero una acción de
riesgo configurada no ocurre. No llega a Crítica porque el stop-loss configurado **sí** queda vivo
(es literalmente el que ocupa el id).

**Test exacto** (`apps/worker/src/engine/bot-runner.spec.ts`, junto al bloque «reutilización de ids
por estrategia»):

```
it('el aplanado por limitAction sale aunque haya stop loss configurado', async () => {
  const flat: DesiredOrder = {
    clientOrderId: makeCoid(BOT_ID, 1, 'STOP_LOSS', 0),
    levelKind: 'STOP_LOSS', levelIndex: 0,
    side: 'SELL', type: 'MARKET', price: '100', qty: '10.000', reduceOnly: true,
  };
  const { runner, adapter } = build(
    { orders: [], immediate: [flat] },   // plan() falso, como el resto del fichero
    {},                                   // store por defecto: findOrderByCoid -> null
    { stopLossPct: '10' },                // withStopLoss inyectará SU STOP_LOSS#0
  );
  (runner as unknown as { strategy: { reusesOrderSlots?: boolean } }).strategy.reusesOrderSlots = true;
  adapter.position = conPos();            // 10 @ 100, LONG
  await runner.start();
  // Hoy: solo sale el stop inyectado (LIMIT/MARKET con trigger). Falta el cierre a mercado.
  const mercados = capturado.filter((r) => r.type === 'MARKET' && r.reduceOnly && !r.triggerPrice);
  expect(mercados).toHaveLength(1);
  await runner.dispose();
});
```

Fakes: los del propio fichero (`FakeAdapter`, `fakeStore`, `build`, `conPos`), más el envoltorio de
`adapter.placeOrder` que ya se usa en `bot-runner.spec.ts:898-902` para capturar las peticiones.
Con `store.findOrderByCoid` devolviendo `null` la primera vez y la fila del stop después, hace falta
un `fakeStore` con memoria; lo más limpio es reutilizar el `MemoryStore` de
`bot-runner.strategies.spec.ts:119`, que ya lleva las filas por coid.

**Propuesta de arreglo** (para el spec de corrección, no para aquí): índice 999 en el aplanado
—ya reservado para cierres manuales, `reconcile.ts:82`— y que `withStopLoss` mire también
`desired.immediate`.

---

## F-06 — `safely()` se traga `AUTH` y `THROTTLED` en el reemplazo

**CONFIRMO** (por lectura).

`safely` (`bot-runner.ts:2081-2091`) captura **todo**; si el mensaje casa
`/not found|unknown order|does not exist/i` calla (`:2088`), y si no, emite `ACTION_FAILED` en
**WARN** (`:2089`). Envuelve la cancelación suelta (`:741`) y **la pareja cancelar+colocar** del
reemplazo (`:753-761`). `place()` relanza a propósito `AUTH` y `THROTTLED` (`:929`); el camino de
`toPlace` (`:769-772`) **no** está envuelto, así que allí sí propagan hasta `onTickError`.
Inconsistencia deliberada por omisión.

**Qué error se traga y qué no, en el reemplazo:**

| Tipo | Dónde se maneja | Evento | ¿Se entera el motor? |
|---|---|---|---|
| `AUTH` | `place():929` lanza → `safely():2089` | `ACTION_FAILED` WARN | **No** |
| `THROTTLED` | ídem | `ACTION_FAILED` WARN | **No** |
| `RULES` | dentro de `place():904-914` | `ORDER_REJECTED` WARN + cuarentena | No hace falta |
| `INSUFFICIENT_FUNDS` | `place():915-923` | `INSUFFICIENT_FUNDS` ERROR + cuarentena | No hace falta |
| `RETRYABLE` | `place():935-953` | `ORDER_RETRY` **INFO** + `placeFailures++` | Solo tras 20 |
| resto | `place():964-971` | `ORDER_REJECTED` ERROR + cuarentena | No |
| fallo del `cancelOrder` de `:754` | `safely` | `ACTION_FAILED` WARN | No |

**Estado del bot tras un `AUTH` durante un reemplazo.** La cancelación de `:754` ya salió y la fila
está `CANCELED` (`:759`); el `place()` lanza; `safely` lo convierte en WARN. El bot **sigue
corriendo**, sin `stopped`, sin `setStatus('ERROR')`, sin desenganche, con el lease renovándose.
`stopLossVivo` sí se pone a `false` (`:898`) si la orden era el stop. En el **siguiente** tick la
orden faltará en el libro, entrará por `toPlace` (`:771`) —que no está envuelto— y entonces sí
llegará el `AUTH` a `onTickError` con su `AUTH_ERROR` CRITICAL y su desenganche. Es decir: **el
`AUTH` se retrasa un tick, no se pierde para siempre**. Un market maker que solo reemplace y no
tenga nunca nada en `toPlace` es el caso patológico, y ocurre: si todas las cotizaciones están en el
libro y solo cambian de precio, el plan es todo `toReplace`.

**Camino THROTTLED y enfriamiento del venue.** `place()` relanza; `safely` lo traga; el tick
continúa y sigue intentando reemplazos, pero cada intento choca contra
`VenueCooldown.comprobar()` (`cooldown.ts:51-61`) que lanza **sin tocar la red**. O sea: no se
alarga el castigo del venue —eso está bien resuelto— pero el bot pinta como sano durante los 60 s
(o 120 s si hubo veto de IP) y escribe un `ACTION_FAILED` WARN por cada orden y por cada tick. Con
ocho cotizaciones y latido de 15 s son 32 eventos WARN por minuto. Hyperliquid no tiene
`VenueCooldown` cableado, así que allí sí se sigue llamando.

**Severidad propuesta: Alta.** Coincide con la estimación de `findings.md`.

**Test propuesto** (`bot-runner.spec.ts`): «un AUTH durante un reemplazo detiene el bot»:
plan con una orden que exista en el libro con otro precio para forzar `toReplace`
(hay que devolver algo en `adapter.getOpenOrders` y en `store.ownVenueClientIds`),
`adapter.placeError = new ExchangeError('AUTH','clave revocada')`; se espera `detached` no vacío y
`store.events` con `AUTH_ERROR`. Hoy sale `ACTION_FAILED`.

---

## F-07 — Promesas sin `catch` que pueden tumbar el worker

Inventario completo de `void <promesa>` y de `.subscribe(cb)` con callback asíncrono en
`apps/worker/src` (excluidos los `.spec.ts`), con veredicto sobre si el rechazo puede llegar a
`main.ts:90`:

| Punto | Qué se lanza | ¿Puede rechazar sin manejar? |
|---|---|---|
| `account-hub.service.ts:140` `setInterval(() => void this.closeIdle())` | `closeIdle` | **No**: `flushPaper(...).catch()` (`:524`) y `adapter.close().catch()` (`:532`). |
| **`account-hub.service.ts:225` `void pending.finally(...)`** | promesa **derivada** de `create()` | **SÍ.** `pending` se espera en `:227`, pero la derivada de `.finally()` hereda el rechazo y no tiene manejador. `create()` rechaza si falla `paperStore.load` (`:264`, `findUniqueOrThrow`) o `credentials.openAdapter` (`:288`: `findUniqueOrThrow` sobre `exchange_accounts` en `credentials.service.ts:35`, `envelope.open` en `:72`, o `createAdapter`). |
| `account-hub.service.ts:347` `void this.savePaper(entry)` | `savePaper` | No: `run` lleva `.catch()` (`:398`) antes del `.finally()` (`:409`). |
| `account-hub.service.ts:503` `void this.flushPaper(entry).catch().then(...)` | cadena | No: `.catch()` delante y `adapter.close().catch()` dentro (`:510`). |
| `bot-runner.ts:467` `void this.exclusive(() => this.onFill(fill))` | `onFill` | No: `try/catch` completo (`:997-1076`). |
| **`bot-runner.ts:472` `void this.onOrderUpdate(order)`** | `onOrderUpdate` | **No**: `:1182` `syncOrderState(...).catch(() => undefined)` y `syncOrderState` ya lleva su propio `.catch` (`bot-store.ts:404`). Refuto este punto de la semilla. |
| **`bot-runner.ts:482` `void this.onStreamHealth(h)`** | `onStreamHealth` | **No**: el único `await` es `this.event(...).catch(() => undefined)` (`:1207`). Refuto este punto. |
| `bot-runner.ts:516` `setInterval(() => void this.exclusive(() => this.tick()))` | `tick` | Solo si `onTickError` lanzara. Único resquicio realista: `shortMessage(err.message)` (`:2116`) con un valor lanzado que no sea `Error` (`errors.ts:198` hace `message.replace`). Latente, muy improbable. |
| `bot-runner.ts:712` `void this.exclusive(async () => …tick())` | ídem | ídem. |
| **`bot-runner.ts:1734` y `:1744` `void this.event(...)`** | `store.event` | **SÍ.** `bot-store.ts:180` `db.botEvent.create` **no** está capturado (solo lo está la publicación al bus, `:196`). Se alcanza desde `acquireFairPrice` (`:1721`), llamada en `start()` (`:459`) y en `syncFairPrice` (`:1805`), cuando la fuente guardada ya no existe (`:1733`) o el worker no tiene feeds (`:1743`). Con la base caída, el worker entero se va. |
| `engine.service.ts:81` y `:505` `void this.applyDetachments()` | `applyDetachments` | **No hoy**: `runner.dispose().catch()` (`:162`), `releaseUnexecuted` con `.catch` interno (`command-inbox.service.ts:116`) y `leases.release` con `try/catch` (`lease.service.ts:130-137`). Garantía prestada: cualquier `await` nuevo sin captura lo rompe. |
| `engine.service.ts:87` `setInterval(() => void this.scan())` | `scan` | No: `try/catch/finally` (`:128-141`). |
| `engine.service.ts:527` y `:542` `.subscribe(cb)` síncronos | cuerpo del callback | Teórico: una excepción síncrona dentro del `next` de RxJS sale como `uncaughtException` (`main.ts:94`). Solo si el mensaje deserializado fuera `null`. Baja. |
| `engine.service.ts:536` `void this.drainCommands().catch(...)` | — | No. |
| `engine.service.ts:546` `void this.reloadConfig(...)` | `reloadConfig` | No: `try/catch` (`:555-573`). |
| `lease.service.ts:96` `setInterval(() => void this.renewAll())` | `renewAll` | No: `try/catch` (`:200-237`). |
| `libs/audit/audit.service.ts:56` `void this.db.activityLog.create(...)` | — | No: `.catch()` (`:69`). |
| `market-data.service.ts:377,394,454` `void this.bus…catch()` | — | No. |
| `market-data.service.ts:144,226` `.subscribe({next, error})` | — | No: hay `error`. |
| `price-source.service.ts:206,210,368` `void this.poll(key)` | `poll` | No: `try/catch/finally` (`:281-317`). |
| `price-source.service.ts:211` `void this.seed(key, feed)` | `seed` | No: `try/catch` (`:337-346`). |
| **`notifications/notifier.service.ts:130` `events$.subscribe((m) => void this.onEvent(m))`** | `onEvent` | **SÍ.** `onEvent` espera `linkOf` (`:157` → `db.telegramLink.findUnique`, `:210`) y `botLabel` (`:169` → `db.bot.findUnique`, `:229`), ninguna capturada. `sendMessage` **no** es el problema: devuelve `false` en vez de lanzar (`telegram-client.ts:37-53`). |
| `notifier.service.ts:139,188` `void this.flush(chatId)` | `flush` | No, por lo anterior. |
| `marketdata/watch.service.ts:59` `.subscribe(...)` | — | No: el manejador entero va en `try/catch` (`:66-91`), y el comentario de `:60-65` explica por qué. |
| `telegram-poller.service.ts:65,73,87` | — | Fuera del alcance de esta fase. |

**Veredicto global: CONFIRMO F-07**, con dos matices: (a) los dos puntos que la semilla citaba en
`bot-runner.ts:472` y `:482` están **bien protegidos** (REFUTO esa parte); (b) el punto más grave no
estaba en la semilla y es `account-hub.service.ts:225`.

---

## F-08 — `recoverStale` global y comandos no idempotentes

**CONFIRMO el mecanismo; matizo el impacto.**

`command-inbox.service.ts:123-133`: `updateMany({where: {executed_at: null, claimed_at: {lt: …}}})`.
Sin `claimed_by`, sin comprobar si el worker que lo reclamó sigue vivo (podría cruzarse con
`leases.heldBots()`, que existe en `lease.service.ts:170-172` y no lo usa nadie).
`engine.service.ts:136` lo llama en **cada** barrido con `COMMAND_STALE_MS = 120_000` (`:31`).
`markExecuted` se hace **después** de `handleCommand` (`:283-284`), así que la ventana es toda la
duración del comando.

**Ejecución at-least-once, paso a paso.** `drainCommands` reclama para los bots de este worker
(`:269-271`) y ejecuta en serie por bot (`:281-284`). `handleCommand` entra por `exclusive()`
(`bot-runner.ts:1215-1217`), así que **hace cola detrás del tick en curso**. Si el conjunto
(espera del cerrojo + ejecución) supera 120 s, `recoverStale` lo devuelve a la cola; el mismo worker
lo vuelve a reclamar en el barrido siguiente —sigue siendo el dueño del bot— y lo ejecuta otra vez.

**¿Es alcanzable superar 120 s?** Sí. `VenueBudget.take` espera **sin tope** (`venue-budget.ts:135-143`
y `:251-274`), y el caudal por defecto se deriva del cupo publicado: en Lighter son 60 peticiones por
minuto con el margen de `QUOTA_HEADROOM` (`venue-budget.ts:84-86`). Un tick son cuatro lecturas
(`bot-runner.ts:569-580`) más N colocaciones, cada una con `withWriteRetry` (3 intentos, esperas de
300 y 600 ms más un `verify()`, `rate-limit.ts:94-116`) o `withRetry` (4 intentos, hasta
250+500+1000 ms más los timeouts HTTP, `:62-79`). El enfriamiento del venue **no** cuenta: falla al
instante (`cooldown.ts:51-61`), así que ese cálculo de la semilla no aplica.

**Qué protege a cada comando ante una segunda ejecución:**

| Comando | Idempotente | Qué lo protege |
|---|---|---|
| `PAUSE`, `RESUME`, `CANCEL_ALL_ORDERS`, `STOP_KEEP_POSITION`, `REPAIR` | Sí | Naturaleza de la operación. |
| `STOP_AND_CLOSE`, `PANIC`, `CLOSE_NOW`, `TAKE_PROFIT_NOW` | Sí, dentro del ciclo | El cierre usa siempre `TAKE_PROFIT#999` (`bot-runner.ts:2027`) y `place()` lo veta por fila viva o ejecutada (`:861-866`, `allowRefill=false`). Si el primero cerró la posición, el segundo encuentra `CLOSE_SKIPPED` (`:2010`). |
| `REANCHOR_GRID` | Casi | El segundo reancla al mark de ese instante; efecto acotado. |
| **`ADD_SAFETY_NOW`** | **No** entre ciclos ni entre niveles | Dentro del mismo nivel lo veta `findOrderByCoid`. Pero si la primera ejecución llenó la seguridad #k, `plan()` devuelve la #k+1 (`:1344`) y la segunda ejecución **promedia otra vez**. Doble entrada no pedida. |
| **`ADJUST_MARGIN`** | **No** | Nada. `adjustMargin` (`:1894-1943`) transfiere sin marca. **Pero hoy es inalcanzable**: `adapter.adjustIsolatedMargin` es siempre `undefined` (ver B-10a), así que el comando lanza en `:1902`, `drainCommands` lo cierra con `markFailed` en milisegundos y nunca llega a envejecer. |

**Impacto real hoy: `ADD_SAFETY_NOW` duplicado.** El `ADJUST_MARGIN` doble que describía la semilla
está tapado por un fallo peor. **Severidad propuesta: Media** (F-08 tal cual), y la nota de que
arreglar B-10a **reactiva** el riesgo de transferencia doble: hay que corregir los dos juntos.

**Test propuesto.** `apps/worker/src/engine/command-inbox.spec.ts` (nuevo), con un doble de
`DbService` que capture los argumentos: «`recoverStale` no toca lo que este worker está
ejecutando» — se comprueba que el `where` incluye `claimed_by: { not: workerId }` o equivalente.

---

## F-17 — `syncOrderState` absoluto frente a `recordFill` incremental

**CONFIRMO**, y añado una consecuencia que la semilla no recogía.

- `bot-store.ts:389-405` `syncOrderState`: `updateMany({where:{bot_id, venue_client_id}, data:{…,
  filled_qty: order.filledQty, …}})` — valor **absoluto** del venue.
- `bot-store.ts:467-471` `recordFill`: `data:{filled_qty:{increment: fill.qty}}` — **incremento**.
- Las dos se disparan desde el mismo WebSocket de cuenta: `bot-runner.ts:471-473` (`streamOrders` →
  `onOrderUpdate` → `syncOrderState`) y `:466-468` (`streamFills` → `onFill` → `recordFill`). El
  primero **no** pasa por el cerrojo del runner (`:472` no usa `exclusive`), el segundo sí. No hay
  orden garantizado.

**Escenario A (sobreconteo).** Orden de 1,0. Llega `OrderUpdate{filledQty:'0.5'}` → la fila queda en
0,5. Llega `Fill{qty:'0.5'}` → incremento → 1,0. `bot-store.ts:473` `1.0 >= 1.0` → **`FILLED`**,
cuando en el venue queda medio abierto. Consecuencias: `liveOrderCoids` (`:227`) ya no la devuelve,
así que un PAUSE o un PANIC **no la cancelan**; y `reconcile` la sigue viendo en el libro y
compara contra `have.qty - have.filledQty` del venue (`reconcile.ts:188`), no contra la fila, así
que no la repone ni la cancela mientras esté en el plan. Queda una orden viva fuera del alcance de
las cancelaciones del bot.

**Escenario B (autocorrección).** Si llegan al revés, el absoluto pisa el incremento y la fila queda
bien. O sea: el resultado depende del orden de llegada.

**Escenario C — coid reutilizado, el que la semilla no cubría.** `upsertPendingOrder`
(`bot-store.ts:338-342`) reinicia `filled_qty` a 0 en el `update`, y está razonado (`:331-337`). Para
una estrategia con `reusesOrderSlots` (los dos market makers, Grid Classic, GridMart, Neutral Grid)
una cotización `FILLED` se recoloca con el mismo coid y la fila arranca de cero. Si después llega,
tarde, un fill de la encarnación **anterior** —reconexión del socket, barrido REST de diez minutos
(`bot-runner.ts:463`)—, `recordFill` lo casa por `venue_client_id` con la fila **nueva**
(`:430-439`) y la marca `FILLED` o `PARTIALLY_FILLED`. El ledger no se descuadra (`bot_fills`
deduplica por `venue_fill_id`), pero el **estado de la orden** miente: una cotización viva pasa a
`FILLED` y desaparece de `liveOrderCoids`.

**`onFill` con contexto degradado.** `bot-runner.ts:1051-1058`: `buildContext(ticker, null, [], '0')`
— posición `null`, sin órdenes, saldo `'0'`. Lo consume `strategy.onFill`, hoy solo GridMart. Una
estrategia que mirase `ctx.position` en `onFill` decidiría sobre una posición inexistente. Es una
trampa esperando; hoy no muerde.

**Severidad propuesta: Alta** (era Media en la semilla). El escenario A deja órdenes vivas fuera del
alcance del PANIC, que es más que un error contable.

**Test propuesto.** `apps/worker/src/engine/bot-store.spec.ts` (nuevo, con el `DbService` de
`paper-accounts.spec.ts:94-185` como modelo): «un OrderUpdate y su Fill no cuentan dos veces lo
mismo» — `syncOrderState({filledQty:'0.5'})` y luego `recordFill({qty:'0.5'})` sobre una orden de 1
y comprobar `filled_qty === 0.5` y estado `PARTIALLY_FILLED`. Hoy falla.

---

## F-18 — Escrituras best-effort, `claimForBots`, `/health`, `exit(0)`

**CONFIRMO los cuatro puntos.**

1. **Escrituras best-effort sin alerta.** `bot-store.ts:264` (`markCoidsCanceled`), `:362`
   (`rejectOrder`), `:385` (`markOrderCanceled`), `:404` (`syncOrderState`), `:819` (`trackMmPeaks`);
   `command-inbox.service.ts:87,102,116`. Ninguna avisa: el `.catch(() => undefined)` es mudo (el
   único que registra algo es `markExecuted`, `:87-89`, con un `logger.warn`). Consecuencias
   concretas ya trazadas: `rejectOrder` tragado → fila `PENDING` eterna (B-1);
   `markCoidsCanceled` tragado → la base cree vivas órdenes ya canceladas y el reconciliador las
   perseguirá un tick.
2. **`claimForBots` tragado.** `engine.service.ts:269-271` `.catch(() => new Map())`. Con la base
   caída, un PANIC encolado es indistinguible de la cola vacía. Y como `recoverStale` (`:136`)
   también falla, el comando ni siquiera se libera. El PANIC se queda quieto sin que nada lo diga.
3. **`/health` con cero runners.** `engine.service.ts:610`
   `healthy: this.runners.size === 0 || stalled.length < this.runners.size`. Un worker que no puede
   adoptar (base caída: `adoptPending` lanza y `scan` lo traga en `:137-138`) reporta 200 para
   siempre. Y el healthcheck del compose (`docker-compose.yml:280-289`) no reinicia nada aunque
   diera 503 (ver B-17).
4. **`process.exit(0)`.** `main.ts:76`, alcanzado también desde `unhandledRejection` (`:92`) y
   `uncaughtException` (`:96`). Sale con código 0 en un fatal, así que ningún orquestador que mire
   el código de salida distingue un despliegue de una caída. Con `restart: unless-stopped` el
   contenedor vuelve igual, pero el síntoma se pierde.

**Severidad propuesta: Media** para el conjunto, con la excepción del punto 1 aplicado a
`rejectOrder`/`confirmOrder`, que sube a **Alta** por lo dicho en B-1 y B-3.

---

## F-11 — Semántica de `drawdownPct` (solo descripción; decide el usuario)

`bot-store.ts:885-890`:

```
drawdownPct(totalInvestment, equity) {
  const invested = D(totalInvestment);
  if (invested.lte(0)) return null;
  const e = D(equity);
  return e.gte(0) ? D(0) : e.abs().div(invested).mul(100);
}
```

Es **pérdida acumulada sobre el capital asignado**, no caída desde máximo. Devuelve exactamente 0
mientras el equity sea ≥ 0. El `equity` que le llega desde `checkRiskGuards` (`bot-runner.ts:1618`)
es `realizedPnlAcc + unrealizedPnl` del **bot entero**, no un valor de cuenta.

Dos consumidores:

- `killSwitchDrawdownPct` (`:1613-1626`): un bot que sube un 50 % y baja hasta el +5 % nunca
  dispara, porque su equity sigue siendo positivo. El nombre del campo en la pantalla de límites
  dice «drawdown», que en la industria significa caída desde máximo.
- `maxDailyLossPct` (`:1642-1654`), que reutiliza la misma función con el PnL realizado de HOY del
  bot. Aquí la semántica sí encaja: «hoy he perdido X % de mi capital».

Para medir caída desde máximo haría falta guardar el pico; existen columnas `peak_inventory` y
`peak_margin` en `bot_mm_stats` (`bot-store.ts:788-820`), pero son de market making y no de equity.
El denominador es `total_investment`, que **sube** cuando el usuario marca `countAsBotCapital` en un
ADJUST_MARGIN (`bots.service.ts:1038-1040`) — y por B-10a sube sin que llegue ni un dólar a la
posición.

**Veredicto: decisión de producto.** Se documenta, no se toca (principio 6 de `specs/README.md`).

---

## Ciclo de vida del stop-loss (B-21) — ¿existe algún camino con posición y sin stop más de un tick y sin evento CRITICAL?

**Sí. Cuatro.**

1. **Cuarentena del stop** (B-21a). `place():840-851` o `:904-923`. Evento INFO o WARN. Dura hasta
   que cambie la posición. **Indefinido.**
2. **Reemplazo no atómico con `RETRYABLE`** (B-21b). `:754` cancela, `:760` no coloca, `:938`
   emite INFO. Se reintenta en el tick siguiente por `toPlace`, pero puede encadenar hasta 20
   colocaciones antes de que `MAX_PLACE_FAILURES` pause el bot (`:947-951`). **Hasta ~5 minutos**
   con una sola orden por tick.
3. **`STOP_AND_CLOSE` / kill-switch con el cierre fallido** (B-14). `:1269` `cancelOwnOrders()` sin
   `keepProtective` se lleva el stop; el cierre no ocurre; el evento afirma que sí. **Indefinido**
   (hasta que el usuario mire).
4. **Posición leída como plana**. `withStopLoss` devuelve el plan intacto si `position` es `null` o
   `qty` es cero (`stop-loss.ts:41-44`); entonces el stop vivo no está en `desired.orders` y
   `reconcile` lo mete en `toCancel` (`reconcile.ts:204-207`) → se cancela. La lectura de posición
   pasa por la caché de un segundo del hub (`account-hub.service.ts:555`), invalidada tras cada
   escritura (`:717`), así que la ventana es corta; pero un venue que devuelva la posición vacía un
   instante (reconexión, respuesta parcial) cancela el stop y lo repone al tick siguiente. **Un
   tick.** Sin evento de ninguna clase.

De los cuatro, el 1 y el 3 cumplen los criterios (1) y (2) de «Crítica» de `specs/README.md`. Falta
(3) en ambos: son «Crítica (por confirmar)» y **no disparan cambios** en este spec.

Lo que sí está bien y merece constar: el stop se conserva en las seis rutas que dejan la posición
abierta (`keepProtective`), `stopLossVivo` empieza pesimista y solo lo enciende un `confirmOrder`
(`:376`, `:895`), y `protectionNote` (`:1520-1526`) dice la verdad en los eventos de pausa y parada.

---

## Idempotencia de `place()` para las inmediatas (la MARKET de entrada)

**Muerte entre `upsertPendingOrder` (`:868`) y `placeOrder` (`:876`).** Al reiniciar, la fila está
`PENDING`. `place()` la ve en `:861` y sale en `:864` porque `allowRefill` es `false` para las
inmediatas (`:781`). **No se reenvía.** La entrada base **nunca se abre** y no hay evento: el bot se
queda en un ciclo que no arranca. Es el hueco de B-1, y aquí duele más porque afecta a la entrada.

**Muerte entre `placeOrder` (aceptada) y `confirmOrder` (`:892`).** La fila queda `PENDING` con
`venue_client_id`. Al reiniciar: `sweepFills` retrocede diez minutos (`:463`, `:1170-1173`),
`recordFill` casa el fill por `venue_client_id` (`bot-store.ts:430-439`), incrementa y marca
`FILLED` (`:473-477`), y `applyFillToCycle` contabiliza la entrada. Si el plan volviera a pedir la
misma inmediata, `place()` la veta (`FILLED` + `allowRefill=false`). **No se duplica exposición.**
Cubierto por `bot-runner.spec.ts:788-802` («una inmediata con fila FILLED no se reenvía jamás»).

**¿Puede reenviarse una MARKET ya ejecutada?** Solo si su fila acabara en `REJECTED` o `CANCELED`,
y hay exactamente un camino que lo produce con la orden viva: `confirmOrder` fallando por la base →
`rejectOrder` en `:899` (ver B-3). Entonces, si el ciclo aún no ha asimilado el fill y la estrategia
vuelve a pedir la entrada, `place()` **sí la reenviaría**. El venue rechazaría el coid duplicado
(los tres exigen unicidad), así que no hay doble posición, pero el registro queda peor. Ese es el
único resquicio que he encontrado y **no** constituye exposición duplicada.

**Veredicto: la idempotencia por `clientOrderId` está bien construida.** El problema es el
contrario: es *demasiado* absorbente y convierte una fila `PENDING` huérfana en un veto permanente.

---

## Lease: TTL, renovación y duración del tick

- TTL 30 s (`lease.service.ts:66`, `WORKER_LEASE_TTL_MS`), renovación cada `ttlMs/3` = 10 s
  (`:96`), en un `setInterval` **propio** e independiente del runner.
- Peor caso de un tick: cuatro lecturas al venue (`bot-runner.ts:569-580`) más N colocaciones, cada
  una con `withWriteRetry` (300 + 600 ms de espera y un `verify()` por intento,
  `rate-limit.ts:99-115`) y con la espera **sin tope** de `VenueBudget.take`
  (`venue-budget.ts:135-143`, `:251-274`). En Lighter, con el cupo de 60 peticiones por minuto
  repartido entre todos los bots del mismo `WORKER_EGRESS_ID`, un tick puede durar minutos.
- **¿Puede un tick sobrevivir al lease?** Por duración, **no**: todo son esperas de E/S y la
  renovación sigue corriendo. Solo se pierde el lease si Redis falla (`:213-236`) o si el bucle de
  eventos se bloquea por CPU más de 30 s.
- **¿Qué hace `dropLostLeases` a mitad de tick?** `engine.service.ts:175-185`: `abandonPaper`,
  `runner.dispose()` y borrar del mapa. `dispose()` espera al cerrojo (`bot-runner.ts:542`), así que
  **el tick en vuelo termina de colocar toda su escalera** aunque el lease ya sea de otro worker.
  `halted()` (`:793`) no mira el lease. La ventana está acotada por la duración del tick y la cubre
  la idempotencia por coid (fila escrita antes de mandar + `findOrderByCoid` + unicidad del coid en
  el venue). **No hay exposición duplicada, pero sí hay dos procesos escribiendo durante esa
  ventana.**

**Veredicto: OK.** Mejorable: comprobar el lease en `halted()` cortaría la ventana en seco. Se anota
como sugerencia, no como hallazgo.

## Redis caído más de un TTL: ¿se paran los runners a media ejecución?

`renewAll` vacía `held` y llama `onLeaseLost` con **todos** los bots
(`lease.service.ts:221-234`). `engine.service.ts:73-82` abandona los sandboxes y encola el
desenganche; `applyDetachments` (`:153-167`) hace `dispose()` **esperando al cerrojo**. Es decir:
**no se para a media ejecución**; el tick en curso termina, incluidas sus colocaciones.
`releaseUnexecuted` (`:164`) devuelve los comandos y `leases.release` (`:165`) intenta soltar en un
Redis que no responde y registra un `warn` (`lease.service.ts:136`).

**¿Quedan órdenes en vuelo sin registrar?** No: la fila se escribe antes de mandar (`:868`) y el
tick termina, así que `confirmOrder` o `rejectOrder` se ejecutan. Lo único que puede quedar sin
registrar es si el proceso muere a la vez (B-1) o si `confirmOrder` falla (B-3).

Ojo con el efecto colateral: si Redis cae para **todos** los workers, nadie puede adquirir leases
tampoco, así que los bots se quedan **sin dueño** hasta que Redis vuelva. Es la elección correcta
(«ante la duda se prefiere parar a duplicar», `:189-190`), pero conviene decirlo: **Redis es un
punto único de fallo para la operación entera**, y el aviso solo llega a `activity_log` si
`AUDIT_LOG_ENABLE` está a `true` — y el compose lo pone a `false` por defecto
(`docker-compose.yml:261`), mientras que `apps/worker/.env.example:95` lo pone a `true`. Divergencia
menor entre compose y `.env.example` que merece anotarse: en el despliegue por defecto, el incidente
más grave del motor **solo existe en stdout**.

## Kill switch

- La API marca `STOPPING` (`risk.service.ts:180-183`) y **no publica en el bus**.
- Latencia: `ENGINE_SCAN_INTERVAL_MS` = 5 s (`engine.service.ts:86`, `docker-compose.yml:214`) más
  la espera del cerrojo del runner. Los bots sin dueño se adoptan en el mismo barrido porque
  `adoptPending` (`:317-334`) incluye `STOPPING` a propósito, y `trySpawn` (`:400-409`) los cierra
  ahí mismo.
- **Con el venue caído**: ver B-14. Cancela el stop, no cierra, deja la posición abierta y —según
  el camino— o no dice nada (excepción tragada en `logger.error`) o afirma que ha cerrado.

---

# 3. Hallazgos propuestos

`id provisional | título | severidad | evidencia | impacto | test propuesto`

| id | título | severidad | evidencia | impacto | test propuesto |
|---|---|---|---|---|---|
| **B-16a** | `void pending.finally(...)` deja un rechazo sin manejar al abrir una cuenta y tumba el worker entero | **Crítica (por confirmar)** | `account-hub.service.ts:225`; `credentials.service.ts:35,72`; `paper-state.store.ts:46`; `main.ts:90-93,76` | Borrar una conexión de exchange con un bot vivo (o un hipo de la base al abrirla) mata el proceso con sus 250 bots; los leases caducan y hay hasta un TTL sin nadie atendiendo | `paper-accounts.spec.ts`, «un fallo al abrir la cuenta no deja un rechazo sin manejar»; fakes: `CredentialsService` doble que rechaza + espía de `process.on('unhandledRejection')` |
| **B-21a** | Un stop-loss rechazado o vetado entra en cuarentena y no se reintenta: posición sin red, sin evento CRITICAL | **Crítica (por confirmar)** | `bot-runner.ts:826,840-851,904-923,976`; `order-gate.ts:81-103` | Posición apalancada sin el stop que el usuario configuró, indefinidamente, con un solo INFO o WARN en la bitácora. Si había stop vivo, `:754` ya lo canceló | `bot-runner.spec.ts`, «un stop-loss rechazado por reglas no queda en cuarentena en silencio»; fakes: `FakeAdapter.placeError = ExchangeError('RULES')`, `fakeStore`, `conPos()` |
| **B-14** | `STOP_AND_CLOSE` cancela el stop antes de cerrar y afirma que ha cerrado aunque no lo consiga | **Alta** | `bot-runner.ts:1266-1277,2007-2041`; `engine.service.ts:242-245`; `risk.service.ts:180` | Kill-switch o parada con cierre durante un corte del venue: posición abierta, sin stop, bot `STOPPED` y evento que dice «posición cerrada a mercado» | `bot-runner.spec.ts`, «STOP_AND_CLOSE que no consigue cerrar no dice que ha cerrado»; fakes: `adapter.placeError`, `adapter.position` |
| **B-10a** | `AccountHandle` no reexpone `adjustIsolatedMargin` ni `setPositionMode`: `ADJUST_MARGIN` es código muerto y `positionMode` no se aplica | **Alta** | `account-hub.service.ts:621-791` (ausentes) frente a `types.ts:201,223`; `bot-runner.ts:440,1901`; `aster.ts:745,766`; `hyperliquid.ts:748`; `lighter.ts:1333`; `bots.service.ts:1038-1040` | Todo ajuste de margen falla en los tres venues; con `countAsBotCapital` el capital asignado del bot sube sin que llegue el margen, y de ese denominador sale `drawdownPct` que dispara el kill-switch. El test actual pasa porque el fake sí declara el método (`bot-runner.spec.ts:140`) | `paper-accounts.spec.ts`, «el handle de la cuenta expone el ajuste de margen y el modo de posición del adaptador»; fakes: el `AccountHub` y los dobles ya montados en `:261-293` |
| **B-06** (= F-06) | `safely()` convierte `AUTH` y `THROTTLED` del reemplazo en un WARN | **Alta** | `bot-runner.ts:741,751-762,929,2081-2091` | Un bot con la clave revocada parece vivo hasta que algo caiga en `toPlace`; con THROTTLED escribe decenas de WARN por minuto y el usuario no ve nada rojo | `bot-runner.spec.ts`, «un AUTH durante un reemplazo detiene el bot»; fakes: `getOpenOrders` con la orden a otro precio + `ownVenueClientIds` con su id + `placeError = AUTH` |
| **B-07** (= F-07) | Promesas sin `catch` con acceso a la base: `acquireFairPrice` y `NotifierService.onEvent` | **Alta** | `bot-runner.ts:1734,1744` → `bot-store.ts:180`; `notifier.service.ts:130,157,169,210,229`; `main.ts:90` | Un fallo de la base en un camino secundario apaga el worker entero | `bot-runner.spec.ts`, «un fallo al registrar el evento de fuente de precio no sale del runner»; fakes: `fakeStore` con `event` que rechaza + `priceSource` ausente para entrar en `:1743` |
| **B-21b** | Reemplazo del stop no atómico y `RETRYABLE` reportado en INFO | **Alta** | `bot-runner.ts:751-762,935-953,104,947` | Posición sin stop desde un tick hasta veinte colocaciones (~5 min) con solo eventos INFO | `bot-runner.spec.ts`, «si el stop no se puede reponer tras cancelarlo, se avisa en CRITICAL»; fakes: `placeErrorOnce = RETRYABLE` |
| **B-08** (= F-17) | `syncOrderState` absoluto frente a `recordFill` incremental, y el reinicio de `filled_qty` con coids reutilizados | **Alta** | `bot-store.ts:341,389-405,467-483`; `bot-runner.ts:466-473` | Una orden viva marcada `FILLED` desaparece de `liveOrderCoids` y ni un PANIC la cancela | `bot-store.spec.ts` (nuevo), «un OrderUpdate y su Fill no cuentan dos veces lo mismo» |
| **B-03** | `confirmOrder` fallido marca `REJECTED` una orden que el venue aceptó; `rejectOrder` tragado deja filas `PENDING` eternas | **Alta** | `bot-runner.ts:875-899`; `bot-store.ts:345-363`; `bot-store.ts:223-233` | La base miente sobre el libro: órdenes vivas fuera del alcance de PAUSE y PANIC; niveles vetados para siempre | `bot-runner.spec.ts`, «una orden aceptada por el venue no se marca REJECTED porque falle la base»; fakes: `store.confirmOrder` que rechaza |
| **B-01** | Una fila `PENDING` huérfana veta su `clientOrderId` para siempre y en silencio | **Alta** | `bot-runner.ts:861-866` (return sin evento); `bot-store.ts:309-343`; ningún barrido de `PENDING` en el repositorio | Nivel de escalera —o la entrada base a mercado— que no se coloca nunca más dentro del ciclo, sin ningún síntoma | `bot-runner.spec.ts`, «una fila PENDING huérfana no deja el nivel muerto para siempre»; fakes: `findOrderByCoid` → `{status:'PENDING'}` |
| **B-02b** (= F-02) | El aplanado por `limitAction` del market maker reutiliza el coid del stop inyectado y nunca sale | **Alta** | `market-maker.ts:829-842`; `market-maker-v2.ts:1176-1189`; `stop-loss.ts:48,59`; `bot-runner.ts:779-782,861-866,645-651`; `mm-shared.ts:410` | `CLOSE_ALL` no cierra y `SHUTDOWN` apaga dejando la posición abierta; `limitActionFiredAt` se persiste igual, así que no se reintenta en todo el ciclo | ver el test completo en la sección 2 (F-02) |
| **B-10b** (= F-08) | `recoverStale` desreclama comandos de cualquier worker, incluidos los que se están ejecutando | **Media** | `command-inbox.service.ts:123-133`; `engine.service.ts:31,136,283-284`; `venue-budget.ts:135-143` | `ADD_SAFETY_NOW` ejecutado dos veces promedia dos veces; al arreglar B-10a vuelve el riesgo de transferencia de margen doble | `command-inbox.spec.ts` (nuevo), «`recoverStale` no toca lo que este worker está ejecutando» |
| **B-17** | `/health` se declara sano con cero runners y el healthcheck del compose no reinicia nada | **Media** | `engine.service.ts:586-611`; `main.ts:35-46`; `docker-compose.yml:197,280-289` | Un worker que no puede hablar con la base pasa por sano indefinidamente | Sin test: corrección de la condición y nota en el compose |
| **B-18** (= F-18) | Escrituras best-effort mudas y `claimForBots` tragado; `exit(0)` en fatales | **Media** | `bot-store.ts:264,362,385,404,819`; `command-inbox.service.ts:87,102,116`; `engine.service.ts:269-271`; `main.ts:76,92,96` | Con la base caída un PANIC parece «no hay comandos»; ningún orquestador distingue un fatal de un despliegue por el código de salida | Sin test propio: se cubre con B-01 y B-03 |
| **B-22** | Relojes: no hay guarda de deriva y el nonce de Aster no es monótono ante un salto de reloj hacia atrás | **Media** | `aster.ts:211-219`; `bot-runner.ts:1696,1958-1961`; `market-data.service.ts:264` | Deriva > 60 s: rechazo sistemático de toda llamada firmada en Aster; deriva del venue hacia adelante: se opera con un precio viejo dado por fresco | `packages/exchange-core`, «el nonce de Aster es estrictamente creciente aunque el reloj retroceda»; fake: `jest.spyOn(Date,'now')` |
| **B-19** | `bot_commands` (y `bot_config_revisions`) sin retención ni mención | **Baja** | `retention.service.ts:63-67` | Crecimiento sin techo de tablas que nadie purga | Sin test |
| **B-02a** | Un fallo de Redis marca la fuente de precio externa como caída | **Baja** | `price-source.service.ts:289-296` | `status()` reporta una causa falsa; el aviso al usuario pierde precisión | `price-source.service.spec.ts`, «un fallo de Redis no marca la fuente como caída» |
| **B-02c** | `AUDIT_LOG_ENABLE` por defecto `false` en el compose y `true` en `.env.example` | **Baja** | `docker-compose.yml:261` frente a `apps/worker/.env.example:95`; `lease.service.ts:227-233` | En el despliegue por defecto, el incidente de «se sueltan todos los bots» solo existe en stdout | Sin test |

Notas de estrictez sobre las dos «Crítica»:

- **B-16a** cumple (1) —borrar una conexión de exchange es una operación normal de la aplicación— y
  (2) «caída del worker entero». Falta (3): el test está escrito arriba y hasta ejecutarlo se queda
  en «Crítica (por confirmar)», sin disparar cambios.
- **B-21a** cumple (1) y (2) «posición sin el stop-loss configurado». Falta (3). Igual tratamiento.
- **B-14** y **B-21b** producen el mismo efecto (2) pero por caminos que se autocorrigen o que
  exigen un fallo del venue coincidente; se dejan en **Alta** deliberadamente, con la nota de que el
  usuario puede subirlas.
- **NO** he propuesto como Crítica nada relacionado con órdenes duplicadas: la idempotencia por
  `clientOrderId` resiste los tres escenarios que la ponen a prueba (muerte a mitad de `place`,
  cerebro dividido por lease, reejecución de un comando).

---

# 4. Verificado OK

Lo que está bien resuelto, con la línea que lo resuelve. Vale tanto como la lista de hallazgos.

**Idempotencia y órdenes**

- La fila de `bot_orders` se escribe **antes** de llamar al venue — `bot-runner.ts:868` frente a `:876`.
- Veto de duplicados por `clientOrderId`, con la excepción justa para las estrategias que reutilizan
  huecos — `bot-runner.ts:861-866`; probado en `bot-runner.spec.ts:752-802`.
- Las inmediatas nunca recolocan un id ejecutado, declare lo que declare la estrategia —
  `bot-runner.ts:781` (sin `allowRefill`) y el comentario de `:774-778`.
- `client_order_id` es único a nivel global en la base — `schema.prisma:489`.
- El coid es determinista y lo genera una sola función — `makeCoid`, usado también por
  `closePositionAtMarket` (`bot-runner.ts:2027`) en vez de una cuarta copia del prefijo.
- El cierre manual usa el índice 999, fuera de la escalera, y `reconcile` lo reconoce —
  `bot-runner.ts:2021-2029`, `reconcile.ts:82,117-119`.

**Reconciliación**

- Tolerancia de medio tick y medio step, contra la cantidad **restante** — `reconcile.ts:184-199,
  246-253`.
- Pertenencia exacta desde la base en vez de fuerza bruta — `bot-store.ts:242-250`,
  `bot-runner.ts:579`, `reconcile.ts:143-171`.
- Se respetan las órdenes sin id de cliente y las de otros bots — `reconcile.ts:152-171`.
- El orden de ejecución libera margen antes de pedirlo: cancelar → reemplazar → colocar —
  `bot-runner.ts:719-728,739-772`.
- Un `PANIC` no puede colocar nada después de sí mismo: `halted()` entre órdenes —
  `bot-runner.ts:740,752,770,780,793`; probado en `bot-runner.spec.ts:323-345`.

**Cerrojo y concurrencia**

- Todo lo que toca el venue o el estado pasa por `exclusive()` — `bot-runner.ts:405-412`,
  y la cola avanza aunque una operación falle (`:407-410`).
- La cola de `RateLimiter` tiene el mismo cuidado — `rate-limit.ts:36-39`.
- `requestTick` agrupa: veinte fills encolan un tick — `bot-runner.ts:708-717`.
- `applyFillToCycle` corre en una transacción con `SELECT … FOR UPDATE` sobre el ciclo —
  `bot-store.ts:596-605`; tercera línea de defensa por escrito (`:583-588`).
- Los contadores de market making van en la MISMA transacción que el ciclo — `bot-store.ts:633-635,
  733-775`.

**Stop-loss**

- Se inyecta en las siete estrategias desde un solo sitio — `stop-loss.ts:30-73`,
  `bot-runner.ts:643`.
- El lado sale del SIGNO de la posición real, no de `cfg.direction` — `stop-loss.ts:50`; probado en
  `bot-runner.spec.ts:894-911`.
- Sale como orden condicional nativa (`triggerPrice`), así que protege con el motor caído —
  `stop-loss.ts:65-67`.
- `keepProtective` lo conserva en las seis rutas que no cierran posición — `bot-store.ts:223-233`;
  usado en `bot-runner.ts:1229,1257,1306,1416,1670,1125`; probado en `bot-runner.spec.ts:821-871`.
- `stopLossVivo` empieza pesimista y solo lo enciende un `confirmOrder` — `bot-runner.ts:376,895`;
  se apaga en cada veto y en cada fallo (`:841,898`).
- `protectionNote` dice en voz alta si queda red — `bot-runner.ts:1520-1526`.
- El sentido del disparo viaja explícito y no se deduce del lado — `bot-runner.ts:886-890`.

**Lease**

- Renovación de todos los leases en un solo script y por lotes — `lease.service.ts:42-51,201-211`.
- Liberación con compare-and-delete — `:24-29`.
- Renovación independiente del tick, en su propio temporizador — `:96`.
- Ante Redis inalcanzable más de un TTL, se sueltan todos: se prefiere parar a duplicar —
  `:213-236`, con entrada CRITICAL en la bitácora (`:227-233`).
- Perder un lease suelta el runner **al instante**, no en el barrido siguiente —
  `engine.service.ts:73-82,175-185`.
- Orden correcto al apagar: runners fuera, leases después — `engine.service.ts:96-119`,
  `lease.service.ts:100-116`.

**Comandos**

- Bandeja duradera en la base; el bus solo adelanta — `command-inbox.service.ts:14-26`,
  `engine.service.ts:525-539`.
- Reclamo con `updateMany` condicional: dos entregas del mismo comando no lo ejecutan dos veces —
  `command-inbox.service.ts:66-70`.
- Un comando que falla se cierra con el motivo en vez de reintentarse para siempre —
  `command-inbox.service.ts:99-103`, `engine.service.ts:291`.
- El aviso de fallo lleva el `user_id` real — `engine.service.ts:295-302`,
  `command-inbox.service.ts:55-61`.
- Lo reclamado y no ejecutado vuelve a la cola al soltar un bot o al apagar —
  `engine.service.ts:115-117,164,278`.
- Se adopta antes de drenar, para que un PANIC a un bot huérfano se ejecute en el mismo barrido —
  `engine.service.ts:132-135`.

**Guardas de riesgo**

- Se evalúan **antes** de planificar — `bot-runner.ts:612-614`.
- Un bot pausado sigue vigilando la liquidación y no coloca nada — `bot-runner.ts:616-625`;
  probado en `bot-runner.spec.ts:663-744`.
- El apalancamiento se revisa haya o no posición — `bot-runner.ts:1549-1555`.
- El aviso de liquidación lleva enfriamiento; la **acción** no — `bot-runner.ts:1586-1608`.
- El equity del kill-switch se calcula en el instante, no del snapshot anterior —
  `bot-runner.ts:1614-1622`.
- El corte del día es la medianoche del usuario, no la del contenedor — `bot-store.ts:78-115,
  902-948`.
- `pauseForRisk` pausa y no cierra, y conserva el stop — `bot-runner.ts:1659-1679`.
- Cortacircuitos por ticks fallidos y por colocaciones fallidas, los dos —
  `bot-runner.ts:95,104,947-951,2127-2131`.

**Liquidación**

- Tres condiciones antes de atribuirse una liquidación — `bot-runner.ts:1018-1022`.
- Orden sintética con coid derivado del bot y del fill: dedupe por unicidad —
  `bot-store.ts:515-521,566-571`; sin `venue_order_id` a propósito (`:527-532`).
- Lo parcial lo decide el venue, no el ciclo — `bot-runner.ts:1108-1114`.
- Se cancela contra el venue, no solo en la base, y conservando el stop si queda posición —
  `bot-runner.ts:1116-1125`.
- Aviso único por episodio con testigo propio, rearmado en RESUME —
  `bot-runner.ts:283,1092-1093,1137,1244`; probado en `bot-runner.spec.ts:1468-1550`.

**Streams y datos de mercado**

- El canal de datos nunca recibe `error()`; la salud va por su propio canal — `ws.ts:26-27,133-137`.
- Los ganchos del socket van blindados para que una excepción no tumbe el proceso —
  `ws.ts:120-131,154-160`.
- Backoff con jitter y reinicio tras 60 s estables — `ws.ts:144-148,186-198`.
- La URL se resuelve en cada reconexión (listenKey de Aster) — `ws.ts:33-35,98`.
- Guarda contra el `stop()` que llega mientras se resolvía la URL — `ws.ts:106-113`.
- Una suscripción por símbolo con contador de referencias, y la suscripción al venue **guardada**
  para poder soltarla — `market-data.service.ts:31-51,137-188`.
- Un precio viejo no se sirve como respaldo — `market-data.service.ts:261-265,293-300`.
- El respaldo por REST de las ejecuciones existe de verdad — `bot-runner.ts:1163-1178`.
- El precio externo rancio se entrega como **ausente**, no como el último conocido —
  `bot-runner.ts:1693-1696`.
- Cambiar la fuente externa en caliente reabre el feed — `bot-runner.ts:1783-1809`; probado en
  `bot-runner.strategies.spec.ts:807-900`.
- Un sondeo en vuelo no se solapa con el siguiente — `price-source.service.ts:111-118,277-279`.
- Retroceso solo para lo que se arregla esperando (GEO/THROTTLED), no para un timeout —
  `price-source.service.ts:308-314`.
- `reschedule` comprueba que el feed sigue vivo antes de armar el temporizador —
  `price-source.service.ts:356-365`.

**Caudal**

- Presupuesto por venue **y red**, compartido entre procesos con el mismo `WORKER_EGRESS_ID` —
  `venue-budget.ts:38-45,246-249`; `venue-budget.provider.ts:26-35`.
- Reserva del 20 % para escrituras — `venue-budget.ts:120-122,245`.
- Un peso mayor que la capacidad se concede a depósito lleno en vez de esperar para siempre —
  `venue-budget.ts:126-130`, `TAKE_SCRIPT:199-202`.
- Script Lua atómico para el depósito compartido — `venue-budget.ts:178-214`.
- Con Redis caído se limita en memoria en vez de dejar de limitar — `venue-budget.ts:266-270`.
- Enfriamiento del venue que falla **sin tocar la red** — `cooldown.ts:51-61`, cableado en
  `aster.ts:268,334` y `lighter.ts:511,532`.
- Un `withWriteRetry` pregunta al venue antes de reenviar — `rate-limit.ts:81-115`.
- Un limitador por CUENTA, no por bot — `account-hub.service.ts:99-118`,
  `credentials.service.ts:90-99`.

**AccountHub y simulación**

- Caché de un segundo con petición única en vuelo e invalidación tras escribir —
  `account-hub.service.ts:541-609,713-751`.
- Single-flight en la apertura — `:217-228`.
- `close()` idempotente: una liberación doble no le cierra la cuenta a otro bot — `:772-790`.
- Se relee `refs` después de cada `await` antes de desalojar — `:508,529`.
- Un sandbox sin bot se guarda y se cierra en el acto, no a los treinta segundos — `:489-512`.
- El epoch protege del reinicio de simulación; el lease, del relevo entre procesos —
  `paper-state.store.ts:100-150`, `account-hub.service.ts:455-478`.
- La simulación no descifra la credencial de nadie — `credentials.service.ts:102-137`,
  `account-hub.service.ts:300-322`; probado en `paper-accounts.spec.ts:62-92`.
- En simulación el precio va al adaptador de la cuenta, no al feed compartido, y está razonado —
  `account-hub.service.ts:640-661`.

**Apagado y retención**

- Tope de cierre (30 s) por debajo del `stop_grace_period` (45 s) — `main.ts:8`,
  `docker-compose.yml:201`.
- Los runners se cierran sin cancelar órdenes: un despliegue no deshace la escalera de nadie —
  `engine.service.ts:108-112`.
- `dispose()` espera al cerrojo antes de cerrar el transporte — `bot-runner.ts:539-543`.
- Purga por lotes, con tope por pasada y detrás de un cerrojo — `retention.service.ts:11-14,49-60,
  138-146`.
- Lo grave se conserva mucho más — `retention.service.ts:115-129,87-101`.
- El histórico real (`bot_cycles`, `bot_orders`, `bot_fills`) no se purga nunca —
  `retention.service.ts:28-31`.

**Varios**

- `markOrderCanceled` filtra por bot: sin eso corrompía datos de otro usuario —
  `bot-store.ts:365-386`.
- El mensaje de error se recorta antes de llegar a la bitácora y a la ficha del bot —
  `bot-runner.ts:2112-2116`, `errors.ts:198-201`.
- La spec del mercado se relee cada 40 ticks y limpia la cuarentena si cambia la retícula —
  `bot-runner.ts:76,1988-2005`.
- La red sale de la CUENTA y de ningún otro sitio — `credentials.service.ts:76-80`,
  `engine.service.ts:443-446`, `bot-runner.ts:206-213`.
- Un bot que se está parando se adopta siempre, y los simulados no compiten por el par —
  `engine.service.ts:359-393`.
- Un bot borrado deja rastro en `activity_log`, que no tiene clave foránea justo para esto —
  `engine.service.ts:218-234`.
- Un mensaje ilegible del bus no rompe el flujo — `bus.service.ts:206-213`,
  `watch.service.ts:59-91`.
- La bitácora es estructuralmente incapaz de retrasar el motor (devuelve `void`) —
  `audit.service.ts:46-74`.
- `bot-runner.ts:592-598`: un venue que no devuelve precio hace fallar el tick en vez de planificar
  una escalera a cero.
- `currentTicker` exige un precio positivo **y reciente** antes de cerrar a mercado —
  `bot-runner.ts:1945-1973`; probado en `bot-runner.spec.ts:438-525`.
- El aviso de arranque fallido lleva el `user_id` real — `engine.service.ts:420-431`.
- Jitter y desfase inicial en el latido: mil bots no golpean el venue en el mismo instante —
  `bot-runner.ts:502-521`.
- Persistencia cada cuatro ticks, o antes si la **forma** de la nota cambió —
  `bot-runner.ts:120,131,678-689`, `bot-store.ts:149-164`.
- El acumulado del bot se calcula una vez al adoptar y luego se mantiene incremental —
  `bot-store.ts:1086-1096`, `cycle-accounting.ts:142,177,204`.
