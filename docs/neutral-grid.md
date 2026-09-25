# Rejilla neutral (Neutral Grid) — guía completa

> Estrategia `NEUTRAL_GRID` · riesgo **MEDIO**.
> Código: [`neutral-grid.ts`](../packages/strategy-core/src/strategies/neutral-grid.ts) · pesos en `geometricWeights()` de [`ladder.ts`](../packages/strategy-core/src/ladder.ts) · guía in-app en [`neutral-grid.guide.ts`](../apps/app/src/app/core/content/neutral-grid.guide.ts).
> Si no conoces la [rejilla clásica](./grid-classic.md), empieza por ella: esta es su versión a dos lados, y es la que más limitaciones abiertas tiene de las cinco.

---

## 1. Qué es esto, en cristiano

Eliges un **precio ancla** y un rango a su alrededor. El bot reparte las líneas por todo el rango y
**cuelga compras en las que quedan por debajo del precio y ventas en las que quedan por encima**, desde el
primer momento y sin esperar a tener inventario. Cada compra ejecutada te deja más largo; cada venta, más
corto. En el centro del rango la posición neta ronda cero: el ancla es **el precio en el que el bot
considera que tu posición debería ser cero**.

Los niveles no pesan todos igual: con el **multiplicador de tamaño** los más lejanos al ancla mueven más
dinero, para que las entradas fuertes ocurran en los extremos y la posición tienda a revertir a cero cerca
del centro.

### El riesgo, dicho claro

El precio **rompe en tendencia**. Al alejarse del ancla la posición neta crece en su contra —largo si cae,
corto si sube— y **no vuelve sola**. Sin **Exposición máxima** crece hasta agotar el margen; con ella, cada
lado se tiende solo hasta donde cabe y, alcanzado el tope, el bot deja vivas solo las órdenes que reducen
la posición y espera. A diferencia de la rejilla clásica, aquí también
puedes acabar **corto** sin haberlo decidido: las ventas de arriba abren cortos cuando el precio sube.

Y un segundo riesgo, menos evidente: la línea que el precio acaba de cruzar se queda **sin orden hasta que
el precio se aleja medio escalón** (es lo que evita recomprar encima de lo que acaba de ejecutarse). En un
lateral muy estrecho, pegado a una sola línea, la rejilla ejecuta poco.

### Vocabulario mínimo

| Palabra | Qué significa aquí |
|---|---|
| **Ancla** | El centro. Por debajo se compra, por encima se vende; el peso de cada línea crece con la distancia al ancla. |
| **Línea** | Cada precio del rango. Con 20 niveles hay 20 líneas repartidas a los dos lados. |
| **Banda muerta** | Medio paso local alrededor de una línea recién cruzada: la línea se queda **sin orden** hasta que el precio se aleja de ella esa distancia, y vuelve con el lado que toque. El paso local es la distancia a su vecina más próxima. Evita recomprar encima de lo que acaba de ejecutarse. |
| **Posición neta** | Compras menos ventas. Positiva = largo, negativa = corto. |
| **Exposición máxima** | Tope de la posición neta: acota lo que se tiende para aumentarla, y las órdenes que la reducen siguen siempre. **Es el freno de esta estrategia.** |
| **Multiplicador de tamaño** | Cuánto más pesa cada línea que la anterior según se aleja del ancla. Con 1, todas iguales. |
| **Ciclo** | Cada paso exacto de la posición por cero cierra un ciclo y abre otro. |

---

## 2. Cómo funciona por dentro, paso a paso

El motor revisa el bot **cada 15 segundos**; una ejecución dispara una revisión inmediata.

### Paso 1 — Construir la retícula

Precios como en la rejilla clásica (aritmético o geométrico; aquí **geométrico por defecto**). Pesos:

```
rango_i     = |i − índice de la primera línea ≥ ancla|          (distancia al ancla, en escalones)
peso_i      = multiplicador ^ rango_i
margen_i    = capital asignado × peso_i / Σ pesos                ← Σ margen_i = capital asignado
cantidad_i  = margen_i × apalancamiento / precio_i
```

Con multiplicador 1 todas las líneas mueven lo mismo (`capital × apalancamiento / niveles`). Con 1,5 y 12
niveles, la línea del ancla pesa 1 y los extremos `1,5⁵ ≈ 7,6` y `1,5⁶ ≈ 11,4`: más de la mitad del
capital (un 61 % en la Configuración C) vive en las cuatro líneas de los extremos.

### Paso 2 — Compras abajo, ventas arriba, y la línea cruzada espera

Con el precio de marca `m`, cada línea tiene un lado y lo conserva hasta que el precio la cruza:

```
primer plan del ciclo   línea < m → COMPRA post-only · línea > m → VENTA post-only · línea = m → sin orden
compra viva             sigue mientras línea < m; si el precio la cruza (o se ejecuta) → cruzada
venta viva              sigue mientras línea > m; si el precio la cruza (o se ejecuta) → cruzada
cruzada                 sin orden hasta que m se aleja medio paso local:
                        línea < m − medio paso → COMPRA · línea > m + medio paso → VENTA
medio paso local        la mitad de la distancia de esa línea a su vecina más próxima
```

La espera de la línea cruzada (la banda muerta) evita recomprar encima de lo que acaba de ejecutarse: sin
ella, la línea más cercana cambiaría de lado en cada revisión y el bot se pasaría el día cancelando y
recolocando la misma orden.

Ninguna orden es `reduceOnly`: en modo unidireccional cada línea solo mueve la posición neta, y marcarlas
reduce-only haría que el venue rechazara media retícula cada vez que la posición cruza el cero.

### Paso 3 — El tope de exposición

El tope acota lo que se **tiende**, y **cada lado con su presupuesto**: la posición abierta, medida al
precio de ahora, más las órdenes que la agrandarían, de la línea más cercana al precio hacia fuera; la
primera que no cabe corta ese lado ahí. Las que la **reducen** se dejan siempre: retirarlas dejaría la
posición sin contrapartida. Manda el menor de **Exposición máxima** y **Tope de exposición**.

Con la posición a cero, las compras y las ventas la agrandan todas, pero nunca a la vez —si el precio baja
se llenan las compras y las ventas de arriba no se tocan—, así que cada lado tiene su presupuesto: con 700
USDC y líneas de 66,5, al arrancar se tienden diez compras y diez ventas (Configuración A). Con
posición, solo cuenta el lado que la agranda, y parte de lo ya abierto. Si el tope deja fuera alguna línea,
la nota lo dice: `Retícula neutral: 20 órdenes activas; el tope de exposición deja fuera 4 líneas.`

La **Revisión aplica el mismo tope**: cada lado recorre sus líneas en el orden en que el precio las
tocaría yendo en contra, y una entra solo si la posición que deja, valorada a **su** precio, cabe en el
tope. En la primera que no, corta el lado y lo dice («El tope de exposición no deja tender …: con él, la
posición valorada a ese precio ya no cabe»), y lo que queda fuera no cuenta en los totales. El tope mide
lo que vale la posición, no lo que costó: el tamaño que enseña la Revisión, a precio de entrada, puede
pasar de él. Como la exposición se mide al
precio de cada momento, la Revisión puede contar alguna línea más o menos que las que se tienden al
arrancar: un largo vale menos según el precio baja, y un corto, más según sube.

### Paso 4 — Reconciliar

Como en todas: calcula lo que debería haber, compara con lo que hay, coloca lo que falta y cancela lo que
sobra. Las líneas reutilizan su identificador (`GRID_BUY#i`, `GRID_SELL#i`): una línea que se ejecuta
vuelve a desearse cuando el precio se aleja de ella medio paso local. Nota habitual: `Retícula neutral: 18
órdenes activas.`

### Paso 5 — Cruzar el cero

Cada vez que la posición pasa exactamente por cero se cierra un ciclo (`CYCLE_CLOSED`) y empieza otro:
cambian **todos** los identificadores y la retícula entera se cancela y recoloca (hasta 200 órdenes).

### Paso 6 — Guardas

Stop-loss inyectado por el motor a un % del margen desde la media (la dirección sale del **signo de la
posición real**, que aquí cambia), y las [guardas de riesgo](./riesgo-y-liquidacion.md#6-las-guardas-del-motor-revisión-a-revisión).
La estrategia valida: ancla dentro del rango, al menos 4 niveles, paso ≥ 2 ticks, y **avisa** si Dirección
no es Neutral. Como la rejilla puede acabar corta, la regla del 5 % y la del stop frente a la liquidación
se miden **siempre contra el corto**, el lado que antes se liquida, sea cual sea la Dirección. Y sobre el
tope:

- sin ninguno de los dos (ni Exposición máxima ni Tope de exposición), avisa de que la posición neta crece
  hasta agotar el margen;
- si es menor que lo que suman las líneas de un lado, avisa. En la Configuración A: `El tope de exposición
  (700.00) es menor que lo que suman las líneas de un lado (865.02): cada lado se tiende desde el ancla
  hasta donde quepa.`
- si no cabe ni la línea más cercana al ancla de ninguno de los dos lados, es un **error**. Con 60 en la
  Configuración A: `El tope de exposición (60.00) no deja tender ni la línea más cercana al ancla (66.56):
  el bot no pondría ninguna orden.`

---

## 3. Cómo configurarlo con poco riesgo

### Las cinco reglas de oro

1. **Exposición máxima, siempre.** Es el único freno propio. Un valor entre la mitad y el total del capital
   asignado: cada lado se tiende hasta donde cabe, y en una ruptura el bot no tiende nada que lleve la
   posición neta, medida al precio de cada momento, por encima de ahí (el valor de un corto sí sigue
   creciendo si el precio sube). La Revisión te enseña en qué línea se corta cada lado (§2, Paso 3).
2. **Pocos niveles y un rango razonable.** Cada línea tiene que superar el mínimo del par **también en el
   centro**, que es donde menos pesa con multiplicador > 1. La app rechaza el bot si alguna no cumple.
3. **Cuenta con la histéresis.** Una línea tendida sigue viva hasta que el precio la cruza; después queda
   sin orden hasta que el precio se aleja medio paso local (la mitad de la distancia a su vecina más
   próxima) y vuelve con el lado que toque. Pasos estrechos rearman antes la línea cruzada; pasos anchos
   tardan más en volver a cotizarla.
4. **1× o 2×, y sabe que viene en cruzado.** El valor de fábrica es margen **cruzado**: la liquidación queda
   más lejos pero una ruptura arrastra el saldo de los otros bots de la cuenta, y la Revisión solo puede
   darte una cota de la liquidación. Aislado si quieres compartimentar.
5. **Su backtest es orientativo.** El replay planifica una vez por vela: dentro de una vela cada línea solo
   puede cruzarse una vez, y el recorrido intra-vela es una hipótesis (apertura → extremos → cierre).

### Configuración A — «Neutral alrededor de un ancla clara en ETH»

Precios del 24-08-2026 (`venue-markets.ts`), Lighter, ETH a **2.503,35 USDC**.

| Campo | Valor | % del capital |
|---|---|---|
| Par | ETH/USDC (Lighter) | |
| Dirección | Neutral | |
| Modo de margen | Cruzado (fábrica) | |
| Apalancamiento | **2×** | |
| Capital asignado | **800 USDC** | 100 % |
| Precio ancla | **2.500** | |
| Precio inferior / superior | **2.200 / 2.800** | |
| Niveles | **24** | |
| Espaciado | Geométrico | |
| Multiplicador de tamaño | 1 | |
| Exposición máxima | **700 USDC** | 87,5 % |

**Qué hace esto.** Paso del **1,05 %** (26 USDC de media). Cada línea mueve **≈ 66,5 USDC** (0,0238-0,0303
ETH). Con ETH en 2.503,35 las líneas de abajo son **trece compras**, de 2.200 a 2.494,98, y las de arriba
**once ventas**, de 2.521,28 a 2.800. La posición arranca en cero, y el tope de **700 USDC** da a cada lado
su presupuesto: al arrancar tiende **diez compras** (de 2.270,30 a 2.494,98) y **diez ventas** (de 2.521,28
a 2.770,80), y la nota dice `Retícula neutral: 20 órdenes activas; el tope de exposición deja fuera 4
líneas.` Al crearlo, la app ya avisa de que el tope es menor que lo que suma un lado (865,02).

Cada vuelta del precio al ancla cierra ciclos por los dos lados. Una línea ejecutada se queda sin orden
hasta que el precio se aleja de ella medio paso local, unos **±13 USDC** (±0,52 %) junto al precio. Si ETH
se va a 2.200 el bot habrá acumulado un largo, pero el tope corta las compras antes de que ese lado llegue
a los 865 USDC que suman sus líneas: si cae poco a poco y sin rebotar, se queda en **once compras** (hasta
2.246,62), unos 695 USDC al precio de ese momento. La undécima no estaba tendida al arrancar: entra cuando
la caída le hace sitio, porque el largo vale menos según baja el precio. Si sube igual, el corto se queda en
las **diez ventas** (hasta 2.770,80). Con saltos bruscos las cuentas cambian, porque el tope mide la
posición al precio de cada revisión.

**Peor caso (la Revisión).** Un largo y un corto nunca conviven, así que la Revisión enseña cada lado por
separado, no los suma, y aplica el tope:

- **Largo**, once compras (hasta 2.246,62; la de 2.223,18 ya no cabe): 0,3093 ETH a una media de
  **2.366,27**, **731,89 USDC** de posición y 365,94 de margen. Liquidación en **1.213,48**, un 48,72 % por
  debajo de la media (un 51,53 % por debajo de 2.503,35), con −356,56 USDC, el 97,44 % del margen.
- **Corto**, diez ventas (hasta 2.770,80; la de 2.800 ya no cabe): 0,2518 ETH a una media de **2.641,91**,
  **665,23 USDC** y 332,62 de margen. Liquidación en **3.866,20**, un 46,34 % por encima de la media (un
  54,44 % por encima de 2.503,35), con −308,28 USDC, el 92,68 % del margen.

Las dos son una cota, porque el margen es cruzado: con el resto de la cuenta detrás, la real queda más
lejos. El mantenimiento es el 2,5 % de ETH en Lighter (máximo de 20×). Sin tope, cada lado llevaría todas
sus líneas: 865,02 USDC el largo y 731,87 el corto. Los 1.600 USDC que dan el capital por el apalancamiento
no son ninguna posición: serían las compras y las ventas sumadas.

### Configuración B — «BTC con el tope de exposición como freno principal»

| Campo | Valor | % del capital |
|---|---|---|
| Par | BTC/USDC (Lighter) · **78.910 USDC** | |
| Apalancamiento | **2×** | |
| Capital asignado | **1.000 USDC** | 100 % |
| Precio ancla | **79.000** | |
| Precio inferior / superior | **74.000 / 84.000** | |
| Niveles | **20** | |
| Espaciado | Geométrico (fábrica) | |
| Modo de margen | Cruzado (fábrica) | |
| Multiplicador de tamaño | 1 | |
| Exposición máxima | **500 USDC** | 50 % |

**Qué hace esto.** Paso del **0,67 %** (≈ 526 USDC de media). Cada línea mueve **≈ 99,5 USDC**
(0,00119-0,00135 BTC). Sin tope habría diez compras, de 74.000 a 78.579,0, y diez ventas, de 79.105,1 a
84.000. El tope de **500 USDC** es la mitad del capital, con su presupuesto por lado: al arrancar tiende
**cinco compras** (de 76.509,9 a 78.579,0) y **cinco ventas** (de 79.105,1 a 81.244,4), y la nota dice que
deja fuera 10 líneas. Con posición, las que la reducen siguen todas y el tope corta el otro lado: si BTC
cae poco a poco y sin rebotar, el largo se queda en cinco compras (hasta 76.509,9, unos 491 USDC); si sube
igual, el corto se queda en **cuatro** ventas (hasta 80.704,2). La quinta, tendida al arrancar, se retira
antes de que el precio llegue a ella: un corto vale más según sube el precio, y con cuatro vendidas ya no
cabe. Es la forma de tener una rejilla ancha sin que una ruptura la convierta en una posición direccional
grande. Una línea ejecutada vuelve a cotizar cuando el precio se aleja de ella medio paso local, entre ±261
y ±263 USDC (±0,33 %) junto al precio.

**Peor caso (la Revisión, con el tope).** Largo, cinco compras (hasta 76.509,9): 0,00642 BTC a
**77.535,4**, 497,78 USDC y 248,89 de margen; liquidación (cota) en **39.761,8**, un 48,72 % por debajo de
la media, con −242,51 USDC. Corto, cuatro ventas (hasta 80.704,2): 0,00498 BTC a **79.897,5**, 397,89 USDC
y 198,94 de margen; liquidación en **116.923,2**, un 46,34 % por encima, con −184,39 USDC. Sin tope, cada
lado llevaría sus diez líneas, unos 996 USDC.

### Configuración C — «SOL cargando los extremos»

| Campo | Valor | % del capital |
|---|---|---|
| Par | SOL/USDC (Lighter) · **138,42 USDC** | |
| Apalancamiento | **2×** | |
| Capital asignado | **600 USDC** | 100 % |
| Precio ancla | **138** | |
| Precio inferior / superior | **115 / 165** | |
| Niveles | **12** | |
| Espaciado | Geométrico | |
| Modo de margen | Cruzado (fábrica) | |
| Multiplicador de tamaño | **1,5** | |
| Exposición máxima | **600 USDC** | 100 % |

**Qué hace esto.** Con multiplicador 1,5 las líneas pegadas al ancla mueven poco y las de los extremos
mucho: **23 USDC** en 140,029 frente a **263 USDC** en 115 y **175** en 165. El bot apenas se mueve
mientras SOL ronde los 138. Útil cuando esperas ruido en el centro y quieres reservar la munición para los
extremos. A cambio, con doce niveles el paso medio es de 4,5 USDC, y una línea ejecutada tarda en volver:
queda sin orden hasta que el precio se aleja de ella medio paso local, entre ±2,19 y ±2,26 USDC (≈ ±1,6 %)
junto al precio.

| Línea | 115,000 | 118,836 | 122,801 | 126,898 | 131,132 | 135,507 | 140,029 | 144,701 | 149,529 | 154,518 | 159,673 | 165,001 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Lado | compra | compra | compra | compra | compra | compra | venta | venta | venta | venta | venta | venta |
| Notional (USDC) | 263 | 175 | 117 | 78 | 52 | 35 | 23 | 35 | 52 | 78 | 117 | 175 |
| Tendida al arrancar | no | sí | sí | sí | sí | sí | sí | sí | sí | sí | sí | sí |

**El tope pesa aquí más de lo que parece.** Cada lado tiene su presupuesto de 600 USDC, y el largo suma
719,59 (la app lo avisa al crearlo): al arrancar se tienden todas las líneas salvo **la de 115, la de 263
USDC** (`Retícula neutral: 11 órdenes activas; el tope de exposición deja fuera 1 línea.`). Si SOL cae
poco a poco, compra hasta 118,836 (unos
439 USDC al precio de ese momento) y la de 115 sigue sin caber. El corto suma 479,59 y cabe entero: si SOL
sube, vende hasta la línea de 165. Si quieres que la munición de abajo cuente, el tope tiene que cubrir el
lado largo: con 720 USDC la línea de 115 se tiende desde el arranque.

**Peor caso (la Revisión, con el tope).** Largo, cinco compras (hasta 118,836; la de 115 no cabe): 3,692
SOL a **123,669**, 456,59 USDC y 228,29 de margen; liquidación (cota) en **63,421**, un 48,72 % por debajo
de la media, con −222,44 USDC. Corto, las seis ventas: 3,049 SOL a **157,294**, 479,59 USDC y 239,79 de
margen; liquidación en **230,185**, un 46,34 % por encima, con −222,25 USDC.

> Con 20 niveles y multiplicador 1,8 el ejemplo **no sería válido**: las líneas centrales caen a 0,83
> USDC, por debajo del mínimo de 10 USDC y de la cantidad mínima de 0,1 SOL, y la app rechaza el bot. Con
> 12 niveles y 1,5 pasa (comprobado con `preview()`).

### Checklist antes de arrancar

- [ ] ¿**Exposición máxima** puesta? (entre la mitad y el total del capital)
- [ ] ¿La línea que menos pesa (la del ancla, con multiplicador > 1) supera los 20 USDC?
- [ ] ¿El ancla está cerca del precio de hoy o del precio al que el par suele volver? (dentro del rango, o la app lo rechaza)
- [ ] ¿Me vale que una línea recién ejecutada tarde medio paso local en volver a cotizar? (pegado a una sola línea, ejecuta poco)
- [ ] ¿El tope deja tender lo que quiero? (cada lado tiene su presupuesto: un lado que suma más que el tope no se tiende entero, y la Revisión dice en qué línea se corta)
- [ ] ¿Apalancamiento 1× o 2×? ¿Sé que viene en **cruzado**?
- [ ] ¿En Lighter, 30 líneas o menos?
- [ ] ¿**Dirección** en Neutral? (no cambia nada: ni la retícula ni la validación), ¿y sé que **Tope de exposición** es un segundo freno junto a Exposición máxima? (§4)
- [ ] ¿He mirado en la Revisión los dos lados, cada uno con su media, su margen, su stop y su liquidación?
- [ ] ¿He decidido cómo recentrar si hace falta? (editar el ancla, no el comando)

### Señales de alarma cuando ya está funcionando

| Lo que ves | Qué significa | Qué hacer |
|---|---|---|
| `Retícula neutral: N órdenes activas; el tope de exposición deja fuera M líneas.` | El tope no deja tender esas líneas: al arrancar, las de los extremos que no caben en el presupuesto de su lado; con posición, las del lado que la agrandaría. Si M crece en una ruptura, el freno ha actuado | Si sale al arrancar y querías la retícula entera, sube el tope. En una ruptura, decide: esperar el retorno, recentrar (editando el ancla), o cerrar |
| `CYCLE_CLOSED` frecuentes con recolocación de toda la retícula | La posición cruza el cero a menudo | Normal; en Lighter cuenta el cupo de peticiones |
| `ORDER_UNVIABLE` en las líneas del centro | Con multiplicador > 1 el centro pesa poco | Baja el multiplicador o sube capital |

---

## 4. Lo que este bot NO mira (importante)

| Campo | Realidad |
|---|---|
| **Dirección** (`direction`) | ⚠️ **No se lee.** Largo, corto o neutral, la retícula es la misma (compras bajo el ancla y ventas encima), la Revisión enseña siempre los dos lados y la validación mide siempre contra el corto. La app avisa si eliges Largo o Corto. |
| **Tope de exposición** (`maxNotionalCap`) | **Sí**, como segundo tope junto a **Exposición máxima**, con el mismo sentido: manda el menor de los dos, en el plan, en la Revisión y en la validación. |
| **Espera entre ciclos** (`cooldownMinutes`) | **Sí.** Al cruzar el cero se cierra el ciclo y, si hay espera, la retícula no vuelve a tenderse hasta que pase. |
| **Capital asignado** | ✅ Sí: se reparte entre todas las líneas, las de los dos lados. La Revisión enseña el margen de cada lado aparte, con el tope ya aplicado. |

Sí funcionan, aplicados por el motor: **Stop loss** (a un % del margen desde la media, con la dirección de
la posición real), **Pérdida diaria máxima** (sobre el capital), **Al acercarse la liquidación**, guardas
de la cuenta.

---

## 5. Limitaciones conocidas (hallazgos abiertos)

Confirmadas en `specs/001-revision-integral/findings.md`, abiertas a 2026-09-06.

> ⚠️ **Límite conocido (F-94, aceptado).** Al cruzar el cero se cierra el ciclo y la retícula entera se
> recoloca con ids nuevos (es el diseño: el ciclo de la neutral es una posición); con 200 niveles en un
> rango del 5 % el paso queda por debajo de una ida y vuelta maker+maker y la estrategia no avisa (la
> clásica sí). El funding del inventario no se muestra (riesgo §9).

---

## 6. Parámetros configurables, uno a uno

🔥 en caliente · 🌤️ en tibio (cancela y recoloca las órdenes; la posición sigue; pide confirmación) ·
❄️ en frío (hay que crear otro bot).

### 6.1 Configuración básica

#### Conexión de exchange · `exchangeAccountId` · ❄️ en frío

La cuenta con la que opera. **Consejo**: empieza en «Simulación», pero sabiendo que el simulador no
reproduce la banda muerta mejor que el venue: la rejilla neutral se ve igual de quieta en simulación.

#### Par · `symbol` · ❄️ en frío

Fija tick, paso de cantidad y mínimo. Con multiplicador > 1, la línea del ancla es la que más cerca queda
del mínimo.

#### Dirección · `direction` · ❄️ en frío · por defecto **Neutral**

Neutral / Largo / Corto. ⚠️ **No se lee**: la retícula es idéntica en los tres casos, la Revisión enseña
los dos lados, cada uno con su liquidación, y la validación mide la regla del 5 % y el stop siempre contra
el corto, sea cual sea el valor. Déjalo en Neutral; la app avisa si eliges otro.

#### Capital asignado · `totalInvestment` · 🌤️ en tibio · mínimo 10 · ⚠️ campo de riesgo

La suma de los márgenes de todas las líneas, repartida por pesos. Con multiplicador 1, cada línea recibe
`capital / niveles`.

#### Precio ancla · `anchorPrice` · 🌤️ en tibio · obligatorio

El centro de la retícula: el precio en el que el bot considera que tu posición debería ser cero. Todo se
mide contra él: por debajo compras, por encima ventas, y el peso de cada línea crece con su distancia.
Ponerlo lejos del precio actual hace que el bot arranque ya cargado hacia un lado.

**Consejo**: dentro del rango (la app lo exige), cerca del precio de hoy o del precio al que el par suele
volver. **Editarlo es la forma de recentrar**: el comando «Recentrar la retícula» no existe para esta
estrategia y el menú del bot no lo ofrece.

#### Precio inferior · `lowerPrice` · 🌤️ en tibio · ⚠️ campo de riesgo

Extremo inferior. La compra más lejana se coloca aquí; es donde acaba tu posición larga máxima si el
precio se desploma.

#### Precio superior · `upperPrice` · 🌤️ en tibio · ⚠️ campo de riesgo

Extremo superior. La venta más lejana se coloca aquí; es donde acaba tu **corto** máximo si el precio se
dispara.

#### Niveles · `gridLevels` · 🌤️ en tibio · 4–200 · por defecto **20**

Cuántas líneas se reparten por el rango completo, contando los dos lados. Más niveles: retícula más fina,
más ciclos y más pequeños, y **banda muerta más pequeña**. El mínimo son 4.

**Consejo**: que el capital repartido siga dejando la línea más ligera por encima de 20 USDC. En Lighter,
≤ 30.

#### Espaciado · `gridSpacing` · 🌤️ en tibio · por defecto **Geométrico**

Misma distancia en USDC (aritmético) o mismo porcentaje (geométrico). Aquí viene geométrico por defecto:
si el rango es amplio, el mismo salto en USDC rinde porcentajes muy distintos arriba y abajo del ancla.

#### Multiplicador de tamaño · `sizeMultiplier` · 🌤️ en tibio · 1–3 · por defecto **1**

Cuánto más dinero mueven los niveles lejanos al ancla frente a los cercanos. Subirlo vacía el centro y
carga los extremos. Bajarlo a 1 reparte el capital de forma pareja.

**Consejo**: entre 1 y 1,5 para empezar. Por encima de 2, casi todo el capital vive en las dos o tres
líneas de cada extremo y las del centro caen por debajo del mínimo del par.

### 6.2 Riesgo

#### Exposición máxima · `maxExposure` · 🔥 en caliente · opcional · ⚠️ campo de riesgo

Tope de la posición **neta** del bot, en USDC. **Es el freno propio de esta estrategia**: cada lado tiene
su presupuesto, y acota lo que se tiende para agrandar la posición —la posición al precio de ahora más
esas órdenes, de la línea más cercana al precio hacia fuera— y deja siempre vivas las que la reducen. La
Revisión lo aplica igual y corta cada lado en la primera línea que ya no cabe (§2, Paso 3).

**Consejo**: ponlo siempre. Sin él la app avisa por una razón concreta: en una ruptura la posición neta
crece hasta agotar el margen. Si es menor que lo que suman las líneas de un lado, la app avisa de que ese
lado no se tenderá entero; si no deja tender ni la línea más cercana al ancla, es un error. Y si quieres
que las líneas de un extremo lleguen a tenderse, que cubra lo que suma ese lado (en la Configuración C,
720 USDC para el largo).

#### Tope de exposición · `maxNotionalCap` · 🔥 en caliente · opcional

Segundo tope junto a **Exposición máxima**, con el mismo sentido: manda el menor de los dos, en el plan,
en la Revisión y en la validación. Con él solo, sin Exposición máxima, la app ya no avisa de que falta
tope. Déjalo vacío si el propio te basta.

#### Stop loss (sobre el margen) · `stopLossPct` · 🔥 en caliente · 0,1–90 × apalancamiento · ⚠️ campo de riesgo

Cuánto de tu **margen** puedes perder, medido desde la media de la posición, antes de que el motor la
cierre con una orden condicional nativa: a 2×, un 20 % del margen es un 10 % del precio. La dirección sale
del **signo de la posición real**, así que sirve igual si acabas largo o corto
([riesgo §7](./riesgo-y-liquidacion.md#7-el-stop-loss)). El campo enseña su equivalente en precio y,
debajo, dónde dispararía en cada lado con las líneas que el tope deja tender ya ejecutadas.

La validación lo mide siempre contra la liquidación del **corto**, la más cercana: a 2× en ETH de Lighter
(mantenimiento del 2,5 %), el más ancho sin aviso es un **61,7 %** del margen, y es lo que propone «Usar el
stop más ancho válido» cuando el tuyo lo pasa. En cruzado, un stop detrás de la liquidación es un aviso; en
aislado, un error.

#### Pérdida diaria máxima (sobre el capital) · `maxDailyLossPct` · 🔥 en caliente · 0,1–100

Pérdida realizada hoy por este bot, en % de su capital asignado, a partir de la cual se pausa.

#### Al acercarse la liquidación · `liquidationAction` · 🔥 en caliente · por defecto **Solo avisar** · ⚠️ campo de riesgo

Solo avisar / Pausar el bot / Cerrar todo. En cruzado la liquidación del venue depende de toda la cuenta, y
la Revisión solo puede darte una cota.

### 6.3 Tiempos

#### Espera entre ciclos (min) · `cooldownMinutes` · 🔥 en caliente · 0–10080 · por defecto **0**

Al cruzar el cero se cierra el ciclo y, si hay espera, la retícula no vuelve a tenderse hasta que pase.

### 6.4 Exchange

#### Apalancamiento · `leverage` · 🌤️ en tibio · 1–50 · por defecto **2** · ⚠️ campo de riesgo

Multiplica ganancia y pérdida y acerca la liquidación. A 2× en ETH de Lighter (mantenimiento del 2,5 %),
el largo se liquida con un 48,72 % en contra y el corto con un 46,34 %; a 1× el largo no se liquida, pero
el corto sí, con un 95,12 %. La regla del 5 % se mide contra el corto, porque la rejilla puede acabar corta:
con ese mantenimiento, el máximo es 13×. Con la posición abierta no se puede cambiar
(`LEVERAGE_WITH_POSITION`): el stop es un % del margen y se movería con él.

**Consejo**: 1× o 2×.

#### Modo de margen · `marginMode` · ❄️ en frío · por defecto **Cruzado**

⚠️ **Aquí el valor de fábrica es cruzado**: la liquidación queda más lejos, pero una posición perdedora
puede arrastrar el saldo del resto de bots de esa cuenta, y la Revisión rotula cada liquidación como cota.
Elige **Aislado** si quieres que el peor caso de esta rejilla no toque a los demás. No se puede cambiar
después.

---

## 7. Resumen de valores de fábrica

| Campo | Por defecto | ¿Lo cambio? |
|---|---|---|
| Dirección | Neutral | ✅ Déjalo (no se lee; la app avisa si lo cambias) |
| Modo de margen | **Cruzado** | 🟡 Aislado si compartes cuenta con otros bots |
| Apalancamiento | 2× | ✅ Déjalo, o 1× |
| Niveles | 20 | Según rango y capital; banda muerta = medio paso local |
| Espaciado | Geométrico | ✅ Déjalo |
| Multiplicador de tamaño | 1 | 🟡 1,2-1,5 si quieres cargar extremos; vigila el centro |
| Exposición máxima | vacío | 🔴 **Ponlo** |
| Al acercarse la liquidación | Solo avisar | 🟡 «Cerrar todo» a 2× o más |
| Espera entre ciclos | 0 | ✅ Déjalo, o unos minutos |

---

## 8. ¿Esta u otra?

| | **Rejilla neutral** | [Rejilla clásica](./grid-classic.md) | [Market Maker V1](./market-maker.md) |
|---|---|---|---|
| Lados | Dos desde el arranque | Uno (el de la entrada) | Dos, alrededor del precio |
| Precios | Fijos en líneas | Fijos en líneas | Siguen al precio (recotiza) |
| Puede acabar corto sin querer | **Sí** | No (en largo) | Sí, acotado por el tope |
| Freno | `maxExposure` | Rango + `stopOnRangeExit` | Modos defensivo/alto riesgo |
| Reacciona a movimientos lentos | Bien (la línea vive hasta que se cruza) | Bien | Bien (recotiza cada 30 s) |
| Hallazgos abiertos propios | `direction` no se lee (§4) | — | — (F-54 resuelto en el spec 036) |

**Elige la neutral si**: no quieres sesgo y el par da saltos claros alrededor de un precio reconocible.
**Elige la clásica si**: quieres acumular o es tu primer bot. **Elige un market maker si**: el par oscila
deprisa y prefieres que las órdenes sigan al precio.
