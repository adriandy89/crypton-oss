# Revisión integral — Fase 3, línea A: Market Maker v1, Market Maker v2, `mm-shared.ts` + paridad A-19…A-22

Fecha: 2026-09-05. Modo: solo lectura, sin red. Fuente de verdad: `specs/001-revision-integral/spec.md` (R-3, A-1…A-14, A-19…A-22) y `findings.md` (F-02 confirmado como B-02b por la revisión del motor; F-12, F-13, F-14, F-15, F-25/F-26, F-30 como semillas).

Escala de severidad: la de `specs/README.md`.

(Secciones añadidas incrementalmente; ver el final para la lista consolidada de hallazgos y el bloque «Verificado OK».)

## 0. Cómo llega el contexto a `plan()` (condiciona a las dos estrategias)

- `bot-runner.ts:557-643` (`tick`): `sweepFills()` → lee `ticker`, `positions`, `openOrders`, `balances`, `ownVenueIds` → rechaza `mark <= 0` (`:592`) → `checkRiskGuards` → `buildContext` (`:1685-1712`) → `this.withStopLoss(this.strategy.plan(ctx), position, cycleSeq)` (`:643`) → fusiona y persiste `scratchPatch` (`:645-651`) → `reconcile` con `ownIds` exacto (`:653-663`) → `execute` (`:665`) → `requestStop` (`:672-676`).
- `now` es `Date.now()` del servidor (`:1691`); las edades de las órdenes salen de `VenueOrder.createdAt`, que ponen los adaptadores (ver A-5 / MM-05).
- `fairPrice`: `peek()` del feed externo y se entrega **null si tiene más de `FAIR_PRICE_STALE_MS = 15_000` ms** (`:114`, `:1692-1696`). Binance se sondea cada 2 s (`price-source.service.ts:34-37`), con retroceso exponencial hasta 300 s ante 429/418/403/451 (`:52`, `:311-314`): durante un retroceso el precio caduca y la V2 deja de cotizar (por diseño, ver §2 A-5).
- `ticker`: en Hyperliquid `mark` es el **mid del libro** y con un lado vacío sale la mitad del otro (`hyperliquid.ts:426-438`; F-25/F-26, ya confirmados). Las dos estrategias anclan en `ctx.ticker` (`bookMid`, `mm-shared.ts:42-46`, que cae a `mark` si falta un lado), así que heredan ambos.
- Cierre de ciclo: `cycleAfterFill` (`cycle-accounting.ts:153,186-213`) declara plana la posición por debajo de `QTY_EPSILON` y devuelve un ciclo nuevo con `scratch: { cycleSeq: nextSeq, cooldownMinutes }`; `bot-store.ts:683,692` escribe **exactamente ese scratch** en la fila nueva y lo devuelve al runner. Es decir, **todo lo que el market maker guarda en `scratch` (`quotedMid`, `quotedAt`, `volSamples`, `armedAt`, `limitActionFiredAt`) se borra cada vez que la posición vuelve a cero**, y `cycleSeq` sube, con lo que cambian todos los `clientOrderId` (ver MM-04).
- `isMarketMaker` (`bot-runner.ts:382-383`) activa `trackMmStats` en `applyFillToCycle` (`:1039-1042`, `bot-store.ts:733-775`) y `trackMmPeaks` en cada snapshot (`:2052-2064`, `bot-store.ts:788-820`): las marcas de agua usan `qty × ticker.mark`, luego en Hyperliquid son «qty × mid».

## 1. Market Maker v1 — `packages/strategy-core/src/strategies/market-maker.ts`

### A-1 Entrada
- **Qué hace**: no hay «entrada» como tal: en cada tick emite hasta `layers` compras y `layers` ventas en `orders` (`:751-825`), tipo `POST_ONLY` salvo `postOnly === false` → `LIMIT` (`:742`). Nunca `MARKET` en `immediate` salvo el aplanado de `limitAction` (`:829-839`). El «cooldown» es doble: refresco por tiempo/deriva (`:651-659`) y `fillCooldownSeconds` sobre `ctx.cycle.lastEntryAt` (`:665-667`).
- **Qué promete**: `docs/market-maker.md:59-69` («Solo recotiza si… Intervalo… Distancia mínima… TTL»; «congela su cotización durante esos segundos»).
- **Veredicto**: hallazgos **MM-01** (`fillCooldownSeconds` inerte con `referencePrice`, F-15), **MM-02** (`refreshMs` suelo 5 frente a 15), **MM-04** (el cierre de ciclo borra `quotedMid` y anula la espera tras el fill que cierra el par).
- Detalle de MM-01: `quotedMid`/`quotedAt` solo se escriben cuando `!anchor && shouldRequote` (`:695-698`). Con `referencePrice` puesto `quotedMid` es siempre `null` → `cooling = cooldownMs > 0 && quotedMid != null && …` (`:667`) es siempre `false`, `shouldRequote` siempre `true` (`:690-691`) y la nota nunca dice «espera tras ejecución». El TTL de salida sigue funcionando (`expired` se calcula con `cooling = false`). La guía (`market-maker.guide.ts:172-177`) y la doc (`:400-406`) prometen la espera sin excepción.
- Detalle de MM-02: `refreshMs = Math.max(5, …)` (`:651`) frente a `validate` ≥ 15 (`:529-536`). Inerte hoy: solo afectaría a una fila guardada antes del suelo de 15, y el motor reconcilia cada 15 s de todas formas. Baja.

### A-2 Escalera
- **Qué hace**: pesos geométricos sin normalizar para distancia y tamaño (`geometricWeights`, `ladder.ts:33-42`; `:726-727`); `distancia_l = max(minBps, base × distW[l] × profile.distance × spreadWiden × regimeMul)` (`:763-766`, `:801-804`); `tamaño_l = orderSizePerSide × profile.size × sizeW[l]` (`:728`, `:752`); `sizeToQty` divide por el precio en `QUOTE` y no en `BASE` (`mm-shared.ts:144-152`). Cabida «todo o nada» contra `longCap`/`shortCap` (`:774`, `:809`).
- **Qué promete**: `docs/market-maker.md:109-133` (fórmula, «20, 30 y 45 bps», «todo o nada»). Cálculo comprobado: base 20, mult 1,5 → 20 / 30 / 45 ✓; conservador 30 × 1,5 = 45 y 67,5 ✓; tamaño 25 × 0,7 = 17,5 ✓ (`docs:177-181`).
- **Veredicto**: OK en `plan()`. Pero el **notional cabe contra `longCap` mientras régimen y sesgo se calculan contra `maxBotPositionValue`** → **MM-03**. El apalancamiento no entra en el tamaño (`targetLeverage` solo viaja al venue, `:849`), coherente con `docs:261`.

### A-3 Take profit
- **Qué hace**: no existe TP; la salida es el lado que reduce, cotizado a `regimeMul.reducing` (`REGIME_DISTANCE`, `mm-shared.ts:104-108`), sin `reduceOnly` salvo `HIGH_RISK` (`:770`, `:808`).
- **Veredicto**: no aplica (por diseño). Ver A-8.

### A-4 Stop loss
- **Qué hace**: la estrategia no emite `STOP_LOSS` en `orders`; `withStopLoss` (`stop-loss.ts:30-73`) lo inyecta con el signo de la posición real y `reduceOnly: true`, redondeado con `px(market, precio, exitSide)` (`:52`): para un largo la venta se redondea **hacia arriba**, un tick más cerca de la entrada → dispara un poco antes (conservador). No hay duplicado en `orders`.
- **Veredicto**: OK, salvo lo ya confirmado como **F-02 / B-02b**: el aplanado de `limitAction` usa `makeCoid(botId, seq, STOP_LOSS, 0)` (`:831`), el mismo id que el stop inyectado (`stop-loss.ts:59`), y `withStopLoss` solo mira `desired.orders` (`:48`). Agravante propio de esta estrategia (no repetido en B-02b): `limitActionFiredAt` se escribe en el scratch en ese mismo tick (`:840`) aunque `place()` vete la inmediata, y `limitBreach` devuelve `flatten: !alreadyFired` (`mm-shared.ts:397,410`) → **el cierre no se reintenta en toda la vida del ciclo** (el ciclo solo se cierra al quedar plano, que es justo lo que no ocurre). Con `SHUTDOWN` el bot además se para con la posición abierta (`:841`, `bot-runner.ts:672-676`) mientras la nota dice «cerrando y apagando».

### A-5 Safety, recompra y reanclaje
- **Qué hace**: el «reanclaje» es la recotización: `staleByTime` (`:658`), `staleByDrift` con umbral `minAllowedDistanceBps` (`:659`; doble función documentada en `docs:67`) y `expired` (`:679-688`). Las edades salen de `orderAges(ctx.openOrders)` = `VenueOrder.createdAt` (`mm-shared.ts:163-169`; `isOlderThan`, `:171-182`).
- **Veredicto**: **MM-05**: en Lighter `toVenueOrder` pone `createdAt: Date.now()` en cada sondeo (`lighter.ts:1920`) aunque el SDK entrega `timestamp`, `created_at` y `updated_at` en el mismo objeto (`zklighter-sdk/dist/api.d.ts:487-489`). Edad ≈ 0 ms siempre → `isOlderThan` nunca es cierta → `exitOrderTtlSeconds` (V1) y `orderMaxAgeSeconds` + `exitOrderTtlSeconds` (V2, con 120 s **por defecto**) son código muerto en Lighter. Hyperliquid usa `o.timestamp` (`hyperliquid.ts:421`, `:941`); Aster `o.time ?? o.updateTime` por REST (`aster.ts:1039`) pero `ev.E` (hora del evento) por WebSocket (`:973`), con lo que en Aster una ejecución parcial rejuvenece la orden. El simulador usa su reloj (`dry-run.ts:483,851`) ✓.
- También A-5: el ancla manual (`referencePrice`, `:644`, `:693`) sustituye al mercado sin límite de deriva; el comentario de `validate` (`:541-543`) anuncia un aviso que **no existe**: el bloque solo comprueba `ref > 0` (`:544-549`). La doc (`:467`) dice «La app avisa pero no lo impide». Baja → **MM-13**.

### A-6 Cierre de ciclo y cooldown
- **Qué hace**: no lee `cycle.cooldownUntil` ni `cooldownMinutes` (cero apariciones en `market-maker.ts`); la doc lo declara (`docs:262`). El ciclo lo cierra el motor al quedar plano (`cycle-accounting.ts:153`).
- **Veredicto**: **MM-04** (Media, candidata a Alta por churn de caudal): para un market maker NEUTRAL «quedar plano» es el final de **cada par casado** (compra 0,001 + venta 0,001 → `nextQty = 0` → `closed`). Cada cierre: (1) `cycleSeq` sube → los `layers × 2` ids cambian → `reconcile` cancela todas las cotizaciones vivas del ciclo anterior (`buildOwnIdSet` cubre `seq − 1` a propósito, `reconcile.ts:102-111`; el runner pasa `ownVenueClientIds(botId, [seq, seq − 1])`, `bot-runner.ts:579`) y las repone con id nuevo: `2 × layers` cancelaciones + `2 × layers` colocaciones por vuelta y pérdida de prioridad en el libro de las capas que no se habían tocado; (2) `quotedMid` desaparece → `shouldRequote` forzado; (3) `lastEntryAt: null` (`cycle-accounting.ts:198`) y `quotedMid == null` → `cooling` falso → **la «espera tras un fill» no se aplica nunca tras la ejecución que cierra el par**, que es la mitad de las ejecuciones; (4) en V2 se pierden además `volSamples` y `armedAt` (§2). Nada de esto está en la doc, que promete «Una ejecución rehace la cotización al instante» (`docs:398`) pero no «cancela y repone todas las capas».
- Test propuesto (`strategies.spec.ts`): MM v1 NEUTRAL, `layers: 3`, `fillCooldownSeconds: 60`; contexto tras el fill de cierre (`cycle.scratch = { cycleSeq: 2 }`, `lastEntryAt: null`, `openOrders` con los seis ids de `seq 1`): `reconcile(plan)` da `toCancel = 6` y `toPlace = 6`, y `note` no contiene «espera». El test documenta el coste actual y fallará cuando se decida corregirlo (no cerrar ciclo en market makers, o arrastrar `quotedMid`/`lastEntryAt`/`volSamples`/`armedAt` al ciclo nuevo).

### A-7 Dirección
- **Qué hace**: `NEUTRAL` cotiza ambos lados; `LONG` solo bids; `SHORT` solo asks (`:739-741`). `preview` estima como `SHORT` o `LONG` (`:631`).
- **Qué promete**: `docs:282-287` lo dice exactamente así. La guía in-app (`market-maker.guide.ts:213-218`) dice «trata la posición contraria como algo a deshacer», que es lo que **no** hace (con `LONG` no hay venta que deshaga nada). Baja → **MM-13**.
- **Veredicto**: código coherente con la doc larga; guía in-app engañosa.

### A-8 `reduceOnly`
- **Qué hace**: `reduceOnly = role === 'reducing' && regime === 'HIGH_RISK'` (`:770`, `:808`); el aplanado sí es `reduceOnly` (`:838`).
- **Veredicto**: OK y documentado (`docs:85`; findings «Verificado OK»). Consecuencia conocida: en `positionMode: HEDGE` una venta abre la otra pata (`docs:491`).

### A-9 `preview()` ≡ `plan()`
- **Qué hace**: `preview` (`:576-635`) usa `size = D(cfg.orderSizePerSide)` **sin `profile.size`** (`:587`) mientras `plan` usa `orderSizePerSide × profile.size` (`:728`). Sí aplica `profile.distance` (`:597`, `:612`). Ignora sesgo y ensanchamiento (correcto sin posición, `ratio = 0`). `buildPreview` marca **las dos caras como entradas** (`isEntry: true` en bids y asks, `:607`, `:622`) y estima la liquidación como `LONG` con la fórmula aislada (`common.ts:341-342`; F-14).
- **Números**: con `riskProfile: CONSERVATIVE` y `orderSizePerSide: 12` en un mercado con `minNotional: 10` (Lighter y Hyperliquid, `venue-markets.ts:51,135`): el preview muestra 12,00 USDC por capa y es válido; el bot manda 12 × 0,7 = **8,40** → `revisarOrden` → `ENTRADA_INVALIDA` (`order-gate.ts:56-63`) en **todas** las capas de los dos lados → cero cotizaciones, un `ORDER_UNVIABLE` por forma y silencio después. La doc lo describe como riesgo del usuario (`docs:294`), pero el preview —«literalmente lo que se mandará» (`bot-create.page.ts:1072-1073`)— dice que sí cabe. Rango afectado: `orderSizePerSide ∈ [minNotional, minNotional / 0,7)` = [10, 14,28) USDC con conservador, y con `layerSizeMultiplier < 1` cualquier capa cuyo `size × 0,7 × sizeW[l] < 10`. El asistente puede producirlo: `build.ts:441` reparte `porLado = capital × lev / (capas × 6)` y con perfil PRUDENTE elige `CONSERVATIVE` (`:471-473`); con `capital = 150`, `lev = 1` (régimen «salvaje» de `venue-matrix.spec.ts:71-85`: `volDiaria = 220/√365 = 11,5`, `100/(10,67 × 11,5) = 0,81 → 1`), `capasPorCapital = floor(150/72) = 2`, `capas = 2`, `porLado = 150/12 = 12,50` → preview válido, órdenes reales de 8,75 < 10. `venue-matrix.spec.ts:173-189` no lo caza porque comprueba `preview()`, que omite el multiplicador, y sus capitales son 50/200/1000/5000 (`:31`). → **MM-06 (Alta: bot muerto en una configuración que pasa validación y preview)**.
- Peor caso doble: `worstCaseNotional` suma bids y asks (3 capas × 50 × 2 lados = 300 cuando el peor caso real de un neutral es 150 por lado) y `worstAvg` promedia compras y ventas alrededor del mid → liquidación «LONG» sobre un notional que no puede existir a la vez → **MM-07** (Media, extiende F-14).
- Test propuesto: `preview(cfg CONSERVATIVE, size 12, market minNotional 10).valid === true` y, para el mismo `cfg`, `plan(ctx).orders.every(o => revisarOrden(market, o, true).motivo === 'OK')` → hoy falla la segunda mitad.

### A-10 `validate()` frente a `meta.fields`
- **Qué hace**: `validate` (`:491-574`) comprueba `orderSizePerSide > 0`, `maxBotPositionValue > 0`, `minAllowed > 0` y `≤ buy/sell`, `buy/sell > 0`, `layers ∈ [1,10]`, `refreshSeconds ≥ 15`, umbrales `(0,100]` y `defensive < high`, `floor < ceiling`, `referencePrice > 0`, y avisa si las capas de un lado superan el tope. `validateCommon` (`common.ts:191-240`): símbolo, cuenta, `leverage ∈ [1, market.maxLeverage]`, `totalInvestment > 0`, aviso de `maxNotionalCap`, mercado activo.
- **No acotados aunque `meta.fields` los limita** (F-13; enumeración completa de la V1):

| Campo | `meta` | `validate` | Efecto de un valor fuera de rango |
|---|---|---|---|
| `orderSizePerSide` | min 1 | > 0 | 0,5 USDC pasa; lo rechaza el preview por `minNotional` (visible) |
| `maxBotPositionValue` | min 1 | > 0 | 0,5 pasa; `atCap` casi inmediato |
| `maxLongPosition` / `maxShortPosition` | min 0 | nada | negativo o `'0.00'` → `longCap = 0` → esa cara nunca «cabe» (`:774`) y **no hay nota ni evento** |
| `buyDistanceBps` / `sellDistanceBps` | 1–1000 | > 0 | > 10 000 → precio ≤ 0 → capa descartada en silencio (`:776`) |
| `minAllowedDistanceBps` | 1–500 | > 0, ≤ buy/sell | — |
| `inventorySkewFactor` | 0–3 | nada | negativo invierte el sesgo (el centro se mueve **a favor** del inventario: acumula más deprisa); ≥ 500 con ratio 1 y 20 bps → `skewedMid ≤ 0` → sin órdenes |
| `refreshSeconds` | 15–3600 | ≥ 15 | sin máximo |
| `fillCooldownSeconds` | 0–3600 | nada | negativo → 0 (`Math.max`) |
| `exitOrderTtlSeconds` | 0–86400 | nada | negativo → apagado |
| `layerDistanceMultiplier` | 1–3 | nada | < 1 acerca las capas profundas (todas al `minBps`, precios repetidos con ids distintos) |
| `layerSizeMultiplier` | 0,1–3 | nada | ≤ 0 → las capas > 0 se saltan (`:753`) |
| `defensiveThresholdPct` / `highRiskThresholdPct` | 1–100 | (0,100] | — |
| `totalInvestment` | min 10 | > 0 | — |
| `stopLossPct` (común) | 0,1–90 | **nada** | > 100 en largo → `stopLossPrice < 0` → `px` negativo → `revisarOrden` `IMPOSIBLE` (`order-gate.ts:68-75`) → **stop no colocado**, `stopLossVivo = false`, un WARN |
| `maxDailyLossPct` (común) | 0,1–100 | nada | — |
| `cooldownMinutes` (común) | 0–10080 | nada | inerte en MM |
| `maxNotionalCap` (común) | min 0 | nada | inerte en MM (`docs:260`) |
| `priceFloor` / `priceCeiling` | min 0 | floor < ceiling | negativo → ignorado |

- **Veredicto**: **MM-08** (F-13 confirmado; Media). Los tres con efecto silencioso son `maxLong/ShortPosition` (una cara muerta), `inventorySkewFactor` negativo y `stopLossPct > 100` (este último es común a las siete: va al validador genérico que propone F-13).
- Test propuesto: recorrer `meta.fields` desde el registro y afirmar que `validate()` devuelve ERROR para `min − step`, `max + step` y una opción inexistente, en las siete estrategias.

### A-11 Parámetros muertos o a medias
- `fillCooldownSeconds` a medias (MM-01, MM-04). `cooldownMinutes` y `maxNotionalCap`: muertos **y documentados** (`docs:254-262`) → OK. `totalInvestment`: solo denominador de guardas (`bot-runner.ts:1620,1646`) ✓ doc. `exitOrderTtlSeconds`: muerto en Lighter (MM-05). `referencePrice`: vivo y sin el aviso prometido (MM-13). `positionMode` (COLD) lo aplica el motor, fuera de esta línea.

### A-12 `clientOrderId` y `cycleSeq`
- **Qué hace**: `seq = Number(scratch.cycleSeq ?? 0)` (`:639`) — la misma expresión que el tick (`bot-runner.ts:568`) y que `place()` (`:821`); `withStopLoss` recibe ese mismo `cycleSeq` (`:643`, `:1501-1512`). Backtest: `?? 1` (`engine.ts:202`), pero el scratch siempre lo trae (`:151`). Ids: `QB{l}`, `QA{l}` con `l < layers ≤ 10`; inmediata `SL0`; cierre manual `TP999` (`bot-runner.ts:2027`).
- **Veredicto**: sin colisiones dentro de `orders`; colisión `orders` (stop inyectado) × `immediate` (aplanado) = F-02, ya confirmada. No se repite el análisis.

### A-13 Comisiones, funding y slippage
- **Qué hace**: nada en la V1: no hay campo de comisión; el diferencial es el que teclea el usuario y `postOnly` por defecto garantiza maker. Funding: no se modela en ninguna parte (declarado en `warnings.ts:39-41` para el backtest). El aplanado sale `MARKET` con `price: px(mid)` (`:836`), donde `mid` puede ser `quotedMid` (rancio hasta `refreshSeconds`); F-16 ya cubre qué hace cada adaptador con el `price` de una MARKET.
- **Qué promete**: `docs:232,250` remite a la V2 para cubrir comisiones ✓; la guía (`:25`) también.
- **Veredicto**: OK como está contado. `MarketMakerStats.feesPaid` acumula `fill.fee` con el signo que llega del venue (`bot-store.ts:742,759,771`; `cycle-accounting.ts:123,152`): un rebate maker negativo **sube** el realizado, coherente si los adaptadores conservan el signo (C-8).

### A-14 `onFill`, `reusesOrderSlots`, `recycleLevelOnExit`
- **Qué hace**: `reusesOrderSlots: true` (`:461`); sin `onFill` ni `recycleLevelOnExit`. El motor permite recolocar un id `FILLED` en `toPlace`/`toReplace` (`bot-runner.ts:760,767-771,861-866`) y **nunca** en `immediate` (`:779-782`). `cycleAfterFill` cuenta `QUOTE_BID` y `QUOTE_ASK` como entradas (`ENTRY_KINDS`, `cycle-accounting.ts:28-34`): `lastEntryAt` se actualiza con cualquier cara → la espera tras fill aplica a compras y ventas ✓; `filledLevelIndexes` crece hasta `2 × layers` valores sin uso (inofensivo).
- **Veredicto**: OK. Un fill **parcial** no libera nada: `reconcile` compara contra la cantidad restante (`reconcile.ts:188-189`) y la orden sigue viva hasta que se recotiza; correcto.

### Otros puntos pedidos (V1)
- **`atCap` frente a topes por lado (MM-03)**: `atCap = |exposure| ≥ maxBotPositionValue` (`:710`) mientras las capas caben contra `longCap = maxLongPosition ?? maxPos` (`:703-704`, `:774`). Con `maxLongPosition: 200` y `maxBotPositionValue: 1000`, a 250 USDC largo no hay bids (no caben) pero `limitAction` no dispara (`atCap` falso), `ratio = 0,25` → régimen NORMAL, sesgo de 0,25 × 20 = 5 bps y la nota dice «Inventario 250.00 (25 % del tope), N cotizaciones». Los topes por lado son un freno mudo: ni régimen, ni acción al límite, ni nota. Media. Test: `plan()` con `maxLongPosition: '200'`, posición larga 250, `limitAction: CLOSE_ALL` → hoy `immediate = []` y `note` sin «Tope».
- **Sesgo por inventario**: `skewedMid = mid × (1 − skew × ratio × baseBps / 10 000)` (`:716-720`) con `baseBps = (buy + sell) / 2` ✓ igual que `docs:94`. Con `ratio = 1`, skew 1, 20/20 bps y `dynamicSpread`: centro −20 bps, ensanchamiento ×2 → venta a +20 bps del mid real y compra a −60 bps ✓ («vender antes, comprar más lejos»).
- **`fitToRoom` / `useFullSizeUntilMax`**: solo V2. En V1 la cabida es todo o nada (`:774`) tal como dice `docs:133` ✓.
- **`sizeToQty` BASE/QUOTE**: `notional = size × price` en BASE y `= size` en QUOTE (`mm-shared.ts:149-151`); los topes comparan notional en quote en los dos modos ✓ (test `strategies.spec.ts:969-973`).
- **Anclaje en `ctx.ticker` (F-25/F-26)**: `bookMid` cae a `mark` cuando falta un lado (`mm-shared.ts:45`); en Hyperliquid con el ask vacío `mark = bid/2` (`hyperliquid.ts:427-436`) → el bot valora el inventario a la mitad (`inventoryOf`, `mm-shared.ts:70-76`): `loadPct` se divide por dos, un `HIGH_RISK` pasa a `NORMAL` y un `atCap` con `PAUSE_ENTRIES` se levanta durante ese tick; además `staleByDrift` (5 000 bps) fuerza recotizar y guarda el mid falso en `quotedMid` (`:696`), con lo que el tick siguiente vuelve a recotizar. Es la consecuencia de F-26 en esta estrategia; no abro ficha nueva.

## 2. Market Maker v2 — `packages/strategy-core/src/strategies/market-maker-v2.ts`

### A-1 Entrada
- **Qué hace**: igual que la V1 (`orders` POST_ONLY/LIMIT, `:1076`; inmediata solo el aplanado, `:1175-1189`), con tres puertas previas: `resolveAnchor` (`:757-768`, `:968-979`), `activationGate` (`:982-986`, `mm-shared.ts:345-368`) y el refresco con umbral propio `repriceThresholdBps` (`:1000`), edad máxima `orderMaxAgeSeconds` (`:1027`) y TTL de salida (`:1028`). `quotedMid`/`quotedAt` se escriben siempre que `shouldRequote` (`:1034-1038`): aquí **no** existe el defecto MM-01 (no hay ancla manual).
- **Qué promete**: `docs/market-maker-v2.md:94-105`.
- **Veredicto**: OK salvo MM-02 (mismo `Math.max(5, …)`, `:989`), MM-04 (cierre de ciclo) y MM-05 (edades en Lighter, con `orderMaxAgeSeconds: 120` **por defecto** — `:792` — es la V2 la más afectada). Con `orderMaxAgeSeconds` y `refreshSeconds: 30` la orden se reevalúa cada 30 s; si el precio no se movió no se toca, y a los 120 s se cancela y repone **al mismo precio**: pérdida de prioridad sin beneficio. Es lo documentado (`docs:503-507`); lo anoto sin ficha.

### A-2 Escalera
- **Qué hace**: `distancia_l = max(floorBps, bps × distW[l] × profile.distance × regimeMul)` (`:1096-1099`, `:1138-1141`) con `bps = max(floor, min(cap, base + dyn + 2·fee + buffer))` (`composeSpreadBps`, `:666-690`). Tamaño `orderSizePerSide × profile.size × sizeW[l]` (`:1071`, `:1086`) recortado por `fitToRoom` (`:1229-1239`) al hueco `maxPos − projected` (`:1110`, `:1152`), `qty = notional / price` solo si hubo recorte (`:1114`).
- **Qué promete**: `docs:143-181`. Números comprobados: guía ejemplo 1 (`market-maker-v2.guide.ts:45`): raw = 40 + (1,5 + 25 × 0,35) + 2 × 2 + 0 = **54,25** → «54» ✓; suelo max(8, 4 + 8) = 12 ✓. Doc config A (`docs:239-250`): 25 + 1,5 + 7 + 4 + 2 = 39,5 → × 1,5 conservador = **59,25** ✓ (la propia doc aplica el preset **después** del techo).
- **Veredicto**: **MM-09** — el techo `maxDynamicSpreadBps` se aplica al total **antes** de `distW`, `profile.distance` y `regimeMul` (`:687` frente a `:1098`). Con el techo por defecto (100 bps): preset CONSERVATIVE → capa 1 a **150 bps**; régimen DEFENSIVE lado que añade (×1,5) → 150; ambos → **225**; tres capas con multiplicador 1,5 → 225 (BALANCED) / 337,5 (CONSERVATIVE). La guía in-app dice «Techo duro: el bot no cotiza nunca más ancho que esto» (`market-maker-v2.guide.ts:208`) y `docs:164` «la capa 1 nunca supera el techo», mientras `docs:369` y `:486` reconocen lo contrario. Media (parámetro a medias + doc que se contradice). Test: `plan({ buyDistanceBps: 500, maxDynamicSpreadBps: 50, behaviorPreset: 'CONSERVATIVE' })` → precio del bid `>= 99.5` (hoy 99,25).
- `fitToRoom` con `useFullSizeUntilMax: false` (por defecto) → **MM-14**: el recorte puede dejar un resto por debajo de `minNotional` que `revisarOrden` rechaza como `ENTRADA_INVALIDA` (WARN `ORDER_UNVIABLE`, `order-gate.ts:56-63`) en **cada** recotización, porque la cuarentena es por forma (`bot-runner.ts:826,845,976-978`) y la forma cambia con el precio. Ejemplo: `maxBotPositionValue 1000`, posición 995 USDC → hueco 5 → orden de 5 USDC < 10 → un WARN cada 30 s mientras dure. `plan()` tiene `ctx.market.minNotional` a mano y podría descartar el resto. Media (ruido y una capa prometida que nunca sale).
- Test: `plan({ useFullSizeUntilMax: false, maxBotPositionValue: '1000' }, { position: makePosition('9.95', '100') })` → la única compra vale 5 USDC → `revisarOrden(market, o, true).motivo === 'ENTRADA_INVALIDA'`.

### A-3 Take profit
- No aplica (igual que V1).

### A-4 Stop loss
- Igual que V1: inyectado por `withStopLoss`; colisión F-02 en `:1178` con el mismo agravante (`limitActionFiredAt` escrito aunque la inmediata se vete, `:1187`; `SHUTDOWN` con posición abierta, `:1188`).

### A-5 Safety, recompra y reanclaje
- **Qué hace**: `resolveAnchor`: `VENUE_MARK` → `ctx.ticker.mark`; `VENUE_MID` → `bookMid`; `SOURCE_GLOBAL` + `EXCHANGE` → `bookMid`; `SOURCE_GLOBAL` + `BINANCE` → `ctx.fairPrice` o **null** (`:757-768`). Con null devuelve `orders: []` y nota «Sin precio de referencia de binance…» (`:969-979`) → el reconciliador **cancela todas las cotizaciones vivas** (también las del lado que reduce) y deja solo el stop inyectado. El motor avisa con `FAIR_PRICE_UNAVAILABLE` cada 5 min con la causa (`bot-runner.ts:1818-1830`, `FAIR_PRICE_ALERT_COOLDOWN_MS`, `:117`) **solo si hay `fairFeedKey`**; si `acquireFairPrice` devolvió null (worker sin feeds, fuente desconocida) hay un WARN al arrancar (`:1734-1750`) y después solo la nota. El precio caduca a los 15 s (`:114`) con sondeo de 2 s y retroceso hasta 300 s ante 429/418/403/451 (`price-source.service.ts:52,311-314`): un bloqueo geográfico deja al bot parado con un evento cada 5 min y la causa «GEO» (`FAIR_PRICE_CAUSE_TEXT`).
- **Qué promete**: `docs:76-84`, `:566`; guía `:16`, `:238`.
- **Veredicto**: modo de fallo correcto y **visible** (nota + evento con causa). Un feed que parpadea (rancio 15 s, vuelve, rancio) cancela y repone `2 × layers` órdenes por episodio; asumido por diseño. **MM-12** (Baja, consecuencia de F-25): `VENUE_MARK` en Hyperliquid es el mid (`hyperliquid.ts:436`), así que la guía «El de marca es el que ese exchange usa para liquidar, más estable que el medio» (`market-maker-v2.guide.ts:244`; `docs:578`) es falsa en ese venue: `VENUE_MARK ≡ VENUE_MID`.
- Edades: MM-05 (Lighter), con `orderMaxAgeSeconds: 120` por defecto muerto allí.

### A-6 Cierre de ciclo y cooldown
- **Qué hace**: no lee `cooldownUntil` (documentado, `docs:344`). Al quedar plano el motor borra el scratch (§0).
- **Veredicto**: MM-04 con dos efectos exclusivos de la V2: (a) **`volSamples` se pierde en cada par casado** → `volBps = 0` en la siguiente cotización → con los valores de fábrica el diferencial cae de 41,5 + 0,35 × vol a **41,5 bps** justo después de ejecutar, y tarda hasta `volatilitySampleSeconds` (300 s, ≤ 10 muestras a 30 s) en volver a medir; en tendencia —cuando más importa ensanchar— el bot cotiza su diferencial más estrecho tras cada vuelta. (b) **`armedAt` se pierde** → **MM-18**: con `activationMode: PRICE_BELOW` y disparo 0,0040, kPEPE cruza a 0,0039, el bot compra, vende, queda plano, el scratch se borra, el precio vuelve a 0,0041 y `activationGate` responde «Esperando a que el precio baje a 0.004» (`mm-shared.ts:360-365`) con `orders: []` → **el bot se duerme tras su primera vuelta**, contra `docs:92` («Una vez armado, se queda armado para siempre») y `guide:262`. Media.
- Test (MM-18): `plan({ activationMode: 'PRICE_BELOW', activationPrice: '90' }, { price: '100', cycle: { scratch: { cycleSeq: 2 } } })` tras un ciclo cerrado → hoy `orders = []`; el test de regresión debe fijar que `armedAt` sobrevive al cierre (o que la condición se evalúa una sola vez por bot y no por ciclo).

### A-7 Dirección
- Igual que V1 (`:1073-1075`; preview `:954`); la guía in-app repite el texto engañoso (`market-maker-v2.guide.ts:288-293`) → MM-13.

### A-8 `reduceOnly`
- Igual que V1 (`:1102`, `:1144`, aplanado `:1185`) ✓.

### A-9 `preview()` ≡ `plan()`
- **Qué hace**: `preview` (`:894-958`): `mid = D(refPrice)` (ignora fuente externa y activación: razonable); `buySpread = composeSpreadBps(cfg, buy, 0).bps` y por capa `bps = buySpread × distW × profile.distance` (`:920`) **sin el `max(floorBps, …)`** de `plan` (`:1096-1099`); tamaño **sin `profile.size`** (`:905`).
- **Números**: (1) tamaño: idéntico a MM-06 (conservador 12 USDC → 8,40 real). (2) suelo por capa: `buyDistanceBps 10`, `feeEstimateBps 5`, `minProfitMarginBps 20`, preset AGGRESSIVE → `bps = max(30, 10 + 1,5 + 10) = 30`; `plan` cotiza `max(30, 30 × 0,7) = 30 bps`; el preview enseña **21 bps** (99,79 frente a 99,70 sobre 100). (3) peor caso doble y liquidación LONG: MM-07.
- **Veredicto**: MM-06 y MM-07 se dan también en V2.

### A-10 `validate()` frente a `meta.fields`
- **Qué hace**: `validate` (`:814-892`): tamaño y tope > 0, distancias > 0, `layers`, `refreshSeconds ≥ 15`, umbrales, banda, `validateFairSource` (forma del símbolo, aviso de origen), aviso de suelo > distancia, error `cap < suelo` (solo si `cap > 0`), precio de disparo si hay condición.
- **No acotados** (F-13; además de los comunes de la tabla de §1):

| Campo | `meta` | `validate` | Efecto |
|---|---|---|---|
| `minAllowedDistanceBps` | 1–500 | **nada** (ni > 0 ni ≤ distancias; `docs:411` lo admite) | 500 con base 40 → cotiza a 500 bps; el aviso que salta dice «Comisión y margen mínimo obligan a…» (`:854-862`), que no es la causa |
| `repriceThresholdBps` | 1–1000 | nada | **`'0'` → `driftBps.gte(0)` siempre cierto (`:1000`) → recotiza en cada tick: `2 × layers` cancelaciones y colocaciones cada 15 s**; negativo igual |
| `maxDynamicSpreadBps` | 1–5000 | ≥ suelo solo si > 0 | `'0'` **desactiva el techo en silencio** (`:686-687`) |
| `feeEstimateBps` / `safetyBufferBps` / `minProfitMarginBps` / `orderBookMarginBps` | ≥ 0 | nada | negativos estrechan; el suelo `max(minAllowed, …)` los contiene salvo que `minAllowed` también sea 0 |
| `volatilityMultiplier` | 0–5 | nada | negativo: **se estrecha** con la volatilidad (al revés de lo prometido); el suelo lo contiene |
| `volatilitySampleSeconds` | 30–3600 | nada | 1 → ventana de 1 s → vol siempre 0; enorme → tope de 240 muestras |
| `orderMaxAgeSeconds`, `fillCooldownSeconds`, `exitOrderTtlSeconds` | ≥ 0 | nada | negativo → apagado |
| `layerDistanceMultiplier` / `layerSizeMultiplier` | 1–3 / 0,1–3 | nada | como V1 |
| `priceSource`, `fairPriceOrigin`, `sourceMarketType`, `activationMode`, `sizingMode`, `behaviorPreset`, `limitAction`, `positionMode` | `options` | nada | un enum desconocido cae al defecto por `??`/`profileOf`; `priceSource` desconocido → sin ancla → el runner avisa (`bot-runner.ts:1733-1741`) |
| booleanos (`postOnly`, `dynamicSpread`, `useFullSizeUntilMax`) | — | nada | la cadena `'false'` es veraz: `postOnly === false` no se cumple → POST_ONLY (seguro); `dynamicSpread === false` tampoco → activado |

- **Veredicto**: MM-08 (F-13). El caso con efecto de caudal es `repriceThresholdBps: 0`.

### A-11 Parámetros muertos o a medias
- `orderMaxAgeSeconds`, `exitOrderTtlSeconds`: muertos en Lighter (MM-05). `maxDynamicSpreadBps`: a medias (MM-09). `activationMode`: a medias (MM-18). `volatilitySampleSeconds`: a medias (MM-04a). `feeEstimateBps`: vivo pero con defecto 0 → **MM-10**: con `feeEstimateBps: '0'` (`:784`) el suelo es `max(8, 0 + 8) = 8` bps y toda la «garantía de beneficio» se reduce a `minProfitMarginBps`; la doc lo grita (`docs:193-197`, `:413-421`) y el asistente pone 2 bps (`build.ts:399,491`), pero un bot creado a mano con los defectos cotiza «como si operar fuese gratis». Media, y **cambiar el defecto es decisión del usuario** (principio 6). `cooldownMinutes`, `maxNotionalCap`: muertos y documentados ✓. `sourceMarketType` y `sourceSymbolOverride`: los consume el worker (`bot-runner.ts:1775-1780`) ✓.

### A-12 `clientOrderId` y `cycleSeq`
- Igual que V1 (`:962`; F-02 en `:1178`). `expiredQuotes` genera los ids con `makeCoid(botId, seq, LevelKind[kind], layer)` (`:1025`) → los mismos que las órdenes ✓.

### A-13 Comisiones, funding y slippage
- **Qué hace**: `feeEstimateBps × 2` entra en el suelo y en el bruto (`:673-685`); `safetyBufferBps` se suma al bruto; se asume maker (`postOnly`); funding no existe; slippage no aplica (POST_ONLY) salvo el aplanado MARKET (F-16). La comisión es un número que teclea el usuario, no se lee de la cuenta ni del venue, y el bot no la contrasta con `fill.fee` que sí conoce (`bot-store.ts:742`).
- **Qué promete**: `docs:413-421`, guía `:118-123`.
- **Veredicto**: OK como está contado; MM-10 por el defecto.

### A-14 `onFill`, `reusesOrderSlots`, `recycleLevelOnExit`
- `reusesOrderSlots: true` (`:773`), sin `onFill` ✓ igual que V1.

### Otros puntos pedidos (V2)
- **`sampleVolatility`** (`mm-shared.ts:286-321`): ventana `max(1, floor(volatilitySampleSeconds ?? 300)) s`; la muestra solo se añade con `record = shouldRequote && dynamicSpread` (`:1045-1051`); recorte a las últimas `MAX_VOL_SAMPLES = 240` (solo muerde si `ventana / refresco > 240`, p. ej. 3600 s / 15 s = 240 justo); `volBps = (max − min) / media × 10 000` ✓ igual que `docs:111-115` (99→101 sobre 100 = 200 bps ✓). Pero **`volBps` se recalcula en cada tick sobre el anillo podado aunque no se recotice**, y el precio de las órdenes es `quotedMid × (1 ∓ bps(volBps))` (`:1034`, `:1065-1066`, `:1100`): en el tick intermedio (a +15 s de una recotización de 30 s) se poda exactamente la muestra que estaba en el borde de la ventana; si era el máximo o el mínimo —lo normal en tendencia— `volBps` baja, el precio se mueve más de medio tick y `reconcile` **cancela y repone todas las capas sin recotizar**. Contradice el comentario de `:1040-1044` («el diferencial únicamente se aplica en ese momento»). Ejemplo: vol 25 → 15 bps, × 0,35 = 3,5 bps; sobre BTC a 80 000 son 28 USD > tick. → **MM-17** (Media: churn no previsto, hasta duplicar las cancelaciones en tendencia). Test: dos `plan()` sin recotizar (`quotedAt` reciente) con `volSamples` cuya muestra extrema envejece entre ambos → los precios difieren → `reconcile(...).toReplace.length > 0`.
- **`composeSpreadBps` y `maxDynamicSpreadBps`**: MM-09 (arriba). El suelo sí se aplica **después** de los multiplicadores (`:1096-1099`), así que `HIGH_RISK` reduciendo (×0,5) nunca baja del suelo ✓.
- **`feeEstimateBps` por defecto 0**: MM-10.
- **`resolveAnchor` null**: modo de fallo correcto y visible (A-5). Añado: al quedar sin ancla se cancelan también las salidas; documentado («retira sus órdenes»).
- **`fitToRoom` / `useFullSizeUntilMax`**: MM-14; con `true` es todo o nada ✓ (`:1238`; test `strategies.spec.ts:1309-1317`).
- **`reduceOnly` solo en HIGH_RISK**: ✓ documentado (`docs:137`).
- **`limitBreach` / `SHUTDOWN`**: F-02 + agravante (A-4).
- **Sesgo por inventario**: la V2 **no** lo tiene (solo régimen) y lo dice (`docs:141`) ✓.
- **`orderAges` / `expiredQuotes` en Lighter**: MM-05.
- **BASE/QUOTE**: el recorte se hace en notional en los dos modos (`:1105-1114`) ✓ (tests `:1288-1307`).
- **Coid único entre `orders` e `immediate`**: solo F-02.

## 3. `mm-shared.ts` — verificación pieza a pieza

| Pieza | Líneas | Veredicto |
|---|---|---|
| `PROFILE` / `profileOf` | `:28-37` | ✓ 1,5/0,7 · 1/1 · 0,7/1,3 como en las dos docs; clave desconocida → BALANCED |
| `bookMid` / `bookSpreadBps` | `:42-55` | ✓; hereda F-25/F-26 por `mark` |
| `inventoryOf` | `:70-76` | ✓ `ratio ∈ [−1, 1]`, `loadPct = |ratio| × 100`; valora al `mid` de la estrategia (con ancla manual, al ancla, no al mercado: a 10 % de deriva el tope se mide 10 % mal — Baja, va en MM-13) |
| `riskRegime` / `REGIME_DISTANCE` | `:87-108` | ✓ `≥` en ambos umbrales; 1,5/0,6 y 0/0,5 como en las docs |
| `priceBand` | `:126-133` | ✓ corta solo el lado que abre; `floor ≥ ceiling` lo rechaza `validatePriceBand` |
| `sizeToQty` | `:144-152` | ✓ |
| `orderAges` / `isOlderThan` | `:163-182` | ✓ en sí; MM-05 por `createdAt` en Lighter; depende de que `now` (servidor) y `createdAt` (venue) compartan reloj (B-22) |
| `sideRoles` | `:200-204` | ✓ plano = ambos «adding» |
| `expiredQuotes` | `:220-251` | ✓ el conjunto decide recotizar **y** dejar de desear (test `:1208-1239`); usa `roles` del signo de la posición ✓ |
| `sampleVolatility` | `:286-321` | fórmula ✓; MM-17 (recálculo entre recotizaciones), MM-04a (anillo borrado al cerrar ciclo) |
| `activationGate` | `:345-368` | ✓ armado pegajoso **dentro del ciclo**; MM-18 al cerrarlo |
| `limitBreach` | `:389-417` | ✓ una vez por ciclo; con F-02 el «una vez» se consume sin cerrar |

## 4. A-19 — `apps/api/src/modules/leaderboard/share-codec.ts`

- **Qué hace**: lista blanca por `FieldMeta` (`:60-68`); `kind: 'money'` → proporción de `totalInvestment` con 8 decimales (`:70-73`); **todo lo demás viaja tal cual** en `params` (`:75`). `expandFromShare` multiplica y redondea a **2 decimales** (`:92-97`) y no valida; `copy()` (`leaderboard.service.ts:247-264`) devuelve la config sin pasar por `validate()`: la validación llega en la app (en línea) y en `create()`.
- **F-30** (ya registrado): `referencePrice`, `priceFloor`, `priceCeiling` (V1, `market-maker.ts:398-430`) y `priceFloor`, `priceCeiling`, `activationPrice` (V2, `:585-632`) son `kind: 'price'` y viajan intactos.
- **P-01 (Media, Alta si `postOnly: false`)**: `sourceSymbolOverride` es `kind: 'text'` (`market-maker-v2.ts:576-584`) y viaja tal cual junto a `priceSource` y `sourceMarketType`. Autor: kPEPE en Hyperliquid con `BINANCE` + `1000PEPEUSDT`; copiador: ETH. `fairFeedRequest` (`bot-runner.ts:1775-1780`) pide `1000PEPEUSDT`, el ancla es ≈ 0,004 y `validateFairSource` solo mira la forma (`:707-730`). Con `postOnly: true` las ventas a 0,004 cruzan el libro y el venue las rechaza en cada tick (cuarentena por forma, ruido); con `postOnly: false` —también compartido tal cual— la venta LIMIT a 0,004 se ejecuta como taker al bid en cada recotización, `inventoryOf` valora la posición a 0,004 (`exposure ≈ 0`, `mm-shared.ts:72`), así que ni `atCap` ni `HIGH_RISK` la frenan: vende hasta `INSUFFICIENT_FUNDS`. Test: `sanitizeForShare(cfg V2 con override, marketMakerV2.meta.fields)` → `params.sourceSymbolOverride` debe ser `undefined` (marcar el campo como ligado al símbolo, igual que los `kind: 'price'`).
- **P-02 (Media)**: el redondeo a 2 decimales produce `'0.00'` / `'0.40'` en topes opcionales que nadie valida: `maxLongPosition: 200` sobre 50 000 de capital → ratio 0,004 → copiador con 100 → `'0.40'`; `validate()` acepta (min 0 sin comprobar) y `plan()` toma `'0.40'` como verdadero → `longCap = 0,4` → **cero compras para siempre sin nota ni evento** (sonda `probe-mm.cjs`: `validate.ok = true | bids = 0`). `orderSizePerSide` y `maxBotPositionValue` a `'0.00'` sí dan ERROR legible; `maxNotionalCap: '0.00'` se ignora (`common.ts:216-219`) ✓. Test: `expandFromShare` con capital pequeño → `validate()` debe rechazar un tope por lado menor que `orderSizePerSide`.
- **P-03 (Baja)**: `share-codec.spec.ts:252-259` barre seis estrategias y omite `MARKET_MAKER_V2`; sus dos campos `money` sí se convierten (mismo código), pero el test que promete «si mañana se añade una estrategia… lo detecta» no cubre la séptima.

## 5. A-20 — `apps/api/src/modules/advisor/build.ts`

- **Cadena real** (`advisor.service.ts:243-304`): `buildConfig` → `coerceConfig` (recorta a `min/max/step/options` del descriptor, `sanitize.ts:69-116`) → `enforceCouplings` (`:149-245`) → `validate()` (descarta con `VALIDACION`) → `preview()` (descarta con `VENUE` si hay violaciones) → `dentroDeLimites`. Ninguna configuración sale sin pasar `validate()` y `preview()` ✓.
- **`venue-matrix.spec.ts`** afirma: (1) si `validate()` pasa, los niveles del `preview()` cumplen tick/step/minQty/maxQty/minNotional derivados a mano (`:152-196`); (2) con 5 000 en BTC/ETH algún perfil sale (`:198-226`); (3) `leverage ≤ maxLeverage` del venue (`:228-243`). **No** afirma que lo generado valide (salta en silencio, `:171`) ni que `plan()` sea ejecutable —y ahí está MM-06—; capitales 50/200/1000/5000 (`:31`).
- **Market makers** (`build.ts:395-505`), rangos comprobados: `minAllowedDistanceBps = round(clamp(min(0,4·spread, spread − 1), 1, 500)) ≤ distancia` por construcción (`:410`; `enforceCouplings` lo repara además, `sanitize.ts:235-241`) ✓; `defensivo ≤ 94` y `alto = clamp(defensivo + 10, defensivo + 1, 100)` ✓ (`:442-443`); `refreshSeconds` múltiplo de 5 en [15, 720] ✓ (`:444,458`); `layers ≤ 10` (V1) / `≤ 3` (V2) ✓; `layerDistanceMultiplier ∈ [1, 3]`, `layerSizeMultiplier ∈ [0,1, 3]`, `inventorySkewFactor ∈ [0, 3]` ✓ (`:460-461,479`); V2: `feeEstimateBps 2`, `safetyBufferBps 1`, `minProfitMarginBps 8` → suelo `max(minDist, 12)`; `maxDynamicSpreadBps = round(clamp(4·spread, 13,5, 5000)) ≥ 14 > 12` ✓ y `distancia ≥ 16 > 12` → sin aviso de suelo ✓; `repriceThresholdBps ∈ [1, 1000]` ✓; `volatilityMultiplier ∈ [0, 5]` ✓; `leverage ≤ 3` (`:397`) ✓ coherente con «1x o 2x» de las docs.
- **Parámetros muertos (F-12) que el asistente sí rellena**: `fullCycleCooldownMinutes` (`build.ts:250`, GridMart, nadie lo lee), `reanchorOnDrift: AGRESIVA` y `reanchorThresholdPct` (`:331-332`, Neutral Grid, solo texto en `note`), `preloadInventory: false` (`:316`, Grid Classic, inerte pero en falso). → **P-04 (Media, extiende F-12)**: el asistente presenta como recomendación conductas que no existen.
- **MM-06 desde el asistente**: PRUDENTE → `CONSERVATIVE` (`:471-473`, `:485-487`) y `orderSizePerSide = floor(capital·lev / (capas·6))` (`:441`); el filtro `preview()` mira `porLado`, el bot manda `0,7 × porLado`. Caso computado en §1 A-9 (capital 150, lev 1, capas 2 → 12,50 → 8,75 < 10).
- **`limitAction: CLOSE_ALL` para PRUDENTE** (`:464`): es la acción que F-02 deja sin ejecutar en cuanto el usuario añade `stopLossPct` en el formulario; el asistente no pone `stopLossPct`, así que por sí solo no dispara F-02.
- **`MAX_SAFE_LEVERAGE = 18`** (`sanitize.ts:34`) frente a `risk.service.ts:86-93`: `estimateLiquidationPrice(1, lev, dir)` con MMR 0,005 → distancia `1/lev − 0,005`: 18× → 5,056 % (pasa), 19× → 4,763 % (403) ✓ coinciden; se aplica en `leverageFor` (`build.ts:116,121-123`) y otra vez en `enforceCouplings` (`sanitize.ts:158-161`); `advisor.spec.ts:172` lo afirma ✓.

## 6. A-21 — `apps/app/src/app/features/bots/bot-create.page.ts`

- **`fullConfig()`** (`:512-518`) = `config + exchangeAccountId + symbol`: la misma forma que valida `POST /bots/preview` tal cual (`bots.service.ts:157`) y que arma `create()` (`:704-708`) ✓.
- **Dos resultados, los dos se usan**: `livePreview` (local, en cada pulsación, `:594-604`) alimenta el panel de riesgo; el `preview` del servidor (`runPreview`, `:1075-1103`) es el que autoriza `canCreate` (`:757-770`) ✓ jerarquía correcta. `create()` vuelve a calcular un tercer preview con precio nuevo (`bots.service.ts:729-736`).
- **Pueden divergir** → **P-06 (Baja)**: la app usa `tickerOf(...).last` (`:345-350`); el servidor `ticker.mark` (Redis `crypton:px:*` `mark`, `bots.service.ts:1396-1399`, o `adapter.getTicker().mark`, `:1423-1424`). En Lighter `last = last_trade_price` y `mark = mark_price` (`lighter.ts:795,798`); en Hyperliquid ambos son el mid (F-25). En QUOTE el notional no depende del precio (cosmético); en BASE, `qty × precio ≥ minNotional` puede cambiar de veredicto entre el panel y el servidor cerca del mínimo. `PreviewBotDto` admite `refPrice` (`bots.service.ts:165-166`) y la app no lo manda (`:1082-1092`): mandarlo cerraría la deriva.
- **Fuente del `MarketSpec`**: la app (`toMarketSpec`, `market-spec.ts:17-38`, de `GET /markets`), la API (`markets.service.ts:98-118`) y el worker (`bot-store.ts:278-290`, refrescado cada `SPEC_REFRESH_EVERY_TICKS = 40` ticks) leen la **misma tabla `market`** ✓; solo difiere el instante.
- **Nada de Node en el navegador**: `grep -rn "node:|from 'fs'|from 'path'|from 'crypto'|process\.|Buffer\." packages/strategy-core/src` → vacío ✓; `index.ts` no exporta `testing.ts` (`:1-49`) ✓; sí exporta `venue-markets` (fixtures de tests) al bundle → **P-07 (Baja, tamaño)**. `@crypton/shared` solo depende de `decimal.js` ✓. La app resuelve los dos paquetes como fuente (`apps/app/tsconfig.json:11-13`) ✓.
- Validación: la app pinta solo `ERROR` en línea y `WARNING` aparte (`:527-580`) y el 400 del servidor llega con `issues` al toast (`:1095-1099`) ✓.

## 7. A-22 — `packages/backtest/src/engine.ts` y `ticks.ts`

- **Sí comparte**: `withStopLoss` (`:370-375`), `revisarOrden(market, o, true)` (`:414`; `entradasVivas` siempre `true`, así que `RESTO_INCERRABLE` no existe y una salida bajo mínimo se descarta con una línea de aviso, `:416-418`), el redondeo (es el propio `plan()`), `reconcile` con `ownIds` exacto (`:381-389`), `cycleAfterFill` con `cooldownMinutes` de la config (`:216-225`; el runner lo lee del scratch, mismo valor), `cycleId` `'bt-1'` → `null` al cerrar (F-15 de Grid Classic; los market makers no leen `cycleId`) n/a. Comisiones maker/taker, slippage y MMR plano vienen de `params` (`:120-131`).
- **Declarado en `warnings.ts`**: orden dentro de la vela (`:18-20`), sin profundidad ni parciales —«un market maker sale mejor parado»— (`:23-26`), MMR plano ≈ 0,5 % (`:29-31`), precios de otra fuente (`:34-36`), sin funding (`:39-41`), ficha de hoy (`:44-45`), guardas de **cuenta** (`:48-49`), margen retenido (`:52-53`), comparar con hold (`:56-57`).
- **P-08 (Alta; Crítica en real, rebajada por afectar solo a simulación; confirmada con sonda local)**: `DryRunAdapter.placeOrder` ejecuta al instante todo `type: 'MARKET'` (`dry-run.ts:451-463`) e **ignora `triggerPrice`** (cero apariciones en `dry-run.ts`; solo los adaptadores reales lo traducen: `hyperliquid.ts:558-562`, `lighter.ts:1139-1160`, `aster.ts:603-604`). El stop que inyecta `withStopLoss` es `MARKET` + `triggerPrice` (`stop-loss.ts:63-67`). Sonda `probe-dryrun-stop.cjs` (scratchpad, sin red, contra `dist`): largo 1 BTC a 100,15; stop generado `SELL MARKET 95.2 trigger 95.2`; `placeOrder` → **`ack FILLED`, posición plana, `realizedPnl −0,40`** con el precio en 100. Afecta al backtest (`engine.ts:423-432`, que además **ni pasa `triggerPrice`**) y al modo simulación del worker (`account-hub.service.ts:265` crea `DryRunAdapter`; `place()` no distingue paper de real). Consecuencia: **todo backtest y todo bot de simulación con `stopLossPct` cierran la posición a mercado (taker + slippage) en el primer plan tras cada entrada**, y el resultado enseña un bot que «entra y sale» sin que ninguna advertencia lo diga. Sin test: `exchange-core.spec.ts` tiene 37 menciones de `DryRunAdapter` y ninguna de stop o trigger. Test propuesto: `placeOrder({ type: 'MARKET', triggerPrice: '95', reduceOnly: true })` con `mark = 100` debe quedar `OPEN` y ejecutarse solo cuando `mark ≤ 95` (y al revés para `BUY`). Corresponde a la línea B/C (simulador), se anota aquí porque rompe la paridad A-22.
- **P-09 (Media): huecos de paridad no declarados** para los market makers:
  1. `fairPrice` es la propia serie reproducida (`:326-329`): una V2 anclada a Binance es indistinguible de `EXCHANGE` en el replay, y la tesis «el DEX se desvía del mercado global» no se puede probar.
  2. **Un `plan()` por vela** (`:349-354`) con `now = bar.t + span − 1`: `quotedAt` es el final de la vela anterior → `now − quotedAt = span` → con velas de 5 m `staleByTime` es siempre cierto (`refreshSeconds` 30 no significa nada) y `fillCooldownSeconds: 35` nunca está activo al planificar (el fill más tardío es `t + 225 s`, el plan en `t + 299 s`); la ventana de volatilidad de 300 s contiene ≤ 2 muestras → `volBps ≈ |Δcierre|`.
  3. **`orderMaxAgeSeconds: 120` (defecto V2) con velas de 5 m**: la orden colocada al final de la vela `i` tiene 300 s de edad al final de la `i + 1` → caduca → no se desea → se cancela; se repone en la `i + 2` → **cotiza solo en vela alterna** (mitad del tiempo sin órdenes). Con velas de 1 m, dos de cada tres. El resultado del backtest de una V2 «de fábrica» no es el de un bot que cotiza continuamente.
  4. El encabezado (`:39`) declara «3. guardas de riesgo ← `checkRiskGuards` (el subconjunto puro)» y **no hay ninguna guarda** en `runReplay` (grep `liquidationAction|maxDailyLossPct|killSwitch|drawdown|maxNotional`: vacío); `warnings.ts:48-49` solo declara las de cuenta. `liquidationAction: CLOSE_ALL/PAUSE`, `maxDailyLossPct` y el kill-switch por bot no se simulan ni se avisan.
  5. Los rechazos del simulador se tragan (`:433`, `.catch(() => undefined)`): una POST_ONLY que cruza desaparece sin aviso, mientras el motor real emite `ORDER_REJECTED` y pone la forma en cuarentena.
  6. El simulador sí honra `createdAt` (`dry-run.ts:483`), así que `orderMaxAgeSeconds`/`exitOrderTtlSeconds` «funcionan» en replay y no en Lighter real (MM-05): el backtest no reproduce la producción de ese venue.
- `ticks.ts`: `tickerAt` pega `bid`/`ask` al extremo de la mecha y pone `mark` en el extremo (`:74-96`) ✓ coherente con «los venues liquidan en la mecha»; `spreadBps` sintético alimenta `bookSpreadBps` (`autoAdjustDistance`) sin declararlo (menor).

## 8. Sondas locales (scratchpad, sin red, contra los `dist` ya compilados de la línea base)

- `review/probe-mm.cjs` (funciones puras de `strategy-core`): confirma MM-01, MM-03, MM-04, MM-06, MM-08 (`repriceThresholdBps 0`, `maxLongPosition 0.40`), MM-09, MM-14, MM-17 y MM-18 con los números citados arriba.
- `review/probe-dryrun-stop.cjs` (`DryRunAdapter` + `withStopLoss`): confirma P-08 (`ack FILLED`, posición plana con el precio a 5 % del disparo).
- No se ha ejecutado jest ni se ha tocado el repositorio.

## 9. Hallazgos

| id | título | severidad | evidencia | impacto | test propuesto |
|---|---|---|---|---|---|
| MM-01 | `fillCooldownSeconds` inerte con `referencePrice` (V1) | Media (F-15 confirmado) | `market-maker.ts:652-654,667,690-698` | la espera prometida no ocurre y la nota nunca lo dice | `plan({ referencePrice, fillCooldownSeconds: 60 }, { lastEntryAt: now − 5 s })` → `note` contiene «espera» (hoy no; sonda) |
| MM-02 | `refreshMs = max(5, …)` frente a validación ≥ 15 (V1/V2) | Baja (F-15) | `market-maker.ts:651`, `market-maker-v2.ts:989`, `:529-536` | inerte hoy | test de que `refreshMs ≥ 15 000` para cualquier config válida; constante única |
| MM-03 | topes por lado mudos: `atCap`, régimen y sesgo miran solo `maxBotPositionValue` (V1) | Media (F-15) | `market-maker.ts:703-704,710,774,809` | con `maxLongPosition` bajo: sin compras, sin `limitAction`, régimen NORMAL, nota «25 % del tope» | sonda: bids 0, immediate 0, nota sin «Tope»; test que exija breach o nota |
| MM-04 | cada par casado cierra el ciclo: cancela y repone todas las capas y borra `quotedMid`, `lastEntryAt`, `volSamples`, `armedAt` | Media (candidata a Alta por caudal) | `cycle-accounting.ts:153,186-213`; `bot-store.ts:683,692`; `reconcile.ts:102-111`; `bot-runner.ts:579` | `2·layers` cancelaciones + colocaciones por vuelta, prioridad perdida, sin espera tras el fill de cierre; V2 sin volatilidad tras cada vuelta | sonda: `toCancel 6 / toPlace 6`; regresión al arrastrar el scratch o no cerrar ciclo en market makers |
| MM-05 | Lighter pone `createdAt: Date.now()` en cada sondeo: `exitOrderTtlSeconds` y `orderMaxAgeSeconds` muertos en ese venue | Alta | `lighter.ts:1902-1921`; `zklighter-sdk/dist/api.d.ts:487-489`; `mm-shared.ts:163-182`; `aster.ts:973` (parcial) | parámetro documentado (120 s por defecto en V2) sin efecto; el backtest sí lo aplica | `exchange-core.spec.ts`: `toVenueOrder` con `created_at = X` → `createdAt = X` (unidad por confirmar en C-8) |
| MM-06 | `preview()` omite `profile.size`: config válida y previsualizada cuyo `plan()` no coloca nada | Alta | `market-maker.ts:587,728`; `market-maker-v2.ts:905,1071`; `order-gate.ts:56-63`; `build.ts:441,471-473` | conservador con tamaño en [minNotional, minNotional/0,7): cero cotizaciones en ambos lados; el asistente puede generarlo (150 USDC, 1×) | sonda: preview válido + `ENTRADA_INVALIDA` en las dos caras; test preview ≡ plan en notional por capa |
| MM-07 | `preview` suma las dos caras como entradas, promedia compras con ventas y estima liquidación LONG aislada (NEUTRAL, CROSS por defecto) | Media (extiende F-14) | `market-maker.ts:600-624,627-634`; `market-maker-v2.ts:923-957`; `common.ts:313-342` | peor caso ×2, precio medio sin sentido, liquidación de un escenario imposible | preview NEUTRAL 3 × 50 → `worstCaseNotional` 150, no 300 |
| MM-08 | `validate()` no acota lo que `meta.fields` declara (F-13): `repriceThresholdBps 0`, `maxLong/ShortPosition 0.00`, `inventorySkewFactor < 0`, `stopLossPct > 100`, `layer*Multiplier`, `volatility*`, `fee*`, enums, booleanos | Media | tablas de §1 A-10 y §2 A-10 | recotizar en cada tick; una cara muerta sin aviso; sesgo invertido; stop no colocado | validador genérico sobre `meta.fields`; sondas: `repriceThresholdBps 0` y `maxLongPosition 0.40` pasan `validate()` |
| MM-09 | techo `maxDynamicSpreadBps` aplicado antes de capa, preset y régimen (V2) | Media (F-15) | `market-maker-v2.ts:686-689,1096-1099,1138-1141`; `docs/market-maker-v2.md:164` vs `:369,486`; guía `:208` | conservador: 150 bps con techo 100; defensivo ×1,5; doc que se contradice | sonda: bid 99,2 con techo 50 y CONSERVATIVE (esperado ≥ 99,5) |
| MM-10 | `feeEstimateBps` por defecto 0: el suelo se reduce a `minProfitMarginBps` | Media (F-15; decisión del usuario) | `market-maker-v2.ts:784`; `docs:193-197,413-421`; `build.ts:399,491` | la garantía central de la V2 apagada de fábrica | decidir defecto (el asistente usa 2 bps) o hacer el campo obligatorio |
| MM-11 | agravante de F-02: `limitActionFiredAt` se escribe aunque `place()` vete el aplanado; con `SHUTDOWN` el bot se para con posición abierta | Alta (viaja con F-02) | `market-maker.ts:829-841`; `market-maker-v2.ts:1176-1188`; `mm-shared.ts:397,410`; `bot-runner.ts:672-676` | el cierre no se reintenta en toda la vida del ciclo; «cerrando y apagando» con posición | marcar `limitActionFiredAt` solo tras el ack; ampliar el test de F-02 |
| MM-12 | `VENUE_MARK` ≡ mid en Hyperliquid mientras la guía promete «más estable que el medio» | Baja (consecuencia de F-25) | `market-maker-v2.ts:759`; `hyperliquid.ts:436`; guía v2 `:244`; `docs:578` | opción sin efecto en un venue | test de F-25 |
| MM-13 | textos: `referencePrice` «la app avisa» (no hay aviso), `direction` «deshacer la contraria» (no lo hace), inventario valorado al ancla y no al mercado | Baja | `market-maker.ts:541-549`; `docs/market-maker.md:467`; guía v1 `:213-218`; guía v2 `:288-293`; `mm-shared.ts:70-76` | usuario mal informado | añadir aviso de deriva del ancla; corregir guías |
| MM-14 | recorte al hueco por debajo de `minNotional` (V2, `useFullSizeUntilMax: false` por defecto) | Media | `market-maker-v2.ts:1109-1114,1229-1239`; `order-gate.ts:56-63`; `bot-runner.ts:826,845,976-978` | un WARN `ORDER_UNVIABLE` por recotización; la capa prometida nunca sale | sonda: 5 USDC → `ENTRADA_INVALIDA`; test: descartar restos < `ctx.market.minNotional` |
| MM-15 | `maxDynamicSpreadBps: '0'` desactiva el techo en silencio (V2) | Baja (parte de MM-08) | `market-maker-v2.ts:686-687,865-866` | guarda apagada por un valor fuera del descriptor (min 1) | validar `≥ 1` |
| MM-16 | V2 no valida `minAllowedDistanceBps ≤ distancias` y el aviso atribuye el suelo a «comisión y margen» | Baja | `market-maker-v2.ts:850-863`; `docs:411` | aviso engañoso | mensaje que distinga la causa |
| MM-17 | `volBps` se recalcula en cada tick sobre el anillo podado y mueve los precios sin recotizar (V2) | Media | `market-maker-v2.ts:1034,1045-1051,1065-1066,1100`; `mm-shared.ts:296-304` | cancelar/reponer todas las capas en ticks intermedios (en tendencia, hasta duplicar el churn); contradice su propio comentario | sonda: bid 99,0 → 99,6 sin recotizar; test: precios estables entre recotizaciones |
| MM-18 | `armedAt` se pierde al cerrar ciclo: el bot se duerme tras su primera vuelta si el precio retrocede (V2) | Media | `mm-shared.ts:353,367`; `bot-store.ts:692`; `docs:92`; guía `:262` | «una vez armado se queda armado» es falso | sonda: ciclo 2 → «Esperando a que el precio baje a 90» con 0 órdenes |
| P-01 | `sourceSymbolOverride` viaja tal cual al copiar del ranking | Media (Alta con `postOnly: false`) | `share-codec.ts:75`; `market-maker-v2.ts:576-584,707-730`; `bot-runner.ts:1775-1780` | ancla del par equivocado; ventas taker en bucle si no es post-only | `sanitizeForShare` excluye el campo (marcarlo ligado al símbolo como los `kind: 'price'`) |
| P-02 | `toFixed(2)` al copiar produce `'0.00'`/`'0.40'` en `maxLong/ShortPosition`, que nadie valida | Media | `share-codec.ts:92-97`; `market-maker.ts:703-704,774` | una cara muerta sin aviso (sonda) | validar tope por lado ≥ `orderSizePerSide` |
| P-03 | `share-codec.spec.ts` no barre `MARKET_MAKER_V2` | Baja | `share-codec.spec.ts:252-259` | cobertura | añadir la séptima al bucle |
| P-04 | el asistente rellena parámetros muertos (F-12) | Media (extiende F-12) | `build.ts:250,316,331-332` | recomendaciones con conductas inexistentes | no emitir esos campos hasta implementarlos |
| P-05 | — (fusionado en MM-06: el asistente puede producir el caso conservador) | — | `build.ts:441,471-473` | — | — |
| P-06 | la app previsualiza con `last` y la API con `mark` | Baja | `bot-create.page.ts:345-350`; `bots.service.ts:1396-1424`; `lighter.ts:795,798` | previews distintos cerca del mínimo con `sizingMode: BASE` | mandar `refPrice` en `POST /bots/preview` |
| P-07 | `venue-markets` (fixtures) exportado al bundle del navegador | Baja | `strategy-core/src/index.ts:41` | tamaño | export aparte |
| P-08 | `DryRunAdapter` ejecuta el stop-loss al instante: ignora `triggerPrice` y trata `MARKET` como ejecución inmediata | Alta (Crítica en real, rebajada por afectar solo a simulación; confirmada con sonda) | `dry-run.ts:451-463`; `stop-loss.ts:63-67`; `engine.ts:423-432`; `account-hub.service.ts:265`; `exchange-core.spec.ts` (sin test de trigger) | todo backtest y todo bot de simulación con `stopLossPct` cierran cada entrada a mercado con taker y slippage; el resultado miente sin aviso | `exchange-core.spec.ts`: `MARKET` + `triggerPrice` queda `OPEN` y se ejecuta al cruzar `mark`; `engine.ts` debe pasar `triggerPrice` |
| P-09 | huecos de paridad del backtest no declarados: `fairPrice` = la serie, un plan por vela (refresco/espera/volatilidad sin sentido), `orderMaxAgeSeconds` alterna velas, guardas por bot inexistentes pese al encabezado, rechazos tragados, edades que Lighter real no tiene | Media | `engine.ts:39,326-329,349-354,433`; `warnings.ts:48-49` | una V2 «de fábrica» en velas de 5 m cotiza en vela alterna y sin volatilidad; guardas que el usuario cree simuladas | ampliar `fidelityWarnings`; test: replay V2 con 5 m cuenta órdenes vivas por vela |

Severidades por la escala de `specs/README.md`: Alta = pérdida acotada/probabilística, red documentada muerta o bot muerto en una configuración; Media = degradación visible, parámetro a medias, deriva o doc que confunde; Baja = textos y tests. Ninguna cumple las tres condiciones de Crítica en operación real; P-08 lo sería en real y se rebaja un nivel por afectar solo a simulación.

## 10. Verificado OK

- **Escalera V1**: geometría sin normalizar, 20/30/45 bps con multiplicador 1,5, perfil ×1,5/×0,7 y ×0,7/×1,3, tamaño 25 × 0,7 = 17,5; los ejemplos de `docs/market-maker.md` (configuraciones A y B) se reproducen con el código (`market-maker.ts:726-728,751-825`; `mm-shared.ts:28-32`).
- **Sesgo y ensanchamiento V1**: `centro = mid × (1 − skew × ratio × media_bps / 10 000)`, `× (1 + |ratio|)`, exactamente como `docs:94,104` (`market-maker.ts:716-724`).
- **`composeSpreadBps`**: reproduce los números de la guía (54,25 → «54») y de la doc (39,5 → 59,25 con conservador); el suelo se aplica después de los multiplicadores, así que `HIGH_RISK` reduciendo (×0,5) nunca baja del suelo (`market-maker-v2.ts:666-690,1096-1099`).
- **Stop loss**: inyectado con el signo de la posición real, `reduceOnly`, `triggerPrice`, redondeo conservador (un tick más cerca de la entrada, dispara antes); la estrategia no lo duplica en `orders` (`stop-loss.ts:30-73`).
- **`reduceOnly`** solo en `HIGH_RISK` y en el aplanado, documentado (`docs:85,137`).
- **`clientOrderId`**: misma expresión `Number(scratch.cycleSeq ?? 0)` en `plan()`, en el tick, en `place()` y en `withStopLoss`; ids `QB{l}`/`QA{l}` con `l < 10`, sin colisiones dentro de `orders`; la única colisión `orders` × `immediate` es F-02 (`client-order-id.ts:52-59`; `bot-runner.ts:568,643,821`).
- **`reusesOrderSlots`**: el motor permite recolocar un id `FILLED` solo en reconciliadas y nunca en inmediatas (`bot-runner.ts:760,767-782,861-866`).
- **BASE / QUOTE**: los topes comparan notional en la quote en los dos modos, en V1 y V2 (`mm-shared.ts:144-152`; tests `strategies.spec.ts:969-973,1288-1307`).
- **`priceBand`** corta solo el lado que abre; **`riskRegime`** con `≥` en ambos umbrales y `REGIME_DISTANCE` 1,5/0,6 y 0/0,5 como las docs (`mm-shared.ts:87-133`).
- **`expiredQuotes`**: el mismo conjunto decide recotizar y dejar de desear; regresión cubierta (`strategies.spec.ts:1208-1239`).
- **Sin ancla externa** (`resolveAnchor` null): no se cotiza, no se cae en silencio al mid local, hay nota y evento con causa cada 5 min (`bot-runner.ts:1818-1830`); feed compartido por clave con refcount, retroceso ante 429/418/403/451 y semilla desde Redis (`price-source.service.ts:174-226,276-347`); `syncFairPrice` reabre el feed al cambiar en caliente los campos de fuente (`bot-runner.ts:1800-1809`).
- **`sampleVolatility`**: `(max − min) / media` en bps, ventana en segundos, tope de 240 muestras, sin escritura en la base cuando no se recotiza (`mm-shared.ts:286-321`; tests `:1151-1195`).
- **`activationGate`**: pegajoso dentro del ciclo; `validate()` exige precio de disparo con condición (`market-maker-v2.ts:879-889`).
- **`validateFairSource`**: forma del símbolo y aviso de origen incoherente (`market-maker-v2.ts:707-747`; tests `:1354-1390`).
- **`validate()` V1**: `minAllowed ≤ distancias`, `defensive < high`, `floor < ceiling`, `refresh ≥ 15`, capas 1..10, aviso «capas > tope»; **V2**: `cap ≥ suelo`, aviso «suelo > distancia» (`market-maker.ts:491-574`; `market-maker-v2.ts:814-892`).
- **Asistente**: rangos de los market makers por construcción (`minAllowed ≤ distancia`, `defensivo < alto`, refresco múltiplo de 5, `cap ≥ suelo`, apalancamiento ≤ 3), `MAX_SAFE_LEVERAGE = 18` idéntico a la regla del 5 % de `risk.service.ts` con MMR 0,5 %, y `validate()` + `preview()` antes de ofrecer nada (`build.ts:395-505`; `sanitize.ts:34,149-245`; `advisor.service.ts:243-304`).
- **App**: `fullConfig()` tiene la misma forma que valida la API; el preview del servidor es el que autoriza crear; los tres consumidores leen el `MarketSpec` de la misma tabla; `strategy-core` no usa nada de Node y no exporta `testing.ts` (`bot-create.page.ts:512-518,757-770`; `market-spec.ts`; `markets.service.ts:98-118`; `bot-store.ts:278-290`).
- **Backtest**: comparte `withStopLoss`, `revisarOrden`, `reconcile` con `ownIds` exacto y `cycleAfterFill`; `tickerAt` pega `bid`/`ask`/`mark` a la mecha; los nueve avisos de `fidelityWarnings` son correctos en lo que dicen (`engine.ts:216-225,370-389,414`; `ticks.ts:66-99`; `warnings.ts`).
- **`share-codec`**: lista blanca por `FieldMeta`, `money` a proporción, sin `totalInvestment` ni `originalInvestment`; los dos campos `money` de cada market maker se convierten (`share-codec.ts:51-79`).
- **Estadísticas de market making**: `bumpMmStats` en la misma transacción que el ciclo; `trackMmPeaks` escribe solo cuando sube el máximo; `feesPaid` conserva el signo del venue (`bot-store.ts:733-820`).
- **Dinero sin coma flotante**: en `market-maker.ts`, `market-maker-v2.ts` y `mm-shared.ts` solo hay `Math.max/floor` sobre segundos y contadores; todo importe es `Decimal`.

Fin del informe de la línea A (market makers y paridad A-19…A-22).

