# 065 — El canal con IA no mantiene su ritmo

Estado: `hecho` (falta CA-13, la comprobación del usuario tras desplegar) · Tipo: `cambio` · Rama: `spec/065-ritmo-y-caudal-del-canal`

## Objetivo

Que un bot del canal con IA cierre su revisión dentro del intervalo del motor, y que la plataforma
aguante más bots sin que el cupo de peticiones del venue se convierta en una espera invisible. Se
sabrá que está conseguido cuando los cuatro simulados del incidente dejen de emitir `TICK_SLOW`, y
cuando el caudal avise antes de que un usuario lo note.

## Contexto

Incidente del 2026-09-19, 10:36 UTC. Cuatro bots **simulados** de `AI_CHANNEL` sobre Hyperliquid
(SOL, BTC, HYPE, ETH) avisan, uno detrás de otro:

> «La revisión ha tardado 55 / 73 / 79 / 107 s, más que el intervalo de 15 s: el bot no está
> manteniendo su ritmo. Suele ser el cupo de peticiones del venue, que hace esperar en vez de
> fallar.»

El aviso hizo su trabajo: `TICK_SLOW` existe desde el spec 031 para destapar exactamente esto, la
degradación invisible del presupuesto de caudal, que **duerme en vez de fallar**
(`bot-runner.ts:356-365`). Lo que hay detrás no es un fallo puntual del venue sino piezas que no
escalan, y que el canal con IA (spec 058) puso al límite por primera vez con sus ventanas de mil
velas.

**Lo que NO es la causa**, descartado con evidencia antes de diseñar:

- **No es la CPU.** `canal/analisis.spec.ts:289-304` deja escrito que un análisis nuevo con mil
  velas tarda unos 4 ms sobre `dist`, y hay caché LRU por huella de series
  (`canal/analisis.ts:105-148`).
- **No es el modelo.** La IA del canal es asíncrona por `bot_ai_intents`: ninguna llamada al LLM
  vive dentro del tick.
- **No son las velas dentro del tick.** `precargarSeries` corre fuera del cerrojo del bot
  (`bot-runner.ts:2591-2622`); el tick lee la caché en memoria de forma síncrona.

Causas encontradas en el código (`main` en `3c18a43`):

1. **Cada bot simulado pide el precio por REST, uno a uno.**
   `account-hub.service.ts:736-739` desvía a propósito a los simulados **fuera** de
   `MarketDataService.ticker()` —que tiene TTL de 1 s y deduplica peticiones idénticas en vuelo— y
   los manda a `DryRunAdapter.getTicker`, que en Hyperliquid son dos peticiones: `l2Book` (peso 2)
   y `metaAndAssetCtxs` (peso 20).
   El comentario que lo justifica («servirle el precio desde el feed lo dejaba ciego: ninguna orden
   simulada se ejecutaba jamás») ya no es toda la verdad: `DryRunAdapter.streamTicker`
   (`dry-run.ts:447-458`) casa las órdenes en reposo en cada tick del WebSocket, y el runner
   siempre se suscribe (`bot-runner.ts:949-956`) antes de su primer tick.
2. **Una lectura de velas legítima exige el depósito al 100 %.**
   `venue-budget.ts:194-234`: `capacity = rate × burstSeconds` = 17 × 2 = **34**, suelo de lectura
   6,8, y `need = min(peso + suelo, capacity)`. Con `candleSnapshot` pesando `20 + ceil(barras/60)`
   (`venue-weights.ts:193-199`), las series del canal (144 / 1000 / 480 barras, +2) pesan
   **23 / 37 / 29**: toda lectura de peso ≥ 27,2 exige el depósito lleno, y la de 37 lo deja en
   **−3** de deuda que pagan durmiendo todos los demás.
   `burstSeconds = 2` viene del spec 020, anterior a las ventanas de mil velas del 058. El número
   nunca se revisó cuando cambiaron los pesos.
3. **El bucle de espera no tiene cola: es hambre, no cupo.**
   El `for(;;)` de `venue-budget.ts:225-233` y su gemelo de Redis (`:390-436`) no tienen FIFO, ni
   envejecimiento, ni tope. Los que esperan compiten al despertar, así que **una petición cara
   pierde sistemáticamente contra las baratas que llegan después**. Y con Redis, cada durmiente
   evalúa el script cada ≥20 ms: treinta esperas son hasta 1500 `EVAL`/s contra el mismo Redis que
   sostiene los leases (invariante 10).
4. **El limitador de caudal es de concurrencia 1.**
   `rate-limit.ts:27-41`: `this.queue = result.then(...)` donde `result` espera a que `fn()`
   **termine**. Su comentario promete una «ventana deslizante» que no existe. El caudal real es
   `1/max(intervalo, latencia)`, y una llamada colgada retiene 10 s a todas las de detrás. Todos
   los simuladores de un venue comparten una sola fuente de precios
   (`account-hub.service.ts:355-364`), y con ella un solo limitador.
5. **La API comparte el mismo depósito y va sin freno.**
   `WORKER_EGRESS_ID=shared` hace que API y worker compartan `crypton:budget:shared:<venue>`, y
   `apps/api/src/modules/market-data/market-data.service.ts:406-410` crea su adaptador público
   **sin `rateLimitPerSecond`**. El gráfico de la app (spec 061) carga 9 páginas de 300 velas = 225
   de peso por apertura, contra un depósito de 34.
6. **El tope por venue no cuenta los simulados.**
   `engine.service.ts:648`: `AI_CHANNEL_MAX_BOTS_PER_VENUE` solo se aplica si `!bot.dry_run`.
7. **La serie de estructura pide más histórico del necesario.**
   `ai-channel.ts:661-668` pide 1000 velas de 15 min donde bastan unas 656.

Los defectos 1 y 4 se retroalimentan; los 2 y 3 hacen que la lectura pesada se muera de hambre en
vez de esperar su turno.

Decisiones del usuario, preguntadas antes de diseñar:

- **No se para a recoger evidencia de producción**: los defectos están confirmados en el código y
  son reales con independencia de cuál disparó el aviso de ese día.
- **Alcance: mínimo seguro más el rediseño de la capa de caudal.**
- **Sí se reducen las velas** «a lo necesario para que funcione bien el bot de IA; no es necesario
  demasiada vela histórica, solo lo necesario para no agregar ruido viejo». Es la decisión
  explícita que `CLAUDE.md` exige para tocar la semántica de una estrategia.

## Lo que la medición dice sobre las velas

Medido ejecutando `dist/` contra `escenarioCanal` y contra paseos aleatorios sembrados. **Solo una
de las tres series se puede recortar**; las otras dos no son margen, son definición:

| Serie | Hoy | Nuevo | Peso HL | Qué fija el mínimo |
|---|---|---|---|---|
| 5 min (disparo) | 144 | **144** | 23 → 23 | El RSI(14) de Wilder es recursivo y necesita ~110 velas para converger (`setups.ts:129`, `estadistica.ts:42-57`). Y bajar a 120 **no cambia el peso**: `20 + ceil(barras/60)` da 23 en los dos casos |
| 15 min (estructura y tasas) | 1000 | **`ventanaCanal + 8×70`** = 656 con la ventana por defecto | 37 → **31** | `PASO_TASAS = 8` y el umbral `n > 60` de evidencia MODERADA (`tasas-base.ts:64,74-78`) |
| 1 h (régimen) | 480 | **480** | 29 → 29 | Los percentiles se calculan sobre **toda la serie** (`regimen.ts:76-77`): la longitud *es* la ventana de referencia. Medido: a 336 velas el escenario pasa de RANGO a INDEFINIDO |

**Por qué no se baja más el 15 min.** Con evidencia MODERADA y esperanza negativa la herramienta
**descarta el setup** (`herramienta.ts:489`), y esa puerta solo existe por encima de 60 muestras.
Medido sobre el escenario: 1000 velas → 112 muestras; 640 → 67; 576 → 59 (se pierde MODERADA);
500 → 50; 400 → 37. Recortar a 500 apagaría una red de seguridad que hoy protege.

**Por qué una fórmula y no un número plano.** `channelWindowBars` llega hasta 200
(`ai-channel.ts:569-570`): con 656 fijo, ese usuario se quedaría en 57 muestras sin enterarse.

**Por qué no se quita una temporalidad.** Agregar el 1 h desde el 15 min exigiría 1920 velas de
15 min, y `barrasDe` las recorta a `maxBars − 3`: en Lighter son **497** (`capabilities.ts:118`),
así que el régimen pasaría a depender del venue.

El ahorro del recorte es **−4,4 % de peso por hora y símbolo** (540 → 516). Es poco, y hay que
decirlo: lo que arregla el incidente son R-1 a R-4, no el recorte de velas.

## Alcance

- `packages/exchange-core`:
  - `rate-limit.ts`: los dos carriles del limitador;
  - `venue-budget.ts`: capacidad, cola, envejecimiento y una consulta a Redis por ciclo;
  - `caudal-metricas.ts` (nuevo): contadores de proceso;
  - `adapters/dry-run.ts`: la procedencia del último precio;
  - `adapters/{hyperliquid,lighter,aster}.ts`: elegir carril por prioridad.
- `packages/strategy-core`: `strategies/ai-channel.ts`, las ventanas de `seriesDe`.
- `apps/worker`: `engine/account-hub.service.ts` (el comentario), `engine/engine.service.ts` (el
  tope), `engine/bot-runner.ts` (`TICK_SLOW` con números) y el vigilante de caudal.
- `apps/api`: `modules/market-data/market-data.service.ts` y su vigilante de caudal.
- `packages/backtest`: `engine.canal.spec.ts`, la longitud fijada.
- `apps/app`: `core/content/ai-channel.guide.ts`.
- `docs/ai-channel.md`, `docs/administracion.md`, y los `.env.example` y el compose.

## Fuera de alcance

- **`QUOTA_HEADROOM` y `VENUE_QUOTA_PER_MINUTE`.** Todo el argumento de seguridad descansa en
  ellos; tocarlos es otro spec, como en el 020.
- **Revertir «dormir en vez de fallar»** (specs 020/031). Solo se añade una cota opcional, y solo
  para lecturas.
- **`writeReserve` y `criticalReserve`.** Cambiarlos ahora mezclaría dos hipótesis en el mismo
  despliegue.
- **Concurrencia de escritura en Lighter.** El `nonce_manager` del SDK no lo permite
  (`lighter.ts:542-582`) y el modo de fallo es «el adaptador no vuelve a colocar una orden».
- **Concurrencia de lectura en Aster.** Sus lecturas van firmadas con nonce y no se puede sondear
  sin credenciales, que `specs/README.md` prohíbe.
- **Trocear `candleSnapshot`.** Cuatro páginas de 250 pesan 100 frente a 37: multiplica por 2,7 el
  consumo para resolver un problema que no es de cupo sino de capacidad instantánea.
- **Meter a los simulados en `MarketDataService`.** Hoy no hay suscripción para los símbolos que
  solo usan simulados, así que su `ticker()` iría a REST igual. Spec propio.
- **El umbral de `TICK_SLOW` y `RECONCILE_INTERVAL_MS`.** El detector de humos no se apaga.
- **Que Lighter nunca alcance evidencia MODERADA.** Su techo de muestras es `(497 − 96)/8 = 50`, así
  que un bot de Lighter con `requireEvidence: 'MODERADA'` no abre jamás y nadie lo avisa. Se anota
  como hallazgo para un spec de seguimiento; no se corrige aquí.
- **Cambiar valores por defecto de estrategia** distintos de las ventanas de `seriesDe`, que son la
  decisión explícita del usuario.

## Requisitos

- **R-1 — El simulador sirve el precio que ya le entregó el flujo.**
  - `anotarTicker` guarda la **procedencia** del último precio: flujo o REST.
  - `getTicker` devuelve ese precio sin llamar a la fuente cuando vino del flujo hace menos de
    `PRECIO_DEL_FLUJO_MS` (1 s), y **sin volver a casar**: ese precio ya se casó al llegar.
  - Todo lo demás queda intacto, incluido el último precio con el venue caído (050 R-4).
  - Es la procedencia y no un TTL a secas porque `ReplaySourceAdapter.streamTicker` devuelve `EMPTY`
    (`replay-source.ts:69-79`): en un backtest nunca hay precio venido del flujo, y un TTL ciego
    habría roto el replay en silencio.
- **R-2 — El depósito se dimensiona con los pesos reales.**
  - `burstSeconds` por defecto pasa de 2 a **6**, y la capacidad se topa en
    `VENUE_QUOTA_PER_MINUTE[venue] × (1 − QUOTA_HEADROOM)`.
  - La garantía es `capacity + rate × 60 ≤ cupo`, o sea `capacity ≤ 0,15 × cupo`: Hyperliquid
    **102**, Lighter **5,1**, Aster **204**; el peor minuto queda en el 93,5 % del cupo publicado.
  - `ORDER_RATE` de Aster no se toca: su capacidad sale de la ventana de 10 s, no del burst.
  - **No será variable de entorno.** API y worker comparten depósito, y si uno llevara 6 y el otro
    2, el recorte del script de Redis limitaría en silencio para siempre.
- **R-3 — El presupuesto reparte con cola, no con carrera.**
  - Camino rápido intacto: cola vacía y fichas suficientes, se concede en el acto.
  - Orden por clase y llegada: críticas, luego escrituras, luego lecturas; FIFO dentro de cada una.
  - Un solo servidor por clave de depósito, con un temporizador en vez de N durmientes.
  - Una petición barata adelanta a la cara **solo si no la retrasa**.
  - Envejecimiento a los 10 s: una espera vieja sube una clase **a efectos de orden**, nunca de
    suelo. El suelo es una reserva de seguridad y no se presta.
  - Cota de espera opcional y **solo para lecturas**; por defecto no hay cota.
  - En Redis solo habla con Redis la **cabeza** de cada clave. El script y la clave no cambian.
- **R-4 — El limitador tiene dos carriles.**
  - `run()` sigue siendo el carril **ordenado** de hoy; `runLibre()` admite varios en vuelo.
  - El marcapasos **reserva el turno en la llamada**, no al terminar la llamada, así que el
    espaciado deja de depender de la latencia. Orden interno: semáforo, turno, llamada.
  - **El carril se elige por prioridad, no por método**: las lecturas van al libre; las escrituras y
    las críticas, al ordenado. Es lo que salva el caso trampa de `lighter.ts:1497-1505`, que cancela
    por el mismo método que las lecturas pero con prioridad de escritura.
  - Concurrencia por defecto: Hyperliquid 4, Lighter 2, Aster 1. Ajustable por
    `VENUE_MAX_CONCURRENT_READS`, que sí puede ser variable de entorno porque es estado por proceso.
  - Subir la concurrencia no puede pasarse del cupo: toda llamada pasa por el presupuesto **antes**
    del limitador.
- **R-5 — La API deja de ir sin freno.** Su adaptador público recibe tope de caudal y concurrencia
  explícitos.
- **R-6 — El tope por venue cuenta los simulados, de forma asimétrica.**
  - Si el que llega es simulado, cuentan todos los bots del canal de ese venue.
  - Si el que llega es real, se cuentan solo los reales: **un simulado nunca le quita el hueco a un
    bot con dinero**.
  - El valor por defecto no cambia.
- **R-7 — Las ventanas de velas, a lo necesario.** La serie de estructura pasa de 1000 a
  `ventanaCanal + PASO_TASAS × 70`. El 5 min y el 1 h se quedan como están.
- **R-8 — El 1 h deja de bajarse cuatro veces por hora.** El techo de refresco deja de aplicarse a
  los intervalos de una hora o más, que se refrescan por su propio cierre. Para que eso sea seguro,
  la persecución del cierre reintenta más veces en los intervalos largos.
- **R-9 — Observabilidad.**
  - Contadores de proceso por venue y prioridad: concesiones, espera total, espera máxima, en cola,
    en vuelo.
  - Un vigilante cada 60 s en el worker **y en la API**, que avisa con espera máxima por encima de
    3 s o cola sostenida, con enfriamiento de 15 min.
  - `TICK_SLOW` dice cuánto de la espera fue del presupuesto, con los números en el `payload`. La
    atribución es del venue en ese intervalo, no del bot, y el texto lo dice así.

## Criterios de aceptación

- **CA-1** El simulador no vuelve a pedir el precio con el flujo vivo: test en `exchange-core`, con
  el contador de llamadas a la fuente a cero tras la primera y con el casado intacto.
- **CA-2** Sin flujo —el caso del backtest— cada lectura de precio sigue yendo a la fuente y casando.
- **CA-3** Una lectura de mil velas no exige el depósito lleno ni deja deuda.
- **CA-4** Una lectura cara no se muere de hambre entre lecturas baratas.
- **CA-5** Una crítica no espera detrás de una cola de lecturas.
- **CA-6** El depósito no puede pasarse del cupo en una ventana de 60 s, en los tres venues.
- **CA-7** Treinta esperas son una consulta a Redis por ciclo, no treinta.
- **CA-8** Una llamada colgada no retiene a las de detrás en el carril libre, y el carril ordenado
  no solapa dos llamadas nunca.
- **CA-9** El análisis con la serie corta es el mismo que con la larga: régimen, mercado, canal y
  candidatos, con más de 60 muestras y evidencia MODERADA.
- **CA-10** Para toda la banda de `channelWindowBars`, de 48 a 200, las muestras pasan de 60.
- **CA-11** Los simulados cuentan para el tope por venue, pero no le quitan el hueco a un real.
- **CA-12** Verificación completa en verde: `pnpm build:packages`, `pnpm test`, `pnpm lint`,
  `pnpm check:env` y el typecheck de la app.
- **CA-13 (manual, usuario)** Tras desplegar API y worker juntos: ningún `TICK_SLOW` en 15 minutos,
  los cuatro simulados siguen casando órdenes, y la consola del canal no muestra descartes nuevos.

## Riesgos

- **Se reabre la puerta de la esperanza negativa.** Si en un par concreto la muestra cae de 61 a 59,
  un setup hoy bloqueado dejaría de estarlo. Por eso 656 y no 480, y por eso la comprobación previa.
- **Bots con evidencia exigida** distinta de «no» podrían dejar de operar con menos muestras. Se
  cuentan antes de desplegar; si hay alguno, se habla con su dueño.
- **Ráfaga instantánea mayor** contra el venue, 102 en vez de 34. Acotada por construcción y por
  CA-6: el peor minuto sube del 87,8 % al 93,5 % del cupo publicado.
- **Un carril libre mal enchufado en un camino firmado** rompería el nonce de Lighter de forma
  permanente. Mitigado eligiendo el carril por prioridad y con el test del carril ordenado.
- **Despliegue escalonado.** API y worker comparten la clave del depósito, y un proceso viejo la
  recorta en cada refill. Durante la ventana mixta se limita **de más**, nunca de menos. **La clave
  no se versiona**: dos versiones darían dos depósitos sobre la misma IP y ahí sí se podría pasar
  del cupo.
- **La IA verá números distintos** en las tasas base y sus juicios cambiarán en el margen. Es «misma
  calidad», no «mismo resultado». El modo por reglas no mira tasas.
- **Riesgo residual asumido.** Si los bots pidieran de verdad más de 1020 de peso por minuto
  sostenidos, habría que esperar sí o sí. El rediseño hace que la espera sea justa y visible en vez
  de arbitraria e invisible, y R-9 avisa antes del síntoma.

## Referencias oficiales

- Hyperliquid, <https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits>
  (consultada el 2026-09-13 en el spec 050): «REST requests share an aggregated weight limit of 1200
  per minute» por IP; `l2Book`, `clearinghouseState` y `allMids` pesan 2, el resto de `info` 20.
- `@nktkas/hyperliquid@0.33.3`, `esm/transport/http/mod.js`: timeout por defecto de 10 000 ms.
- Lighter, <https://apidocs.lighter.xyz/docs/rate-limits> y
  <https://apidocs.lighter.xyz/reference/candles.md>: «Returns at most 500 candles per call».
- Aster: `REQUEST_WEIGHT` 2400 por minuto e IP, confirmado por el propio venue en `rateLimits[]` de
  `/fapi/v3/exchangeInfo`.
