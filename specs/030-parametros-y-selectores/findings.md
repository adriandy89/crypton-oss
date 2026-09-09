# 030 — Hallazgos: parámetros, selectores y lo que el formulario no dice

Fecha: 2026-09-09. Modo: solo lectura sobre el código, más una sonda local contra el `dist` ya
compilado (sin red, sin credenciales). Escala de severidad: la de `specs/README.md`.

Origen: el usuario preguntó por el selector **«Introducir tamaños en · Valor nocional / Cantidad de
moneda»** y pidió revisar, uno por uno, los parámetros de las siete estrategias, qué afecta cada uno,
y si el formulario y el backend deben cambiar según lo que el usuario elige.

---

## F-01 — `sizingMode: BASE` es inutilizable en cualquier moneda que no sea barata

**Severidad: Alta.** Confirmada con sonda.

- **Evidencia**: `market-maker.ts:88-97` y `market-maker-v2.ts:145-154` declaran
  `orderSizePerSide` con `kind: 'money'`, `unit: 'USDC'` y **`min: 1`**, fijos. La validación
  genérica del spec 019 aplica ese mínimo a rajatabla: `common.ts:335-337`
  (`if (f.min != null && n.lt(f.min))`). Pero `sizingMode` cambia **la naturaleza del número**:
  `mm-shared.ts:183-189`, `sizeToQty` → con `BASE` «el usuario teclea moneda y el número ya ES la
  cantidad».
- **Sonda** (`dist` compilado, `MARKET_MAKER`, `sizingMode: 'BASE'`, `orderSizePerSide: '0.05'`):

  ```
  [ERROR] orderSizePerSide - orderSizePerSide no puede ser menor que 1.
  ```

- **Impacto**: en modo «Cantidad de moneda» **no se puede pedir menos de 1 unidad**. En BTC eso es
  ~100.000 USDC por capa **y por lado**; en ETH, ~3.000. Con las 3 capas de fábrica y dos lados, el
  bot más pequeño que el formulario acepta compromete seis veces esa cifra. El modo sólo es usable
  en monedas de menos de ~10 USDC, y en el resto la estrategia no se puede crear.
- **Y el mensaje no ayuda**: «no puede ser menor que 1», sin unidad ni explicación de que el mínimo
  está pensado en USDC.
- **Contrato de arreglo**: el mínimo de `orderSizePerSide` no puede ser una constante del
  descriptor cuando `sizingMode` decide la unidad. Con `BASE` el mínimo que importa es el del
  mercado (`minQty`), y el suelo debe salir de ahí; con `QUOTE` sigue siendo el nocional. Ficheros:
  `market-maker.ts`, `market-maker-v2.ts` (descriptor y `validate`), y `bot-create.page.ts`
  (`capFields`, que ya reescribe `leverage` con el tope del mercado y es el sitio natural).
  Test: `strategies.spec.ts` «con `sizingMode: BASE` una cantidad por debajo de 1 pero por encima
  del mínimo del mercado es válida».

- **Decisión**: corregido (commit `71eca24`): `camposEfectivos()` en `common.ts`, aplicada por
  `registry.ts` antes de `validateMeta` en `validate()` y en `preview()`. Con `BASE` el mínimo pasa a
  ser `market.minQty` (o el `stepSize` si el venue no la declara). Sonda repetida tras el arreglo:
  `valida: true`. Tests: cinco en `strategies.spec.ts`, «el tamaño en moneda no se mide en USDC».

---

## F-02 — El campo dice **USDC** aunque el usuario haya elegido «Cantidad de moneda»

**Severidad: Alta.** Misma raíz que F-01, corrección distinta.

- **Evidencia**: `unit: 'USDC'` fijo en los dos descriptores (arriba). `ui-field.component.ts:124-125`
  pinta `field().unit` tal cual, dentro del input. `bot-create.page.ts:405-431`: `fields()` sólo
  quita cuenta y par, y `capFields` sólo reescribe `leverage` — **no hay nada que dependa de
  `sizingMode`**. En toda la app, `sizingMode` aparece únicamente en textos de ayuda
  (`field-labels.ts:166-167,206-207`, guías); ninguna lógica lo lee.
- **Impacto**: el usuario elige «Cantidad de moneda», teclea `50` con el campo rotulándole `USDC`, y
  el bot coloca 50 unidades de la moneda. En LIT (~4,85) son ~242 USDC por capa y lado, cinco veces
  lo que creía; en un par caro, un orden de magnitud. Es el campo más importante de la estrategia.
- **Lo que lo hace serio**: el propio `ui-field` justifica la existencia de `unit` con este mismo
  argumento (`:27-29`): «equivocarse cuesta dinero: 40 bps y 40 % no se parecen en nada».
- **Contrato de arreglo**: la unidad del campo pasa a depender del modo — `USDC` con `QUOTE`, el
  símbolo base del par (`market.base`) con `BASE`. El sitio es `capFields`, que ya hace exactamente
  esto con `leverage`. Test: el descriptor que llega a `ui-field` lleva `unit: 'BTC'` con
  `sizingMode: BASE` en el par BTC.

- **Decisión**: corregido (commits `71eca24` y `6972425`): la misma `camposEfectivos()` devuelve
  `unit: market.base` con `BASE`, y `capFields` la aplica en el formulario antes de su ajuste de
  apalancamiento. La regla es una sola y la comparten app, `validate()` y API.

---

## F-03 — En modo BASE se pierden dos avisos de riesgo y nadie los suple

**Severidad: Media.**

- **Evidencia**: `market-maker.ts:564` y `:584` se saltan enteros con
  `cfg.sizingMode !== SizingMode.BASE`. Son el aviso de «las capas de un lado suman más que el tope
  de posición» y el de «el tope por lado no deja sitio ni a la cotización más pequeña» (001/F-64).
- **Por qué se saltan**: `validate()` no tiene precio, y sin precio no se puede comparar una
  cantidad de moneda con un tope en nocional. La decisión es razonable **ahí**.
- **Impacto**: quien usa el modo BASE se queda sin las dos guardas, y no se le dice. El agujero de
  F-64 —una cara del bot muerta en silencio— vuelve a estar abierto en este modo.
- **Contrato de arreglo**: `preview()` **sí** recibe `refPrice`, así que las dos comprobaciones
  caben ahí para el modo BASE. Ficheros: `market-maker.ts` y `market-maker-v2.ts` (`preview`).

- **Decisión**: corregido (commit `71eca24`): `avisosDeTopeEnMoneda()` en `market-maker.ts`, llamada
  desde `preview()`. Sólo la V1: la V2 no tiene topes por lado. Tres tests.

---

## F-04 — Parámetros que quedan inertes según un selector, sin decirlo

**Severidad: Media.**

El patrón correcto ya existe en el repo y está aplicado a medias. **Sí avisan**:

- Neutral Grid, `direction` (`neutral-grid.ts:309-316`): «la dirección no sesga la retícula neutral».
- Market Maker V2, `priceSource` frente a `fairPriceOrigin` (`market-maker-v2.ts:751-759`): «has
  elegido una fuente externa pero el ancla es el libro del propio venue».

**No avisan** (confirmado leyendo cada uso):

| Selector | Deja inerte a | Evidencia |
|---|---|---|
| `inventoryPriceAdjustment: false` (MM v1) | `inventorySkewFactor` | `market-maker.ts:768-769` (`skewFactor = D(0)`) |
| `dynamicSpread: false` (MM v2) | `orderBookMarginBps`, `volatilityMultiplier` y, con ellos, `volatilitySampleSeconds` | `market-maker-v2.ts:685-688` (`dynamicAdd = D(0)`) |
| `buyOnlyIfImprovesAverage: false` (TDCA) | `marginBelowAveragePct` | `tdca.ts:287-290` (sólo se usa dentro del `if`) |
| `classicMode: true` (GridMart) | `gridSellCount`, `gridSellInitialSeparationPct`, `gridSellDistanceMultiplier`, `corePctSoldAtLevel1`, `gridSellQtyMultiplier` | `gridmart.ts:281`, `:354`, `:499`, `:585` |

- **Impacto**: el usuario configura una protección o un comportamiento que no existe. Es el mismo
  problema que 001/F-12 («parámetros muertos») pero por combinación, no por parámetro.
- **Contrato de arreglo**: un `warn` en `validate()` por cada pareja, con el texto del patrón ya
  establecido. Barato y sin cambiar conducta.

- **Decisión**: corregido (commit `71eca24`): un `warn` por pareja, con el texto del patrón. El techo
  del diferencial (`maxDynamicSpreadBps`) queda fuera del aviso porque **sí** sigue aplicándose con
  `dynamicSpread: false`. GridMart avisa una vez, no cinco. Cuatro tests.

---

## F-05 — Campos de dinero sin unidad

**Severidad: Baja.**

- **Evidencia**: `tdca.amountPerBuy` (`money`, `min: 1`), `tdca.maxPositionNotional` (`money`,
  `min: 0`) y `neutral-grid.maxExposure` (`money`, `min: 0`) **no declaran `unit`**, mientras
  `totalInvestment` (`common.ts:89-99`) y los cuatro campos de dinero de los market makers sí lo
  llevan.
- **Impacto**: tres campos de dinero sin unidad en el input, en dos estrategias. Cosmético, pero es
  justo lo que `unit` existe para evitar.

- **Decisión**: corregido (commit `71eca24`).

---

## F-06 — El formulario no refleja ninguna dependencia entre campos

**Severidad: Baja** (se convierte en Media si no se corrigen F-02 y F-04).

- **Evidencia**: `bot-create.page.ts:405-409` (`fields()`) y `:456-490` (`groupsOf`) reparten los
  campos por `group` y por `advanced`, y nada más. No hay filtrado, ocultación ni deshabilitado por
  valor de otro campo.
- **Impacto**: con `activationMode: NONE` se sigue pidiendo `activationPrice`; con
  `priceSource: EXCHANGE` se siguen ofreciendo `sourceSymbolOverride` y `sourceMarketType`; y todos
  los de F-04. El Market Maker V2 declara 38 campos: la mitad no aplica en una configuración dada.
- **Nota**: la agrupación por secciones ya ayuda (`dynamicSpread`, `priceSource`, `activation` son
  grupos propios). Lo que falta es que el grupo se pliegue o se atenúe cuando su interruptor está
  apagado.

- **Decisión**: corregido en su variante acotada (commit `6972425`): los grupos `dynamicSpread`,
  `priceSource` y `activation` se atenúan con la etiqueta «no aplica ahora» cuando su selector los
  deja inertes. **No se oculta nada**: ocultar esconde configuración ya escrita y mueve los demás
  campos de sitio. Decisión del usuario entre las tres opciones ofrecidas.

---

## Verificado correcto (no son hallazgos)

- **Grid Classic, `sizingMode`**: aquí **no** cambia la unidad que teclea el usuario. El capital
  sigue siendo `totalInvestment` en USDC y el modo sólo decide el reparto —mismo importe por línea
  (`QUOTE`) o mismas unidades (`BASE`)—: `grid-classic.ts:139-144`. Su etiqueta, «Reparto del
  tamaño» (`field-labels.ts:49`), es correcta y distinta a propósito de la de los market makers.
- **`maxBotPositionValue`, `maxLongPosition`, `maxShortPosition`**: son nocional **siempre**, también
  en modo BASE (`sizeToQty` devuelve `notional` y los topes se comparan con él). Su `unit: 'USDC'`
  es correcto.
- **La app y la API previsualizan con el mismo precio**: `bot-create.page.ts:1146-1152` manda
  `refPrice` justamente para que no discrepen cerca del mínimo con `sizingMode: BASE` (001/F-66).
- **Validación genérica**: `common.ts:300-341` acota `min`, `max`, enteros y `options` de todo el
  descriptor (spec 019). Es sólida; el problema de F-01 no es que valide, es que el descriptor
  miente cuando el modo cambia.
- **Market Maker V2, `validate()`**: avisa del techo del diferencial a 0, de la comisión a 0, del
  suelo por distancia mínima frente al suelo por coste, y de la fuente externa ignorada. Es la
  validación más completa de las siete.
