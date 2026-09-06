# Revisión de las siete estrategias — «¿están bien los bots?»

Fecha: 2026-09-06 · Árbol: `main` = `d8f8f20` (rama `spec/008-guia-de-uso`) · Solo lectura: ningún
bot, venue ni base de datos se tocó. Los scripts (`coherencia-estrategias.cjs`, `verificar-ejemplos.cjs`,
`comprobar-parametros.cjs`, `comprobar-enlaces.cjs`) viven en el scratchpad de la sesión; su salida
íntegra va al final de este informe.

## 1. Veredicto en una página

**El código está en verde y hace lo que dice su test.** Las seis Críticas del spec 001 están corregidas y
no queda ningún rojo. Lo que **no** está bien es la distancia entre lo que el formulario, la ayuda in-app y
el README **prometen** y lo que el motor **hace**: 30 Altas, 47 Medias y 11 Bajas del 001 siguen abiertas
y varias de ellas las nota el usuario al configurar un bot (parámetros que nadie lee, un preview que
enseña la mitad del peor caso, un comando que duplica compras, un modo de take profit que cierra al
instante). Este spec documenta todo eso con honestidad; los specs 009, 010 y 011 corrigen lo que afecta al
dinero de bots en marcha.

| Estrategia | Veredicto | Lo que hay que saber hoy |
|---|---|---|
| Rejilla clásica | Operable con `sizingMode: QUOTE` | No usar «Recentrar» con inventario (F-84); el preview enseña la mitad del peor caso (F-88); `maxNotionalCap` actúa a posteriori (F-87); ≤ 30 líneas en Lighter (F-50); `cooldownMinutes` y `preloadInventory` muertos |
| Rejilla neutral | Operable con avisos obligatorios | Apenas ejecuta en bajadas graduales y su backtest lo sobreestima (F-81/F-65); «Recentrar» es un no-op (F-84); `direction`, `maxNotionalCap`, `cooldownMinutes` no se leen; preview aislado con CROSS de fábrica (F-14) |
| DCA temporizado | La más sana | Desaconsejada en Lighter (F-47); `maxNotionalCap` y `cooldownMinutes` muertos; margen negativo invierte la condición vía API (F-13) |
| Martingala | Operable con `tpMode: LIMIT` obligatorio | «A mercado» cierra al instante y entra en bucle (F-80); base LIMIT persigue al precio (F-92); cooldown congelado (F-86); «Adelantar seguridad» sin acuse (F-85) |
| GridMart | Operable con avisos; `classicMode` evita lo peor | Las recompras borran las seguridades del mismo índice (F-82); ventas en trozos y polvo del núcleo dejan el ciclo sin cerrar (F-89); `takeProfitPct`, `tpMode`, `fullCycleCooldownMinutes` no gobiernan nada; sin multiplicadores la API revienta (F-13) |
| Market Maker V1 | Operable con avisos | `stopLossPct` + `limitAction` ≠ pausar → la acción nunca sale (F-02); preview sin ×0,7 (F-57); topes por lado mudos (F-59); cada par casado cierra ciclo (F-58); `fillCooldown` inerte con ancla (F-15) |
| Market Maker V2 | Operable con avisos | `feeEstimateBps` 0 de fábrica (F-15); el techo no es techo con capas/preset (F-60); armado se pierde al cerrar ciclo (F-62); F-61, F-63 |
| Transversal | — | «Parar y cerrar» cancela el stop antes de cerrar (F-33); «Aportar margen» falla siempre (F-34); stop no atómico (F-35); `REJECTED` tras acuse y `PENDING` huérfana (F-36/37); stop revisado al disparo (F-91); la API no acota `stopLossPct` (F-13) |

## 2. Línea base automática (A1)

| Batería | Resultado |
|---|---|
| `pnpm build:packages` | ok |
| strategy-core | 223 tests, 6 suites, verde |
| worker | 268 tests, 9 suites, verde |
| exchange-core | 276 tests, 13 suites, verde |
| shared | 73 tests, verde |
| backtest | 26 tests, verde |
| `pnpm lint` | 0 errores (3 avisos preexistentes en `apps/api`) |
| `pnpm check:env` | coherente |
| `tsc -p apps/app/tsconfig.app.json --noEmit` | ok |
| `pnpm --filter app build` / `lint` (tras los textos de este spec) | ok / «All files pass linting» |

## 3. Coherencia por estrategia (A2)

Resumen de la salida del script (íntegra en §6):

- **C1 `meta.fields` ↔ interfaz `XConfig`**: limpio en las cinco no-MM. En los dos market makers,
  `sizingMode`, `limitAction`, `positionMode`, `priceFloor` y `priceCeiling` viven en el tipo compartido de
  `mm-shared.ts`, no en la interfaz propia: falso positivo del script, no un desfase.
- **C2 `default` del descriptor ↔ `defaults()`**: cinco divergencias, todas **deliberadas** (la estrategia
  sobreescribe el común): Neutral Grid y los dos MM en `marginMode` CROSS (descriptor ISOLATED); TDCA y MM
  V2 `leverage` 1 (descriptor 2); Martingala `cooldownMinutes` 1 (descriptor 0). El formulario enseña
  `defaults()`. Anotado en las guías como «valores de fábrica». GridMart **no** sobreescribe
  `cooldownMinutes` (queda 0) mientras su campo muerto `fullCycleCooldownMinutes` enseña 1 (F-94).
- **C3 textos**: los 187 `labelKey`/`helpKey` existen en `field-labels.ts`. Las cinco
  `strategy.*.description` que faltan no tienen lector (`STRATEGY_BLURBS` cubre los siete kinds).
- **C4 fichas in-app**: todos los campos propios tienen ficha (tipado `GuideOptions<C>` con `-?`).
- **C5 parámetros que `plan()` no lee** (confirma F-12): Grid Classic `cooldownMinutes` (muerto),
  `preloadInventory` (solo aviso); Neutral Grid `maxNotionalCap`, `cooldownMinutes` (muertos), `direction`
  (solo preview); TDCA `maxNotionalCap`, `cooldownMinutes` (muertos), `totalInvestment` (solo validación);
  GridMart `tpMode`, `fullCycleCooldownMinutes` (muertos), `takeProfitPct` (solo preview); MM V1/V2
  `maxNotionalCap`, `cooldownMinutes` (muertos, documentados), `positionMode` (motor, inerte por F-34).
  Martingala: ninguno. Falsos negativos conocidos: `reanchor*` de Neutral Grid (solo alimenta la nota) y
  `cooldownMinutes` congelado en Martingala/GridMart (F-86), que el script da por vivos.
- **C6 límites declarados que `validate()` no acota** (confirma y amplía F-13): en **las siete**,
  `totalInvestment` 9 (< 10), `maxNotionalCap` −1, `stopLossPct` 180 y −1, `maxDailyLossPct` 200 y −1,
  `cooldownMinutes` 20160 y −1 pasan sin ERROR. Además por estrategia: Neutral Grid `gridLevels` 400,
  `sizeMultiplier` 6/0/−1, `maxExposure` −1, `reanchorThresholdPct` 100/−1; TDCA `intervalMinutes` 20160,
  `marginBelowAveragePct` 200/−1, `takeProfitPct` 200, `maxPositionNotional` −1; Martingala
  `initialSeparationPct` 40, `volumeScale` 10, `stepScale` 6, `takeProfitPct` 100; GridMart todo lo anterior
  más `satelliteTpPct` 40, `gridSellCount` 40, los multiplicadores 6/0/−1, `gridRebuyDiscountPct` 40,
  `fullCycleCooldownMinutes` 20160/−1; MM V1 y V2, decenas (distancias 2000/4000 bps, `refreshSeconds` 7200,
  `feeEstimateBps` −1, `maxDynamicSpreadBps` 0/−1, `repriceThresholdBps` 0…). **Solo el formulario protege.**
- **C6b campos obligatorios ausentes que revientan**: Martingala y GridMart sin `volumeScale` o
  `stepScale` → excepción en `validate()`/`preview()`; GridMart además sin `gridSellDistanceMultiplier` o
  `gridSellQtyMultiplier` (F-13 confirmado: 500 en `/bots/preview`).
- **C7 preview frente a peor caso**: Grid Classic (ejemplo A) `worstCaseNotional` 596,79 / margen 300 frente
  a 1.191,72 / 595,86 de todas las líneas (F-88). TDCA a 12× repite el aviso de apalancamiento (F-14).
- **C8 defaults con 100 USDC**: Grid Classic y Neutral Grid inválidas en Lighter y Hyperliquid (5 USDC por
  línea < 10); Martingala y GridMart inválidas en todos los venues (la base y las primeras seguridades no
  llegan al mínimo); los MM válidos salvo Aster BTCUSDT (cantidad mínima 0,001 BTC ≈ 79 USDC > 20 de
  tamaño). Consecuencia para la guía: «100 USDC no dan para 20 niveles».

## 4. Ejemplos de las guías (Fase 1)

15 configuraciones (3 por estrategia no-MM) ejecutadas con `validate()` + `preview()` sobre los fixtures de
`venue-markets.ts`: **14 válidas a la primera**, 1 inválida y corregida: el ejemplo C de la rejilla neutral
de la guía in-app (SOL, 20 niveles, multiplicador 1,8) dejaba las líneas centrales en 0,83 USDC, por
debajo del mínimo; pasa con 12 niveles y multiplicador 1,5. La guía in-app se corrigió en este spec. Los
números de todos los bloques «Peor caso» de `docs/` salen de esa ejecución.

## 5. Tests que faltan (para los specs 009+)

| Estrategia | Sin test hoy |
|---|---|
| Grid Classic | F-03 (BASE con dos marks), F-84 (REANCHOR con `filledLevelIndexes`), F-87 (tope acota lo tendido), F-88 (peor caso completo) |
| Neutral Grid | F-81 («una compra sigue viva mientras el precio se le acerca»); `strategies.spec.ts:433` y `bot-runner.strategies.spec.ts:585` **fijan** la conducta actual |
| TDCA | F-13 (`marginBelowAveragePct < 0`), F-14 (avisos duplicados) |
| Martingala | F-80 (TP condicional), F-92 (base LIMIT), F-86 (cooldown HOT) |
| GridMart | F-82, F-89, F-13 (multiplicadores ausentes) |
| MM V1 | F-02, F-57, F-59 |
| MM V2 | F-60 (`strategies.spec.ts:1131` fija lo contrario), F-62 (tras cierre de ciclo), F-63 |
| Transversal | `withStopLoss` sin spec propio; `bot-runner.spec.ts:847` documenta F-33 como esperada |

## 6. Salida íntegra del script de coherencia

```
Generado el 2026-09-05 sobre `packages/strategy-core/dist`.


## GRID_CLASSIC (`grid-classic.ts`, 18 campos, 7 propios)

- **C1 fields ↔ interfaz `GridClassicConfig`**: limpio.
- **C2 default ↔ defaults()**: sin contradicciones. 
- **C3 textos**: todos los labelKey/helpKey presentes. descriptionKey `strategy.grid.description` ausente (sin lector; STRATEGY_BLURBS cubre el kind).
- **C4 fichas de la guía in-app**: todos los campos propios tienen ficha.
- **C5 parámetros no leídos por `plan()`**: `exchangeAccountId` → motor/API; `symbol` → motor/API; `marginMode` → motor/API; `stopLossPct` → motor/API; `maxDailyLossPct` → motor/API; `liquidationAction` → motor/API; `cooldownMinutes` → MUERTO; `preloadInventory` → solo validate/preview.
- **C6 valores fuera de rango que `validate()` acepta** (base válida): `totalInvestment`=9, `maxNotionalCap`=-1, `stopLossPct`=180, `stopLossPct`=-0.9, `stopLossPct`=-1, `maxDailyLossPct`=200, `maxDailyLossPct`=-0.9, `maxDailyLossPct`=-1, `cooldownMinutes`=20160, `cooldownMinutes`=-1.
- **C6b campos obligatorios ausentes que revientan preview/validate**: ninguno.

## NEUTRAL_GRID (`neutral-grid.ts`, 20 campos, 9 propios)

- **C1 fields ↔ interfaz `NeutralGridConfig`**: limpio.
- **C2 default ↔ defaults()**: `marginMode`: descriptor ISOLATED vs defaults() CROSS. 
- **C3 textos**: todos los labelKey/helpKey presentes. descriptionKey `strategy.neutral.description` ausente (sin lector; STRATEGY_BLURBS cubre el kind).
- **C4 fichas de la guía in-app**: todos los campos propios tienen ficha.
- **C5 parámetros no leídos por `plan()`**: `exchangeAccountId` → motor/API; `symbol` → motor/API; `direction` → solo validate/preview; `marginMode` → motor/API; `maxNotionalCap` → MUERTO; `stopLossPct` → motor/API; `maxDailyLossPct` → motor/API; `liquidationAction` → motor/API; `cooldownMinutes` → MUERTO.
- **C6 valores fuera de rango que `validate()` acepta** (base válida): `totalInvestment`=9, `maxNotionalCap`=-1, `stopLossPct`=180, `stopLossPct`=-0.9, `stopLossPct`=-1, `maxDailyLossPct`=200, `maxDailyLossPct`=-0.9, `maxDailyLossPct`=-1, `cooldownMinutes`=20160, `cooldownMinutes`=-1, `gridLevels`=400, `sizeMultiplier`=6, `sizeMultiplier`=0, `sizeMultiplier`=-1, `maxExposure`=-1, `reanchorThresholdPct`=100, `reanchorThresholdPct`=-0.5, `reanchorThresholdPct`=-1.
- **C6b campos obligatorios ausentes que revientan preview/validate**: ninguno.

## TDCA (`tdca.ts`, 18 campos, 7 propios)

- **C1 fields ↔ interfaz `TdcaConfig`**: limpio.
- **C2 default ↔ defaults()**: `leverage`: descriptor 2 vs defaults() 1. 
- **C3 textos**: todos los labelKey/helpKey presentes. descriptionKey `strategy.tdca.description` ausente (sin lector; STRATEGY_BLURBS cubre el kind).
- **C4 fichas de la guía in-app**: todos los campos propios tienen ficha.
- **C5 parámetros no leídos por `plan()`**: `exchangeAccountId` → motor/API; `symbol` → motor/API; `marginMode` → motor/API; `totalInvestment` → solo validate/preview; `maxNotionalCap` → MUERTO; `stopLossPct` → motor/API; `maxDailyLossPct` → motor/API; `liquidationAction` → motor/API; `cooldownMinutes` → MUERTO.
- **C6 valores fuera de rango que `validate()` acepta** (base válida): `totalInvestment`=9, `maxNotionalCap`=-1, `stopLossPct`=180, `stopLossPct`=-0.9, `stopLossPct`=-1, `maxDailyLossPct`=200, `maxDailyLossPct`=-0.9, `maxDailyLossPct`=-1, `cooldownMinutes`=20160, `cooldownMinutes`=-1, `intervalMinutes`=20160, `marginBelowAveragePct`=200, `marginBelowAveragePct`=-1, `takeProfitPct`=200, `maxPositionNotional`=-1.
- **C6b campos obligatorios ausentes que revientan preview/validate**: ninguno.

## MARTINGALE (`martingale.ts`, 18 campos, 7 propios)

- **C1 fields ↔ interfaz `MartingaleConfig`**: limpio.
- **C2 default ↔ defaults()**: `cooldownMinutes`: descriptor 0 vs defaults() 1. 
- **C3 textos**: todos los labelKey/helpKey presentes. descriptionKey `strategy.martingale.description` ausente (sin lector; STRATEGY_BLURBS cubre el kind).
- **C4 fichas de la guía in-app**: todos los campos propios tienen ficha (con LADDER_OPTION_DOCS).
- **C5 parámetros no leídos por `plan()`**: `exchangeAccountId` → motor/API; `symbol` → motor/API; `marginMode` → motor/API; `stopLossPct` → motor/API; `maxDailyLossPct` → motor/API; `liquidationAction` → motor/API.
- **C6 valores fuera de rango que `validate()` acepta** (base válida): `totalInvestment`=9, `maxNotionalCap`=-1, `stopLossPct`=180, `stopLossPct`=-0.9, `stopLossPct`=-1, `maxDailyLossPct`=200, `maxDailyLossPct`=-0.9, `maxDailyLossPct`=-1, `cooldownMinutes`=20160, `cooldownMinutes`=-1, `initialSeparationPct`=40, `volumeScale`=10, `stepScale`=6, `takeProfitPct`=100.
- **C6b campos obligatorios ausentes que revientan preview/validate**: `volumeScale` → Error, `stepScale` → Error.

## GRIDMART (`gridmart.ts`, 27 campos, 16 propios)

- **C1 fields ↔ interfaz `GridMartConfig`**: limpio.
- **C2 default ↔ defaults()**: sin contradicciones. 
- **C3 textos**: todos los labelKey/helpKey presentes. descriptionKey `strategy.gridmart.description` ausente (sin lector; STRATEGY_BLURBS cubre el kind).
- **C4 fichas de la guía in-app**: todos los campos propios tienen ficha (con LADDER_OPTION_DOCS).
- **C5 parámetros no leídos por `plan()`**: `exchangeAccountId` → motor/API; `symbol` → motor/API; `marginMode` → motor/API; `stopLossPct` → motor/API; `maxDailyLossPct` → motor/API; `liquidationAction` → motor/API; `takeProfitPct` → solo validate/preview; `tpMode` → MUERTO; `fullCycleCooldownMinutes` → MUERTO.
- **C6 valores fuera de rango que `validate()` acepta** (base válida): `totalInvestment`=9, `maxNotionalCap`=-1, `stopLossPct`=180, `stopLossPct`=-0.9, `stopLossPct`=-1, `maxDailyLossPct`=200, `maxDailyLossPct`=-0.9, `maxDailyLossPct`=-1, `cooldownMinutes`=20160, `cooldownMinutes`=-1, `initialSeparationPct`=40, `volumeScale`=10, `stepScale`=6, `takeProfitPct`=100, `satelliteTpPct`=40, `gridSellCount`=40, `gridSellInitialSeparationPct`=40, `gridSellDistanceMultiplier`=6, `gridSellDistanceMultiplier`=0, `gridSellDistanceMultiplier`=-1, `gridSellQtyMultiplier`=6, `gridSellQtyMultiplier`=-0.9, `gridSellQtyMultiplier`=-1, `gridRebuyDiscountPct`=40, `fullCycleCooldownMinutes`=20160, `fullCycleCooldownMinutes`=-1.
- **C6b campos obligatorios ausentes que revientan preview/validate**: `volumeScale` → Error, `stepScale` → Error, `gridSellDistanceMultiplier` → Error, `gridSellQtyMultiplier` → Error.

## MARKET_MAKER (`market-maker.ts`, 38 campos, 27 propios)

- **C1 fields ↔ interfaz `MarketMakerConfig`**: en `fields` y no en la interfaz: `sizingMode`, `limitAction`, `positionMode`, `priceFloor`, `priceCeiling`. 
- **C2 default ↔ defaults()**: `marginMode`: descriptor ISOLATED vs defaults() CROSS. 
- **C3 textos**: todos los labelKey/helpKey presentes. descriptionKey `strategy.mm.description` presente.
- **C4 fichas de la guía in-app**: todos los campos propios tienen ficha.
- **C5 parámetros no leídos por `plan()`**: `exchangeAccountId` → motor/API; `symbol` → motor/API; `marginMode` → motor/API; `totalInvestment` → motor/API; `maxNotionalCap` → MUERTO; `stopLossPct` → motor/API; `maxDailyLossPct` → motor/API; `liquidationAction` → motor/API; `cooldownMinutes` → MUERTO; `positionMode` → motor/API.
- **C6 valores fuera de rango que `validate()` acepta** (base válida): `totalInvestment`=9, `maxNotionalCap`=-1, `stopLossPct`=180, `stopLossPct`=-0.9, `stopLossPct`=-1, `maxDailyLossPct`=200, `maxDailyLossPct`=-0.9, `maxDailyLossPct`=-1, `cooldownMinutes`=20160, `cooldownMinutes`=-1, `maxLongPosition`=-1, `maxShortPosition`=-1, `buyDistanceBps`=2000, `sellDistanceBps`=2000, `sellDistanceBps`=0, `sellDistanceBps`=-1, `inventorySkewFactor`=6, `inventorySkewFactor`=-1, `refreshSeconds`=7200, `fillCooldownSeconds`=7200, `fillCooldownSeconds`=-1, `exitOrderTtlSeconds`=172800, `exitOrderTtlSeconds`=-1, `layerDistanceMultiplier`=6, `layerDistanceMultiplier`=0, `layerDistanceMultiplier`=-1, `layerSizeMultiplier`=6, `layerSizeMultiplier`=-0.9, `layerSizeMultiplier`=-1.
- **C6b campos obligatorios ausentes que revientan preview/validate**: ninguno.

## MARKET_MAKER_V2 (`market-maker-v2.ts`, 48 campos, 37 propios)

- **C1 fields ↔ interfaz `MarketMakerV2Config`**: en `fields` y no en la interfaz: `sizingMode`, `limitAction`, `positionMode`, `priceFloor`, `priceCeiling`. 
- **C2 default ↔ defaults()**: `marginMode`: descriptor ISOLATED vs defaults() CROSS; `leverage`: descriptor 2 vs defaults() 1. 
- **C3 textos**: todos los labelKey/helpKey presentes. descriptionKey `strategy.mmv2.description` presente.
- **C4 fichas de la guía in-app**: todos los campos propios tienen ficha.
- **C5 parámetros no leídos por `plan()`**: `exchangeAccountId` → motor/API; `symbol` → motor/API; `marginMode` → motor/API; `totalInvestment` → motor/API; `maxNotionalCap` → MUERTO; `stopLossPct` → motor/API; `maxDailyLossPct` → motor/API; `liquidationAction` → motor/API; `cooldownMinutes` → MUERTO; `positionMode` → motor/API; `sourceMarketType` → motor/API.
- **C6 valores fuera de rango que `validate()` acepta** (base válida): `totalInvestment`=9, `maxNotionalCap`=-1, `stopLossPct`=180, `stopLossPct`=-0.9, `stopLossPct`=-1, `maxDailyLossPct`=200, `maxDailyLossPct`=-0.9, `maxDailyLossPct`=-1, `cooldownMinutes`=20160, `cooldownMinutes`=-1, `buyDistanceBps`=4000, `sellDistanceBps`=4000, `sellDistanceBps`=0, `sellDistanceBps`=-1, `minAllowedDistanceBps`=1000, `minAllowedDistanceBps`=0, `minAllowedDistanceBps`=-1, `feeEstimateBps`=200, `feeEstimateBps`=-1, `safetyBufferBps`=400, `safetyBufferBps`=-1, `minProfitMarginBps`=1000, `minProfitMarginBps`=-1, `refreshSeconds`=7200, `repriceThresholdBps`=2000, `repriceThresholdBps`=0, `repriceThresholdBps`=-1, `orderMaxAgeSeconds`=172800, `orderMaxAgeSeconds`=-1, `fillCooldownSeconds`=7200, `fillCooldownSeconds`=-1, `exitOrderTtlSeconds`=172800, `exitOrderTtlSeconds`=-1, `volatilitySampleSeconds`=7200, `volatilitySampleSeconds`=29, `volatilitySampleSeconds`=-1, `orderBookMarginBps`=400, `orderBookMarginBps`=-1, `volatilityMultiplier`=10, `volatilityMultiplier`=-1, `maxDynamicSpreadBps`=10000, `maxDynamicSpreadBps`=0, `maxDynamicSpreadBps`=-1, `layerDistanceMultiplier`=6, `layerDistanceMultiplier`=0, `layerDistanceMultiplier`=-1, `layerSizeMultiplier`=6, `layerSizeMultiplier`=-0.9, `layerSizeMultiplier`=-1.
- **C6b campos obligatorios ausentes que revientan preview/validate**: ninguno.

## C7 — preview frente a peor caso

- Grid Classic (ejemplo A de la guía): preview worstCaseNotional=596.79 worstCaseMargin=300.00; suma de TODAS las líneas=1191.72 (F-88).
- TDCA (5x para forzar avisos): 1 avisos, 0 duplicados (F-14): 

## C8 — defaults con 100 USDC por venue (niveles con violaciones)

- **LIGHTER BTC** @ 78910.1: GRID_CLASSIC: INVALIDO (20/20 niveles con violación) · NEUTRAL_GRID: INVALIDO (20/20 niveles con violación) · TDCA: INVALIDO (0/0 niveles con violación) · MARTINGALE: INVALIDO (2/7 niveles con violación) · GRIDMART: INVALIDO (2/11 niveles con violación) · MARKET_MAKER: ok (0/6 niveles con violación) · MARKET_MAKER_V2: ok (0/2 niveles con violación)
- **LIGHTER BTC (testnet, minimo doble)** @ 78603.3: GRID_CLASSIC: INVALIDO (20/20 niveles con violación) · NEUTRAL_GRID: INVALIDO (20/20 niveles con violación) · TDCA: INVALIDO (0/0 niveles con violación) · MARTINGALE: INVALIDO (3/7 niveles con violación) · GRIDMART: INVALIDO (3/11 niveles con violación) · MARKET_MAKER: ok (0/6 niveles con violación) · MARKET_MAKER_V2: ok (0/2 niveles con violación)
- **LIGHTER ETH** @ 2503.35: GRID_CLASSIC: INVALIDO (20/20 niveles con violación) · NEUTRAL_GRID: INVALIDO (20/20 niveles con violación) · TDCA: INVALIDO (0/0 niveles con violación) · MARTINGALE: INVALIDO (3/7 niveles con violación) · GRIDMART: INVALIDO (3/11 niveles con violación) · MARKET_MAKER: ok (0/6 niveles con violación) · MARKET_MAKER_V2: ok (0/2 niveles con violación)
- **LIGHTER SOL** @ 138.42: GRID_CLASSIC: INVALIDO (20/20 niveles con violación) · NEUTRAL_GRID: INVALIDO (20/20 niveles con violación) · TDCA: INVALIDO (0/0 niveles con violación) · MARTINGALE: INVALIDO (3/7 niveles con violación) · GRIDMART: INVALIDO (3/11 niveles con violación) · MARKET_MAKER: ok (0/6 niveles con violación) · MARKET_MAKER_V2: ok (0/2 niveles con violación)
- **HYPERLIQUID BTC** @ 78910: GRID_CLASSIC: INVALIDO (20/20 niveles con violación) · NEUTRAL_GRID: INVALIDO (20/20 niveles con violación) · TDCA: INVALIDO (0/0 niveles con violación) · MARTINGALE: INVALIDO (2/7 niveles con violación) · GRIDMART: INVALIDO (2/11 niveles con violación) · MARKET_MAKER: ok (0/6 niveles con violación) · MARKET_MAKER_V2: ok (0/2 niveles con violación)
- **HYPERLIQUID ETH** @ 2503.3: GRID_CLASSIC: INVALIDO (20/20 niveles con violación) · NEUTRAL_GRID: INVALIDO (20/20 niveles con violación) · TDCA: INVALIDO (0/0 niveles con violación) · MARTINGALE: INVALIDO (2/7 niveles con violación) · GRIDMART: INVALIDO (2/11 niveles con violación) · MARKET_MAKER: ok (0/6 niveles con violación) · MARKET_MAKER_V2: ok (0/2 niveles con violación)
- **HYPERLIQUID DOGE (step entero)** @ 0.09209: GRID_CLASSIC: INVALIDO (20/20 niveles con violación) · NEUTRAL_GRID: INVALIDO (20/20 niveles con violación) · TDCA: INVALIDO (0/0 niveles con violación) · MARTINGALE: INVALIDO (2/7 niveles con violación) · GRIDMART: INVALIDO (2/11 niveles con violación) · MARKET_MAKER: ok (0/6 niveles con violación) · MARKET_MAKER_V2: ok (0/2 niveles con violación)
- **HYPERLIQUID kPEPE (tick minusculo)** @ 0.004133: GRID_CLASSIC: INVALIDO (19/20 niveles con violación) · NEUTRAL_GRID: INVALIDO (19/20 niveles con violación) · TDCA: INVALIDO (0/0 niveles con violación) · MARTINGALE: INVALIDO (2/7 niveles con violación) · GRIDMART: INVALIDO (2/11 niveles con violación) · MARKET_MAKER: ok (0/6 niveles con violación) · MARKET_MAKER_V2: ok (0/2 niveles con violación)
- **ASTER BTCUSDT** @ 78910.1: GRID_CLASSIC: INVALIDO (20/20 niveles con violación) · NEUTRAL_GRID: INVALIDO (20/20 niveles con violación) · TDCA: INVALIDO (0/0 niveles con violación) · MARTINGALE: INVALIDO (6/7 niveles con violación) · GRIDMART: INVALIDO (10/11 niveles con violación) · MARKET_MAKER: INVALIDO (6/6 niveles con violación) · MARKET_MAKER_V2: INVALIDO (2/2 niveles con violación)
- **ASTER ETHUSDT** @ 2503.35: GRID_CLASSIC: ok (0/20 niveles con violación) · NEUTRAL_GRID: ok (0/20 niveles con violación) · TDCA: INVALIDO (0/0 niveles con violación) · MARTINGALE: INVALIDO (2/7 niveles con violación) · GRIDMART: INVALIDO (2/11 niveles con violación) · MARKET_MAKER: ok (0/6 niveles con violación) · MARKET_MAKER_V2: ok (0/2 niveles con violación)
- **ASTER DOGEUSDT (step entero)** @ 0.09209: GRID_CLASSIC: ok (0/20 niveles con violación) · NEUTRAL_GRID: ok (0/20 niveles con violación) · TDCA: INVALIDO (0/0 niveles con violación) · MARTINGALE: INVALIDO (1/7 niveles con violación) · GRIDMART: INVALIDO (1/11 niveles con violación) · MARKET_MAKER: ok (0/6 niveles con violación) · MARKET_MAKER_V2: ok (0/2 niveles con violación)
- **ASTER 1000PEPEUSDT (tick de 7 decimales)** @ 0.0041336: GRID_CLASSIC: ok (0/20 niveles con violación) · NEUTRAL_GRID: ok (0/20 niveles con violación) · TDCA: INVALIDO (0/0 niveles con violación) · MARTINGALE: INVALIDO (1/7 niveles con violación) · GRIDMART: INVALIDO (1/11 niveles con violación) · MARKET_MAKER: ok (0/6 niveles con violación) · MARKET_MAKER_V2: ok (0/2 niveles con violación)
```

## 7. Salida del script de ejemplos

```

== grid-classic · A · Lateral amplio en BTC · LIGHTER BTC @ 78910.1 
   valid=true niveles=20
   peorCaso: notional=596.79 margen=300.00 media=75257.7
   liq=38005.1 dist=51.84% tp=null
   minNotional por nivel=59.17 (venue min 10, minQty 0.0001)
   peorCasoReal (todas las lineas, F-88)=1191.72 notional / 595.86 margen
     GRID_BUY#0 BUY 72000.0×0.00083 (59.76)
     GRID_BUY#1 BUY 72736.8×0.00082 (59.64)
     GRID_BUY#2 BUY 73473.6×0.00081 (59.51)
     GRID_BUY#3 BUY 74210.5×0.00080 (59.37)
     GRID_BUY#4 BUY 74947.3×0.00080 (59.96)
     GRID_BUY#5 BUY 75684.2×0.00079 (59.79)
     … (11 más)
     GRID_SELL#17 SELL 84526.4×0.00070 (59.17)
     GRID_SELL#18 SELL 85263.2×0.00070 (59.68)
     GRID_SELL#19 SELL 86000.0×0.00069 (59.34)

== grid-classic · B · Acumular SOL sin apalancamiento · LIGHTER SOL @ 138.42 
   valid=true niveles=25
   peorCaso: notional=239.26 margen=240.00 media=128.910
   liq=0.645 dist=99.53% tp=null
   minNotional por nivel=19.87 (venue min 10, minQty 0.1)
   peorCasoReal (todas las lineas, F-88)=498.33 notional / 498.33 margen
     GRID_BUY#0 BUY 120.000×0.166 (19.92)
     GRID_BUY#1 BUY 121.666×0.164 (19.95)
     GRID_BUY#2 BUY 123.333×0.162 (19.98)
     GRID_BUY#3 BUY 125.000×0.160 (20.00)
     GRID_BUY#4 BUY 126.666×0.157 (19.89)
     GRID_BUY#5 BUY 128.333×0.155 (19.89)
     … (16 más)
     GRID_SELL#22 SELL 156.667×0.127 (19.90)
     GRID_SELL#23 SELL 158.334×0.126 (19.95)
     GRID_SELL#24 SELL 160.000×0.125 (20.00)

== grid-classic · C · Rejilla corta sobre un techo (ETH) · HYPERLIQUID ETH @ 2503.3 
   valid=true niveles=16
   peorCaso: notional=898.40 margen=300.00 media=2650.2
   liq=3520.3 dist=40.63% tp=null
   minNotional por nivel=74.74 (venue min 10, minQty 0.0001)
   peorCasoReal (todas las lineas, F-88)=1197.99 notional / 399.33 margen
     GRID_SELL#0 BUY 2400.0×0.0312 (74.88)
     GRID_SELL#1 BUY 2426.6×0.0309 (74.98)
     GRID_SELL#2 BUY 2453.3×0.0305 (74.83)
     GRID_SELL#3 BUY 2480.0×0.0302 (74.90)
     GRID_BUY#4 SELL 2506.7×0.0299 (74.95)
     GRID_BUY#5 SELL 2533.4×0.0296 (74.99)
     … (7 más)
     GRID_BUY#13 SELL 2746.7×0.0273 (74.98)
     GRID_BUY#14 SELL 2773.4×0.0270 (74.88)
     GRID_BUY#15 SELL 2800.0×0.0267 (74.76)

== neutral-grid · A · Ancla clara en ETH · LIGHTER ETH @ 2503.35 
   valid=true niveles=24
   peorCaso: notional=1596.89 margen=800.00 media=2475.42
   liq=1250.09 dist=50.06% tp=null
   minNotional por nivel=66.42 (venue min 10, minQty 0.005)
     GRID_BUY#0 BUY 2200.00×0.0303 (66.66)
     GRID_BUY#1 BUY 2223.18×0.0299 (66.47)
     GRID_BUY#2 BUY 2246.62×0.0296 (66.50)
     GRID_BUY#3 BUY 2270.30×0.0293 (66.52)
     GRID_BUY#4 BUY 2294.23×0.0290 (66.53)
     GRID_BUY#5 BUY 2318.41×0.0287 (66.54)
     … (15 más)
     GRID_SELL#21 SELL 2741.90×0.0243 (66.63)
     GRID_SELL#22 SELL 2770.80×0.0240 (66.50)
     GRID_SELL#23 SELL 2800.00×0.0238 (66.64)

== neutral-grid · B · BTC con tope de exposición · LIGHTER BTC @ 78910.1 
   valid=true niveles=20
   peorCaso: notional=1992.41 margen=1000.00 media=78782.4
   liq=39785.1 dist=49.58% tp=null
   minNotional por nivel=99.25 (venue min 10, minQty 0.0001)
     GRID_BUY#0 BUY 74000.0×0.00135 (99.90)
     GRID_BUY#1 BUY 74495.3×0.00134 (99.82)
     GRID_BUY#2 BUY 74993.9×0.00133 (99.74)
     GRID_BUY#3 BUY 75495.9×0.00132 (99.65)
     GRID_BUY#4 BUY 76001.2×0.00131 (99.56)
     GRID_BUY#5 BUY 76509.9×0.00130 (99.46)
     … (11 más)
     GRID_SELL#17 SELL 82886.7×0.00120 (99.46)
     GRID_SELL#18 SELL 83441.5×0.00119 (99.30)
     GRID_SELL#19 SELL 84000.0×0.00119 (99.96)

== neutral-grid · C · SOL cargando los extremos · LIGHTER SOL @ 138.42 
   valid=true niveles=12
   peorCaso: notional=1199.18 margen=600.00 media=132.829
   liq=67.079 dist=51.54% tp=null
   minNotional por nivel=22.96 (venue min 10, minQty 0.1)
     GRID_BUY#0 BUY 115.000×2.287 (263.01)
     GRID_BUY#1 BUY 118.836×1.475 (175.28)
     GRID_BUY#2 BUY 122.801×0.952 (116.91)
     GRID_BUY#3 BUY 126.898×0.614 (77.92)
     GRID_BUY#4 BUY 131.132×0.396 (51.93)
     GRID_BUY#5 BUY 135.507×0.255 (34.55)
     GRID_SELL#6 SELL 140.029×0.164 (22.96)
     GRID_SELL#7 SELL 144.701×0.239 (34.58)
     GRID_SELL#8 SELL 149.529×0.347 (51.89)
     GRID_SELL#9 SELL 154.518×0.504 (77.88)
     GRID_SELL#10 SELL 159.673×0.732 (116.88)
     GRID_SELL#11 SELL 165.001×1.063 (175.40)

== tdca · A · Acumular BTC con paciencia · LIGHTER BTC @ 78910.1 
   valid=true niveles=20
   peorCaso: notional=491.88 margen=500.00 media=75211.3
   liq=376.1 dist=99.52% tp=76339.5
   minNotional por nivel=24.26 (venue min 10, minQty 0.0001)
     BASE#0 BUY 78910.1×0.00031 (24.46)
     SAFETY#1 BUY 78515.5×0.00031 (24.34)
     SAFETY#2 BUY 78122.9×0.00032 (25.00)
     SAFETY#3 BUY 77732.3×0.00032 (24.87)
     SAFETY#4 BUY 77343.6×0.00032 (24.75)
     SAFETY#5 BUY 76956.9×0.00032 (24.63)
     … (11 más)
     SAFETY#17 BUY 72464.4×0.00034 (24.64)
     SAFETY#18 BUY 72102.1×0.00034 (24.51)
     SAFETY#19 BUY 71741.6×0.00034 (24.39)

== tdca · B · Cazar caídas rápidas en ETH · HYPERLIQUID ETH @ 2503.3 
   valid=true niveles=15
   peorCaso: notional=597.73 margen=600.00 media=2297.2
   liq=11.5 dist=99.54% tp=2343.1
   minNotional por nivel=39.77 (venue min 10, minQty 0.0001)
     BASE#0 BUY 2503.3×0.0159 (39.80)
     SAFETY#1 BUY 2473.2×0.0161 (39.82)
     SAFETY#2 BUY 2443.5×0.0163 (39.83)
     SAFETY#3 BUY 2414.2×0.0165 (39.83)
     SAFETY#4 BUY 2385.2×0.0167 (39.83)
     SAFETY#5 BUY 2356.6×0.0169 (39.83)
     … (6 más)
     SAFETY#12 BUY 2165.6×0.0184 (39.85)
     SAFETY#13 BUY 2139.7×0.0186 (39.80)
     SAFETY#14 BUY 2114.0×0.0189 (39.95)

== tdca · C · Comprar sin condiciones (DOGE) · ASTER DOGEUSDT (step entero) @ 0.09209 
   valid=true niveles=20
   peorCaso: notional=299.10 margen=300.00 media=0.08777
   liq=0.00044 dist=99.52% tp=0.09215
   minNotional por nivel=14.91 (venue min 5, minQty 1)
     BASE#0 BUY 0.09209×162 (14.92)
     SAFETY#1 BUY 0.09162×163 (14.93)
     SAFETY#2 BUY 0.09117×164 (14.95)
     SAFETY#3 BUY 0.09071×165 (14.97)
     SAFETY#4 BUY 0.09026×166 (14.98)
     SAFETY#5 BUY 0.08981×167 (15.00)
     … (11 más)
     SAFETY#17 BUY 0.08456×177 (14.97)
     SAFETY#18 BUY 0.08414×178 (14.98)
     SAFETY#19 BUY 0.08372×179 (14.99)

== martingale · A · Escalera equilibrada en ETH · LIGHTER ETH @ 2503.35 
   valid=true niveles=7
   peorCaso: notional=799.62 margen=400.00 media=1807.05
   liq=912.56 dist=63.55% tp=1828.73
   minNotional por nivel=18.52 (venue min 10, minQty 0.005)
     BASE#0 BUY 2503.35×0.0074 (18.52)
     SAFETY#1 BUY 2428.24×0.0122 (29.62)
     SAFETY#2 BUY 2330.61×0.0204 (47.54)
     SAFETY#3 BUY 2203.69×0.0345 (76.03)
     SAFETY#4 BUY 2038.70×0.0597 (121.71)
     SAFETY#5 BUY 1824.20×0.1067 (194.64)
     SAFETY#6 BUY 1545.36×0.2016 (311.54)

== martingale · B · BTC conservador, escalera corta · LIGHTER BTC @ 78910.1 
   valid=true niveles=7
   peorCaso: notional=2696.73 margen=900.00 media=67350.9
   liq=45237.4 dist=42.67% tp=68024.4
   minNotional por nivel=112.84 (venue min 10, minQty 0.0001)
     BASE#0 BUY 78910.1×0.00143 (112.84)
     SAFETY#1 BUY 77331.8×0.00204 (157.76)
     SAFETY#2 BUY 75359.1×0.00294 (221.56)
     SAFETY#3 BUY 72893.2×0.00426 (310.53)
     SAFETY#4 BUY 69810.7×0.00622 (434.22)
     SAFETY#5 BUY 65957.7×0.00922 (608.13)
     SAFETY#6 BUY 61141.4×0.01393 (851.70)
   WARNING maxNotionalCap: El tope (2400.00) es menor que el notional del bot (2700.00): no llegara a tender la escalera completa.

== martingale · C · DOGE agresivo, al filo · ASTER DOGEUSDT (step entero) @ 0.09209 
   valid=true niveles=6
   peorCaso: notional=599.80 margen=300.00 media=0.06268
   liq=0.03165 dist=65.63% tp=0.06456
   minNotional por nivel=28.82 (venue min 5, minQty 1)
     BASE#0 BUY 0.09209×313 (28.82)
     SAFETY#1 BUY 0.08748×495 (43.30)
     SAFETY#2 BUY 0.08149×797 (64.95)
     SAFETY#3 BUY 0.07371×1321 (97.37)
     SAFETY#4 BUY 0.06360×2298 (146.15)
     SAFETY#5 BUY 0.05045×4345 (219.21)

== gridmart · A · GridMart completo sobre ETH · LIGHTER ETH @ 2503.35 
   valid=true niveles=10
   peorCaso: notional=1599.40 margen=800.00 media=2093.46
   liq=1057.20 dist=57.77% tp=2114.39
   minNotional por nivel=125.42 (venue min 10, minQty 0.005)
     BASE#0 BUY 2503.35×0.0501 (125.42)
     SAFETY#1 BUY 2428.24×0.0671 (162.93)
     SAFETY#2 BUY 2330.61×0.0909 (211.85)
     SAFETY#3 BUY 2203.69×0.1250 (275.46)
     SAFETY#4 BUY 2038.70×0.1757 (358.20)
     SAFETY#5 BUY 1824.20×0.2552 (465.54)
     GRID_SELL#6 SELL 2114.42×0.1910 (403.85)
     GRID_SELL#7 SELL 2139.54×0.1910 (408.65)
     GRID_SELL#8 SELL 2169.69×0.1910 (414.41)
     GRID_SELL#9 SELL 2205.86×0.1910 (421.32)

== gridmart · B · Modo clásico (BTC) · LIGHTER BTC @ 78910.1 
   valid=true niveles=8
   peorCaso: notional=1197.06 margen=600.00 media=59436.9
   liq=30015.6 dist=61.96% tp=60150.1
   minNotional por nivel=37.09 (venue min 10, minQty 0.0001)
     BASE#0 BUY 78910.1×0.00047 (37.09)
     SAFETY#1 BUY 76937.3×0.00072 (55.39)
     SAFETY#2 BUY 74274.1×0.00112 (83.19)
     SAFETY#3 BUY 70678.7×0.00178 (125.81)
     SAFETY#4 BUY 65825.0×0.00286 (188.26)
     SAFETY#5 BUY 59272.5×0.00477 (282.73)
     SAFETY#6 BUY 50426.6×0.00842 (424.59)
     TAKE_PROFIT#7 SELL 60167.5×0.02018 (1214.18)

== gridmart · C · SOL con rejilla ancha · LIGHTER SOL @ 138.42 
   valid=true niveles=10
   peorCaso: notional=1399.79 margen=700.00 media=113.739
   liq=57.438 dist=58.50% tp=114.877
   minNotional por nivel=127.90 (venue min 10, minQty 0.1)
     BASE#0 BUY 138.420×0.924 (127.90)
     SAFETY#1 BUY 132.191×1.354 (178.99)
     SAFETY#2 BUY 124.093×2.020 (250.67)
     SAFETY#3 BUY 113.566×3.090 (350.92)
     SAFETY#4 BUY 99.881×4.919 (491.31)
     GRID_SELL#5 SELL 115.447×2.461 (284.12)
     GRID_SELL#6 SELL 117.409×2.461 (288.94)
     GRID_SELL#7 SELL 119.665×2.461 (294.50)
     GRID_SELL#8 SELL 122.260×2.461 (300.88)
     GRID_SELL#9 SELL 125.244×2.461 (308.23)

0 ejemplo(s) en rojo
```
