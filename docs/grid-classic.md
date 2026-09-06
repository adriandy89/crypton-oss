# Rejilla clásica (Grid Classic) — guía completa

> Estrategia `GRID_CLASSIC` · riesgo **BAJO** (el más bajo de las siete).
> Código: [`grid-classic.ts`](../packages/strategy-core/src/strategies/grid-classic.ts) · reparto de precios en [`ladder.ts`](../packages/strategy-core/src/ladder.ts) · guía in-app en [`grid-classic.guide.ts`](../apps/app/src/app/core/content/grid-classic.guide.ts).
> Antes de leer esto conviene tener claro lo de [riesgo y liquidación](./riesgo-y-liquidacion.md) y [buenas prácticas](./buenas-practicas.md).

---

## 1. Qué es esto, en cristiano

Eliges un precio inferior, uno superior y cuántas líneas quieres entre los dos. El bot **parte el rango en
esas líneas y cuelga una compra en cada una de las que quedan por debajo del precio**. Cuando el precio
baja y ejecuta una compra, el bot pone su venta **en la línea inmediatamente superior**. Cuando esa venta
se ejecuta, te has quedado la diferencia entre las dos líneas, el nivel queda libre y vuelve a poner su
compra. Y así indefinidamente mientras el precio siga dentro del rango.

No apuesta a que el precio suba. **Apuesta a que se mueva.** Cada vaivén entre dos líneas es un ciclo
cerrado: comprar abajo, vender arriba, repetir. Es la más fácil de entender de las siete.

### El riesgo, dicho claro

El precio **se va del rango por abajo y no vuelve**. Cada línea que atraviesa ejecuta su compra; ninguna
venta llega a tocarse. Al llegar al precio inferior tienes **todas las compras hechas** —el capital
entero, multiplicado por el apalancamiento— en una posición larga en pérdidas, esperando. La rejilla no
tiene un mecanismo propio para salir de ahí: solo el stop-loss que le pongas, o tu decisión.

Por arriba el riesgo es distinto: si el precio supera el precio superior, todas las ventas se han
ejecutado, el bot se queda en líquido y **deja de operar** hasta que el precio vuelva. No pierdes dinero;
dejas de ganarlo.

### Vocabulario mínimo

| Palabra | Qué significa aquí |
|---|---|
| **Línea** (nivel) | Cada uno de los precios en que se parte el rango. Con 20 niveles hay 20 líneas. |
| **Paso** (escalón) | La distancia entre dos líneas consecutivas. Es lo que ganas, bruto, en cada ciclo de una línea. |
| **Inventario** | Lo que has comprado y aún no has vendido. Cada línea con inventario tiene su venta esperando un escalón más arriba. |
| **Ciclo de línea** | Compra en la línea `i` + venta en la línea `i+1`. Al cerrarse, la línea `i` vuelve a ofrecer su compra. |
| **Post-only** | La orden se cuelga en el libro y solo se ejecuta si alguien viene a buscarla. Comisión de *maker*, la barata. Si fuese a cruzar el libro, el exchange la rechaza y el bot la recoloca. |
| **Reduce-only** | La venta solo puede reducir la posición: nunca abre un corto por error. |
| **Rango** | Del precio inferior al superior. Fuera de él el bot no coloca entradas nuevas. |

---

## 2. Cómo funciona por dentro, paso a paso

El motor revisa cada bot **cada 15 segundos**, y **una ejecución dispara una revisión inmediata**. En cada
revisión hace esto:

### Paso 1 — Construir la retícula

Los precios de las líneas salen del rango y del número de niveles:

```
ARITMÉTICO : línea_i = inferior + i × (superior − inferior) / (niveles − 1)      → misma distancia en USDC
GEOMÉTRICO : línea_i = inferior × (superior / inferior) ^ (i / (niveles − 1))   → mismo porcentaje
```

Y la cantidad de cada línea:

```
notional por línea = capital asignado × apalancamiento / niveles
cantidad (QUOTE)   = notional por línea / precio de la línea     ← por defecto: abajo se compran más monedas
cantidad (BASE)    = notional por línea / precio actual          ← las mismas monedas en todas las líneas
```

Con 600 USDC a 2× y 20 niveles, cada línea mueve **60 USDC**. Ese número tiene que quedar **holgado por
encima del mínimo del par** (10 USDC en Lighter y Hyperliquid, 5 en Aster): la app lo comprueba y no te
deja crear el bot si alguna línea no cumple.

### Paso 2 — Decidir qué línea es entrada y cuál salida

Con el precio de marca actual, toda línea **por debajo** es una línea de entrada (en un bot largo). Para
cada una **sin inventario** el bot desea una **compra post-only** justo en la línea. Para cada línea
**con inventario** desea una **venta reduce-only en la línea inmediatamente superior**; la última línea
del rango vende un escalón proyectado por encima del superior, para que lo comprado en el techo no se
quede sin contrapartida.

Las líneas por encima del precio y sin inventario **no tienen orden**: el bot no vende lo que no ha
comprado (ver `preloadInventory` en §4).

### Paso 3 — Reconciliar, no ejecutar pasos

El bot no «recuerda» qué órdenes puso: en cada revisión calcula la lista de órdenes que **debería** haber
y la compara con las que **hay** en el exchange. Coloca las que faltan y cancela las que sobran. Cada
orden lleva un identificador determinista (`GRID_BUY#i`, `GRID_SELL#i`), así que un worker reiniciado
reconoce sus órdenes y no duplica nada.

### Paso 4 — Una compra se ejecuta

La línea queda marcada como «con inventario», tu precio medio se recalcula, y en la siguiente revisión
aparece su venta un escalón arriba. Cuando esa venta se ejecuta, el nivel se **recicla**: vuelve a ofrecer
su compra. El PnL del ciclo es `cantidad × paso − comisiones`.

### Paso 5 — Fuera del rango

Si el precio sale del rango y **Parar al salir del rango** está activado (lo está por defecto), el bot
deja de tender entradas nuevas **pero mantiene vivas las ventas de lo que ya compró**: cancelarlas dejaría
la posición sin contrapartida, que es justo lo que arruina una rejilla. La nota del bot dice:

> `Precio fuera del rango: sin entradas nuevas, salidas activas.`

### Paso 6 — Tope de exposición

Si rellenaste **Tope de exposición**, el bot solo tiende las compras que caben en él: suma la posición
abierta y las compras vivas, de la línea más cercana al precio hacia fuera, y corta donde la siguiente ya
no cabe («Tope de notional: 3 de 10 entradas tendidas.»; con la posición por encima del tope, «Tope de
notional alcanzado: sin entradas nuevas.»).

### Paso 7 — Guardas

El motor añade el **stop-loss** como orden condicional nativa del exchange sobre el precio medio, si lo
configuraste, y evalúa las [guardas de riesgo](./riesgo-y-liquidacion.md#6-las-guardas-del-motor-revisión-a-revisión)
antes de planificar. Si una salta, el bot se pausa conservando el stop.

---

## 3. Cómo configurarlo con poco riesgo

### Las cinco reglas de oro

1. **El rango sale del gráfico, no del deseo.** Mira dónde ha rebotado el par las últimas semanas y deja
   el rango **algo más ancho** que eso. El precio inferior es el precio al que estarías cómodo teniendo
   el capital entero invertido.
2. **`capital × apalancamiento / niveles` ≥ 2 × mínimo del par.** Con 60 USDC por línea vas holgado; con
   12 estás al filo (una línea a 12 USDC puede caer a 9,90 al redondear la cantidad).
3. **1× o 2×.** Una rejilla gana el paso en cada ciclo, que es pequeño. Multiplicar la pérdida del peor
   caso por diez para ganar el mismo paso no compensa. A 1× no hay liquidación.
4. **El paso tiene que pagar las comisiones.** Un ciclo paga dos comisiones de maker (compra y venta). Con
   0,02 % por lado, el paso tiene que ser bastante mayor que 0,04 %: la app avisa por debajo de 0,05 %,
   pero **0,05 % es el mínimo aceptable, no un buen paso**. Pasos del 0,5 % al 1,5 % es lo habitual.
5. **Decide el peor caso antes de arrancar.** Es `capital × apalancamiento`, todas las líneas compradas.
   Si no lo aceptas, pon stop-loss por debajo del precio inferior, o baja el capital.

Y una sexta para Lighter: **no más de 30 líneas** (cuenta compras vivas + ventas vivas + stop). Lighter
limita a 30 las órdenes activas por mercado y la vista previa avisa si la rejilla tiende más.

### Configuración A — «Lateral amplio en BTC»

Para un mercado que lleva semanas entre dos precios claros. Precios del 24-08-2026 (`venue-markets.ts`), Lighter, BTC a **78.910 USDC**.

| Campo | Valor | % del capital |
|---|---|---|
| Par | BTC/USDC (Lighter) | |
| Dirección | Largo | |
| Modo de margen | Aislado | |
| Apalancamiento | **2×** | |
| Capital asignado | **600 USDC** | 100 % |
| Precio inferior / superior | **72.000 / 86.000** | |
| Niveles | **20** | |
| Espaciado | Aritmético | |
| Reparto del tamaño | Valor nocional | |
| Parar al salir del rango | Sí | |
| Stop loss | vacío (el peor caso está aceptado) | |

**Qué hace esto.** El paso es de **736,8 USDC** (un 0,93 % en 78.910; un 1,02 % en 72.000). Con BTC en
78.910 hay **diez compras vivas** por debajo (72.000, 72.737, …, 78.632) y diez líneas de venta por
encima esperando a tener inventario. Cada línea mueve **60 USDC** (≈ 0,00076-0,00083 BTC). Un ciclo
completo entre dos líneas deja `0,00083 × 736,8 ≈ 0,61 USDC` brutos en la línea más baja y ≈ 0,56 en la
más alta; menos dos comisiones de maker (≈ 0,024 USDC en Lighter): **≈ 0,55 USDC por vuelta**.

**Peor caso (vista previa, todas las líneas).** Basta con que BTC suba por encima de 86.000 y recorra el
rango entero hacia abajo para que las veinte líneas se compren: notional **1.191,72 USDC**, margen
**600,00**, precio medio **78.765,5**, liquidación estimada a 2× aislado **41.351,9** (−47,6 %).

Si BTC pierde los 72.000 te quedas con las veinte compras hechas: 1.200 USDC de posición larga y los 600
USDC de margen comprometidos, esperando a que vuelva.

### Configuración B — «Acumular SOL sin apalancamiento»

Cuando quieres acumular una moneda y cobrar el vaivén mientras tanto, sin liquidación posible.

| Campo | Valor | % del capital |
|---|---|---|
| Par | SOL/USDC (Lighter) · **138,42 USDC** | |
| Apalancamiento | **1×** | |
| Capital asignado | **500 USDC** | 100 % |
| Precio inferior / superior | **120 / 160** | |
| Niveles | **25** | |
| Espaciado | Aritmético | |
| Parar al salir del rango | **Sí** | |

**Qué hace esto.** Paso de **1,667 USDC** (1,2 % en 138; 1,39 % en 120; 1,04 % en 160). Doce compras
vivas entre 120 y 138,33. Cada línea mueve **20 USDC** (0,125-0,167 SOL: por encima del mínimo de 10 USDC
y de la cantidad mínima de 0,1 SOL). Un ciclo deja ≈ 0,25-0,28 USDC brutos.

**Peor caso (vista previa, todas las líneas).** **498,32 USDC** de notional y 500,00 de margen: SOL
comprado a una media de **138,96**. A 1× la liquidación estimada es 3,47 USDC: en la práctica, no existe.
El peor caso es quedarte con 500 USDC de SOL.

Son **25 líneas**: cabe en el límite de 30 órdenes de Lighter mientras no añadas stop y ventas a la vez
(las ventas solo existen para las líneas con inventario, así que en la práctica nunca hay 25 órdenes vivas).

### Configuración C — «Rejilla corta sobre un techo»

En corto todo se invierte: el bot **vende** en las líneas por encima del precio y **recompra un escalón
más abajo**. Gana mientras el par siga rebotando bajo un techo.

| Campo | Valor | % del capital |
|---|---|---|
| Par | ETH/USDC (Hyperliquid) · **2.503 USDC** | |
| Dirección | **Corto** | |
| Apalancamiento | **3×** | |
| Capital asignado | **400 USDC** | 100 % |
| Precio inferior / superior | **2.400 / 2.800** | |
| Niveles | **16** | |
| Stop loss | recomendable, por encima de 2.800 | |

**Qué hace esto.** Paso de **26,67 USDC** (1,07 %). Doce ventas vivas entre 2.506,7 y 2.800; cada línea
mueve **75 USDC** (≈ 0,03 ETH). Un ciclo deja ≈ 0,80 USDC brutos.

**Peor caso (vista previa, todas las líneas).** **1.197,99 USDC** de corto, 400,00 de margen, media
**2.594,2** y liquidación estimada **3.407,0** (**+36,1 %**). Si ETH rompe los 2.800, acumulas el corto
entero y a 3× el margen de maniobra hasta la liquidación es de poco más de un tercio del precio.

> En la bitácora de un bot **corto** las entradas aparecen como `GRID_BUY` (lado SELL) y las salidas
> como `GRID_SELL` (lado BUY): las etiquetas nombran el **papel** del nivel, no el lado de la orden.

### Checklist antes de arrancar

- [ ] ¿El rango es más ancho que el vaivén real de las últimas semanas?
- [ ] ¿`capital × apalancamiento / niveles` da al menos **20 USDC** por línea?
- [ ] ¿El paso cubre holgadamente dos comisiones? (≥ 0,3 % es cómodo; la app avisa por debajo de 0,05 %)
- [ ] ¿Apalancamiento 1× o 2×?
- [ ] ¿Acepto el **peor caso real** (todas las líneas = capital × apalancamiento), o he puesto stop-loss bajo el rango?
- [ ] ¿«Parar al salir del rango» activado?
- [ ] ¿En Lighter, 30 líneas o menos?
- [ ] ¿«Reparto del tamaño» decidido? (Valor nocional es lo habitual; Cantidad de moneda fija la cantidad
      con el precio del primer plan de cada ciclo)
- [ ] ¿He mirado el peor caso de la vista previa (todas las líneas compradas)?

### Señales de alarma cuando ya está funcionando

| Lo que ves | Qué significa | Qué hacer |
|---|---|---|
| `Precio fuera del rango: sin entradas nuevas, salidas activas.` y el precio por **debajo** | Tienes todas (o casi todas) las compras hechas | Decide: esperar el rebote (con stop), aportar margen si aislado, o cerrar |
| Lo mismo con el precio por **encima** | En líquido; no pierdes | Espera, o crea otra rejilla más arriba |
| `Tope de notional: N de M entradas tendidas` | El tope no deja tender la rejilla entera | Es el freno actuando; si no lo esperabas, sube el tope o baja el capital |
| Muchos `ORDER_UNVIABLE` | Líneas por debajo del mínimo del par al redondear | Menos niveles o más capital |
| `ORDER_REJECTED` «Post-only rechazada: cruzaría el libro» justo tras una ejecución | Normal: el precio sigue encima de la línea que acaba de ejecutarse | Nada; vuelve solo |
| Ciclos cerrados con PnL casi cero o negativo | El paso no paga las comisiones | Menos niveles o rango más ancho |

---

## 4. Lo que este bot NO mira (importante)

| Campo | Realidad |
|---|---|
| **Espera entre ciclos** (`cooldownMinutes`) | **Sí.** El ciclo se cierra al vender todo el inventario; durante la espera no se tienden compras nuevas y las ventas siguen. |
| **Precargar inventario** (`preloadInventory`) | ⚠️ **Muerto.** Solo produce un aviso en la revisión. El bot arranca siempre en líquido y solo vende lo que compró en alguna línea. |
| **Tope de exposición** (`maxNotionalCap`) | **Sí.** Acota lo que se tiende: posición abierta más compras vivas, de la línea más cercana al precio hacia fuera. |
| **Capital asignado** (`totalInvestment`) | **Sí** dimensiona: `capital × apalancamiento / niveles` es el tamaño de cada línea. |

Sí funcionan con normalidad, aplicados por el motor: **Stop loss** (orden condicional nativa sobre el
precio medio), **Pérdida diaria máxima**, **Al acercarse la liquidación** y las guardas de la cuenta.

---

## 5. Limitaciones conocidas (hallazgos abiertos)

Todo lo de esta sección está confirmado en `specs/001-revision-integral/findings.md` y abierto a
2026-09-06. Cuando un hallazgo se cierre, su bloque desaparece de aquí.

> ⚠️ **Limitación conocida (F-12, decide el usuario).** `preloadInventory` no hace nada (§4). El
> **funding** de mantener inventario en un perpetuo no se cuenta en ninguna pantalla (riesgo §9).

---

## 6. Parámetros configurables, uno a uno

**Mutabilidad** = si puedes cambiar el campo con el bot en marcha: 🔥 en caliente (siguiente revisión, sin
tocar órdenes ni posición) · 🌤️ en tibio (cancela y vuelve a tender las órdenes; la posición **no** se
cierra; la app pide confirmación) · ❄️ en frío (no se puede cambiar: hay que crear otro bot).

### 6.1 Configuración básica

#### Conexión de exchange · `exchangeAccountId` · ❄️ en frío

La cuenta con la que opera el bot: una de tus conexiones, con su red (real, pruebas o simulación) ya
decidida. Determina dónde se colocan las órdenes, qué saldo se usa y qué pares hay.

**Consejo**: si es tu primera rejilla, la cuenta «Simulación». Ver [simulación y backtest](./simulacion-y-backtest.md).

#### Par · `symbol` · ❄️ en frío

Fija el tick, el paso de cantidad, el mínimo de orden y el apalancamiento máximo. Un par barato con tick
grueso deja menos sitio para poner líneas juntas (ver [venues y mínimos](./venues-y-minimos.md)).

#### Dirección · `direction` · ❄️ en frío · por defecto **Largo**

En **largo** el bot compra en las líneas bajo el precio y vende un escalón arriba. En **corto** vende en
las líneas sobre el precio y recompra un escalón abajo; el peor caso se invierte (posición corta completa
si el precio rompe por arriba) y la liquidación queda por encima del precio medio.

#### Capital asignado · `totalInvestment` · 🌤️ en tibio · mínimo 10 · ⚠️ campo de riesgo

El margen que el bot puede usar. Se reparte **a partes iguales** entre las líneas:
`capital × apalancamiento / niveles` es el notional de cada una. Con apalancamiento, la posición que
llega a mover es el capital multiplicado por él.

- Subirlo con el bot en marcha recoloca todas las líneas con más tamaño (en tibio).
- **Consejo**: el mínimo es 10 USDC, pero el mínimo útil es mucho más alto: cada línea suelta tiene que
  superar el mínimo del par. Con 20 líneas y 2×, 600 USDC dan 60 por línea.

#### Precio inferior · `lowerPrice` · 🌤️ en tibio · ⚠️ campo de riesgo

La línea más baja. Por debajo ya no hay ninguna. **Marca tu peor caso**: si el precio lo pierde, todas las
compras están hechas y la posición entera está en pérdidas.

**Consejo**: míralo como el precio al que estarías cómodo con el capital entero invertido.

#### Precio superior · `upperPrice` · 🌤️ en tibio · ⚠️ campo de riesgo

La línea más alta. Si el precio la supera, todas las ventas se han ejecutado y el bot se queda en líquido
hasta que vuelva. No pierdes dinero: dejas de ganarlo.

**Consejo**: que quede por encima del techo que el par ha respetado últimamente, no justo encima del
precio de hoy.

#### Niveles · `gridLevels` · 🌤️ en tibio · 3–200 · por defecto **20**

En cuántas líneas se parte el rango. Más niveles: líneas más juntas, más operaciones y más pequeñas.
Menos niveles: líneas más separadas, menos operaciones, cada una con más beneficio. El capital se reparte
siempre a partes iguales, así que subir niveles reduce el tamaño de cada orden.

- La app rechaza el bot si el paso es menor que **2 ticks** del venue, y avisa si es menor que 0,05 %.
- **Consejo**: que `capital × apalancamiento / niveles` siga por encima de 20 USDC. En Lighter, 30 como
  máximo: la vista previa avisa si te pasas.

#### Espaciado · `gridSpacing` · 🌤️ en tibio · por defecto **Aritmético**

- **Aritmético**: la misma distancia en USDC entre todas las líneas. Un paso de 700 USDC es un 0,9 %
  arriba del rango y casi un 1 % abajo.
- **Geométrico**: el mismo porcentaje entre líneas: abajo quedan más juntas en dinero, arriba más
  separadas.

**Consejo**: aritmético se lee más fácil. Geométrico compensa en rangos muy amplios, donde el extremo
inferior y el superior se diferencian mucho.

#### Reparto del tamaño · `sizingMode` · 🌤️ en tibio · por defecto **Valor nocional**

- **Valor nocional**: todas las líneas mueven el mismo dinero; abajo compras más monedas que arriba y tu
  precio medio mejora solo.
- **Cantidad de moneda**: todas compran las mismas monedas; las de abajo comprometen menos dinero.

**Consejo**: **Valor nocional** es lo habitual. En «Cantidad de moneda» la cantidad por línea se fija con
el precio del primer plan de cada ciclo, así que el motor y la vista previa (que usa el precio de creación)
coinciden salvo por lo que el precio se haya movido hasta el arranque.

### 6.2 Comportamiento

#### Parar al salir del rango · `stopOnRangeExit` · 🔥 en caliente · por defecto **Sí**

Activado, fuera del rango el bot deja de colocar entradas nuevas pero **mantiene vivas las ventas** de lo
que ya compró: sigue pudiendo cerrar ciclos si el precio vuelve. Desactivado, sigue operando aunque el
precio esté fuera de la zona que decidiste.

**Consejo**: déjalo activado. Es lo que impide que la rejilla persiga al precio fuera de donde tu tesis
tenía sentido.

#### Precargar inventario · `preloadInventory` · ❄️ en frío · por defecto **No** · ⚠️ campo de riesgo

Pensado para comprar de golpe, al arrancar, el inventario necesario para poder vender también en las
líneas de arriba (como hacen los grids de los exchanges).

> ⚠️ **Hoy no cambia nada**: el motor no lo lee. Si lo activas, la app avisa en la revisión y el
> comportamiento es el mismo. Déjalo apagado.

### 6.3 Riesgo

#### Tope de exposición · `maxNotionalCap` · 🔥 en caliente · opcional

Tope del valor de la posición. Acota lo que se **tiende**: posición abierta más compras vivas, de la línea
más cercana al precio hacia fuera; la primera que no cabe corta la rejilla ahí, sin huecos.

**Consejo**: sin tope, el freno de una rejilla es `capital × apalancamiento`. Ponlo por debajo si quieres
que la rejilla nunca comprometa más de una cifra, aunque el precio la recorra entera.

#### Stop loss (%) · `stopLossPct` · 🔥 en caliente · 0,1–90 · ⚠️ campo de riesgo

Pérdida sobre el **precio medio** a la que el motor cierra la posición con una orden condicional nativa del
exchange (sobrevive a que la plataforma se caiga; ver [riesgo §7](./riesgo-y-liquidacion.md#7-el-stop-loss)).

**Consejo**: en una rejilla, por debajo del precio inferior: es la única salida ordenada si el precio se
va del rango y no vuelve. Vacío solo si aceptas el peor caso completo.

#### Pérdida diaria máxima (%) · `maxDailyLossPct` · 🔥 en caliente · 0,1–100

Pérdida realizada **hoy** por este bot, en % de su capital, a partir de la cual se pausa (sin cerrar la
posición). Es el freno para un día malo.

#### Al acercarse la liquidación · `liquidationAction` · 🔥 en caliente · por defecto **Solo avisar** · ⚠️ campo de riesgo

Qué hace el bot cuando la distancia a la liquidación baja del umbral de aviso (10 % por defecto): **Solo
avisar** manda el aviso y no toca nada; **Pausar el bot** pausa dejando la posición; **Cerrar todo** cierra
a mercado antes de que lo haga el exchange.

**Consejo**: a 1× no aplica. A 2× con el rango bien puesto, la liquidación queda lejos del precio
inferior; si prefieres que el bot actúe solo, «Cerrar todo» duele menos que una liquidación.

### 6.4 Tiempos

#### Espera entre ciclos (min) · `cooldownMinutes` · 🔥 en caliente · 0–10080 · por defecto **0**

El ciclo se cierra al vender todo el inventario. Durante la espera no se tienden compras nuevas; las ventas
del inventario que quede siguen vivas.

### 6.5 Exchange

#### Apalancamiento · `leverage` · 🌤️ en tibio · 1–50 · por defecto **2** · ⚠️ campo de riesgo

Multiplica por igual la ganancia y la pérdida, y acerca la liquidación (≈ 49,5 % a 2×, 32,8 % a 3×,
19,5 % a 5×). Es en tibio porque el venue puede rechazar el cambio con posición abierta y, aunque lo
acepte, mueve el precio de liquidación.

**Consejo**: **1× o 2×**. La API rechaza configuraciones cuya liquidación estimada quede a menos del 5 %.

#### Modo de margen · `marginMode` · ❄️ en frío · por defecto **Aislado**

**Aislado**: lo máximo que pierde este bot es su margen. **Cruzado**: la liquidación queda más lejos pero
una posición perdedora arrastra el saldo de los otros bots de la cuenta.

**Consejo**: **Aislado** para que el peor caso de esta rejilla no toque a los demás.

---

## 7. Resumen de valores de fábrica

| Campo | Por defecto | ¿Lo cambio? |
|---|---|---|
| Dirección | Largo | Según tu tesis |
| Modo de margen | Aislado | ✅ Déjalo |
| Apalancamiento | 2× | 🟡 1× si vas a acumular |
| Espaciado | Aritmético | ✅ Déjalo |
| Reparto del tamaño | Valor nocional | ✅ Déjalo |
| Niveles | 20 | Según capital y rango (≥ 20 USDC por línea; ≤ 30 en Lighter) |
| Precargar inventario | No | ✅ Déjalo (muerto) |
| Parar al salir del rango | Sí | ✅ Déjalo |
| Al acercarse la liquidación | Solo avisar | 🟡 «Cerrar todo» si operas a 2× o más |
| Espera entre ciclos | 0 | ✅ Déjalo (muerto) |

---

## 8. ¿Esta u otra?

| | **Rejilla clásica** | [Rejilla neutral](./neutral-grid.md) | [Market Maker V1](./market-maker.md) |
|---|---|---|---|
| Arranca | Comprando (o vendiendo, en corto) **solo un lado** | A **dos lados** desde el primer momento | A dos lados, alrededor del precio |
| Precios de las órdenes | Fijos, en líneas del rango | Fijos, en líneas del rango | Se mueven con el precio (recotiza) |
| Peor caso | `capital × apalancamiento` en una dirección | Lo mismo, en la dirección hacia la que rompa | `Valor máximo de la posición` |
| Freno propio | El rango y `stopOnRangeExit` | `maxExposure` | Modos defensivo y de alto riesgo |
| Cuándo | Lateral con sesgo (acumular) | Lateral sin sesgo | Volatilidad continua sin tendencia |

**Elige la rejilla clásica si**: quieres acumular una moneda cobrando el vaivén, o es tu primer bot.
**Elige la neutral si**: no quieres quedarte estructuralmente largo ni corto.
**Elige un market maker si**: el par oscila deprisa y prefieres que las órdenes sigan al precio en vez de
esperar en líneas fijas.
