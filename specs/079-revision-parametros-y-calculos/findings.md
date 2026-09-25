# 079 — Hallazgos

Commit base: `bdb3f5e` (`main`) · Fecha: 2026-09-25 · Versiones: node 22, pnpm 10.28.1 · Hosts
sondeados: ninguno (solo documentación oficial).

## Línea base

En el worktree `CRYPTON-080`, sobre `bdb3f5e`, paquete a paquete desde Git Bash:

| Paquete | Resultado |
|---|---|
| `pnpm build:packages` | verde |
| shared | 250 de 250 |
| strategy-core | 994 de 994 |
| exchange-core | 517 de 517 cuando corre solo. Bajo `pnpm test` fallan `cooldown.spec` y `rate-limit.spec`, dos tests de tiempo que no aguantan la carga, y `pnpm test` para ahí |
| backtest | 75 de 75 |
| worker | 681 de 681 |
| api | 6325 de 6327 |

Los dos rojos de la API no dependen del código:

- `app.module.spec` pide `APP_REDIRECT_WEB`, que en la copia principal llega del `.env`; el worktree
  no tiene `.env`, a propósito.
- Un caso de `backtests.service.spec` pasa de 30 s bajo carga; solo, pasa: 21 de 21.

## Referencias oficiales

| Fuente | Regla | Cita literal | URL | Fecha |
|---|---|---|---|---|
| Binance Futures | ROI y precio objetivo | «ROI% = PnL / Initial Margin = Side * (1 - Settlement Price / Entry Price) / IMR»; «Long target price = Entry Price * ( ROI% / Leverage + 1 )»; «Short target price = Entry Price * ( 1 - ROI% / Leverage )»; «IMR = 1 / leverage» | https://www.binance.com/en/support/faq/how-to-use-the-binance-futures-calculator-360036498511 | 2026-09-25 |
| Binance Futures | TP/SL por ROI | «Configure Take Profit and Stop Loss by: PNL: Estimated PNL amount · ROI: Estimated ROI% · Offset %: % change relative to the last market price» | https://x.com/BinanceFutures/status/1846974460781609092 | 2026-09-25 |
| Binance Futures | Resultado estimado | «Estimated PnL = (Exit Price - Entry Price) * Position Size» (USDⓈ-M) | https://www.binance.com/en/support/faq/how-to-calculate-profit-and-loss-for-futures-contracts-3a55a23768cb416fb404f06ffedde4b2 | 2026-09-25 |
| Binance Futures | Retroceso del trailing, sobre el precio | «If you set the callback rate to 1%, the trailing stop will continue to follow the price at a distance of 1%»; rango 0,1-10 % | https://www.binance.com/en/support/faq/what-is-a-trailing-stop-order-360042299292 | 2026-09-25 |
| Binance DCA | Desviación y objetivo, sobre el precio | «Price Deviation… if you set 5%, the bot will set a buy or sell order for every 5% change from the base order»; «Take Profit refers to the target profit percentage based on the average price» | https://www.binance.com/en/support/faq/binance-spot-dca-parameters-797f6e465186474fac2add2f7ce0474a | 2026-09-25 |
| Hyperliquid | Precio de liquidación | «liq_price = price - side * margin_available / position_size / (1 - l * side)»; «side = 1 for long and -1 for short»; «l = 1 / MAINTENANCE_LEVERAGE»; «margin_available (isolated) = isolated_margin - maintenance_margin_required» | https://hyperliquid.gitbook.io/hyperliquid-docs/trading/liquidations | 2026-09-25 |
| Hyperliquid | Mantenimiento | «The maintenance margin is half of the initial margin at max leverage, which varies from 3-40x.» | https://hyperliquid.gitbook.io/hyperliquid-docs/trading/liquidations | 2026-09-25 |
| Lighter | Mantenimiento y disparo | «Maintenance Margin Req := ∑ S_i × mark_i × M_i»; liquidación parcial cuando «Maintenance Margin Req > Account Value > Close-out Margin Req»; en aislado «the position will be treated as a separate account… the collateral for an isolated position is called AllocatedMargin» | https://docs.lighter.xyz/trading/liquidations-and-llp-insurance-fund | 2026-09-25 |
| Aster | Mantenimiento por tramos | «Maintenance margin… It's based on the total size of your position rather than the leverage you select»; «higher portions fall into higher maintenance margin tiers, each with progressively higher rates»; «If your margin falls below the maintenance requirement, your position may be liquidated» | https://docs.asterdex.com/trading/perpetuals/margin | 2026-09-25 |

**La fórmula exacta del código coincide con la de Hyperliquid.** Despejando la de HL con
`margin_available = q·E/L − q·E·l`:

- largo: `E(1 − 1/L)/(1 − l)`;
- corto: `E(1 + 1/L)/(1 + l)`.

Es exactamente `precioLiquidacionAislada` (`liquidation.ts:206-222`), con `l` = el mantenimiento,
que HL fija en `1/(2·maxLev)`. Es la regla de `maintenanceMarginRateOf` (`liquidation.ts:72-80`).

En Lighter, la liquidación parcial empieza cuando el valor de la cuenta baja de `S·mark·M`, que es
la misma ecuación con `M` = la fracción de mantenimiento.

En Aster, con la tasa del tramo que rige y sin el «importe de mantenimiento» que descuentan los
tramos altos, la fórmula queda del lado conservador.

**La lineal `estimateLiquidationPrice` (`liquidation.ts:24-38`), la que usa toda la previsualización
salvo las IA, es una aproximación que en corto sale optimista:** 89184 frente a 89127 en el caso del
usuario.

## El caso del usuario, cifra a cifra

TRAILING_PROFIT, SHORT, 15×, `totalInvestment` 120, `takeProfitPct` 15, `trailingCallbackPct` 1,1
(deducido del «mínimo 72702»), `stopLossPct` 5 (de fábrica). Mercado BTC con `maxLeverage` 40, así
que `mmr = 1/(2·40) = 1,25 %`.

| Cifra de la pantalla | Cómo sale | Qué es de verdad |
|---|---|---|
| Exposición 1799,46 / margen 120 | `min(120·15, …)` = 1800 → `qty = floor(1800/84601)` = 0,02127 | Correcto |
| Precio medio 84601 | `activationPrice` (entrada condicionada) | El precio de hoy era ≈ 84455 |
| Objetivo 71911 | `84601 × (1 − 15/100)` | **15 % del precio = +225 % del margen = +270 USDC** |
| Liquidación 89184 | Lineal: `84601 × (1 + 1/15 − 0,0125)` | Exacta: **89127** |
| «Aguanta 5,60 %» | `|89184 − 84455| / 84455` | Desde la **entrada** son 5,42 % (lineal) o **5,35 %** (exacta) |
| «~6,7 %» | `100/15` | Ignora el mantenimiento |
| Stop (no se ve) | `84601 × 1,05` = 88831 | −90 USDC = **−75 % del margen**, a 0,35 % de la liquidación exacta |
| Mínimo que cobra, 72702 | `71911 × 1,011` | +253 USDC, +211 % del margen |

## Resumen

| ID | Título | Área | Severidad | Estado | Arreglo |
|---|---|---|---|---|---|
| F-01 | El stop puede quedar en la liquidación o detrás, y nada lo comprueba | riesgo | Alta | confirmado · 080 fase 2 | M |
| F-02 | GridMart: la previsualización dimensiona las ventas de la rejilla sobre la posición entera | preview | Alta | confirmado · 080 fase 4 | S |
| F-03 | `RiskService` mide el nocional de un MM con un campo que el MM no lee | riesgo | Alta | confirmado · 080 fase 3 | S |
| F-04 | Los % de resultado son del precio y se presentan como beneficio o pérdida | semántica | Media | confirmado · 080 fases 2 y 7 | L |
| F-05 | Seguimiento: la previsualización ignora que la condición de entrada ya se cumple | preview | Media | confirmado · 080 fase 4 | S |
| F-06 | Seguimiento en corto con objetivo ≥ 100: el seguimiento no se arma nunca | validación | Media | confirmado · 080 fase 2 | S |
| F-07 | Cinco distancias a la liquidación distintas y una fórmula lineal optimista | riesgo | Media | confirmado · 080 fases 1 y 4 | M |
| F-08 | La app comprueba el 5 % con un mantenimiento plano del 0,5 %; el asesor también | deriva | Media | confirmado · 080 fase 1 | S |
| F-09 | La Revisión no enseña el stop, ni el resultado en USDC, ni el ROI | preview | Media | confirmado · 080 fase 4 | L |
| F-10 | Rejilla neutral en SHORT: liquidación del lado equivocado | preview | Media | confirmado · 080 fase 4 | S |
| F-11 | Neutral y MM: exposición, margen y precio medio mezclan los dos lados | preview | Media | confirmado · 080 fase 4 | M |
| F-12 | TDCA: la previsualización proyecta contra el precio anterior, no contra la media | preview | Media | confirmado · 080 fase 4 | S |
| F-13 | Rejilla en modo BASE: margen por línea `T/n` en vez de nocional/L | preview | Media | confirmado · 080 fase 4 | S |
| F-14 | MM: la previsualización ignora suelos y topes que `plan()` sí aplica | preview | Media | confirmado · 080 fase 4 | M |
| F-15 | Martingala/TDCA con trailing: el «Objetivo» es la activación y no se avisa | preview | Media | confirmado · 080 fase 4 | S |
| F-16 | La condición del aviso «retroceso ≥ objetivo» es falsa | validación | Media | confirmado · 080 fase 2 | S |
| F-17 | «Puedes perder todo el margen asignado» es falso en cruzado | app | Media | confirmado · 080 fase 4 | S |
| F-18 | Rótulos que no dicen la base de cada %, ayudas que faltan o sobran | textos | Media | confirmado · 080 fase 7 | M |
| F-19 | Guías que contradicen al código | textos | Media | confirmado · 080 fase 7 | M |
| F-20 | Cabeceras de «escalera» en estrategias sin escalera | app | Media | confirmado · 080 fase 4 | S |
| F-21 | Previsualización con HALF_UP donde el plan redondea por lado | preview | Baja | confirmado · 080 fase 4 | S |
| F-22 | Tendencia: riesgo sin unidad, ATR fijo del 2 %, NEUTRAL solo en largo | preview | Baja | confirmado · 080 fases 4 y 7 | S |
| F-23 | AGENT_TRADE y AI_CHANNEL: previsualización distinta de su validación | preview | Baja | confirmado · 080 fase 4 | S |
| F-24 | GridMart: punto de equilibrio con niveles sin redondear | preview | Baja | confirmado · 080 fase 4 | S |
| F-25 | App: «marca» que es el último precio, y dinero en `number` | app | Baja | confirmado · 080 fases 4 y 5 | S |
| F-26 | Asesor: ámbar al 15 %, el resto de la app al 10 y al 25 % | app | Baja | confirmado · 080 fase 4 | S |
| F-27 | El aviso de `maxNotionalCap` habla de «escalera» en todas | textos | Baja | confirmado · 080 fase 7 | S |
| F-28 | La guía de la rejilla dice que a 1× no hay liquidación | textos | Baja | confirmado · 080 fase 7 | S |
| F-29 | Un campo opcional vacío revienta `validate`, `preview` y `plan` | robustez | Media | encontrado y corregido en el 080 (fase 7) | S |

Ninguna **Crítica**. F-01 cumple (1) y (3) de la escala: se alcanza con una configuración válida y
se demuestra con un test. Pero en aislado la pérdida está acotada al margen asignado («pérdida
acotada»), y eso es **Alta**. El usuario puede subirla.

## Fichas

### F-01 — El stop puede quedar en la liquidación o detrás, y nada lo comprueba

- **Síntoma.** Un `stopLossPct` más ancho que la distancia a la liquidación nunca salta: el venue
  liquida antes y se pierde el margen entero.
  - Seguimiento de beneficio con los valores de fábrica (stop del 5 %) a 16× en BTC, el máximo que
    admite la regla del 5 %: la liquidación exacta del corto queda a 4,94 %.
  - Cualquier estrategia a 15× con stop del 10 %.
- **Evidencia.**
  - `common.ts:315-321` solo exige 0 < stop < 100.
  - `risk.service.ts:85-140` solo mira el apalancamiento.
  - El asesor (`advisor/build.ts:651-680`) calcula el stop por volatilidad, entre el 1 y el 30 %,
    sin mirar la liquidación: 30 % a 3× con mantenimiento > 3,3 % queda detrás.
  - El supervisor solo lo estrecha (`supervisor/apply.ts:941-950`).
  - Solo las IA lo comprueban: `canal/herramienta.ts:523-525`, `agent-trade.ts:1079-1098` y la
    regla `HOLGURA_LIQUIDACION = 0.5` de `operacion/gestion.ts:37-38`.
  - La guía se lo pide al usuario: «¿El apalancamiento deja la liquidación más lejos que tu stop?»
    (`docs/trailing-profit.md:164`).
- **Impacto.** El usuario cree tener una pérdida máxima y pierde todo el margen asignado.
- **Propuesta.** En aislado, error si el stop queda en la liquidación exacta o detrás; aviso si la
  liquidación queda a menos de medio stop detrás del stop (la regla de la casa). En cruzado, solo
  aviso. Con una propuesta del stop más ancho válido.
- **Decisión.** Del usuario, 2026-09-25 (D-3 y D-4).

### F-02 — GridMart: la previsualización dimensiona las ventas de la rejilla sobre la posición entera

- **Evidencia.**
  - `gridmart.ts:372-378` llama a `gridSellLevels(cfg, breakeven, worstQty)`, con `worstQty` = la
    base más todas las seguridades.
  - `plan()` llama a `gridSellLevels(cfg, breakeven, coreQty)` con `coreQty = min(qty base, pos)`
    (`gridmart.ts:519`, `566`).
- **Impacto.**
  - Con los valores de fábrica, las ventas de la previsualización salen ≈ Σw/w₀ ≈ 43 veces más
    grandes que las reales.
  - La comprobación del mínimo de nocional (`violations`) se hace sobre esa cantidad: un bot que la
    pantalla da por válido coloca ventas por debajo del mínimo, y el venue las rechaza orden a orden.
  - Es la clase de defecto que la escala llama «bot muerto en un venue o configuración».
- **Propuesta.** La previsualización dimensiona sobre el núcleo, igual que `plan()`, y el objetivo
  sobre el satélite.

### F-03 — `RiskService` mide el nocional de un MM con un campo que el MM no lee

- **Evidencia.**
  - `risk.service.ts:94`: `notional = opts.nocional ? D(opts.nocional) : investment.mul(leverage)`.
  - Los MM (`market-maker.ts`, `market-maker-v2.ts`) no declaran `nocionalMaximo` y no leen
    `totalInvestment`: su tope real es `maxBotPositionValue`.
- **Impacto.** Los límites de nocional por bot y por usuario comparan un número que no es el que el
  MM puede abrir: sobra en un caso y falta en otro. Es un error contable que alimenta una guarda.
- **Propuesta.** El MM declara su nocional máximo (`maxBotPositionValue`) y la API lo usa.

### F-04 — Los % de resultado son del precio y se presentan como beneficio o pérdida

- **Síntoma.** A 15×, «Objetivo 15 %» es +225 % del margen, y «Stop loss 5 %» es −75 %.
- **Evidencia.**
  - `ladder.ts:128-135` y `ladder.ts:179-186`: `entrada × (1 ± pct/100)`, sin apalancamiento.
  - Los rótulos: «Stop loss (%)» (`field-labels.ts:32`), «Beneficio al que empieza a seguir (%)»
    (`:146-149`), y «Con 15 % y 1 %, lo mínimo que cobras es +13,85 %» (`:96`, `:128`).
  - El detalle de un bot vivo, en cambio, enseña «X % sobre el margen» (`bot-detail.page.html:175`).
- **Impacto.** El usuario razona como en un exchange, donde el TP/SL se da por ROI (ver Binance
  arriba), y ve objetivos y pérdidas desproporcionados.
- **Decisión.** Del usuario (D-1 y D-2): los % de **resultado** pasan a medirse sobre el margen; las
  **distancias** siguen sobre el precio, como en Binance.

### F-05 — Seguimiento: la previsualización ignora que la condición de entrada ya se cumple

- **Evidencia.**
  - `trailing-profit.ts:273-280` toma `activationPrice` como entrada siempre que hay condición.
  - `activationGate` (`mm-shared.ts:966-975`) arma **en el acto** si el precio ya la cumple, y
    `plan()` entra a mercado al precio de ese momento (`trailing-profit.ts:391-432`).
- **Impacto.** Entrada, cantidad, objetivo y liquidación se enseñan sobre un precio que no será el
  de la entrada.

### F-06 — Seguimiento en corto con objetivo ≥ 100: el seguimiento no se arma nunca

- **Evidencia.**
  - `takeProfitPrice(E, 100, 'SHORT')` = 0 (`ladder.ts:128-135`).
  - `trailingVigente` arma cuando `extremo ≤ objetivo` (`trailing-take-profit.ts:281`), y eso no
    ocurre con un precio positivo.
  - `validate()` solo exige > 0 (`trailing-profit.ts:216-219`) y el campo llega a 500 (`:117`).
- **Impacto.** Un parámetro que anula la estrategia: solo queda el stop.

### F-07 — Cinco distancias a la liquidación distintas y una fórmula lineal optimista

- **Evidencia**, sobre el caso del usuario:

  | Distancia | Valor | De dónde sale |
  |---|---|---|
  | Aviso del apalancamiento | 6,7 % | `100/L` (`common.ts:282-285`) |
  | Regla del 5 % | 5,42 % | lineal, desde la entrada (`common.ts:263-281`) |
  | «Aguanta» | 5,60 % | desde el precio de hoy y en valor absoluto (`common.ts:624`, `liquidation.ts:41-45`) |
  | Fórmula exacta | 5,35 % | solo en las IA (`liquidation.ts:206-241`) |
  | App | 6,2 % | 0,5 % plano (`bot-create.page.ts:918-929`) |

- **Impacto.**
  - El usuario no puede saber cuál creer.
  - Con una entrada condicionada al lado de ruptura (largo PRICE_ABOVE, corto PRICE_BELOW), la
    liquidación puede quedar al otro lado del precio de hoy, y el valor absoluto lo esconde.
- **Propuesta.** Una sola fórmula, la exacta, que coincide con la de Hyperliquid. La distancia se
  mide desde la entrada, y la del precio de hoy se enseña aparte y con signo.

### F-08 — La app comprueba el 5 % con un mantenimiento plano del 0,5 %; el asesor también

- **Evidencia.**
  - `bot-create.page.ts:918-929`: `(1/L − 0,005)·100 < 5`, con un comentario que dice «Se calcula
    igual» que el servidor, que usa el mantenimiento del mercado (`common.ts:263`).
  - `advisor/sanitize.ts:20-34`: `MAX_SAFE_LEVERAGE = 18`, con el mismo razonamiento.
- **Impacto.** Con un mantenimiento del mercado ≤ 0,26 %, la app bloquea un 19× que el servidor
  acepta; y el asesor ignora el tope real de cada par.

### F-09 — La Revisión no enseña el stop, ni el resultado en USDC, ni el ROI

- **Evidencia.**
  - `PreviewResult` (`packages/shared/src/bot.ts:322-335`) no tiene stop, ni resultado, ni ROI.
  - `buildPreview` ni recibe `stopLossPct`.
  - La tabla del peor caso (`bot-create.page.html:410-440`) enseña precios sueltos.
- **Impacto.** La cifra que decide cuánto se puede perder no está en la pantalla donde se decide.

### F-10 — Rejilla neutral en SHORT: liquidación del lado equivocado

- **Evidencia.**
  - `neutral-grid.ts:344` pasa `direction: 'SHORT'` con `neutral: true`.
  - `buildPreview` calcula entonces la liquidación del **largo** (la media de las compras) con la
    fórmula del **corto** (`common.ts:578-579`).
- **Impacto.** Una liquidación por encima de la entrada de un largo: un número sin sentido.

### F-11 — Neutral y MM: exposición, margen y precio medio mezclan los dos lados

- **Evidencia.**
  - «Exposición» y «Margen» suman todas las entradas, compras y ventas (`common.ts:547-551`), que
    en modo unidireccional nunca conviven.
  - «Precio medio» pondera las dos a la vez (`common.ts:571`).
  - La guía repite la cifra inflada: «los 1.600 USDC que permitiría el apalancamiento»
    (`neutral-grid.guide.ts:43`).
- **Propuesta.** Un bloque por lado.

### F-12 — TDCA: la previsualización proyecta contra el precio anterior, no contra la media

- **Evidencia.**
  - `tdca.ts:252-257`: `projected = projected × (1 ∓ m)`, aunque el comentario dice «respecto de la
    media anterior».
  - `plan()` compra cuando `mark ≤ media × (1 − m)` (`tdca.ts:370-379`).
- **Impacto.** La escalera enseñada es más profunda que la real, y con `m = 0` todas las compras
  caen en el mismo precio.

### F-13 — Rejilla en modo BASE: margen por línea `T/n` en vez de nocional/L

- **Evidencia.** `grid-classic.ts:258`: `perLevelMargin = totalInvestment / n`, cuando en modo BASE
  el nocional de cada línea es `p·qty` (`levelQty`).
- **Impacto.** El margen enseñado no es nocional/L. La diferencia crece cuanto más lejos del precio
  está el rango.

### F-14 — MM: la previsualización ignora suelos y topes que `plan()` sí aplica

- **Evidencia.**
  - V1: la previsualización usa `buyDistanceBps × pesos × perfil` (`market-maker.ts:732,747`);
    `plan()` aplica `max(minAllowedDistanceBps, …)` (`:1039-1042`, `:1094-1101`) y recorta capas
    con los topes (`:1062`, `:1111`).
  - V2: no recorta capas al tope (`market-maker-v2.ts:1231-1308` frente a `:1564-1569`,
    `:1740-1754`), y le falta el aviso de «capas por encima del tope» que la V1 sí tiene.
- **Impacto.** Con el perfil agresivo, 10/8 bps se enseñan como 7 bps y el bot cotiza a 8.

### F-15 — Martingala/TDCA con trailing: el «Objetivo» es la activación y no se avisa

- **Evidencia.** Con `trailingTakeProfit`, el objetivo es donde empieza a seguir. El seguimiento de
  beneficio lo avisa (`trailing-profit.ts:313-324`); martingala y TDCA pintan el mismo número sin
  aviso.

### F-16 — La condición del aviso «retroceso ≥ objetivo» es falsa

- **Evidencia.** `trailing-profit.ts:246-255` avisa si `cb ≥ tp`. La salida en pérdida llega en
  realidad con:
  - largo: `(1+t)(1−c) < 1`, es decir `c > t/(1+t)`;
  - corto: `(1−t)(1+c) > 1`, es decir `c > t/(1−t)`.
- **Ejemplos.**
  - Largo, t = 3 % y c = 2,95 %: sale a 0,9996 × entrada, en pérdida, y **no avisa**.
  - Corto, t = 10 % y c = 10 %: sigue en beneficio, y **avisa**. El texto dice además «por debajo
    del precio de entrada», que en corto es al revés.

### F-17 — «Puedes perder todo el margen asignado» es falso en cruzado

- **Evidencia.** `bot-create.page.html:543-545`. En cruzado respalda la posición todo el saldo libre
  de la cuenta (`collateralBacking`, `liquidation.ts:122`).

### F-18 — Rótulos que no dicen la base de cada %, ayudas que faltan o sobran

- **Evidencia.**
  - `stopLossPct` y `maxDailyLossPct` no tienen `helpKey` (`common.ts:112-136`): uno es del precio y
    el otro del capital, y están uno al lado del otro con «(%)».
  - El `takeProfitPct` de TDCA no tiene `helpKey` (`tdca.ts:121-131`), así que su ayuda de
    `field-labels.ts:90-92` no se ve nunca.
  - Textos que solo valen para el largo: «caer desde el máximo» (`field-labels.ts:150-153`).
  - «+13,85 %» presentado como lo que se cobra (`:96`, `:128`).
  - «Margen bajo la media (%)» (`:80`): «margen» choca con el margen del apalancamiento.
  - El TP satélite de GridMart y la separación de sus ventas no dicen su base (`:172-176`).

### F-19 — Guías que contradicen al código

- **Evidencia.**
  - `ladder-options.ts:35`: «La app rechaza… si la escalera entera **no cubre al menos** lo que te
    separa de la liquidación». Es al revés: `martingale.ts:228` rechaza cuando la cobertura **llega
    o pasa** la liquidación.
  - `gridmart.guide.ts:104` (la previsualización ya usa `satelliteTpPct`), `:129` (la recompra es
    siempre `fill × (1 − d)`), `:141` (el último nivel vende el resto, `gridmart.ts:232`) y `:153`.
  - «A 2×… hasta un 50 %» (`martingale.guide.ts:112`, `gridmart.guide.ts:62,165`), «a 10×, cercana
    al 10 %» y «hasta 50× en Aster» (`common-options.ts:32-37`): ignoran el mantenimiento y la regla
    del 5 %.
  - Tendencia y MM heredan los textos comunes, que para ellos son falsos:
    - en tendencia el stop % se ignora y el tamaño sale del riesgo;
    - en los MM `totalInvestment` no dimensiona nada.
  - MM V2:
    - el ejemplo pone 20/20 bps y calcula con 40 (`market-maker-v2.guide.ts:44`: «40 + 10,25 + 4 =
      54 bps»);
    - dice que el sesgo de inventario «llega apagado» (`:134`), cuando por defecto está encendido
      (`market-maker-v2.ts:1025-1026`);
    - dice «Con 0 no hay techo» (`:280`, `field-labels.ts:379`), cuando el mínimo del campo es 1
      (`market-maker-v2.ts:503`).
  - AI_CHANNEL: «Por defecto hacen falta dos confirmaciones» (`ai-channel.guide.ts:13`), y el valor
    por defecto es 1 (`canal/config.ts:77`).
  - `docs/riesgo-y-liquidacion.md:29,88,93-94`: la fórmula lineal con 0,005 fijo, líneas citadas
    caducadas, y la afirmación de que el formulario usa la misma regla.

### F-20 — Cabeceras de «escalera» en estrategias sin escalera

- **Evidencia.** `TEXTOS_ESCALERA` (`bot-create.page.ts:162-180`) sirve a todas menos AI_CHANNEL:
  - «Si se ejecuta la escalera entera» en el seguimiento, que tiene una sola orden;
  - «Esto es lo que se colocará» en tendencia, que espera una ruptura y estima su tamaño con un ATR
    supuesto.

### F-21 a F-28 — Bajas

- **F-21** — `buildPreview` formatea objetivo y liquidación con `toFixed`, que redondea HALF_UP, la
  regla por defecto de decimal.js; `px()` redondea por lado (`common.ts:622-625` frente a
  `common.ts:641-646`). Las cifras significativas de HL no se aplican en la previsualización.
- **F-22** — Tendencia:
  - `riskPerTradePct` no declara unidad (`trend-follow.ts`; «Riesgo por operación»,
    `field-labels.ts:199`);
  - el ATR de la previsualización es un 2 % fijo (`trend-follow.ts:231,496`);
  - en NEUTRAL solo se pinta el largo.
- **F-23** — AGENT_TRADE y AI_CHANNEL:
  - las dos previsualizaciones usan la liquidación lineal y la validación la exacta
    (`agent-trade.ts:1082` frente a `1133-1170`);
  - AGENT_TRADE pinta «—» de objetivo teniendo objetivos;
  - AI_CHANNEL calcula el riesgo con `min(riesgo, diario)` (`ai-channel.ts:1605-1669`), y el bot usa
    el 90 % de lo que queda del día (`canal/herramienta.ts:185-195`).
- **F-24** — GridMart: el punto de equilibrio sale de los niveles sin redondear (`gridmart.ts:372-374`),
  mientras `buildPreview` usa los redondeados.
- **F-25** — `mark()` devuelve el último negociado (`bot-create.page.ts:507-526`). Los avisos de
  límite calculan dinero con `number` (`:853-864`).
- **F-26** — `ui-recommendations.component.ts:280-284` pasa a ámbar por debajo del 15 %; el resto de
  la app, al 25 y al 10 % (`core/utils/risk.ts:14-16`).
- **F-27** — `common.ts:292-307`: el aviso «no llegará a tender la escalera completa» sale también
  en el seguimiento, cuya guía recomienda el tope para dimensionar, y en los MM, que no lo leen.
- **F-28** — `grid-classic.guide.ts:57`: «Sin apalancamiento no hay precio de liquidación», y la
  previsualización pinta una a 1× en largo (`entrada × mmr`).

### F-29 — Un campo opcional vacío revienta `validate`, `preview` y `plan`

- **Encontrado** durante el 080, al repasar la guía de la V2 («con 0 no hay techo», cuando el mínimo
  del campo es 1 y lo que deja sin techo es el campo vacío).
- **Evidencia.** El formulario manda `''` al vaciar una casilla. `validateMeta` lo trata como
  ausente, pero las estrategias leen `D(cfg.x ?? defecto)`, y `??` no tapa la cadena vacía:
  `new Decimal('')` lanza. Recorriendo todos los campos de todas las estrategias salen 24 caminos que
  lanzan en `validate()` o `preview()`, en seis estrategias, y más de cuarenta en `plan()`: los dos
  market makers casi enteros, la rejilla neutral, el DCA, la tendencia y el seguimiento.
- **Impacto.** `POST /bots/preview` y la creación responden un 500 con un `DecimalError` crudo. Un
  campo vacío que `validate()` deja pasar —el umbral defensivo del market maker— revienta el tick
  del worker en cada revisión; el stop nativo sigue puesto, pero el bot deja de gestionar su
  posición. En la app, el panel de riesgo desaparece sin decir por qué.
- **Arreglo (080).** El registro de estrategias, por el que pasan la API, el worker, la app y el
  backtest, entrega la configuración con la regla de `validateMeta` (`sinVacios`): un opcional
  vacío está ausente —un stop vacío es «sin stop»—, un obligatorio con valor de fábrica vale ese
  valor, y uno sin él se queda para que la validación diga «Falta». Test en `vacios.spec.ts`, que
  recorre todos los campos de todas las estrategias: sin el arreglo fallan 20 de sus 22 casos.

### F-30 a F-37 — Encontrados al rehacer las guías con el 080

Cada cifra de las guías se volvió a calcular con el código del 080, estrategia a estrategia. Donde la
cuenta no cuadraba con la guía, el defecto resultó estar a veces en el código, que ya estaba así en
`main`. Todos se corrigen en el 080 (D-6), cada uno con su test.

- **F-30 (Media)** — La Revisión no aplicaba el tope de exposición en la martingala, en GridMart ni
  en las dos rejillas, y `plan()` sí:
  - enseñaba la escalera o la retícula entera, con su liquidación, aunque el bot se fuera a parar en
    el tope;
  - la guía de la martingala lo tenía que decir aparte («vista previa, sin contar el tope»);
  - la validación de la escalera rechazaba por la liquidación seguridades que el tope nunca deja
    tender.
  El DCA tampoco aplicaba sus dos topes (`tdca.ts`, previsualización).
  - **Arreglo.** `recorridoPeorCaso` recibe el tope y corta con `TOPE`: un nivel entra si la posición
    que deja, valorada a su precio, cabe. Es la cota de lo que tiende el plan, que valora lo abierto
    al precio de ahora.
  - El tope se mira antes que el stop y la liquidación: un nivel que no se tiende no existe.
  - Los totales «de todas las órdenes» no cuentan lo que el tope no deja tender.
  - La app dice «El tope de exposición no deja tender…».
  - Un tope que no deja tender ninguna línea es un error en las dos rejillas (en la clásica, en modo
    importe).
- **F-31 (Media)** — Rejilla neutral: con la posición a cero, `plan()` contaba compras y ventas en
  un solo presupuesto del tope (`neutral-grid.ts`, `admitidas`).
  - Tendía la mitad de lo que cabía en cada lado al arrancar y tras cada cruce del cero.
  - La nota decía «Tope de exposición alcanzado: solo órdenes que reducen posición» sin posición que
    reducir.
  - La guía de la app prometía «cotizar en las veinte líneas».
  - **Arreglo.** Un presupuesto por lado, y una nota que dice cuántas líneas deja fuera.
- **F-32 (Media)** — Rejilla neutral: la validación medía la regla del 5 % y la del stop contra la
  dirección configurada (`ladoMasEstrecho(direction)`), aunque `plan()` no la lee. En Largo, un stop
  del 65 % a 2× pasaba sin aviso con la rejilla pudiendo acabar corta.
  - El aviso común del tope comparaba con el capital por el apalancamiento, que se reparte entre los
    dos lados.
  - **Arreglo.** Se mide siempre contra el corto, y el aviso del tope va por lado.
- **F-33 (Alta)** — Tendencia: nada comparaba el stop por ATR con la liquidación. Es la clase de F-01.
  - Ejemplo: a 10× en un par con un ATR de 4 h del 4 %, el stop a 2,5 ATR queda a un 10 % y la
    liquidación exacta a un 8,9 %: no salta nunca.
  - La pérdida queda acotada al margen aislado, pero el «riesgo por operación» deja de ser el de la
    operación, y la salida es una liquidación con su penalización.
  - **Arreglo.** En aislado `plan()` no entra si el stop quedaría en la liquidación o detrás, y lo
    anota; si cabe con poca holgura, entra y lo anota.
  - La validación avisa con el ATR de la estimación y dice a partir de qué volatilidad ese
    apalancamiento deja de caber.
- **F-34 (Baja)** — El margen de cada nivel de la previsualización lo ponía cada estrategia a su
  manera: el capital asignado al nivel, o el tamaño antes de redondear. Un market maker a 1× enseñaba
  35,00 de margen junto a 33,81 de nocional. **Arreglo.** Lo pone `buildPreview`: el nocional ya en
  la retícula entre el apalancamiento.
- **F-35 (Baja)** — Cuatro campos comunes tenían un valor por defecto en la ficha y otro en
  `defaults()` (037/F-08): el apalancamiento del DCA, el margen de la rejilla neutral y la espera de la
  martingala y de GridMart. Con `sinVacios` (F-29), un DCA con el apalancamiento en blanco se
  calculaba a 2×. **Arreglo.** Cada estrategia redefine el suyo con `commonFieldsWith`.
- **F-36 (Baja)** — Textos de la app que decían lo contrario del código:
  - el suelo y el techo de precio de los market makers bloquean solo el lado que abriría posición,
    y se rotulaban como «deja de abrir posición nueva»;
  - «Sin condición», en el seguimiento, abre a mercado en la primera revisión;
  - la nota de la Revisión del DCA decía «hasta dónde puede llegar el ciclo», y enseña lo contrario;
  - la guía de la V2 decía que la app no comprueba la distancia mínima, y avisa.
- **F-37 (Baja)** — Comentarios desfasados:
  - el del aviso sin sesgo por inventario, que la V2 trae encendido desde el 071;
  - el del defecto de la puerta de régimen;
  - el del simulador, que ya no liquida con un 0,5 % plano (P-6).

## Verificado OK

- **Signos del corto:** correctos en `scaledLadder`, `takeProfitPrice`, `stopLossPrice`,
  `gridSellLevels`, la recompra de GridMart y la condición de compra de TDCA.
- **Stop del motor.** `withStopLoss` toma la dirección del signo de la posición real y la entrada
  del venue (`stop-loss.ts:41-56`). Es correcto para las estrategias que cambian de lado.
- **Dinero en las estrategias:** todo en `Decimal`. `number` solo en el apalancamiento y el
  mantenimiento, y solo para dividir.
- **Martingala:** comprobar la cobertura desde el ancla contra la distancia a la liquidación desde
  la media es conservador.
- **Las IA** ya comprueban el stop frente a la liquidación, con la fórmula exacta.
- **`maxDailyLossPct`** es un % del capital del bot (`bot-runner.ts:3679-3696`): ya es «sobre el
  margen».
- **El simulador** no dispara un stop que queda detrás de la liquidación (`dry-run.ts:914-918`):
  liquida primero, como el venue.

## Decisiones del usuario (2026-09-25)

| # | Decisión |
|---|---|
| D-1 | Los % de **resultado** pasan a medirse sobre el **margen** (ROI), con la fórmula de Binance: `stopLossPct`, el `takeProfitPct` de martingala, TDCA y seguimiento de beneficio, y el `satelliteTpPct` de GridMart. |
| D-2 | Las **distancias** siguen sobre el **precio**, como en Binance: separaciones, retroceso y reprecio del trailing, descuento de recompra, margen bajo la media, bps del MM y stop ATR. AI_CHANNEL y AGENT_TRADE no cambian. |
| D-3 | Stop frente a liquidación: en aislado, error en la liquidación o detrás y aviso si queda cerca; en cruzado, solo aviso. |
| D-4 | Al cambiar el apalancamiento se mantiene el % sobre margen. El formulario enseña el equivalente en precio y en USDC, y propone el stop más ancho válido. |
| D-5 | Una migración convierte una vez los % guardados, y aborta si hay algún bot en marcha. |
| D-6 | No hay bots activos. Se corrige todo, de cualquier severidad, en el 080, sin dejar lógica vieja. |

Y las del plan aprobado el mismo día:

| # | Decisión |
|---|---|
| P-1 | Numeración 079/080, en un worktree aparte. |
| P-2 | El ROI se convierte con el apalancamiento de la configuración. El stop usa `max(config, posición del venue)` y avisa si no coinciden. |
| P-3 | Con posición abierta no se cambia el apalancamiento. |
| P-4 | El aviso de «stop cerca» usa `HOLGURA_LIQUIDACION = 0.5`. |
| P-5 | `START` vuelve a validar la configuración. |
| P-6 | El simulador usa el mantenimiento de cada mercado. |
| P-7 | Se elimina el `takeProfitPct` muerto de GridMart. |
| P-8 | El resultado en USDC, sin comisiones y rotulado así. |
| P-9 | Sin cabecera de versión: API, worker y app salen juntos. |

## Specs de seguimiento

| Nº | Slug | Hallazgos | Prioridad |
|---|---|---|---|
| 080 | `roi-y-revision-profesional` | F-01 a F-37 (F-29 a F-37, encontrados durante el propio 080) | Alta |
