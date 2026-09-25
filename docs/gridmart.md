# GridMart — guía completa

> Estrategia `GRIDMART` · riesgo **ALTO**.
> Código: [`gridmart.ts`](../packages/strategy-core/src/strategies/gridmart.ts) · hereda la escalera de [`martingale.ts`](../packages/strategy-core/src/strategies/martingale.ts) y `scaledLadder()` de [`ladder.ts`](../packages/strategy-core/src/ladder.ts) · guía in-app en [`gridmart.guide.ts`](../apps/app/src/app/core/content/gridmart.guide.ts).
> **Empieza por la [guía de la martingala](./martingale.md)**: GridMart es la martingala más una capa encima, y hereda todos sus riesgos. Es la estrategia más compleja de todas; si es tu primer bot, no es este.

---

## 1. Qué es esto, en cristiano

El arranque es idéntico a la martingala: **entrada base y escalera de seguridades** por debajo, cada una
más lejos y más grande. La diferencia está en la salida. La posición se divide en dos partes:

- El **núcleo**: lo que compró la entrada base.
- El **satélite**: todo lo que añadieron las seguridades.

El **satélite** tiene su propia orden de cierre, a un objetivo **corto** sobre el punto de equilibrio, en
% de tu margen: es la parte que se deshace en el primer rebote. El **núcleo no se cierra de golpe**: sobre
él se tiende una **rejilla de ventas** escalonadas hacia arriba. Cada venta de la rejilla que se ejecuta
deja anotada una **recompra** por debajo, al precio de esa venta menos el descuento que fijes; cuando la
recompra entra, ese escalón vuelve a estar disponible para venderse otra vez. Vender arriba, recomprar
abajo, sobre el mismo núcleo, mientras el precio oscile.

Donde la martingala solo espera al objetivo final, GridMart **hace trabajar la posición** mientras espera.

### El riesgo, dicho claro

Heredas **el peor caso completo de la martingala**: si el par cae sin rebotar, la posición entera —capital
por apalancamiento, concentrado en los últimos escalones— queda abierta en pérdidas. Y añades complejidad:
conviven cuatro mecanismos a la vez (escalera, cierre del satélite, rejilla de ventas, recompras), y
cualquiera de ellos te sorprende si no lo has entendido antes de arrancar.

### Vocabulario mínimo

| Palabra | Qué significa aquí |
|---|---|
| **Núcleo** | La cantidad de la entrada base (o toda la posición, si es menor). Se deshace por la rejilla. |
| **Satélite** | Lo que añadieron las seguridades. Se cierra de golpe por su propio take profit, el **TP satélite**. |
| **Punto de equilibrio** (breakeven) | El precio medio real de la posición que reporta el exchange. Sobre él se calculan el TP satélite y los escalones de venta. |
| **Venta de rejilla** (`GRID_SELL#j`) | Cada escalón de venta sobre el núcleo, post-only, reduce-only. |
| **Recompra** (`GRID_BUY#j`) | La orden que se anota al ejecutarse la venta `j`, al precio de esa venta menos el descuento. |
| **Modo clásico** | Apaga rejilla y recompras: queda una martingala con una única salida al objetivo del satélite. |
| El resto (base, seguridad, cobertura, ancla, ciclo) | Igual que en la [martingala](./martingale.md#vocabulario-mínimo). |

---

## 2. Cómo funciona por dentro, paso a paso

El motor revisa el bot **cada 15 segundos**; una ejecución dispara una revisión inmediata.

### Paso 1 — Abrir ciclo y colgar la escalera

Idéntico a la martingala: sin posición (y fuera de la espera entre ciclos), entrada base a mercado (o
post-only si eliges «Límite»); con posición, seguridades post-only colgadas del **ancla** (el precio de la
base), recortadas por el **Tope de exposición** si lo hay. Fórmulas en la
[guía de la martingala, paso 2](./martingale.md#paso-2--la-escalera).

### Paso 2 — Dividir la posición

```
núcleo   = MIN( cantidad de la entrada base , posición actual )
satélite = posición actual − núcleo
```

Recién abierto el ciclo, todo es núcleo y el satélite es cero. Cada seguridad que entra es satélite.

### Paso 3 — El take profit del satélite

Si el satélite es mayor que cero, una orden **LIMIT reduce-only** por el satélite al
`equilibrio × (1 + TP satélite / (100 × apalancamiento))`: el TP satélite es un % de tu margen, así que a
2× un 1,6 % del margen es un 0,8 % del precio. Es la salida rápida: en el primer rebote suelta el
inventario de las seguridades y libera margen. Con la posición de nuevo reducida al núcleo, el satélite
vuelve a cero y la orden desaparece.

### Paso 4 — La rejilla de ventas sobre el núcleo

Con `k` ventas, separación inicial `s`, multiplicador de distancia `d`, porcentaje inicial `p` y
multiplicador de cantidad `q`:

```
precio_j   = equilibrio × (1 + (s + s·d + … + s·dʲ) / 100)        j = 0…k−1  (en corto, restando)
cantidad_0 = núcleo × p / 100        cantidad_j = cantidad_{j−1} × q
```

Las cantidades **se recortan para que la suma nunca supere el núcleo**, y la última venta se lleva lo que
quede: con `p = 25 %` y cuatro ventas de igual tamaño el núcleo se agota justo en la última; con `p = 20 %`
y cinco, igual. Cada escalón sale como orden **post-only reduce-only**. La separación y su multiplicador son
distancias en % del **precio**, no del margen.

Un escalón **con recompra pendiente no se cotiza**: su inventario ya se vendió y hasta que la recompra
entre no hay nada que vender en él.

### Paso 5 — Una venta se ejecuta: anotar la recompra

Al ejecutarse `GRID_SELL#j`, el bot anota una recompra `GRID_BUY#j` a `precio de la venta × (1 −
descuento / 100)`, con **la cantidad de esa ejecución**, y la desea en la siguiente revisión como
post-only. Cuando la recompra entra, se borra de la lista y el escalón `j` vuelve a ofrecer su venta.
Cada vuelta completa (vender en `j`, recomprar abajo) deja el descuento como beneficio y conserva el
núcleo… siempre que el descuento sea **menor** que la separación (la app avisa si no).

### Paso 6 — Cierre y espera

El ciclo se cierra cuando la posición vuelve a cero (satélite vendido y núcleo deshecho por la rejilla, o
cierre manual). `Espera entre ciclos` y vuelta a la entrada base. La nota del bot mientras dura el ciclo,
en la configuración A tras la primera seguridad: `Núcleo 0.0501, satélite 0.0671.`

### Modo clásico

Con **Modo clásico** activado desaparecen rejilla y recompras: queda **una única salida** sobre toda la
posición al objetivo del **TP satélite**, exactamente como una martingala (nota, en la configuración B recién
entrada la base: `GridMart Classic: TP satélite en 79856.9.`). Es la forma de usar GridMart cuando quieres
el comportamiento simple.

### Paso 7 — Guardas

Stop-loss inyectado por el motor sobre la media, en % del margen como en la martingala, y las
[guardas de riesgo](./riesgo-y-liquidacion.md#6-las-guardas-del-motor-revisión-a-revisión). La validación
de la escalera es la de la martingala ([paso 5](./martingale.md#paso-5--guardas)): nivel a nivel, con la
media de lo ya comprado y la liquidación exacta de esa media; error en aislado si la liquidación llega antes
que una seguridad, aviso si el que llega antes es el stop o si la escalera cubre menos de la mitad de la
distancia a la liquidación. Más: TP satélite > 0 (y aviso si en precio no llega al 0,3 %), al menos una
venta, porcentaje del núcleo en (0, 100], descuento > 0, separación > 0, y aviso si el descuento supera la
separación del primer escalón. En modo clásico, un aviso de que los cinco parámetros de la rejilla no se
usan.

---

## 3. Cómo configurarlo con poco riesgo

### Las cinco reglas de oro

1. **Todas las de la martingala** que tocan a la escalera y al stop (último escalón, 1-2×, escalera que
   cabe entera y con holgura, stop más allá del último escalón), y la de las comisiones aplicada al **TP
   satélite**: por debajo del 0,3 % del precio (a 2×, un 0,6 % del margen) la app avisa.
2. **Descuento de recompra < separación inicial de venta.** Si no, cada vuelta pierde núcleo en vez de
   ganarlo. La app avisa.
3. **`% del núcleo × ventas = 100` si quieres ventas iguales.** Si no llega, la última venta se lleva todo
   lo que quede (con un 10 % y cuatro ventas, la última vende el 70 %); si pasa, el núcleo se acaba antes y
   las últimas ventas se recortan o no se tienden (con un 40 % y cuatro, quedan tres: 40, 40 y 20 %).
4. **Cada venta de la rejilla ≥ 20 USDC.** El núcleo dividido entre las ventas tiene que dar órdenes por
   encima del mínimo del par; si no, `ORDER_UNVIABLE` en cada revisión.
5. **Cantidades por encima del paso.** El último escalón de la rejilla se lleva lo que quede del núcleo,
   así que los porcentajes no tienen que sumar 100; lo que hace falta es que cada venta redondee a una
   cantidad válida del venue y por encima de su mínimo.

Las cifras de los ejemplos salen de `preview()` y `plan()` sobre las fichas de mercado de
[`venue-markets.ts`](../packages/strategy-core/src/venue-markets.ts). La liquidación es la exacta de una
posición aislada con el mantenimiento del 2,5 % que dan las fichas de Lighter (admiten 20×); con el bot en
marcha manda la que devuelve el exchange. Los resultados en USDC son sin comisiones, como en la Revisión.

### Configuración A — «GridMart completo sobre ETH»

Precios del 24-08-2026 (`venue-markets.ts`), Lighter, ETH a **2.503,35 USDC**.

| Campo | Valor | % del capital |
|---|---|---|
| Par | ETH/USDC (Lighter) | |
| Apalancamiento | **2×** | |
| Capital asignado | **800 USDC** | 100 % |
| Órdenes de seguridad · separación · dist. · vol. | **5 · 3 % · 1,3 · 1,3** | |
| Take profit satélite | **1,6 % del margen** (0,8 % del precio) | |
| Ventas de rejilla | **4** | |
| Separación inicial de venta | **1 %** | |
| Multiplicador de distancia de venta | **1,2** | |
| % del núcleo vendido en el nivel 1 | **25 %** | |
| Multiplicador de cantidad de venta | 1 | |
| Descuento de recompra | **0,5 %** | |
| Tipo de orden base | A mercado | |

**Qué hace esto.** La entrada base compra **0,0501 ETH** (125,4 USDC): ese es el núcleo. Sobre él se
tienden cuatro ventas en **2.528,39 · 2.558,43 · 2.594,48 · 2.637,73** (1 %, 2,2 %, 3,64 % y 5,37 % sobre
el equilibrio), de un 25 % del núcleo cada una: 0,0125 ETH ≈ **31,6-33,0 USDC** por orden. Si ETH sube a
2.530 se ejecuta la primera venta y queda anotada una recompra en **2.515,74** (−0,5 %); cuando el precio
vuelve, recompra y el escalón vuelve a estar disponible: 0,0125 × 12,65 ≈ 0,16 USDC por vuelta, menos
comisiones.

Por debajo esperan las seguridades en **2.428,24 · 2.330,61 · 2.203,69 · 2.038,70 · 1.824,20** (cobertura
del **27,1 %**), con tamaños 162,9 · 211,9 · 275,5 · 358,2 · 465,5 USDC. Si entra la primera, el
equilibrio baja a 2.460,35, el satélite pasa a ser 0,067 ETH y aparece su TP en **2.480,04**: el 1,6 % del
margen, un 0,8 % del precio sobre el nuevo equilibrio. Las ventas de la rejilla bajan con él (la primera, a
2.484,96).

**Peor caso (vista previa).** Notional **1.599,40 USDC**, margen **799,70**, media **2.093,46**. El
objetivo que enseña la Revisión es el del satélite: **2.110,21** (+0,80 % de precio) sobre 0,7139 ETH —todo
menos el núcleo—, +11,96 USDC, un +1,60 % de su margen. La liquidación exacta queda en **1.073,57**
(−48,72 % desde la media, −57,11 % desde el precio de hoy), muy por debajo del último escalón. La vista
previa pinta además la rejilla de ventas **sobre el equilibrio del peor caso** y dimensionada sobre el
**núcleo**, como hará el bot: 2.114,40 · 2.139,52 · 2.169,66 · 2.205,84, de 0,0125 ETH cada una. Es por
dónde saldría el núcleo si la escalera se llenara entera, no donde están las ventas hoy.

### Configuración B — «Modo clásico: martingala pura, sin rejilla»

| Campo | Valor | % del capital |
|---|---|---|
| Par | BTC/USDC (Lighter) · **78.910 USDC** | |
| Modo clásico | **Activado** | |
| Apalancamiento | **2×** | |
| Capital asignado | **600 USDC** | 100 % |
| Órdenes de seguridad · separación · dist. · vol. | **6 · 2,5 % · 1,35 · 1,5** | |
| Take profit satélite | **2,4 % del margen** (1,2 % del precio) | |

**Qué hace esto.** Sin rejilla ni recompras: una única orden de cierre sobre la posición entera al 2,4 %
del margen —un 1,2 % del precio— sobre la media, exactamente como una martingala. Seguridades en **76.937 ·
74.274 · 70.679 · 65.825 · 59.272 · 50.427**: cobertura del **36,1 %**. Tamaños 37,1 → 424,6 USDC (la
escala 1,5 concentra el 35 % del capital en el último escalón).

**Peor caso (vista previa).** Notional **1.197,06**, margen **598,53**, media **59.436,8**, objetivo
**60.150,1** (+1,20 % de precio, +14,37 USDC, +2,40 % del margen), liquidación exacta **30.480,5**
(−48,72 % desde la media, −61,37 % desde el precio de hoy).

### Configuración C — «SOL con rejilla ancha y recompras frecuentes»

| Campo | Valor | % del capital |
|---|---|---|
| Par | SOL/USDC (Lighter) · **138,42 USDC** | |
| Apalancamiento | **2×** | |
| Capital asignado | **700 USDC** | 100 % |
| Órdenes de seguridad · separación · dist. · vol. | **4 · 4,5 % · 1,3 · 1,4** | |
| Ventas de rejilla | **5** | |
| Separación inicial de venta | **1,5 %** | |
| Multiplicador de distancia de venta | **1,15** | |
| % del núcleo vendido en el nivel 1 | **20 %** | |
| Descuento de recompra | **1 %** | |
| Take profit satélite | 1,2 % del margen (fábrica; 0,6 % del precio) | |

**Qué hace esto.** El núcleo son **0,924 SOL** (127,9 USDC) y se reparte en cinco ventas del 20 % (0,184
SOL ≈ **25,85-28,05 USDC** cada una) en **140,497 · 142,885 · 145,630 · 148,788 · 152,420**. El descuento
del 1 % es menor que la separación del 1,5 %: la primera recompra queda en 139,092, por encima de donde
entró el núcleo, así que cada venta recomprada deja margen a favor y el núcleo se conserva. Las seguridades
esperan en **132,191 · 124,093 · 113,566 · 99,881** (cobertura del **27,8 %**).

**Peor caso (vista previa).** Notional **1.399,79**, margen **699,89**, media **113,739**; objetivo del
satélite en 114,422 (+0,60 % de precio) sobre 11,383 SOL, +7,77 USDC; liquidación exacta **58,328**
(−48,72 % desde la media, −57,86 % desde el precio de hoy). Ventas del peor caso desde 115,446, de 0,184 SOL
cada una.

### Checklist antes de arrancar

- [ ] La checklist entera de la [martingala](./martingale.md#checklist-antes-de-arrancar); sus preguntas
  del take profit valen aquí para el **TP satélite**, que sale siempre como orden limitada.
- [ ] ¿Descuento de recompra **<** separación inicial de venta?
- [ ] ¿Sé cuánto vende cada línea? (`% del núcleo × ventas = 100` para ventas iguales; si no, la última se
  lleva el resto)
- [ ] ¿Cada venta de rejilla ≥ 20 USDC? (núcleo × % ≥ mínimo del par)
- [ ] ¿Sé que la salida de GridMart es el **TP satélite** más la rejilla, y no un take profit sobre el total?
- [ ] ¿He decidido si quiero **modo clásico** (una martingala con TP satélite, sin rejilla de ventas)?
- [ ] ¿`Espera entre ciclos` revisada? (viene en 1 min)

### Señales de alarma cuando ya está funcionando

| Lo que ves | Qué significa | Qué hacer |
|---|---|---|
| `Núcleo 0.0003, satélite 0.0000.` durante días sin `CYCLE_CLOSED` | Un resto por debajo del mínimo de orden del venue, que ninguna orden puede vender | Ciérralo a mano en el exchange |
| `ORDER_UNVIABLE` en las ventas de rejilla | Núcleo / ventas por debajo del mínimo | Menos ventas o más capital |
| Cada vuelta de la rejilla reduce el núcleo | Descuento > separación | Baja el descuento (en caliente) |
| `ADD_SAFETY_SKIPPED` tras «Adelantar orden de seguridad» | El exchange no aceptó la seguridad manual | Mira el evento anterior y repite si procede |
| Muchos ciclos cerrados en minutos con PnL ≈ 0 | TP satélite demasiado corto para comisiones | Súbelo |

---

## 4. Lo que este bot mira y lo que no

| Campo | Realidad |
|---|---|
| **Espera entre ciclos** (`cooldownMinutes`) | ✅ Sí, y en caliente: el valor vigente se aplica al cerrar el siguiente ciclo. Viene en **1 min**. |
| **Tope de exposición** (`maxNotionalCap`) | ✅ Sí: corta la escalera en el escalón en que el notional proyectado alcanza el tope; no toca la rejilla ni las recompras anotadas. |
| **Capital asignado** | ✅ Techo real de la escalera. |

Sí funcionan: **Stop loss**, **Pérdida diaria máxima**, **Al acercarse la liquidación**, guardas de la
cuenta.

---

## 5. Limitaciones conocidas (hallazgos abiertos)

Ningún hallazgo abierto propio a 2026-09-06 (`specs/001-revision-integral/findings.md`). Las de la escalera
están en la [martingala](./martingale.md#5-limitaciones-conocidas-hallazgos-abiertos).

---

## 6. Parámetros configurables, uno a uno

🔥 en caliente · 🌤️ en tibio (cancela y recoloca; la posición sigue; pide confirmación) · ❄️ en frío.

El TP satélite y el stop son **% del margen** desde el punto de equilibrio; las separaciones y el descuento
de recompra, **% del precio**. El máximo de los dos primeros escala con el apalancamiento `L` (el
formulario lo enseña ya multiplicado). Los bots creados antes del spec 080 se convirtieron una vez por su
propio apalancamiento: salen donde salían.

### 6.1 Configuración básica

#### Conexión de exchange · `exchangeAccountId` · ❄️ en frío

La cuenta con la que opera. **Consejo**: empieza en «Simulación», y no con esta estrategia.

#### Par · `symbol` · ❄️ en frío

Fija mínimo, paso de cantidad y apalancamiento máximo. Importa más que en otras: cada venta de la rejilla
tiene que redondear a una cantidad válida y por encima del mínimo.

#### Dirección · `direction` · ❄️ en frío · por defecto **Largo**

En corto todo se invierte: escalera por encima, rejilla de **recompras** por debajo del equilibrio, y
re-ventas por encima.

#### Capital asignado · `totalInvestment` · 🌤️ en tibio · mínimo 10 · ⚠️ campo de riesgo

Margen total de la escalera, repartido por pesos entre base y seguridades. **La base decide el tamaño del
núcleo**, y el núcleo dividido entre las ventas tiene que superar el mínimo del par: con 800 USDC, 5
seguridades y escala 1,3, la base son 125 USDC y cuatro ventas de unos 32.

#### Modo clásico · `classicMode` · ❄️ en frío · por defecto **No**

Apaga la rejilla de ventas y las recompras: queda una sola orden de cierre sobre la posición entera al
objetivo del **TP satélite**, y todos los parámetros de rejilla y recompra dejan de tener efecto.

**Consejo**: no se puede cambiar después. Es la forma de tener el comportamiento simple sin cambiar de
estrategia.

### 6.2 La escalera (heredada de la martingala)

#### Nº de órdenes de seguridad · `numLimitBuys` · 🌤️ en tibio · 1–30 · por defecto **6** · ⚠️ campo de riesgo

Cuántas seguridades se cuelgan bajo la base. Cada una que entra baja la media y **aumenta el satélite**.
Ver [la escalera en la guía de la martingala](./martingale.md#62-la-escalera).

#### Separación inicial (del precio) · `initialSeparationPct` · 🌤️ en tibio · 0,05–20 · por defecto **1**

Distancia de la base a la primera seguridad. Igual que en la martingala.

#### Escala de distancia · `stepScale` · 🌤️ en tibio · 1–3 · por defecto **1,2**

Cuánto se aleja cada seguridad respecto de la anterior; decide la cobertura. Igual que en la martingala.

#### Escala de volumen · `volumeScale` · 🌤️ en tibio · 1–5 · por defecto **1,6** · ⚠️ campo de riesgo

Cuánto crece cada seguridad. Aquí además decide **cuánto satélite** entra en cada escalón frente al núcleo
fijo. Igual que en la martingala.

#### Tipo de orden base · `baseOrderType` · 🔥 en caliente · por defecto **A mercado**

Cómo entra la base. «Límite» se coloca post-only al precio del momento y **espera quieta**: no persigue al
precio y, si en cinco minutos no se ha ejecutado, se vuelve a colocar al precio de entonces.
**Consejo**: **A mercado** para arrancar seguro; **Límite** si prefieres ahorrar la comisión de taker y no
te importa esperar.

### 6.3 La rejilla de ventas y las recompras

#### Take profit satélite (sobre el margen) · `satelliteTpPct` · 🔥 en caliente · 0,05–20·L · por defecto **1,2**

Beneficio sobre tu margen al que se cierra el **satélite** (lo que añadieron las seguridades), medido desde
el equilibrio: a 2×, un 1,2 % del margen es un 0,6 % del precio. Es la salida rápida del bot. Bajarlo
suelta el satélite en el primer repunte y libera margen; subirlo lo mantiene más tiempo expuesto. El
máximo es un 20 % del precio: 20 veces el apalancamiento sobre el margen (40 a 2×). El valor de fábrica,
1,2 %, es el 0,6 % del precio de siempre a 2×.

**Consejo**: suele ser corto a propósito, por debajo del 1 % del precio (un 2 % del margen a 2×), pero por
encima de las comisiones: si en precio no llega al 0,3 % (un 0,6 % del margen a 2×), la app avisa. Con el
modo clásico activado es el objetivo de la posición entera.

#### Ventas de rejilla · `gridSellCount` · 🌤️ en tibio · 1–20 · por defecto **4**

Cuántas ventas escalonadas se tienden sobre el núcleo. Más ventas trocean el núcleo en porciones más
pequeñas y reparten los cierres por un tramo más ancho de subida.

**Consejo**: que el núcleo dividido entre las ventas siga dando órdenes por encima del mínimo del par.

#### Separación inicial de venta (del precio) · `gridSellInitialSeparationPct` · 🌤️ en tibio · 0,05–20 · por defecto **1**

A qué distancia sobre el equilibrio se coloca la **primera** venta. Separaciones cortas venden pronto y a
menudo; largas esperan subidas de verdad.

**Consejo**: tiene que ser **mayor** que el descuento de recompra, o cada vuelta pierde núcleo. La app avisa.

#### Multiplicador de distancia de venta · `gridSellDistanceMultiplier` · 🌤️ en tibio · 1–3 · por defecto **1,2**

Cuánto se aleja cada venta respecto de la anterior. Subirlo abre la rejilla en abanico: las primeras
ventas cerca, las últimas muy arriba. **Consejo**: entre 1,1 y 1,3.

#### % del núcleo vendido en el nivel 1 · `corePctSoldAtLevel1` · 🌤️ en tibio · 1–100 · por defecto **25**

Qué parte del núcleo se vende en la primera línea. Con 25 % y cuatro ventas iguales el núcleo se agota
justo en la última. **Consejo**: `% × ventas = 100` si quieres ventas iguales; si no llega, la última venta
se lleva lo que quede (con un 10 % y cuatro ventas, el 70 %).

#### Multiplicador de cantidad de venta · `gridSellQtyMultiplier` · 🌤️ en tibio · 0,1–3 · por defecto **1**

Cuánto crece o mengua cada venta respecto de la anterior. Por encima de 1 vendes más cuanto más sube.
**Consejo**: empieza en 1. El bot recorta la venta que se pasaría del núcleo que queda, y la última se lleva
el resto.

#### Descuento de recompra (del precio) · `gridRebuyDiscountPct` · 🔥 en caliente · 0,05–20 · por defecto **0,5**

Cuánto por debajo del precio de una venta ejecutada se anota su recompra. **Es el beneficio de cada vuelta
completa de la rejilla.** Descuentos pequeños recompran enseguida y reciclan el escalón a menudo.

**Consejo**: manténlo por debajo de la separación inicial de venta.

### 6.4 Riesgo

#### Tope de exposición · `maxNotionalCap` · 🔥 en caliente · opcional

Aquí el motor **sí** lo consulta al tender la escalera: corta en el escalón en que se alcanza, sin tocar
la rejilla ni las recompras anotadas. **Consejo**: mira el peor caso de la vista previa para elegir la cifra.

#### Stop loss (sobre el margen) · `stopLossPct` · 🔥 en caliente · 0,1–90·L · ⚠️ campo de riesgo

Orden condicional nativa a `media × (1 − stop / (100 × apalancamiento))`
([riesgo §7](./riesgo-y-liquidacion.md#7-el-stop-loss)): un % de tu margen, con las mismas reglas que en la
[martingala](./martingale.md#63-riesgo) frente a la escalera y frente a la liquidación. Vacío es «sin
stop».
**Consejo**: más allá del último escalón y por delante de la liquidación: en la configuración A, entre el
36,3 % y el 64,9 % del margen; fuera de ese tramo la app avisa.

#### Pérdida diaria máxima (sobre el capital) · `maxDailyLossPct` · 🔥 en caliente · 0,1–100

Pérdida realizada hoy por este bot, en % de su capital, a partir de la cual se pausa.

#### Al acercarse la liquidación · `liquidationAction` · 🔥 en caliente · por defecto **Solo avisar** · ⚠️ campo de riesgo

Solo avisar / Pausar el bot / Cerrar todo. **Consejo**: «Cerrar todo» a 2× o más.

### 6.5 Tiempos

#### Espera entre ciclos (min) · `cooldownMinutes` · 🔥 en caliente · 0–10080 · por defecto **1**

La espera que **sí** se aplica entre el cierre de un ciclo y la siguiente base. Se puede cambiar en
caliente: el valor vigente se usa al cerrar el ciclo. **Consejo**: 1-5 minutos.

### 6.6 Exchange

#### Apalancamiento · `leverage` · 🌤️ en tibio · 1–50 · por defecto **2** · ⚠️ campo de riesgo

Como en la martingala, acorta la escalera que cabe: la app la recorre nivel a nivel con la media de lo ya
comprado y, si la liquidación llega antes que una seguridad, rechaza la configuración en aislado (en
cruzado, avisa). El TP satélite y el stop van en % del margen: con más apalancamiento quedan más cerca en
precio. Con la posición abierta no se puede cambiar (409, `LEVERAGE_WITH_POSITION`).
**Consejo**: 1× o 2×; cuánta escalera cabe a cada apalancamiento, en la
[regla 2 de la martingala](./martingale.md#las-seis-reglas-de-oro).

#### Modo de margen · `marginMode` · ❄️ en frío · por defecto **Aislado**

**Consejo**: **Aislado**.

---

## 7. Resumen de valores de fábrica

| Campo | Por defecto | ¿Lo cambio? |
|---|---|---|
| Modo clásico | No | 🟡 Sí, si quieres simplicidad |
| Escalera (seguridades · sep. · dist. · vol.) | 6 · 1 % · 1,2 · 1,6 | Como en la martingala: cobertura 9,9 %, corta |
| Take profit satélite | 1,2 % del margen (0,6 % del precio a 2×) | ✅ Déjalo, o 1,6 % (0,8 % del precio) |
| Ventas de rejilla | 4 | ✅ Déjalo |
| Separación inicial de venta | 1 % | ✅ Déjalo |
| Multiplicador de distancia de venta | 1,2 | ✅ Déjalo |
| % del núcleo vendido en el nivel 1 | 25 % | ✅ Déjalo (4 × 25 = 100) |
| Multiplicador de cantidad de venta | 1 | ✅ Déjalo |
| Descuento de recompra | 0,5 % | ✅ Déjalo (< 1 %) |
| Espera entre ciclos | 1 | ✅ Déjalo, o 1-5 min |
| Apalancamiento / Modo de margen | 2× / Aislado | ✅ Déjalo |

---

## 8. ¿Esta u otra?

| | **GridMart** | [Martingala](./martingale.md) | [Rejilla clásica](./grid-classic.md) |
|---|---|---|---|
| Entradas | Escalera martingala | Escalera martingala | Líneas fijas de un rango |
| Salida | Satélite por TP corto + núcleo por rejilla con recompras | Una, sobre el total | Una por línea comprada |
| Mecanismos simultáneos | 4 | 2 | 1 |
| Riesgo | Alto | Alto | Bajo |
| Hallazgos abiertos propios | — | — | — |

**Elige GridMart si**: ya entiendes la martingala, esperas una caída seguida de un lateral, y quieres que
la posición trabaje mientras espera. **Elige la martingala si**: quieres lo mismo sin la rejilla (o usa el
modo clásico). **Elige la rejilla clásica si**: es tu primer bot.
