# Market Maker (V1) — guía completa

> Estrategia `MARKET_MAKER`.
> Código: [`market-maker.ts`](../packages/strategy-core/src/strategies/market-maker.ts) · piezas compartidas con la V2 en [`mm-shared.ts`](../packages/strategy-core/src/strategies/mm-shared.ts)

---

## 1. Qué es esto, en cristiano

Imagina una casa de cambio. Pone un cartel que dice:

> **Compro a 99 · Vendo a 101**

No le importa si la moneda va a subir o a bajar. Gana **el hueco entre esos dos números**. Si llega alguien con prisa por vender, le compra a 99. Si luego llega otro con prisa por comprar, le vende a 101. Se ha quedado 2 de beneficio y sigue con el mismo dinero que tenía.

Eso es un *market maker*: **pone precio a los dos lados a la vez y cobra la diferencia**.

El bot hace exactamente esto, automáticamente y sin parar:

1. Mira el precio medio del mercado.
2. Cuelga una **orden de compra un poco por debajo**.
3. Cuelga una **orden de venta un poco por encima**.
4. Si se ejecutan las dos, se queda la diferencia y vuelve a empezar.

**No apuesta a que el precio suba o baje.** Gana del ir y venir del precio.

### El riesgo, dicho claro

El problema aparece cuando el precio **no va y viene, sino que se va en línea recta**.

Si BTC cae sin parar, tu orden de compra se ejecuta… y la de venta no. El bot pone otra compra más abajo, y también se ejecuta. Y otra. Acabas **comprando toda la bajada**, con una posición larga en pérdidas y ninguna venta ejecutada.

A eso se le llama **quedarse con inventario del lado equivocado**, y es *el* riesgo de esta estrategia. Toda la parte de riesgo del bot (topes, modos defensivos, sesgo por inventario) existe para frenar exactamente eso.

### Vocabulario mínimo

| Palabra | Qué significa aquí |
|---|---|
| **bps** (punto básico) | Una centésima de porcentaje. **100 bps = 1 %**, **20 bps = 0,2 %**. Es la unidad de todo lo que sea "distancia al precio". |
| **Inventario** | La posición que el bot tiene abierta ahora mismo. Si ha comprado y aún no ha vendido, tiene inventario largo. |
| **Cotizar** | Colgar en el libro tu compra y tu venta. |
| **Recotizar** | Cancelar esas órdenes y volver a ponerlas a precios actualizados. |
| **Maker / Taker** | *Maker* es quien deja la orden colgada esperando (comisión barata). *Taker* es quien se lanza contra una orden que ya está puesta (comisión cara). Un market maker debe ser **siempre maker**. |
| **Capa** | Cada escalón de órdenes. Con 3 capas hay 3 compras a distancias crecientes y 3 ventas. |
| **Tope de posición** | El límite de exposición que le pones al bot. Es el freno principal. |

---

## 2. Cómo funciona por dentro, paso a paso

El motor revisa cada bot **cada 15 segundos**. Además, **una ejecución dispara una revisión inmediata**. En cada revisión, el bot hace esto:

### Paso 1 — ¿Cuál es el precio de referencia?

Toma el **punto medio del libro**: `(mejor compra + mejor venta) / 2`. Si el exchange no publica los dos lados, usa el *precio de marca*.

Si has rellenado **Precio de referencia**, usa ese número fijo en vez del mercado (ancla manual).

### Paso 2 — ¿Toca recotizar?

El bot **no** rehace sus órdenes en cada revisión: hacerlo perdería la prioridad en el libro y quemaría cuota de peticiones. Solo recotiza si:

- Ha pasado el **Intervalo de actualización de órdenes** (30 s por defecto), **o**
- El precio se ha alejado de donde cotizó más de la **Distancia mínima permitida**, **o**
- Alguna orden de salida ha caducado por su TTL.

> ⚠️ **Detalle poco obvio:** en la V1, `minAllowedDistanceBps` hace **dos trabajos a la vez**: es el suelo duro de la cotización *y* el umbral de deriva que dispara una recotización anticipada. Si lo pones muy bajo, el bot recotizará constantemente. (La V2 separa esos dos trabajos en dos campos distintos.)

Si acaba de haber una ejecución y tienes **Espera tras un fill** configurada, el bot **congela** su cotización durante esos segundos. Es para no perseguir al mercado que acaba de barrer su orden.

### Paso 3 — ¿Cuánto inventario llevo?

```
exposición = cantidad de la posición × precio       (con signo: + largo, − corto)
ratio      = exposición / Valor máximo de posición  (acotado entre −1 y +1)
ocupación  = |ratio| × 100                           (en %)
```

Con esa ocupación decide en qué **modo de riesgo** está:

| Modo | Cuándo | Lado que AÑADE posición | Lado que la REDUCE |
|---|---|---|---|
| **Normal** | Ocupación < umbral defensivo | distancia × 1 | distancia × 1 |
| **Defensivo** | Ocupación ≥ **70 %** (por defecto) | distancia **× 1,5** (se aleja) | distancia **× 0,6** (se acerca) |
| **Alto riesgo** | Ocupación ≥ **90 %** (por defecto) | **× 0 → desaparece del libro** | distancia × 0,5, y marcada `reduceOnly` |

Las dos mitades empujan a la vez hacia deshacer inventario, no solo una.

### Paso 4 — Desplazar el centro (sesgo por inventario)

Si **Ajuste de precio por inventario** está activado (lo está por defecto), el bot **no cotiza alrededor del precio medio, sino de un centro desplazado en contra de su inventario**:

```
centro = precio × (1 − sesgo × ratio × distancia_media / 10.000)
```

Con posición larga el centro **baja**: la venta queda más cerca (sale antes) y la compra más lejos (compra menos). Es lo que hace que el bot tienda solo a volver a posición cero.

### Paso 5 — Ensanchar el diferencial (spread dinámico)

Si **Diferencial dinámico** está activado (lo está por defecto):

```
ensanchamiento = 1 + |ratio|
```

Con la posición a la mitad del tope cotiza un 50 % más ancho; con el tope lleno, el doble. Cuanto más cargado está, más caro cobra por seguir cargándose.

### Paso 6 — Calcular cada capa y colocar

Para cada capa `l` (de 0 a `capas − 1`):

```
distancia_bps = MAX( distancia_mínima ,
                     base × mult_distancia^l × perfil × ensanchamiento × modo_riesgo )

precio_compra = centro × (1 − distancia_bps / 10.000)
precio_venta  = centro × (1 + distancia_bps / 10.000)

tamaño_capa   = Tamaño por compra/venta × perfil_tamaño × mult_tamaño^l
```

Los multiplicadores son **geométricos y sin normalizar**. Con `mult_distancia = 1,5` y base 20 bps, las capas van a **20, 30 y 45 bps**. Con `mult_tamaño = 1` todas las capas mueven el **mismo** dinero: 3 capas de 50 USDC son **150 USDC comprometidos por lado**.

El **perfil de riesgo** multiplica distancia y tamaño a la vez:

| Perfil | Distancia | Tamaño |
|---|---|---|
| Conservador | × 1,5 (más lejos) | × 0,7 (más pequeño) |
| Equilibrado | × 1 (tus números tal cual) | × 1 |
| Agresivo | × 0,7 (más cerca) | × 1,3 (más grande) |

Antes de colocar cada capa comprueba que **cabe** dentro del tope. En la V1 es **todo o nada**: si la capa no cabe entera, no se coloca. (La V2 sí puede recortarla.)

### Paso 7 — Guardas finales

- **Piso / techo de precio**: fuera de la banda el bot **solo bloquea el lado que abre posición**. El lado que reduce sigue vivo, para que nunca te quedes atrapado sin nadie que deshaga.
- **Tope alcanzado** → se ejecuta la **Acción al alcanzar el límite**: pausar entradas, cerrar todo a mercado, o cerrar y apagar.

---

## 3. Cómo configurarlo con poco riesgo

### Las cinco reglas de oro

1. **Empieza en Neutral.** Si eliges "Intención Long", el bot **solo pone compras y ninguna venta** (ver el aviso en 5.1). Eso ya no es hacer mercado: es acumular.
2. **Apalancamiento 1x o 2x.** Un market maker gana céntimos muchas veces. Multiplicar el riesgo por 10 para ganar los mismos céntimos no compensa.
3. **El freno de verdad es «Valor máximo de la posición».** Ponlo en un número que puedas perder entero sin que te cambie el día. Todo lo demás se calcula sobre él.
4. **Deja «Solo post-only» activado.** Si pagas comisión de taker, pagas justo lo que intentas cobrar.
5. **Que la suma de las capas quepa holgada en el tope.** Con 3 capas de 50 USDC tienes 150 comprometidos por lado; si el tope es 150, el bot vive permanentemente al límite. Regla práctica: **tope ≥ 3 × lo comprometido por lado**.

### Configuración A — "Prueba de agua" (riesgo mínimo)

Para entender qué hace el bot arriesgando lo mínimo: distancias amplias, poco dinero, frenos muy tempranos.

| Campo | Valor |
|---|---|
| Par | Uno muy líquido: BTC/USDC o ETH/USDC |
| Dirección | **Neutral** |
| Apalancamiento | **1x** |
| Modo de margen | Aislado |
| Tamaño por compra/venta | **25 USDC** |
| Valor máximo de la posición | **150 USDC** |
| Distancia de compra / venta | **30 bps / 30 bps** |
| Distancia mínima permitida | **15 bps** |
| Perfil de riesgo | **Conservador** |
| Capas | **2** · distancia 1,5 · tamaño 1 |
| Intervalo de actualización | 60 s |
| Espera tras un fill | 30 s |
| Modo defensivo a partir de | **50 %** |
| Modo de alto riesgo a partir de | **75 %** |
| Acción al alcanzar el límite | **Pausar entradas** |
| Solo post-only | **Sí** |
| Diferencial dinámico | Sí |
| Ajuste de precio por inventario | Sí |

**Qué hace esto con BTC a 100.000 USDC.** El perfil Conservador multiplica la distancia por 1,5 y el tamaño por 0,7:

- Capa 1: 30 × 1,5 = **45 bps** → compra en **99.550**, venta en **100.450**
- Capa 2: 30 × 1,5 × 1,5 = **67,5 bps** → compra en **99.325**, venta en **100.675**
- Cada capa mueve 25 × 0,7 = **17,5 USDC**. Total comprometido: **35 USDC por lado**.

Una vuelta completa en la capa 1 deja **90 bps brutos (0,9 %)** sobre 17,5 USDC ≈ **0,16 USDC**, menos comisiones. Es poco, y es intencionado: aquí el objetivo es ver el bot funcionar, no ganar.

Los frenos entran pronto: a **75 USDC** de exposición (50 % de 150) pasa a defensivo; a **112,5 USDC** deja de añadir del todo.

### Configuración B — "Equilibrada" (uso normal)

Cuando ya entiendes el comportamiento y quieres que el bot trabaje de verdad.

| Campo | Valor |
|---|---|
| Par | Líquido y con movimiento constante |
| Dirección | **Neutral** |
| Apalancamiento | **2x** |
| Tamaño por compra/venta | **50 USDC** |
| Valor máximo de la posición | **500 USDC** |
| Distancia de compra / venta | **20 bps / 20 bps** |
| Distancia mínima permitida | **10 bps** |
| Perfil de riesgo | **Equilibrado** |
| Capas | **3** · distancia 1,5 · tamaño 1 |
| Intervalo de actualización | 30 s |
| Espera tras un fill | 15 s |
| Modo defensivo / alto riesgo | 70 % / 90 % |
| Acción al alcanzar el límite | Pausar entradas |

**Con ETH a 3.000 USDC:**

- Capas a 20, 30 y 45 bps → compras en **2.994**, **2.991** y **2.986,50**; ventas en **3.006**, **3.009** y **3.013,50**.
- 3 × 50 = **150 USDC comprometidos por lado**, cómodos frente al tope de 500.
- Defensivo a partir de 350 USDC de exposición; deja de añadir a partir de 450.

### Configuración C — "Rango vigilado"

Igual que la B, más límites de precio para que el bot no acumule fuera de donde tu tesis tiene sentido:

| Campo añadido | Valor de ejemplo (ETH a 3.000) |
|---|---|
| No operar por debajo de | **2.600** |
| No operar por encima de | **3.400** |
| Stop loss (%) | **8 %** |

Por debajo de 2.600 el bot **deja de vender en corto** pero mantiene sus compras; por encima de 3.400 deja de comprar pero mantiene sus ventas. Nunca se corta el lado que te saca de la posición.

### Checklist antes de arrancar

- [ ] ¿Dirección en **Neutral**?
- [ ] ¿Apalancamiento en 1x o 2x?
- [ ] ¿El **Valor máximo de la posición** es dinero que puedo perder entero?
- [ ] ¿`capas × tamaño` es bastante menor que el tope? (tope ≥ 3 × lo comprometido por lado)
- [ ] ¿Cada capa supera el mínimo del par (~10 USDC)? Ojo con el perfil Conservador, que lo reduce al 70 %.
- [ ] ¿La distancia que cotizo cubre la comisión de ida y vuelta? *(Si no sabes calcularlo, usa la [V2](./market-maker-v2.md): lo calcula ella.)*
- [ ] ¿**Solo post-only** activado?
- [ ] ¿Umbral defensivo **menor** que el de alto riesgo?
- [ ] ¿He mirado la vista previa antes de crear el bot?

### Señales de alarma cuando ya está funcionando

El bot escribe una nota en cada revisión, del estilo:

> `Inventario 312.40 (62 % del tope), 6 cotizaciones.`

| Lo que ves | Qué significa | Qué hacer |
|---|---|---|
| La ocupación sube y **nunca baja** | El mercado está en tendencia y solo se ejecuta un lado | Baja el tope, ensancha distancias o párale |
| `Modo defensivo` / `Modo high_risk` constantemente | El tope es demasiado pequeño para el tamaño de tus capas | Sube el tope **o** baja el tamaño por orden |
| `Tope de posición alcanzado: entradas en pausa` | Llegaste al límite; el bot espera a que la posición baje | Decide tú: esperar, o cerrar a mano |
| `espera tras ejecución` permanente | La espera tras un fill es más larga que el ritmo de ejecuciones | Bájala |
| Casi ninguna ejecución | Cotizas demasiado lejos, o el par no tiene volumen | Acerca las distancias, o cambia de par |
| Muchísimas ejecuciones y aun así pierdes | El diferencial no cubre comisiones | Ensancha distancias, o pásate a la V2 |

---

## 4. Lo que este bot NO mira (importante)

Tres campos comunes que salen en el formulario y **no hacen lo que esperarías** en esta estrategia:

| Campo | Realidad |
|---|---|
| **Tope de exposición** (`maxNotionalCap`) | ⚠️ **Esta estrategia lo ignora.** Solo lo respetan Rejilla clásica, GridMart y Martingala. Aquí el tope real y único es **Valor máximo de la posición**. |
| **Capital asignado** (`totalInvestment`) | No dimensiona órdenes. Aquí el tamaño lo mandan **Tamaño por compra/venta** y **Capas**. Sí se usa como denominador de la **Pérdida diaria máxima**. |
| **Espera entre ciclos** (`cooldownMinutes`) | Pensado para estrategias con ciclos que abren y cierran. Un market maker cotiza de forma continua: usa **Espera tras un fill**. |

Sí funcionan con normalidad, aplicados por el motor: **Stop loss**, **Pérdida diaria máxima** y **Al acercarse la liquidación**. El stop loss se coloca como orden condicional **nativa en el exchange** (sigue vivo aunque la plataforma se caiga) y su dirección se calcula del **signo de la posición real**, no de la dirección declarada — que es lo correcto para un bot que cambia de lado solo.

---

## 5. Parámetros configurables, uno a uno

**Mutabilidad** = si puedes cambiar el campo con el bot en marcha:

- 🔥 **En caliente**: se aplica en la siguiente revisión, sin tocar órdenes ni posición.
- 🌤️ **En tibio**: cancela las órdenes y las vuelve a tender. La posición **no** se cierra.
- ❄️ **En frío**: **no se puede cambiar**. Hay que parar el bot y crear otro.

### 5.1 Configuración básica

#### Dirección · `direction` · ❄️ en frío · por defecto **Neutral**

Hacia qué lado se inclina la cotización. Aquí no describe una posición, sino una **intención**.

> ⚠️ **AVISO IMPORTANTE.** El comportamiento real del código es más tajante de lo que sugiere el nombre:
> - **Neutral** → coloca compras **y** ventas. Es el market maker de verdad.
> - **Intención Long** → coloca **solo compras**. **No pone ni una sola venta.** El bot acumula y no tiene salida propia: solo saldrías por stop loss, por la acción al alcanzar el límite o cerrando a mano.
> - **Intención Short** → coloca **solo ventas**, con el problema simétrico.
>
> Si lo que quieres es "hacer mercado pero inclinado a comprar", **no uses Intención Long**: deja **Neutral** y pon la **distancia de compra más corta que la de venta** (por ejemplo 15 / 35 bps). Así compras más fácil de lo que vendes, pero sigues teniendo salida.

#### Tamaño por compra/venta · `orderSizePerSide` · 🔥 en caliente · mínimo 1

Lo que se pone en **cada orden, en cada lado**. Con varias capas es el tamaño de la **primera**; las demás salen de multiplicarlo.

- Subirlo hace que cada ejecución mueva más posición y llegues antes al tope.
- **Consejo**: que supere el mínimo del par (~10 USDC). Cuidado con el perfil Conservador, que lo reduce al 70 %: 12 USDC se convierten en 8,4 y el exchange puede rechazar la orden.

#### Valor máximo de la posición · `maxBotPositionValue` · 🔥 en caliente · mínimo 1 · ⚠️ campo de riesgo

**El freno principal de esta estrategia.** Tope de exposición del bot en cualquier dirección, larga o corta.

- De él se calculan **en porcentaje** los umbrales defensivo y de alto riesgo.
- Al alcanzarlo entra en juego la **Acción al alcanzar el límite**.
- **Consejo**: aquí manda este campo, **no** el "Tope de exposición" genérico (que se ignora). Sin holgura frente a `capas × tamaño`, el bot vive permanentemente en modo defensivo.

#### Perfil de riesgo · `riskProfile` · 🔥 en caliente · por defecto **Equilibrado**

Atajo que ajusta distancia y tamaño a la vez, multiplicando lo que hayas escrito:

| | Distancia | Tamaño |
|---|---|---|
| Conservador | × 1,5 | × 0,7 |
| Equilibrado | × 1 | × 1 |
| Agresivo | × 0,7 | × 1,3 |

Equilibrado deja tus números tal cual. Los otros dos mueven el comportamiento entero sin que toques campo por campo.

#### Introducir tamaños en · `sizingMode` · 🌤️ en tibio · por defecto **Valor nocional**

- **Valor nocional**: escribes 50 USDC y el bot calcula la cantidad al precio de cada momento.
- **Cantidad de moneda**: escribes 0,001 BTC y el valor en USDC varía con el precio.

**Consejo**: valor nocional. Es directamente el dinero en juego y se compara sin cuentas contra el tope.

#### Acción al alcanzar el límite · `limitAction` · 🔥 en caliente · ⚠️ campo de riesgo

Qué hace el bot cuando la posición toca su tope:

| Opción | Qué hace |
|---|---|
| **Pausar entradas** (por defecto) | Deja de cotizar el lado que añade. Espera a que la posición baje. |
| **Cerrar todo** | Liquida la posición **a mercado**, una sola vez. |
| **Apagar** | La cierra a mercado y además detiene el bot. |

**Consejo**: **Pausar entradas**. El modo de alto riesgo ya ha estado empujando hacia la salida antes de llegar aquí; cerrar a mercado en el peor momento realiza la pérdida entera.

### 5.2 Cotización

#### Distancia de compra · `buyDistanceBps` · 🔥 en caliente · 1–1000 bps · por defecto **20**

A cuántos puntos básicos **por debajo** del centro se coloca la compra. 20 bps = 0,2 %.

- **Corta** → se ejecuta mucho, ganas poco por vuelta y acumulas inventario deprisa.
- **Larga** → se ejecuta poco, ganas más por vuelta.

#### Distancia de venta · `sellDistanceBps` · 🔥 en caliente · 1–1000 bps · por defecto **20**

El espejo, **por encima** del centro. Las dos juntas forman el diferencial que cobras por vuelta completa.

**Consejo**: simétricas si quieres neutralidad de verdad. Asimétricas inclinan el bot: 15 / 35 hace que compre más fácil de lo que vende.

#### Distancia mínima permitida · `minAllowedDistanceBps` · 🔥 en caliente · 1–500 bps · por defecto **8**

**Suelo duro**: el bot no cotiza nunca más cerca del precio que esto, pase lo que pase con el sesgo, el diferencial dinámico o el ajuste automático.

> Doble función en la V1: también es el umbral de deriva que dispara una recotización anticipada. Ponerlo muy bajo hace que el bot recotice sin parar.

Tiene que ser **menor o igual** que las distancias de compra y de venta, o la app rechaza la configuración.

#### Ajustar distancia automáticamente · `autoAdjustDistance` · 🔥 en caliente · por defecto **No**

Activado, la distancia base deja de ser fija y **sigue la anchura real del libro**: el bot cotiza al menos un **20 % más ancho** que el diferencial que ve en el mercado. Nunca cotiza más cerca de lo que le pediste — se queda con el mayor de los dos números.

**Útil en** pares cuyo libro se abre y se cierra mucho a lo largo del día.

#### Solo post-only · `postOnly` · 🔥 en caliente · por defecto **Sí**

Intenta colocar órdenes que **no tomen liquidez de inmediato**, para pagar siempre comisión de maker.

- **Activado**: si una orden fuese a ejecutarse al instante, el exchange la rechaza en vez de cruzarla, y el bot la recoloca.
- **Desactivado**: puedes acabar pagando comisión de taker, que es la que se come el diferencial.

**Consejo**: **déjalo activado**. El negocio de un market maker es cobrar el diferencial, no pagarlo.

#### Diferencial dinámico · `dynamicSpread` · 🔥 en caliente · por defecto **Sí**

Ensancha la cotización a medida que crece el inventario: `× (1 + ocupación)`. Con el tope al 50 %, cotiza un 50 % más ancho; con el tope lleno, el doble.

**Consejo**: **déjalo activado**. Es lo que evita que una tendencia te llene la posición siempre al mismo precio.

#### Ajuste de precio por inventario · `inventoryPriceAdjustment` · 🔥 en caliente · por defecto **Sí**

Desplaza el **centro** de la cotización en contra del inventario. Con posición larga baja el centro: la venta queda más cerca y la compra más lejos.

**Consejo**: activado. Es lo que hace que el bot tienda a volver solo a posición cero.

#### Sesgo por inventario · `inventorySkewFactor` · 🔥 en caliente · 0–3 · por defecto **1**

Cuánta fuerza tiene ese desplazamiento. Con 0 no hay; con 2, el doble.

Solo tiene efecto si el ajuste de precio por inventario está activado. Subirlo hace que el bot corra más por deshacer inventario, a costa de vender antes de tiempo en un movimiento a favor.

### 5.3 Tiempos

#### Intervalo de actualización de órdenes · `refreshSeconds` · 🔥 en caliente · 15–3600 s · por defecto **30**

Cada cuánto se rehace la cotización **aunque el precio no se haya movido**.

- El mínimo real son **15 segundos**: es el ritmo al que el motor revisa cada bot. Por debajo, el campo prometería un refresco que nadie ejecutaría.
- **Una ejecución rehace la cotización al instante**, sin esperar a esto. Este número es el techo de latencia cuando no pasa nada, no el tiempo de reacción.

#### Espera tras un fill · `fillCooldownSeconds` · 🔥 en caliente · 0–3600 s · por defecto **0**

Congela la cotización unos segundos después de una ejecución. Evita que el bot persiga al mercado que acaba de barrer su orden y se vuelva a poner justo delante del mismo movimiento.

Durante la espera **tampoco caduca** ninguna orden: congelar significa congelar.

**Consejo**: 15–30 s en mercados con movimiento. Con 0 no hay pausa.

#### Mantener órdenes de salida durante · `exitOrderTtlSeconds` · 🔥 en caliente · 0–86400 s · por defecto **0**

Cuánto vive una orden **de salida** antes de rehacerla al precio nuevo. Solo aplica al lado que **reduce** inventario.

- **0** = no caduca nunca: la salida espera a su precio indefinidamente.
- **Con valor** = el bot la retira y la vuelve a poner más cerca del mercado actual: cierra antes, a peor precio.

### 5.4 Niveles (capas)

#### Capas · `layers` · 🌤️ en tibio · 1–10 · por defecto **3**

Cuántas órdenes escalonadas por lado.

- Más capas cubren un tramo más ancho de precio, a costa de más dinero colgado.
- **Con una sola capa, el bot deja de cotizar ese lado en cuanto esa orden se ejecuta**, hasta la siguiente recotización.
- **Consejo**: 2 o 3 para empezar.

#### Multiplicador de distancia por capa · `layerDistanceMultiplier` · 🌤️ en tibio · 1–3 · por defecto **1,5**

Cuánto se aleja cada capa respecto de la anterior. Con 1,5 y base 20 bps: **20 → 30 → 45**.

Con **1**, todas las capas van a la misma distancia y se ejecutan prácticamente juntas.

#### Multiplicador de tamaño por capa · `layerSizeMultiplier` · 🌤️ en tibio · 0,1–3 · por defecto **1**

Cuánto crece cada capa respecto de la anterior.

- **> 1**: las capas lejanas mueven más dinero (compras más cuanto más cae el precio).
- **< 1**: al revés.
- **Consejo**: empieza en **1**. Subirlo mucho convierte al market maker en algo parecido a una martingala.

> La app avisa si `tamaño × (1 + m + m² + …)` supera el tope de posición: significaría que las capas más profundas nunca llegan a colocarse.

### 5.5 Riesgo

#### Modo defensivo a partir de · `defensiveThresholdPct` · 🔥 en caliente · 1–100 % · por defecto **70**

Qué porcentaje del tope activa el modo defensivo: el bot **aleja un 50 %** el lado que añade y **acerca un 40 %** el que reduce. Sigue cotizando a dos lados, pero empujando hacia la salida.

Tiene que ser **menor** que el umbral de alto riesgo, o nunca llega a activarse (la app lo rechaza).

#### Modo de alto riesgo a partir de · `highRiskThresholdPct` · 🔥 en caliente · 1–100 % · por defecto **90** · ⚠️ campo de riesgo

Qué porcentaje del tope hace que el bot **deje de añadir por completo**. Superado, el lado que añade desaparece del libro y solo queda el que reduce, colocado a la mitad de distancia y marcado `reduceOnly` para salir cuanto antes.

Es la última línea antes de que actúe la Acción al alcanzar el límite.

#### Límite de inventario largo / corto · `maxLongPosition` / `maxShortPosition` · 🔥 en caliente · opcionales

Topes **específicos** por lado, en USDC. Permiten ser asimétrico: dejar que el bot acumule más en un sentido que en el otro sin tocar el tope general.

Si los dejas vacíos, ambos lados usan el **Valor máximo de la posición**.

### 5.6 Precio

#### Precio de referencia · `referencePrice` · 🔥 en caliente · opcional

**Ancla manual.** Con esto puesto, el bot cotiza alrededor de **este precio** y no del mercado.

⚠️ Congela el centro donde tú digas. Si el mercado se aleja del ancla, el bot se queda cotizando al aire, sin órdenes cerca del precio real. La app avisa pero no lo impide: puede ser deliberado (esperar a que el precio vuelva).

**Consejo**: déjalo vacío salvo que sepas exactamente por qué lo quieres, y revísalo si el precio se mueve.

#### No operar por debajo de · `priceFloor` · 🔥 en caliente · opcional

Por debajo de este precio el bot **solo reduce, no abre**: desactiva el lado que abriría posición corta nueva.

#### No operar por encima de · `priceCeiling` · 🔥 en caliente · opcional

Por encima de este precio el bot **solo reduce, no abre**: desactiva el lado que abriría posición larga nueva.

> Las bandas cortan **solo el lado que abre**. El lado que te saca de la posición sigue siempre vivo — cortar los dos te dejaría atrapado con inventario y sin nadie que lo deshaga.

### 5.7 Exchange

#### Modo de posición · `positionMode` · ❄️ en frío · por defecto **Automático**

Cómo cuenta el exchange una venta cuando ya tienes un largo abierto.

- **Automático**: deja el modo que tenga la cuenta.
- **Unidireccional**: una venta **resta** del largo.
- **Cobertura**: una venta abre un corto **en paralelo** al largo, en vez de reducirlo.

⚠️ Importa más aquí que en ninguna otra estrategia: en cobertura, un market maker neutral acumula las dos patas a la vez y **paga margen por las dos**. **Deja Automático.**

#### Apalancamiento · `leverage` · 🌤️ en tibio · 1–50x · por defecto **2** · ⚠️ campo de riesgo

Multiplica por igual la ganancia y la pérdida, y acerca el precio de liquidación. A 2x necesitas un movimiento adverso cercano al 50 % para liquidarte; a 10x, cercano al 10 %.

Es **en tibio** y no en caliente porque el venue puede rechazar el cambio con posición abierta y, aunque lo acepte, mueve el precio de liquidación.

**Consejo**: **1x o 2x** en esta estrategia. Por encima de 10x la app te avisa.

#### Modo de margen · `marginMode` · ❄️ en frío

- **Aislado**: lo máximo que puedes perder en este bot es el margen que le asignaste; la liquidación llega antes.
- **Cruzado**: la liquidación está más lejos, pero una posición perdedora puede arrastrar el saldo del resto de bots de esa cuenta.

**Consejo**: **Aislado** si quieres que el peor caso de este bot no toque a los demás.

---

## 6. ¿V1 o V2?

| | **Market Maker (V1)** | **[Market Maker V2](./market-maker-v2.md)** |
|---|---|---|
| El diferencial que escribes | Es **el que se usa** (con ajustes por inventario) | Es un **punto de partida**; la fórmula suma encima |
| Se adapta a la volatilidad | ❌ No | ✅ Sí: la mide y ensancha |
| Garantiza cubrir comisiones | ❌ Lo calculas tú | ✅ Suelo automático: `comisión × 2 + margen mínimo` |
| Precio de referencia externo | ❌ Solo el libro local (o ancla manual fija) | ✅ Puede anclarse a Binance |
| Caducidad de órdenes por edad | ❌ Solo las de salida | ✅ Todas (`orderMaxAgeSeconds`) |
| Recorta la última capa al tope | ❌ Todo o nada | ✅ Configurable |
| Condición de activación | ❌ | ✅ Espera a que el precio cruce un disparador |
| Sesgo de precio por inventario | ✅ Sí (desplaza el centro) | ❌ No lo tiene |
| Nº de parámetros | Menos | Bastante más |
| Capas por defecto | 3 | 1 |
| Apalancamiento por defecto | 2x | 1x |

**Elige la V1 si**: quieres control directo y predecible del diferencial, y prefieres menos mandos.

**Elige la V2 si**: quieres que el bot se adapte solo al ritmo del mercado, y sobre todo si te importa **asegurar que cada vuelta completa deja beneficio limpio después de comisiones**.
