# 050 — Una caída del venue no es un fallo del bot

Estado: `hecho` (falta CA-10 manual) · Tipo: `cambio` · Rama: `spec/050-caida-del-venue`

## Objetivo

Que un corte pasajero de la API de un venue (HTTP 5xx, timeouts, `fetch failed`, 429) no pause
bots, no inunde Telegram y no deje a nadie mirando un aviso falso. El bot espera sin tocar nada,
avisa una vez al caer y otra al volver, y reconcilia solo cuando el venue responde. Los fallos que
NO son del venue siguen pausando como hasta ahora.

## Contexto

Incidente del 2026-09-13, 08:37 UTC. La API pública de Hyperliquid respondió durante unos tres
minutos con `502 Bad Gateway` de nginx, timeouts de 10 s y `fetch failed`. Lo que vio el usuario:

- **Cuatro bots fallando a la vez**: tres simulados en Modo IA y uno
  real. Cada tick fallido era un evento `TICK_ERROR` y una línea
  en Telegram. Hubo seis mensajes en un minuto, y siguió después de la pausa.
- **Los tres simulados se pausaron** con «5 ticks seguidos fallidos (último: HTTP 502)».
  - Siguieron pausados con Hyperliquid ya recuperado: nada reanuda un bot.
  - El Modo IA dejó de revisarlos: salta los que no están `RUNNING` (046 R-13).
  - El real se quedó a un tick de lo mismo, y pausar cancela su escalera y su take profit.
- **Una alerta falsa**: «la posición sigue abierta… Atención: la posición queda SIN stop loss» en
  uno de los simulados, que no tenía posición.
- **«La revisión ha tardado 72 s… Suele ser el cupo de peticiones del venue»**: el cupo no tenía
  nada que ver.

Causas encontradas en el código (`main` en `5c570ca`):

1. **La guarda no distingue a quién es la culpa.**
   - `onTickError` cuenta igual un 502 que un bug (`bot-runner.ts:2697-2717`), y a los 5 llama a
     `pauseForRisk`.
   - La guarda nació para el bot que falla SIEMPRE (su comentario cita «caída del venue» junto a
     «símbolo retirado»). Pero pausar durante una caída no protege nada: el venue no acepta
     órdenes, las cancelaciones de la pausa también fallan y el stop nativo sigue donde estaba.
   - Lo único que consigue es que el bot no vuelva.
2. **`TICK_ERROR` sin enfriamiento.**
   - Uno por tick y por bot, que va a la preferencia `errors` del notificador.
   - Tras la pausa sigue: un bot pausado llama al venue antes de mirar `paused` (`:704-718` frente
     a `:758`).
3. **Latido que encola.**
   - El `setInterval` (`:652`) pone un tick en la cola del cerrojo cada 15 s aunque el anterior no
     haya terminado (`exclusive()`, `:530`).
   - Con ticks de 72 s se acumulan cuatro que corren después uno detrás de otro.
4. **Ticks larguísimos.**
   - Cada lectura de HL hace 4 intentos de hasta 10 s (`withRetry`, `rate-limit.ts:62`; timeout del
     SDK por defecto).
   - `sweepFills` va antes del `Promise.all`, así que un tick puede llegar a ~84 s.
   - `TICK_SLOW` culpa al cupo (`:864`).
5. **`fetch failed` es FATAL.**
   - El SDK de HL lanza `HttpRequestError('Unknown HTTP request error: fetch failed')` con el error
     de red en `cause`.
   - No casa con el patrón `RETRYABLE` (`errors.ts:76`), así que ni se reintenta.
6. **Los simulados no tienen colchón.**
   - `DryRunAdapter.getTicker` va por REST en cada tick y no recurre al último precio
     (`dry-run.ts:369`).
   - El hub los saca a propósito de `MarketDataService`, que a los reales les da 20 s de
     tolerancia (`account-hub.service.ts:720`).
7. **`protectionNote` solo mira la configuración** (`:2011`), no si hay posición.
8. **Lighter y Aster hacen `fetch` sin `AbortSignal`** (`lighter.ts` `publicGet`, `aster.ts`
   `http`): una conexión colgada retiene el cerrojo del bot, y con él un PANIC, hasta los 300 s de
   undici.

Decisión del usuario, preguntada antes de diseñar:

- Ante una caída del venue **no se pausa**; el bot espera y avisa al caer y al volver.
- Los simulados también avisan, agrupados.

Precedentes de este mismo patrón:
- el comentario de `errors.ts:90-105`, la caída 503 de Lighter que acabó en «5 ticks seguidos
  fallidos»;
- `venue-empty-strings.spec.ts:8`.

## Alcance

- `packages/exchange-core`:
  - `errors.ts`: clasificación de fallos de red y `isVenueUnavailable`;
  - `adapters/dry-run.ts`: último precio reciente;
  - `adapters/lighter.ts` y `adapters/aster.ts`: timeout de `fetch`.
- `apps/worker`:
  - `engine/bot-runner.ts`: guarda de ticks, latido, aviso de ritmo, nota de protección;
  - `engine/bot-store.ts`: `setLastError`;
  - `engine/engine.service.ts`: runners atascados;
  - `notifications/notifier.service.ts`: tipos nuevos.
- `apps/app`: `core/utils/labels.ts`, las etiquetas de los eventos nuevos.
- `docs/riesgo-y-liquidacion.md` y `docs/comandos-guardas-y-eventos.md`.

## Fuera de alcance

- **La guarda de 20 colocaciones fallidas** (`MAX_PLACE_FAILURES`). Es otro escenario (lecturas
  sanas, escrituras caídas); se deja como está.
- **Un cortacircuitos por venue compartido entre bots** (fallar en local mientras el venue está
  caído). Útil, pero toca el camino de un PANIC, que siempre debe intentarlo; merece spec propio.
- **Reanudar automáticamente los bots que YA están pausados** por el incidente. Se reanudan a mano.
- **La API** (`MarketDataService`): sus WARN son correctos y no inundan nada.
- **Agrupar por venue en Telegram**: el lote por chat ya junta los N bots en un mensaje.
- **Cambiar la estrategia, los valores por defecto o la semántica de un parámetro de usuario.**

## Requisitos

- **R-1 Clasificación.**
  - Son `RETRYABLE`:
    - `fetch failed`, `UND_ERR_*`, `other side closed`, `EPIPE`, `ECONNABORTED`;
    - un `HTTP 5xx` (500-599), tanto en el texto como en el estado que el adaptador pasa aparte
      cuando el cuerpo no dice otra cosa;
    - el aborto por timeout de `fetch` (`TimeoutError`, «The operation was aborted due to
      timeout»);
    - el `cause.code` de red de un error envuelto (el `HttpRequestError` del SDK de HL).
  - `isVenueUnavailable(e)` es cierto para un `ExchangeError` `RETRYABLE` o `THROTTLED`.
  - Las escrituras siguen seguras: `withWriteRetry` pregunta al venue antes de reenviar.
- **R-2 Guarda de ticks.**
  - **Fallo del venue** (`isVenueUnavailable`).
    - Nunca pausa.
    - Al tercer fallo seguido, un evento `VENUE_UNAVAILABLE` (WARN). Dice qué venue, desde cuándo,
      el último motivo, que el bot espera sin pausar y que sus órdenes siguen como estaban, más la
      nota de protección de R-5.
    - Deja ese texto en `last_error` **sin tocar `status`**.
    - Se recuerda cada 30 min mientras dure.
  - **Recuperación.** En cuanto las lecturas de un tick salen bien tras una caída anunciada, aunque
    ese tick acabe después en una guarda o en una parada:
    - emite `VENUE_RECOVERED` (INFO) con la duración;
    - borra `last_error` solo si lo escribió la caída.
  - **Fallo propio** (cualquier otro).
    - Cuenta aparte dentro de la racha; a los 5 pausa, como hasta ahora.
    - `TICK_ERROR` sale en el primer fallo de la racha y cuando cambia el motivo, nunca en cada
      tick.
    - Con el bot ya pausado no sale.
    - El WARN del log se mantiene en cada tick.
- **R-3 Latido.**
  - El temporizador no encola un tick si ya hay uno en curso o esperando.
  - Durante una caída, los ticks del temporizador se espacian con una espera extra de
    `min(intervalo × (2^(n-1) − 1), 60 s)` tras el fallo n-ésimo: el primer reintento va a su
    ritmo, y después la espera se dobla hasta un minuto.
  - Los comandos y los ticks pedidos (fills, recargas) no esperan nunca.
  - `TICK_SLOW` no se emite en un tick que acabó en caída del venue.
- **R-4 Simulados.**
  - Si la fuente falla con `isVenueUnavailable`, `DryRunAdapter.getTicker` devuelve el último
    precio del símbolo cuando tiene menos de 20 s según el reloj de la simulación.
  - Si no hay precio reciente, o el error es de otra familia, relanza.
- **R-5 Nota honesta.**
  - El runner recuerda si hay posición, y lo olvida en cuanto algo puede haberla cambiado: una
    ejecución o el primer fallo de una racha.
  - `pauseForRisk`, `PAUSE`, `STOP_KEEP_POSITION` y `VENUE_UNAVAILABLE` dicen «no tenía posición
    abierta» solo cuando consta plana; «si tenía posición abierta, sigue abierta» cuando no se sabe.
  - Solo con posición, o sin saberlo, llevan la coletilla del stop.
- **R-6 Salud.** Un runner que espera al venue no cuenta como atascado, pero deja de contar como
  «esperando» tras tres minutos sin un fallo nuevo del venue.
- **R-7 Notificador y app.**
  - `VENUE_UNAVAILABLE` y `VENUE_RECOVERED` van a la preferencia `errors`, con icono propio.
  - La app los rotula en castellano.
- **R-8 Timeouts de `fetch`.**
  - `publicGet` de Lighter y `http` de Aster abortan a los 10 s, igual que el SDK de Hyperliquid.
  - El aborto sale `RETRYABLE`.
- **R-9 Documentación.** La tabla de guardas y la de eventos dicen la conducta nueva.

## Criterios de aceptación

- **CA-1** Clasificación: test en `exchange-core.spec.ts`. `fetch failed`, `HttpRequestError`-like
  con `cause.code`, `HTTP 500`, `HTTP 520` y `TimeoutError` dan `RETRYABLE`; un `FATAL`
  cualquiera sigue `FATAL`.
- **CA-2** Simulador: test con `StubSource`. Precio reciente servido; precio viejo relanza; error
  no-venue relanza.
- **CA-3** Runner, fallo del venue: test.
  - N ≥ 5 ticks `RETRYABLE` → ningún `RISK_GUARD_TRIPPED`, un solo `VENUE_UNAVAILABLE`,
    `setLastError` con el texto y `setStatus` sin llamar.
  - Tick bueno → un `VENUE_RECOVERED` y `setLastError(null)`.
- **CA-4** Runner, fallo propio: test. 5 ticks `FATAL` → pausa como antes, un solo `TICK_ERROR`,
  ninguno más con el bot pausado.
- **CA-5** Latido: test.
  - Un tick lento no deja cola.
  - Durante la caída el temporizador espacia.
  - Un comando entra sin esperar.
- **CA-6** Nota: test. Una pausa recién leída plana dice «no tenía posición abierta» y no «SIN stop
  loss»; tras una racha de fallos o una ejecución sin releer, no presume que siga plana.
- **CA-7** Salud, notificador y etiquetas: tests. Un runner esperando al venue no está atascado;
  los tipos nuevos se entregan con `errors`.
- **CA-8** Lighter y Aster: test con `fetch` simulado que no responde → falla por timeout
  `RETRYABLE`.
- **CA-9** Verificación completa en verde: `pnpm build:packages`, `pnpm test`, `pnpm lint`,
  `pnpm check:env` y el typecheck de la app.
- **CA-10 (manual, usuario)**
  - Tras desplegar, reanudar los tres simulados pausados.
  - En la siguiente caída real: un aviso por bot al caer y otro al volver, ninguna pausa, y la
    tarjeta con «no responde desde…» limpiándose sola.

## Riesgos

- **Cambia la conducta de bots en marcha**: un bot real ya no se pausa por una caída del venue.
  - Es la decisión del usuario.
  - Se mitiga con el aviso al tercer fallo, el recordatorio cada 30 min y que `last_error` queda
    visible en la tarjeta.
  - El stop loss nativo no depende del worker (invariante 6).
- **Símbolo retirado que responde sin precio** (`RETRYABLE` «El venue no devuelve precio»):
  - ya no pausa: esperará avisando cada 30 min;
  - no puede operar ni antes ni ahora, y retirar el símbolo lo decide el usuario.
- **Un fallo `RETRYABLE` que no sea del venue** (una BD caída que lance un texto con «timeout»)
  esperaría en vez de pausar.
  - Aceptable: pausar tampoco podría escribir en una BD caída.
- **Un `fetch failed` en una escritura** pasa a reintentarse.
  - Seguro: `withWriteRetry` verifica antes de reenviar, y las cancelaciones no reintentan (`callWrite`).
  - Donde sí reintenta `call()` (cancelar en Lighter, apalancamiento), la operación es idempotente.
  - El ajuste de margen no reintenta en ningún venue (`callWrite`, `signedRequestOnce`, limitador
    directo): un timeout lo hace fallar y lo decide quien lo pidió.

## Revisión

Hecha el 2026-09-13 sobre `dc35981` por un revisor independiente, requisito por requisito contra el
código. **Ningún hallazgo Crítico ni Alto**: nada del cambio coloca, duplica ni deja sin stop. Se
corrigieron los siete dentro de la rama, cada uno con su test rojo primero:

- **M-1 (Media)** «No tenía posición abierta» podía ser falso —una entrada ejecutada durante la
  caída, o una pausa justo después de un fill sin releer— y quitaba el aviso del stop en el sentido
  peligroso. La lectura se olvida con cada ejecución y con el primer fallo de una racha.
- **M-2 (Media)** Un 5xx de Aster o Lighter con cuerpo `{}`, `{code,msg}` o HTML seguía saliendo
  FATAL: los adaptadores pasan el estado aparte y `classify` solo lo miraba para el cortafuegos. Ahora
  un 5xx sin texto que diga otra cosa es `RETRYABLE`.
- **B-1** Pausar o parar durante una caída anunciada dejaba «el bot espera sin pausar» bajo el estado.
- **B-2** Una revisión que encontraba el venue de vuelta y salía por una guarda o una parada no
  anunciaba la vuelta. Se anuncia en cuanto las lecturas salen bien.
- **B-3** Reanudar en plena caída dejaba la tarjeta sin motivo hasta el siguiente aviso (30 min).
- **B-4** «Esperando al venue» no caducaba y podía tapar a un runner colgado ante la salud.
- **B-5** Un timeout salía como «23: The operation was aborted due to timeout».

## Referencias oficiales

- `@nktkas/hyperliquid@0.33.3`, `esm/transport/http/mod.js` (leído el 2026-09-13 en
  `node_modules`):
  - «Throws on a non-OK response, a timeout, an abort, or a network failure»;
  - timeout por defecto `this.timeout = options?.timeout === undefined ? 10_000`;
  - sin respuesta, el mensaje es `Unknown HTTP request error: ${cause.message}` y el error de red
    va en `cause`.
- Node.js ≥ 22, `AbortSignal.timeout(ms)`: aborta con un `DOMException` de nombre `TimeoutError`
  («The operation was aborted due to timeout»).
- Documentación del SDK, https://nktkas.gitbook.io/hyperliquid/error-handling.md (consultada el
  2026-09-13):
  - «`HttpRequestError` is thrown by `HttpTransport` when the `fetch` call fails or when the server
    returns a non-2xx or non-JSON response»;
  - «For network-level failures, `response` is undefined, and the underlying cause is in `cause`»;
  - «A default request timeout of 10 seconds is implemented using `AbortSignal.timeout()`».
- Hyperliquid, https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits
  (consultada el 2026-09-13): «REST requests share an aggregated weight limit of 1200 per minute»
  por IP; `l2Book`, `clearinghouseState` y `allMids` pesan 2, el resto de `info` 20. La página no
  dice qué estado HTTP devuelve al pasarse ni menciona los 5xx: el 502 del incidente era de su
  infraestructura, no del cupo, y cuatro bots quedan muy por debajo del presupuesto del motor.
