# 037 — Los mandos del market maker se pelean entre sí

Estado: `hecho` (falta CA-13, manual) · Tipo: `cambio` · Rama: `spec/037-combinaciones-de-market-maker`

## Objetivo

Que los mandos de las dos estrategias de market maker hagan lo que su guía promete cuando se
combinan entre sí. Hoy varios se anulan unos a otros con los valores de fábrica, y la
documentación describe una conducta que el código no tiene.

Se sabrá que está hecho cuando, con un test por cada uno: el lado que reduce inventario se
**acerque** de verdad en modo defensivo, la V2 no coloque dos órdenes al mismo precio, una orden
de salida no se cancele justo cuando el mercado viene a buscarla, y la vista previa de la V2
pinte el mismo precio que coloca el bot.

## Contexto

Los dos market makers vienen de tres specs seguidos: el
[029](../029-market-maker-contra-el-libro/spec.md) (no cotizaban contra el libro), el
[035](../035-el-precio-alcanza-la-cotizacion/spec.md) (no ejecutaban nunca) y el
[036](../036-lighter-stream-de-cuenta/spec.md) (Lighter entrega ya sus ejecuciones por su canal
de cuenta). Los tres arreglaban que el bot **no llegaba a operar**.

El propio 035 avisa de la consecuencia: *«con el arreglo, un bot que antes no ejecutaba empezará
a ejecutar; revisa tu Posición máxima y la acción al alcanzar el límite antes de ponerlo en real:
esa red nunca había hecho falta porque nunca había inventario que topar»*.

Pues bien: esa red no está donde la guía dice que está. Revisando las dos estrategias contra sus
propias guías aparecieron parámetros que se cancelan entre sí. El más caro es el primero, porque
ocurre **con los valores de fábrica** y desactiva justo el mecanismo que el 035 acaba de volver
necesario.

### Por qué `cambio` y no `revisión`

La escala de `specs/README.md` reserva **Crítica** para cinco efectos concretos (posición sin
stop, órdenes duplicadas por idempotencia rota, caída del worker, firma contra el host
equivocado, rechazo sistemático de toda orden). Ninguno de estos hallazgos encaja: son pérdida
acotada y probabilística, es decir **Altas**. En un spec de revisión, una Alta no se corrige
dentro: va a spec de seguimiento.

Como lo que se quiere es corregirlas, este es un spec de **cambio** con alcance cerrado y una
lista explícita de defectos. `findings.md` recoge las que **no** se tocan aquí y por qué.

## Alcance

- `packages/strategy-core/src/strategies/market-maker.ts` (V1)
- `packages/strategy-core/src/strategies/market-maker-v2.ts` (V2)
- `packages/strategy-core/src/strategies/mm-shared.ts` (la caducidad compartida)
- `apps/api/src/modules/advisor/build.ts`, por el radio de impacto de R-2
- Sus tests: `packages/strategy-core/src/strategies.spec.ts`,
  `apps/api/src/modules/advisor/advisor.spec.ts`,
  `packages/strategy-core/src/strategies/mm-ejecucion.spec.ts`
- Las guías que describen la conducta corregida: `docs/market-maker.md`,
  `docs/market-maker-v2.md`, `apps/app/src/app/core/content/market-maker*.guide.ts`

## Fuera de alcance

- **El modelo de coste de la V2** (`roundTripCost = fee × 2` sumado a **cada** lado, y el mismo
  factor dentro del suelo). Es un error de contabilidad real, pero **erra del lado seguro**:
  cotiza más ancho de lo necesario. Corregirlo **estrecha el diferencial de todos los bots V2 en
  marcha**, y el principio 6 exige decisión explícita del usuario. Ficha `F-01`.
- **Topes por lado (`maxLongPosition`/`maxShortPosition`) y `avisosDeTopeEnMoneda` en la V2**. No
  es un mando que se pelee con otro: es una funcionalidad que la V2 no tiene. Ficha `F-02`.
- **El rango de `feeEstimateBps` (0–100) que no admite el rebate de maker de Hyperliquid.** Es un
  cambio de rango de un parámetro de usuario más un signo nuevo en toda la fórmula. Ficha `F-03`.
- **La guarda de divergencia entre la fuente externa y el libro del venue**, que el spec 029 dejó
  explícitamente para su propio spec. Sigue donde estaba.
- **Cualquier mando nuevo.** Microprecio, sesgo de inventario en la V2, funding, markout y filtro
  de tendencia son el spec 039, y dependen del 038.
- `packages/db/prisma`, valores de fábrica que cambien la conducta de un bot en marcha, y el
  simulador.

## Requisitos

- **R-1 — El ensanchado por inventario deja de anular el modo defensivo (V1).**
  `spreadWiden = 1 + |ratio|` se aplica hoy a **los dos lados**, multiplicando al `regimeMul`,
  que sí es asimétrico. Con base 20 bps y fábrica, el lado que **reduce** cotiza a 20,4 bps al
  70 % de carga (modo defensivo, que promete 12) y a 19,0 bps al 90 % (alto riesgo, que promete
  10): la salida no se acerca **nunca**. El ensanchado pasa a aplicarse **solo al lado que
  añade**, que es donde el riesgo ha crecido.

- **R-2 — Ninguna de las dos coloca dos órdenes al mismo precio.** `layerDistanceMultiplier` nace
  en `1` en la V2, así que basta con subir `layers` para que todas las capas caigan al mismo
  precio; en la V1 el valor de fábrica es 1,5, pero su rango admite 1 y el defecto es idéntico.
  `validate()` lo rechaza en las dos, y `plan()` no emite un precio que ya haya colocado —lo que
  cubre además el caso que `validate()` no puede ver, el de dos capas vecinas que el tick del
  venue redondea al mismo sitio—.

  **Radio de impacto**: el asesor puede generar esa combinación. `defaultKnobs` no llega a la
  banda `MUY_BAJA` en `spread` (su mínimo es `BAJA` → 1,05), pero el asesor con modelo sí: el
  parseo acepta las cinco bandas y el valor entra tal cual en `buildConfig`, donde
  `1,4 × 0,55 = 0,77` se acotaba a 1. Así que el suelo del multiplicador sube a 1,05 cuando hay
  más de una capa. El test exhaustivo que ya existía no lo habría detectado: tolera los ERROR de
  `validate()` y sale antes, así que R-2 lleva test propio en el asesor.

- **R-3 — El TTL de salida respeta el lado al que el mercado se acerca.** `expiredQuotes` aplica
  `exitOrderTtlSeconds` sin mirar `alcanzando`, en las dos versiones. Es el mismo fallo que el
  035 corrigió para la deriva y la edad, y que quedó abierto por este camino: se le aplica la
  misma excepción asimétrica.

- **R-4 — La vista previa de la V2 no miente.** `preview()` pasa por `conTecho`, de modo que el
  precio de cada nivel coincide con el que `plan()` coloca sobre el mismo precio de referencia.

- **R-5 — Los descriptores de campo de la V2 dicen lo que el bot usa.** `buyDistanceBps`,
  `sellDistanceBps` y `orderMaxAgeSeconds` declaran en `meta.fields` un `default` distinto del de
  `defaults()` (40 vs 20, 40 vs 20, 120 vs 300). Se ponen al día con lo que el spec 035 decidió.

- **R-6 — La liquidación estimada de un market maker neutral deja de mezclar los dos lados.**
  `buildPreview` recibe `neutral: true` cuando la dirección es `NEUTRAL` —que es el valor de
  fábrica de las dos—, como ya hace `neutral-grid.ts`.

- **R-7 — La nota de la V2 cuenta las cotizaciones vivas, no las deseadas.** Hoy imprime
  `orders.length`. Es exactamente el defecto que el 029 corrigió en la V1 con `parseCoid` y que no
  se portó.

- **R-8 — El enfriamiento tras ejecución de la V2 se calcula como el de la V1.** V2 usa
  `quotedMid != null` donde V1 usa `lastFillAt > 0`: con un reloj sintético (backtest, dry-run) un
  bot que no ha ejecutado nada entra en enfriamiento permanente.

- **R-9 — El ancla manual deja de recalcular la distancia automática en cada tick (V1).** Con
  `referencePrice` puesto, `quotedMid` no se escribe nunca, así que `shouldRequote` es siempre
  cierto y `autoAdjustDistance` recalcula y reescribe `scratch` en cada tick. El 029 congeló esa
  distancia con el centro precisamente para no recotizar cada quince segundos; con ancla, la
  congelación no llega a ocurrir.

- **R-10 — Las guías dejan de describir la conducta antigua.** Las tablas de modos de riesgo de
  las dos guías de `docs/` y de la app describen hoy el acercamiento que R-1 hace real por
  primera vez; y los valores de fábrica de la V2 se ponen al día con R-5.

## Criterios de aceptación

- **CA-1** Con `dynamicSpread: true`, base 20 bps y ocupación del 70 %, el lado que reduce cotiza
  **más cerca** del centro que con inventario cero. Test en `strategies.spec.ts` que hoy falla.
- **CA-2** Con ocupación del 90 %, el lado que reduce cotiza a la mitad de la distancia base.
- **CA-3** El lado que **añade** conserva su ensanchado: a 70 % de carga sigue a `20 × 1,7 × 1,5`.
- **CA-4** `marketMakerV2.validate()` con `layers: 3` y `layerDistanceMultiplier: '1'` devuelve un
  issue; y `plan()` con esa configuración no emite dos órdenes al mismo precio.
- **CA-5** Un camino de precio en `mm-ejecucion.spec.ts` en el que el mercado se acerca a la orden
  de salida mientras vence su TTL: la orden **sobrevive** y acaba ejecutando.
- **CA-6** `preview()` y `plan()` de la V2 sobre el mismo `refPrice`, con
  `maxDynamicSpreadBps` por debajo del diferencial bruto, dan **el mismo precio** por nivel.
- **CA-7** Los tres `default` de `meta.fields` de la V2 coinciden con `defaults()`. Test genérico
  que lo comprueba para **todas** las estrategias, no solo para estas dos.
- **CA-8** El `estimatedLiquidationPrice` de un preview NEUTRAL no sale de una media ponderada que
  mezcla compras y ventas.
- **CA-9** La nota de la V2 con órdenes vivas en `openOrders` cuenta esas, no las deseadas.
- **CA-10** `plan()` de la V2 con `now` pequeño y `cycle.lastEntryAt` nulo **no** entra en
  enfriamiento.
- **CA-11** Con `referencePrice` y `autoAdjustDistance` puestos, dos ticks seguidos sin movimiento
  del libro devuelven los mismos precios y **no** reescriben `quotedAutoBps`.
- **CA-12** `pnpm test` en verde, `pnpm lint` limpio, y el typecheck de la app.
- **CA-13** *(manual, usuario)* Un MM V1 simulado con inventario por encima del umbral defensivo
  enseña en la pantalla del bot una distancia de salida menor que la de entrada.

## Riesgos

- **R-1 cambia la conducta de un bot en marcha.** Es el objeto del spec: hoy esa conducta es la
  que la guía promete y el código no cumple. El cambio **acerca la salida**, nunca aleja la
  entrada, así que no puede abrir más exposición de la que ya había. Aun así, no hay ningún market
  maker real en marcha (solo simulados), lo que quita casi todo el riesgo.
- **R-2 con `validate()` en ERROR** impide **guardar** una configuración que hoy se guarda. Un bot
  ya creado con ella sigue funcionando; lo que cambia es que al editarlo habrá que arreglarla.
  Es el mismo trato que ya recibe `minAllowedDistanceBps > buyDistanceBps` en la V1.
- **R-5 cambia lo que la app enseña como valor por defecto**, no lo que el bot usa: los bots ya
  creados conservan su configuración. El riesgo es el contrario al habitual — hoy la app miente.
- **R-3 y R-9 tocan caminos sin ningún test**. Cada uno lleva el suyo antes del arreglo.

## Referencias oficiales

Ninguna: todos los hallazgos son de conducta interna y se demuestran con tests, no con
documentación de venue. Las citas de la literatura que motivan el spec 039 no se apoyan aquí.
