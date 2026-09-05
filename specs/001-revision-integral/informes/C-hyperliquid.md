# Línea C — Hyperliquid

Revisado sobre `packages/exchange-core/src/adapters/hyperliquid.ts` (1134 líneas, leído entero),
`venue-weights.ts`, `venue-budget.ts`, `rate-limit.ts`, `coid.ts`, `endpoints.ts`, `market-cache.ts`,
`capabilities.ts`, `packages/shared/src/{market,orders,precision}.ts` y el consumo en
`apps/worker/src/engine/bot-runner.ts`. Documentación oficial citada en `findings.md`. Sondas
públicas de mainnet y testnet en `probes/out/` y `probes/compare.md`.

## Matriz de llamadas

| # | Llamada | Endpoint / campo oficial | Regla | Método | Resultado |
|---|---|---|---|---|---|
| 1 | `loadMarkets` `:305-329` | `info.metaAndAssetCtxs` | peso 20; `szDecimals`, `maxLeverage`, `midPx` | DOC + SONDA | **OK**; el tick derivado es el problema, ver HL-1 |
| 2 | `verify` `:334` | `clearinghouseState` | peso 2, solo lectura | DOC | OK |
| 3 | `getBalances` / `getPositions` `:366-398` | `clearinghouseState`, memo 800 ms | peso 2 | DOC | OK |
| 4 | `getOpenOrders` `:400-423` | `frontendOpenOrders`, memo 800 ms | peso 20, todos los símbolos | DOC | OK con reserva, ver HL-6 |
| 5 | `getTicker` `:425-439` | `l2Book` | peso 2 | DOC + código | **Desviación**: HL-2 y HL-3 |
| 6 | `getTickers` `:448-471` | `metaAndAssetCtxs` | peso 20 | DOC | OK |
| 7 | `getCandles` `:473-508` | `candleSnapshot` | peso `20 + ceil(barras/60)` | DOC | **OK**, cobrado exacto (`:495`) |
| 8 | `getRecentFills` `:514-541` | `userFillsByTime` | peso `20 + ceil(fills/20)` | DOC | Desviación consciente, ver HL-7 |
| 9 | `placeOrder` `:547-614` | `exchange.order` | `a,b,p,s,r,t,c`, `grouping:'na'`, `builder{b,f}` | DOC + SDK | Campos **OK**; precio ver HL-1; tif ver HL-8 |
| 10 | `toAck` `:617-638` | `response.data.statuses[0]` | `resting`/`filled`/string | SDK | Desviación menor, HL-9 |
| 11 | `cancelOrder` `:640-655` | `cancelByCloid` / `cancel` | `{asset,cloid}` / `{a,o}` | DOC | **OK** de forma; prioridad ver HL-4 |
| 12 | `cancelOwn` `:663-671` | `cancelByCloid` en lote | un lote, solo ids propios | DOC | OK; peso ver HL-5 |
| 13 | `cancelAll` `:678-687` | `cancel` por oid | alcance de cuenta y símbolo | código | OK, documentado como tal |
| 14 | `modifyOrder` `:689-717` | `exchange.modify` | `{oid, order}` | DOC | **Desviación**: F-04b (camino muerto) |
| 15 | `setLeverage` `:719-728` | `updateLeverage` | `{asset,isCross,leverage}` | DOC | OK de forma; prioridad ver HL-4 |
| 16 | `adjustIsolatedMargin` `:748-771` | `updateIsolatedMargin` | `ntli` entero en 1e6 | DOC | **OK**, ejemplar (trunca, sin reintento) |
| 17 | `streamOrders` / `streamFills` `:919-987` | `subs.orderUpdates`, `subs.userFills` | por usuario | SDK | OK; metadatos ver HL-10 |
| 18 | `streamTicker` `:823-848` | `subs.bbo` | por moneda | SDK | **Desviación**: HL-2 y HL-3 |
| 19 | `streamCandles` `:795-817` | `subs.candle` | moneda e intervalo | SDK | OK |
| 20 | `findPlaced` `:1090-1107` | `orderStatus` con cloid | peso 2; acepta cloid | DOC + SDK | **OK**, y es la pieza que evita duplicar |
| 21 | `close` `:989-1013` | cierre de transporte | 10 conexiones por IP | DOC | OK en sí; ver HL-11 |

## Veredictos C-1…C-9

- **C-1 Hosts y redes** — OK. El adaptador no usa `endpoints.ts`: pasa `isTestnet` al SDK, que conoce las dos redes (`:267-269`), y la red sale de `opts.testnet` (columna de la cuenta) con respaldo en la credencial antigua. No hay forma de que el destino venga del cliente.
- **C-2 Precisión** — **Desviación grave, HL-1**. Ver abajo y F-04 en `findings.md`. El tamaño sí es correcto: `stepSize = 10^-szDecimals` (`:313`) y `qy()` trunca hacia abajo, que es lo que pide la regla «Sizes are rounded to the `szDecimals` of that asset».
- **C-3 Cuerpo de la orden** — OK salvo el tif (HL-8). `cloid` es hex de 128 bits: `hyperliquidCodec.encode` produce `0x` + 16 bytes de sha256 (`coid.ts:17-30`), con guarda de paso para ids ya codificados. `reduceOnly` viaja en `r` (`:600`). El disparador usa `tpsl` explícito desde `req.intent` (`:570`), con el comentario del incidente que lo motivó. `grouping: 'na'` correcto.
- **C-4 Firma y builder** — OK de forma: `builder {b, f}` con `f` en décimas de punto básico (`:1023-1029`). **Sin tope**: el esquema del SDK documenta un máximo de 100 en perps y 1000 en spot, y aquí se reenvía lo que diga la configuración. Ver HL-12.
- **C-5 Errores** — Parcial. `mapOrderStatus` cubre once variantes de cancelación (`:1110-1133`), lo cual es notablemente completo, pero el `default` devuelve `OPEN` para cualquier estado desconocido. Y el adaptador **no tiene `VenueCooldown`**, al contrario que Lighter y Aster: tras un 429 sigue llamando. Ver HL-13.
- **C-6 Caudal** — La tabla de pesos coincide **exactamente** con la documentación (peso 2 para las seis ligeras, 60 para `userRole`, 20 por defecto, `+1 por cada 20` en trece endpoints, `candleSnapshot` `+1 por cada 60`). Cupo 1200/min con 15 % de margen. Lo que falla es la **prioridad** de las escrituras (HL-4) y el peso de las acciones en lote (HL-5).
- **C-7 WebSocket** — Un transporte por adaptador, perezoso, con flujos compartidos por contador de referencias y cierre real del transporte. Bien resuelto. El problema es de escala: HL-11.
- **C-8 Fills y posiciones** — OK. `esLiquidacionHl` lee `dir` con cast documentado; la comisión llega con signo del venue y `feeToken`; `isTaker` de `crossed`. `getPositions` deriva `markPrice` de `positionValue / |szi|`, que sí es el mark del venue.
- **C-9 Cancelar, modificar, apalancamiento y margen** — OK salvo `modifyOrder` (F-04b) y la prioridad de presupuesto (HL-4).

## Hallazgos

### HL-1 — El tick sale del mid del catálogo y el precio enviado deja de ser el planificado

Severidad **Alta** (candidata a Crítica en el stop-loss). Ya está en `findings.md` como **F-04**, con
la medición sobre el catálogo real: 41 de 177 activos vivos divergen dentro de un ±100 % del mid, y
cuatro dentro de un +6 %. No lo repito aquí.

### HL-2 — `Ticker.mark` no es el precio de marca del venue, es el punto medio del libro

- **Severidad**: Alta.
- **Evidencia**: `packages/shared/src/market.ts:37-38` documenta el campo como «Precio de marca: el
  que usa el venue para liquidar. Es el que manda en riesgo». Los otros dos adaptadores lo cumplen:
  Aster toma `premiumIndex.markPrice` (`aster.ts:457`) y Lighter `mark_price` con respaldo en
  `index_price` (`lighter.ts:798`, `:1567`). Hyperliquid, en cambio, pone el mid del libro tanto en
  REST (`hyperliquid.ts:429`, `:436`) como en WebSocket (`:830-839`) — y eso que `metaAndAssetCtxs`
  **sí trae `markPx` y `oraclePx`**, como enseña la sonda (`probes/out/hyperliquid.mainnet.metaAndAssetCtxs.*.json`:
  `{"oraclePx":"79627.0","markPx":"79587.0","midPx":"79583.5"}`).
- **Impacto**: en Hyperliquid las guardas de riesgo corren sobre un precio distinto del que usa el
  venue para liquidar. Lo consumen `bot-runner.ts:1558` (notional frente a `maxNotionalPerBot`),
  `:1580` (`liquidationDistancePct`, que dispara `liquidationAction`, incluido `CLOSE_ALL`), `:2056`
  y `:2067` (instantáneas y equity, o sea el kill-switch por drawdown) y el ancla del market maker.
  En un libro ancho o desequilibrado el mid y el mark se separan justo cuando más importa.
- **Test propuesto**: `exchange-core.spec.ts` — `getTicker` con un `l2Book` cuyo mid difiera del
  `markPx` del contexto debe devolver el `markPx` en `mark` y el mid en `last`.
- **Propuesta**: llevar `markPx` a `Ticker.mark` (ya se pide `metaAndAssetCtxs` para el catálogo, así
  que puede memoizarse) y dejar el mid en `last`.

### HL-3 — Con un lado del libro vacío, el precio queda a la mitad

- **Severidad**: Alta.
- **Evidencia**: `getTicker` `:427-429` hace `bid = levels[0]?.[0]?.px ?? '0'` y `mid = (bid+ask)/2`.
  `streamTicker` `:829-832` hace lo mismo con `firstNum(bid?.px, 0)`. Si un lado viene vacío, el mid
  es **la mitad del otro lado**, no cero.
- **Impacto**: el motor solo rechaza `mark <= 0` (`bot-runner.ts:592`), así que un precio a la mitad
  pasa como bueno. A partir de ahí: la distancia a liquidación se calcula mal y puede disparar
  `liquidationAction: CLOSE_ALL`, que cierra la posición a mercado; el notional sale a la mitad y la
  guarda de exposición deja de saltar; un market maker cotiza alrededor de un precio falso. Es poco
  frecuente —hace falta un libro de un solo lado— pero cuando ocurre el sistema actúa con convicción
  sobre un dato inventado.
- **Test propuesto**: `exchange-core.spec.ts` — `l2Book` con `levels[0] = []` debe producir un error
  clasificado o un ticker sin precio, nunca `ask/2`.
- **Propuesta**: si falta un lado, no inventar el mid: devolver el mark del venue (ver HL-2) o lanzar
  `RETRYABLE`, que es lo que el motor ya sabe tratar.

### HL-4 — Cancelaciones y apalancamiento gastan el presupuesto de LECTURA

- **Severidad**: Alta (parte de **F-10**).
- **Evidencia**: `cancelOrder` `:646`, `:652`; `cancelOwn` `:670`; `cancelAll` `:682`; `modifyOrder`
  `:697`; `setLeverage` `:721` pasan por `call()` (`:1060`), que toma del presupuesto con prioridad
  `'read'`. Solo `placeOrder` (`:592`) y `adjustIsolatedMargin` (`:764`) usan `callWrite` (`:1075`).
  La reserva del 20 % existe precisamente para que «una avalancha de lecturas no pueda dejar sin
  caudal a la cancelación de un pánico» (`:1071-1074`), y no cubre a las cancelaciones.
- **Refuerzo desde la documentación**: el venue va en dirección contraria y les da **más** cupo —
  «Cancels have cumulative limit `min(limit + 100000, limit * 2)`» — precisamente para que siempre se
  pueda cancelar. Nuestro presupuesto hace lo opuesto.
- **Test propuesto**: `exchange-core.spec.ts` — con el depósito agotado por lecturas, un `cancelOwn`
  debe poder salir.

### HL-5 — El peso de las acciones en lote no se modela

- **Severidad**: Baja.
- **Evidencia**: la documentación fija el peso de una acción de intercambio en `1 + floor(batch_length / 40)`.
  `callWrite` cobra siempre 1 (`:1076`) y las cancelaciones en lote van por `call` con el peso por
  defecto 2. Un `cancelOwn` de 200 órdenes debería costar 6.
- **Impacto**: infracontabilidad pequeña, absorbida por el 15 % de margen. Se anota por completitud.

### HL-6 — `getOpenOrders` pierde la naturaleza de las órdenes con disparador

- **Severidad**: Media.
- **Evidencia**: `:414` mapea `type` a `MARKET` solo si `orderType === 'Market'`, y todo lo demás a
  `LIMIT`; `:415` toma `limitPx` como precio. Una condicional (stop-loss) trae además `triggerPx`,
  `isTrigger` y `triggerCondition`, y `VenueOrder` (`shared/src/orders.ts:57`) no tiene dónde
  guardarlos. `streamOrders` `:934` fuerza `type: 'LIMIT'` y `:940` fuerza `reduceOnly: false`.
- **Impacto**: el reconciliador compara precio y cantidad, así que un stop-loss y una orden límite al
  mismo precio son indistinguibles para él; y `reduceOnly` guardado como `false` para una orden que sí
  lo es deja la fila de `bot_orders` mintiendo. No he encontrado un camino en el que hoy eso cambie una
  decisión, de ahí Media y no Alta, pero es una pérdida de información en la frontera con el venue.

### HL-7 — El recargo por elementos de `userFillsByTime` no se cobra

- **Severidad**: Baja, **desviación consciente y documentada** (`:517-522`): el presupuesto se toma
  antes de llamar y el número de fills solo se sabe después. Lo dejo anotado como aceptado.

### HL-8 — `req.timeInForce` se ignora

- **Severidad**: Media (parte de **F-16**).
- **Evidencia**: `:575-581` deriva el tif solo del `OrderType`: `POST_ONLY → 'Alo'`, `MARKET → 'Ioc'`,
  resto `'Gtc'`. `TimeInForce` en `shared/src/enums.ts:69` incluye `IOC` y `FOK`, y solo Aster lo
  respeta. Un llamante que pida FOK recibe GTC sin aviso.

### HL-9 — `toAck` accede a `statuses[0]` sin guardas

- **Severidad**: Media.
- **Evidencia**: `:609` hace `result.response.data.statuses[0]`. Si el venue devolviera una respuesta
  con otra forma, el error sería un `TypeError` genérico y `classify` lo etiquetaría `FATAL`, que en
  `place()` no relanza pero sí deja la orden como rechazada. El propio `toAck` sí lanza un
  `ExchangeError('FATAL')` legible cuando el estado no encaja (`:637`), así que falta solo la guarda
  previa.

### HL-10 — Metadatos incorrectos en `orderUpdates`

Ver HL-6: `type` y `reduceOnly` fijos.

### HL-11 — Un transporte de WebSocket por cuenta, contra un límite de diez por IP

- **Severidad**: Alta.
- **Evidencia**: `subs` crea un `WebSocketTransport` por instancia de adaptador (`:166-175`), y
  `AccountHub` crea **un adaptador por cuenta de exchange** (`account-hub.service.ts:185`). La
  documentación oficial: «Maximum of 10 websocket connections», «Maximum of 30 new websocket
  connections per minute» y «Maximum of 10 unique users across user-specific websocket subscriptions».
  El propio comentario del código ya lo sabe (`:145-150`).
- **Impacto**: a partir de la **undécima cuenta de Hyperliquid** que corra por la misma IP de salida,
  las conexiones nuevas se rechazan. Los bots afectados no mueren —el tick por REST cada 15 s los hace
  converger igual— pero se quedan sin fills en tiempo real y sin recotización rápida, que es
  justamente lo que un market maker necesita. Nada en el código cuenta las conexiones ni avisa; el
  síntoma sería un `STREAM_ERROR` repetido. Y `WORKER_MAX_BOTS` está en 250, así que el escenario no
  es hipotético. Los reintentos cada 5 s (`:981-984`) además chocan con el límite de 30 conexiones
  nuevas por minuto.
- **Test propuesto**: no es unitario; corresponde a una comprobación de escala. Lo mínimo sería contar
  cuántas cuentas de Hyperliquid tiene un worker y avisar al pasar de diez.

### HL-12 — La comisión de builder no se acota

- **Severidad**: Media (parte de **F-16**).
- **Evidencia**: `:1023-1029` reenvía `builderFeeTenthBps` tal cual. El esquema del SDK documenta un
  máximo de 100 en perps. Un valor mal puesto en la configuración rechaza **todas** las órdenes de las
  cuentas con builder aprobado.

### HL-13 — Hyperliquid no tiene enfriamiento local tras un throttle

- **Severidad**: Media.
- **Evidencia**: `cooldown.ts` (`VenueCooldown`) está cableado en Lighter (`lighter.ts:511`, `:533`) y
  en Aster (`aster.ts:268`, `:334`), pero no en este adaptador. Tras un 429, `withRetry` reintenta
  hasta cuatro veces con espera creciente y el resto de bots de la cuenta siguen llamando.
- **Impacto**: alargar el castigo. En Hyperliquid el límite por dirección deja al usuario en «una
  petición cada 10 segundos», así que insistir es exactamente lo contrario de lo que conviene.

## Verificado OK

- Los pesos de `hyperliquidWeight` (`venue-weights.ts:181-214`) coinciden **uno a uno** con la tabla oficial: peso 2 para `l2Book`, `allMids`, `clearinghouseState`, `orderStatus`, `spotClearinghouseState` y `exchangeStatus`; 60 para `userRole`; 20 por defecto; `+1 por cada 20 elementos` en los trece endpoints que lo llevan; `candleSnapshot` con `+1 por cada 60`. El cupo de 1200/min y el margen del 15 % también.
- `adjustIsolatedMargin`: `ntli` entero en múltiplos de 1e6 truncando hacia cero, signo construido dentro y **sin reintento automático** porque no es idempotente (`:730-771`). Es el manejo más cuidadoso del fichero.
- `findPlaced` pregunta por `orderStatus` con el cloid, que pesa 2 y responde también para órdenes ya ejecutadas: es lo que impide duplicar una orden a mercado cuando se pierde la respuesta (`:1080-1107`).
- El `cloid` cumple el formato oficial de 128 bits y `cancelByCloid` se prefiere al oid, de modo que ninguna orden ajena puede colarse en un lote de cancelación.
- El sentido del disparador (`tpsl`) viaja explícito desde la estrategia en vez de deducirse, con el incidente documentado en el comentario (`:563-570`).
- Los flujos son compartidos con contador de referencias y el transporte se cierra de verdad en `close()`; los fallos de socket salen por `streamHealth` y nunca como `error()` sobre los `Subject` de datos, que quedarían muertos.
- El firmante y el transporte de WebSocket son perezosos: un adaptador público nunca materializa la clave ni ocupa una de las diez conexiones.
- En 5126 precios simulados sobre el catálogo real, ninguno viola las reglas de cifras significativas ni de decimales del venue.
