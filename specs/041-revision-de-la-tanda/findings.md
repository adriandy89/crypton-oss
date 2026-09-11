# 041 — Hallazgos de la revisión de los specs 037-040

Commit base: `21da121` · Fecha: 2026-09-11 · Hosts sondeados: ninguno.

## Resumen

| ID | Título | Área | Severidad | Estado |
|---|---|---|---|---|
| F-01 | `reusesOrderSlots` permite una segunda entrada a mercado | `trend-follow` | **Crítica** | **corregido en 041** |
| F-02 | El primer stop se ancla en la marca y no en la entrada | `trend-follow` | Alta | **corregido en 041** |
| F-03 | El tamaño no se acota por capital ni por margen | `trend-follow` | Alta | **corregido en 041** |
| F-04 | Un markout rancio entra en la media como si fuera reciente | `mm-shared` | Media | **corregido en 041** |
| F-05 | La vista previa dimensionaba sin el tope que aplica `plan()` | `trend-follow` | Baja | **corregido en 041** |
| F-06 | Un sesgo de tamaño alto podría dejar sin colocar la salida en la V1 | `market-maker` | Baja | descartado, ver ficha |

## Fichas

### F-01 — `reusesOrderSlots` permite una segunda entrada a mercado

- **Síntoma**: la estrategia de tendencia declaraba `reusesOrderSlots: true`, que autoriza al motor
  a **recolocar un `clientOrderId` que ya se ejecutó**
  (`bot-runner.ts:1036`: `if (!(allowRefill && already.status === 'FILLED')) return null;`).
- **Por qué es Crítica**: cumple la definición de `specs/README.md` al pie de la letra —«órdenes o
  exposición duplicadas»— y es alcanzable en operación normal. La señal de ruptura sale de la
  **vela cerrada**, así que sigue siendo cierta durante todo el intervalo, hasta cuatro horas.
  Mientras la posición no aparezca en `getPositions()`, cada tick de quince segundos vuelve a ver
  ruptura y posición cero, y vuelve a emitir `BASE#0`. La bandera quita justo el veto que impide
  que se coloque otra vez.
- **Por qué existía**: se copió de los market makers, donde es necesaria: allí «ejecutada»
  significa que el hueco de la cotización quedó libre.
- **Arreglo**: no declararla. Al cerrarse la posición se cierra el ciclo —`keepCycleOnFlat` no
  está declarado—, sube `cycleSeq` y los ids del ciclo siguiente son otros, así que no se pierde
  nada.
- **Test**: `NO reutiliza ids de orden, y eso es deliberado`, con el motivo escrito.

### F-02 — El primer stop se ancla en la marca y no en la entrada

- **Síntoma**: el stop inicial salía de `mark ∓ k·ATR`. Con entrada en 100, `k·ATR = 4,5` y el
  precio ya en 94 en el primer tick con posición, el stop salía en **89,5** en vez de en 95,5.
- **Impacto**: la operación arriesga más que el `riskPerTradePct` declarado, que es **la promesa
  que sostiene la estrategia entera**. Con un hueco del 10 % el riesgo real se dobla.
- **Arreglo**: el primer stop es `max(entrada − k·ATR, marca − k·ATR)` para un largo y el mínimo
  para un corto. Si el precio se fue a favor, el stop nace ya más arriba; si se fue en contra,
  nace donde tenía que nacer.
- **Efecto lateral esperado**: un test antiguo (`el stop de un corto esta POR ENCIMA`) codificaba
  la conducta defectuosa con un escenario imposible —corto entrado en 100 con el precio ya en
  120—. Se reescribió con un escenario coherente.

### F-03 — El tamaño no se acota por capital ni por margen

- **Síntoma**: `cantidad()` divide el riesgo entre la distancia al stop y devuelve el resultado.
  En un mercado muy tranquilo el ATR es minúsculo y esa división se dispara.
- **Evidencia**: con 30 velas planas y una ruptura de medio punto, el ATR sale ~0,055; con
  `k = 1` y capital 1.000 al 1 %, la cantidad es ~182 unidades, o sea **más de 18.000 de nocional
  sobre 1.000 de capital**.
- **Impacto**: el venue rechaza la orden por margen, o la acepta con un apalancamiento que el
  usuario no pidió.
- **Nota**: el spec 040 ya lo pedía en su R-3 («acotado por `maxNotionalCap` y por el margen
  disponible») y **no se implementó**. Es el tipo de requisito que ningún test genérico comprueba.
- **Arreglo**: `techoNocional()` = el menor de `maxNotionalCap`, `totalInvestment × apalancamiento`
  y `availableBalance × apalancamiento`. Recortar **baja** el riesgo por debajo del declarado, así
  que es seguro; y la nota lo dice, porque el usuario pidió arriesgar un 1 % y va a arriesgar
  menos.

### F-04 — Un markout rancio entra en la media como si fuera reciente

- **Síntoma**: `resolverMarkout` resolvía todo fill con `now − ts >= horizonte`, sin techo. Si el
  bot ha estado sin planificar —fuente externa caída, bot pausado, worker relevado—, un fill de
  hace diez minutos se resuelve contra el mid de ahora.
- **Evidencia**: el test sin el arreglo da **−1000 bps** (un −10 %) entrando en la EWMA como si
  fuera un markout de treinta segundos.
- **Impacto**: acotado, porque el markout nace apagado. Pero cuando se encienda, una medida falsa
  aleja la cotización sin motivo.
- **Arreglo**: se descarta lo que pase de **tres horizontes**. No es medible, y una medida falsa
  es peor que ninguna. El pendiente se limpia igual, para que no se quede dando vueltas.

### F-05 — La vista previa dimensionaba sin el tope

- **Síntoma**: `preview()` llamaba a `cantidad()` sin el techo que ahora aplica `plan()`, así que
  prometía un tamaño que el bot no iba a colocar. Es el mismo defecto que el 037 corrigió en la V2
  con el techo del diferencial.
- **Arreglo**: el mismo `techoNocional()`, con la parte que sale de la configuración —antes de
  crear el bot no hay `availableBalance` que mirar.

### F-06 — El sesgo de tamaño y el tope por lado en la V1 (descartado)

- **Síntoma posible**: con `sizeSkewFactor` alto, el lado que reduce crece hasta `× (1 + k·ratio)`,
  y la V1 es **todo o nada** al comprobar si cabe en el tope. Una orden de salida agrandada podría
  no caber y **no colocarse**, justo cuando más falta hace.
- **Por qué se descarta**: en la zona peligrosa —ocupación alta— el régimen es `HIGH_RISK`, que
  marca la salida como `reduceOnly` y entonces `fits` es cierto sin mirar el tope. Y en la zona
  intermedia haría falta que el tamaño por orden estuviera cerca del tope entero, que es lo que la
  guía ya desaconseja con la regla «tope ≥ 3 × lo comprometido por lado».
- **Decisión**: no se toca. Queda anotado para que no se vuelva a revisar.

## Verificado OK

Lo que se revisó en esta pasada y está bien:

- **El signo del sesgo por funding** (039). Comprobado caso a caso: con `f > 0` el centro baja, la
  venta se acerca y el bot tiende a quedarse corto, que es el lado que cobra. Y funciona igual
  estando largo que corto, que es lo que justifica no mirar `q`.
- **La dirección del filtro de tendencia** (039). Con deriva positiva se corta la venta nueva; con
  deriva negativa, la compra. Un test escrito al revés lo puso en duda y el código tenía razón.
- **`microprecio` y `desequilibrio` ante datos ausentes o a cero**: caen al punto medio y a `null`
  respectivamente, sin dividir por cero.
- **La migración de Prisma** (040): `ALTER TYPE ... ADD VALUE` dentro de transacción requiere
  PostgreSQL 12+, y el compose fija `postgres:18-alpine`. Aplicada y verificada en local.
- **El redondeo del stop**: `px(market, precio, 'SELL')` redondea hacia arriba, lo que acerca un
  stop de venta al mercado y hace que dispare **antes**. Dirección conservadora.
- **El dedup de capas del 037** no se traga una capa legítima: `colocados` solo se rellena dentro
  del guard, así que una capa que no cabe no bloquea a la siguiente.
- **El parche de markout no se pierde en ningún retorno temprano**: en la V1 `plan()` tiene un
  único `return`, y en la V2 el bloque va después de las salidas por ancla y por activación.
- **Los campos nuevos del 038 fluyen por el feed compartido**: `MarketDataService` pasa el objeto
  entero y lo cachea en Redis tal cual; `DryRunAdapter` lo arrastra de su fuente.

## Preguntas abiertas

Ninguna nueva. Sigue pendiente **F-01 del spec 037** (el coste de ida y vuelta que la V2 cobra dos
veces), que necesita decisión del usuario porque estrecha el diferencial de los bots en marcha.
