# 037 — Hallazgos

Lo que se encontró revisando las dos estrategias de market maker contra sus propias guías y **no
se corrige aquí**. Lo que sí se corrige está en `spec.md` como R-1..R-10; no se repite.

La severidad sigue la escala de `specs/README.md`. Ninguno de estos hallazgos alcanza **Crítica**:
todos son pérdida acotada o probabilística, o degradación visible sin pérdida.

Commit base: `180af9b` · Fecha: 2026-09-11 · Hosts sondeados: ninguno (todo es conducta interna).

## Línea base

`pnpm build:packages` en verde. `pnpm test` exit 0: `strategy-core` 314 tests en 7 suites,
`apps/api` 4307 en 35 suites. `pnpm lint` limpio.

**Al cerrar el spec**: `strategy-core` **331** (17 nuevos), `apps/api` **4317** (10 nuevos),
`worker` 327, `backtest` 31. `pnpm lint` limpio y `ng build` de la app sin errores.

## Resumen

| ID | Título | Área | Severidad | Estado | Evidencia | Arreglo |
|---|---|---|---|---|---|---|
| F-01 | El coste de ida y vuelta se cobra dos veces en la V2 | `market-maker-v2` | Alta | confirmado, aplazado | `market-maker-v2.ts:679,691` | S, pero cambia bots en marcha |
| F-02 | La V2 no tiene topes por lado ni avisos de tope en moneda | `market-maker-v2` | Media | confirmado, aplazado | `market-maker.ts:1104` no se invoca en V2 | M |
| F-03 | `feeEstimateBps` no admite el rebate de maker | `market-maker-v2` | Media | confirmado, aplazado | `market-maker-v2.ts:227-244` | M |
| F-04 | `orderBookMarginBps` promete el libro y es una constante | `market-maker-v2` | Media | confirmado, aplazado | `market-maker-v2.ts:429-443` | S (o 039) |
| F-05 | Nadie valida la coherencia entre los cuatro tiempos | ambos | Media | confirmado, aplazado | sin guarda | S |
| F-06 | `plan()` no lee `totalInvestment` en ninguno de los dos | ambos | Media | confirmado, aplazado | — | M |
| F-07 | Un comentario de `validate()` promete una detección que no existe | `market-maker` | Baja | **corregido en 037** | `market-maker.ts:583-585` | S |
| F-08 | Cuatro estrategias declaran un `meta.default` que su `defaults()` contradice | todas menos las MM | Media | confirmado, aplazado | ver ficha | S |

Estados: `por confirmar` · `confirmado` · `corregido en NNN` · `seguimiento NNN` · `descartado`.

## Fichas

### F-01 — El coste de ida y vuelta se cobra dos veces en la V2

- **Síntoma**: la V2 cotiza más ancho de lo que su propia fórmula pretende. Con `feeEstimateBps: 2`
  cobra 8 bps de comisión donde el coste real de un par casado son 4.
- **Evidencia**: `composeSpreadBps` (`market-maker-v2.ts:677-697`) calcula
  `roundTripCost = fee × 2` y lo suma a **cada lado** (`:691`), además de meterlo en el suelo
  (`:681-684`). Una vuelta completa son dos lados, así que acaba llevando `4·fee`; y el suelo por
  vuelta acaba siendo `2 × (2·fee + margen) = 4·fee + 2·margen` donde lo correcto es
  `2·fee + margen`.
- **Impacto**: el bot ejecuta menos de lo que debería. No pierde dinero: **erra del lado seguro**.
  Por eso es Alta y no Crítica, y por eso no se toca sin permiso.
- **Reproducción**: `composeSpreadBps(cfg, D(20), D(0))` con `feeEstimateBps: '2'`,
  `minProfitMarginBps: '8'` ⇒ `bps = 25,5` y `floorBps = 12`. La vuelta completa cotiza 51 bps con
  un coste real de 4 y un margen pedido de 8: sobran 31.
- **Propuesta**: dividir entre dos el componente de coste y el suelo, o —mejor— renombrar los
  campos a «por vuelta» y dejar la fórmula. Las dos opciones **estrechan el diferencial de todos
  los bots V2 en marcha**.
- **Decisión**: **aplazado**. El principio 6 de `specs/README.md` exige decisión explícita del
  usuario para cambiar la semántica de un parámetro suyo. Spec de seguimiento propuesto.

### F-02 — La V2 no tiene topes por lado ni avisos de tope en moneda

- **Síntoma**: `maxLongPosition`/`maxShortPosition` no existen en la V2, y en
  `sizingMode: BASE` la V2 no da **ninguno** de los dos avisos que sí da la V1
  (`avisosDeTopeEnMoneda`, `market-maker.ts:1104-1152`, nacido del 030/F-03).
- **Evidencia**: `atCap` en la V2 es solo `|exposure| >= maxPos` (`market-maker-v2.ts:1197`); la
  V1 además mira `atCapLong`/`atCapShort` (`market-maker.ts:822-823`).
- **Impacto**: no se puede ser asimétrico en la V2, y en modo «cantidad de moneda» el usuario no
  recibe el aviso de que sus capas no caben en el tope.
- **Propuesta**: portar los dos mecanismos de la V1. Son campos nuevos: `meta.fields`,
  mutabilidad, formulario, guía.
- **Decisión**: **aplazado**. No es un mando que se pelee con otro, es funcionalidad que falta.

### F-03 — `feeEstimateBps` no admite el rebate de maker

- **Síntoma**: Hyperliquid **paga** al maker (−0,015 % en el escalón base de perpetuos). El campo
  está acotado a `min: 0, max: 100` (`market-maker-v2.ts:232-233`), así que un maker con rebate
  no puede declarar su economía real y cotiza más ancho de lo necesario.
- **Impacto**: menos ejecuciones de las que la economía del venue permite. Se agrava con F-01.
- **Propuesta**: permitir negativos y revisar el signo en el suelo y en la suma. Toca la fórmula
  entera y el formulario.
- **Decisión**: **aplazado**. Debería ir junto con F-01, que es el mismo trozo de fórmula.

### F-04 — `orderBookMarginBps` promete el libro y es una constante

- **Síntoma**: el campo se llama «margen del libro de órdenes», su ayuda habla de la anchura del
  libro y el docstring de la estrategia promete componer el diferencial *«a partir de la
  volatilidad realizada, la anchura del libro y el coste de operar»* (`market-maker-v2.ts:60-71`).
  Pero es un sumando fijo: la V2 **no importa `bookSpreadBps`**.
- **Evidencia**: `composeSpreadBps:686-689`; la lista de importaciones de `mm-shared` en la V2 no
  incluye `bookSpreadBps`, que sí existe (`mm-shared.ts:49-55`) y que la V1 sí usa vía
  `autoAdjustDistance`.
- **Impacto**: el usuario cree que el bot se adapta a la anchura real del libro y no lo hace.
- **Propuesta**: o se renombra el campo a lo que es, o se conecta al libro de verdad. Lo segundo
  encaja con el spec 039.
- **Decisión**: **aplazado al 039**, que ya va a tocar la composición del diferencial.

### F-05 — Nadie valida la coherencia entre los cuatro tiempos

- **Síntoma**: `refreshSeconds`, `orderMaxAgeSeconds`, `fillCooldownSeconds` y
  `volatilitySampleSeconds` se validan **uno a uno** y nunca entre sí. Combinaciones que hoy se
  guardan sin una palabra:
  - `orderMaxAgeSeconds < refreshSeconds` ⇒ la caducidad manda siempre y `refreshSeconds` deja de
    significar nada.
  - `fillCooldownSeconds > refreshSeconds` ⇒ el enfriamiento gana siempre, porque la puerta es
    `!cooling && (…)`.
  - `volatilitySampleSeconds` muy por encima de `orderMaxAgeSeconds` ⇒ se cotiza con una medida
    que aún no ha visto una ventana entera. Los dos valen 300 de fábrica **a propósito**
    (`market-maker-v2.ts:816-819`).
- **Impacto**: mandos que el usuario cree que ha puesto y que otro campo anula en silencio.
- **Propuesta**: tres avisos (no errores) en `validate()`, con el mismo criterio de «solo en lo
  patológico» que el 035 fijó para `repriceThresholdBps`: *«un aviso que sale siempre es un aviso
  que se ignora siempre»*.
- **Decisión**: **aplazado**. Es el mismo trabajo que el aviso de coherencia del 039 y conviene
  hacerlo de una vez, con la lista completa.

### F-06 — `plan()` no lee `totalInvestment` en ninguno de los dos

- **Síntoma**: `maxBotPositionValue` y `totalInvestment` no se relacionan en ningún sitio. El tope
  de posición no se compara con el capital que el usuario declara asignar al bot, y **los umbrales
  defensivo y de alto riesgo salen en porcentaje de ese tope**, no del capital.
- **Matiz importante**: `totalInvestment` **no es colateral segregado** —el bot comparte el margen
  de la cuenta, y `plan()` ni siquiera lo lee—, así que no se puede afirmar que un tope mayor que
  el capital sea inalcanzable: depende del saldo de la cuenta. Lo que sí es cierto es que un
  usuario que escribe «capital asignado 100» y «posición máxima 500» tiene sus tres redes de
  inventario calibradas sobre 500, no sobre los 100 que cree haber arriesgado.
- **Impacto**: el modo defensivo entra cinco veces más tarde de lo que el usuario cree. Hace falta
  configurarlo así a propósito, por eso es Media.
- **Propuesta**: aviso en `validate()` si `maxBotPositionValue > totalInvestment × leverage`, que
  es la cota superior de lo que ese capital podría sostener él solo.
- **Decisión**: **aplazado**, al mismo spec que F-05.

### F-07 — Un comentario de `validate()` promete una detección que no existe

- **Síntoma**: `market-maker.ts:583-585` dice que las capas que caen al mismo precio *«lo detecta
  `preview()`, donde `normalizeOrder()` marca los niveles que caen al mismo precio»*. No es
  verdad: `normalizeOrder` (`packages/shared/src/precision.ts:59-90`) comprueba precio, cantidad,
  `minNotional`, `minQty` y `maxQty`, y **no compara niveles entre sí**.
- **Impacto**: el comentario desvió la revisión de este mismo spec. Es exactamente el tipo de red
  documentada que resulta ser código muerto.
- **Decisión**: **corregido dentro del 037**, junto con R-2, que es el que hace real la detección
  para la V2.

### F-08 — Cuatro estrategias declaran un `meta.default` que su `defaults()` contradice

- **Síntoma**: el panel de ayuda de la app le enseña al usuario «por defecto: X» leyendo
  `meta.fields[].default`, y `coerceConfig` del asesor cae a ese mismo valor cuando no puede
  interpretar el del modelo. Pero el formulario se siembra con `defaults()`. Cuando los dos no
  coinciden, la ayuda miente.
- **Evidencia**: recorriendo `listStrategies()` quedan cuatro, todas en campos **comunes**:

  | Estrategia | Campo | `meta.default` | `defaults()` |
  |---|---|---|---|
  | `NEUTRAL_GRID` | `marginMode` | `ISOLATED` | `CROSS` |
  | `TDCA` | `leverage` | 2 | 1 |
  | `MARTINGALE` | `cooldownMinutes` | 0 | 1 |
  | `GRIDMART` | `cooldownMinutes` | 0 | 1 |

  El descriptor de un campo común vive una sola vez en `COMMON_FIELDS`
  (`packages/strategy-core/src/common.ts:32`) mientras cada estrategia lo redefine en su
  `defaults()`.
- **Impacto**: degradación visible sin pérdida. No toca lo que el bot hace, solo lo que la app
  cuenta y el valor al que cae el asesor ante un dato ilegible.
- **Reproducción / test**: `meta.default coincide con defaults() en toda estrategia`
  (`strategies.spec.ts`), que lleva estas cuatro como excepciones declaradas. **La lista tiene que
  menguar**: si crece, alguien ha desincronizado un campo nuevo.
- **Propuesta**: la vía ya existe y es la que usan los dos market makers desde este spec —
  `commonFieldsWith`, que deja a una estrategia redefinir el descriptor de un campo común. Son
  cuatro ficheros y cuatro líneas.
- **Decisión**: **aplazado**. El alcance del 037 son las dos estrategias de market maker; tocar las
  otras cuatro es un spec de limpieza, no este.

## Verificado OK

Lo que se revisó y estaba bien, para no volver a revisarlo:

- **`sinCruzarLibro`** (`mm-shared.ts:76-93`) y su orden de aplicación (antes de dimensionar). El
  clamp nunca empeora el precio y se aplica también al ancla manual y a la fuente externa. El 029
  lo dejó cerrado.
- **`precioEstable`** (`mm-shared.ts:108-168`) y su asimetría. La excepción del lado que el
  mercado alcanza es exacta, no heurística, y está probada con un camino de precio real.
- **`activationGate`** (`mm-shared.ts:478-501`): el armado irreversible y el fallo abierto ante un
  disparador inválido son deliberados y correctos.
- **El techo aplicado después de capa, preset y régimen** (`conTecho`): es el arreglo de 001/F-60
  y cumple la promesa de «nunca cotizo más ancho de X». Lo único mal es que `preview()` no lo
  usaba (R-4).
- **`fitToRoom`** (`market-maker-v2.ts:1416-1430`): el recorte en nocional respetando
  `minNotional` es correcto y está probado.
- **`limitBreach` y el id del aplanado**: distinto del `STOP_LOSS#0`, así que «Cerrar todo» sale
  aunque haya stop (001/F-02).

## Preguntas abiertas

1. **F-01**: ¿se corrige el doble cobro del coste de ida y vuelta, sabiendo que **estrecha el
   diferencial de todos los bots V2 en marcha**? Alternativa sin cambiar conducta: renombrar los
   campos a «por vuelta completa» y dejar la fórmula como está.
2. **R-2**: ¿el rechazo de `layers > 1` con multiplicador 1 debe ser ERROR (no se puede guardar) o
   aviso? Este spec asume ERROR, por analogía con la V1.

## Specs de seguimiento propuestos

| Nº propuesto | Slug | Hallazgos | Prioridad |
|---|---|---|---|
| 041 | `coste-y-rebate-en-la-v2` | F-01, F-03 | Alta — es dinero, pero necesita decisión del usuario |
| 042 | `coherencia-entre-mandos` | F-05, F-06 | Media — desarma redes de seguridad en silencio |
| 043 | `descriptores-al-dia` | F-08 | Baja — cuatro líneas, pero la ayuda miente hasta entonces |
| — | (dentro del 039) | F-04 | Media |
| — | (dentro del 038/039) | F-02 | Media |
