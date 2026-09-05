# Revisión integral — Fase 3, línea A (grids, martingale, tdca + piezas comunes A-15…A-18)

Fecha: 2026-09-05. Modo: solo lectura sobre el repo (`D:\WORK\PERSONAL\CRYPTON`), sin red.
Alcance: R-3 de `specs/001-revision-integral/spec.md`, items A-1…A-18, semillas F-03, F-12, F-13, F-14, F-15, F-30 y «semillas menores».
Nota: F-02 / B-02b (colisión de coid en el flatten de MM) ya está trazada por la revisión del engine; no se repite aquí.

Convención de citas: `fichero:línea` relativo a la raíz del repo. Severidades según `specs/README.md`.


---

## 1. Grid Classic (`packages/strategy-core/src/strategies/grid-classic.ts`)

Promesa (guía `apps/app/src/app/core/content/grid-classic.guide.ts`): «Parte un rango en niveles y pone una compra en cada uno. Cuando una se ejecuta, coloca su venta un escalón más arriba» (:5-6); «El capital asignado se reparte a partes iguales entre todos los niveles» (:12); «El nivel queda libre y vuelve a colocar su compra» (:14); «upperPrice: Por encima de él ya no hay ninguna línea» (:83); `preloadInventory`: «Hoy no cambia nada: el motor no precarga inventario» (:103); riesgo etiquetado «BAJO» (:7). Ayuda de `maxNotionalCap` (`apps/app/src/app/core/utils/field-labels.ts:28-29`): «Tope duro: el motor no coloca nada que lo supere, pase lo que pase con el resto de ajustes».

| Ítem | Qué hace (fichero:línea) | Qué promete | Veredicto |
|---|---|---|---|
| A-1 Entrada | Solo `orders` `POST_ONLY` `GRID_BUY` en las líneas del lado de entrada (`isEntryLine = isLong ? p.lt(ref) : p.gt(ref)`, :313; :316-325). `immediate` se declara (:298) y nunca se rellena. **No mira `cycle.cooldownUntil`** en ningún punto de `plan()`. | «compra limitada en cada línea por debajo del precio» (guía :12). `cooldownMinutes` está en `COMMON_FIELDS` (`common.ts:146-158`, HOT, «Espera entre ciclos»). | Mecanismo **OK**. **Hallazgo A-11-GC-1**: `cooldownMinutes` es parámetro muerto en Grid Classic (nadie lo lee; el ciclo sí se cierra al quedar plana la posición, `cycle-accounting.ts:153`, y `bot-store.ts:682` guarda `cooldown_until`, pero el plan lo ignora). |
| A-2 Escalera | `gridPrices` :131-136 → `arithmeticPrices`/`geometricPrices` (`ladder.ts:12-30`, extremos incluidos, `Decimal`). `levelQty` :146-151: `perLevelNotional = totalInvestment × leverage / levels`; denominador = precio de la línea (QUOTE) o **`refPrice`** (BASE). En `plan()` `ref = ctx.ticker.mark` (:288, :310); en `preview()` `ref = refPrice` de creación (:254, :260). Tope: `capReached = notionalActual ≥ cap` (:305-307) es una **puerta binaria** sobre la posición ya abierta, no un recorte de lo que se tiende. | «reparte a partes iguales» (guía :12). `maxNotionalCap`: «Tope duro de notional. El motor no coloca nada que lo supere» (`shared/bot.ts:38`, `field-labels.ts:29`). | Reparto **OK** (notional = `totalInvestment × leverage`, margen = `totalInvestment`). **Hallazgo F-03** (BASE, ver §Semillas). **Hallazgo A-2-GC-2**: con posición 0 y `maxNotionalCap = 100`, un grid de 20 líneas × 60 USDC tiende las 20 (1 200 USDC de compras vivas): el tope solo actúa *después* de superarse. Martingale sí recorta por notional proyectado (`martingale.ts:357-361`). Promesa de `bot.ts:38` incumplida. |
| A-2 (última línea) | `sellPriceFor` :158-163: la salida de la línea superior se proyecta a `upper + (upper − prev)`, **fuera del rango**. | «Por encima de él ya no hay ninguna línea» (guía :83). | Baja: contradicción documental; la orden se coloca fuera del rango declarado. |
| A-3 Take profit | Por línea: `GRID_SELL#i` en `sellPriceFor` (LONG) / `buyPriceFor` (SHORT), `reduceOnly: true`, `POST_ONLY` (:328-340). Cantidad = `levelQty` **recalculada en el tick** (:310), no la comprada. Redondeo `px(exit side)`: venta ↑ / compra ↓ (`precision.ts:20-23`), lado seguro. | «coloca su venta en la línea inmediatamente superior» ✓ | **OK** en QUOTE (misma fórmula que la compra → misma cantidad). En BASE la cantidad de la venta sigue al mark y ya no coincide con lo comprado (F-03). Nota: `filledLevelIndexes` se marca al **primer** fill, aunque sea parcial (`cycle-accounting.ts:145`): un parcial cancela el resto de la compra y coloca la venta por la cantidad **entera** del nivel (reduce-only la acota al venue). |
| A-4 Stop loss | No lo emite (correcto). Lo inyecta `withStopLoss` (`stop-loss.ts:30-73`) sobre `position.qty`/`entryPrice` reales, `type MARKET` + `triggerPrice`, `reduceOnly: true`, guarda de duplicado por `desired.orders.some(STOP_LOSS)` (:48). Redondeo `px(exitSide)`: LONG→SELL→↑, SHORT→BUY→↓ → el disparo queda **un tick más cerca de la entrada** (salta antes, pérdida menor). | — | **OK**. La «semilla menor» del lado del redondeo se REFUTA como riesgo: es el lado conservador. |
| A-5 Safety / recompra / reanclaje | Sin seguridades. La «recompra» es el reciclado del nivel: `recycleLevelOnExit: true` (:179) → `cycle-accounting.ts:146-148` libera el índice al ejecutarse `GRID_SELL#i`, y `bot-store.ts:1036-1038` aplica la misma regla al reparar. `REANCHOR_GRID` (`bot-runner.ts:1294-1311`) fija `anchorPrice` (Grid Classic no lo usa) y **vacía `filledLevelIndexes`** conservando la posición. La app ofrece el comando para cualquier estrategia (`bot-detail.page.ts:98`). | «El nivel queda libre y vuelve a colocar su compra» ✓ | Reciclado **OK**. **Hallazgo A-5-GC-3** (Alta): «Recentrar la retícula» sobre un Grid Classic con inventario deja la posición **sin ninguna venta** (no hay `holding`) y **vuelve a tender la compra** de cada nivel ya comprado: exposición duplicada por nivel, y el inventario previo queda sin contrapartida hasta que el precio vuelva a bajar y suba. |
| A-6 Ciclo y cooldown | El ciclo cierra cuando `nextQty < QTY_EPSILON` (`cycle-accounting.ts:153,192-213`): en un grid ocurre **cada vez que se vende todo el inventario**. Al cerrar, `cycleId: null` (:195) y `cycleSeq+1`. `plan()` :291: `seq = cycleId ? scratch.cycleSeq : 0`. | — | **Hallazgo F-15** (ver §Semillas): tras el primer cierre el motor reconcilia con `cycleSeq = N` y la estrategia emite ids con `seq = 0`. Cooldown: ignorado (A-1). |
| A-7 Dirección | LONG/SHORT espejo correcto: entradas `entrySide`, salidas `exitSide`, líneas de entrada por encima del mark en SHORT (:313, :320, :329, :334). `direction` no se valida (`validateCommon` no mira `options`): `NEUTRAL` → `isLong = true` (:289). Etiquetas: en SHORT la **venta** de entrada es `GRID_BUY` y la **compra** de salida `GRID_SELL` (:317, :331). | Guía :72 «En corto todo se invierte» ✓ | Espejo **OK**. Etiquetas: Baja (cosmético; `ENTRY_KINDS` clasifica bien porque GRID_BUY *es* la entrada). `NEUTRAL` aceptado sin error: entra en F-13. |
| A-8 reduceOnly | Entradas `false` (:324), salidas `true` (:338). | — | **OK** |
| A-9 preview ≡ plan | Misma `levelQty` y `gridPrices`; misma clasificación de línea de entrada por `refPrice` (:262) que por `mark` (:313); mismo `px/qy` vía `normalizeOrder`. **Peor caso**: `buildPreview` solo acumula `isEntry` = líneas del lado de entrada *en el momento del preview* (:271, `common.ts:317-321`). Liquidación: `estimateLiquidationPrice(worstAvg, lev, dir)` (`common.ts:342`), fórmula aislada (Grid Classic es ISOLATED por defecto, :189). | Guía :42 «Si BTC pierde los 72.000, te quedas con las veinte compras hechas y 1.200 USDC» (peor caso = TODAS las líneas). | **Hallazgo A-9-GC-4** (Media): el preview subestima el peor caso. Ejemplo de la guía (72 000–86 000, 20 niveles, 600 USDC, 2x, precio 78 910): líneas por debajo = k=0..9 → 10 → `worstCaseNotional = 600`, `worstCaseMargin = 300`; el peor caso real es 1 200 / 600 (la guía lo dice bien, el preview no). El precio medio y la liquidación estimada salen del subconjunto. En BASE además cambia la cantidad (F-03). |
| A-10 validate | `validate` :194-245 + `validateCommon` (`common.ts:191-240`). Acota: `lowerPrice`/`upperPrice` > 0 y orden, `gridLevels` 3..200, paso ≥ 2 ticks, aviso paso < 0,05 %. **No acota**: `gridSpacing.options`, `sizingMode.options`, `direction.options`, `marginMode.options`, `leverage.max=50`/`step=1` (solo `≥1` y `≤ market.maxLeverage`), `totalInvestment.min=10` (solo `>0`), `stopLossPct` 0,1..90 (**nada**), `maxDailyLossPct` 0,1..100, `liquidationAction.options`, `cooldownMinutes` 0..10080. | «`validate()` acota todo lo que `meta.fields` declara» (R-3 A-10). | **Hallazgo F-13** (lista completa en §Semillas). Lo peor: `stopLossPct = 100` pasa la validación y `stopLossPrice` da 0 → `px` → `revisarOrden` `IMPOSIBLE` → **sin stop** y solo un WARN. |
| A-11 Parámetros muertos | `preloadInventory` solo produce un aviso (:239-243); `plan()` no lo lee. `cooldownMinutes` no se lee. `maxNotionalCap` actúa a posteriori (A-2). `stopOnRangeExit` ✓ (:303). `sizingMode` ✓ (:149). | Guía :103-104 admite `preloadInventory` muerto. | **F-12 CONFIRMADO** para `preloadInventory` (documentado) y ampliado a `cooldownMinutes`. |
| A-12 coid / cycleSeq | `GB i` y `GS i` por índice (:317, :331); nunca hay `immediate`, así que no hay colisión `orders`×`immediate`. `seq` :291 diverge del motor (`bot-runner.ts:568,821`) en cuanto `cycleId` es `null`. | Mismo cálculo que motor y backtest (A-12). | **Hallazgo F-15** (Crítica por confirmar en HL/Lighter; ver §Semillas). |
| A-13 Comisiones / funding / slippage | Único supuesto explícito: aviso si el paso < 0,05 % «puede no cubrir ni las comisiones» (:226-236). Funding no aparece en código ni guía. `cycle-accounting.ts:123` resta `fill.fee` del realizado. | Guía :42 «0,55 USDC menos comisiones» (60 × 0,93 % = 0,56 ✓). | Baja: un grid perp LONG paga funding mientras retiene inventario y no se cuenta al usuario en ninguna parte. El umbral 0,05 % es el mínimo aceptable (maker+maker en HL ≈ 0,03 %). |
| A-14 `onFill` / slots | Sin `onFill`. `reusesOrderSlots: true` + `recycleLevelOnExit: true` (:178-179); `place()` permite recolocar un id `FILLED` solo con la bandera (`bot-runner.ts:861-866`); `upsertPendingOrder` reencarna la fila a 0 (`bot-store.ts:331-342`). | Comentario `types.ts:42-52`. | **OK**, coherente. |

Comprobación numérica de la guía (ejemplo 1: 72 000–86 000, 20 niveles, 600 USDC, 2x, BTC 78 910): paso = 14 000/19 = 736,84 («unos 737» ✓); 0,93 % ✓; notional por línea = 1 200/20 = 60 ✓; líneas por debajo del precio: `72 000 + k·736,84 < 78 910 → k ≤ 9` → 10 («unas diez» ✓); peor caso 20 × 60 = 1 200 ✓. La guía es coherente con `plan()`; el que no lo es, es el preview (A-9-GC-4).

### Grid Classic — tests propuestos (`packages/strategy-core/src/strategies.spec.ts`, bloque `gridClassic.plan`)

```ts
it('el id de nivel lleva el mismo cycleSeq que el motor aunque el ciclo no tenga id', () => {
  // Tras cerrar un ciclo, `cycleAfterFill` devuelve `cycleId: null` y el motor
  // reconcilia con `scratch.cycleSeq`; el plan no puede irse a 0.
  const plan = (cycleId: string | null) =>
    getStrategy(StrategyKind.GRID_CLASSIC).plan(
      makeContext({ strategy: StrategyKind.GRID_CLASSIC, config, price: '100',
        cycle: { cycleId, scratch: { cycleSeq: 3 } } }),
    );
  const conId = plan('c-3').orders.map((o) => o.clientOrderId);
  const sinId = plan(null).orders.map((o) => o.clientOrderId);
  expect(sinId).toEqual(conId);                                   // hoy falla: seq 0
  expect(parseCoid(sinId[0])!.cycleSeq).toBe(3);
});

it('en modo BASE la cantidad no cambia con el mark', () => {
  const at = (price: string) =>
    getStrategy(StrategyKind.GRID_CLASSIC).plan(
      makeContext({ strategy: StrategyKind.GRID_CLASSIC,
        config: cfg({ ...(config as object), sizingMode: 'BASE' }), price }),
    ).orders.map((o) => o.qty);
  expect(at('100')).toEqual(at('99'));                            // hoy falla (F-03)
});

it('el tope de notional acota lo que se TIENDE, no solo lo ya abierto', () => {
  const ctx = makeContext({ strategy: StrategyKind.GRID_CLASSIC,
    config: cfg({ ...(config as object), maxNotionalCap: '30' }), price: '100' });
  const buys = byKind(getStrategy(StrategyKind.GRID_CLASSIC).plan(ctx).orders, LevelKind.GRID_BUY);
  const tendido = buys.reduce((a, o) => a + Number(o.qty) * Number(o.price), 0);
  expect(tendido).toBeLessThanOrEqual(30);                        // hoy falla: tiende 40
});

it('respeta el cooldown entre ciclos', () => {
  const ctx = makeContext({ strategy: StrategyKind.GRID_CLASSIC, config, price: '100',
    now: 1_000_000, cycle: { cooldownUntil: 1_060_000 } });
  expect(getStrategy(StrategyKind.GRID_CLASSIC).plan(ctx).orders).toHaveLength(0); // hoy falla
});

it('el peor caso del preview cuenta TODAS las líneas, no solo las de debajo del precio', () => {
  const p = getStrategy(StrategyKind.GRID_CLASSIC).preview(config, makeMarket(), '100');
  expect(Number(p.worstCaseNotional)).toBeCloseTo(100, 0);        // hoy da 40 (2 de 5 líneas)
});
```

Test de motor propuesto para A-5-GC-3 (`apps/worker/src/engine/bot-runner.spec.ts`): Grid Classic con `filledLevelIndexes: [1]` y posición `0.2 @ 95`; ejecutar `REANCHOR_GRID`; en el tick siguiente se espera que siga existiendo una `GRID_SELL#1` (o que el comando se rechace para esta estrategia). Hoy: se tiende `GRID_BUY#1` de nuevo y no hay venta.

---

## 2. Neutral Grid (`packages/strategy-core/src/strategies/neutral-grid.ts`)

Promesa (guía `neutral-grid.guide.ts`): «compra por debajo [del ancla], vende por encima, y trata de volver siempre a posición cero» (:6); «El ancla es el centro: el punto donde el bot considera que tu posición debería ser cero» (:11); «deja una banda muerta de medio escalón, para no cancelar y recolocar órdenes en cada movimiento mínimo» (:15); `reanchorOnDrift`: «Hoy solo informa … El recentrado real se lanza a mano, con el comando Recentrar la retícula» (:121); `maxNotionalCap`: «Este campo queda como límite adicional y no sustituye a aquel» (:132); `direction`: «En largo o corto … el bot entiende que tu intención es acabar cargado en esa dirección» (:138). Ayuda `field-labels.ts:72-73`: «El recentrado se lanza a mano, con «Recentrar la retícula»».

| Ítem | Qué hace (fichero:línea) | Qué promete | Veredicto |
|---|---|---|---|
| A-1 Entrada | Todas las líneas van por `orders` `POST_ONLY`, `reduceOnly: false` (:348-360). Lado por posición **respecto al mark**, no al ancla: `isBuy = price < mark − deadband`, `isSell = price > mark + deadband`, y la línea que cae dentro de la banda **no se desea** (:336-338). `deadband = stepAvg/2` con `stepAvg = (upper − lower)/(levels − 1)` (:318-324), aritmético aunque el espaciado sea GEOMETRIC (defecto, :230). Sin `immediate`. No mira `cooldownUntil`. | «compra por debajo del ancla, vende por encima» (:6, :11); banda muerta «para no cancelar y recolocar» (:15). | **Hallazgo A-1-NG-1 (Alta, por confirmar con backtest)**: la banda muerta **cancela la orden justo antes de que pueda ejecutarse**. Una línea a distancia `d` del mark solo está viva mientras `d > stepAvg/2`; el motor replanifica cada `reconcileIntervalMs` (~15 s; el stream de precio solo actualiza `lastTicker`, `bot-runner.ts:476-480,515`). Para que una compra en 95 (paso 5, banda 2,5) se ejecute, el precio tiene que pasar de > 97,5 a ≤ 95 **entre dos latidos**; en cualquier aproximación gradual la orden se cancela en el primer latido con mark < 97,5 y no vuelve a existir hasta que el mark supere 107,5, ya como **venta**. Con los ejemplos de la propia guía: ETH 2 200–2 800/24 niveles → banda 13 USDC (0,52 %); BTC 74 000–84 000/20 → 263 USDC (0,33 %); SOL 115–165/20 → 0,95 %. Solo se ejecutan saltos de ese tamaño en 15 s. El «vaivén» prometido no se cobra. |
| A-2 Escalera | `buildLines` :180-217: precios `arithmeticPrices`/`geometricPrices`; rango de cada línea = distancia en índices a la primera línea `≥ anchor` (:192-197); pesos `geometricWeights(maxRank+1, sizeMultiplier)` (:200); `margin_i = total × w[rank]/Σw`, `notional = margin × lev`, `qty = notional / price` (:206-216). Σ notional = `totalInvestment × leverage` ✓. `maxExposure`: `capReached = |pos| × mark ≥ cap`; con tope, solo sobreviven las líneas que reducen (:326-345). **`maxNotionalCap` no aparece en el fichero.** | «los niveles más lejanos al ancla pesan más» (:13) ✓; `maxExposure` «solo quedan vivas las que la reducen» (`field-labels.ts:69-70`) ✓; `maxNotionalCap` «queda como límite adicional» (:132) ✗. | Reparto y `maxExposure` **OK**. **Hallazgo A-11-NG-2** (Media): `maxNotionalCap` es **muerto** en Neutral Grid (y en TDCA, ver §5): la ayuda común promete «Tope duro: el motor no coloca nada que lo supere, pase lo que pase» (`field-labels.ts:29`) y la guía «límite adicional»; no hay ninguna lectura. `validateCommon` solo avisa (`common.ts:216-231`). Con GEOMETRIC la banda aritmética supera el paso local abajo (50–200/20 niveles: paso inferior 3,79 frente a banda 3,95): dos líneas vecinas pueden caer en la banda a la vez. Baja. |
| A-3 Take profit | No existe como tal: cada línea es entrada y salida a la vez (`reduceOnly: false`, comentario :356-358). El beneficio sale de vender en la línea superior lo comprado en la inferior. Con la banda muerta (A-1) la línea que acaba de ejecutarse cambia de lado solo cuando el mark se aleja medio escalón más: si se ejecuta en un salto, la vuelta se cobra; en gradual, no hay ejecución. | — | Mecanismo coherente; depende de A-1. |
| A-4 Stop loss | `withStopLoss` sobre el **signo de la posición real** (`stop-loss.ts:50-52`): correcto para un bot que cambia de lado solo. | — | **OK** |
| A-5 Reanclaje | `reanchorOnDrift`/`reanchorThresholdPct` solo añaden texto a `note` (:366-371). El comando `REANCHOR_GRID` (`bot-runner.ts:1294-1311`) escribe `cycle.anchorPrice = mark` y vacía `filledLevelIndexes`; **Neutral Grid lee únicamente `cfg.anchorPrice`** (:187, :367) y no usa `filledLevelIndexes`. | «El recentrado real se lanza a mano, con el comando Recentrar la retícula» (guía :121, ayuda :72-73). | **F-12 CONFIRMADO** (`reanchorOnDrift` muerto, documentado) y **Hallazgo A-5-NG-3 (Media/Alta)**: «Recentrar la retícula» es un **no-op** para Neutral Grid: cancela las órdenes propias (`:1306`) y el tick siguiente vuelve a tender exactamente la misma retícula colgada de `cfg.anchorPrice`/`lowerPrice`/`upperPrice`. La única vía real de recentrar es una revisión WARM de `anchorPrice` (:68). La promesa de la guía y de la ayuda es falsa. |
| A-6 Ciclo y cooldown | El ciclo cierra si la posición queda **exactamente** plana (`cycle-accounting.ts:153`); un flip de signo no cierra (:139) y reancla `averageEntry` al precio del fill. Al cerrar, `cycleSeq+1` → **todos** los ids cambian (`seq` :310) → reconcile cancela y recoloca la retícula entera. `cooldownUntil` no se mira. | — | Media: cada paso exacto por cero (vender y recomprar la misma línea con la misma cantidad, el caso típico tras un salto) recoloca la retícula completa (hasta 200 órdenes). `cooldownMinutes` muerto (como Grid Classic). |
| A-7 Dirección | `plan()` no lee `cfg.direction` (:308-374). `preview()` estima la liquidación con `direction === 'SHORT' ? 'SHORT' : 'LONG'` (:302): NEUTRAL → LONG. Campo con opciones `NEUTRAL/LONG/SHORT` (:145-155) y COLD. | «En largo o corto … el bot entiende que tu intención es acabar cargado en esa dirección» (guía :138). | Semilla «`plan()` ignora `direction`» **CONFIRMADA**. La guía promete un sesgo que no existe: Media (documentación que confunde; el campo es COLD, así que el usuario no puede ni corregirlo). **F-14 CONFIRMADO** para NEUTRAL→LONG en el preview. |
| A-8 reduceOnly | `false` en todas (:359), a propósito y documentado. Con `capReached`, las «reductoras» tampoco son reduce-only: si la posición cambia de signo entre latidos, aumentan. | — | OK (decisión documentada). Baja el matiz del tope. |
| A-9 preview ≡ plan | Preview: lados **respecto al ancla** (`r.below`, :214, :288); `isEntry: true` en todas (:295) → `worstCaseNotional = total × lev` (coincide con el peor caso real: caída desde el techo con todas las líneas por debajo convertidas en compras). Plan: lados **respecto al mark** con banda. Liquidación: `estimateLiquidationPrice` aislada (`common.ts:342`) con `marginMode` por defecto **CROSS** (:235). | — | **F-14 CONFIRMADO** (liquidación aislada en un bot cruzado por defecto: el preview enseña una liquidación más cercana de lo que el venue aplicará; conservador pero falso). Preview y plan solo coinciden cuando mark ≈ ancla. |
| A-10 validate | :240-277. Acota: `lowerPrice > 0`, `upper > lower`, `anchor` dentro del rango, `gridLevels ≥ 4`, paso ≥ 2 ticks, aviso sin `maxExposure`. **No acota**: `gridLevels.max = 200`, `sizeMultiplier` 1..3 (con 0 las líneas de rango > 0 quedan a cantidad 0 y se descartan en silencio, :334; con negativo, todas), `gridSpacing.options`, `reanchorThresholdPct` 0,5..50, `maxExposure.min`, `direction.options`, más lo común (F-13). | — | **F-13** (ver §Semillas). |
| A-11 Muertos | `reanchorOnDrift`, `reanchorThresholdPct` (solo nota), `maxNotionalCap` (nada), `cooldownMinutes` (nada), `direction` (nada en `plan`). | — | **F-12 CONFIRMADO y ampliado.** |
| A-12 coid | `GB i`/`GS i` según el lado del momento (:347-349): la misma línea `i` alterna `GB i` y `GS i`, ids distintos; sin `immediate`; `seq` del scratch = motor ✓. `reusesOrderSlots: true` (:225) necesario porque los ids vuelven. | — | **OK** |
| A-13 Comisiones | Ningún supuesto; a diferencia de Grid Classic no hay aviso de paso frente a comisiones. 200 niveles en un rango del 5 % → 0,025 % por escalón, por debajo de una ida y vuelta maker+maker. | — | Baja. |
| A-14 onFill / slots | Sin `onFill`; no usa `filledLevelIndexes` (correcto: las líneas no son «entradas» de una vez). `reusesOrderSlots` ✓. | — | **OK** |

Nota de paridad con el backtest (A-22, fuera de línea A pero relevante para A-1-NG-1): `packages/backtest/src/engine.ts:349-354` planifica **una vez por vela** y ejecuta el `tickPath` de la vela sobre las órdenes colocadas al cierre de la anterior. En vivo la ventana es ~15 s; en el replay, la vela entera (5 m, 1 h). El backtest **sobreestima** las ejecuciones del Neutral Grid respecto a producción, justo en la estrategia donde la ventana decide si hay ejecución.

### Neutral Grid — tests propuestos (`strategies.spec.ts`, bloque `neutralGrid.plan`)

```ts
it('una compra sigue viva mientras el precio se le acerca desde arriba', () => {
  // Líneas 90,95,100,105,110 (paso 5, banda 2,5). A 96 la compra de 95 está a
  // un 1 % del precio y del lado correcto: cancelarla ahí es cancelarla justo
  // antes de que pueda ejecutarse en cualquier bajada gradual.
  const ctx = makeContext({ strategy: StrategyKind.NEUTRAL_GRID, config, price: '96' });
  const buys = getStrategy(StrategyKind.NEUTRAL_GRID).plan(ctx).orders
    .filter((o) => o.side === 'BUY').map((o) => o.price);
  expect(buys).toContain('95.0');                                // hoy falla
});

it('«Recentrar la retícula» mueve el centro: el ancla del ciclo manda sobre la config', () => {
  const ctx = makeContext({ strategy: StrategyKind.NEUTRAL_GRID, config, price: '105',
    cycle: { anchorPrice: '105' } });
  const { orders } = getStrategy(StrategyKind.NEUTRAL_GRID).plan(ctx);
  // Con el ancla en 105, la línea de 105 deja de ser la primera venta y 100 pasa a pesar como centro.
  expect(orders.find((o) => o.price === '100.0')?.side).toBe('BUY');
  // Hoy `plan()` ignora `cycle.anchorPrice`: el test documenta el no-op del comando.
});

it('maxNotionalCap acota lo tendido (hoy no se lee)', () => {
  const ctx = makeContext({ strategy: StrategyKind.NEUTRAL_GRID,
    config: cfg({ ...(config as object), maxNotionalCap: '30' }), price: '100' });
  const tendido = getStrategy(StrategyKind.NEUTRAL_GRID).plan(ctx).orders
    .reduce((a, o) => a + Number(o.qty) * Number(o.price), 0);
  expect(tendido).toBeLessThanOrEqual(30);                       // hoy falla: tiende 80
});
```

Test de backtest propuesto (`packages/backtest/src/engine.spec.ts`): serie que baja de 100 a 90 en pasos del 0,3 % por vela con el grid 90–110/5 niveles y `barPath` lineal; se espera al menos una ejecución en 95. Hoy, con latidos por vela, el replay sí ejecuta (la vela cubre la banda) mientras el motor real no: el test debe fijar la cadencia de planificación al `reconcileIntervalMs` real para reproducir el fallo.

---

## 3. Martingale (`packages/strategy-core/src/strategies/martingale.ts`)

Promesa (guía `martingale.guide.ts` + `ladder-options.ts`): entrada base «a mercado por defecto, o limitada si prefieres esperar precio» (:12); «limitada, que espera a que el precio venga a buscarla» (`ladder-options.ts:14`); «El capital se reparte proporcionalmente entre todos los escalones, así que el capital asignado es un techo real» (:14); TP «se recoloca … sobre la media nueva» (:15); `tpMode`: «a mercado en cuanto se toca el precio» (`ladder-options.ts:50-53`); `maxNotionalCap` «corta la escalera en el escalón en que se alcanza» (:85); `cooldownMinutes` «Viene con 1 minuto por defecto» (:100); `stopLossPct` «Ponlo por debajo del último escalón» (:106).

| Ítem | Qué hace (fichero:línea) | Qué promete | Veredicto |
|---|---|---|---|
| A-1 Entrada | `pos ≤ 0` → cooldown (:294-301) → `BASE#0` desde `scaledLadder(anchor: mark)[0]` (:303-312); `type = baseOrderType === 'LIMIT' ? POST_ONLY : MARKET`, `price = px(mark, entrySide)` (:319-320). MARKET → `immediate`; POST_ONLY → `orders` (:326-327). | «a mercado por defecto, o limitada» ✓ | MARKET **OK** (idempotencia por `B0` + veto de fila, `bot-runner.ts:861-866`). **Hallazgo A-1-MG-1** (Media, doc): la base LIMIT va por `orders` y su precio es `px(mark)` **de cada tick**: el reconciliador la cancela y recoloca cada vez que el mark se mueve más de medio tick (`reconcile.ts:184,246-249`). No «espera a que el precio venga a buscarla»: persigue al precio como un *join-the-bid*. Contraste con GridMart, que la manda por `immediate` y no la recoloca nunca (§4). **Nota transversal A-1-C**: el `price = px(mark, BUY)` (redondeado hacia ABAJO) que acompaña a la MARKET es el precio de ejecución que Lighter pasa a `create_market_order` (`lighter.ts:1094,1106-1113`); HL lo ensancha un 5 % (`hyperliquid.ts:551-554`) y Aster no lo manda (`aster.ts:596-601`). Va a la línea C (F-16), pero el incidente real de `order-gate.ts:157-159` (BASE de 0,00196 BTC con 0,00001 ejecutado en Lighter) es exactamente lo que hace un IOC limitado al mid. |
| A-2 Escalera | `scaledLadder` (`ladder.ts:79-111`): `price_i = anchor × (1 ∓ Σ_{k<i} sep·stepScale^k / 100)`, `margin_i = total × volumeScale^i / Σ`, `notional = margin × lev`, `qty = notional/price`. Σ margen = `totalInvestment` ✓. Ancla = `cycle.anchorPrice ?? position.entryPrice` (:336), fijada al primer fill BASE (`cycle-accounting.ts:150`). Tope: `projected = pos × mark` + Σ notional de los no ejecutados; `break` en el primero que lo supera (:349-361). | «el capital asignado es un techo real» ✓; «corta la escalera en el escalón» ✓ | **OK**. Comprobación (test `ladder.spec.ts:52-84` y guía ej. 1: 6 seg., 3 %, 1,3, 1,6, 400 USDC, 2x): distancias 3, 6,9, 11,97, 18,56, 27,13, 38,27 % → precios 2 428, 2 330, 2 203, 2 038, 1 824, 1 545 ✓ («cubre un 38 %» ✓); pesos 1..1,6⁶ → base 400×2/26,15 ≈ 30,6 USDC de notional… la guía dice «unos 19 USDC» de **margen** para la base (400/26,15 = 15,3 USDC de margen, 30,6 de notional) y «unos 311» para el último (400×10,49/26,15 = 160 de margen, 321 de notional): la guía mezcla margen y notional en el mismo ejemplo. Baja (doc). |
| A-3 Take profit | `takeProfitPrice(position.entryPrice, tp%, dir)` (:378-379); `type = tpMode === 'MARKET' ? 'MARKET' : 'LIMIT'` (:385), `price = px(tp, exitSide)`, `qty = qy(pos)`, `reduceOnly: true`, **sin `triggerPrice`** (:380-389). | «LIMIT deja la salida como maker; MARKET garantiza el cierre» (:44); «a mercado en cuanto se toca el precio» (`ladder-options.ts:50`). | **Hallazgo A-3-MG-2 (Alta, por confirmar con test)**: con `tpMode = MARKET` la salida es una orden **a mercado sin disparador**: los tres adaptadores la ejecutan **al instante** (HL: IOC a `tp × 0,95`, por debajo del mercado para un LONG, cruza el libro, `hyperliquid.ts:551-554,571-579`; Lighter: `create_market_order`, `lighter.ts:1096-1113`; Aster: `MARKET`, `aster.ts:1052`). En el primer tick con posición, el bot **cierra a mercado al precio actual** (pérdida = spread + taker), el ciclo se cierra, pasa el cooldown y vuelve a abrir la base: bucle que quema comisiones mientras dure. `place()` sí manda `intent: 'TP'` (`bot-runner.ts:890`), pero sin `triggerPrice` ningún adaptador lo convierte en condicional. La opción está en el formulario (`MARTINGALE_FIELDS` :120-128, HOT). En GridMart `tpMode` no se lee (LIMIT fijo), así que solo afecta a Martingale. |
| A-4 Stop loss | No lo emite (:391-392; test `strategies.spec.ts:224-234`). `withStopLoss` sobre `position.entryPrice` con `stopLossPrice` (`ladder.ts:138-145`). Guía: «por debajo del último escalón». | ✓ | **OK** en la capa de estrategia. |
| A-5 Safety / reanclaje | Seguridades = `SAFETY#i` `POST_ONLY` para `i ∉ filledLevelIndexes` (:352-373). `ADD_SAFETY_NOW` (`bot-runner.ts:1338-1361`) toma la primera `SAFETY` deseada y la manda como `MARKET` **con el precio de la escalera**. `REANCHOR_GRID` fija `anchorPrice = mark` y vacía `filledLevelIndexes` (:1298-1303). | «Adelantar orden de seguridad» (`bot-detail.page.ts:97`). | Seguridades **OK**. **Hallazgo A-5-MG-3** (Media): en HL una `MARKET` lleva IOC a `price × 1,05`: una seguridad a más del ~4,8 % por debajo del mark (`SAFETY#3` con 3 %/1,3 ya está a −12 %) sale como IOC por debajo del mercado, **no se ejecuta**, y el runner igualmente escribe `SAFETY_ADDED … ejecutada a mercado` (:1354-1358) porque no mira el ack. En Lighter el precio de la escalera es el precio de ejecución (peor todavía). `REANCHOR_GRID` sobre una martingala con posición vuelve a tender **toda** la escalera por debajo del mark actual: el margen comprometido puede llegar a `totalInvestment` + lo ya invertido (Media; el comentario del runner lo describe, la app no avisa). |
| A-6 Ciclo / cooldown | Cierre al quedar plana (`cycle-accounting.ts:153`); `cooldownUntil = now + scratch.cooldownMinutes` (:186-189). El motor no pasa `opts.cooldownMinutes` (`bot-store.ts:629`) → se usa `scratch.cooldownMinutes`, que `ensureCycle` hereda del scratch **guardado** (`bot-store.ts:1110`: `{ cycleSeq, cooldownMinutes, ...scratch }`, el guardado pisa al de config) y cada cierre copia al ciclo siguiente (:662,683). | `cooldownMinutes` es HOT (`common.ts:149`). | **Hallazgo A-6-MG-4** (Media): `cooldownMinutes` queda **congelado** con el valor de la primera fila de ciclo; una revisión HOT nunca surte efecto (ni tras REPAIR ni tras reinicio). El backtest sí lee la config (`engine.ts:222`): paridad rota. |
| A-7 Dirección | SHORT: `sign = +1` en `scaledLadder` (`ladder.ts:87`) → seguridades por encima; `takeProfitPrice(SHORT)` por debajo; lados por `entrySide/exitSide`. Test `ladder.spec.ts:86-98`. | — | **OK** |
| A-8 reduceOnly | Entradas `false` (:322, :371); TP `true` (:388). | — | **OK** |
| A-9 preview ≡ plan | `ladderLevels(cfg, refPrice)` = mismo `scaledLadder` (:221-242); TP del preview sobre `worstAvg` (`common.ts:344-348`); liquidación aislada (defecto ISOLATED ✓). En vivo el ancla es el fill de la base (≈ `refPrice` + slippage). `validateLadderConfig` compara la cobertura con `100/lev` sin MMR (:183): a 2x el último escalón a 49,6 % pasa, y la liquidación estimada está en 49,5 %. | — | **OK** salvo el matiz del MMR (Baja). |
| A-10 validate | `validateLadderConfig` :143-218. Acota `numLimitBuys` 1..30 ✓, `initialSeparationPct > 0` (no `max 20`), `volumeScale ≥ 1` (no `max 5`; aviso > 2,5), `stepScale ≥ 1` (no `max 3`), `takeProfitPct > 0` (no `max 50`), cobertura frente a liquidación ✓. **No acota** `baseOrderType.options`, `tpMode.options` ni lo común. | — | **F-13**. |
| A-11 Muertos | Ninguno propio. `cooldownMinutes` HOT congelado (A-6). `targetLeverage` de `DesiredState` (:398) no lo lee el motor (`syncLeverage` usa `config.leverage`; grep sin resultados en `apps/worker`, `packages/backtest`): campo muerto del contrato, Baja. | — | — |
| A-12 coid | `B0` (solo con posición plana) ∪ {`S i`, `TP0`} (con posición) + `SL0` inyectado: sin colisión `orders`×`immediate` en ninguna rama. `seq` del scratch = motor = backtest ✓. | — | **OK** |
| A-13 Comisiones | TP sobre `position.entryPrice` (sin comisiones). `takeProfitPct.min = 0,05` (:105) < ida y vuelta (HL taker 0,045 % + maker 0,015 %): un ciclo «en beneficio» al mínimo pierde dinero. La guía avisa («por debajo del 0,3 %», `ladder-options.ts:47`), `validate` no. Funding no se menciona. | — | Baja. |
| A-14 onFill / slots | Sin `onFill`; sin `reusesOrderSlots` → `place()` veta ids `FILLED` (correcto: una seguridad ejecutada no vuelve). El reemplazo del TP (`toReplace`) recoloca el mismo `TP0` tras cancelar (fila `CANCELED`, permitido) ✓. Parcial de `SAFETY#i`: el primer fill marca el índice (`cycle-accounting.ts:145`) → el resto de la orden deja de desearse y se cancela: el escalón queda **parcialmente** tomado y no se repone (Media, ver A-15). | — | OK con el matiz del parcial. |

### Martingale — tests propuestos (`strategies.spec.ts`, bloque `martingale.plan`)

```ts
it('con tpMode MARKET la salida es condicional: lleva disparador y no se ejecuta al colocarla', () => {
  const ctx = makeContext({ strategy: StrategyKind.MARTINGALE,
    config: cfg({ ...(config as object), tpMode: 'MARKET' }), price: '99.5',
    position: makePosition('0.1', '100'), cycle: { anchorPrice: '100', filledLevelIndexes: [0] } });
  const tp = byKind(getStrategy(StrategyKind.MARTINGALE).plan(ctx).orders, LevelKind.TAKE_PROFIT)[0];
  expect(tp.type).toBe('MARKET');
  expect(tp.triggerPrice).toBe('101.0');                          // hoy falla: undefined
});

it('la entrada base LIMIT no persigue al precio tick a tick', () => {
  const at = (price: string) => byKind(getStrategy(StrategyKind.MARTINGALE).plan(
    makeContext({ strategy: StrategyKind.MARTINGALE,
      config: cfg({ ...(config as object), baseOrderType: 'LIMIT' }), price })).orders, LevelKind.BASE)[0];
  // Documenta la conducta actual (cambia con cada tick); la deseada depende de una decisión de producto.
  expect(at('100').price).not.toBe(at('100.3').price);
});
```

Test de motor propuesto (`apps/worker/src/engine/bot-runner.spec.ts`) para A-6-MG-4: bot con `cooldownMinutes: 1`, `reloadConfig({ cooldownMinutes: 30 }, 'HOT')`, cerrar el ciclo con un fill de TP y comprobar que `cooldown_until` del ciclo nuevo dista 30 min; hoy dista 1.

---

## 4. GridMart (`packages/strategy-core/src/strategies/gridmart.ts`)

Promesa (guía `gridmart.guide.ts`): «El NÚCLEO es lo que compró la entrada base; el SATÉLITE es todo lo que añadieron las seguridades» (:13); «Cada venta de la rejilla que se ejecuta deja anotada una recompra por debajo … Cuando la recompra entra, ese escalón vuelve a estar disponible» (:16); `takeProfitPct`: «sigue formando parte de la configuración de la escalera y de las comprobaciones» (:88); `fullCycleCooldownMinutes`: «Hoy no cambia nada: el motor no lo lee» (:142); `maxNotionalCap`: «Corta la escalera en el escalón en que se alcanza el tope» (:148); `gridSellQtyMultiplier`: «El bot recorta la última venta si la suma se pasara del núcleo» (:131).

| Ítem | Qué hace (fichero:línea) | Qué promete | Veredicto |
|---|---|---|---|
| A-1 Entrada | Igual que Martingale (:373-402) **pero la base va siempre por `immediate`**, también cuando es `POST_ONLY` (:391-401). Una inmediata no se reconcilia: si no se ejecuta, cada tick el plan la vuelve a emitir y `place()` la veta por fila viva (`bot-runner.ts:861-866`); nunca se recoloca ni se cancela por el tick. | `baseOrderType` LIMIT «puede no empezar nunca si el precio se va» (`ladder-options.ts:16`). | Media (A-1-GM-1): conducta **distinta** de Martingale para el mismo campo compartido (`MARTINGALE_FIELDS`). Aquí sí «espera», pero al precio del tick en que se emitió y sin caducidad; un cambio HOT de `baseOrderType` a MARKET no surte efecto mientras la LIMIT viva (mismo coid `B0`, veto). Nota A-1-C (Lighter) aplica igual. |
| A-2 Escalera | Idéntica (:405-438); tope por notional proyectado con `break` (:425) ✓. Núcleo: `coreQty = min(ladder[0].qty, pos)`; satélite = `pos − core` (:443-444). `ladder[0].qty` se recalcula del ancla y de la config vigente, no de lo ejecutado. | «Corta la escalera en el escalón…» ✓ | **OK**. Con `totalInvestment`/`volumeScale` revisados en caliente (WARM) el «núcleo» cambia de tamaño sin que cambie la posición: Baja. |
| A-3 Salidas | Satélite: `TP0` `LIMIT` reduce-only en `breakeven × (1 ± satelliteTpPct)` con `breakeven = position.entryPrice` (:440, :467-480). Rejilla: `gridSellLevels` (:186-215) escalones `j` en `breakeven × (1 ± Σ sep·mult^k)`, cantidad `core × corePct% × qtyMult^j` recortada al resto (:207-212), `GS j` `POST_ONLY` reduce-only (:491-503), saltando los `j` con recompra pendiente (:490-492). Classic: un `TP0` sobre `pos` a `satelliteTpPct` (:446-465). **`takeProfitPct` y `tpMode` no se leen en `plan()`** (tipo `LIMIT` fijo :454, :475). | Guía :14-17 ✓. `takeProfitPct` «forma parte … de las comprobaciones» (:88). | Mecánica **OK**. **Hallazgo A-11-GM-2** (Media): `takeProfitPct` (HOT) y `tpMode` (HOT) son **muertos** en GridMart; y el preview pinta `takeProfitPrice` a partir de `takeProfitPct` cuando no es Classic (:356 → `common.ts:344-348`): el asistente enseña un precio de cierre que ningún pedido usará. |
| A-4 Stop loss | `withStopLoss` ✓ (no lo emite). | — | **OK** (capa estrategia). |
| A-5 Recompra / safety | `onFill` (:532-573): un fill `GRID_SELL#j` anota `rebuys[j] = { price: px(fill × (1 ∓ discount)), qty: qy(fill.qty) }` **reemplazando** la entrada previa del mismo `j` (:547); un fill `GRID_BUY#j` la elimina (:562-569). Las recompras salen como `GB j` `POST_ONLY` `reduceOnly: false` (:506-517). `gridRebuyDiscountPct` HOT se lee en el fill ✓. | «deja anotada una recompra … ese escalón vuelve a estar disponible» ✓ | Mecánica **OK**. **Hallazgo A-14-GM-3** (Media): una venta ejecutada **en varios trozos** (dos eventos de fill de la misma `GS j`) sobrescribe la recompra: solo se recompra la cantidad del **último** trozo; el resto del núcleo vendido no vuelve. Con `MAX_FILLS`/libros finos (Lighter, HL) las ejecuciones por tramos son la norma. |
| A-5 (índices) | La recompra `GB j` es entrada (`ENTRY_KINDS`, `cycle-accounting.ts:28-34`): `cycleAfterFill` hace `filledLevelIndexes.add(j)` (:145). El bucle de seguridades salta `if (filled.has(i)) continue` (:422) con **el mismo espacio de índices** (`types.ts:47-50` lo reconoce para la dirección contraria). | Seguridades «cada una más lejos y más grande» esperando por debajo (guía :12). | **Hallazgo A-5-GM-4 (Alta, por confirmar con test)**: **la recompra del escalón `j ≥ 1` borra la seguridad `SAFETY#j` para el resto del ciclo**: con los valores por defecto (4 ventas, 6 seguridades) las recompras de los escalones 1, 2 y 3 dejan sin tender las tres seguridades **más cercanas** al precio, y si estaban vivas el reconciliador las cancela (ya no se desean). La red de promediado que la guía describe se vacía en silencio a medida que la rejilla trabaja. Además `entriesFilled` sube con cada recompra (irrelevante aquí). |
| A-6 Ciclo / cooldown | El ciclo solo cierra si la posición queda plana: con núcleo + rejilla parcial rara vez ocurre. `cooldownMinutes` sí se respeta (:374-378) pero con el valor congelado (A-6-MG-4). `fullCycleCooldownMinutes`: **ningún lector** (solo meta :159-169 y defaults :245). `defaults()` no fija `cooldownMinutes` → 0: el bot abre el siguiente ciclo sin espera aunque el formulario enseñe «1 min» en el campo muerto. | Guía :139-144 admite el campo muerto. | **F-12 CONFIRMADO** (`fullCycleCooldownMinutes`). Baja adicional: los defaults contradicen la intención (espera 1 min) con el campo vivo a 0. |
| A-7 Dirección | SHORT: signo en `gridSellLevels` (:194) → «ventas» = compras por debajo del breakeven ✓; recompra por encima del precio de la venta (:540) ✓; satélite `takeProfitPrice(SHORT)` ✓; escalera por encima ✓. | — | **OK** (etiquetas `GRID_SELL`/`GRID_BUY` invertidas en SHORT, cosmético). |
| A-8 reduceOnly | Entradas y recompras `false` (:399, :436, :515); satélite, rejilla y TP classic `true` (:457, :478, :501). | — | **OK** |
| A-9 preview ≡ plan | Escalera de entrada + escalones de venta sobre el peor caso (`worstQty`, `breakeven` del peor caso) (:315-348) ✓ razonable. `takeProfitPct` → `takeProfitPrice` mostrado sin uso (A-11-GM-2). Liquidación aislada, defecto ISOLATED ✓. | — | OK con la salvedad del TP mostrado. |
| A-10 validate | :252-309 sobre `validateLadderConfig`. Acota `satelliteTpPct > 0`, `gridSellCount ≥ 1`, `corePct ∈ (0,100]`, `discount > 0`, `firstSep > 0`, aviso `discount > firstSep`. **No acota**: `gridSellDistanceMultiplier` (1..3) y `gridSellQtyMultiplier` (0,1..3) **en absoluto** — con `undefined` `gridSellLevels` hace `separation.mul(undefined)` / `qty.mul(undefined)` (:204, :212) y **lanza `DecimalError`** en `preview()` y en `plan()` (el 500 que `invalidPreview` quería evitar, un nivel más abajo); con 0 o negativo, escalones repetidos o ventas por debajo del breakeven; `gridSellCount.max`, `satelliteTpPct.max`, `gridSellInitialSeparationPct.max`, `gridRebuyDiscountPct.max` (≥ 100 → recompra a precio ≤ 0 → `ENTRADA_INVALIDA` cada tick). | — | **F-13** (con un caso que lanza). |
| A-11 Muertos | `fullCycleCooldownMinutes`, `takeProfitPct`, `tpMode` (heredado), `cooldownMinutes` congelado. | — | **F-12** ampliado. |
| A-12 coid | `B0` (plana) ∪ {`S i`, `TP0`, `GS j`, `GB j`} + `SL0`; `GS j` y `GB j` excluyentes por `j` (:490-492); tipos distintos → sin colisión de **coid**. La colisión es de **índice de nivel** en `filledLevelIndexes` (A-5-GM-4). `seq` del scratch ✓. | — | coid **OK**; índices **hallazgo**. |
| A-13 Comisiones | Aviso `discount > firstSep` ✓ (:295-306). Con `discount = 0,5 %` y `sep = 1 %` cada vuelta deja 0,5 % bruto menos dos maker (≈ 0,03 % HL): fino. `satelliteTpPct.min = 0,05` por debajo de una ida y vuelta. | Guía :113, :137 ✓ | Baja. |
| A-14 onFill / slots | `reusesOrderSlots: true` (:224) necesario (`GS j` vuelve tras la recompra) ✓; `recycleLevelOnExit` ausente a propósito ✓ (`types.ts:47-50`). Parciales: A-14-GM-3. | — | OK salvo el parcial. |

Comprobación numérica de la guía (ej. 1, ETH 2 503, 5 seg. 3 %/1,3/1,3, 800 USDC 2x, 4 ventas 1 %/1,2, 25 %): pesos 1..1,3⁵ (Σ = 12,76) → base = 800×2/12,76 = 125,4 USDC → 0,0501 ETH («unos 0,05 ETH» ✓); ventas en `breakeven × (1,01, 1,022, 1,0364, 1,0537)` = 2 528, 2 558, 2 594, 2 637 ✓; 25 % de 0,0501 × 2 528 ≈ 31,7 USDC («unos 32» ✓); recompra 2 530 × 0,995 = 2 517,4 («2.515» ≈ ✓). Seguridades 2 428, 2 330, 2 203, 2 038, 1 824 ✓ («27 %» ✓).

### GridMart — tests propuestos (`strategies.spec.ts`, bloque `gridmart.plan`)

```ts
it('la recompra de un escalón no borra la seguridad del mismo índice', () => {
  // GB1 es entrada: `cycleAfterFill` marca el índice 1 y el plan lo confunde con SAFETY#1.
  const base = makeContext({ strategy: StrategyKind.GRIDMART, config, price: '101',
    position: makePosition('0.15', '100'), cycle: { anchorPrice: '100', filledLevelIndexes: [0] } });
  const r = cycleAfterFill(base.cycle,
    { qty: D('0.1'), averageEntry: D('100'), realizedPnl: D(0), fees: D(0), entriesFilled: 1,
      filledLevelIndexes: [0], anchorPrice: D('100'), lastEntryAt: null },
    { venue: base.venue, symbol: 'BTC', venueFillId: 'f', venueOrderId: 'o',
      clientOrderId: makeCoid(base.botId, 1, 'GRID_BUY', 1), side: 'BUY', price: '100.5',
      qty: '0.05', fee: '0', feeAsset: 'USDC', isTaker: false, ts: 0 }, {}, 0);
  const ctx = { ...base, cycle: r.cycle };
  const safeties = byKind(getStrategy(StrategyKind.GRIDMART).plan(ctx).orders, LevelKind.SAFETY);
  expect(safeties.map((o) => o.levelIndex)).toContain(1);          // hoy falla: falta SAFETY#1
});

it('una venta ejecutada en dos trozos recompra la suma, no el último trozo', () => {
  const strategy = getStrategy(StrategyKind.GRIDMART);
  const ctx = makeContext({ strategy: StrategyKind.GRIDMART, config, price: '101',
    position: makePosition('0.3', '100'), cycle: { anchorPrice: '100', filledLevelIndexes: [0, 1] } });
  const fill = (qty: string, id: string) => ({ venue: ctx.venue, symbol: 'BTC', venueFillId: id,
    venueOrderId: 'o1', clientOrderId: '1a2b3c4d.1.GS0', side: 'SELL' as const, price: '101', qty,
    fee: '0', feeAsset: 'USDC', isTaker: false, ts: 0 });
  const c1 = strategy.onFill!(ctx, fill('0.02', 'f1'), ctx.cycle);
  const c2 = strategy.onFill!(ctx, fill('0.03', 'f2'), c1);
  const rebuys = c2.scratch['rebuys'] as { qty: string }[];
  expect(rebuys).toHaveLength(1);
  expect(rebuys[0].qty).toBe('0.05000');                          // hoy: '0.03000'
});

it('validate rechaza multiplicadores de rejilla ausentes en vez de lanzar en preview', () => {
  const sin = cfg({ ...(config as object), gridSellDistanceMultiplier: undefined });
  expect(getStrategy(StrategyKind.GRIDMART).validate(sin, makeMarket()).ok).toBe(false); // hoy: true
  expect(() => getStrategy(StrategyKind.GRIDMART).preview(sin, makeMarket(), '100')).not.toThrow();
});
```

---

## 5. TDCA (`packages/strategy-core/src/strategies/tdca.ts`)

Promesa (guía `tdca.guide.ts`): «Compra a mercado el importe que le hayas dicho, siempre que se cumplan todas las condiciones: cupo, intervalo, precio que mejore la media, tope» (:12); «mantiene viva una orden de cierre sobre el total, al precio medio más el objetivo» (:14); `intervalMinutes` «es un freno, no un disparador» (:90); `maxPositionNotional` «Aquí manda este campo, no el tope de exposición genérico» (:120); `maxNotionalCap` «Este queda como límite adicional» (:125).

| Ítem | Qué hace (fichero:línea) | Qué promete | Veredicto |
|---|---|---|---|
| A-1 Entrada | `immediate` `MARKET` cuando no hay bloqueos (:300-326): cupo `entriesFilled ≥ maxBuys` (:273-276), intervalo desde `cycle.lastEntryAt` (:278-282), mejora del medio frente a `position.entryPrice × (1 ∓ marginBelow)` (:284-293), tope `pos × mark ≥ maxPositionNotional` (:295-298). Id `B0` para la primera y `S k` (`k = entriesFilled`) para las siguientes (:311-319; test `strategies.spec.ts:354-372`). `price = px(mark, entrySide)`. **No mira `cooldownUntil`.** | Guía :12 ✓; :90 ✓ | **OK**. `cooldownMinutes` (HOT, en el formulario) **muerto** en TDCA (A-11-TD-1). `lastEntryAt` es el `ts` del venue (`cycle-accounting.ts:163`) y se compara con `ctx.now` del motor: con deriva de reloj el intervalo se acorta o alarga (B-22, Baja). Nota A-1-C (precio de la MARKET en Lighter) aplica. |
| A-2 Escalera | Sin escalera: `qty = amountPerBuy × leverage / mark` (:301-302), `qy` floor. Margen por compra = `amountPerBuy`; peor caso = `amountPerBuy × maxBuys` ≤ `totalInvestment` exigido en `validate` (:170-189) ✓. `maxPositionNotional` es puerta binaria sobre la posición actual (puede excederse en una compra) ✓ aceptable. **`maxNotionalCap` no se lee.** | «Aquí manda este campo, no el tope genérico» (:120) ✓; «Este queda como límite adicional» (:125) ✗ | **Hallazgo A-11-TD-2** (Media, compartido con Neutral Grid): `maxNotionalCap` muerto frente a la ayuda común «Tope duro … pase lo que pase» (`field-labels.ts:29`). |
| A-3 Take profit | `TP0` `LIMIT` reduce-only sobre `position.entryPrice × (1 ± tp)` con `qty = qy(pos)` (:255-266); se recoloca sola al cambiar el medio (reconcile por precio/cantidad). | Guía :14 ✓ | **OK** |
| A-4 Stop loss | `withStopLoss` ✓ (:268-269 lo dice). | — | **OK** |
| A-5 Safety / reanclaje | No aplica. `ADD_SAFETY_NOW` busca `SAFETY` en `orders` (`bot-runner.ts:1344`): TDCA solo emite en `immediate` → «No queda ninguna orden de seguridad pendiente» (WARN). `REANCHOR_GRID` vacía `filledLevelIndexes` (TDCA no los usa) y fija un ancla que TDCA ignora. | La app ofrece ambos comandos para todas las estrategias (`bot-detail.page.ts:97-98`). | No aplica; comandos inertes (Baja, UI). |
| A-6 Ciclo / cooldown | Cierra al ejecutarse el TP (plana). Cooldown ignorado (A-1). | — | A-11-TD-1. |
| A-7 Dirección | SHORT: `required = entry × (1 + marginBelow)` y `mark ≥ required` (:285-289) ✓; TP por debajo ✓; preview proyecta hacia arriba (:219-220) ✓. | — | **OK** |
| A-8 reduceOnly | Compras `false` (:324); TP `true` (:265). | — | **OK** |
| A-9 preview ≡ plan | Proyección: cada compra a `−marginBelow %` compuesto sobre la anterior (:216-231); `qty = amount × lev / proyectado` ✓ misma fórmula que `plan()`; TP sobre `worstAvg` ✓; liquidación aislada (defecto ISOLATED ✓). `issues = validateCommon(...).concat(this.validate(...).issues)` (:203): `validate` **ya incluye** `validateCommon` (:152) → avisos comunes **duplicados** en la UI. Con `marginBelow = 0` (permitido) todas las compras se proyectan al mismo precio: el «peor caso» no baja. | — | **F-14 CONFIRMADO** (duplicados, :203). El resto **OK**. |
| A-10 validate | :151-200. Acota `amountPerBuy > 0` (no `min 1`), `intervalMinutes ≥ 1` (no `max 10080`), `maxBuysPerCycle ≥ 1` (**no `max 500`**), `takeProfitPct > 0` (no `max 100`), peor caso ≤ `totalInvestment` ✓, aviso `leverage > 3` ✓. **No acota** `marginBelowAveragePct` 0..100 (negativo → compra cuando el precio está **por encima** de la media, lo contrario de la promesa; > 100 → nunca compra), `maxPositionNotional.min`. | — | **F-13**. `maxBuysPerCycle > 512` desborda `MAX_LEVEL_INDEX` solo en la ruta sin `ownIds` (ver A-15). |
| A-11 Muertos | `cooldownMinutes`, `maxNotionalCap`. | — | **F-12** ampliado. |
| A-12 coid | `TP0` en `orders`; `B0` o `S k` en `immediate`; tipos distintos → sin colisión; `S k` con `k ≤ maxBuys − 1` (499 con el máximo declarado) < `MAX_LEVEL_INDEX = 512` ✓. `seq` del scratch ✓. | — | **OK** |
| A-13 Comisiones | TP sobre `position.entryPrice`; entrada **taker** siempre (MARKET) + salida maker: en HL 0,045 % + 0,015 % = 0,06 % > `takeProfitPct.min = 0,05`. La guía avisa («por debajo del 0,3 %», :114); `validate` no. Funding no se menciona (un DCA que «puede durar días», :23, paga funding todo ese tiempo). | — | Baja/Media (doc). |
| A-14 onFill / slots | Sin `onFill`; ids no se reutilizan dentro del ciclo → sin `reusesOrderSlots` ✓; el veto por fila `FILLED` es la red contra la doble compra a mercado entre el fill y su asimilación ✓ (`bot-runner.ts:774-782`). | — | **OK** |

### TDCA — tests propuestos (`strategies.spec.ts`, bloque `tdca.plan`)

```ts
it('respeta el cooldown entre ciclos antes de la primera compra', () => {
  const ctx = makeContext({ strategy: StrategyKind.TDCA, config, price: '100',
    now: 1_000_000, cycle: { cooldownUntil: 1_060_000 } });
  expect(getStrategy(StrategyKind.TDCA).plan(ctx).immediate).toHaveLength(0);   // hoy falla
});

it('no repite los avisos comunes en el preview', () => {
  const p = getStrategy(StrategyKind.TDCA).preview(
    cfg({ ...(config as object), leverage: 15 }), makeMarket(), '100');
  const lev = p.issues.filter((i) => i.field === 'leverage');
  expect(lev).toHaveLength(1);                                                   // hoy: 2
});

it('rechaza un margen bajo la media negativo', () => {
  const r = getStrategy(StrategyKind.TDCA).validate(
    cfg({ ...(config as object), marginBelowAveragePct: '-5' }), makeMarket());
  expect(r.ok).toBe(false);                                                      // hoy: true
});
```

---

## 6. Piezas comunes

### A-15 `reconcile` (`packages/strategy-core/src/reconcile.ts`)

| Aspecto | Qué hace | Veredicto |
|---|---|---|
| Tolerancias | `samePrice`: medio tick (:246-249); `sameQty`: medio step contra `remaining = qty − filledQty` (:184-199). | **OK** para órdenes cuya cantidad deseada se deriva de la posición (TP: al reducirse la posición, `want.qty` baja con `remaining`; test `apps/worker/src/engine/reconcile.spec.ts:89`). **Hallazgo A-15-1 (Alta, por confirmar)**: para una línea de **tamaño fijo** que sigue deseada tras un parcial (Neutral Grid, recompras de GridMart, cotizaciones del MM), `remaining < want.qty` → `toReplace` → se cancela el resto y se coloca **la cantidad completa otra vez** (`bot-runner.ts:751-761`): la línea acaba comprando `parcial + completa`. Ejemplo: línea de 1,0 con 0,3 ejecutado → se recoloca 1,0 → hasta 1,3 en esa línea (30 % más margen del diseñado). El caso inverso (Martingale/Grid Classic): el primer parcial marca el índice, el resto se cancela y el escalón queda tomado a medias (Media). El contrato «qué significa un parcial» no está definido entre `plan()` y `reconcile()`. |
| `ownIds` | Autoritativo desde la base: `ownVenueClientIds(botId, [seq, seq−1])` (`bot-store.ts:242-250`, `bot-runner.ts:579,662`). Sin él, fuerza bruta 2 × 8 × 514 ids (:105-123). | **OK** como diseño. Ventana de dos ciclos: cualquier orden que sobreviva a **dos cierres** deja de reconocerse en HL/Lighter (id opaco, `isOurs` :226-237 → `ownIds.has` = false → `foreign`). Solo Grid Classic produce órdenes así (F-15); el resto cambia todos los ids al cerrar. |
| `foreign` | Sin `clientOrderId` → ajena (:153-158); id no reconocido → ajena (:166-170). Aster: prefijo legible, incluido el legado de 8 (:229-234). | **OK**: respeta órdenes manuales y de otros bots. Efecto colateral de F-15: una orden propia clasificada como ajena **nunca se cancela por el tick** (sí por `cancelOwnOrders`, que va por estado en base, `bot-store.ts:223-233`). |
| `MAX_LEVEL_INDEX = 512` | Cubre 200 (grids) y 499 (TDCA con `maxBuysPerCycle = 500`, `tdca.ts:316`) (:69-79). | **OK**. `validate` no acota `maxBuysPerCycle ≤ 500` (F-13): con 600 por API, los índices > 512 solo se pierden en la ruta **sin** `ownIds` (tests, usos sueltos); producción y backtest pasan el conjunto exacto. REFUTO como riesgo de producción. |
| Índice 999 | `SPECIAL_LEVEL_INDEXES = [999]` (:82) ↔ `closePositionAtMarket` `TAKE_PROFIT#999` (`bot-runner.ts:2021-2035`). | **OK**; la propuesta de F-02 (`STOP_LOSS#999` para el aplanado del MM) quedaría cubierta. |
| Reemplazo | Solo compara precio y cantidad (:184-199): un cambio de `type` (p.ej. `tpMode` LIMIT→MARKET, HOT) con el mismo precio/cantidad queda «unchanged» hasta que el precio se mueva. | Baja (y en este caso, afortunado: retrasa A-3-MG-2). |

Test propuesto para A-15-1 (`apps/worker/src/engine/reconcile.spec.ts`, estilo de `:89`):
```ts
it('una línea de tamaño fijo con ejecución parcial no se recoloca completa', () => {
  const plan = run([want({ qty: '1.000' })], [have({ qty: '1.000', filledQty: '0.300' })]);
  // Lo correcto es dejar el resto (0,7) en el libro o reponer exactamente 0,7; hoy: toReplace con 1,0.
  expect(plan.toReplace).toHaveLength(0);
});
```

### A-16 `order-gate` (`packages/strategy-core/src/order-gate.ts`)

| Aspecto | Qué hace | Veredicto |
|---|---|---|
| Entradas | `normalizeOrder` con violación → `ENTRADA_INVALIDA` WARN, se descarta el nivel y sigue (:56-63). | **OK** (test `order-gate.spec.ts:85-98`). |
| Salidas | `qty ≤ 0 ∨ price ≤ 0` → `IMPOSIBLE`; con entradas vivas → `ESPERANDO_MINIMO` INFO; sin ellas → `RESTO_INCERRABLE` WARN (:65-103). `entradasVivas` sale del plan del tick (`bot-runner.ts:734-735`); `salidaDefinitiva` para cierres manuales (:818, :839). | **OK**. Matices: (1) la `maxQty` de Aster (F-22) cae en la misma rama y el mensaje habla de «mínimo» (Baja); (2) el **stop-loss** se revisa con `price = triggerPrice` (`stop-loss.ts:63-67`): el notional se calcula al precio de disparo, un 10 % por debajo del actual en un LONG con `stopLossPct = 10` → una posición de 10,5 USDC (por encima del mínimo de 10) da 9,45 al disparo → `RESTO_INCERRABLE` → **sin stop** y `stopLossVivo = false` (`bot-runner.ts:841`). Si el venue mide el mínimo al precio de disparo es correcto; si lo mide al mark, el motor renuncia a un stop que el venue aceptaría. POR CONFIRMAR en C-2 por venue. Media. |
| Cuarentena | Por forma (`side:type:price:qty`, `bot-runner.ts:976-978`); se levanta al cambiar la forma o el ciclo (:1044). | **OK** |

### A-17 `cycle-accounting` (`packages/strategy-core/src/cycle-accounting.ts`)

| Aspecto | Qué hace | Veredicto |
|---|---|---|
| `QTY_EPSILON = 1e-8` (:42) | Umbral absoluto de «plana» (:153) y de discrepancia en `repairCycleFromVenue` (`bot-store.ts:1021`). | **REFUTO** como problema práctico: el step más fino de los fixtures es 1e-5 (`venue-markets.ts`), las posiciones del venue son múltiplos del step y ningún residuo real cae entre 1e-8 y el step. Anotar que en mercados de step entero (DOGE, kPEPE) el umbral es 8 órdenes de magnitud más fino de lo que puede existir. Baja. |
| Comisiones | `realized = prev − fee` en **todo** fill, entradas incluidas (:123); `matched` bruto (:135); `fees` acumuladas (:152). Se asume comisión en la quote (USDC/USDT), que es el caso de los tres venues. | **OK** (test `cycle-accounting.spec.ts:100-111`). |
| Flip | `prevQty.s !== signed.s` → realiza sobre `min(fill, |prev|)` y reancla `averageEntry` al precio del fill (:131-140). | **OK** (test :123-131). El `anchorPrice` (solo de un BASE) y `entriesFilled` no se tocan en el flip; irrelevante para las cinco (solo Neutral Grid flipa y no los usa). |
| `cycleId: null` al cerrar (:195) | El estado devuelto abre el ciclo siguiente sin id; el motor lo adopta tal cual (`bot-store.ts:692`) y **nadie** lo vuelve a rellenar hasta `ensureCycle` (adopción, `engine.service.ts:459`, o REPAIR, `bot-runner.ts:1328`). Único lector: `grid-classic.ts:291`. | **F-15 CONFIRMADO** (ver §7). |
| Cooldown | `opts.cooldownMinutes ?? scratch.cooldownMinutes` (:186-187). Motor: no pasa `opts` (`bot-store.ts:629`) → scratch congelado (`bot-store.ts:1110`, `:662,683`). Backtest: pasa la config (`engine.ts:222`) y además **veta el plan** en cooldown para todas las estrategias (`engine.ts:368`), cosa que el motor no hace. | **Hallazgo A-6-MG-4** (HOT congelado) + paridad A-22: grids y TDCA respetan el cooldown en el replay y no en vivo. |
| `lastEntryAt = fill.ts` (:163) | Reloj del venue frente a `ctx.now` (motor) en TDCA (`tdca.ts:279`). | Baja (B-22). |

### A-18 `liquidation.ts` (`packages/shared/src/liquidation.ts`)

| Aspecto | Qué hace | Veredicto |
|---|---|---|
| Fórmula | LONG `entry × (1 − 1/lev + mmr)`, SHORT `entry × (1 + 1/lev − mmr)` (:23-37). La aislada exacta (mantenimiento sobre el notional **al precio de liquidación**) es `entry × (1 − 1/lev)/(1 − mmr)`: a 2x y 0,5 % → 50,25 frente a 50,5; a 10x → 90,45 frente a 90,5. | Aproximación aceptable; el error dominante es el MMR. |
| MMR plano 0,005 (:11) | «Es OPTIMISTA» (:5-10). Hyperliquid publica que el mantenimiento es la mitad del margen inicial al apalancamiento máximo (**POR CONFIRMAR, DOC, sin red en esta sesión**): BTC 40x → 1,25 %; ETH 25x → 2 %; DOGE/kPEPE 10x → **5 %**. Aster: tramos por `leverageBracket` (POR CONFIRMAR); Lighter: por mercado (POR CONFIRMAR). Ejemplo HL DOGE a 5x LONG: código −19,5 % (`0,805 × entry`); con 5 % → −15 % (`0,85 × entry`): 4,5 puntos de optimismo. BTC a 10x: −9,5 % frente a −8,75 %. | Media, acotada: el número solo alimenta el preview (`common.ts:342`), la puerta gruesa de `risk.service.ts:86-95` (umbral 5 %) y el simulador (`dry-run.ts:706-713`, con `this.mmr`). **La guarda viva usa el `liquidationPrice` del venue** (`bot-runner.ts:1579-1580`): el MMR plano nunca decide una acción en producción. |
| Aislado frente a cruzado | `buildPreview` siempre aislada aunque `marginMode = CROSS` (defecto de Neutral Grid :235 y de los MM). `collateralBacking`/`liquidationOfPosition` (:75-144) sí distinguen: caja cruzada = `equity − aislado inmovilizado`, repartida ∝ notional, con suelo en el margen propio; apalancamiento efectivo = `notional/caja`. Consumidores: simulador (`dry-run.ts:706`) y saldos paper de la API (`bots.service.ts:437`), no el preview (no hay cuenta que mirar). Ejemplo: Neutral Grid 2x, medio 100, cuenta 1 000 USDC con una sola posición de 200 de notional: preview → 50,5; `liquidationOfPosition` → caja 1 000, lev efectivo 0,2, factor negativo → `null` («no se liquida»). | **F-14 CONFIRMADO**: el preview enseña una liquidación en un bot cruzado que el venue no aplicaría así. Conservador (más cerca de lo real), pero contradice la etiqueta «Estimación con la fórmula del venue» (`bot.ts:208`). |
| `collateralBacking` | Reparto ∝ notional y `max(parte, propio)` (:107-112). Cuenta `extraMargin` del objetivo también en cruzado (:81). | **OK** (razonable; documentado). |
| `liquidationDistancePct` | `|liq − cur|/cur` (:40-44): siempre ≥ 0; una liquidación ya sobrepasada devuelve distancia positiva. | Baja (la posición ya no existiría). |

---

## 7. Semillas de `findings.md`

### F-03 — Grid Classic BASE: `mark` en `plan()`, `refPrice` en `preview()` — **CONFIRMO**

Mecanismo: `levelQty` (`grid-classic.ts:146-151`) divide el notional por línea entre `refPrice`; `plan()` pasa `ctx.ticker.mark` (:288, :310, :337) y `preview()` el `refPrice` de creación (:254, :260; la API lo toma de `crypton:px:*` o del ticker, `bots.service.ts:1382-1399`). `qy` trunca al step (`common.ts:383-384`); `reconcile` tolera medio step (`reconcile.ts:251-254`): en cuanto la cantidad truncada cambia **un step**, todas las líneas (compras y ventas, que usan la misma `levelQty`) entran en `toReplace`.

Cuándo cambia un step: `qty = N / mark`, `dqty/dmark = −N/mark²`; un step `s` corresponde a `Δmark = s · mark² / N`.

| Mercado | step | mark | N por línea | `qty` cruda | Δmark para un step | En % |
|---|---|---|---|---|---|---|
| HL BTC (`venue-markets.ts:379-397`) | 0,00001 | 78 910 | 100 USD | 0,00126733 → `0.00126` | 622,6 USD | **0,79 %** → se recoloca la retícula entera cada ~0,8 % de movimiento |
| Aster BTCUSDT (`:465-483`) | 0,001 | 78 910 | 100 USD | 0,00126733 → `0.001` | cambia solo con mark ≤ 50 000 o > 100 000 | casi nunca; pero cada línea mueve 79 USD en vez de 100 (−21 %), y por encima de 100 000 USD `qy` da `0.000` y **todas** las líneas caen en `ENTRADA_INVALIDA` |
| Moneda barata (enunciado) | 1 | 0,5 | 100 USD | 200 | 0,0025 USD | **0,5 %** |
| HL/Aster DOGE (`:421-438`, `:505-523`) | 1 | 0,09209 | 100 USD | 1 085,9 → `1085` | 0,0000848 USD (8 ticks) | **0,092 %**: prácticamente en cada latido con movimiento |

Efecto: pérdida de prioridad en el libro y cupo de órdenes (200 líneas × 2 llamadas por recolocación); la venta de un nivel ya comprado se recoloca con una cantidad **distinta** de la comprada (resto sin vender o reduce-only recortada por el venue). Solo con `sizingMode = BASE` (defecto QUOTE). Severidad Alta confirmada por lectura; el test «en modo BASE la cantidad no cambia con el mark» (§1) falla hoy. Nota: `sizingMode` es WARM (:67), así que el arreglo (anclar al `refPrice` de la revisión o a `cycle.anchorPrice`) cambia cantidades de bots BASE en marcha → aviso al usuario (pregunta abierta ya anotada).

### F-12 — Parámetros muertos o a medias — **CONFIRMO y amplío**

| Campo | Estrategia | Evidencia | Estado |
|---|---|---|---|
| `preloadInventory` | Grid Classic | solo aviso en `validate` (:239-243); `plan()` no lo lee | confirmado (guía y ayuda lo admiten) |
| `reanchorOnDrift`, `reanchorThresholdPct` | Neutral Grid | solo texto en `note` (:366-371) | confirmado (admitido); y el comando manual que la guía ofrece como alternativa es un no-op para esta estrategia (A-5-NG-3) |
| `fullCycleCooldownMinutes` | GridMart | sin lector (solo :159-169, :245) | confirmado (admitido) |
| `takeProfitPct`, `tpMode` | GridMart | `plan()` no los lee; `LIMIT` fijo (:454, :475); el preview pinta un TP con `takeProfitPct` (:356) | **nuevo** |
| `cooldownMinutes` | Grid Classic, Neutral Grid, TDCA | ningún `plan()` mira `cooldownUntil` | **nuevo** |
| `cooldownMinutes` (valor) | Martingale, GridMart | congelado en la primera fila de ciclo (`bot-store.ts:1110`, `:662,683`; motor no pasa `opts.cooldownMinutes`, `:629`) | **nuevo** (HOT sin efecto) |
| `maxNotionalCap` | Neutral Grid, TDCA | ninguna lectura; ayuda común promete «tope duro … pase lo que pase» (`field-labels.ts:29`) | **nuevo** |
| `maxNotionalCap` (semántica) | Grid Classic | puerta binaria sobre lo ya abierto (:305-307), no acota lo tendido | **nuevo** |
| `direction` | Neutral Grid | `plan()` no lo lee; la guía promete sesgo (:138) | **nuevo** (semilla menor confirmada) |
| `targetLeverage` | todas (contrato `DesiredState`) | sin consumidor en worker ni backtest | **nuevo**, Baja |

### F-13 — `validate()` no acota lo que `meta.fields` declara — **CONFIRMO**; enumeración completa

Ni la API (`PreviewBotDto.config: Record<string, unknown>`, `dtos/*.ts:37,73`; sin validador genérico en `bots.service.ts`) ni `validateCommon` recorren `min/max/step/options`: solo la UI los aplica.

**Comunes (las cinco)** — `common.ts:29-159` frente a `:191-240`: `direction.options` ✗ (`NEUTRAL` en un grid → LONG); `marginMode.options` ✗; `leverage.max = 50` ✗ (solo `≤ market.maxLeverage`) y `step = 1` ✗ (2,5 pasa y llega a `setLeverage`); `totalInvestment.min = 10` ✗ (solo > 0); `maxNotionalCap.min` ✗ (inocuo); **`stopLossPct` 0,1..90 ✗ (nada: con ≥ 100 el precio de disparo es ≤ 0 → `IMPOSIBLE` → sin stop)**; `maxDailyLossPct` 0,1..100 ✗ (negativo → `loss ≥ dailyPct` cierto desde el primer tick → bot pausado nada más arrancar, `bot-runner.ts:1642-1653`); `liquidationAction.options` ✗ (valor desconocido → PAUSE, :1602-1607); `cooldownMinutes` 0..10080 ✗.

**Grid Classic**: `gridSpacing.options` ✗, `sizingMode.options` ✗ (valores desconocidos caen en ARITHMETIC/QUOTE en silencio). `gridLevels` ✓ (3..200), precios ✓.

**Neutral Grid**: `gridLevels.max = 200` ✗ (Grid Classic sí lo comprueba); `sizeMultiplier` 1..3 ✗ (0 → todas las líneas de rango > 0 a cantidad 0 y descartadas en silencio, :334; negativo → retícula vacía); `gridSpacing.options` ✗; `maxExposure.min` ✗; `reanchorThresholdPct` 0,5..50 ✗; `direction.options` ✗.

**Martingale** (`validateLadderConfig` :143-218): `initialSeparationPct.max = 20` ✗; `volumeScale.max = 5` ✗ (aviso > 2,5); `stepScale.max = 3` ✗; `takeProfitPct.max = 50` ✗; `baseOrderType.options` ✗; `tpMode.options` ✗. ✓: `numLimitBuys` 1..30, mínimos > 0, cobertura frente a liquidación.

**GridMart** (:252-309, hereda lo anterior): **`gridSellDistanceMultiplier` 1..3 ✗ sin ninguna comprobación** y **`gridSellQtyMultiplier` 0,1..3 ✗ sin ninguna** — ausentes, `gridSellLevels` hace `separation.mul(undefined)` (:204) / `qty.mul(undefined)` (:212) y **lanza `DecimalError`** en `preview()` y en `plan()`; 0 o negativos → escalones repetidos o ventas por debajo del breakeven; `satelliteTpPct.max` ✗; `gridSellCount.max = 20` ✗; `gridSellInitialSeparationPct.max` ✗; `corePctSoldAtLevel1.min = 1` ~ (comprueba > 0); `gridRebuyDiscountPct.max = 20` ✗ (≥ 100 → recompra a precio ≤ 0 → `ENTRADA_INVALIDA` cada tick); `fullCycleCooldownMinutes` ✗ (muerto).

**TDCA** (:151-200): `amountPerBuy.min = 1` ✗ (> 0); `intervalMinutes.max` ✗; `maxBuysPerCycle.max = 500` ✗; `marginBelowAveragePct` 0..100 ✗ (negativo invierte la condición: compra solo cuando el precio está **por encima** de la media; > 100 → nunca compra); `takeProfitPct.max = 100` ✗; `maxPositionNotional.min` ✗.

### F-14 — Preview frente a plan — **CONFIRMO** (los tres puntos)

1. `common.ts:342` usa `estimateLiquidationPrice` (aislada) sea cual sea `marginMode`; Neutral Grid nace en CROSS (:235). Ejemplo en §6 A-18: preview 50,5 frente a `null` con la cuenta entera detrás.
2. `neutral-grid.ts:302`: NEUTRAL → LONG. La retícula puede acabar corta (todas las ventas de arriba ejecutadas): la liquidación de ese caso (por encima) no se enseña nunca.
3. `tdca.ts:203`: `validateCommon(...).concat(this.validate(...).issues)` con `validate` que ya incluye `validateCommon` (:152): todo aviso común sale dos veces (ejemplo: `leverage > 10`).
Añadido: Grid Classic subestima el peor caso (A-9-GC-4).

### F-15 — `cycleSeq` en Grid Classic vía `cycle.cycleId` — **CONFIRMO** (Crítica por confirmar en HL/Lighter)

Traza con el motor:
1. Adopción: `ensureCycle` devuelve `cycleId = String(id)` (`bot-store.ts:1100`) → `seq = scratch.cycleSeq = N` en :291 = motor (`bot-runner.ts:568`). Todo coincide.
2. Primer cierre (la posición vuelve a 0, en un grid: al venderse todo el inventario): `cycleAfterFill` devuelve `cycleId: null` (`cycle-accounting.ts:195`) y `applyFillToCycle` lo adopta tal cual con `scratch.cycleSeq = N+1` (`bot-store.ts:692`). Nadie repone `cycleId` (único escritor: `ensureCycle`, llamado solo en adopción y REPAIR).
3. Desde entonces `plan()` emite **`seq = 0`** mientras el motor reconcilia con `N+1`, `withStopLoss` firma `SL0` con `N+1` (`bot-runner.ts:643`) y `place()` graba las filas con `cycle_seq = N+1` (`:821,870`). Los ids de la retícula (`.0.GBi`) ya no cambian en los cierres siguientes (eso evita la recolocación entera en cada cierre, pero por accidente).
4. `ownVenueClientIds(botId, [seq, seq−1])` (`:579`; `bot-store.ts:242-250`) solo devuelve filas de los **dos últimos** `cycle_seq`. Una orden `.0.GBi` colocada en el ciclo M sigue viva en el ciclo M+2 (sus ids no cambian) pero su fila tiene `cycle_seq = M` → **fuera de `ownIds`**.
5. En Aster no pasa nada (`parseCoid` + prefijo, `reconcile.ts:227-235`). En **Hyperliquid y Lighter** (`parseCoid` = null sobre hash/entero) esa orden es `foreign` (:166-170): el tick **nunca la cancela**. Dos consecuencias reales: (a) `stopOnRangeExit`/`capReached` retiran las compras deseadas, pero las colocadas hace ≥ 2 ciclos siguen vivas y se ejecutan cuando el precio vuelve: el bot compra donde prometió no comprar; (b) **tras un reinicio o readopción** (`ensureCycle` → `cycleId` ≠ null → `seq = N+k`) el plan desea `.N+k.GBi` **además** de las `.0.GBi` vivas, que ahora son ajenas: `place()` no las ve (`findOrderByCoid` por el id nuevo, `:861`) y **tiende una segunda compra en cada línea**: exposición duplicada (dos compras por nivel, una sola venta por nivel al ejecutarse). Requisitos: Grid Classic en HL o Lighter, ≥ 2 cierres de ciclo desde la colocación (habitual en un grid que oscila) y un reinicio del worker (despliegue, pérdida de lease). Todo es operación normal con configuración válida → **Crítica (por confirmar)** con el test de §1 más un test de motor: `bot-runner.spec.ts`, Grid Classic en HL, filas `.0.GB3` con `cycle_seq = 2`, ciclo actual 4, `ensureCycle` con id → el tick no debe colocar `.4.GB3` mientras `.0.GB3` viva. Backtest: `cycleId: 'bt-1'` (`engine.ts:141`) → mismo salto a 0 tras el primer cierre; `ownIds` exacto (`emitted`) evita las consecuencias, así que **el replay no reproduce el fallo** (A-22).
Ejemplo numérico: grid 20 líneas en HL BTC; tres cierres; reinicio → el tick siguiente coloca hasta 20 compras nuevas junto a las ≤ 20 antiguas: hasta 2 × `totalInvestment × leverage` de compras vivas.

### Semillas menores

| Semilla | Veredicto | Evidencia |
|---|---|---|
| `QTY_EPSILON` absoluto frente al step | **REFUTO** como riesgo (§6 A-17); Baja documental | `cycle-accounting.ts:42`; steps ≥ 1e-5 en `venue-markets.ts` |
| `MAX_LEVEL_INDEX = 512` frente a 500 de TDCA | **REFUTO**: índice máximo 499; producción y backtest usan `ownIds` exacto; solo la ruta de fuerza bruta se vería afectada, y solo si `validate` dejara pasar > 513 compras (F-13) | `reconcile.ts:79,105-123`; `tdca.ts:316`; `bot-runner.ts:579,662`; `engine.ts:388` |
| `withStopLoss` redondea el disparo del lado de salida, «un tick más cerca» | **REFUTO** como riesgo: LONG→SELL→↑ y SHORT→BUY→↓ acercan el disparo a la entrada, es decir, **salta antes** (pérdida menor). Lado conservador. | `stop-loss.ts:52`; `precision.ts:20-23` |
| Grid Classic SHORT etiqueta `GRID_BUY` las ventas de entrada | **CONFIRMO**, Baja (cosmético; contabilidad correcta porque `GRID_BUY` ∈ `ENTRY_KINDS`) | `grid-classic.ts:317,331`; `cycle-accounting.ts:28-34` |
| `neutral-grid.plan()` ignora `direction` | **CONFIRMO**, Media por la promesa de la guía (:138) | `neutral-grid.ts:308-374`, `:302` |
| `testing.ts:makeTicker` usa floats | **REFUTO** para producción: ningún fichero no-spec importa `testing.ts` (grep en `apps/` y `packages/`; `index.ts` no lo reexporta). El comentario `testing.ts:15-19` («el worker los usa también») está desfasado. Baja | `testing.ts:43-54` |
| `ASSUMED_MAX_LEVERAGE = 50` / `PERCENT_PRICE` / `MAX_NUM_ORDERS` | Fuera de línea A (C-2). Solo anoto que `leverage.max = 50` del formulario coincide con el supuesto de Aster y que ningún `validate` mira `MAX_NUM_ORDERS`: un Grid Classic de 200 niveles + TP/SL supera los 200 por símbolo (F-23) | `common.ts:76-77` |

---

## 8. Comprobaciones extra

### (a) Unicidad de `clientOrderId` dentro de un `plan()` (`orders` ∪ `immediate`), todas las ramas

| Estrategia | Ramas y ids | Veredicto |
|---|---|---|
| Grid Classic | por índice `i`: `GB i` si `!holding ∧ entrada ∧ acceptEntries ∧ !capReached`; `GS i` si `holding` — excluyentes (:315, :328). `immediate` siempre vacío (:298). | **OK** |
| Neutral Grid | una orden por línea, `GB i` o `GS i` según el lado del momento (:347-349); sin `immediate`. | **OK** |
| Martingale | plana: `B0` (en `immediate` si MARKET, en `orders` si LIMIT, nunca en ambos, :326-327) o nada (cooldown); con posición: `S i` (i ≥ 1, no ejecutados) + `TP0`. | **OK** |
| GridMart | plana: `B0` en `immediate`; con posición: `S i` + `TP0` (satélite **o** classic, nunca ambos, :446-480) + `GS j` / `GB j` excluyentes por `j` (:490-492, :506). | **OK** |
| TDCA | `TP0` (`orders`) + `B0` o `S k` (`immediate`, `k = entriesFilled`) (:258, :312-317). | **OK** |
| Inyectados | `SL0` (`stop-loss.ts:59`): ninguna de las cinco emite `STOP_LOSS`; `TP999` del cierre manual (`bot-runner.ts:2027`) fuera de toda escalera. | **OK** (F-02 es exclusivo de los MM). |

### (b) `reduceOnly`

Entradas `false` / salidas `true` en Grid Classic (:324/:338), Martingale (:322,:371/:388), GridMart (:399,:436,:515/:457,:478,:501), TDCA (:324/:265); stop inyectado `true` (`stop-loss.ts:69`); cierre manual `true` (`bot-runner.ts:2034`). Neutral Grid: todo `false` a propósito (:356-359). **OK**.

### (c) Apalancamiento: notional = `totalInvestment × leverage`, margen = `totalInvestment`

| Estrategia | Plan | Preview (peor caso) | Veredicto |
|---|---|---|---|
| Grid Classic | por línea `T·L/n` notional, `T/n` margen (:148, :256); Σ = `T·L` | solo líneas del lado de entrada en el momento del preview | ✗ preview parcial (A-9-GC-4) |
| Neutral Grid | Σ `margin_i` = `T`, Σ notional = `T·L` (:203-216) | todas las líneas (`isEntry: true`) = `T·L` | ✓ |
| Martingale / GridMart | `scaledLadder`: Σ margen = `T`, Σ notional = `T·L` (`ladder.ts:99-100`; test `ladder.spec.ts:100-113`); `maxNotionalCap` recorta por notional proyectado | mismo `ladderLevels` | ✓ |
| TDCA | por compra `amount·L`; `validate` exige `amount × maxBuys ≤ T` (:170-189) | `maxBuys` compras proyectadas | ✓ |
| Motor | `syncLeverage` usa `config.leverage` (`bot-runner.ts:425,1855-1862`); `targetLeverage` del plan no se lee | — | ✓ coherente; campo muerto (Baja) |

### (d) Espejo SHORT

Grid Classic: líneas de entrada por encima del mark, salida en la línea inferior, lados invertidos (:313,:320,:329,:334) ✓. Neutral: no aplica (`direction` ignorado). Martingale/GridMart: `scaledLadder` con signo +1 (`ladder.ts:87`), TP/satélite/rejilla con signo −1 (`ladder.ts:133`; `gridmart.ts:194,338`), recompra con signo +1 (`gridmart.ts:540`) ✓. TDCA: umbral `entry × (1 + margin)` y `mark ≥ required` (:285-289), TP por debajo, preview hacia arriba (:219) ✓. Stop: por signo de la posición (`stop-loss.ts:50-52`) ✓. Etiquetas `GRID_BUY/GRID_SELL` invertidas en SHORT (Grid Classic, GridMart): cosmético.

### (e) `maxNotionalCap` (`break`) y `maxExposure`

Martingale (:349-361) y GridMart (:418-426): `projected = pos × mark + Σ notional` y `break` en el primer escalón que supera el tope ✓ (test `strategies.spec.ts:205-216`). El arranque en `pos × mark` (valor actual, no de entrada) deja pasar algo más de escalera cuando el precio ha caído (Baja). Grid Classic: puerta binaria sobre lo abierto (A-2-GC-2). Neutral Grid y TDCA: no lo leen (A-11-NG-2/TD-2). `maxExposure` (Neutral, :326-345) ✓ (test :413-423); `maxPositionNotional` (TDCA, :295-298) puerta binaria, admitido por la guía ✓.

### (f) Cooldown y `cycleAfterFill`

`cooldownUntil = now + scratch.cooldownMinutes × 60 000` al cerrar (`cycle-accounting.ts:186-189`); el motor lo persiste (`bot-store.ts:663,682`). Lo respetan Martingale (:294-301) y GridMart (:374-378); lo ignoran Grid Classic, Neutral Grid y TDCA. El valor es el de la **primera** fila de ciclo (congelado, A-6-MG-4). El backtest lo lee de la config y lo aplica a **todas** (`engine.ts:222,368`): en el replay un TDCA espera entre ciclos y en vivo no.

### (g) `position.entryPrice` (venue) frente a `cycle.averageEntry` (ciclo)

- Anclan en **`position.entryPrice`**: TP de Martingale (:378), satélite/rejilla de GridMart (:440), TP y umbral de TDCA (:256, :286), stop inyectado (`stop-loss.ts:52`).
- Ancla en **`cycle.anchorPrice`** (fill del BASE, `cycle-accounting.ts:150`) con respaldo en `position.entryPrice`: escaleras de Martingale/GridMart (:336; :405).
- `cycle.averageEntry` solo alimenta el realizado del ciclo (`cycle-accounting.ts:135`), el equity del kill-switch (`bot-runner.ts:1618`) y la atribución de liquidaciones (`:1022`).
- Liquidación parcial: el venue conserva `entryPrice` y reduce `qty` → TP/stop se redimensionan al resto en el tick siguiente (reconcile por cantidad) ✓; `recordLiquidation` + `cycleAfterFill` reducen el ciclo ✓; `filledLevelIndexes` no cambia → las seguridades no se rearman ✓; `afterLiquidation` decide conservar o retirar el stop según quede posición (`bot-runner.ts:1096-1100`) ✓. GridMart: `coreQty = min(ladder[0].qty, pos)` → el satélite absorbe primero la reducción ✓.
- Divergencia real: un añadido manual en el exchange mueve `position.entryPrice` y no `cycle.averageEntry` → el TP sigue al venue (correcto) y el realizado del ciclo se calcula contra el medio antiguo (deriva contable, F-17).

### (h) Redondeo de `px()` por caso de salida y polvo de `qy()`

| Orden | Lado | Modo | Efecto | Seguro |
|---|---|---|---|---|
| TP LONG | SELL | ↑ | un tick más lejos del mercado, más beneficio, nunca cruza | ✓ |
| TP SHORT | BUY | ↓ | ídem (compra más barata) | ✓ |
| Stop LONG | SELL | ↑ | disparo un tick **más cerca** de la entrada → salta antes | ✓ conservador |
| Stop SHORT | BUY | ↓ | ídem | ✓ conservador |
| Recompra GridMart | BUY | ↓ | más barata, no cruza en post-only | ✓ |
| MARKET de entrada | BUY/SELL | ↓/↑ | precio del lado **pasivo** acompañando a una orden a mercado: irrelevante en HL (±5 %) y Aster (no se manda); en Lighter es el precio de ejecución (A-1-C) | ⚠ C-3 |

`qy` trunca al step (`common.ts:383-384`, `precision.ts:29-30`). Salidas dimensionadas desde `pos` (múltiplo del step del venue) → sin polvo. Excepción: GridMart reparte el núcleo en fracciones (`gridmart.ts:199-212`) y cada escalón se trunca por separado: con núcleo 0,00196 BTC y tres ventas al 33,33 % → 3 × 0,00065 = 0,00195 → **0,00001 BTC** de núcleo que ninguna orden desea (por debajo de `minQty`, invendible), `RESTO_INCERRABLE` no salta porque no hay orden que revisar, y el ciclo no cierra nunca. Baja/Media.

### (i) `diffConfig` HOT/WARM/COLD frente al motor

- Mecánica (`mutability.ts:223-259`; `bot-runner.ts:1387-1420`): HOT → `this.config` nuevo + tick; WARM → además `syncLeverage(previous)` y `cancelOwnOrders(keepProtective)`; campo desconocido → COLD (rechazado). `positionMode`, `limitAction`, `priceFloor`, `priceCeiling` y `sizingMode` (fuera de Grid Classic) están en `CommonBotConfig` pero no en `COMMON_FIELDS` → cualquier cambio por API es COLD ✓ (seguro).
- HOT honrados: todo lo que `plan()` lee (`maxNotionalCap`, `maxExposure`, `takeProfitPct`, `satelliteTpPct`, `gridRebuyDiscountPct`, `stopOnRangeExit`, TDCA entero), `stopLossPct` (`:1510`), `liquidationAction` (`:1602`), `maxDailyLossPct` (`:1642`).
- HOT **no** honrados: `cooldownMinutes` (congelado, A-6-MG-4); `baseOrderType` en GridMart mientras viva la base LIMIT (mismo `B0`, veto por fila viva, A-1-GM-1). `tpMode` sí se honra, y honrarlo a MARKET es A-3-MG-2.
- WARM con estado por índice sin remapear (**Hallazgo A-i-1**, Media): `lowerPrice`/`upperPrice`/`gridLevels`/`gridSpacing` (Grid Classic) y `numLimitBuys`/`initialSeparationPct`/`stepScale` (Martingale/GridMart) cambian el precio que significa cada índice, pero `filledLevelIndexes` sobrevive a la recarga (`reloadConfig` no lo toca). Grid Classic con la línea 3 comprada a 95 y un rango nuevo desplazado hacia abajo: la venta de la línea 3 se coloca en la nueva línea 4 (puede quedar **por debajo** de 95: venta reduce-only a pérdida) y la compra de la línea 3 no se tiende. `sizingMode` WARM: la venta de un nivel comprado en QUOTE se recalcula en BASE (cantidad distinta). Martingale: el índice `1` ejecutado a −3 % pasa a significar −1 %: la escalera nueva tiene un hueco donde no hubo compra. Ningún campo HOT necesita reanclaje; los que lo necesitan son estos WARM, y hoy WARM «cancela y retiende» sin reconciliar la memoria del ciclo.

### (j) Cruces con la línea C detectados desde las estrategias

1. **Lighter, stop-loss inyectado** — `withStopLoss` emite `type: 'MARKET'` + `triggerPrice` (`stop-loss.ts:63-67`); `lighter.ts:1096` entra en `create_market_order` para **todo** `type === 'MARKET'` sin mirar `triggerPrice`, y el disparador solo se traduce en la rama límite (`:1139-1142,1159-1161`). Si es así, en Lighter el stop **cierra la posición en el momento de colocarse** (reduce-only a mercado). Crítica (por confirmar): test de `LighterAdapter.placeOrder` con `{ type: 'MARKET', triggerPrice, reduceOnly }` esperando `create_order` con `ORDER_TYPE_STOP_LOSS*` y `trigger_price ≠ NIL`; hoy llamaría a `create_market_order`. Corresponde a C-3; se anota aquí porque anula A-4 en ese venue.
2. **Lighter, `price` de las MARKET** — las estrategias acompañan la MARKET con `px(mark, lado)` redondeado hacia el lado pasivo (`martingale.ts:320`, `gridmart.ts:397`, `tdca.ts:322`; el cierre manual con `mark`, `bot-runner.ts:2032`); Lighter lo pasa como precio de ejecución (`lighter.ts:1094,1106-1113`). Un IOC limitado al mid no cruza el libro: ejecuciones parciales o nulas. El incidente documentado en `order-gate.ts:157-159` (BASE 0,00196 → 0,00001 ejecutado) encaja. Alta (por confirmar, F-16).
3. **Hyperliquid, `ADD_SAFETY_NOW`** — IOC a `precio × 1,05` (`hyperliquid.ts:551-554`) no alcanza seguridades a > 4,8 % del mark; el runner anuncia «ejecutada a mercado» sin mirar el ack (`bot-runner.ts:1353-1358`). Media.

---

## 9. Lista de hallazgos (línea A, fase 3)

Severidad según `specs/README.md`. «(pc)» = por confirmar con el test propuesto (ninguno se ha ejecutado: sesión de solo lectura).

| id | Título | Severidad | Evidencia (fichero:línea) | Impacto | Test propuesto |
|---|---|---|---|---|---|
| F-15 (A-6/A-12) | Grid Classic emite `cycleSeq = 0` en cuanto `cycle.cycleId` es `null` (tras el primer cierre); en HL/Lighter sus órdenes salen de la ventana `ownIds` y tras un reinicio se tiende una segunda compra por línea | **Crítica (pc)** | `grid-classic.ts:291`; `cycle-accounting.ts:195`; `bot-store.ts:242-250,692,1100`; `bot-runner.ts:568,579,821`; `reconcile.ts:166-170,226-237` | Órdenes propias que el tick nunca cancela (compran fuera de rango/tope) y exposición duplicada tras readopción; solo Aster se salva | `strategies.spec.ts` «mismo cycleSeq que el motor aunque el ciclo no tenga id» (§1) + `bot-runner.spec.ts` readopción con `.0.GB3` viva |
| C-3-L1 (cruce, A-4) | Lighter manda el stop-loss (`MARKET` + `triggerPrice`) por `create_market_order`: se ejecutaría al colocarse | **Crítica (pc, línea C)** | `lighter.ts:1096-1113` frente a `:1139-1161`; `stop-loss.ts:63-67` | Posición cerrada a mercado al inyectar el stop, en Lighter | `exchange-core.spec.ts`: `placeOrder` MARKET+trigger → `create_order` STOP_LOSS |
| A-3-MG-2 | Martingale `tpMode: MARKET` = orden a mercado sin disparador: cierre inmediato en los tres venues y bucle abrir/cerrar | **Alta (pc)** | `martingale.ts:385-389`; `hyperliquid.ts:551-579`; `lighter.ts:1096-1113`; `aster.ts:1052` | Pérdida repetida de spread + taker por ciclo mientras la opción esté activa | «con tpMode MARKET la salida lleva disparador» (§3) |
| A-1-NG-1 | Neutral Grid: la banda muerta cancela cada línea cuando el precio se le acerca a menos de medio escalón; sin ejecuciones en movimientos graduales | **Alta (pc)** | `neutral-grid.ts:318-338`; `bot-runner.ts:476-480,515` | Bot inactivo en mercados normales; el backtest (una planificación por vela) lo disimula | «una compra sigue viva mientras el precio se le acerca» (§2) + backtest con cadencia real |
| A-5-GM-4 | GridMart: la recompra `GB j` marca `filledLevelIndexes[j]` y borra `SAFETY#j` del resto del ciclo | **Alta (pc)** | `gridmart.ts:417-422,506-517`; `cycle-accounting.ts:28-34,145`; `types.ts:47-50` | Las seguridades más cercanas desaparecen (y se cancelan) a medida que la rejilla trabaja | «la recompra no borra la seguridad del mismo índice» (§4) |
| A-15-1 | `reconcile` recoloca la cantidad **completa** de una línea de tamaño fijo tras un parcial | **Alta (pc)** | `reconcile.ts:184-199`; `bot-runner.ts:751-761` | Sobreexposición por línea (Neutral Grid, recompras GridMart, MM) | `reconcile.spec.ts` «parcial de tamaño fijo no se recoloca completa» (§6) |
| A-5-GC-3 | «Recentrar la retícula» sobre Grid Classic con inventario: ventas fuera, compras repetidas en los niveles ya comprados | **Alta** | `bot-runner.ts:1294-1311`; `grid-classic.ts:315,328`; `bot-detail.page.ts:98` | Inventario sin salida y doble compra por nivel; comando ofrecido en la app | `bot-runner.spec.ts` REANCHOR_GRID con `filledLevelIndexes: [1]` (§1) |
| F-03 (A-2/A-9) | Grid Classic BASE dimensiona con el mark: la retícula entera se recoloca cada ~0,8 % (HL BTC), 0,5 % (moneda a 0,5) o 0,09 % (DOGE) de movimiento | **Alta** | `grid-classic.ts:146-151,260,288,310,337`; `reconcile.ts:251-254` | Churn de cancelaciones, pérdida de prioridad, ventas con cantidad distinta de la comprada | «en modo BASE la cantidad no cambia con el mark» (§1) |
| A-1-C (cruce F-16) | Las MARKET llevan `px(mark, lado pasivo)`; en Lighter es el precio de ejecución | **Alta (pc, línea C)** | `lighter.ts:1094,1106-1113`; `martingale.ts:320`; `gridmart.ts:397`; `tdca.ts:322`; incidente `order-gate.ts:157-159` | Entradas y cierres a mercado parciales o nulos en Lighter | test de `LighterAdapter.placeOrder` MARKET: precio de ejecución con holgura |
| A-5-NG-3 | «Recentrar la retícula» es un no-op para Neutral Grid (lee solo `cfg.anchorPrice`) mientras guía y ayuda lo ofrecen como el recentrado real | Media/Alta | `neutral-grid.ts:187,367`; `bot-runner.ts:1294-1311`; `neutral-grid.guide.ts:121`; `field-labels.ts:72-73` | Promesa falsa; cancelación y recolocación inútil de la retícula | «el ancla del ciclo manda sobre la config» (§2) |
| A-6-MG-4 | `cooldownMinutes` (HOT) congelado con el valor de la primera fila de ciclo; backtest lo lee de la config | Media | `bot-store.ts:629,662,683,1110`; `engine.ts:222,368` | Cambios en caliente sin efecto; paridad rota | `bot-runner.spec.ts` reload HOT + cierre (§3) |
| A-11-* / F-12 | Parámetros muertos: `cooldownMinutes` (Grid Classic, Neutral, TDCA), `maxNotionalCap` (Neutral, TDCA), `takeProfitPct`+`tpMode` (GridMart), `preloadInventory`, `reanchor*`, `fullCycleCooldownMinutes`, `direction` (Neutral), `targetLeverage` | Media | §7 tabla F-12 | El usuario configura lo que no ocurre; ayuda común promete «tope duro» | tests de cooldown (§1, §5) y de `maxNotionalCap` (§2) |
| A-2-GC-2 | `maxNotionalCap` en Grid Classic solo corta entradas nuevas tras superarse; no acota lo tendido | Media | `grid-classic.ts:305-307`; `field-labels.ts:28-29`; `bot.ts:38` | 20 líneas × 60 = 1 200 USDC vivos con tope 100 | «el tope acota lo que se TIENDE» (§1) |
| A-9-GC-4 | El preview de Grid Classic solo cuenta las líneas de debajo del precio como peor caso | Media | `grid-classic.ts:262-271`; `common.ts:317-321,341-342` | Peor caso, media y liquidación a la mitad de lo real (ejemplo de la guía: 600 frente a 1 200) | «el peor caso cuenta TODAS las líneas» (§1) |
| F-13 (A-10) | `validate()` no acota min/max/options de 30+ campos (lista completa §7): `stopLossPct ≥ 100` → sin stop; `maxDailyLossPct < 0` → bot pausado al arrancar; GridMart sin multiplicadores → `DecimalError` en preview/plan | Media | `common.ts:191-240`; `neutral-grid.ts:240-277`; `martingale.ts:143-218`; `gridmart.ts:252-309,204,212`; `tdca.ts:151-200`; `dtos/*.ts:37,73` | Clientes de la API saltan el formulario | validador genérico sobre `meta.fields` + «rechaza multiplicadores ausentes» (§4), «margen negativo» (§5) |
| F-14 (A-9) | Preview: liquidación aislada con CROSS por defecto; NEUTRAL→LONG; avisos duplicados en TDCA | Media | `common.ts:342`; `neutral-grid.ts:235,302`; `tdca.ts:152,203` | Distancia a liquidación falsa (50,5 frente a «no se liquida»); UI ruidosa | «no repite los avisos comunes» (§5) |
| A-14-GM-3 | GridMart: cada trozo de una venta sobrescribe la recompra del escalón | Media | `gridmart.ts:547-553` | Núcleo que no vuelve tras ejecuciones por tramos | «venta en dos trozos recompra la suma» (§4) |
| A-i-1 | Revisión WARM de la forma de la escalera con inventario: `filledLevelIndexes` no se remapea | Media | `bot-runner.ts:1412-1417`; `grid-classic.ts:290,315,328`; `martingale.ts:348,353` | Ventas reduce-only por debajo del coste; huecos en la escalera | `bot-runner.spec.ts` reload WARM con `filledLevelIndexes` no vacío |
| A-5-MG-3 | `ADD_SAFETY_NOW` en HL: IOC a +5 % no alcanza seguridades lejanas; evento «ejecutada» sin mirar el ack. `REANCHOR_GRID` en martingala rearma toda la escalera bajo el mark | Media | `bot-runner.ts:1338-1361,1294-1303`; `hyperliquid.ts:551-554` | Falsa confirmación; margen comprometido por encima de `totalInvestment` | `bot-runner.spec.ts` ack no ejecutado → sin `SAFETY_ADDED` |
| A-16-1 | El stop se revisa al precio de disparo: posiciones justo por encima del mínimo se quedan sin stop (según cómo mida el venue) | Media (pc, C-2) | `order-gate.ts:49,65-103`; `stop-loss.ts:63-67`; `bot-runner.ts:839-841` | Sin stop con solo un WARN | `order-gate.spec.ts` stop de 10,5 USDC a −10 % |
| A-1-MG-1 / A-1-GM-1 | Base LIMIT: Martingale la recoloca al mark en cada tick; GridMart la deja fija y sin caducidad; la doc dice «espera a que el precio venga a buscarla» | Media (doc) | `martingale.ts:319-327`; `gridmart.ts:391-401`; `ladder-options.ts:14-17` | Dos conductas para el mismo campo; cambio HOT inefectivo en GridMart | «la base LIMIT no persigue al precio» (§3) |
| A-7-NG | Guía de Neutral Grid promete un sesgo por `direction` que `plan()` no implementa | Media (doc) | `neutral-grid.ts:308-374`; `neutral-grid.guide.ts:135-140` | Campo COLD con promesa falsa | — |
| A-18-1 | MMR plano 0,005 optimista (HL alts ≈ 5 %); solo preview, puerta gruesa y simulador | Media (pc, DOC) | `liquidation.ts:11,23-37`; `common.ts:342`; `risk.service.ts:86-95` | Distancias de liquidación en el preview 4-5 puntos mejores de lo real en alts | `ladder.spec.ts` con MMR por mercado (cuando `MarketSpec` lo lleve) |
| A-15-2 | Parcial de una entrada de escalera (Martingale, Grid Classic): el primer fill marca el nivel y el resto se cancela | Media | `cycle-accounting.ts:145`; `martingale.ts:353`; `grid-classic.ts:315` | Escalones tomados a medias sin reposición | `bot-runner.strategies.spec.ts` parcial de `SAFETY#1` |
| A-h-GM | Polvo del núcleo en GridMart por truncado por escalón: ciclo que no cierra | Baja/Media | `gridmart.ts:199-212`; `common.ts:383-384` | Resto invendible y silencioso | «tres ventas al 33 % no dejan polvo» |
| Bajas | Grid Classic: etiquetas SHORT (:317,:331), venta de la última línea fuera del rango (:158-163), aviso de comisiones al 0,05 %; Neutral: banda aritmética con GEOMETRIC (:318-323), recolocación entera al pasar por cero exacto; Martingale: guía mezcla margen y notional (`martingale.guide.ts:44`), cobertura sin MMR (:183); GridMart: defaults `cooldownMinutes` 0 con campo muerto a 1 (:245); TDCA: comandos inertes en la app, reloj del venue en el intervalo; comunes: `targetLeverage` muerto, `testing.ts:15-19` desfasado, `QTY_EPSILON` documental, `liquidationDistancePct` sin signo, mensaje de `maxQty` en `order-gate`, funding ausente en toda la documentación, mínimos de `takeProfitPct` por debajo de la ida y vuelta | Baja | citas en cada sección | — | — |

---

## 10. Verificado OK

- **Aritmética de escaleras**: `arithmeticPrices`/`geometricPrices` incluyen ambos extremos y usan `Decimal` a precisión 40 (`ladder.ts:12-30`; `money.ts:10`); `scaledLadder` reparte el margen ∝ `volumeScale^i` con Σ margen = `totalInvestment` y notional = margen × apalancamiento (`ladder.ts:79-111`; tests `ladder.spec.ts:52-113`). Los ejemplos numéricos de las guías de Grid Classic (§1) y GridMart (§4) cuadran con el código.
- **Take profit y stop**: `takeProfitPrice`/`stopLossPrice` son espejos exactos LONG/SHORT (`ladder.ts:128-145`; test `ladder.spec.ts:131-141`); TP de Martingale, GridMart y TDCA sobre el `entryPrice` real del venue, `reduceOnly: true`, cantidad = posición completa (o satélite/núcleo en GridMart); se recolocan solas por el reconciliador al moverse el medio.
- **Stop-loss inyectado** (capa estrategia): una sola fuente (`withStopLoss`), por signo de la posición real, con `triggerPrice`, `reduceOnly`, sin duplicar el de la estrategia (ninguna de las cinco lo emite; test `strategies.spec.ts:224-234`); el redondeo del disparo cae del lado conservador (salta antes).
- **`reduceOnly`**: `true` en toda salida y `false` en toda entrada de Grid Classic, Martingale, GridMart y TDCA; `false` deliberado y documentado en Neutral Grid.
- **`clientOrderId`**: sin colisiones `orders`×`immediate` en ninguna rama de las cinco; `cycleSeq` del scratch coincide con motor y backtest en Neutral Grid, Martingale, GridMart y TDCA; `MAX_LEVEL_INDEX = 512` cubre el índice máximo real (499) y el 999 del cierre manual está en la lista especial.
- **`maxNotionalCap`** en Martingale y GridMart: recorte por notional proyectado con `break` (test `strategies.spec.ts:205-216`). **`maxExposure`** en Neutral Grid: solo sobreviven las órdenes que reducen (test `:413-423`). **`maxPositionNotional`** en TDCA, según la guía.
- **Espejo SHORT** correcto en las cuatro direccionales (escalera, TP, stop, umbral de TDCA, recompra de GridMart).
- **Redondeo**: `px` por lado (`roundPriceForSide`) y `qy` truncado (`floorToStep`) son los únicos formateadores (`common.ts:379-384`); las salidas se dimensionan desde la posición (múltiplo del step), sin polvo salvo el reparto del núcleo de GridMart.
- **Reciclado de niveles**: `recycleLevelOnExit` solo en Grid Classic, aplicado igual en `cycleAfterFill` y en `repairCycleFromVenue` (`cycle-accounting.ts:146-148`; `bot-store.ts:1036-1038`); `reusesOrderSlots` declarado exactamente por las tres estrategias cuyos ids vuelven (Grid Classic, Neutral Grid, GridMart) y honrado por `place()` (`bot-runner.ts:760-771,861-866`).
- **Idempotencia de las inmediatas**: `B0`/`S k` estables por turno (test `strategies.spec.ts:354-372`) y veto por fila viva o ejecutada en `place()`; `upsertPendingOrder` reencarna a 0 solo para ids reutilizados (`bot-store.ts:331-342`).
- **`cycle-accounting`**: media ponderada, realizado contra el medio, comisiones descontadas del realizado y no del `matched`, flip reanclado, acumulado por delta, cierre al quedar plana, cooldown con el `now` del llamante — todo con test (`cycle-accounting.spec.ts`); `QTY_EPSILON` inocuo frente a los steps reales.
- **`order-gate`**: distingue entrada inválida / imposible / esperando mínimo / resto incerrable con el caso real de Lighter (`order-gate.spec.ts`), y el motor lo usa tanto en `place()` como en el backtest (`engine.ts:414`).
- **`reconcile`**: tolerancias de medio tick y medio step, `ownIds` exacto desde la base en el camino caliente, fuerza bruta acotada al camino sin `ownIds`, respeto de órdenes ajenas y manuales, reconocimiento de ids legados de 8 caracteres.
- **Liquidación**: la guarda viva usa `position.liquidationPrice` del venue (`bot-runner.ts:1579-1580`); `collateralBacking` distingue aislado/cruzado y lo consumen simulador y saldos paper; la estimación se etiqueta como tal.
- **Mutabilidad**: campos desconocidos → COLD; `positionMode`, `limitAction`, `priceFloor`, `priceCeiling` no expuestos a las cinco y por tanto COLD; WARM sincroniza el apalancamiento con el venue antes de retender.
- **`testing.ts`**: los floats de `makeTicker` no llegan a producción (ningún importador fuera de los specs).
- **Purity**: `plan()` es pura en las cinco (mismo contexto → mismo resultado; tests `strategies.spec.ts:820-838,1319-1327` cubren dos; el resto no tiene efectos ni estado de módulo por lectura).
