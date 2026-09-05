# Fase 2 — Línea C · Lighter (R-5, C-1 … C-9)

Spec: `specs/001-revision-integral/spec.md` · Base `63e676f` · Fecha 2026-09-05 ·
`zklighter-sdk` 1.3.0 (koffi 2.16.3) · Escala de severidad: `specs/README.md`.

**Alcance de esta fase**: solo lectura. Ninguna llamada firmada, ninguna petición de red a un
venue. Las sondas públicas ya estaban hechas y aquí se LEEN sus JSON guardados.

## 0. Método y fuentes

| Clave | Qué es |
|---|---|
| **DOC** | Documentación oficial de Lighter (`apidocs.lighter.xyz`), con URL, fecha y cita literal. |
| **SDK** | Lectura del código publicado de `zklighter-sdk@1.3.0` (`dist/signer.js`, `dist/api.d.ts`, `dist/api.js`). |
| **SONDA** | JSON guardados en `scratchpad/probes/out/lighter.*.json` (2026-09-05, 15:25 UTC). |
| **TEST** | Suite existente en `packages/exchange-core/src/*.spec.ts`. |

Ficheros auditados (leídos íntegros): `packages/exchange-core/src/adapters/lighter.ts` (1998 líneas),
`coid.ts`, `errors.ts`, `cooldown.ts`, `venue-weights.ts`, `venue-budget.ts`, `rate-limit.ts`,
`endpoints.ts`, `service-credentials.ts`, `ws.ts`, `market-cache.ts`, `candles.ts`, `capabilities.ts`,
`lighter-transport.spec.ts`, `packages/shared/src/precision.ts`, `orders.ts`, `market.ts`,
`packages/strategy-core/src/stop-loss.ts`, `order-gate.ts`, `common.ts`, `client-order-id.ts`,
`apps/worker/src/engine/bot-runner.ts` (`place()`, `execute()`, `safely()`, `closePositionAtMarket()`).

### Datos de sonda que se usan más abajo

| Sonda | Resultado |
|---|---|
| `GET /api/v1/orderBookDetails?filter=perp` (mainnet) | 200 · **233** perps · **216 activos**, 17 `inactive` · `spot_order_book_details: []` |
| ídem (testnet) | 200 · **176** perps, todos activos |
| `GET /api/v1/orderBooks` (mainnet) | 200 · 244 entradas |
| `GET /api/v1/orderBookDetails?market_id=0` | ETH: `supported_size_decimals 4`, `supported_price_decimals 2`, `min_base_amount "0.0050"`, `min_quote_amount "10.000000"`, `order_quote_limit "281474976.710655"`, `min_initial_margin_fraction 200`, `maintenance_margin_fraction 120`, `taker_fee`/`maker_fee` `"0.0000"`, `mark_price "2460.11"`, `index_price "2461.20"`, `last_trade_price 2459.83` |
| `GET /api/v1/candles?market_id=0&resolution=1h&count_back=3&…` | 200 · `{code:200, r:"1h", c:[{t,o,h,l,c,v,V,i}]}` · `t` en **ms** (1788606000000) |
| `GET /api/v1/candlesticks?...` (ruta del SDK) | mainnet **403** vacío (CloudFront) · testnet **404** `404 page not found` |

Derivados de la sonda que importan al veredicto:

- `supported_price_decimals + supported_size_decimals = 6` **en los 233 mercados**. Distribución:
  `0p/6s`×5, `1p/5s`×9, `2p/4s`×48, `3p/3s`×38, `4p/2s`×34, `5p/1s`×76, `6p/0s`×23.
- `min_base_amount` tiene **exactamente** `supported_size_decimals` decimales en los 233 (0 excepciones):
  el mínimo cae siempre en la retícula del step.
- `min_quote_amount` ∈ {`"10.000000"`, `"0.000000"`}; 6 decimales en los 233.
- `min_initial_margin_fraction` ∈ {0, 200, 333, 400, 500, 666, 1000, 1250, 2000, 3333}. Hay **un**
  mercado con fracción 0.
- `taker_fee` y `maker_fee` son `"0.0000"` en los 233 mercados.
- `order_quote_limit` tiene 13 valores distintos; el mayor, `281474976.710655`, es exactamente
  (2^48−1)/10^6 — el `quote_amount` del protocolo es un entero de 48 bits.

### Fuentes oficiales locales usadas (fecha de `updatedAt` de cada página)

| Fichero local | URL | `updatedAt` |
|---|---|---|
| `docs_trading.md` | https://apidocs.lighter.xyz/docs/trading | 2026-08-25 |
| `docs_rate-limits.md` | https://apidocs.lighter.xyz/docs/rate-limits | 2026-08-30 |
| `docs_get-started.md` | https://apidocs.lighter.xyz/docs/get-started | 2026-09-04 |
| `docs_api-keys.md` | https://apidocs.lighter.xyz/docs/api-keys | 2026-06-17 |
| `docs_websocket-reference.md` | https://apidocs.lighter.xyz/docs/websocket-reference | 2026-08-11 |
| `docs_data-structures-constants-and-errors.md` | https://apidocs.lighter.xyz/docs/data-structures-constants-and-errors | 2026-03-09 |
| `reference_{orderbookdetails,orderbooks,orderbookorders,accountactiveorders,trades,candles,account-1,nextnonce}.md` | https://apidocs.lighter.xyz/reference/… | 2026-05-29 (candles 2026-04-24) |
| `constants.go`, `l2_create_order.go` | github.com/elliottech/lighter-go `types/txtypes/` (commit `37514ad`, el que enlaza la doc) | — |
| `signer_client.py` | github.com/elliottech/lighter-python `lighter/signer_client.py` | — |

`docs_error-codes.md` es la página HTML de ReadMe sin renderizar (la lista de códigos vive en
`docs_data-structures-constants-and-errors.md`, sección «Error Codes», que es la que se cita).

## 1. Matriz de llamadas (R-5)

Convención: `L:n` = `packages/exchange-core/src/adapters/lighter.ts:n`; `S:n` =
`zklighter-sdk/dist/signer.js:n`; `A:n` = `dist/api.d.ts:n`; `T:n` = `docs_trading.md:n`;
`RL:n` = `docs_rate-limits.md:n`; `GS:n` = `docs_get-started.md:n`; `WS:n` =
`docs_websocket-reference.md:n`; `GO:n` = `constants.go:n`; `CO:n` = `l2_create_order.go:n`.

| # | Llamada (fichero:línea) | Endpoint / campo oficial | Regla | Método | Evidencia | Resultado |
|---|---|---|---|---|---|---|
| 1 | `loadMarkets` `L:561` `orderApi.orderBookDetails(undefined, 'perp')` | `GET /api/v1/orderBookDetails?filter=perp` | `filter ∈ {all,spot,perp}`; `market_id` opcional (255 = todos) | DOC + SONDA + TEST | `reference_orderbookdetails.md:29-55`; sonda 200 con 233 perps; `lighter-transport.spec.ts:178-183` | **OK** |
| 2 | `loadMarkets` `L:568-585` → `MarketSpec` | `supported_price_decimals`, `supported_size_decimals`, `min_base_amount`, `min_quote_amount`, `min_initial_margin_fraction`, `status` | «base_amount, price are to be passed as integers» `GS:74`; «to buy a whole Ethereum coin where supported_size_decimals is 4, you will need to specify size equal to 1*10^4» `T:35`; mínimos: «The highest of the two is applied. Note that those minimums only apply to maker orders» `T:35` | DOC + SONDA | tick = 10^-price_decimals, step = 10^-size_decimals; en los 233 mercados `min_base_amount` cae en el step (sonda, §0) | **OK** en el mapeo. Nota: el motor aplica los mínimos también a órdenes taker (`order-gate.ts`), más estricto que el venue |
| 3 | `maxLeverageOf` `L:1988-1992` | `min_initial_margin_fraction` en diezmilésimas | `MarginFractionTick = 10_000` `GO:149`; el SDK firma `imf = floor(10000/leverage)` `S:1034` | SDK + SONDA | Sonda: fracciones {200…3333} ⇒ 50x…3x; un mercado con 0 ⇒ 20 por defecto (`L:1990`) | **OK** (el 0 es un mercado sin apalancamiento publicado; el 20 es un valor inventado pero acotado) |
| 4 | `verify` `L:592` `signer.check_client()` | Nativo `CheckClient(api_key, account_index)` (koffi) | No documentado en REST; el Python hace lo mismo (`signer_client.py:438`) | SDK | `S:537-546`; la librería nativa puede hacer red por su cuenta: no pasa por `limiter`, `budget` ni `cooldown` | **OK** funcional; ver LT-15 |
| 5 | `fetchAccount` `L:620` `accountApi.account('index', String(accountIndex))` | `GET /api/v1/account?by=index&value=` | `by ∈ {index,l1_address}`, `value` string | DOC | `reference_account-1.md:44-64`; firma SDK `A:1698`. Campos usados `collateral`, `available_balance`, `positions[].{position,sign,avg_entry_price,unrealized_pnl,initial_margin_fraction,margin_mode,liquidation_price,allocated_margin}` existen (`reference_account-1.md:164-265,338-349`) | **OK**. Sin cabecera `authorization` salvo que antes hubiera pasado un `publicGet` (LT-5) |
| 6 | `getPositions` `L:652,659,661-662` | `sign` («1 for Long, -1 for Short» `reference_account-1.md:19`), `margin_mode` (0 cross / 1 isolated `GO:133-136`) | — | DOC + SDK | `p.sign < 0 ? -1 : 1` ✓; `ISOLATED_MARGIN_MODE = 1` `S:1122` ✓; `markPrice` sale de `detailsBySymbol.last_trade_price` (catálogo, TTL 5 min `market-cache.ts:18`) | **OK** salvo `markPrice` (LT-13) y `leverage` desde `initial_margin_fraction` como cadena («20.00» en el ejemplo oficial; unidad por confirmar) |
| 7 | `fetchOpenOrders` `L:695-700` `accountActiveOrders(accountIndex, marketId, undefined, authToken())` | `GET /api/v1/accountActiveOrders` | Cabecera `authorization` **required: true**; `account_index` required; `market_id` opcional («If not specified, returns active orders for all markets» `reference_accountactiveorders.md:31-57`) | DOC + SDK | Firma `A:2871`: `(accountIndex, marketId, authorization?, auth?)`. El adaptador manda el token como **4.º argumento = query `auth`** (`api.js:2583-2588`) y deja la cabecera al objeto mutable `sdkHeaders` (`L:352,391`). El SDK anota «`auth` made optional to support header auth clients» | **Discrepancia** (LT-5): la doc exige cabecera; el SDK aún acepta query. Y `market_id` omitido devuelve TODOS los mercados en una llamada, que hace innecesario el bucle de `L:689-704` (F-10) |
| 8 | `getRecentFills` `L:725-734` `trades('timestamp', 100, undefined, authToken(), marketId, accountIndex, undefined, 'desc')` | `GET /api/v1/trades` | `sort_by` required ∈ {block_height,timestamp,trade_id}; `limit` 1..100 required; `sort_dir` solo `desc`; `market_id`, `account_index` opcionales; «auth is required for master accounts and sub accounts» | DOC + SDK | `reference_trades.md:9,82-105,165-174`; firma `A:2958` casa posición a posición. Peso **600** (`RL:30`) descontado como 2 (`L:738`, `venue-weights.ts:117-119`) ✓ | **OK** en parámetros. `type` (`trade|liquidation|deleverage|market-settlement`, `reference_trades.md:263-272`) se ignora: **F-05 CONFIRMO** |
| 9 | `getRecentFills` `L:743-771` mapeo a `Fill` | `ask_account_id`, `bid_account_id`, `is_maker_ask`, `ask_client_id`, `bid_client_id`, `taker_fee`/`maker_fee` (int32), `timestamp` | Ejemplo oficial `timestamp: 1640995200` (segundos) y `transaction_time` en µs | DOC + SDK + TEST | `normalizeTs` `L:74` cubre segundos y milisegundos; `feeToUsdc` divide por 1e6 (`L:1976-1980`, `errors.spec.ts:71-95`) | **OK** |
| 10 | `getTicker` (respaldo REST) `L:804` `orderBookOrders(marketId, 1)` | `GET /api/v1/orderBookOrders?market_id&limit` | `limit` 1..250 required | DOC | `reference_orderbookorders.md:39-49`; `SimpleOrder.price` string ✓ | **OK** |
| 11 | `getTickers` (respaldo REST) `L:877` `orderBookDetails(undefined,'perp')` | ídem #1; `daily_chart`, `daily_price_change`, `last_trade_price` | — | DOC + SONDA + TEST | `exchange-core.spec.ts:1273-1360` | **OK** |
| 12 | `getCandles` `L:937-944` `publicGet('/api/v1/candles', {market_id, resolution, start_timestamp, end_timestamp, count_back})` | `GET /api/v1/candles` | Los cinco parámetros son `required`; timestamps 0..5e12 (ms); «Returns at most 500 candles per call. Zero values are omitted» | DOC + SONDA + TEST | `reference_candles.md:9,29-98`; `capabilities.ts:118` (500); sonda 200 con `t` en ms; `lighter-transport.spec.ts:115-183`. La ruta del SDK (`/candlesticks`, `A:2350`) da 403/404 (sonda) | **OK** |
| 13 | `authToken` `L:548` `create_auth_token_with_expiry()` y caché `L:1002-1018` (8 min) | Token `{expiry_unix}:{account_index}:{api_key_index}:{random_hex}` | «Each auth code can have a maximum expiry of 8 hours» `docs_api-keys.md:21`; «Max is 8 hours, default is 10 minutes» `GS:142` | DOC + SDK | `S:717-727`: `DEFAULT_10_MIN_AUTH_EXPIRY` ⇒ `10*MINUTE`; `AUTH_TOKEN_TTL_MS = 8 min` `L:213` < 10 | **OK** en vida. **Discrepancia** en propagación: `authHeaderToken()` solo se ejecuta desde `restHeaders()` (`L:985`), que solo usa `publicGet` (`L:1025`); `sdkHeaders.authorization` se escribe ahí y en ningún otro sitio (LT-5) |
| 14 | `placeOrder` LIMIT/POST_ONLY `L:1150-1163` `create_order(marketId, clientIndex, baseAmount, price, isAsk, LIMIT=0, GTT=1 o POST_ONLY=2, reduceOnly, NIL_TRIGGER_PRICE=0, DEFAULT_28_DAY_ORDER_EXPIRY=-1)` | `sendTx` tipo 14 `L2CreateOrder` | Tipos 0..6 y tif 0..2 `T:45-62`; ejemplo oficial con `order_expiry=DEFAULT_28_DAY_ORDER_EXPIRY` `GS:100-113`; `LimitOrder` con tif ≠ IOC exige `OrderExpiry ≠ 0` `CO:121-128`; expiry entre 5 min y 30 días `T:70`, `GO:229-230` | DOC + SDK | Orden de argumentos casa con `S:773` y con `GS:103-113`; constantes `S:1103-1118` = `GO:74-97` | **OK** |
| 15 | `placeOrder` TP/SL-limit `L:1139-1143,1159-1162` `ORDER_TYPE_STOP_LOSS_LIMIT=3` / `TAKE_PROFIT_LIMIT=5`, GTT, `trigger_price` escalado, expiry −1 | ídem | `StopLossLimitOrder/TakeProfitLimitOrder`: exige `TriggerPrice ≠ 0` y `OrderExpiry ≠ 0`, solo perps `CO:139-146`; «besides a trigger price, you should indicate a price as well, which indicates the allowed slippage for the execution» `T:37`; 21735 «SL/TP order price is too far from the trigger price» | DOC + SDK | Coincide con `create_sl_limit_order`/`create_tp_limit_order` del SDK (`S:878-885`). **Pero esta rama es inalcanzable desde las estrategias**: el único emisor de `triggerPrice` es `stop-loss.ts:67` y va con `type: 'MARKET'`, que entra antes por `L:1097` | **Rama correcta pero muerta**; ver #16 y LT-1 |
| 16 | `placeOrder` MARKET `L:1097-1130` `create_market_order(marketId, clientIndex, baseAmount, price, isAsk, reduceOnly)` | `ORDER_TYPE_MARKET=1`, `IOC=0`, `NIL_TRIGGER_PRICE`, `DEFAULT_IOC_EXPIRY=0` (`S:801-803`) | `MarketOrder` exige IOC, expiry 0 y **sin trigger** `CO:113-120`; `avg_execution_price` = «the worst price you're willing to accept - if the sequencer cannot offer you an equal or better price, the order is cancelled» `T:37`; «Orders that have the correct syntax will be accepted by the API servers, returning code=200. This does not guarantee the execution of your order» `T:11` | DOC + SDK | (a) `req.triggerPrice` se **descarta**: el stop inyectado (`stop-loss.ts:63-67`, `type:'MARKET'`+`triggerPrice`) sale como IOC inmediata al precio del stop — Hyperliquid mira `triggerPrice` antes que `type` (`hyperliquid.ts:557-560`) y Aster también (`aster.ts:1045-1050`). (b) `price = px(mark)` sin holgura (`tdca.ts:322`, `market-maker.ts:836`, `bot-runner.ts:2031`) frente al 5 % de Hyperliquid (`hyperliquid.ts:555`) y a `create_market_order_limited_slippage` del SDK (`S:804-817`). (c) el ack devuelve `status: FILLED` sin que el venue lo haya dicho (`L:1120-1125`) | **Discrepancia grave**: LT-1 (stop) y LT-3 (holgura + FILLED fabricado) |
| 17 | `placeOrder` `client_order_index` `L:1091` `lighterCodec.encodeNumeric` | uint48 | «client_order_index (uint48)» `T:41`; `MinClientOrderIndex = 1`, `MaxClientOrderIndex = 2^48-1`, `NilClientOrderIndex = 0` `GO:205-209`; «unique (across all markets)» `GS:74` | DOC + SDK + TEST | `coid.ts:39-48` toma 6 bytes de sha256 ⇒ [0, 2^48−1]; `exchange-core.spec.ts:57-62` | **OK** (0 con probabilidad 2^-48 = «sin índice»). Alcance de la unicidad (¿solo activas?) **por confirmar**; ver §3 |
| 18 | `placeOrder` escalado `L:1093-1094,1160` `scaled()` `L:1949-1951` | `base_amount` int64 ≤ 2^48−1; `price` y `trigger_price` **uint32** (1..2^32−1) | `GO:214-234`; `CO:73-90,159-162` | SDK + TEST | Truncado `ROUND_DOWN`; `exchange-core.spec.ts:303-306`. Con `px()` delante el valor ya está en la retícula y no se trunca nada; sin `px()` solo llega `mark` del ticker (`bot-runner.ts:2031`), con menos de un tick de error | **OK** |
| 19 | `findPlaced` `L:1189-1215` | `accountActiveOrders` + `trades` | — | SDK | `L:1204`: `getRecentFills(...).catch(() => [])` ⇒ un fallo de red se lee como «no llegó» y `withWriteRetry` (`rate-limit.ts:110-113`) **reenvía** la MARKET | **F-16 CONFIRMO** (LT-10) |
| 20 | `cancelOrder` `L:1233-1237` `cancel_order(marketId, BigInt(orderIndex))` | `sendTx` tipo 15 `L2CancelOrder`; `order_index` int64 (≥ 2^48+1 `GO:211-212`) | Cancelar por `order_index` `GS:116-123`, `T:41` | DOC + SDK | `S:861-874`. Va por `this.call` ⇒ prioridad `read` y `withRetry` de 4 intentos (F-10). El `venueOrderId` del ack es el **índice de cliente** (`L:1122,1174`), no un `order_index` | **OK** en el cable; F-10 CONFIRMO; ver LT-13 |
| 21 | `cancelAll` `L:1292` `cancel_all_orders(CANCEL_ALL_TIF_IMMEDIATE=0, 0)` | `sendTx` tipo 16; `ImmediateCancelAll = 0` `GO:107-112`; ventana programada 5 min..15 días `GO:222-223` | El JS 1.3.0 no expone `cancel_all_market_index` (el Python sí, `signer_client.py:1158`): alcance de **cuenta** | DOC + SDK | `S:924-937`; comportamiento con `0` verificado contra testnet por el autor (`L:1278-1291`); no se puede repetir aquí | **OK** (alcance de cuenta asumido en `L:1269-1273`) |
| 22 | `setLeverage` `L:1303-1307` `update_leverage(marketId, CROSS=0 o ISOLATED=1, leverage)` | `sendTx` tipo 20; `imf = floor(10000/leverage)` `S:1034` | `MarginFractionTick 10_000` `GO:149`; `L2UpdateLeverage` 40/min `RL:127`; 21132 «margin mode change on a market with position or open order is not allowed» | DOC + SDK | Orden de argumentos casa con `S:1032` (`market_index, margin_mode, leverage`). Un apalancamiento no divisor (7 ⇒ 1428) puede dar 21113 «invalid initial margin fraction»: por confirmar | **OK**; 21132 cae en FATAL (LT-8) |
| 23 | `adjustIsolatedMargin` `L:1352-1358` `update_margin(marketId, amount.toNumber(), REMOVE=0 o ADD=1)` | `sendTx` tipo 29 `L2UpdateMargin`; `usdc_amount × 1e6` con `Math.floor` `S:1050` | `OneUSDC = 1000000` `GO:145`; `RemoveFromIsolatedMargin=0`, `AddToIsolatedMargin=1` `GO:139-142` | SDK | Importe legible (no escalado) ✓ `L:1321-1323`; sin `call` (no reintento) ✓; conserva `signedWrite`, que es inerte (LT-2) | **OK** (coma flotante del SDK: 1 µUSDC como mucho) |
| 24 | WS `ensureSocket` `L:1641-1665` | `wss://{host}/stream` `WS:13`; keepalive «at least one frame every 2 minutes … `{"type":"ping"}` will receive back `{"type":"pong"}`» `WS:29-36` | Reconexión recomendada `RL:52` | DOC + TEST | Ping cada 60 s (`L:190`); `route` ignora `pong` (`L:1692`); resuscripción en `onOpen` (`L:1648-1652`, `lighter-transport.spec.ts:291-309`) | **OK** |
| 25 | WS `market_stats/all` `L:1799-1813` | `{"type":"subscribe","channel":"market_stats/all"}` `WS:562-565`; respuesta `market_stats:{id}` | — | DOC + TEST | Fusión parcial probada `lighter-transport.spec.ts:261-285` | **OK** |
| 26 | WS `ticker/{id}` `L:1552-1571` | `WS:484-546`: canal de respuesta `ticker:{MARKET_INDEX}`, `ticker.{a,b}.{price,size}` strings | — | DOC + TEST | Mapa de rutas con `:` (`L:1734`) coincide con la doc; `lighter-transport.spec.ts:385-404` | **OK** |
| 27 | WS `candle/{id}/{res}` `L:1600-1616` | `WS:722-830`: 8 resoluciones; «up to 2 candles … candles[0] will be the oldest» | — | DOC + TEST | `LIGHTER_INTERVALS` = las ocho (`capabilities.ts:56-65`); se emiten todas (`L:1606`) | **OK** |
| 28 | WS `unsubscribe` `L:1764` | `{"type":"unsubscribe","channel"}` `WS:391-397` | — | DOC + TEST | `lighter-transport.spec.ts:336-353` | **OK** |
| 29 | WS límites | «Connections: 255 · Subscriptions per connection: 500 · Max Messages Sent By Client Per Minute: 200 · Max Inflight Messages: 50» `RL:43-50` | — | DOC | Un socket por adaptador ✓; suscripciones = 1 + 2 por símbolo ✓; en cada reconexión `onOpen` reenvía **todos** los canales de golpe (`L:1649-1651`) sin contar contra 200/min | **OK** hoy; LT-14 por confirmar |
| 30 | WS stream de cuenta (ausente) `L:333-339,1415-1421` | `account_all/{ACCOUNT_ID}` `WS:938-1069`, `account_all_orders/{id}` (auth) `WS:1230-1250`, `account_all_trades/{id}` `WS:1502-1535` | — | DOC | El adaptador sondea `trades` (600) + `accountActiveOrders` cada 12 s por símbolo (`L:224,1439-1446`) | **Ausente**, documentado en código; LT-11 |
| 31 | `nextNonce` (SDK, implícito) `S:109-121,141-151` desde `L:448-451,487` | `GET /api/v1/nextNonce?account_index&api_key_index` `reference_nextnonce.md:29-47`; peso 6 `RL:25` | «each nonce is handled per API_KEY» `T:29`; «we require new_nonce = old_nonce + 1» `docs_api-keys.md:45` | DOC + SDK | Se dispara dos veces al arrancar (constructor `S:157` + `signerReady` `L:451`); fuera de `budget`, `limiter` y `cooldown`; `initialize()` **traga** el fallo (`S:117-120`) | LT-9 y LT-2 |
| 32 | `sendTx` (SDK, implícito) `S:1064-1070` | `POST /api/v1/sendTx` peso 6 `RL:25`; Standard: 60/min compartido `RL:19,58`; «Default 40 requests/minute» por tipo de tx `RL:123` | 429/405 `RL:140` | DOC + SDK | `budget.take(...,1,'write')` solo en `placeOrder` y `adjustIsolatedMargin` (`L:1106,1147,1348`); cancel/leverage por `call` (`read`); la cabecera `authorization` no viaja (el SDK crea su propia `Configuration` sin `baseOptions`, `S:495-497`) | **OK** en cuenta; F-10 CONFIRMO en prioridad |

## 2. Veredictos C-1 … C-9

### C-1 Hosts y redes — **OK, con una nota**

- `endpoints.ts:32-41`: `https://mainnet.zklighter.elliot.ai` / `wss://mainnet.zklighter.elliot.ai/stream`
  y sus gemelos `testnet.` coinciden con la doc (`WS:13`: «URL: `wss://mainnet.zklighter.elliot.ai/stream`;
  `wss://testnet.zklighter.elliot.ai/stream`»; `servers[].url` de cada `reference_*.md` =
  `https://mainnet.zklighter.elliot.ai/`). La sonda responde 200 en los dos hosts REST.
- `chain_id`: el SDK JS deduce `url.includes("mainnet") ? 304 : 300` (`S:481`); la doc dice «The
  relevant Chain IDs for the Lighter app-chain are: `304` (mainnet), `300` (testnet)» (`GS:9`). El SDK
  Python es más fino —`304 if "mainnet.zklighter" in url else 300 if "testnet.zklighter" in url … else 304`
  (`signer_client.py:350-355`)— y **por defecto firma como mainnet** cuando no reconoce el host; el JS
  por defecto firma como **testnet**. Con las dos URLs de la tabla el resultado es el correcto
  (`endpoints.spec.ts:38-41` lo fija). La red viaja al firmante en `L:417-422` con `this.url`.
- **Nota (Baja)**: `creds.baseUrl` heredado gana sobre la tabla (`L:384`, probado en
  `endpoints.spec.ts:89`). Un sobre sellado con un `baseUrl` sin la subcadena `mainnet` firmaría con
  `chain_id 300` contra el host que diga ese `baseUrl`, sin ninguna comprobación de que pertenezca a
  `VENUE_ENDPOINTS`. Es exactamente la trampa que describe el comentario de `endpoints.ts:54-59`; hoy
  ningún cliente lo rellena, pero nada lo impide.

### C-2 Precisión — **OK**

- Tick y step derivan de `supported_price_decimals` / `supported_size_decimals` (`L:568-569`), que es
  lo que manda la doc (`T:35`, `GS:76-82`). Sonda: en los 233 mercados `supported_* == *_decimals`,
  suma 6, y `min_base_amount` cae siempre en la retícula (§0).
- Al cable van **enteros** (`scaled`, `L:1949-1951`) como `number` a koffi: no hay formateo textual y
  por tanto no puede salir notación exponencial. `base_amount` ≤ 2^48−1 y `price`/`trigger_price`
  son **uint32** (`GO:214-234`): el mayor precio representable es `4 294 967 295 / 10^price_decimals`
  (4 294,97 en un mercado de 6 decimales de precio). Ningún mercado sondeado se acerca.
- `scaled()` trunca (`ROUND_DOWN`). Todo precio de estrategia pasa antes por `px()`
  (`common.ts:379-380` = `roundPriceForSide` + `toFixed(priceDecimals)`), así que llega ya en la
  retícula y el truncado no altera nada. El **único** camino sin `px()` es `closePositionAtMarket`
  (`bot-runner.ts:2031`, `price: mark`), y `mark` es `mark_price`/`index_price` del venue o el punto
  medio del libro (`L:798,1567`): como mucho medio tick de exceso, que en una MARKET es el tope de
  precio y no el precio. Sin efecto. El truncado de una cantidad tampoco: `qy()` ya la ha bajado al step
  (`common.ts:383-384`) y `qty.abs().toFixed(qtyDecimals)` de un cierre parte de una cantidad del venue.
- Mínimos: `minQty = min_base_amount`, `minNotional = min_quote_amount` (`L:578-579`). La doc dice
  «The highest of the two is applied. Note that those minimums only apply to maker orders» (`T:35`); el
  motor los aplica también a las MARKET (`order-gate.ts`), que es más estricto que el venue. Es asunto
  de la línea B (B-21a), no del adaptador.

### C-3 Cuerpo de la orden — **hallazgos LT-1, LT-3; F-16 CONFIRMO**

- Tipos y tif: los enteros del adaptador son los oficiales (`S:1103-1112` = `T:45-62` = `GO:74-97`).
- `timeInForce` de la petición **no se lee**: `L:1132-1135` deriva el tif solo de `req.type`
  (`POST_ONLY → 2`, resto `GTT`). Una petición IOC/FOK saldría GTT. **F-16 CONFIRMO** (contrato).
- `reduceOnly` → `reduce_only` (`L:1115,1158`) ✓. Spot no aplica (solo perps, `L:563`).
- **Disparadores**: el orden de las ramas es el problema. `L:1097` comprueba `req.type === 'MARKET'`
  antes de mirar `req.triggerPrice`, y la única petición con `triggerPrice` que existe en el sistema
  es el stop inyectado, que es `type: 'MARKET'` (`stop-loss.ts:63-67`). Hyperliquid (`hyperliquid.ts:557-560`)
  y Aster (`aster.ts:1045-1050`) miran el disparador primero. Ver **LT-1**.
- Precio de una MARKET: es el peor precio aceptable (`T:37`) y el adaptador manda `px(mark)` sin
  holgura, con acuse `FILLED` inventado (`L:1120-1125`). Ver **LT-3**.
- `client_order_index`: 48 bits, [1, 2^48−1] (`T:41`, `GO:205-209`), con paso de ids ya numéricos
  (`coid.ts:45`). ✓. Builder/integrador: no aplica (el SDK JS 1.3.0 no expone `integrator_*`).

### C-4 Firma y nonce — **hallazgos LT-2 (= F-01 CONFIRMO), LT-5, LT-9**

- Nonce por cuenta **y** clave (`T:29`, `docs_api-keys.md:11,45`): el SDK lo carga con
  `GET /nextNonce` (`S:109-121`) y lo incrementa en local (`S:123-133`). ✓.
- Errores en tupla, no lanzados: `process_api_key_and_nonce` (`S:728-759`) captura **toda** excepción y
  devuelve `[null, null, mensaje]`; el adaptador los convierte en `unwrap` (`L:493-499`). ✓ salvo que
  el `catch` de `signedWrite` (`L:481-489`) queda inalcanzable: **LT-2**.
- Token de auth: 10 min por defecto (`S:719-721`), caché de 8 (`L:213`), máximo oficial 8 h
  (`docs_api-keys.md:21`). ✓ en vida; **LT-5** en propagación (solo lo escribe `publicGet`).
- Índices de clave: `service-credentials.ts:48` exige 4..254; la doc reserva {0,1,2,3}
  (`docs_api-keys.md:9`) — `GS:48` dice «Indices 0-1 are reserved» y «indices 2-254», y las dos páginas
  se contradicen; el adaptador toma la más restrictiva. ✓.

### C-5 Errores — **hallazgos LT-4, LT-7, LT-8**

Salida literal de `classify-check.out.txt` (las regex reales de `errors.ts:23-52` contra 46 mensajes
oficiales de `docs_data-structures-constants-and-errors.md`):

| Código | Clasifica | Debería | Mensaje oficial |
|---|---|---|---|
| 21104 | FATAL | reintento con `hard_refresh_nonce` | invalid nonce |
| 21105 | FATAL | (criterio) | batch transaction nonce is not increasing |
| 21706 / 21701 / 21702 | RULES | RULES | invalid order base or quote amount / invalid base amount / invalid price |
| 21728 | FATAL | idempotencia (la orden **ya está**) | client order index already exists |
| 21727 | FATAL | (criterio) | invalid client order index |
| 21700 | RULES | (criterio) | invalid order index |
| 21600 / 21715 / 21709 / 21708 / 21707 | FATAL | «ya no existe» (no-op de cancelación) | given order is not an active limit order / given order is not an active order / order is inactive / order is empty / account is not owner of the order |
| 21717 / 21718 / 21719 / 21720 | FATAL | RULES | maximum active limit order count [per market] reached / maximum pending order count [per market] reached |
| 21732 / 21738 / 21740 | RULES | (criterio) | reduce only increases position / invalid reduce only direction / invalid reduce only mode |
| 21739 | INSUFFICIENT_FUNDS | INSUFFICIENT_FUNDS | not enough margin to create the order |
| 21507 / 21508 | FATAL | INSUFFICIENT_FUNDS | account is below maintenance/initial margin, can't execute transaction |
| 21734 / 21735 / 21733 | FATAL | RULES | limit order price is too far from the mark price / SL/TP order price is too far from the trigger price / order price flagged as an accidental price |
| 21713 / 21714 / 21712 | FATAL | (criterio) | invalid cancel all time in force / invalid cancel all time / account has a queued cancel all orders request |
| 21613 / 21132 / 21615 / 21614 / 21113 | FATAL | RULES (21132) | invalid margin mode / margin mode change on a market with position or open order is not allowed / invalid update margin direction / no position found / invalid initial margin fraction |
| 23000 | RETRYABLE | THROTTLED | Too Many Requests! |
| 23001 / 23003 / 30009 / 30005 | FATAL | (criterio) | Too Many Subscriptions! / Too Many Connections! / Too Many Websocket Messages! / Invalid Channel |
| 21506 | RETRYABLE | RETRYABLE | too many pending txs. Please try again later |
| 21601 | FATAL | RETRYABLE | order book is full |
| 21514 / 22402 / 22403 / 61002 / 21102 / 21100 | FATAL | (criterio) | maximum 50 transactions allowed per batch / invalid resolution / time range exceeds… / api token expiry… / invalid account index / account not found |

Añadidos de esta fase, leyendo `errors.ts:26` sobre la misma lista: 21120 «invalid signature» → AUTH ✓;
21110 «invalid api key index» → AUTH ✓; pero **21108** «invalid PublicKey,please run changePubKey» y
**21109** «api key not found» → FATAL (la regex `invalid.?(api|key|signature)` no casa con «invalid P…»
ni hay `unauthor|forbidden`). Son los dos mensajes de una clave revocada o no registrada: el bot no
entra en el camino `AUTH → detach` de B-6 sino en la cuarentena por forma con un `ERROR` por orden.

- **Regex de `safely()`** (`bot-runner.ts:2088`: `/not found|unknown order|does not exist/i`) frente
  al vocabulario real de «orden ya no existe» de Lighter (21600, 21715, 21709, 21708): **no casa
  ninguno**. Ver **LT-7**.
- **THROTTLED en el camino de escritura**: el 429/405 solo se reconoce por el estado HTTP
  (`errors.ts:165`), y la tupla del SDK solo trae `response.data.message` (`S:753`): «Too Many
  Requests!» llega sin estado y cae en RETRYABLE (`errors.ts:50`), que `withWriteRetry` reintenta.
  Ver **LT-4**.
- **Umbrales de 21734 y 21735**: no aparecen en ninguna página local (`docs_trading.md`,
  `docs_data-structures…`, la HTML de `error-codes`, `llms.txt`). Solo se sabe que existen: una
  retícula ancha o un stop con `price == trigger` (permitido: distancia cero) pueden toparse con
  ellos y hoy se registran como FATAL en vez de RULES. **Por confirmar** con el venue; no se puede
  sondear sin firmar.

### C-6 Caudal — **F-10 CONFIRMO (parcial); hallazgos LT-4, LT-11, LT-12**

- `VENUE_QUOTA_PER_MINUTE.LIGHTER = 60` en **peticiones** (`venue-weights.ts:32,52`) = «Standard
  accounts: 60 requests per rolling minute» y «While standard accounts rate limits are not weighted»
  (`RL:19,35`). ✓. Margen 0,85 ⇒ 0,85/s, depósito de 2 s (`venue-budget.ts:84-86,108`).
- `LIGHTER_WEIGHT` (`venue-weights.ts:69-92`) coincide **uno a uno** con `RL:25-33` (6 / 50 / 100 /
  150 / 500 / 600 / 3000 / 23000 / 300); falta solo `referral/*` (3000), que nadie llama. `lighterCost`
  normaliza a peticiones-equivalentes (`trades` = 2) ✓.
- 429 y 405 → THROTTLED por estado (`errors.ts:165`) = «You will receive HTTP 429, or HTTP 405»
  (`RL:140`); página WAF por huella (`errors.ts:173`). Enfriamiento local 60 s (`cooldown.ts:100`) =
  «Firewall: 60 seconds, static» (`RL:151`). Pero el corte de los **servidores de API** dura
  `weightOfEndpoint/(totalWeight/60)` —750 ms para un endpoint de 300 (`RL:152-154`)— y el adaptador
  le aplica también 60 s: conservador de más (Baja, dentro de LT-15).
- **Reserva de escritura**: existe (20 %, `venue-budget.ts:109,122`) pero `cancelOrder`, `cancelOwn`,
  `cancelAll` y `setLeverage` piden con prioridad `read` porque van por `this.call` (`L:1235,1263,1277,1302`).
  **F-10 CONFIRMO**. Además `call` = `withRetry` de 4 intentos: un `cancel_order` que da timeout tras
  haber entrado se reenvía con el nonce ya decrementado (`S:752`) y cae en «invalid nonce» (LT-2).
- **Fuera de la cuenta**: `nextNonce` (2 al arrancar, 1 por `hard_refresh`), `CheckClient` nativo de
  `verify()`. `sendTx` sí se cuenta (1) en `placeOrder`/`adjustIsolatedMargin`.
- **Aritmética por bot** (Standard, 51 peticiones/min útiles): sondeo = `trades` (2) + `accountActiveOrders`
  (1) cada 12 s por símbolo = **15/min**; tick = `account` (1, memo 800 ms) + `getOpenOrders(symbol)` (1)
  = 2 por tick, 24/min con latido de 5 s. Un bot ≈ 39/min; el segundo bot de la misma IP ya
  espera en el depósito. No es un error —el presupuesto espera, no falla— pero fija la capacidad real:
  **≈ 1 bot por IP y red sin cuenta Plus/Premium**. Ver LT-11.
- `getOpenOrders()` sin símbolo = 216 peticiones firmadas en mainnet (sonda) contra 60/min: **latente**.
  Ningún llamante lo hace: `account-hub.service.ts:696-697` pone `symbol ?? this.symbol`,
  `bot-runner.ts:572` pasa `bot.symbol`, y `findPlaced`/`cancelOrder`/`cancelOwn` llevan símbolo. Y la
  doc dice que un `accountActiveOrders` sin `market_id` devuelve **todos** los mercados en una llamada
  (`reference_accountactiveorders.md:51`): el bucle de `L:689-704` multiplica por 216 algo que el venue
  da en 1. Ver LT-12.

### C-7 WebSocket — **OK; hallazgos LT-11 (stream de cuenta), LT-14 (por confirmar)**

- Suscripción `{type:'subscribe', channel}` y baja `{type:'unsubscribe', channel}` (`L:1650,1740,1764`)
  = `WS:391-397,406,486`. Canales `market_stats/all`, `ticker/{id}`, `candle/{id}/{res}` = `WS:563,487,729`.
  Respuestas con `:` = `WS:504,581,747`. ✓ (y probado contra servidor local).
- Ping `{"type":"ping"}` cada 60 s (`L:190,1653-1656`) frente a «at least one frame every 2 minutes»
  y «Clients sending `{"type":"ping"}` will receive back `{"type":"pong"}`» (`WS:29-36`). ✓.
- Resuscripción en `onOpen` (`L:1648-1652`); una conexión por adaptador frente a 255 por IP; ≤ 500
  suscripciones por conexión (`RL:45-46`). ✓.
- **Ausente**: `account_all/{id}` (`WS:938-1069`: `positions`, `trades`, `funding_histories` en cada
  actualización), `account_all_orders/{id}` (`WS:1230-1250`) y `account_all_trades/{id}` (`WS:1502-1535`).
  El adaptador lo sabe (`L:333-339,1370-1385`) y sondea. Ver LT-11.
- «When you're rate-limited on REST, WebSocket connections also get rate-limited, and vice versa»
  (`RL:142`): `ReconnectingSocket` no consulta `cooldown` al reconectar (Baja, en LT-15).
- «Max Messages Sent By Client Per Minute: 200» (`RL:49`): `onOpen` reenvía todos los canales de
  golpe. Ver LT-14.

### C-8 Fills y posiciones — **F-05 CONFIRMO; hallazgo LT-13**

- Comisión: `maker_fee`/`taker_fee` son `int32` en unidades de 1e-6 USDC (`reference_trades.md:325-328,348-352`;
  medido por el autor en `L:1956-1974`); `feeToUsdc` divide por 1e6 y conserva el signo (positivo =
  pagada). ✓ con test (`errors.spec.ts:71-95`).
- `Trade.type ∈ {trade, liquidation, deleverage, market-settlement}` en la **doc** (`reference_trades.md:263-272`)
  y en el **SDK** (`A:1263,1302-1308`); `L:752-757` afirma que «el payload de trades de Lighter no
  trae ningún campo que lo diga». **F-05 CONFIRMO con DOC + SDK**: `Fill.liquidation` nunca se marca
  en Lighter.
- Funding: no viaja en los fills; `total_funding_paid_out` (`reference_account-1.md:224-227`) y
  `funding_histories` del stream no se leen. Hoy ninguna contabilidad de funding en este venue (nota).
- Parciales: `filledQty = initial − remaining`, `avgPrice = filled_quote / filled` (`L:1903,1913-1917`) ✓.
- Vocabulario de estados: `Order.status` tiene 17 valores (`A:497-516`); `toVenueOrder` lo ignora y
  deriva OPEN/PARTIALLY_FILLED de las cantidades (`L:1918`); `type` colapsa todo lo que no es `market`
  a `LIMIT` (`L:1910`, gemelo de F-29); `createdAt: Date.now()` en vez de `created_at` (`L:1920`). Ver LT-13.
- Posiciones: `position` siempre positivo con `sign` (`reference_account-1.md:19`) ✓ (`L:651-652`);
  `markPrice` = `last_trade_price` del **catálogo** (hasta 5 min viejo) ✓ funcional pero no es un mark;
  `leverage` = `10000 / initial_margin_fraction` donde el ejemplo oficial trae `"20.00"` (¿porcentaje?):
  por confirmar. Ver LT-13.

### C-9 Cancelaciones, modify, leverage, margen y modo de posición — **OK con F-10**

- `cancel_order(market, order_index)` ✓ (`GS:116-123`); resolución de `order_index` por coid vía
  `accountActiveOrders` ✓; «ya no está» = no-op ✓ (`L:1228-1232,1258-1260`).
- `cancel_all_orders(IMMEDIATE, 0)` ✓ con las constantes oficiales (`GO:107-112`); alcance de cuenta
  (el JS 1.3.0 no pasa `cancel_all_market_index`; `S:924`). Documentado en `L:1269-1273`.
- `modifyOrder`: opcional en el contrato (`types.ts:197`) y no implementado en Lighter aunque el SDK
  trae `modify_order` (`S:938`). No aplica.
- `update_leverage`: `imf = floor(10000/leverage)` (`S:1034`) con `MarginFractionTick = 10 000`
  (`GO:149`) ✓; un rechazo queda en `LEVERAGE_SKIPPED` WARN (`bot-runner.ts:1861-1874`) ✓, incluido
  21132 con posición u órdenes abiertas.
- `update_margin`: importe legible × 1e6 en el SDK (`S:1050`, `GO:145`); direcciones 0/1 (`GO:139-142`)
  ✓; sin reintento ✓. (B-10a: el handle del worker no lo expone.)
- Modo de posición: Lighter tiene una posición por mercado y cuenta; no hay `setPositionMode` ni
  falta. ✓.

## 3. Atención especial

### 3.1 F-01 — Traza completa de `{"code":21104,"message":"invalid nonce"}`

Recorrido de una `create_order` (el de `cancel_order`, `cancel_all_orders`, `update_leverage` y
`update_margin` es idéntico porque los cinco pasan por `process_api_key_and_nonce`):

1. `L:1148-1163` → `signedWrite(fn)` → `signerReady()` (`L:446-459`) espera `nonce_manager.initialize()`
   y devuelve el `SignerClient`.
2. `fn(client)` → `limiter.run(() => signer.create_order(...))` → `S:773-786` →
   `process_api_key_and_nonce(func, -1, -1)` (`S:728`).
3. `S:731-734`: `[ak, n] = nonce_manager.next_nonce()` (`S:123-133`): lee `nonces[ak] = N`, escribe
   `N+1`, devuelve `N`.
4. `func(n, ak)` → `sign_create_order` (nativo) → `send_tx` (`S:1064-1070`) → `tx_api.sendTx` (axios).
5. El venue responde **HTTP 400** con cuerpo `{"code":21104,"message":"invalid nonce"}`. axios lanza un
   `AxiosError` con `message = "Request failed with status code 400"`, `response.status = 400`,
   `response.data = {code: 21104, message: "invalid nonce"}`.
6. `S:743-757` (el `catch`): la condición es `error.response?.status === 400 && error.message?.includes("invalid nonce")`.
   `error.message` es «Request failed with status code 400» → **false** → rama `else` (`S:751-757`):
   `nonce_manager.acknowledge_failure(ak)` (`S:134-140`: `N+1 → N`) y **return**
   `[null, null, trim_exc(error.response?.data?.message || String(error))]` = `[null, null, 'invalid nonce']`.
   (El SDK Python hace `"invalid nonce" in str(e)` sobre la excepción entera, `signer_client.py:244`,
   que sí contiene el cuerpo; el JS compara con `error.message`. Es un bug del port.)
7. De vuelta en `signedWrite` (`L:479-481`): `fn(client)` **resuelve** con la tupla; no hay excepción, el
   `catch` de `L:481` no se ejecuta y `hard_refresh_nonce` (`L:487`) no se llama nunca.
8. `L:1166` `unwrap(result)` (`L:493-499`): `error = 'invalid nonce'` → `throw toExchangeError('invalid nonce', LIGHTER)`.
9. `errors.ts:128-135` `classify('invalid nonce')`: `isThrottled` no (sin estado); AUTH
   `/unauthor|invalid.?(api|key|signature)|…/` no; INSUFFICIENT no; RULES no (`invalid price|invalid
   size|invalid order` no casan con «invalid nonce»); RETRYABLE no → **FATAL**
   (`classify-check.out.txt`, fila 21104).
10. `withWriteRetry` (`rate-limit.ts:103-116`): `isRetryable(e)` false → `break` → `throw`.
11. `bot-runner.ts` `place()` `:897-960`: FATAL → «TODO LO DEMÁS SE CONTIENE»: `rejectOrder`,
    cuarentena por forma, evento `ERROR`. El bot sigue vivo.
12. **Estado final del contador**: `nonces[ak] = N`, el mismo que el venue acaba de rechazar. La
    siguiente escritura —cualquiera: stop, cancelación, cierre— vuelve a firmar con `N` y repite 5–11.
    No hay ningún camino que lea `/nextNonce` otra vez (`hard_refresh_nonce` solo se invoca desde el
    `catch` muerto de `L:487` y desde el `if` inalcanzable de `S:745-748`).

**Cómo se llega a un nonce inválido en operación normal** (criterio 1 de la escala):

- Un `sendTx` que **entra** en el venue pero cuya respuesta se pierde (timeout, `ECONNRESET`): el
  `catch` de `S:751-752` decrementa el contador («acknowledge_failure») aunque el venue lo haya
  consumido. Desde ese instante el local va uno por detrás. `withWriteRetry` clasifica el timeout como
  RETRYABLE, `findPlaced` confirma o reenvía, y el reenvío —o la siguiente escritura— es un 21104.
- `cancel_order` va por `call` = `withRetry` de 4 intentos (`L:1235`): el mismo timeout se reenvía
  hasta cuatro veces con el contador ya desalineado.
- `initialize()` fallido en silencio (LT-9): se firma con nonce 0.
- Otra sesión con la **misma** clave (índice) enviando transacciones.

**Test unitario propuesto** (`packages/exchange-core/src/lighter-signer.spec.ts`, Jest, junto al
`ServidorRest` de `lighter-transport.spec.ts:38-71` para servir `/api/v1/orderBookDetails` y
`/api/v1/accountActiveOrders`; solo se sustituye `SignerClient`):

```ts
jest.mock('zklighter-sdk', () => {
  const actual = jest.requireActual('zklighter-sdk');
  const R = actual.SignerClient; // para copiar las constantes estáticas
  class FakeSigner {
    static ORDER_TYPE_LIMIT = R.ORDER_TYPE_LIMIT; static ORDER_TYPE_MARKET = R.ORDER_TYPE_MARKET;
    static ORDER_TYPE_STOP_LOSS = R.ORDER_TYPE_STOP_LOSS; static ORDER_TYPE_STOP_LOSS_LIMIT = R.ORDER_TYPE_STOP_LOSS_LIMIT;
    static ORDER_TYPE_TAKE_PROFIT_LIMIT = R.ORDER_TYPE_TAKE_PROFIT_LIMIT;
    static ORDER_TIME_IN_FORCE_GOOD_TILL_TIME = 1; static ORDER_TIME_IN_FORCE_POST_ONLY = 2;
    static NIL_TRIGGER_PRICE = 0; static DEFAULT_28_DAY_ORDER_EXPIRY = -1; static DEFAULT_IOC_EXPIRY = 0;
    static CANCEL_ALL_TIF_IMMEDIATE = 0; static CROSS_MARGIN_MODE = 0; static ISOLATED_MARGIN_MODE = 1;
    static ISOLATED_MARGIN_REMOVE_COLLATERAL = 0; static ISOLATED_MARGIN_ADD_COLLATERAL = 1;
    nonce_manager = {
      initialize: jest.fn().mockResolvedValue(undefined),
      hard_refresh_nonce: jest.fn().mockResolvedValue(undefined),
    };
    // Lo que devuelve el SDK 1.3.0 de verdad ante un 400 «invalid nonce»: una TUPLA, no una excepción.
    create_order = jest.fn()
      .mockResolvedValueOnce([null, null, 'invalid nonce'])
      .mockResolvedValueOnce([{}, { code: 200 }, null]);
    create_market_order = jest.fn().mockResolvedValue([{}, { code: 200 }, null]);
    check_client = () => null;
    create_auth_token_with_expiry = () => ['token', null];
    close = async () => undefined;
  }
  return { ...actual, SignerClient: FakeSigner };
});

it('F-01: un «invalid nonce» devuelto en la tupla relee el nonce y reintenta UNA vez', async () => {
  const ack = await adapter.placeOrder({
    symbol: 'BTC', side: 'BUY', type: 'LIMIT', price: '77000', qty: '0.001', clientOrderId: 'a1b2c3d4.1.B0',
  });
  const signer = (adapter as any).signingClient;
  expect(signer.nonce_manager.hard_refresh_nonce).toHaveBeenCalledTimes(1);
  expect(signer.create_order).toHaveBeenCalledTimes(2);
  expect(ack.status).toBe('PENDING');
});
```

Hoy este test **falla** en la primera aserción: `placeOrder` rechaza con `ExchangeError{kind:'FATAL',
message:'invalid nonce'}`, `hard_refresh_nonce` se llama 0 veces y `create_order` 1. **F-01 CONFIRMO**
(mecanismo por lectura del SDK; falta ejecutar el test, que esta fase no puede hacer).

### 3.2 F-05 — `Trade.type`

`reference_trades.md:263-272` (`type` enum `trade|liquidation|deleverage|market-settlement`, además
en el filtro de la petición `:149-163`) y `A:1263,1302-1308` (`TradeTypeEnum`). `L:752-757` dice lo
contrario y `getRecentFills` no lo lee. **CONFIRMO con DOC + SDK** → Alta se sostiene. Test:
`getRecentFills` con un `Trade{type:'liquidation'}` esperando `liquidation: true`; y decidir
`deleverage` (ADL: también cierra sin orden nuestra) y `market-settlement`.

### 3.3 `scaled()` y los caminos sin `px()`

`scaled(value, decimals) = floor(value × 10^decimals)` (`L:1949-1951`, `ROUND_DOWN`, con test
`exchange-core.spec.ts:303-306`). Para una VENTA, truncar el precio lo mueve **a favor del
comprador** (un tick más barato) — el sentido inseguro. Pero no ocurre: `px()` (`common.ts:379-380`)
ya aplica `roundPriceForSide` (SELL → `ROUND_UP` al tick, `precision.ts:20-23`) y `toFixed(priceDecimals)`,
así que el valor que llega a `scaled` es un múltiplo exacto de `10^-priceDecimals` y `× 10^decimals`
es entero. Los emisores: `stop-loss.ts:52`, `tdca.ts:322`, `market-maker.ts:836`,
`market-maker-v2.ts:1184`, `common.ts:329` (escaleras) y los TP de cada estrategia (línea A los
audita). Sin `px()`: `bot-runner.ts:2031` (`price: mark`, cierre a mercado), donde `mark` es
`mark_price`/`index_price` del venue —que llegan con los decimales del mercado— o `(bid+ask)/2`, que
puede traer medio tick; el truncado quita como mucho ese medio tick al **tope** de una MARKET. Sin
efecto práctico. **OK**.

### 3.4 `client_order_index`: colisiones y duplicados

- Espacio: 48 bits (`T:41`, `GO:209`); el codec toma `sha256(coid)[0..6)` (`coid.ts:46`).
  Probabilidad de que dos ids canónicos distintos compartan índice (cumpleaños): `n²/2^49` —
  1,8·10⁻⁹ con 1 000 órdenes vivas, 1,8·10⁻⁷ con 10 000. Índice 0 (= «sin índice», `GO:205`) con
  probabilidad 2⁻⁴⁸. Despreciable.
- Duplicado real (mismo coid reenviado): el venue responde **21728 «client order index already
  exists»** (`docs_data-structures…`, `AppErrClientOrderIndexExists`) al nivel de API → el nonce no
  se consume (`T:29`) y el SDK lo restaura bien (`S:751-752`). `classify` → FATAL. Consecuencias:
  (a) en `place()` queda contenido (cuarentena por forma); (b) en el reenvío de `withWriteRetry` tras
  un acuse perdido que `findPlaced` no supo confirmar, FATAL rompe el bucle y `rejectOrder` marca
  **REJECTED una orden viva** — el caso que describe el propio comentario de `rate-limit.ts:84-88`.
- **Alcance de la unicidad — por confirmar**: la doc solo dice «unique (across all markets)» (`GS:74`).
  Si el venue la comprueba contra el histórico y no solo contra las activas, toda estrategia con
  `reusesOrderSlots` (market makers, retículas que reciclan nivel) recibiría 21728 al recolocar un
  coid ya ejecutado. No se puede sondear sin firmar. Es la pregunta abierta más cara de este venue.

### 3.5 `create_market_order` y el significado de `avg_execution_price`

`S:801-803`: `create_market_order(market, coi, base, avg_execution_price, is_ask, reduce_only)` =
`create_order(…, price = avg_execution_price, ORDER_TYPE_MARKET, IOC, reduce_only, NIL_TRIGGER_PRICE,
DEFAULT_IOC_EXPIRY)`. La doc: «when specifying a price for a taker order, that is to be interpreted as
the worst price you're willing to accept - if the sequencer cannot offer you an equal or better price,
the order is cancelled» (`T:37`); y «Orders that have the correct syntax will be accepted by the API
servers, returning code=200. This does not guarantee the execution of your order, as the sequencer
could still reject it» (`T:11`). El propio SDK trae `create_market_order_limited_slippage`, que manda
`ideal_price × (1 ± max_slippage)` (`S:804-817`; Python `signer_client.py:900`).

Lo que manda el adaptador (`L:1109-1116`): `price = scaled(req.price)`, y `req.price` es:

| Emisor | `price` | Lado | Efecto con «peor precio aceptable» |
|---|---|---|---|
| `stop-loss.ts:52-67` (stop inyectado, `type:'MARKET'`, `triggerPrice`) | `px(stopLossPrice(entry, pct))` = **precio del stop**, por debajo del mercado en un LONG | SELL reduce-only | La rama MARKET (`L:1097`) **descarta `triggerPrice`** y envía una IOC ahora mismo con tope = stop. El mejor bid está por encima del stop ⇒ **se ejecuta al instante al bid**: la posición se cierra en cuanto se coloca la «protección». Espejo exacto en un SHORT. |
| `tdca.ts:322`, `ADD_SAFETY_NOW` (`bot-runner.ts:1353`, nivel convertido a MARKET) | `px(mark, BUY)` = mark redondeado **hacia abajo** | BUY | El mejor ask suele estar **por encima** del mark (mid ± spread/2): el secuenciador no puede dar «equal or better» ⇒ **cancelada** (`canceled-too-much-slippage`). Con el ask por debajo del mark, entra. Depende del spread y del signo `mark − mid` en cada momento. |
| `market-maker*.ts:836/1184` (aplanado) | `px(mid)` | contrario a la posición | Ídem: sin holgura, mitad de las veces no cruza. |
| `closePositionAtMarket` (`bot-runner.ts:2031`, PANIC, STOP_AND_CLOSE, cierre manual) | `mark` | contrario a la posición | Ídem: un **PANIC** puede quedar cancelado por el secuenciador. |

Y el acuse: `L:1120-1125` devuelve `status: OrderStatus.FILLED` **siempre** que `sendTx` conteste 200,
mientras Aster mapea `ack.status` del venue (`aster.ts:618`) e Hyperliquid lee `statuses[0]`. Con
`confirmOrder` (`bot-store.ts`) la fila pasa a `FILLED` sin ejecución, y `place()` veta después
cualquier reenvío de una inmediata con fila FILLED (`bot-runner.ts:857-861`, «para ellas una fila YA
EJECUTADA veta siempre»): una TDCA cuya primera compra el secuenciador canceló **no vuelve a
intentarlo** y se queda sin posición creyendo que la tiene hasta que llegue un fill que nunca llega.
El sondeo no lo corrige: una IOC cancelada no aparece ni en `accountActiveOrders` ni en `trades`.

**Test propuesto (LT-1)** — mismo `FakeSigner` de 3.1:

```ts
it('LT-1: el stop inyectado (MARKET + triggerPrice) NO sale como orden a mercado inmediata', async () => {
  await adapter.placeOrder({
    symbol: 'BTC', side: 'SELL', type: 'MARKET', price: '76000', triggerPrice: '76000',
    qty: '0.001', clientOrderId: 'a1b2c3d4.1.SL0', reduceOnly: true, intent: 'SL',
  });
  const signer = (adapter as any).signingClient;
  expect(signer.create_market_order).not.toHaveBeenCalled();
  // market_id 1, base 100 (0.001 × 10^5), trigger 760000 (76000 × 10^1), is_ask true, reduce_only true
  expect(signer.create_order).toHaveBeenCalledTimes(1);
  const [market, , base, , isAsk, orderType, , reduceOnly, trigger] = signer.create_order.mock.calls[0];
  expect([market, base, isAsk, reduceOnly, trigger]).toEqual([1, 100, true, true, 760000]);
  expect([FakeSigner.ORDER_TYPE_STOP_LOSS, FakeSigner.ORDER_TYPE_STOP_LOSS_LIMIT]).toContain(orderType);
});
```

Hoy falla en `not.toHaveBeenCalled()`: `create_market_order` recibe `(1, idx, 100, 760000, true, true)`.

**Test propuesto (LT-3)**:

```ts
it('LT-3: un 200 de sendTx en una MARKET no se convierte en FILLED por decreto', async () => {
  const ack = await adapter.placeOrder({ symbol: 'BTC', side: 'BUY', type: 'MARKET', price: '77000', qty: '0.001', clientOrderId: 'a1b2c3d4.1.B0' });
  expect(ack.status).not.toBe('FILLED'); // PENDING hasta que `trades` lo confirme
});
```

Hoy falla: devuelve `FILLED`. Qué hacer con la holgura (¿un `slippagePct` en `PlaceOrderRequest`, el
5 % de Hyperliquid, `create_market_order_limited_slippage`?) es decisión del usuario (principio 6 de
la constitución): cambia la conducta de bots en marcha.

### 3.6 `DEFAULT_28_DAY_ORDER_EXPIRY = -1` y `DEFAULT_IOC_EXPIRY = 0`

- `0` es `NilOrderExpiry` (`GO:225`): obligatorio para `MarketOrder` y para `LimitOrder` IOC
  (`CO:113-120,124-125`). `create_market_order` lo pasa (`S:802`) ✓.
- `−1` es el centinela «28 días» que el firmante nativo expande (mismo valor en Python,
  `signer_client.py:288`, y en el ejemplo oficial `GS:112`); para GTT, POST_ONLY y SL/TP-limit la
  validación exige expiry ≠ 0 (`CO:126-127,144-145`) ✓, y 28 d < 30 d máximo (`T:70`, `GO:230`) ✓.
- Consecuencia operativa: **toda orden en reposo caduca a los 28 días** (`canceled-expired`). El sondeo
  la verá desaparecer, emitirá CANCELED (`L:1480-1489`) y el reconciliador la repondrá con el mismo
  coid (ver 3.4, alcance de la unicidad). Un bot de retícula de más de cuatro semanas pasa por ahí en
  todos sus niveles el mismo día.

### 3.7 Caudal: 60/min frente a `limiter` + `budget`

- `limiter` = 8/s (`L:395`, `VENUE_RATE_LIMIT_PER_SECOND`, `credentials.service.ts:95,134`) = 480/min:
  **ocho veces** el cupo Standard. `pollLimiter` = 4/s. Ninguno protege por sí solo; quien acota es
  `budget` (0,85/s, depósito 1,7; `venue-budget.ts:84-86,118-130`). Con `NO_BUDGET` (API y tests,
  `L:396`) solo queda el `limiter`.
- `lighterCost` (`venue-weights.ts:117-119`): `max(1, round(peso/300))` ⇒ `trades` 2, resto 1 ✓ con la
  regla de `RL:35` (los Standard no ponderan salvo que `24000/peso < 60`, y `24000/600 = 40 < 60`:
  `trades` **sí** está limitado a 40/min incluso para Standard — `lighterCost` = 2 sobre 51 lo deja en
  25/min, dentro).
- Sin cuenta: `nextNonce` (2 al arrancar + 1 por `hard_refresh`, todos fuera de `budget`/`limiter`/`cooldown`,
  `S:157`, `L:451,487`), `CheckClient` nativo. `sendTx`: contado como 1 escritura en `placeOrder`/`adjustIsolatedMargin`;
  como 1 **lectura** en cancelaciones y leverage (F-10).
- `getOpenOrders()` sin símbolo: 216 (mainnet) / 176 (testnet) peticiones firmadas de golpe (sonda),
  ≈ 4 minutos del depósito de toda la IP. Latente: ningún llamante omite el símbolo (C-6). Y sobra: el
  venue devuelve todos los mercados con un solo `accountActiveOrders` sin `market_id`
  (`reference_accountactiveorders.md:51`).

### 3.8 Token de autenticación: 8 min frente a la doc, y adónde llega

- Vida: SDK 10 min (`S:719-721`), máximo oficial 8 h (`docs_api-keys.md:21`, `GS:142`), caché 8 min
  (`L:213`). ✓. Firmar es local (`CreateAuthToken` nativo): no cuesta cupo.
- **Propagación** (`L:983-1018`): `authHeaderToken()` solo corre dentro de `restHeaders()`, y
  `restHeaders()` solo lo llama `publicGet` (`L:1025`, velas). Es la única línea que escribe
  `sdkHeaders.authorization` (`L:1011`). Por tanto:
  - En un adaptador de bot del worker (que nunca pide velas), `account`, `orderBookDetails` y
    `orderBookOrders` salen **sin** `authorization` durante toda su vida → cuentan contra el cupo de
    **IP** («To bypass IP-based rate limits, clients can authenticate each request so that only
    L1-based rate limits apply», `RL:15`), compartido por todos los bots y por el cron de precios.
    `account` es una por tick y por bot (memo de 800 ms): cinco bots a 5 s = 60/min de IP solo en
    `account`.
  - `accountActiveOrders` y `trades` sí llevan token, pero como **query `auth`** (`api.js:2583-2585`),
    mientras la doc marca la cabecera `authorization` como `required: true`
    (`reference_accountactiveorders.md:30-37`). El SDK dice que `auth` sigue admitido «to support
    header auth clients»; funciona hoy (el autor lo probó en testnet), sin garantía.
  - En el adaptador de datos de mercado (que sí pide velas), `sdkHeaders.authorization` se renueva
    solo cuando llega otra petición de velas pasados 8 min: entre el minuto 10 y esa petición el SDK
    manda un token **caducado** en `orderBookDetails`. Qué hace el venue con un token caducado en un
    endpoint público está por confirmar (posible 401 → `expired.?token` → AUTH).
- **LT-5**.

### 3.9 Límites del WebSocket

`RL:43-50`: 255 conexiones/IP, 500 suscripciones/conexión, 255 conexiones nuevas/min, **200 mensajes
del cliente/min**, 50 en vuelo. El adaptador: 1 conexión; canales = 1 (`market_stats/all`) + 1 por
símbolo con ticker + 1 por (símbolo, resolución) con velas; ping 1/min. Un adaptador de bot usa 2–3.
El de datos de mercado (uno por venue para todos los gráficos, `market-data.service.ts:347`) puede
pasar de 200 canales con muchos gráficos abiertos; en cada reconexión `onOpen` (`L:1648-1652`) los
reenvía **todos en el mismo instante** → 30009 «Too Many Websocket Messages!» → desconexión → bucle.
Nada cuenta canales ni espacia el reenvío. **LT-14 (por confirmar el umbral real de cierre)**.

### 3.10 Clasificación de errores y los umbrales de 21734/21735

Tabla completa en C-5. Sobre los dos umbrales: no están en ninguna fuente local. 21734 acota la
distancia de una **limit** al mark; una retícula ancha (Grid Classic con `lowerPrice`/`upperPrice`
lejos del precio) pondría sus niveles extremos en ese rechazo, que hoy se registra como FATAL y
entra en cuarentena por forma (sin churn, pero con la retícula recortada en silencio y un `ERROR`
por nivel). 21735 acota `price` frente a `trigger_price` en SL/TP-limit: el adaptador manda
`price == trigger` (distancia cero), que nunca lo dispara; el problema de esa elección es otro (en un
hueco de precio el limit no se ejecuta), y hoy ni siquiera se llega a esa rama (LT-1).

### 3.11 `findPlaced` reenviando una MARKET

`L:1204`: `getRecentFills(symbol, now − 120 s).catch(() => [])`. Si `trades` falla (cupo, WAF, red),
`filled` es `undefined`, `findPlaced` devuelve `null`, y `withWriteRetry` (`rate-limit.ts:110-113`)
**reenvía** la MARKET con el mismo `client_order_index`. Si la primera entró y se ejecutó, la segunda
o bien es rechazada con 21728 (si el venue recuerda los índices ejecutados) o bien **dobla la
posición**. Además, tras un timeout el nonce local va uno por detrás (3.1) y el reenvío es un 21104.
**F-16 CONFIRMO** en su punto grave. Arreglo: propagar el fallo de `getRecentFills` como «no sé»
(no reenviar) en vez de «no llegó».

### 3.12 `koffi`, campos privados y números a mano

- `koffi`: carga perezosa (`S:45-50`) de la librería nativa por plataforma; el adaptador difiere la
  construcción del `SignerClient` al primer uso (`L:412-425`) ✓. `CreateClient` recibe la URL
  (`S:532`) y `CheckClient` (`verify`) puede hacer red desde Go, fuera de `limiter`, `budget`,
  `cooldown` y cabeceras. `SignerClient.close()` es un **no-op** (`S:1071-1073`); el comentario de
  `L:405-410` («abre recursos que luego hay que cerrar») no describe la 1.3.0. Inocuo.
- Campos privados: `L:448-451` y `L:483-487` acceden a `nonce_manager`, declarado `private` en
  `signer.d.ts:123`, mediante `as unknown as {…}`. Frágil ante cualquier subida del SDK; y el segundo
  acceso es código muerto (3.1). `check_client` y `create_auth_token_with_expiry` son públicos ✓.
- Números a mano (sin cita en el código salvo donde se indica): `L:74` umbral 1e12 s/ms; `L:190` ping
  60 s (doc: 2 min ✓); `L:199` 60 s de frescura; `L:206` 3 s; `L:213` 8 min (doc: 10 ✓); `L:224` 12 s
  de sondeo; `L:232` 20 s; `L:235` 30 s; `L:395` 8/s y `L:400` 4/s (8× el cupo); `L:607` 800 ms de memo;
  `L:727` 100 (máximo oficial ✓); `L:1204` 120 s de ventana de `findPlaced`; `L:1503` 60 s de mirada
  atrás en el primer sondeo; `L:1954` 6 decimales USDC (`GO:145` ✓); `L:1990` 20× por defecto y
  `L:1991` tope [1, 100]; `market-cache.ts:18` 5 min; `capabilities.ts:118-121` 500 (doc ✓), 3
  páginas, 1 500 ms.

## 4. Hallazgos

Severidad según `specs/README.md`. «Crítica (por confirmar)» = cumple (1) y (2) y el mecanismo está
confirmado leyendo SDK y doc, pero el test que falla aún no se ha **ejecutado** (esta fase no puede).

| Id | Título | Severidad | Evidencia (fichero:línea) | Cita oficial | Impacto | Test propuesto |
|---|---|---|---|---|---|---|
| **LT-1** | El stop-loss inyectado (`type:'MARKET'` + `triggerPrice`) sale en Lighter como una orden a mercado **inmediata** al precio del stop: `placeOrder` mira `req.type` antes que `req.triggerPrice` y `create_market_order` no lleva disparador | **Crítica (por confirmar)** | `lighter.ts:1097-1130` (rama MARKET primero; `create_market_order` sin trigger), `:1139-1143` (la rama con trigger queda detrás); `stop-loss.ts:63-67`; `bot-runner.ts:876-891` (pasa `type`/`triggerPrice` tal cual); contraste `hyperliquid.ts:557-560`, `aster.ts:1045-1050`; `signer.js:801-803` (`NIL_TRIGGER_PRICE`, IOC) | «when specifying a price for a taker order, that is to be interpreted as the worst price you're willing to accept - if the sequencer cannot offer you an equal or better price, the order is cancelled» (`docs/trading`, 2026-08-25); `MarketOrder` exige `TriggerPrice == Nil` (`l2_create_order.go:113-120`) | En un LONG el stop es una venta reduce-only con tope por **debajo** del bid ⇒ se ejecuta al instante al bid: la posición se cierra nada más colocarse la «protección», el fill llega con el coid del stop y el ciclo termina como «stop tocado»; con `cooldownMinutes` y ciclo nuevo, vuelve a entrar y a salir. Cumple (1) —cualquier bot de Lighter con `stopLossPct`— y (2) —stop con precio/semántica errónea— de la escala | §3.5, «LT-1»: con `FakeSigner`, `placeOrder({type:'MARKET', triggerPrice, reduceOnly, intent:'SL'})` debe llamar a `create_order` con `ORDER_TYPE_STOP_LOSS`/`_LIMIT` y trigger, y **no** a `create_market_order`. Hoy falla |
| **LT-2** (= F-01) | La recuperación de «invalid nonce» es código muerto y un timeout tras un `sendTx` que entró deja el contador desalineado **para siempre** | **Crítica (por confirmar)** | `lighter.ts:477-490` (captura excepción), `:493-499` (`unwrap` fuera), `:1119,1166,1233,1261,1275,1300,1349`; `signer.js:743-757` (compara `error.message`, no `response.data.message`; `acknowledge_failure` en el `else`), `:134-140`; Python `signer_client.py:244` hace `"invalid nonce" in str(e)` | «If the transaction throws an error at the API server level, nonce will not increase» (`docs/trading`); `AppErrInvalidNonce 21104 "invalid nonce"` (`docs/data-structures…`); «we require new_nonce = old_nonce + 1» (`docs/api-keys`) | Tras el primer 21104 ninguna escritura vuelve a entrar: ni stop, ni cancelación, ni cierre, ni PANIC. Detonantes en operación normal: timeout/`ECONNRESET` tras un `sendTx` aceptado (el SDK decrementa), `cancel_order` reintentado por `withRetry`, `initialize()` fallido (LT-9) | §3.1: `create_order` resuelve `[null,null,'invalid nonce']` ⇒ se espera `hard_refresh_nonce` ×1 y `create_order` ×2. Hoy falla |
| **LT-3** | Las órdenes a mercado se mandan con `price = px(mark)` como **peor precio** sin holgura, y el acuse devuelve `FILLED` sin que el venue lo haya dicho | **Alta** | `lighter.ts:1094,1109-1116,1120-1125`; emisores `tdca.ts:322`, `market-maker.ts:836`, `market-maker-v2.ts:1184`, `bot-runner.ts:1353,2031`; `bot-store.ts` `confirmOrder`; `bot-runner.ts:857-861` (fila FILLED veta el reenvío de una inmediata); contraste `hyperliquid.ts:555` (5 %), `signer.js:804-817` (`create_market_order_limited_slippage`) | `docs/trading` §«Handle price and size» (peor precio aceptable) y «Orders that have the correct syntax will be accepted by the API servers, returning code=200. This does not guarantee the execution of your order» (§«Signing Transactions») | Una compra con tope = mark no cruza si el ask está por encima del mark: el secuenciador la cancela y la BD la marca FILLED. TDCA/Martingale/GridMart no vuelven a intentar su entrada (fila FILLED); `ADD_SAFETY_NOW`, el aplanado del market maker y **PANIC/STOP_AND_CLOSE** (`closePositionAtMarket`) pueden no ejecutar y el bot cree que sí | §3.5 «LT-3»: `ack.status !== 'FILLED'` tras un 200. Hoy falla. La holgura es decisión del usuario |
| **LT-4** | Un 429/405 en una escritura se pierde: la tupla del SDK solo trae `message`, «Too Many Requests!» cae en RETRYABLE y `withWriteRetry` reintenta tres veces sin enfriamiento | **Alta** | `signer.js:751-755`; `lighter.ts:493-499,1104-1129,1145-1181` (sin `cooldown.registrar` en el camino `signedWrite`→`limiter.run`); `errors.ts:50,131,164-167`; `rate-limit.ts:108-113`; `classify-check.out.txt` (23000 → RETRYABLE) | «If you exceed any rate limit: You will receive HTTP 429, or HTTP 405 … To avoid this, please ensure your clients are implementing proper backoff and retry strategies»; «Firewall: 60 seconds, static» (`docs/rate-limits`, 2026-08-30) | Insistir es lo que escala el corte (WAF 60 s para toda la IP); el resto de bots de la IP lo pagan. La escala marca «errores THROTTLED tragados» como Alta | `create_order` resuelve `[null,null,'Too Many Requests!']` ⇒ se espera `ExchangeError.kind === 'THROTTLED'`, `create_order` ×1 y `cooldown.restanteMs() > 0`. Hoy: RETRYABLE, ×3 |
| **LT-5** | El token de autenticación solo llega a las llamadas del SDK después de un `publicGet` (velas): los adaptadores de bot mandan `account`/`orderBookDetails`/`orderBookOrders` sin firmar, `accountActiveOrders`/`trades` van con `auth` en la query aunque la doc exige la cabecera, y `sdkHeaders` puede quedarse con un token caducado | **Alta (por confirmar)** | `lighter.ts:983-988` (`restHeaders` único llamador de `authHeaderToken`), `:1025` (`publicGet` único llamador de `restHeaders`), `:1011` (única escritura de `sdkHeaders.authorization`), `:352,389-392`, `:695-700,725-734` (4.º argumento = `auth`); `api.js:2583-2588`; `api.d.ts:2871,2958` | «To bypass IP-based rate limits, clients can authenticate each request so that only L1-based rate limits apply» (`docs/rate-limits`); `authorization` header `required: true` (`reference/accountActiveOrders`); «auth is required for master accounts and sub accounts» (`reference/trades`) | Las lecturas de cuenta de todos los bots consumen el cupo de **IP** (60/min) que el presupuesto cree estar repartiendo por cuenta: riesgo de WAF por IP («riesgo de baneo por IP» = Alta). Si el venue deja de aceptar `auth` en la query, ningún bot ve sus órdenes ni sus fills | Con `ServidorRest`: tras `getBalances()` en un adaptador con credenciales, `ultimasCabeceras.authorization` debe estar definida. Hoy falla (undefined). Y `accountActiveOrders` debe recibir la cabecera, no `?auth=` |
| **LT-6** | Lighter Standard limita a **30 órdenes activas y 10 pendientes por mercado** (250/50 por cuenta); ni el adaptador ni las estrategias lo modelan y los rechazos 21717-21720 se clasifican FATAL | **Alta** | `errors.ts:23-52` (sin patrón); `classify-check.out.txt`; `lighter.ts` (sin límite en `MarketSpec`); `grid-classic.ts:52-121` (hasta 200 niveles, F-23); `venue-weights.ts` (no hay cupo de órdenes) | «Active Orders — Standard: Per Account 250, Per Market 30»; «Pending Orders … take-profit, stop-loss … Standard: 50 / 10» (`docs/rate-limits`, 2026-08-30) | Una retícula de más de 30 niveles nunca se completa en Lighter: los niveles 31+ se rechazan, entran en cuarentena por forma y el usuario opera con una escalera recortada sin saberlo (un `ERROR` por nivel). Con varias estrategias en la misma cuenta, el tope de 250 se reparte sin control | `classify('maximum active limit order count per market reached') === 'RULES'`; y un test de `validate()`/`MarketSpec` que acote niveles por venue (línea A) |
| **LT-7** | La regex de `safely()` no reconoce el vocabulario de Lighter para «esa orden ya no existe»: cada carrera lectura→cancelación produce `ACTION_FAILED` WARN y, en `toReplace`, salta la colocación del reemplazo ese tick | **Media** | `bot-runner.ts:2081-2091` (`/not found|unknown order|does not exist/i`), `:753-762`; `lighter.ts:1233-1237` (la tupla llega como FATAL); `classify-check.out.txt` (21600, 21715, 21709, 21708 → FATAL sin patrón) | `21600 "given order is not an active limit order"`, `21715 "given order is not an active order"`, `21709 "order is inactive"`, `21708 "order is empty"` (`docs/data-structures…`) | Ruido de WARN en Telegram/bitácora y un tick de retraso en cada reemplazo que coincide con una ejecución; en el reemplazo del stop, un tick sin stop | `safely('cancelar', …, () => { throw new ExchangeError('FATAL', 'given order is not an active order') })` no debe emitir evento |
| **LT-8** | Clasificación de errores de Lighter: 21728 (duplicado = «ya está») → FATAL; 21507/21508 → FATAL en vez de INSUFFICIENT_FUNDS; 21734/21735/21733 → FATAL en vez de RULES; 21601 → FATAL en vez de RETRYABLE; 21108/21109 (clave revocada o no registrada) → FATAL en vez de AUTH; 21132 → FATAL | **Media** | `errors.ts:23-52`; `classify-check.out.txt` íntegro (C-5); `rate-limit.ts:84-88` (describe el efecto del 21728 en el reenvío) | Mensajes literales en `docs/data-structures-constants-and-errors` (2026-03-09): `AppErrClientOrderIndexExists`, `AppErrAccountBelowMaintenanceMargin`, `AppErrPriceTooFarFromMarkPrice`, `AppErrPriceTooFarFromTrigger`, `AppErrFatFingerPrice`, `AppErrOrderBookFull`, `AppErrInvalidPublicKey`, `AppErrApiKeyNotFound` | Los eventos salen con el nivel equivocado (ERROR en vez de WARN o INSUFFICIENT_FUNDS); una clave revocada no dispara el camino AUTH→detach de B-6; un duplicado tras acuse perdido marca REJECTED una orden viva | Ampliar `errors.spec.ts:23-40` con las ocho parejas mensaje→clase |
| **LT-9** | El `.catch` de `signerReady` es inalcanzable: `OptimisticNonceManager.initialize()` traga el fallo de `nextNonce` y resuelve con el contador a 0; además el constructor ya lanza su propio `initialize()` (dos `nextNonce` por adaptador, fuera del presupuesto) | **Media** | `lighter.ts:446-459` (`.catch(() => { this.nonceReady = null })`); `signer.js:109-121` (`try/catch` con `console.warn`), `:153-160` (`initialize().catch(console.error)`) | «The SDK handles nonce management automatically» (`docs/get-started`); `GET /nextNonce` (`reference/nextNonce`) | Con `nextNonce` cortado (WAF, red) la primera escritura sale con nonce 0 → 21104 → LT-2. La «segunda oportunidad» prometida en `:452-456` no existe | `nonce_manager.initialize` que **resuelva** dejando `nonces = 0` ⇒ `signerReady` debe detectarlo (nonce 0 tras `initialize` = no cargado) y no firmar |
| **LT-10** (= F-16) | `findPlaced` trata un fallo de `getRecentFills` como «no llegó» y `withWriteRetry` **reenvía** la MARKET; `timeInForce` de la petición se ignora; una MARKET sin `price` sería rechazada por el firmante (`price ≥ 1`) | **Media** (el reenvío, Alta si se combina con LT-3) | `lighter.ts:1204` (`.catch(() => [])`), `:1127,1179`; `rate-limit.ts:110-113`; `:1132-1135` (tif solo por tipo), `:1094` (`req.price ?? '0'`) | `MinOrderPrice = 1` (`constants.go:219`); `ImmediateOrCancel/GoodTillTime/PostOnly` (`docs/trading` §«Time in force») | Posición doblada si la primera entró (o 21728); una petición IOC sale GTT | `getRecentFills` que rechace ⇒ `findPlaced` debe **propagar** (no reenviar). Hoy reenvía |
| **LT-11** | No hay stream de cuenta: fills y órdenes se sondean cada 12 s por símbolo (`trades` 600 + `accountActiveOrders`), lo que fija la capacidad real en ≈ 1 bot por IP y red con cuenta Standard y da hasta 12 s de retraso a cada fill | **Media** | `lighter.ts:224,333-339,1370-1421,1430-1458`; `venue-budget.ts:84-86,108` (0,85/s, depósito 1,7); aritmética en C-6 | `account_all/{ACCOUNT_ID}` (con `positions`, `trades`, `funding_histories`), `account_all_orders/{id}`, `account_all_trades/{id}` (`docs/websocket-reference`, 2026-08-11); «Standard accounts: 60 requests per rolling minute» | Un segundo bot en la misma IP ya espera en el presupuesto; el ledger va con retraso; el funding no se contabiliza | (spec de seguimiento: implementar `account_all_*` y apagar el sondeo cuando entregue, como ya prevé `shouldPoll`) |
| **LT-12** (= F-10) | Cancelaciones, `cancelAll` y `setLeverage` piden presupuesto con prioridad `read` y pasan por `withRetry` ×4; `nextNonce` y `CheckClient` no se cuentan; `fetchOpenOrders` sin símbolo hace 216 llamadas firmadas para lo que el venue da en una (latente: nadie lo llama así) | **Media** | `lighter.ts:1235,1263,1277,1302` (`this.call`), `:506-520`; `:684-706`; `signer.js:109-121,157,532-546`; llamantes `account-hub.service.ts:696-697`, `bot-runner.ts:572` | «Standard accounts: 60 requests per rolling minute»; `market_id`: «If not specified, returns active orders for all markets» (`reference/accountActiveOrders`) | Un PANIC compite por el cupo con las lecturas (la reserva del 20 % no le sirve); un `cancel_order` reintentado tras timeout desalinea el nonce (LT-2). El caso de 216 peticiones no ocurre hoy pero está a una llamada de distancia | `cancelOrder` debe llamar a `budget.take(…, 'write')`; `fetchOpenOrders(undefined)` debe hacer **una** petición sin `market_id` |
| **LT-13** | Mapeos de `VenueOrder`/`Position` que se apartan de la API: `venueOrderId` del acuse es el índice de cliente; `status` ignora `Order.status` (17 valores) y `type` colapsa `stop-loss-limit`/`take-profit-limit` a `LIMIT`; `createdAt = Date.now()`; `Position.markPrice` es `last_trade_price` del catálogo (≤ 5 min); `leverage` se deriva de `initial_margin_fraction` cuyo ejemplo oficial es `"20.00"`; `order_index`/`trade_id` se leen como `number` habiendo `*_str` | **Media (por confirmar)** | `lighter.ts:1122,1174,1902-1922,653,659,661,1994-1998`; `api.d.ts:453-516`; `reference_account-1.md:176-179`; `reference_trades.md:396-415`; `constants.go:211-212` (`order_index` hasta 2^60−1) | `Order.status` enum; `Order.order_id: string`; `AccountPosition.initial_margin_fraction` example `"20.00"` (`reference/account`) | Una condicional `pending` se anuncia OPEN y como LIMIT (gemelo de F-29); `Position.leverage` puede salir ×100 si la unidad es porcentaje; un `order_index` > 2^53 perdería precisión en JSON | Test de `toVenueOrder` con `status:'pending', type:'stop-loss-limit'`; sonda firmada (fuera de este spec) para la unidad de `initial_margin_fraction` |
| **LT-14** | En cada reconexión `onOpen` reenvía todos los canales de golpe; con más de ~200 canales (adaptador de datos de mercado con muchos gráficos) supera «200 mensajes por minuto» y entra en bucle 30009 → desconexión → reconexión | **Media (por confirmar)** | `lighter.ts:1648-1652,1706-1767`; `market-data.service.ts:347` | «Max Messages Sent By Client Per Minute: 200 … Max Inflight Messages: 50»; `30009 "Too Many Websocket Messages!"` (`docs/rate-limits`, `docs/data-structures…`) | Gráficos sin datos en vivo para todos los usuarios mientras dure el bucle; no afecta a los bots (2–3 canales) | Test con `WebSocketServer` local: 250 canales suscritos y un `terminate()` ⇒ el reenvío debe espaciarse por debajo de 200/min |
| **LT-15** | Menores: (a) el corte de los **servidores de API** (750 ms documentados) recibe el enfriamiento del cortafuegos (60 s); (b) `ReconnectingSocket` no consulta `cooldown` aunque «When you're rate-limited on REST, WebSocket connections also get rate-limited»; (c) `CheckClient` nativo fuera de todo control; (d) `SignerClient.close()` es un no-op y el comentario `L:405-410` dice lo contrario; (e) `creds.baseUrl` heredado no se valida contra `VENUE_ENDPOINTS` antes de decidir el `chain_id`; (f) toda orden en reposo caduca a los 28 días y se repone con el mismo coid; (g) el comentario `L:752-757` («no trae ningún campo») es falso; (h) `L:1132-1135` no lee `req.timeInForce` | **Baja** | `cooldown.ts:99-100`; `ws.ts:186-198`; `signer.js:537-546,1071-1073`; `lighter.ts:384,405-410,752-757,1162`; `endpoints.ts:54-59` | «Api servers: weightOfEndpoint/(totalWeight/60)» y «Firewall: 60 seconds, static» (`docs/rate-limits`); `DEFAULT_28_DAY_ORDER_EXPIRY` (`docs/get-started`) | Sin pérdida: esperas de más, comentarios que engañan, y un cambio de retícula a los 28 días | Lote de limpieza |

### Semillas de `findings.md`

| Semilla | Veredicto | Dónde |
|---|---|---|
| **F-01** | **CONFIRMO** (SDK + DOC; test escrito, sin ejecutar) | LT-2, §3.1 |
| **F-05** | **CONFIRMO** (DOC `reference/trades` + SDK `api.d.ts`) | §3.2, C-8 |
| **F-10** | **CONFIRMO** en cancelaciones/leverage por `read` y `SignerClient` fuera del limitador (`nextNonce`, `CheckClient`); **REFUTO como riesgo activo** el `getOpenOrders()` sin símbolo (ningún llamante lo hace) y añado que es redundante: el venue lo da en una llamada | LT-12, C-6 |
| **F-16** | **CONFIRMO** (reenvío de MARKET en `findPlaced`; `timeInForce` ignorado; MARKET depende de `price`). Y se agrava: el `price` de la MARKET es un tope sin holgura y el acuse FILLED es inventado | LT-10, LT-3, §3.5, §3.11 |
| **F-21** | **CONFIRMO**: no existe ningún test del cuerpo de `placeOrder` de Lighter ni de `signedWrite`; los cuatro tests de §3 son el principio de esa cobertura | §3.1, §3.5 |

### Preguntas abiertas (necesitan sonda firmada en testnet, fuera de este spec)

1. Alcance de la unicidad de `client_order_index`: ¿solo órdenes activas o también histórico? Decide si
   `reusesOrderSlots` (market makers, retículas que reciclan nivel) funciona en Lighter (§3.4).
2. ¿`accountActiveOrders` devuelve las condicionales `pending` (TP/SL)? Sin ello el reconciliador
   nunca vería un stop condicional (relevante en cuanto se arregle LT-1).
3. ¿Sigue aceptando el venue `auth` en la query (LT-5)? ¿Qué devuelve un endpoint público con un
   token caducado en la cabecera?
4. Umbrales reales de 21734 («too far from the mark price») y 21735 («too far from the trigger»).
5. Unidad de `AccountPosition.initial_margin_fraction` (`"20.00"` en el ejemplo) y si `update_leverage`
   admite fracciones no canónicas (7× ⇒ 1428).
6. ¿Qué hace el secuenciador con una IOC cuyo tope no cruza: `canceled-too-much-slippage` o ejecución
   parcial? (Determina la frecuencia real de LT-3.)

## 5. Verificado OK

- **Hosts y redes**: los cuatro hosts de `endpoints.ts:32-41` coinciden con la doc; la sonda responde en
  los dos REST; `chain_id` 304/300 sale bien de las dos URLs de la tabla (`endpoints.spec.ts:38-41`).
- **Precisión**: tick = 10^-`supported_price_decimals`, step = 10^-`supported_size_decimals`; enteros al
  cable; en los 233 mercados de mainnet y 176 de testnet `supported_* == *_decimals` y `min_base_amount`
  cae en el step; ningún camino manda un precio fuera de retícula ni notación exponencial.
- **Cuerpo de LIMIT y POST_ONLY**: argumentos, enteros de tipo y tif, `reduce_only`, `NIL_TRIGGER_PRICE`
  y `DEFAULT_28_DAY_ORDER_EXPIRY` coinciden con `signer.js`, `constants.go`, `l2_create_order.go` y el
  ejemplo oficial; `DEFAULT_IOC_EXPIRY = 0` en las MARKET.
- **Índice de cliente**: 48 bits en [1, 2^48−1] con paso de ids ya numéricos (`coid.ts:39-48`,
  `exchange-core.spec.ts:57-62,1057`).
- **Cancelaciones**: `cancel_order` por `order_index` resuelto desde `accountActiveOrders`; «ya no está»
  es no-op; `cancel_all_orders(IMMEDIATE, 0)` con las constantes oficiales y alcance de cuenta escrito.
- **Leverage y margen**: `update_leverage(market, mode, leverage)` con `imf = floor(10000/leverage)`;
  `update_margin` con importe legible, direcciones 0/1 y sin reintento; rechazo de leverage contenido en
  `LEVERAGE_SKIPPED`.
- **Posiciones y saldo**: `sign` ±1, `margin_mode` 0/1, `collateral`/`available_balance`.
- **Fills**: comisiones enteras en 1e-6 USDC convertidas con signo (`feeToUsdc`, con tests); lado por
  `ask_account_id`/`bid_account_id`; maker/taker por `is_maker_ask`; `timestamp` en segundos o
  milisegundos normalizado; deduplicación por `trade_id`; `trades` con `sort_by`, `limit ≤ 100`,
  `sort_dir=desc` y peso 600 contado como 2.
- **Velas**: `/api/v1/candles` (la ruta del SDK está muerta: 403/404), cinco parámetros obligatorios,
  timestamps en ms, `count_back ≤ 500`, ceros omitidos tratados, ocho resoluciones exactas.
- **Caudal**: 60 peticiones/min en unidad «peticiones»; tabla de pesos uno a uno con la doc;
  `lighterCost` con suelo 1; 429/405 y página WAF → THROTTLED antes que cualquier patrón; enfriamiento
  local de 60 s = «Firewall: 60 seconds, static»; presupuesto por venue **y red**.
- **WebSocket**: URL `/stream`; `subscribe`/`unsubscribe` con la forma oficial; ping `{"type":"ping"}`
  cada 60 s frente a 2 min; canales de respuesta con `:`; `market_stats/all` fusionado (no reemplazado);
  errores sin `type` enrutados por salud; resuscripción al reconectar; flujos compartidos con contador
  de referencias; el stream resuelve `market_id` sin REST. Todo con tests contra servidores locales.
- **Token**: 10 min de vida por defecto (máximo oficial 8 h), renovado a los 8; firma local sin cupo.
- **Índices de clave**: 4..254, la lectura más restrictiva de las dos páginas oficiales.
- **Firmante**: perezoso (koffi solo al primer uso); `signerReady` espera `initialize()` antes de la
  primera escritura (intención correcta; LT-9 sobre su `.catch`).
- **Sondeo**: ejecuciones antes que órdenes; serializado; `account` memoizado 800 ms; `getTickers` lee
  la tabla del stream sin abrir socket; `oldestPrice` ordena numéricamente; `absoluteChange` redondea
  a los decimales del último.
- `modifyOrder` y `setPositionMode` son opcionales en el contrato y no faltan en Lighter.
