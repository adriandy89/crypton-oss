# 060 — Hallazgos

Commit base: `7e7290b` (cierre del 059; `git diff main...7e7290b`, 38 commits, 196 ficheros) ·
Fecha: 2026-09-17 · Versiones: node 24.12.0, pnpm 10.28.1, `@nktkas/hyperliquid` 0.33.3 · Hosts
sondeados: ninguno.

Las líneas citadas son las de `7e7290b`. Entre paréntesis, el id de la revisión de origen: EX
(exchange-core y 057), MA (piezas numéricas), ES (herramienta y estrategia), WK (worker), IA (lazo
de la IA), AC (acceso, riesgo, base de datos y backtest) y UI (app y guías). Los informes y sus
scripts están en el scratchpad de la sesión, no en el repo.

## Línea base

- **Sobre `7e7290b`.** La verificación completa del cierre del 059 está en verde: tests, lint,
  `check:env`, builds y 224 de 224 mutaciones (`059-canal-ia/tasks.md`, fase 10).
- **Tests de confirmación de este spec, sin arreglos.** Fallan 9, cada uno por el motivo que
  declara:
  - 5 en el worker de F-01;
  - 1 de F-02 en `exchange-core`;
  - 2 de F-03;
  - 1 de F-07.
- **Con los cinco arreglos (F-01, F-02, F-03, F-07 y F-15), ya con sus commits.** Todos los tests de
  confirmación pasan, y cada arreglo tiene sus mutaciones cazadas (ver su ficha). Suites por paquete:
  `strategy-core` 758, worker 580, `exchange-core` 482 y backtest 64, todas en verde, más la
  verificación completa del cierre.

## Referencias oficiales

No se ha consultado a ningún venue.
- **Lighter.** Los hallazgos salen del propio adaptador: los dos ids de F-01 y F-08 los construye
  nuestro código.
- **Hyperliquid.** Queda por confirmar si un disparador suelto se acusa sin `oid`: es la parte
  Hyperliquid de F-01. El SDK lo admite en su tipo (`statuses: … | "waitingForFill" |
  "waitingForTrigger"`, `esm/api/exchange/_methods/order.d.ts:137`), y confirmarlo exige una
  llamada firmada, que está prohibida.

> **Al día de 2026-09-18.** El spec `062-canal-listo-para-operar` cierra dieciocho de estos
> hallazgos: F-04, F-05, F-06, F-08, F-12, F-13, F-14, F-19, F-21, F-22, F-23, F-24, F-44, F-45,
> F-46, F-47, F-49 y F-52. Van marcados en las tablas; lo que hace cada uno está en
> `specs/062-canal-listo-para-operar/spec.md` § Lo hecho.

## Resumen

| ID | Título | Área | Severidad | Estado | Evidencia | Arreglo |
|---|---|---|---|---|---|---|
| F-01 | Lo que el motor cancela sigue vivo en la base si el venue lo llama por otro id: el stop que se mueve no vuelve (EX-1) | worker / Lighter / HL | **Crítica** | **corregido en 060** (`523f11d`) · previo a la rama | `bot-runner.ts:1267,1279,1411-1420,1664-1673`; `bot-store.ts:360-372,393-404`; `lighter.ts:1311,1406,2427,1823-1841,1880-1908` | S |
| F-02 | Lighter vuelve a mandar una MARKET si no puede leer las ejecuciones: el caso de 001/F-68 que su arreglo no alcanzó (EX-2) | Lighter | **Crítica** | **corregido en 060** (`be0fdaf`) · previo a la rama | `lighter.ts:1453`; `rate-limit.ts:120-155` | S |
| F-03 | Con el bot pausado, la posición del canal se queda sin stop y sin vigilante (WK-1, UI-1) | worker / canal | **Crítica** | **corregido en 060** (`ebc5c9e`) | `bot-runner.ts:1055-1080,1130,2407-2416,2564` | S |
| F-04 | Una intención `ABIERTA` que nadie cierra veta para siempre las entradas del bot (ES-1, WK-2, AC-2) | worker / canal | Alta | confirmado (tests de las revisiones) | `ai-intents.store.ts:195,254-262`; `migration.sql:80`; `bot-runner.ts:1773,2286-2305,2483-2496,2760`; `bot-store.ts:462,1173-1227` | M  · corregido en el 062 |
| F-05 | El cierre a mercado del motor no se puede repetir en el mismo ciclo, y el vigilante avisa en CRITICAL sin freno (WK-3) | worker | Alta | confirmado (tests de la revisión) | `bot-runner.ts:3666,1411-1420,1371-1402,2372-2400` | M  · corregido en el 062 |
| F-06 | El candado de administrador y el tope por venue también se aplican al readoptar: ERROR con la posición abierta (WK-5, AC-1) | worker / acceso | Alta | confirmado (lectura) | `engine.service.ts:483-491,594-599`; `bots.service.ts:1222`; `admin-users.service.ts:158-161` | S  · corregido en el 062 |
| F-07 | F-06 del 057 en un hueco reutilizado: la cotización en estado desconocido queda vetada para siempre (WK-4, ampliado) | worker | Alta | **corregido en 060** (`2a78e47`) · era regresión del 057 | `bot-runner.ts:1486-1503,1419,1664-1673`; `bot-store.ts:324-358` | S |
| F-08 | Lighter: una orden que el secuenciador descarta queda PENDING para siempre y veta su id | Lighter / worker | Alta | confirmado (lectura) · previo | `lighter.ts:1303-1311,1400-1409`; `bot-runner.ts:1664-1673` | S  · corregido en el 062 |
| F-09 | Tendencia recoloca su stop en el tick siguiente la mitad de las veces, un tick más lejos (EX-3) | estrategia | Alta | confirmado (script) · previo | `trend-follow.ts:314,316,333` | S |
| F-10 | Canal inclinado con `slopedWithTrendOnly` apagado: entra contra la pendiente y sale en el tick siguiente (ES-2) | estrategia | Alta | confirmado (script) | `ai-channel.ts:817-818,1154-1159`; `canal/setups.ts:53-62` | S |
| F-11 | El falso quiebre de dos velas ignora la primera: el stop cae dentro de la mecha (MA-2) | canal | Alta (opcional) | confirmado (script) | `canal/canales.ts:366-382`; `canal/tasas-base.ts:143-147` | S |
| F-12 | Pausado, la guarda de liquidación del canal solo avisa; las guías prometen que cierra (UI-1) | worker / guías | Alta | confirmado (script) | `bot-runner.ts:1055-1066`; `riesgo-y-liquidacion.md:209-211`; `comandos-guardas-y-eventos.md:110` | S  · corregido en el 062 |
| F-13 | El aviso de la pausa de 6 h se pierde bajo el límite de un `AI_FAILED` por hora (IA-1, UI-3) | API | Media | confirmado (test) | `ai-channel.service.ts:383-394` | S  · corregido en el 062 |
| F-14 | «⏸ Pausar» contesta «Pausando…» aunque no pause, y no deja rastro (IA-2) | API / notificador | Media | confirmado (test) | `telegram-poller.service.ts:174-185`; `ai-channel.scheduler.ts:90-97`; `ai-channel.service.ts:622-650` | S  · corregido en el 062 |
| F-15 | Tras la pausa por caída máxima o por 1,5× el tope, reanudar vuelve a pausar (UI-2, ES-9) | canal / guías | Media | **corregido en 060** (`93b1ef1`) | `ai-channel.ts:1069-1075,1129-1135`; `docs/ai-channel.md:255-260,483` | S/M |
| F-16 | RESUME no pasa por la puerta de administradores (AC-4) | API | Media | confirmado (script) | `bots.service.ts:1259-1264` | S |
| F-17 | El replay no cancela nada en Hyperliquid ni en Lighter (AC-3) | backtest / simulador | Media (simulación) | confirmado (script) · previo (007) | `backtest/src/engine.ts:661,682-699,839,842`; `dry-run.ts:700-707,1215` | S |
| F-18 | El alta llama «la operación más grande que admite» a la del stop más ancho, que es la más pequeña (UI-4) | app | Media | confirmado (script) | `bot-create.page.ts:171-179`; `bot-create.page.html:410-436` | S |
| F-19 | La ficha de la consola no relee el detalle del dueño con los eventos (UI-5) | app | Media | confirmado (lectura) | `admin/bot-detail.page.ts:152-163,369-376,401-419` | S  · corregido en el 062 |
| F-20 | La pausa al 1,5× cuenta el día del usuario y el canal cuenta en UTC (UI-6, WK-8) | worker | Media | confirmado (lectura) | `bot-runner.ts:3142-3159`; `bot-store.ts:1000-1015` | S |
| F-21 | Una operación cerrada cuya ejecución aún no se ha barrido se trata como una IOC que no se llenó (ES-3) | canal | Media | confirmado (script y e2e) | `ai-channel.ts:1261,1265-1298` | S  · corregido en el 062 |
| F-22 | TP1 ejecutado a medias: el reparto desde arriba pasa el tramo del TP2 al TP1 (ES-4) | canal | Media | confirmado (script) | `ai-channel.ts:1014-1018` | S  · corregido en el 062 |
| F-23 | `observeOnly` y `entriesEnabled` mal tipados pasan la validación y se leen como «opera» (ES-5) | canal | Media | confirmado (script) | `canal/config.ts:146-147,216-217`; `common.ts:405` | S  · corregido en el 062 |
| F-24 | El stop de emergencia de una posición huérfana no mira la liquidación (ES-6) | canal | Media | confirmado (script) | `ai-channel.ts:886-887` | S  · corregido en el 062 |
| F-25 | Aster puede dejar al canal en margen cruzado (WK-6) | worker / Aster | Media | por confirmar | `aster.ts:941-958`; `bot-runner.ts:2251-2280` | S |
| F-26 | Con estructura de 5 min, las tasas base usan la pendiente y el ATR de 5 min (MA-3) | canal | Media | confirmado (script) | `canal/analisis.ts:217`; `canal/tasas-base.ts:140-141,199,211` | S |
| F-27 | La divergencia del falso quiebre compara con el giro de la propia ruptura (MA-4) | canal | Media | confirmado (script) | `canal/setups.ts:101-106,195` | S |
| F-28 | La caché del análisis no distingue la red ni el contenido de las series (MA-1) | canal | Media | confirmado (script) | `canal/analisis.ts:100-148` | S |
| F-29 | El simulador retira sin evento las reduce-only que ya no reducen (EX-4) | simulador | Media (simulación) | confirmado (script) | `dry-run.ts:898-907,963-971` | S |
| F-30 | `leerTramos` y `leerModo` convierten cualquier error, AUTH incluido, en «sin entradas» (WK-8) | worker | Media | confirmado (lectura) | `bot-runner.ts:2094-2100,2120-2126` | S |
| F-31 … F-63 | Bajas | varias | Baja | ver la tabla | | S |

Estados: `por confirmar` · `confirmado` · `corregido en 060` · `seguimiento NNN` · `descartado`.
Arreglo: `S` (menos de 50 líneas) · `M` · `L` (exige spec propio).

## Decisiones del usuario (2026-09-17)

- **Se corrigen dentro del 060**: F-01, F-02 y F-03 (las tres Críticas), F-07 (la regresión que
  traía el 057) y F-15.
- **F-15**: al reanudar, el pico se rearma. La caída pasa a medirse desde el resultado realizado del
  momento en que el usuario reanuda, así que cada reanudación devuelve todo el margen. La pausa del
  1,5× del tope diario se queda como estaba —dura hasta las 00:00 UTC— y su aviso lo dice.
- **El resto** va a los specs de seguimiento del final.

## Fichas

### F-01 — Lo que el motor cancela sigue vivo en la base si el venue lo llama por otro id

- **Síntoma.**
  - **El reemplazo.** Reemplazar es cancelar y volver a colocar con el **mismo** id.
    - `execute()` cancela y anota la cancelación con `markOrderCanceled(bot, existing.venueOrderId)`
      (`bot-runner.ts:1279`; las huérfanas, igual en `:1267`).
    - La tienda busca la fila por `venue_order_id` (`bot-store.ts:393-404`).
    - Ese id es el del **acuse** (`confirmOrder`, `:360-372`), y no siempre coincide con el del libro.
  - **El veto.** Si no casa, la fila sigue viva y `place()` veta el mismo id (`bot-runner.ts:1411-1420`).
    Solo lo libera `pendienteVencida`, que exige una fila PENDING **sin** id de venue y con más de
    5 min (`:1664-1673`).
  - **Lighter.**
    - El acuse guarda el índice de cliente (`lighter.ts:1311,1406`) y el libro informa del
      `order_index` (`:2427`): no casan nunca.
    - El otro camino que corrige la fila es `syncOrderState` desde el stream de órdenes
      (`bot-runner.ts:1994-1997`). En Lighter ese stream solo lo alimenta `pollOrders`
      (`lighter.ts:1880-1908`), que emite solo lo que llegó a ver vivo.
    - Además, `pollOrders` no corre mientras el canal de cuenta entrega ejecuciones: hasta 5 min
      después de la última ejecución de **la cuenta** (`shouldPoll`, `:1823-1841`).
    - Resultado: un stop colocado y reemplazado antes de que un sondeo lo viera deja la fila PENDING,
      con un id que no vence, **para siempre**.
  - **Hyperliquid.** Un disparador acusado sin `oid` (`hyperliquid.ts:956`, por confirmar) deja la
    fila sin id de venue, y el veto dura:
    - hasta que el stream traiga la cancelación, si está vivo;
    - hasta 5 min desde la última escritura de la fila, si el stream está caído o su mensaje llegó
      antes que el acuse (`confirmOrder` pisa el `oid` con null).
- **A quién afecta.** A toda estrategia cuyo stop cambia dentro del ciclo:
  - `withStopLoss` sigue el precio medio y el tamaño de la posición (`stop-loss.ts:44-72`): cada
    ejecución de un DCA, una martingala, una rejilla o el inventario de un market maker lo mueve;
  - el stop de Tendencia, que F-09 mueve además en el segundo tick la mitad de las veces;
  - el breakeven del canal tras el TP1.

  En Lighter, además, una cotización que se recoloca con su id y un nivel que se cancela por
  huérfano y vuelve dentro del mismo ciclo.
- **Impacto.**
  - **Posición sin stop.** En Lighter hasta que acaba el ciclo; en Hyperliquid, hasta 5 min.
  - **En silencio.** El veto devuelve null sin evento.
  - **En el canal.** El vigilante lo tapa: cierra a mercado a los 10 s con un CRITICAL `SIN_STOP`.
    Así, en Lighter toda operación que toca el TP1 se cierra a mercado en vez de seguir hacia el TP2.
  - **En `main`.** Las tres piezas están ya en `main`, y allí es peor: sin el 057/F-01 el stop se
    recoloca **en cada tick**, así que en Lighter se perdería en el segundo tick.
- **Reproducción / test.** Antes del arreglo fallan, por el motivo declarado:
  - `bot-runner.spec.ts`, «lo que el motor cancela se anota aunque el venue lo llame por otro id
    (spec 060 F-01)»: tres casos.
    - Acuse con el índice de cliente, y acuse sin `oid`: el libro queda `[]` en vez de `['91.0']`.
    - La huérfana que vuelve: 0 órdenes en vez de 1.
  - `bot-store.spec.ts`, «BotStore.markOrderCanceled (spec 060)»: dos casos, la consulta nueva.
  - Script de la revisión `ex-stop-reemplazo-venues.js`: «Lighter canal de cuenta vivo: stops tras
    el reemplazo=0 · tras 6 min=0».
- **Contrato de arreglo.**
  - **Conducta.** Lo que el motor acaba de cancelar se anota también por el id de cliente del libro
    (`venue_client_id`), siempre dentro del bot.
  - **Ficheros.** `bot-store.ts`: `markOrderCanceled(botId, venueOrderId, venueClientId?)` con
    `OR`, unas 15 líneas. `bot-runner.ts`: sus dos llamadores pasan `order.clientOrderId` y
    `existing.clientOrderId`, 2 líneas.
  - **Radio.** Solo esos dos llamadores (grep). Sin migraciones y sin cambios entre paquetes.
  - **Lo que no resuelve.** Las órdenes que cancela el propio venue en Lighter: eso es F-08.
- **Decisión.** Corregido en este spec (`523f11d`), aprobado por el usuario el 2026-09-17. Tras el
  arreglo, los cinco tests pasan. Mutaciones, todas cazadas: casar solo por el id de cliente (caen
  los dos de la tienda), no pasar el id en el reemplazo (caen los dos del stop) y no pasarlo al
  cancelar una huérfana (cae el suyo).

### F-02 — Lighter vuelve a mandar una MARKET si no puede leer las ejecuciones

- **Síntoma.** Tras un envío sin respuesta, `withWriteRetry` pregunta si la orden entró
  (`rate-limit.ts:120-155`).
  - **La comprobación.** En Lighter la pregunta es `findPlaced`: mira el libro y las ejecuciones,
    porque una MARKET ejecutada ya no está en el libro.
  - **El fallo tragado.** `getRecentFills(...).catch(() => [])` (`lighter.ts:1453`) convierte «no se
    pudieron leer» en «no entró», y la orden sale otra vez.
  - **El arreglo que no llegó.** 001/F-68 (Crítica) nombraba exactamente este caso («`getRecentFills`
    caído en Lighter … el punto grave de F-16»). Su arreglo (`5603312`) solo tocó `rate-limit.ts`, y
    aquí la comprobación no lanza, así que no lo alcanza. Las notas del 001 lo daban por cubierto.
- **Escenario.**
  1. Sale una MARKET: la base de un DCA, una martingala o una TDCA, o un `ADD_SAFETY_NOW`.
  2. El envío agota el plazo con la orden aceptada.
  3. La lectura del libro sale bien.
  4. La de `trades` falla: es la lectura más pesada (600) y la primera que se corta con el cupo por
     IP.
  5. Sale la segunda MARKET: **posición doblada**.

  La IOC del canal pasa por la misma comprobación (rama `create_order`).
- **Reproducción / test.** `lighter-signer.spec.ts`, «una MARKET sin respuesta no se reenvía si no se
  pueden leer las ejecuciones».
  - Antes: «Received promise resolved instead of rejected» (hubo segundo envío).
  - Después: rechaza con `estadoDesconocido` y hay un solo envío.
- **Contrato de arreglo.**
  - **Cambio.** Quitar el `catch`, una línea más su comentario.
  - **Radio.** `findPlaced` lo usan la comprobación de las dos ramas de `placeOrder` y
    `acuseSiYaEstaba` (el «client order index already exists»). En este último, una lectura fallida
    ahora lanza su error en vez de dejar el rechazo del venue. La fila acaba REJECTED igual, y el tick
    siguiente reconoce la orden por su id si estaba.
- **Decisión.** Corregido en este spec (`be0fdaf`), aprobado por el usuario el 2026-09-17. Mutación
  cazada: devolver el `catch` deja pasar el segundo envío.

### F-03 — Con el bot pausado, la posición del canal se queda sin stop y sin vigilante

- **Síntoma.**
  - **Guardas antes que el plan.** El tick mira las guardas antes de planificar
    (`bot-runner.ts:1055-1080`).
    - Si una pausa, se pausa y se sale.
    - Un bot pausado sale sin planificar.
    - El tick siguiente al llenado es el que pone el stop del canal, y no llega a ponerlo.
  - **El vigilante.** Solo corre en el camino completo (`despuesDelCanal`, `:1130`), y
    `programarVigilancia` no programa nada con el bot pausado (`:2410`).
  - **«Cancelar todo».** Con el bot pausado no pide el tick que repone el stop (`:2564`), y las guías
    dicen que lo repone en el acto (`ai-channel.md:341`, `comandos-guardas-y-eventos.md:86`).
- **Escenario confirmado.**
  1. El tope de caída del usuario está al 10 %, más estricto que la caída máxima del canal (15 %, y
     medida desde el pico).
  2. El bot lleva 98 de pérdida de días anteriores sobre 1000, así que el canal deja entrar.
  3. La comisión y el diferencial de la entrada llevan la cuenta al 10,02 %.
  4. Se pausa en el tick del llenado: 25x sin stop, y un minuto después sigue igual, sin `SIN_STOP`.
- **Otros disparadores.**
  - Un PAUSE entre el llenado y el stop confirmado.
  - `maxNotionalPerBot` igual al nocional máximo del bot: un largo que sube de la entrada lo pasa. El
    canal no conoce las guardas del usuario (`limitesExternos` solo pasa el tope de apalancamiento,
    `:2167`).
  - La pérdida diaria de la cuenta cruzada por el cierre de otro bot.
  - La pausa por colocaciones fallidas.
  - Cancelar todo con el bot pausado.
- **Por qué es del canal.** El orden «guardas antes que el plan» es de siempre. Pero en el canal una
  posición recién abierta va hasta a 25x, su única red es el stop, y el vigilante que la guía da como
  respaldo no corre en pausa. Solo el margen aislado acota la pérdida: hasta `maxMarginPct` (25 % del
  capital por defecto), frente al 1 % planeado.
- **Reproducción / test.** `bot-runner.canal-e2e.spec.ts`. Antes del arreglo fallan los dos, con la
  posición abierta y sin stop:
  - «una guarda que pausa al llenarse la entrada no deja la posición sin stop»;
  - «pausado, «cancelar todas las órdenes» vuelve a poner el stop (spec 060, F-03)».
- **Contrato de arreglo.** En `bot-runner.ts`, unas 45 líneas:
  - **`protegerEnPausa`.** Solo para las estrategias con stop propio y apalancamiento por operación.
    Si hay posición y el stop no está en el libro, coloca el `STOP_LOSS` del plan. Después, el
    vigilante.
  - **Dónde se llama.** En la rama del bot pausado y tras `pauseForRisk`.
  - **`programarVigilancia`.** Con el bot pausado programa solo si hay posición sin stop.
  - **«Cancelar todo».** Pide el tick también en pausa. En el resto de estrategias ese tick no coloca
    nada, como antes.
- **Lo que no cubre.**
  - La **acción** de la guarda de liquidación en pausa: es F-12.
  - Las salidas por tiempo o invalidación en pausa, que la guía declara apagadas a propósito.
- **Decisión.** Corregido en este spec (`ebc5c9e`), aprobado por el usuario el 2026-09-17. Se añadió
  un tercer test: pausado y con el venue rechazando el stop, el vigilante cierra a mercado y avisa.
  Mutaciones, todas cazadas: quitar la llamada tras pausar (cae el de la guarda), quitarla en la rama
  del bot pausado (caen los otros dos), quitar el vigilante (cae el del cierre) y no programar la
  vigilancia en pausa (cae el del cierre).

### F-04 — Una intención `ABIERTA` que nadie cierra veta para siempre las entradas del bot

- **Síntoma.**
  - **Quién cierra.** Solo `cerrar()` escribe CERRADA (`ai-intents.store.ts:254-262`), y solo corre
    cuando una ejecución **procesada** cierra el ciclo (`bot-runner.ts:2483-2496`).
  - **Cierres que no llegan.**
    - Una ejecución que no es del bot se descarta (`bot-store.ts:462`).
    - `repairCycleFromVenue` solo corrige la cantidad (`:1173-1227`).
    - La ejecución del cierre de un STOP_AND_CLOSE o PANIC llega con el runner ya soltado
      (`bot-runner.ts:2760` → `dispose` → `onFill` sale, `:1773`), y al arrancar solo se barren
      10 min hacia atrás (`:218`).
  - **El veto.** A partir de ahí, el índice «una viva por bot» (`migration.sql:80`) rechaza toda
    ACEPTADA (`ai-intents.store.ts:195`), y cada vela con setup acaba en `AI_ENTRY_DISCARDED` WARN
    (`bot-runner.ts:2286`).
- **Caminos.**
  - Cierre a mano en el exchange, que es lo que recomiendan los propios CRITICAL del runner (`:2397`).
  - ADL del venue.
  - Stop u objetivo ejecutados con el worker caído más de 10 min.
  - STOP_AND_CLOSE y arranque más de 10 min después.
  - Un fallo puntual de la base:
    - `caducarPendientes` y `cerrar` van en el mismo `try` (`:2487-2489`);
    - `descartarEntrada` olvida `op` antes de escribir el RECHAZADA y se traga su fallo
      (`:2296-2305`).
- **Impacto.**
  - **Bot muerto.** Solo lo arregla borrarlo.
  - **Avisos.** Un WARN a Telegram por vela.
  - **Coste.** En modo IA, una llamada de pago por vela.
  - **Contabilidad.** La pérdida de esa operación no entra en el tope diario ni en la caída, porque
    el ciclo no se cierra.
- **Reproducción / test.** e2e de las revisiones ES y WK, en el scratchpad:
  - cierre manual → «Entrada descartada … otra operación sigue viva», con la intención en `ABIERTA`;
  - STOP_AND_CLOSE y arranque una hora después → lo mismo.
- **Propuesta.**
  - Con el venue plano y sin `op` en vuelo, cerrar las ACEPTADA/ABIERTA viejas con su motivo, cerrar
    el ciclo desde el venue y avisar.
  - Barrer las ejecuciones antes de soltar tras STOP_AND_CLOSE o PANIC.
  - Dar a `cerrar` su propio `try`, con reintento.
  - No olvidar `op` hasta que el RECHAZADA esté escrito.

### F-05 — El cierre a mercado del motor no se puede repetir en el mismo ciclo

- **Síntoma.**
  - **El id fijo.** `closePositionAtMarket` usa siempre `TAKE_PROFIT#999-i` del ciclo
    (`bot-runner.ts:3666`), y `place()` veta un id con fila viva o ejecutada (`:1411-1420`). Un
    segundo cierre en el mismo ciclo no sale, por ejemplo tras un primero ejecutado a medias.
  - **Quién lo sufre.** Se quedan en «no se pudo cerrar»:
    - el vigilante (`:2372-2400`);
    - la guarda de liquidación, que va por STOP_AND_CLOSE.
  - **El resto bajo mínimo.** `revisarOrden` bloquea con `RESTO_INCERRABLE` las salidas que no son
    stop (`:1371-1402`). Un resto por debajo del mínimo cuyo stop rechaza el venue no se puede
    cerrar.
  - **Los avisos.** El vigilante repite `SIN_STOP` + `ACTION_FAILED` en CRITICAL en cada vigilancia,
    sin enfriamiento, y dice que el exchange no aceptó el cierre aunque no se mandó nada.
- **Reproducción / test.** Tests de la revisión WK, en el scratchpad:
  - quedan 7,929 SOL a 25x sin stop, se manda un solo cierre y salen pares de CRITICAL cada ~6 s;
  - el caso del resto en Lighter.
- **Propuesta.**
  - Un índice por intento en los cierres del motor, como el `500+k` de la estrategia.
  - Eximir de `RESTO_INCERRABLE` los cierres definitivos de las estrategias con apalancamiento por
    operación.
  - Un mensaje fiel y enfriamiento para `SIN_STOP`.

### F-06 — El candado de administrador y el tope por venue también se aplican al readoptar

- **Síntoma.**
  - **Al adoptar.** `spawn` comprueba el rol, `disabled` y el tope por venue en **cualquier** estado
    (`engine.service.ts:594-599`). El fallo deja el bot en ERROR (`:483-491`), también uno en
    STOPPING.
  - **Sin comandos.** En ERROR la API rechaza todo menos START (`bots.service.ts:1222`), y START
    exige el rol (`:1264`).
  - **Contra lo escrito.** La consola dice que deshabilitar a alguien no para sus bots
    (`admin-users.service.ts:158-161`).
- **Escenario.**
  1. Se deshabilita a un administrador, o se le degrada por psql, con una operación del canal
     abierta.
  2. Llega el siguiente despliegue, un reinicio o un corte de Redis.
  3. El bot queda en ERROR con la posición abierta:
     - solo quedan el SL y los TP nativos;
     - no hay salida por tiempo, invalidación, vigilante ni breakeven;
     - uno en STOPPING no cierra nunca;
     - nadie puede pausarlo, pararlo ni pulsar PANIC.

  Antes del reinicio, en modo REGLAS sigue abriendo operaciones: la barrera `DUENO` de la API solo
  frena el modo IA.
- **Propuesta.**
  - El candado solo para arranques nuevos.
  - RUNNING y PAUSED se adoptan en pausa, con un evento.
  - STOPPING se adopta siempre y sin tope.
  - Releer el rol para cerrar las entradas.

### F-07 — F-06 del 057 en un hueco reutilizado: la cotización queda vetada para siempre

- **Síntoma.** El 057 (F-06) deja PENDING una orden en estado desconocido que no reduce
  (`bot-runner.ts:1486-1503`), y esa fila veta el reenvío (`:1419`). Tres piezas lo vuelven
  permanente:
  - `pendienteVencida` solo suelta filas sin id de venue (`:1664-1673`);
  - el `upsert` de una encarnación nueva **no borra** el id de venue de la anterior
    (`bot-store.ts:324-358`);
  - en una estrategia que reutiliza sus ids, la fila es la de la cotización anterior, que tenía su
    `oid`.
- **Escenario.**
  1. Un market maker en Hyperliquid tiene el venue caído: envío fallido y comprobación fallida.
  2. `QUOTE_BID#0`, cuya encarnación anterior se ejecutó, queda PENDING con el `oid` viejo.
  3. Ese lado no vuelve a cotizar en todo el ciclo.

  Con un id nuevo, «solo» son 5 min sin cotizar (WK-4). En `main` la fila se marca REJECTED y se
  reintenta: **es una regresión que trae el 057**, sin desplegar.
- **Reproducción / test.** `bot-runner.spec.ts`, «en un hueco reutilizado, la pendiente también vence
  a los cinco minutos»: 1 envío a los 6 min, cuando se esperaban 2. Sigue en rojo, sin arreglo.
- **Propuesta.**
  - La encarnación nueva empieza sin id de venue: el `upsert` lo pone a null. Hay que cuidar la
    búsqueda de `recordFill` por `venue_order_id`, que sirve a las ejecuciones sin id de cliente.
  - Y, o en su lugar, el veto de F-06 solo para órdenes de ejecución inmediata (MARKET, IOC y FOK):
    una orden en reposo que entró se ve en el libro al tick siguiente.
- **Decisión.** Corregido en este spec (`2a78e47`), aprobado por el usuario el 2026-09-17, con las
  dos partes: el veto queda solo para MARKET, IOC y FOK, y la fila nueva de un id empieza sin id de
  venue. Mutaciones cazadas: invertir la condición de «inmediata» (caen el test del 057 y el nuevo)
  y quitar el borrado del id de venue (cae el de la tienda).

### F-08 — Lighter: una orden que el secuenciador descarta queda PENDING para siempre

- **Síntoma.**
  - **El acuse.** El de Lighter guarda el índice de cliente como id de venue y dice PENDING
    (`lighter.ts:1303-1311,1400-1409`).
  - **El comentario falso.** Promete que, si el secuenciador la cancela, «la fila vence a los cinco
    minutos». No vence: `pendienteVencida` exige no tener id de venue (`bot-runner.ts:1664-1673`).
  - **Nada la corrige.** Una orden descartada sin ejecutar nunca aparece en el libro ni trae
    ejecución: una MARKET fuera de su tope, una post-only que cruzaría o un rechazo posterior al 200
    de `sendTx`. Ni el sondeo ni el stream corrigen la fila.
- **Impacto.**
  - **DCA y martingala.** Una base a mercado que no cruzó deja al bot sin entrada todo el ciclo.
  - **Market maker.** Una cotización post-only que habría cruzado deja muerto su hueco:
    `allowRefill` solo suelta filas FILLED.
  - **El canal, no.** Cada intento usa un `BASE#n` nuevo.
- **Reproducción / test.** Por lectura. El camino es el de F-01 sin la cancelación del motor.
- **Propuesta.** Que el acuse de Lighter no afirme un id de venue que no tiene (`''`, como
  Hyperliquid), para que venza como las demás. Revisarlo junto a F-01 y al CA-8 del 036 (el canal de
  cuenta con credenciales reales).

### F-09 — Tendencia recoloca su stop en el tick siguiente la mitad de las veces

- **Síntoma.** El stop se guarda redondeado al medio (`stop.toFixed`, `trend-follow.ts:314`) y se
  coloca redondeado por lado (`px(..., side)`, `:333`). En el tick siguiente se parte del valor
  guardado, `px` da otro tick y el reconciliador reemplaza el stop.
- **Impacto.**
  - Dos escrituras por cada movimiento del stop, y un stop un tick más lejos.
  - En Lighter, con F-01, el reemplazo deja la posición sin stop.
- **Reproducción / test.** `ex-tendencia-recoloca.js`: recolocaciones espurias en 98 de 200 largos
  y 100 de 200 cortos. Ya estaba en `main`.
- **Propuesta.** Guardar el precio ya redondeado por lado.

### F-10 — Canal inclinado sin «solo a favor»: entra contra la pendiente y sale en el tick siguiente

- **Síntoma.**
  - **La puerta.** Admite un inclinado con régimen de tendencia a favor sin mirar el lado
    (`ai-channel.ts:1154-1159`).
  - **Los lados.** Con la opción apagada, `ladosPermitidos` deja los dos (`canal/setups.ts:53-62`).
  - **La salida.** Cierra por `REGIMEN` una tendencia en contra (`ai-channel.ts:817-818`), que para
    un corto en un canal alcista es justo el régimen que le dejó entrar.
- **Impacto.** Churn de comisiones hasta el tope diario, a 25x. Solo con `slopedWithTrendOnly: false`,
  que no es el valor de fábrica.
- **Reproducción / test.** `s2-inclinado-contra.js`:
  - en plano: «Entrada corta … a 25x»;
  - con la posición: «Cerrando a mercado (REGIMEN)».
- **Propuesta.** Con el régimen en TENDENCIA, quitar los candidatos del lado contrario.

### F-11 — El falso quiebre de dos velas ignora la primera

- **Síntoma.** Con dos velas fuera, el extremo, y con él el stop, sale de la vela fuera más reciente
  (`canal/canales.ts:366-382`; `canal/tasas-base.ts:143-147`).
- **Impacto.** El stop AJUSTADO y el NORMAL pueden quedar por encima del mínimo real de la ruptura.
  Solo con `allowedSetups` en `FALSO_QUIEBRE` o `TODOS`, que no es el valor de fábrica.
- **Reproducción / test.** `fq-dos-velas.js`: «stop NORMAL ~ 98.4006 POR ENCIMA del mínimo de la
  ruptura».
- **Propuesta.** Ampliar la ruptura desde la vela fuera más antigua del mismo lado.

### F-12 — Pausado, la guarda de liquidación del canal solo avisa

- **Síntoma.** Las guardas se evalúan también en pausa, y `LIQUIDATION_NEAR` sale. Pero la rama del
  bot pausado sale antes de actuar (`bot-runner.ts:1055-1066`).
- **Contra las guías.** Prometen que en el canal actúa «Cerrar todo» (`riesgo-y-liquidacion.md:209-211`;
  `comandos-guardas-y-eventos.md:110`).
- **Reproducción / test.** `pausa-liquidacion.cjs`: en marcha, orden de cierre; pausado, solo el
  aviso.
- **Propuesta.** Decisión del usuario (pregunta abierta 2): actuar también en pausa en las
  estrategias con apalancamiento por operación, o corregir las guías.

### F-13 … F-30 — Medias

| ID | Qué pasa | Propuesta |
|---|---|---|
| F-13 | El límite de un `AI_FAILED` por hora (`setnx`, `ai-channel.service.ts:383-394`) se come el aviso de la pausa de 6 h tras el quinto fallo. Test de la revisión IA: «¿aviso de la pausa?» → no. | Con `fallos ≥ tope`, el aviso salta el límite. · **corregido en el 062** |
| F-14 | El poller contesta «Pausando…» siempre (`telegram-poller.service.ts:174-185`). Un vale caducado o usado, un dueño que ya no es admin o un bot que no está vivo solo dejan un log (`ai-channel.scheduler.ts:90-97`), y `BOT_PAUSED` INFO no se entrega. Test IA: 0 eventos y 0 mensajes. | Evento WARN cuando no pausa, y comprobar el vale antes de contestar. · **corregido en el 062** |
| F-15 | La caída máxima se mide sobre el realizado de toda la vida, y el 1,5× hasta las 00:00 UTC (`ai-channel.ts:1069-1075,1129-1135`). Reanudar vuelve a pausar en la revisión siguiente sin haber operado, y la guía dice «lo reanudas tú» (`docs/ai-channel.md:255-260,483`). Script `caida-reanuda.cjs`. | **Corregido en 060** (`93b1ef1`), con la decisión del usuario: el máximo se cuenta desde la última reanudación, el RESUME olvida el historial en caché, y la pausa del 1,5× —que se queda hasta las 00:00 UTC— lo dice en su aviso y en las guías. Mutaciones cazadas: ignorar la reanudación en `picoDeCaida` y no olvidar la caché. |
| F-16 | RESUME no llama a `puedeUsar` (`bots.service.ts:1259-1264`). Un dueño degradado, o un administrador deshabilitado con sesión residual, reanuda su canal: en REGLAS vuelve a operar y se salta la pausa de la estrategia. Script `reanudar-sin-rol.js`. | `puedeUsar` también en RESUME; PAUSE, STOP, PANIC y CLOSE siguen libres. |
| F-17 | El replay pasa a `sim.cancelOwn` el id del libro, que va codificado (`backtest/src/engine.ts:661,839,842`; `dry-run.ts:1215`), y `cancelOwn` solo busca el canónico (`dry-run.ts:700-707`). En HL y Lighter no se cancela nada: martingala HL con 924 ejecuciones frente a 326 en Aster; arreglado, 326 en los dos. El `vigilarStop` del replay da por bueno un stop de otro ciclo (`:682-699`). | `sim.cancelOrder` (acepta los dos) y stops del ciclo actual. Previo (007); Alta menos un nivel por ser simulación. |
| F-18 | «La operación más grande que admite» es la del stop más ancho, la más pequeña: 621 frente a un nocional máximo de 5000, margen 34,5 frente a 250 (`bot-create.page.ts:171-179`; `.html:410-436`). Script `preview-canal.cjs`. | Rótulo fiel y los techos reales. |
| F-19 | La ficha de la consola carga el detalle del dueño una vez y no lo relee con los eventos (`admin/bot-detail.page.ts:152-163,369-376,401-419`): una operación cerrada sigue pintada, y un 409 no recarga. | Releer con los eventos del bot. · **corregido en el 062** |
| F-20 | La pausa al 1,5× usa `startOfDay(user.timezone)` (`bot-runner.ts:3142-3159`; `bot-store.ts:1000-1015`); la estrategia y el panel cuentan en UTC, y las guías dicen UTC. | Día UTC para las estrategias con `topeDiarioReanuda`. |
| F-21 | Con ≥ 5 min y posición plana, la rama «entrada enviada» (`ai-channel.ts:1265-1298`) descarta aunque la operación llegó a existir (`op.maximo`). Salen un «no se llenó» falso, un RECHAZADA sobre una ABIERTA y un `AI_EXIT` con `r: null`, `intentId: null` y motivo genérico. Scripts `s1-cierre-sin-barrer.js` y e2e ES. | Si `op.maximo` existe, esperar la ejecución y avisar pasado un plazo (enlaza con F-04). · **corregido en el 062** |
| F-22 | El reparto de objetivos es desde arriba (`ai-channel.ts:1014-1018`): con el TP1 a medias, TP#0 se queda con el tramo del TP2 y TP#1 se cancela. Script `s4-tp1-parcial.js`: «replace TP0 6->5 · cancel TP1». | Repartir desde abajo: `TP#1 = min(t2, abs)` y `TP#0 = resto`. · **corregido en el 062** |
| F-23 | `booleano()` convierte lo que no es `true`/`false` en el valor por defecto (`canal/config.ts:146-147,216-217`), y `validateMeta` no mira los booleanos (`common.ts:405`). `observeOnly: 1` o `"si"` operan de verdad. Solo por la API directa. Script `s6-booleanos.js`. | Rechazar lo que no sea booleano, y leer `observeOnly` al lado seguro. · **corregido en el 062** |
| F-24 | El stop de emergencia de una huérfana es `entrada·(1 ∓ maxStopPct)` (`ai-channel.ts:886-887`). A 25x con mantenimiento del 2 %, con `maxStopPct` 3 o 5, queda detrás de la liquidación (97,96). Script `s3-huerfana-liquidacion.js`. | Acotarlo entre la entrada y la liquidación del venue. · **corregido en el 062** |
| F-25 | Aster se traga -4047/-4048 al pasar a aislado (`aster.ts:941-958`, a propósito desde 001/F-79), y el canal no mira el modo antes de entrar. Con el símbolo en cruzado y una orden manual abierta, entraría en cruzado y la cota de `maxMarginPct` dejaría de valer. | No entrar si el modo no consta ISOLATED. Por confirmar con el venue. |
| F-26 | Con `structureInterval` 5m, las tasas base miden la pendiente por vela de 5 min y el stop con ATR5 (`canal/analisis.ts:217`; `canal/tasas-base.ts:140-141,199,211`). Las etiquetas salen con stops la mitad de anchos que los de la herramienta: evidencia optimista. Scripts `tasas-5m-*.js`. | Medir con la serie de la estructura. |
| F-27 | `hayDivergencia` compara con el giro que confirma la propia ruptura (`canal/setups.ts:101-106,195`), así que casi nunca confirma un falso quiebre con vuelta fuerte. Script `divergencia-fq.js`. | Comparar con el giro anterior del mismo tipo. |
| F-28 | La clave de la caché del análisis lleva venue, símbolo, configuración y, por serie, longitud, primera `t`, última `t` y último cierre (`canal/analisis.ts:100-148`); no lleva la red ni el contenido. Script `cache-colision.js`: una serie de testnet recibe el análisis de mainnet. El efecto sería de Alta, pero exige el mismo último cierre al tick en las dos redes. | Red en la clave y huella del contenido. |
| F-29 | El simulador retira sin evento las reduce-only que ya no reducen (`dry-run.ts:898-907,963-971`): la fila queda OPEN y veta su id. Script `ex-dryrun-retirada-muda.js`. | Emitir la cancelación. |
| F-30 | `leerTramos` y `leerModo` guardan cualquier error como motivo y cierran las entradas 60 s (`bot-runner.ts:2094-2100,2120-2126`). La escala literal pondría en Alta un AUTH tragado; aquí el AUTH sale antes, en las lecturas firmadas del tick. | Relanzar AUTH y THROTTLED, como `fijarApalancamiento`. |

### F-31 … F-63 — Bajas

| ID | Origen | Qué pasa | Evidencia |
|---|---|---|---|
| F-31 | IA-3 | `AI_DECISION` se anota aunque la escritura final no movió la fila | `ai-channel.service.ts:308,343-350,380` |
| F-32 | IA-4 | El plazo que queda se mide antes de leer la configuración y los cupos | `ai-channel.service.ts:252,281` |
| F-33 | IA-5 | Los contadores de cupo cuentan también lo rechazado (el global sube tras el tope; `CUPO_GLOBAL` gasta cupo del bot) | `ai-channel.service.ts:440-454` |
| F-34 | IA-6 | Una variable vacía da `Number('') = 0` y el mínimo (1 s, cupo 1). El compose pone el defecto con `:-`, así que solo afecta a un `.env` local | `ai-channel.service.ts:133-134` |
| F-35 | IA-7 | `GETDEL` antes de comprobar el dueño, y el vale va en el payload de `AI_ENTRY`, que ven los administradores | `ai-channel.service.ts:622-650` |
| F-36 | IA-8 | `versionPrompt()` no cubre el formato del render | `prompt.ts:147-155` |
| F-37 | EX-5 | FOK y ALO degradan distinto por venue (latente: nadie los pide) | adaptadores |
| F-38 | MA-5 | Dos tests no prueban lo que dicen (ruptura > 1 ATR; no mirar al futuro) | `canales.spec.ts:109-122`; `tasas-base.spec.ts:215-222` |
| F-39 | MA-6 | En corto, tramo y margen se miden al tope de la IOC, por debajo del bid | `herramienta.ts:359-371` |
| F-40 | MA-7 | La histéresis del régimen no compara el sentido: una lectura bajista basta para salir por REGIMEN | `regimen.ts:145-151` |
| F-41 | MA-8 | El canal horizontal toma el grupo más numeroso; el plan decía el más reciente | `canales.ts:90-106` |
| F-42 | MA-9 | `swings` olvida un extremo intermedio al bajar el ATR | `swings.ts:74-79,89-94` |
| F-43 | MA-10 | `sma` no se recupera de un NaN | `estadistica.ts:15-25` |
| F-44 | UI-7 | El semáforo de liquidación sale siempre en rojo en el canal | `risk.ts:14-16` · **corregido en el 062** |
| F-45 | UI-8 | «Consultas X de N» usa el techo del servidor y no `min(presupuesto, servidor)` | panel del canal · **corregido en el 062** |
| F-46 | UI-9 | La pastilla «IA · canal» sale en modo reglas o con las entradas apagadas | consola · **corregido en el 062** |
| F-47 | UI-10 | «Sin análisis todavía» durante las esperas: la vista se anota tras las puertas del día | `ai-channel.ts` · **corregido en el 062** |
| F-48 | UI-11 | La paginación de decisiones pierde una, y «ver más» no espera turno | panel del canal |
| F-49 | UI-12, ES-10 | `maxAdverseFundingBps = 0` apaga el filtro y la guía del canal no lo dice | `ai-channel.ts:1179-1184`; `ai-channel.guide.ts:295-298` · **corregido en el 062** |
| F-50 | UI-13 | Textos inexactos: «que vio el modelo», «con sus números», «sale en gris», «cada operación» del backtest, nocional en riesgo §8, «(en la entrada)» sin costes, racha bajo «Hoy» | guías y app |
| F-51 | UI-14 | El ejemplo SOL/USDC en Hyperliquid usa un mercado sintético (paso 0,001, 50x). Por confirmar | `docs/ai-channel.md` |
| F-52 | UI-15 | «Cortar las entradas» pasa por `validate` y `assertWithinLimits`, y puede fallar | panel del canal · **corregido en el 062** |
| F-53 | ES-7 | Con la operación abierta, `invalidacionAtr`, `breakeven` y `maxStopPct` se leen de la configuración vigente | `ai-channel.ts:809,886,953` |
| F-54 | ES-8, WK-8 | `enLibro` compara el id canónico con el del venue: solo acierta en Aster. El test pasa el canónico | `ai-channel.ts:1267`; `ai-channel.spec.ts:978-986` |
| F-55 | ES-11 | `validate()` y `preview()` miden distinto el mínimo del venue: un bot que operaría no se puede crear | `ai-channel.ts:1577-1595,1640`; `common.ts:602-606` |
| F-56 | ES-12 | El interruptor global solo cierra con `off` exacto (`false`, `0` y `" off "` lo dejan abierto) | `shared/src/ia-canal.ts:360-366` |
| F-57 | WK-7 | Latente: un plan con entradas y sin decisión ACEPTADA llegaría al venue | `bot-runner.ts:2208-2224` |
| F-58 | WK-8 | `idsDeStop` incluye el stop del ciclo anterior: el vigilante daría por protegida una posición nueva con un stop sobrante | `bot-runner.ts:2990` |
| F-59 | AC-5 | Una operación que cierra después de `toMs` no cae en ninguna ventana (la app manda `toMs = Date.now()`) | `backtest/src/metrics.ts:257` |
| F-60 | AC-6 | `GET /backtests` arrastra `metrics.operaciones`: hasta 371 KB por fila | `backtests.service.ts:450-457,504` |
| F-61 | AC-7 | El aviso de fidelidad dice que la pausa al 1,5× no se reproduce, y sí se reproduce | `backtest/src/warnings.ts:113-116` |
| F-62 | AC-8 | `topeDeApalancamiento` con `POR_STOP` ignora el nocional declarado (nadie lo llama así hoy) | `risk.service.ts:168-177` |
| F-63 | AC-9 | Un aporte de margen contado como capital se pierde con un 403 si el dueño ya no es administrador | `bots.service.ts:1509-1515` |

## Verificado OK

Lo que las siete revisiones y la transversal comprobaron y está bien. No hace falta volver a
revisarlo.

- **Dimensionado del canal.**
  - Cuentas de la operación:
    - `R = min(riesgo, 0,9 · lo que queda del tope diario)`;
    - la pérdida por unidad con taker y deslizamiento;
    - N acotado por el múltiplo, `capital·Lmax`, `maxNotionalCap` y el techo del tramo;
    - con `Lmin > Lmax` se recorta N y no se sube la palanca.
  - Topes y redondeos:
    - el saldo libre al 90 %;
    - las cantidades a la baja y un paso menos en la frontera del tramo;
    - `nocionalMaximo` por encima de cualquier N posible.
  - El fuzz de 10.000 casos cubre las tres garantías.
- **Apalancamiento por stop.** `apalancamientoPorStop` y `precioLiquidacionAislada` (`floor`,
  `(1+mmr)`, colchón ≥ 3, topes filtrados) coinciden con la liquidación aislada de Hyperliquid.
- **Redondeos del canal.** Stop y objetivos hacia la entrada; el tope de la IOC nunca añade
  deslizamiento; `px` y `normalizeOrder` no vuelven a mover un precio que ya está en la retícula.
- **La herramienta.** R netos, coste en R, acierto de equilibrio y viabilidad por esquema.
  `construirOperacion` revalida candidato, dirección, setup, canal, esquema y banda con la salida
  fresca.
- **El juez.** Preferencias por perfil, y el paso contiguo solo hacia lo prudente.
- **`plan()` con posición.**
  - Stop siempre.
  - Objetivos que suman la posición y se funden bajo el mínimo.
  - Breakeven que mejora el stop y se guarda.
  - Salidas en orden, `TP#500..511` cada 30 s con CRITICAL al agotarse, y sin apalancamiento con
    posición.
- **`plan()` en plano.**
  - El orden de las puertas.
  - El tope diario hasta las 00:00 UTC.
  - Ventanas UTC, incluidas las que cruzan medianoche.
  - Spread contra el ATR y funding.
  - Sin historial o sin límites no hay entrada.
- **La decisión de la IA en la estrategia.**
  - Sus comprobaciones:
    - vigencia, misma vela y mismo ciclo;
    - huella de la salida completa;
    - confianza mínima antes de reducir;
    - candidato `LISTO` y de uso único;
    - vela posterior a la última salida.
  - Solo cuenta `DECIDIDA`.
- **El lazo de la IA en la API.**
  - Reclamación con escritura condicional.
  - Barreras (interruptor, clave, dueño leído de la base, bot vivo, pausa por fallos, cupos) y
    cupos contados antes de llamar; con Redis caído, no se llama.
  - Cierre condicionado a `CONSULTANDO`.
  - Contrato sin números, parser que no repara nada y elección validada contra la oferta.
  - Render sin precios absolutos, importes ni nombres.
- **El orden de la entrada en el worker.**
  - Pausar, avisos, solicitud, anotar, `setLeverage` solo en plano, orden, con `op` guardado antes.
  - Qué pasa si falla cada paso: AUTH y THROTTLED se relanzan.
  - Los acuses de apalancamiento de cada venue, y sin sincronizarlo al arrancar ni al recargar.
- **Lo del 057 en el runner.** Estos cinco están bien; F-06 y F-01, en cambio, tienen los hallazgos
  F-07 y F-01 de arriba:
  - F-06 en las entradas a mercado;
  - F-08 (rama `default` con `never`);
  - F-09 (solo informativo);
  - F-11;
  - F-02 (`conservarStopPropio`).
- **Vigilante y temporización.**
  - Vigilante: umbrales de 5 y 10 s, y «confirmado» bien definido.
  - Ticks de vigilancia y despertador de cierre de vela: sin duplicados, con desfase por bot, velas
    fuera del cerrojo, parada limpia.
- **Historial e intenciones.**
  - `historialOperaciones`: día UTC, racha, pico en una consulta, caché con invalidación.
  - Intenciones: escrituras condicionales, P2002 → `false`, caducidad ante ejecuciones, comandos,
    recargas, pausas y reanudación.
- **Avisos.**
  - `AI_ENTRY` una vez, también tras reinicio.
  - `AI_EXIT` en lugar de `CYCLE_CLOSED`, con R.
  - Vale de pausa con plazo de 1 s y sin botón si Redis falla.
- **Acceso.**
  - El rol se lee de la base en la API, el worker y la barrera.
  - Solo administradores en listado, vista previa, creación (también simulada y con `startActive`),
    edición y arranque.
  - Rechazado por el asesor y el supervisor; fuera del ranking y de los planes, incluida la semilla.
  - `AI_INTENT` no se admite como comando.
- **Riesgo.**
  - `assertWithinLimits` usa el nocional declarado y el tope `min(25, par)` solo con la regla por
    stop; el resto de estrategias no cambia.
  - `max_notional` se escribe al crear, al editar y al adoptar.
- **Migración.**
  - Solo hacia delante, `ADD VALUE IF NOT EXISTS` sin uso en la misma transacción.
  - Tipos, índices y `ON DELETE CASCADE` casan con `schema.prisma`, y las longitudes bastan.
- **Backtest del canal.**
  - Series sin mirar al futuro, también dentro de la vela.
  - Calentamiento de 481 h, y `serieImposible` → 400.
  - Con posición, la vela va primero hacia el stop.
  - El historial coincide con el del worker.
  - Wilson, R medio, esperanza y factor de beneficio correctos.
  - El resto de estrategias solo cambia por F-04 del 057, a propósito.
- **057, resto.** Las velas finales con gracia, `reduceOnly` en el simulador, IOC de Hyperliquid y
  cierres críticos en el presupuesto.
- **App.** Las 68 comprobaciones de `ia-canal-vistas.spec`, los 48 campos con su etiqueta y su
  ayuda, y los enlaces y anclas de las guías.

## Preguntas abiertas

1. **¿Hay bots con stop en Lighter en producción?** Una consulta de solo lectura lo diría, pero
   necesita tu contraseña SSH. Si los hay, F-01 ya les afecta en `main`, y peor que en la rama.
2. **F-12: la guarda de liquidación del canal con el bot pausado.** ¿Debe cerrar, como dicen las
   guías, o solo avisar, como el resto de estrategias, y se corrigen las guías?
3. **F-06: un canal cuyo dueño deja de ser administrador.** ¿Se adopta en pausa (recomendado) o sigue
   operando?
4. **F-35: el vale de pausa.** ¿Solo lo canjea su dueño, y fuera de `bot_events`?
5. **F-41: el grupo del canal horizontal.** ¿El más reciente, como decía el plan, o el más numeroso,
   como hace el código?
6. **F-49: `maxAdverseFundingBps = 0`.** ¿Significa «sin filtro», como en el market maker, o «ningún
   funding en contra»?
7. **F-01: el acuse sin `oid` de un disparador de Hyperliquid.** Se confirma en testnet con
   credenciales, que es tarea tuya.

## Specs de seguimiento propuestos

| Nº propuesto | Slug | Hallazgos | Prioridad |
|---|---|---|---|
| 061 | `lighter-ids-y-pendientes` | F-08; F-01 en el acuse; CA-8 del 036 | alta |
| 062 | `canal-operacion-cerrada-fuera` | F-04, F-21, F-24, F-53 | alta |
| 063 | `cierres-del-motor-y-pausa` | F-05, F-12, F-58 | alta |
| 064 | `canal-acceso-y-adopcion` | F-06, F-16, F-35, F-63 | alta |
| 066 | `tendencia-stop-redondeado` | F-09 | alta |
| 067 | `canal-estructura` | F-10, F-11, F-26, F-27, F-28, F-38 a F-43 | media |
| 068 | `canal-ia-avisos-y-cupos` | F-13, F-14, F-31 a F-34, F-36 | media |
| 069 | `canal-app-y-guias` | F-18, F-19, F-20, F-44 a F-52 | media |
| 070 | `replay-y-simulador` | F-17, F-29, F-59 a F-61 | media |
| 071 | limpieza | F-22, F-23, F-25, F-30, F-37, F-54 a F-57, F-62 | baja |
