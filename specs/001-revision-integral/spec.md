# 001 — Revisión integral de bots, motor y APIs

Estado: `en curso` · Tipo: `revisión` · Rama: `spec/001-revision-integral` · Base: `63e676f` (`main`, 2026-08-27)

## Objetivo

Saber, con evidencia, si cada una de las siete estrategias hace lo que promete, si el motor falla
seguro en cada modo de fallo conocido, y si cada llamada a cada venue cumple su documentación
oficial. Producir `findings.md` con severidad y corregir dentro de este spec **solo** las Críticas
confirmadas; el resto se convierte en specs de seguimiento.

## Contexto

Es el primer spec del proyecto y el que inaugura la metodología. Lo pide el usuario con la consigna
«MUCHO CUIDADO»: hay bots con dinero real y ningún cambio en el motor puede hacerse a ciegas. La
exploración previa (5 de septiembre de 2026) dejó veintiuna hipótesis de hallazgo, varias ya
comprobadas leyendo el código, que entran en `findings.md` como semillas «por confirmar».

Decisiones del usuario que gobiernan este spec:

- Solo hallazgos, salvo las **Críticas confirmadas**, que se corrigen aquí con el protocolo de `specs/README.md`.
- Verificación estática contra la documentación oficial, suite de tests existente y **sondas públicas de
  solo lectura** en mainnet y testnet. Nada firmado, nada con credenciales.

## Alcance

- `packages/strategy-core` entero: las siete estrategias, `common`, `ladder`, `reconcile`, `order-gate`,
  `stop-loss`, `cycle-accounting`, `client-order-id`, `mutability`, `venue-markets`, `testing`.
- `packages/shared`: `money.ts`, `precision.ts`, `liquidation.ts`, `orders.ts`, `bot.ts`, `enums.ts`.
- `packages/exchange-core`: los tres adaptadores, `dry-run`, `coid`, `errors`, `rate-limit`,
  `venue-budget`, `venue-weights`, `ws`, `endpoints`, `factory`, `market-cache`, `capabilities`.
- `apps/worker/src`: `engine/*`, `marketdata/*`, `notifications/notifier.service.ts` (solo por las
  promesas sin guarda), `libs/budget`, `main.ts`.
- De `apps/api/src` solo: `modules/bots`, `modules/risk`, `modules/exchange-accounts`,
  `modules/leaderboard/share-codec.ts`, `modules/advisor/build.ts` (solo que no genere configuraciones
  fuera de rango).
- De `apps/app` solo `features/bots/bot-create.page.ts` (`fullConfig` y la paridad con la API).
- `packages/backtest` solo en lo que comparte con el motor (`engine.ts`, `ticks.ts`).
- Documentación oficial de Hyperliquid, Lighter y Aster y de los SDKs `@nktkas/hyperliquid` 0.33.3 y
  `zklighter-sdk` 1.3.0.

## Fuera de alcance

Autenticación con Google, Telegram, planes y suscripciones, ranking (salvo el codec), la web Astro,
la interfaz de la app, el advisor más allá de los rangos, el backtest más allá de las piezas
compartidas, subir dependencias, refactorizar, `approveBuilderFee`, pasarela de pago, y cualquier
prueba con credenciales en testnet (no autorizada).

## Requisitos

- **R-1** Línea base registrada antes de tocar nada: `pnpm build:packages`, `pnpm test` (sin e2e),
  `pnpm lint`, `pnpm check:env`, versiones de node, pnpm y SDKs.
- **R-2** Cada regla oficial en la que se apoye un veredicto está citada en `findings.md` con URL,
  fecha de consulta y texto literal.
- **R-3 Línea A (estrategias).** Para cada estrategia se revisan y se dictamina, con `fichero:línea`:
  - A-1 Entrada: cuándo abre y cómo (`MARKET` en `immediate` o `POST_ONLY` en `orders`), cooldown.
  - A-2 Escalera: precios y cantidades (aritmética/geométrica, pesos, apalancamiento sobre el notional, tope de notional).
  - A-3 Take profit: precio de referencia (entrada del venue, ancla, breakeven), cantidad, `reduceOnly`.
  - A-4 Stop loss: inyectado por `withStopLoss` con la posición real; sin duplicar el de la estrategia; lado del redondeo.
  - A-5 Safety, recompra y reanclaje: quién decide, cuándo, y qué parámetro lo controla de verdad.
  - A-6 Cierre de ciclo y cooldown: `cycleAfterFill`, `cooldownMinutes`, `scratch`.
  - A-7 Dirección LONG / SHORT / NEUTRAL: espejo correcto; `direction` ignorado o mal etiquetado.
  - A-8 `reduceOnly` en toda salida y en ninguna entrada.
  - A-9 `preview()` ≡ `plan()`: mismas cantidades, mismo redondeo, misma estimación de liquidación (modo de margen y dirección).
  - A-10 `validate()` acota todo lo que `meta.fields` declara (min, max, step, options), no solo el formulario.
  - A-11 Parámetros muertos o a medias.
  - A-12 `clientOrderId` y `cycleSeq`: mismo cálculo que el motor y el backtest; sin colisiones entre `orders` e `immediate`.
  - A-13 Supuestos de comisiones, funding y slippage y cómo se le cuentan al usuario.
  - A-14 `onFill`, `reusesOrderSlots`, `recycleLevelOnExit`: coherentes con `place()` y `cycle-accounting`.
  - Piezas comunes: A-15 `reconcile` (tolerancias, `ownIds`, `foreign`), A-16 `order-gate`, A-17 `cycle-accounting`
    (`QTY_EPSILON`, comisiones), A-18 `liquidation.ts` (MMR plano, aislado frente a cruzado), A-19 `share-codec`,
    A-20 `advisor/build.ts`, A-21 paridad de la app (`fullConfig` y `preview` de la API), A-22 paridad del backtest.
- **R-4 Línea B (motor).** Para cada modo de fallo se dictamina qué hace el código y qué debería:
  - B-1 Worker muerto a mitad de tick (fila `PENDING` sin id de venue; adopción y reconciliación).
  - B-2 Redis caído más de un TTL (soltar bots, presupuesto de caudal, bus).
  - B-3 BD caída (ticks, eventos, `claimForBots`, escrituras best-effort sin alerta).
  - B-4 WebSocket caído en silencio (`streamHealth`, barrido de fills, techo de latencia).
  - B-5 Venue THROTTLED o WAF (cooldown, reserva de escritura, cancelaciones que van por el cupo de lectura, `SignerClient` fuera del limitador).
  - B-6 Credencial revocada (`AUTH` → detach; el camino de reemplazo bajo `safely()`).
  - B-7 Orden rechazada por reglas o fondos (cuarentena por forma, levantamiento, eventos).
  - B-8 Fill parcial y tardío (`syncOrderState` frente a `recordFill`, coid reutilizado, `onFill` con contexto degradado).
  - B-9 Liquidación total, parcial y de otro símbolo, en cada venue (detección, cancelación, pausa, evento único).
  - B-10 Comandos: duplicado, huérfano, `recoverStale` global, `ADJUST_MARGIN` no idempotente, orden y at-least-once.
  - B-11 Dos workers (lease, TTL frente a la duración máxima de un tick, split-brain).
  - B-12 Lease perdido con bot simulado (`abandonPaper`, epoch).
  - B-13 Bot borrado en marcha (`emergencyCancelAll` y su alcance por venue).
  - B-14 Kill-switch global (latencia sin bus) y guardas por tick (drawdown, notional, pérdida diaria, distancia a liquidación y su acción).
  - B-15 Cortacircuitos (5 ticks, 20 colocaciones) y cuarentena en memoria (se pierde al reiniciar).
  - B-16 Promesas sin `catch` y `unhandledRejection` → `exit` del proceso entero.
  - B-17 `/health` y detección de atasco.
  - B-18 Apagado ordenado (SIGTERM 30 s frente a `stop_grace_period` 45 s, leases, volcado paper).
  - B-19 Retención y crecimiento de tablas.
  - B-20 `AccountHub`: caché de 1 s, single-flight, refcount, cierre por inactividad, ticker de paper.
  - B-21 Stop loss vivo: `stopLossVivo`, reemplazo no atómico (cancelar y luego colocar), `keepProtective`.
  - B-22 Relojes: `now` del motor frente a timestamps del venue; nonce de Aster; deriva.
- **R-5 Línea C (APIs contra doc oficial).** Una matriz por venue con una fila por llamada del
  adaptador (`# | llamada | endpoint o campo oficial | regla | método | evidencia | resultado`).
  Métodos: **DOC**, **SDK**, **SONDA**, **TEST**. Una discrepancia necesita dos métodos para ser Alta
  o más; una Crítica necesita DOC y TEST. Comprobaciones, en este orden:
  - C-1 Hosts y redes (`endpoints.ts`; Lighter deduce `chain_id` de la URL; hosts de testnet de Aster).
  - C-2 Precisión: de la meta del venue a `MarketSpec` y al formato del precio y la cantidad (Hyperliquid
    ≤ 5 cifras significativas y ≤ `6 − szDecimals` decimales, enteros siempre válidos, orden entre tick y
    cifras significativas; Lighter enteros escalados y mínimos; Aster `PRICE_FILTER`, `LOT_SIZE`,
    `MIN_NOTIONAL`); que nunca salga notación exponencial al cable.
  - C-3 Cuerpo de la orden: campos, enums, tif, `reduceOnly`, disparadores, límites del id de cliente
    frente a `coid.ts`, builder.
  - C-4 Firma y nonce: Aster (orden de parámetros, `timestamp`, `recvWindow`, dominio EIP-712); Lighter
    (`nextNonce` por cuenta y clave, errores devueltos en tupla y no lanzados, token de auth); Hyperliquid
    (`builder {b, f}` y sus unidades).
  - C-5 Errores: códigos y mensajes reales de cada venue frente a `errors.ts`, y la regex de `safely()`
    frente al mensaje real de «orden no encontrada».
  - C-6 Caudal: `venue-weights.ts` frente a la doc; 429 y 418; reserva de escritura.
  - C-7 WebSocket: payloads de suscripción, ping/pong, resubscripción, listenKey, límites de conexiones y
    suscripciones de Lighter frente al multiplexado.
  - C-8 Fills y posiciones: signo de la comisión, `Trade.type` de Lighter, funding, parciales, vocabulario de estados.
  - C-9 Cancelaciones, modify, leverage, margen y modo de posición.
- **R-6** Sondas públicas ejecutadas con las salvaguardas de `specs/README.md` y comparadas con lo que
  deriva el adaptador; la lista blanca de hosts se enseña al usuario antes de la primera ejecución.
- **R-7** Consolidación: sin duplicados, severidad por la escala, test que falla escrito para cada
  Crítica antes de proponer el arreglo, tabla resumen y propuesta de specs de seguimiento. **Parada
  obligatoria** para que el usuario apruebe la lista de Críticas.
- **R-8** Correcciones críticas con el protocolo de la constitución: de una en una, con test, diff
  enseñado, aprobación, commit propio.

## Criterios de aceptación

- **CA-1** Cada ítem A-n, B-n y C-n tiene veredicto (`OK`, `hallazgo F-NN` o `no aplica`) con evidencia en `findings.md`.
- **CA-2** `findings.md` tiene la tabla resumen ordenada por severidad y una ficha por hallazgo.
- **CA-3** Toda Crítica confirmada tiene test más corrección aprobada con los tests del paquete y de sus
  dependientes en verde, o una decisión explícita del usuario de no corregirla.
- **CA-4** Lista de specs de seguimiento propuestos con slug, hallazgos que agrupan y prioridad.
- **CA-5** Línea base registrada antes y después; `pnpm test` y `pnpm lint` en verde al cerrar.

## Riesgos

- La app ejecuta `strategy-core` en el navegador: un arreglo que use APIs de Node rompe el wizard.
- Los backtests guardados dejan de ser reproducibles si cambia `plan()` o el redondeo.
- Los specs existentes pueden estar codificando la conducta errónea: se cambian solo con evidencia.
- No existe hoy ningún test del cuerpo de `placeOrder` en los tres adaptadores: escribirlo es parte de la confirmación.

## Referencias oficiales

En `findings.md`, sección «Referencias oficiales»: una fila por regla, con URL, fecha y cita literal.
