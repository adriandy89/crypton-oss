# 057 — Hallazgos

Commit base: `3f03d43` (`main`) · Fecha: 2026-09-17 · Versiones: node 24.12.0, pnpm 10.28.1 · Hosts
sondeados: ninguno. Los formatos de Aster y Lighter salen de sus SDK y de su documentación, no de
llamadas.

## Línea base

Sobre `3f03d43`, antes de tocar nada:

- `pnpm test`: **7216 tests** en verde.
  - API: 5790.
  - worker: 374.
  - exchange-core: 399.
  - strategy-core: 510.
  - shared: 112.
  - backtest: 31.
- `pnpm lint`: 0 errores, con los 3 avisos de siempre.
- `check:env`: coherente.
- Builds de API, worker y app, y `tsc` de la API: limpios.

## Resumen

| ID | Título | Área | Severidad | Estado | Evidencia |
|---|---|---|---|---|---|
| F-01 | Los stops nativos se cancelan y se recolocan en cada tick | reconciliación / adaptadores | Crítica | corregido en 057 | `reconcile.ts:184,252`; `hyperliquid.ts:570,766-769`; `aster.ts:1225-1241`; `lighter.ts:2337-2360`; `dry-run.ts:1022-1038`; `stop-loss.ts:63-71` |
| F-02 | Tendencia suelta su stop si le faltan velas | estrategia | Crítica | corregido en 057 | `trend-follow.ts:427-440`; `stop-loss.ts:42`; `reconcile.ts:208-212`; `bot-runner.ts:737,2342-2351` |
| F-03 | Una vela descargada antes de su cierre se sirve como cerrada | datos del worker | Alta | corregido en 057 | `market-data.service.ts:38,322-330` |
| F-04 | El backtest no pasa velas ni extremos a `plan()` | backtest | Alta | corregido en 057 | `backtest/src/engine.ts:312-334` |
| F-05 | El simulador ignora `reduceOnly` | simulador | Alta | corregido en 057 | `dry-run.ts:535-547,779-807,933-975` |
| F-06 | Una orden en estado desconocido se puede mandar dos veces | worker | Alta | corregido en 057 | `rate-limit.ts:133-145`; `bot-runner.ts:1168-1170,1226` |
| F-07 | Hyperliquid manda una LIMIT IOC como GTC | adaptador | Media | corregido en 057 | `hyperliquid.ts:788-797` |
| F-08 | Un comando desconocido se da por ejecutado | worker | Media | corregido en 057 | `bot-runner.ts:1759-1970`; `engine.service.ts:300-302`; `command-inbox.service.ts:104-114` |
| F-09 | «SIN stop loss» con el stop propio de Tendencia vivo | worker | Media | corregido en 057 | `bot-runner.ts:2129-2135` |
| F-10 | Los cierres a mercado no pasan como críticos en el presupuesto | exchange-core | Media | corregido en 057 | `venue-budget.ts:36-50` |
| F-11 | «Recentrar» se anuncia en estrategias sin ancla | worker | Baja | corregido en 057 | `bot-runner.ts:86-95` |

Estados: `por confirmar` · `confirmado` · `corregido en 057` · `seguimiento NNN` · `descartado`.

## Fichas

### F-01 — Los stops nativos se cancelan y se recolocan en cada tick

- **Síntoma.** `reconcile` empareja por id y compara el `price` de la orden viva con el de la
  deseada (`reconcile.ts:184`, medio tick de tolerancia en `:252`). Nada trata aparte las órdenes
  con disparo.
  - **La deseada.** El stop que emite `withStopLoss` lleva `price = triggerPrice`
    (`stop-loss.ts:63-71`), igual que el de Tendencia.
  - **Hyperliquid.** Un stop a mercado sale con un límite a ±5 % del disparo
    (`hyperliquid.ts:766-769`), y `getOpenOrders` lo informa con `price: limitPx` (`:570`). Su
    propio fixture lo muestra: `'66500'` para un disparo `'70000'` (`hyperliquid.spec.ts`).
  - **Aster.** `toVenueOrder` informa `o.price`, que en un `STOP_MARKET` de estilo Binance vale
    `"0"`. Además llama `LIMIT` a todo lo que no es `MARKET`, e ignora `stopPrice`, que ni siquiera
    está en el tipo `AsterOrder` (`aster.ts:1225-1241,1313-1327`).
  - **Lighter.** `toVenueOrder` informa el precio de ejecución (±5 %), llama `LIMIT` a un
    `stop-loss` e ignora `trigger_price`, aunque el SDK lo trae (`lighter.ts:2337-2360`).
  - **El simulador.** Informa `req.price` y no informa del disparo (`dry-run.ts:1022-1038`), así
    que en papel el fallo no se veía.
- **Qué pasa.** El precio nunca coincide, la orden va a `toReplace` y `execute()` la cancela y la
  vuelve a colocar (`bot-runner.ts:1036-1046`) **en cada tick**, con cada bot que tenga posición y
  stop.
- **Impacto.**
  - **Sin stop entre la cancelación y la nueva colocación.** Si la colocación falla —límite de
    peticiones, un corte—, la posición se queda sin stop hasta que salga.
  - **El presupuesto.** Son dos escrituras cada 15 s por bot. En Lighter (60 por minuto por IP),
    unos 6 bots con stop agotan el presupuesto de todos.
  - **La fila del stop.** En Hyperliquid el acuse de una orden con disparo no trae id (`:845-850`),
    así que la fila puede quedarse PENDING y vetar la recolocación hasta 5 minutos.
  - **También el TP de Trailing.** El de Trailing es una orden con disparo y sufre lo mismo.
- **Reproducción / test.** `reconcile.spec.ts`: stop deseado con disparo 70000 frente a uno vivo con
  precio 66500 y disparo 70000 → hoy va a `toReplace`.
- **Propuesta.**
  - En una orden deseada con disparo se compara `triggerPrice`, no `price`. Si la viva no trae
    disparo, no es la misma orden y se reemplaza.
  - En una deseada sin disparo, una viva con disparo tampoco es la misma.
  - Aster, Lighter y el simulador informan del disparo y del tipo real.
- **Decisión.** Corregir en este spec.
- **Confirmación.** Antes del arreglo fallaban:
  - cinco de los seis tests nuevos de `reconcile.spec.ts` (worker);
  - el de Lighter en `lighter-transport.spec.ts`, que recibía `type: LIMIT` y ningún disparo;
  - el del simulador en `exchange-core.spec.ts`;
  - el del runner en `bot-runner.spec.ts`: con el stop en el libro como lo informa Hyperliquid, diez
    ticks lo mandaban **diez veces**.
- **Arreglo.**
  - `reconcile.ts` (`cambioDePrecio`): la cantidad se sigue comparando igual.
  - Aster, Lighter y el simulador informan del disparo.
  - El **tipo no se compara**, a propósito. El evento del WebSocket de Hyperliquid llega como
    `LIMIT` sin disparo, y cada adaptador nombra distinto sus condicionales. Lo que distingue una
    orden en reposo de una condicional es tener disparo, y eso sí se compara.
  - Aster lee el disparo con `firstNum`: un `stopPrice` vacío es «sin disparo» y no tumba el tick.

### F-02 — Tendencia suelta su stop si le faltan velas

- **Síntoma.** `trendFollow.plan` devuelve `orders: []` si no hay velas suficientes o si falta el
  ATR, **antes** de llegar a la rama con posición (`trend-follow.ts:427-440`).
- **Cadena del fallo.**
  - `withStopLoss` no añade nada, porque en Tendencia `stopLossPct` va vacío a propósito
    (`stop-loss.ts:42`).
  - `reconcile` da el stop vivo por propio y no deseado, y lo cancela (`reconcile.ts:208-212`).
- **Cuándo pasa.**
  - Tras cada reinicio o adopción del worker: el primer tick corre al momento (`bot-runner.ts:737`)
    con la caché de velas fría (`market-data.service.ts:315-330`).
  - Mientras la descarga de velas falle, por ejemplo con Lighter limitando peticiones.
- **Impacto.** Una posición apalancada sin stop durante al menos un tick en cada despliegue, y
  **sin plazo** mientras falten los datos.
- **Reproducción / test.** `trend-follow.spec.ts`: posición abierta, sin velas y con `stopPrice`
  guardado → hoy no emite stop.
- **Propuesta.**
  - La rama con posición va primero y no necesita velas: usa el stop guardado.
  - Sin stop guardado ni ATR, ancla un stop de emergencia al precio de entrada con el ATR de
    reserva que ya usa la vista previa.
  - Guarda en el runner: con posición abierta, un plan que no trae ningún `STOP_LOSS` no cancela el
    que hay.
- **Decisión.** Corregir en este spec.
- **Confirmación.** Antes del arreglo fallaban:
  - cinco tests de `trend-follow.spec.ts`: con posición y sin velas, o con velas planas, no había
    stop;
  - el de integración en `bot-runner.strategies.spec.ts` (estrategia, runner y simulador reales):
    tras tres ticks sin velas, el stop ya no estaba en el libro;
  - el de la guarda en `bot-runner.spec.ts`.
- **Arreglo.**
  - **La estrategia.** `stopDeLaPosicion` va antes de mirar las velas.
    - Con velas: hace lo de siempre.
    - Sin velas, o con ATR cero: mantiene el stop guardado.
    - Sin stop guardado: pone uno de emergencia en `entrada ∓ k × 2 % × entrada`, con el mismo ATR
      de reserva que la vista previa (`ATR_DE_RESERVA`). Ese no se guarda: cuando vuelven las
      velas, manda el calculado, que es con el que se dimensionó la posición. Puede quedar más
      lejos que el de emergencia; se acepta, porque es el que corresponde al riesgo declarado.
  - **El flag.** Nuevo `Strategy.stopPropio`, que declara Tendencia.
  - **El runner.** `conservarStopPropio` quita de `toCancel` las órdenes propias que reducen y
    llevan disparo (o el id de `STOP_LOSS#0`) cuando se cumplen las tres condiciones:
    - la estrategia declara `stopPropio`;
    - hay posición;
    - el plan no trae stop.

    Avisa una vez por racha con `ACTION_FAILED` en WARN.
  - **Lo que no cambia.** Sin `stopPropio`, quitar `stopLossPct` sigue retirando el stop, que es
    decisión del usuario. Sin posición, el stop sobrante se cancela igual.

### F-03 — Una vela descargada antes de su cierre se sirve como cerrada

- **Síntoma.** `candleHistory` filtra las cerradas con `c.t + span <= now` (`:329`). Una vela
  descargada **antes** de su cierre pasa por cerrada en cuanto el reloj supera su final, con los
  datos de antes del cierre, hasta el siguiente refresco: un TTL de 60 s (`:38`) que no está
  alineado al cierre.
- **Impacto.** Tendencia puede entrar por un cierre que nunca ocurrió, y cualquier decisión sobre
  velas de 5 o 15 min llega hasta un minuto tarde.
- **Reproducción / test.** `market-data.spec.ts`: descarga a las 10:14:30 de la vela de las 10:00
  (15 min) y lectura a las 10:15:05 → hoy se entrega como cerrada.
- **Propuesta.**
  - Una vela es final solo si `t + span + gracia <= fetchedAt`.
  - Refresco al cierre (+ 2-5 s, con un desfase por símbolo) cuando falte la última vela esperada,
    con un reintento, antes de volver al TTL.
- **Decisión.** Corregir en este spec.
- **Confirmación.** Dos tests nuevos de `market-data.spec.ts` fallaban antes del arreglo:
  - a las 10:15:05 se entregaba la vela de las 10:00 descargada a las 10:14:30, con su cierre a
    medias;
  - el siguiente refresco llegaba a las 10:15:30, por TTL, y no al cierre.
- **Arreglo.**
  - **Cuándo es definitiva una vela.** `pedidasEn` guarda la hora de **salida** de la petición: la
    respuesta refleja el venue en algún momento entre la salida y la llegada. Una vela es
    definitiva si `t + span + 2 s ≤ pedidasEn`.
  - **El refresco al cierre (`faltaElCierre`).** Si falta la vela que ya debería haber cerrado,
    se pide sin esperar al TTL, a `cierre + 2 s + desfase(clave)` con el desfase entre 0 y 3 s.
    Como mucho dos intentos separados 5 s; después, el TTL de siempre.
  - **Semanas y meses.** Solo se aplica hasta 1 día: las semanas empiezan en lunes y los meses no
    duran lo mismo.
  - **Test de no regresión.** Con la vela esperada ya en la ventana, no se pide nada antes del TTL.

### F-04 — El backtest no pasa velas ni extremos a `plan()`

- **Síntoma.** `contexto()` construye el `BotContext` sin `candles` ni `extremos`
  (`engine.ts:312-334`).
- **Impacto.**
  - Tendencia devuelve «esperando velas» en todo el replay y **nunca opera en un backtest**.
  - El trailing de Trailing no ve la marca de agua de cada vela.
- **Reproducción / test.** `engine.spec.ts`: una serie con una ruptura clara → hoy Tendencia no
  opera.
- **Propuesta.** El contexto de cada vela lleva las velas ya reproducidas (la actual incluida,
  porque se planifica al final de la vela) y el máximo y el mínimo de la vela como `extremos`.
  - **Intervalo mayor que el del replay.** Si el que pide la estrategia es múltiplo del del replay,
    se agregan cubos completos alineados al reloj, con un ayudante nuevo en
    `shared/candle.ts`.
  - **Intervalo menor.** No hay velas, y se avisa.
- **Decisión.** Corregir en este spec.
- **Confirmación.** Los cinco tests nuevos de `engine.spec.ts` fallaban antes del arreglo:
  - Tendencia no operaba ni con su intervalo ni con uno agregado;
  - no había avisos de intervalo ni de calentamiento;
  - el seguimiento salía con el cierre y no con el máximo de la vela.
- **Arreglo.**
  - **El ayudante.** `agregarVelas(velas, origen, destino, hasta)` en `shared/candle.ts`, con sus
    tests. Agrega en cubos alineados a UTC, hasta un día.
    - Solo devuelve cubos cerrados en `hasta`, y solo los que empiezan con su primera vela.
    - Un hueco en medio no invalida el cubo.
    - Devuelve `null` si el destino no se puede construir: es menor, no es múltiplo o pasa de un
      día.
  - **El replay.**
    - Agrega una vez, antes del bucle.
    - En cada vela entrega a la estrategia las de su intervalo ya cerradas, la actual incluida. El
      test de la hora agregada fija que no se entra con una hora a medias.
    - Los `extremos` son el máximo y el mínimo de los pasos de la vela. Se vacían solo al
      planificar, como en el runner.
  - **Los avisos.**
    - Si el intervalo no sirve, el replay lo dice.
    - Dice cuántas velas se gastan en calentar.
    - El aviso de Seguimiento se reescribe: el máximo ya no se mide sobre el cierre.
  - **Las guías.** `trailing-profit.md`, `trend-follow.md` y `simulacion-y-backtest.md`.

### F-05 — El simulador ignora `reduceOnly`

- **Síntoma.** `executeFill` aplica la cantidad entera sin mirar `reduceOnly`
  (`dry-run.ts:933-975`). Pasa igual en tres sitios:
  - la rama `MARKET` de `placeOrder` (`:535-547`);
  - las condicionales disparadas (`:779-807`);
  - las límites casadas (`:746-760`).
- **Impacto.**
  - Un stop y un objetivo de la misma posición que se ejecutan en la misma vela **giran la
    posición** en papel y en backtest.
  - Un cierre mayor que la posición abre otra en contra.
  - Los resultados simulados no se parecen a lo que haría el venue.
- **Reproducción / test.** `dry-run.spec.ts` (nuevo): posición de 1, stop y objetivo de 1 cada uno,
  y un precio que cruza los dos → hoy termina con −1.
- **Propuesta.** `cantidadEjecutable`, que para una orden `reduceOnly`:
  - la recorta a lo que queda de posición;
  - la cancela si ya no reduce.
  - Una `MARKET` `reduceOnly` sin posición se rechaza por reglas, como en el venue.
- **Decisión.** Corregir en este spec.
- **Confirmación.** Cinco de los seis tests nuevos fallaban antes del arreglo. Van en
  `exchange-core.spec.ts`, junto al resto del simulador y su fuente de precios, y no en un
  `dry-run.spec.ts` aparte:
  - stop y objetivo en la misma vela;
  - un cierre mayor que la posición;
  - una límite mayor que la posición;
  - una de mercado sin posición;
  - una de mercado en el sentido que aumenta.

  El sexto es el control y ya pasaba: sin `reduceOnly`, una venta mayor sí gira la posición.
- **Arreglo.** `cantidadEjecutable` en los tres caminos: mercado, condicional disparada y límite
  tocada.
  - Lo que ya no reduce se retira sin ejecutarse.
  - La de mercado se rechaza con `RULES`.
  - El aplanado por liquidación ya iba con la cantidad exacta y no cambia.
  - La opción `limitFill: TRADE_THROUGH` queda para el 058, que es quien la usa.

### F-06 — Una orden en estado desconocido se puede mandar dos veces

- **Síntoma.**
  - Cuando el envío falla y la comprobación de si entró también falla, `withWriteRetry` lanza
    «Estado desconocido» (`rate-limit.ts:133-145`). Su comentario confía en que el tick siguiente
    lo resuelva.
  - Pero `place()` marca la fila REJECTED antes de mirar el tipo de error (`bot-runner.ts:1226`),
    y una fila REJECTED no veta la recolocación (`:1168-1170`).
  - Una orden a mercado que sí entró ya no aparece entre las abiertas.
  - Si la posición aún no se ve en el siguiente tick (Lighter acusa las de mercado como PENDING),
    la estrategia la vuelve a pedir y sale **otra vez**.
- **Impacto.** Exposición doble en una carrera estrecha, bajo degradación del venue: 503
  sostenidos, límites de peticiones.
- **Reproducción / test.** Runner: el primer envío lanza el estado desconocido y la posición sigue
  sin verse → hoy hay un segundo `placeOrder`.
- **Propuesta.**
  - `ExchangeError` marca el estado desconocido.
  - `place()` deja la fila PENDING, que veta la recolocación hasta que la sincronización con el
    venue la resuelva o venza a los 5 minutos, y lo dice en la bitácora.
- **Decisión.** Corregir en este spec, si el test lo confirma.
- **Confirmación.**
  - En el runner: la entrada con estado desconocido salía **dos veces** en dos ticks, y la fila
    acababa REJECTED.
  - En `write-retry.spec.ts`, cuatro tests nuevos no compilaban antes del arreglo, porque el campo
    no existía; el quinto, sobre el último intento, lo destapó la lectura:
    - tras el último intento fallido no se preguntaba si la orden había entrado;
    - ese intento podía haber entrado igual que los anteriores.
- **Arreglo.**
  - **La marca.** `ExchangeError.estadoDesconocido`, un quinto parámetro opcional.
    `withWriteRetry` la pone cuando la comprobación falla, y ahora comprueba también tras el
    último intento.
  - **`place()`.**
    - Con la marca, y si la orden **no** es `reduceOnly`, deja la fila PENDING. Avisa en WARN
      (`ORDER_RETRY`) y cuenta el fallo hacia la pausa por colocaciones fallidas.
    - Las `reduceOnly` siguen el camino de siempre: un duplicado no puede abrir nada, y un stop o
      un cierre no deben esperar cinco minutos. Lo fija un test.
  - **El veto.** Solo alcanza al mismo id, que es lo que la estrategia vuelve a pedir. El bloqueo
    de entradas con **otro** id mientras dura la duda queda para el 058, cuya intención de
    operación ya lo contempla.
  - **La guía.** `comandos-guardas-y-eventos.md` explica el `ORDER_RETRY` en WARN.

### F-07 — Hyperliquid manda una LIMIT IOC como GTC

- **Síntoma.** Para `LIMIT`, el adaptador usa siempre `Gtc` e ignora `timeInForce`
  (`hyperliquid.ts:788-797`).
- **Impacto.** Una orden pedida «inmediata o nada» se queda en el libro. Hoy ninguna estrategia la
  pide, pero la necesita la entrada con tope de precio del bot de canales.
- **Propuesta.** `timeInForce: 'IOC'` se traduce a `Ioc`.
- **Decisión.** Corregir en este spec.
- **Confirmación.** Los dos tests nuevos de `hyperliquid.spec.ts` fallaban antes del arreglo: la IOC
  salía como `Gtc`, y la FOK también.
- **Arreglo.** `tifDe` traduce la vigencia pedida:
  - `ALO` → `Alo`;
  - `IOC` → `Ioc`, con el precio pedido y sin la holgura del 5 % de las de mercado;
  - `FOK` se rechaza con `RULES`, porque Hyperliquid no la tiene.
- **Queda para el 058.** Lo necesitan sus entradas IOC:
  - el simulador trata una límite IOC como una en reposo;
  - el «could not immediately match» de Hyperliquid no tiene clasificación propia.

### F-08 — Un comando desconocido se da por ejecutado

- **Síntoma.**
  - El motor pasa el comando de la base con un cast (`engine.service.ts:300-302`).
  - `runCommand` no tiene rama por defecto (`bot-runner.ts:1759-1970`).
  - La bandeja lo cierra como ejecutado (`command-inbox.service.ts:104-114`).
- **Impacto.** Un comando nuevo que llega a un worker antiguo se pierde en silencio, y la API cree
  que se hizo.
- **Propuesta.** Rama por defecto que lanza. La bandeja lo cierra con el motivo y sale
  `COMMAND_FAILED`.
- **Decisión.** Corregir en este spec.
- **Confirmación.** El test nuevo del runner fallaba antes del arreglo: `handleCommand` con un comando
  inventado se resolvía sin error.
- **Arreglo.**
  - **La rama por defecto.** Lanza con el nombre del comando, y su `never` hace que un comando nuevo
    sin rama no compile.
  - **La bandeja.** Ya cerraba con el motivo lo que lanza (tiene su test).
  - **El aviso.** `COMMAND_FAILED` gana etiqueta en la app («Comando no ejecutado») y fila en
    `comandos-guardas-y-eventos.md`. Hasta ahora salía con la constante tal cual.

### F-09 — «SIN stop loss» con el stop propio de Tendencia vivo

- **Síntoma.** `protectionNote` decide solo por `config.stopLossPct` (`bot-runner.ts:2129-2135`).
  En Tendencia ese campo va vacío y el stop lo pone la estrategia, así que cada aviso dice «la
  posición queda SIN stop loss» aunque el stop esté vivo.
- **Impacto.** Una alerta falsa en cada aviso de un bot de Tendencia, y quien la lee deja de creer
  las verdaderas.
- **Propuesta.** Flag `stopPropio` en la estrategia. Con él, la nota decide por `stopLossVivo`.
- **Decisión.** Corregir en este spec.
- **Confirmación.** Tres tests nuevos del runner fallaban antes del arreglo:
  - Tendencia con su stop en el libro recibía «SIN stop loss»;
  - Tendencia con el stop rechazado, también;
  - con `stopLossPct` y el stop ya en el libro tras un reinicio, «NO consta colocado». La lectura
    destapó este tercero: `stopLossVivo` solo lo encendía un acuse de este proceso.
- **Arreglo.**
  - **La nota.** `protectionNote` usa `stopPropio`, el flag que añadió el F-02, y tiene su propia
    redacción cuando el stop propio no consta.
  - **`stopLossVivo`.** Se toma del libro en cada tick, antes de las guardas, con
    `idsDeStop(cycleSeq)`, que ahora comparte con la guarda del F-02. `place()` lo sigue
    corrigiendo si coloca o le rechazan.
  - **La guía.** `riesgo-y-liquidacion.md`.

### F-10 — Los cierres a mercado no pasan como críticos en el presupuesto

- **Síntoma.** El comentario dice que `critical` es «el stop-loss, los cierres y el pánico», pero
  `prioridadDeOrden` solo marca crítico lo que lleva disparo (`venue-budget.ts:36-50`).
- **Impacto.** Un cierre a mercado —manual, de pánico o de una estrategia— compite con las
  recotizaciones cuando el presupuesto aprieta.
- **Propuesta.** Una `MARKET` `reduceOnly` también es `critical`.
- **Decisión.** Corregir en este spec.
- **Confirmación.** El test nuevo de `exchange-core.spec.ts` no compilaba antes del arreglo: la firma
  solo aceptaba `triggerPrice`.
- **Arreglo.**
  - `prioridadDeOrden` da `critical` también a una `MARKET` `reduceOnly`.
  - Una límite que solo reduce sigue en `write`: es un objetivo, no un cierre, y los market makers en
    alto riesgo las mandan por capas.

### F-11 — «Recentrar» se anuncia en estrategias sin ancla

- **Síntoma.** `REANCHOR_NO_APLICA` no incluye Tendencia ni Trailing (`bot-runner.ts:86-95`). La
  API ya lo impide, pero el motor, si el comando le llega, anuncia «retícula recentrada» y borra
  los niveles del ciclo.
- **Propuesta.** Añadir las dos, con su motivo.
- **Decisión.** Corregir en este spec.
- **Confirmación.** Los dos casos nuevos (`it.each`) fallaban antes del arreglo: el motor guardaba el
  ancla y anunciaba `GRID_REANCHORED`.
- **Arreglo.** Las dos entradas en `REANCHOR_NO_APLICA`, y la nota en `comandos-guardas-y-eventos.md`.

## Verificación

Sobre la punta de la rama:

- `pnpm test`: **7280 tests** en verde, 64 más que en la línea base.
  - API: 5790.
  - worker: 398.
  - exchange-core: 419.
  - strategy-core: 517.
  - shared: 120.
  - backtest: 36.
- `pnpm lint`: 0 errores, con los 3 avisos de siempre.
- `check:env`: coherente.
- Builds de API, worker y app, y `tsc` de la API: limpios. La app, sin avisos de presupuesto.
- **Mutaciones: caen las 28.** Rompen a propósito cada arreglo y se restauran byte a byte; la de
  `reconcile` recompila `strategy-core` antes y después.
  - En la primera pasada sobrevivió una: «sin velas se ignora el stop guardado». El stop guardado
    del test (95) coincidía con el de emergencia de esa entrada, así que las dos ramas daban lo
    mismo.
  - El test usa ahora uno que ya ha subido (112) y comprueba la nota por su texto propio.

## Observaciones fuera de alcance

- **O-1. Los specs del worker no pasan `tsc`.**
  - **Qué falla:**
    - al `FakeAdapter` de `bot-runner.spec.ts` le faltan `capabilities`, `getTickers` y
      `getCandles`;
    - hay dos `DesiredState` con `cancelAll`;
    - hay dos conversiones en `market-data.spec.ts`.
  - **Por qué no se ve:** jest no lo detecta porque el worker compila con `isolatedModules`, y
    `nest build` excluye los specs.
  - **Alcance:** viene de antes de este spec y no llega a producción. Pero un test con los tipos
    rotos puede estar probando algo que ya no existe.
- **O-2. Mover un stop sigue siendo cancelar y después colocar.** Ya está en «Fuera de alcance» del
  spec.
- **O-3. Para el 058, que usa entradas IOC.**
  - El simulador trata una límite IOC como una en reposo.
  - El «could not immediately match» de Hyperliquid no tiene clasificación propia (F-07).
  - Mientras dura un estado desconocido, no se bloquean las entradas con **otro** id (F-06).

## Preguntas abiertas

- **Despliegue, aparte y antes del 058.** Lo decide el usuario.
  - Cambian los paquetes, el worker (el motor y las velas), la API (el backtest de F-04 y los tipos
    compartidos) y la app (una etiqueta).
  - No hay migración.
  - Orden: worker y API, y después la app.
- **CA-4** (manual, opcional, con el usuario). Una consulta de solo lectura en producción: cuántos
  reemplazos de `STOP_LOSS` había antes del despliegue y cuántos después.

## Specs de seguimiento propuestos

- Higiene de tipos en los specs del worker, con `tsc -p tsconfig.json` en su verificación (O-1).
- Mover el stop colocando el nuevo antes de cancelar el viejo (O-2).
