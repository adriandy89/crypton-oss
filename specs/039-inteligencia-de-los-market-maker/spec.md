# 039 — Que el market maker mire algo más que el punto medio

Estado: `hecho` (falta CA-14, manual) · Tipo: `cambio` · Rama: `spec/039-inteligencia-de-los-market-maker`

## Objetivo

Que los dos market makers puedan usar lo que el spec 038 les puso delante —el tamaño del toque y
el funding— y lo que ya tenían y no miraban: sus propias ejecuciones y su propia serie de precios.

Todo **apagado de fábrica**. Un bot en marcha no cambia de conducta hasta que su dueño encienda un
interruptor, y hay un test que lo sostiene.

## Contexto

Los dos MM cotizan alrededor del **punto medio**, que ignora los tamaños del toque, el funding, la
dirección del mercado y su propio historial de ejecuciones. La literatura de market making lleva
décadas diciendo qué falta, y todo lo que dice cabe en cuatro ideas:

1. **El punto medio no es el precio justo.** Stoikov demostró que el *microprecio*
   `(ask·Q_bid + bid·Q_ask)/(Q_bid+Q_ask)` predice mejor el medio futuro que el propio medio, y es
   martingala por construcción —el medio ponderado ingenuo no lo es—. Cotizar al medio con el
   libro cargado de compradores es poner la venta justo donde el precio va a subir.
2. **El inventario debe mover el centro, no solo las distancias.** Es Avellaneda–Stoikov: el
   precio de reserva es el medio desplazado en contra del inventario. **La V1 lo tiene y la V2,
   «la lista», no**: su única reacción al inventario son los modos de riesgo, y de fábrica en
   90 %/100 %, que es casi «no reacciona». Su propia guía recomienda bajarlos a mano.
3. **En un perpetuo el inventario cobra o paga.** El funding dice qué lado está siendo pagado por
   mantener posición. Un market maker neutral puede inclinarse hacia ese lado sin apostar
   dirección.
4. **Hay que medir si te están eligiendo.** El *markout* —dónde está el medio N segundos después
   de cada ejecución— es la medida canónica de selección adversa y no necesita ni un dato externo:
   sale de los propios fills contra el propio mid.

Nada de esto entra por defecto. El 037 acaba de demostrar lo que cuesta un mando que hace algo
distinto de lo que su guía dice; aquí cada mando nuevo nace en cero y quien lo encienda sabrá
exactamente qué enciende.

## Alcance

- `packages/strategy-core/src/strategies/mm-shared.ts` — las funciones **puras** nuevas
- `market-maker.ts` y `market-maker-v2.ts` — los campos y el cableado
- Sus tests, `docs/market-maker*.md` y las dos guías de la app

## Fuera de alcance

- **`modifyOrder` en la reconciliación** (la mitad de peticiones por recotización, y lo que más
  alivia el cupo de Lighter). No es inteligencia, es caudal, y toca `execute()` del runner, que es
  la pieza más delicada del motor. **Spec 041.**
- **El filtro de tendencia en la V1.** La deriva sale del anillo `volSamples`, que **solo tiene la
  V2**. Dárselo a la V1 significa añadirle muestreo, que es un cambio de su escritura en `scratch`
  y merece decidirse aparte. Queda como hallazgo.
- **Cambiar cualquier valor de fábrica existente.** Ni los umbrales 90/100 de la V2, ni las
  distancias, ni nada. Lo que este spec hace es dar herramientas, no reconfigurar bots ajenos.
- **F-01, F-03 y F-05 del spec 037** (el doble cobro del coste, el rebate, la coherencia entre
  tiempos). Siguen en su cola.
- `packages/db/prisma`.

## Requisitos

Todos los campos nuevos son **HOT**, `advanced: true`, y van al grupo `intelligence`.

- **R-1 — El centro puede ser el microprecio.** `fairPriceMode` (`MID` | `MICRO`, fábrica
  **`MID`**). Con `MICRO` el centro sale de `(ask·Q_bid + bid·Q_ask)/(Q_bid+Q_ask)`. **Sin tamaños
  —Lighter, o un venue que deje de mandarlos— cae al punto medio**, y la nota lo dice: nunca se
  inventa un microprecio con datos que no están.

- **R-2 — El desequilibrio del toque puede sesgar el centro.** `obiSkewFactor` (0–2, fábrica
  **0**). Con `I = (Q_bid−Q_ask)/(Q_bid+Q_ask)`, el centro se desplaza
  `obiSkewFactor · I · distancia_base` bps: más compradores en el toque ⇒ centro arriba. Sin
  tamaños, `I` es `null` y el sesgo no se aplica.

- **R-3 — La V2 recupera el sesgo de inventario que le falta.** `inventoryPriceAdjustment` y
  `inventorySkewFactor`, con la **misma fórmula ya probada de la V1**, extraída a `mm-shared` como
  `centroSesgado()` para que las dos usen exactamente el mismo código. Fábrica **`false` / `0`**:
  la V1 conserva los suyos (`true` / `1`) y la V2 nace apagada, porque encenderla cambiaría la
  conducta de los bots V2 que ya existen.

- **R-4 — El inventario puede sesgar el TAMAÑO, no solo la distancia.** `sizeSkewFactor` (0–1,
  fábrica **0**): el lado que añade se achica `(1 − k·|ratio|)` y el que reduce se agranda
  `(1 + k·|ratio|)`. Es más suave que mover precios, porque no sacrifica probabilidad de ejecución
  justo en el lado que quieres ejecutar. Se aplica después del preset y **antes** del recorte al
  tope y del mínimo del par, que siguen mandando.

- **R-5 — El funding puede inclinar la cotización.** `fundingSkewFactor` (0–3, fábrica **0**). El
  centro se desplaza `−fundingSkewFactor · funding_bps` bps.

  **El signo sale del funding y no del inventario, y conviene entender por qué.** `f > 0` significa
  que los largos pagan y los cortos cobran. Bajar el centro acerca las ventas y aleja las compras,
  o sea inclina el libro del bot hacia estar corto — que es el lado al que el venue está pagando.
  Y funciona igual estando largo (te saca antes del lado que paga) que estando corto (te mantiene
  en el que cobra). No hace falta mirar `q`.

- **R-6 — Un funding extremo puede cortar el lado amontonado.** `maxAdverseFundingBps` (0–100,
  fábrica **0** = sin filtro). Por encima de ese |funding|, el lado que **añadiría** posición del
  lado que paga deja de cotizar, igual que hace hoy la banda de precio. El lado que reduce sigue
  vivo **siempre**: cortar los dos deja al usuario atrapado.

- **R-7 — El bot mide si le están eligiendo.** `markoutHorizonSeconds` (0 = apagado, si no 15–300;
  fábrica **0**) y `markoutSensitivity` (0–3, fábrica **0**).

  `onFill` anota `[ts, precio, lado]` en `cycle.scratch` —el hook está cableado y ya lo usan
  `gridmart` y `neutral-grid`, así que el mecanismo está probado—. En `plan()`, los fills cuyo
  horizonte ha vencido se resuelven contra el mid actual y alimentan una EWMA por lado:

  ```
  markout_bps(compra) = (mid − precio_fill) / precio_fill × 10.000
  markout_bps(venta)  = (precio_fill − mid) / precio_fill × 10.000
  penalización_bps    = max(0, −markout_lado) × markoutSensitivity
  ```

  La penalización se **suma a la distancia de ese lado**. Si al bot le están comprando barato, sus
  compras se alejan; sus ventas no se tocan. La nota imprime `markout −3,1/+0,8 bps`, que es un
  diagnóstico que hoy no existe en ninguna pantalla.

- **R-8 — La V2 puede dejar de cotizar contra la tendencia.** `trendGuardEfficiency` (0–1, fábrica
  **0** = apagado). Del anillo `volSamples`, que ya existe, salen la deriva y la **eficiencia de
  Kaufman** —`|recorrido neto| / suma de |movimientos|`, la misma fórmula que ya calcula el asesor
  en la API, extraída a `shared` para que no diverjan—. Por encima del umbral, el lado que pelea
  contra la deriva **deja de añadir**; el que reduce sigue vivo.

- **R-9 — La volatilidad de la V2 puede medirse sin sesgo de muestreo.** `volEstimator`
  (`RANGE` | `PARKINSON`, fábrica **`RANGE`**). El recorrido crece con el número de muestras, así
  que dos bots con la misma volatilidad real pero distinto ritmo de refresco miden cosas
  distintas; `PARKINSON` divide por `√(2·ln n)` y quita esa dependencia. No puede ser el valor de
  fábrica: cambiaría el diferencial de los bots V2 en marcha.

- **R-10 — Nada cambia de fábrica.** Un test recorre las dos estrategias con `defaults()` y
  comprueba que `plan()` devuelve **exactamente** las mismas órdenes que antes del spec.

## Criterios de aceptación

- **CA-1** `microprecio()` con `Q_bid = 3·Q_ask` queda por encima del punto medio; **sin tamaños
  devuelve el punto medio**, y la nota lo dice.
- **CA-2** `desequilibrio()` da `+1` con el ask vacío, `−1` con el bid vacío, `0` con tamaños
  iguales y `null` sin tamaños.
- **CA-3** Con `obiSkewFactor > 0` y `I > 0`, las dos cotizaciones suben; con `I = 0` no se mueven.
- **CA-4** La V2 con `inventoryPriceAdjustment` e inventario largo cotiza la venta más cerca —el
  mismo test que ya pasa la V1—.
- **CA-5** Con `sizeSkewFactor = 0,5` e inventario al 50 %, el lado que añade mueve un 25 % menos y
  el que reduce un 25 % más; y una capa recortada por debajo del mínimo del par **sigue sin
  colocarse**.
- **CA-6** Con `fundingSkewFactor > 0` y funding positivo, las dos cotizaciones bajan. Con funding
  negativo, suben. **Sin `fundingRate` no se mueve nada.**
- **CA-7** Con `maxAdverseFundingBps = 5` y funding de 10 bps, el bot deja de poner compras nuevas
  y **sigue poniendo ventas**; con la posición corta, la compra que reduce sigue viva.
- **CA-8** Markout: dos `plan()` separados por el horizonte, con el mid movido en contra de una
  compra ejecutada ⇒ la distancia de compra crece y la de venta no.
- **CA-9** Markout apagado (fábrica) ⇒ `onFill` no escribe nada en `scratch`.
- **CA-10** `trendGuardEfficiency`: con una rampa monótona en `volSamples`, el lado que pelea
  contra la deriva no coloca; con una onda, los dos colocan.
- **CA-11** `PARKINSON` sobre el mismo recorrido con 10 y con 100 muestras da valores **parecidos**;
  `RANGE` da valores muy distintos. Es la razón de existir del estimador.
- **CA-12** **R-10**: `plan()` con `defaults()` da las mismas órdenes que en `main`.
- **CA-13** `pnpm test` verde, `pnpm lint` limpio, `ng build` de la app sin errores.
- **CA-14** *(manual, usuario)* Dos MM V2 simulados sobre el mismo par, uno con `fairPriceMode:
  MICRO` y otro con `MID`: al cabo de unas horas, comparar inventario acumulado y markout.

## Riesgos

- **Once mandos nuevos en la estrategia que ya tenía más de la plataforma.** Se acotan: todos
  `advanced`, todos en un grupo propio, todos en cero, y la guía explica cuál tocar primero (el
  microprecio) y cuál el último (el funding, que hay que medir antes de confiar).
- **El markout escribe en `cycle.scratch` en cada ejecución.** Anillo con tope, como `volSamples`,
  y solo cuando está encendido. Apagado, `onFill` no toca nada.
- **La penalización por markout puede realimentarse**: alejarse reduce las ejecuciones, lo que deja
  de alimentar la medida. Por eso es una EWMA con suelo en cero —nunca acerca, solo aleja— y con
  `markoutSensitivity` acotado.
- **En Lighter no hay tamaños ni funding**, así que R-1, R-2, R-5 y R-6 no hacen nada allí. Es
  correcto y está declarado en `docs/venues-y-minimos.md` desde el spec 038, pero conviene que la
  guía lo repita donde el usuario elige el mando.

## Referencias oficiales

Ninguna de venue: todo es conducta interna. Las fuentes de los modelos van en la guía, no aquí.
