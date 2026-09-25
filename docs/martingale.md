# Martingala (Martingale) — guía completa

> Estrategia `MARTINGALE` · riesgo **ALTO**.
> Código: [`martingale.ts`](../packages/strategy-core/src/strategies/martingale.ts) · la escalera en `scaledLadder()` de [`ladder.ts`](../packages/strategy-core/src/ladder.ts) · guía in-app en [`martingale.guide.ts`](../apps/app/src/app/core/content/martingale.guide.ts) y [`ladder-options.ts`](../apps/app/src/app/core/content/ladder-options.ts).
> Lee antes [riesgo y liquidación](./riesgo-y-liquidacion.md). Esta estrategia y [GridMart](./gridmart.md) son las dos con **riesgo de ruina real**.

---

## 1. Qué es esto, en cristiano

Una **entrada inicial** y, por debajo, varias **órdenes de seguridad**, cada una **más lejos y más grande**
que la anterior. Si el precio baja, las seguridades van entrando y cada una **baja tu precio medio**
deprisa, porque compra más que las anteriores. Basta entonces un **rebote pequeño** sobre esa media para
que la orden de cierre —una sola, sobre toda la posición— se ejecute en beneficio y el ciclo termine.

Convierte una bajada en una posición con precio medio bajo. Funciona en pares que **corrigen y rebotan**
con regularidad, y cuyas caídas rara vez pasan de lo que cubre tu escalera.

### El riesgo, dicho claro

El par **cae y no vuelve**. Cada escalón te deja más dinero dentro de una posición que sigue bajando, y
por construcción **los últimos escalones son los más grandes**: en la configuración A de abajo, el último
mueve 17 veces la entrada base. Cuando la escalera se agota, el bot deja de promediar y solo queda esperar
el rebote o asumir la pérdida. El peor caso es **todo el capital asignado multiplicado por el
apalancamiento**, y aparece en la Revisión antes de crear el bot, con su objetivo, su stop y su
liquidación. Léelo.

Con **apalancamiento**, la escalera y la liquidación tiran en la misma dirección. La app recorre la
escalera nivel a nivel con la media de lo ya comprado y, si la liquidación de esa media llega antes que
una seguridad, **rechaza** la configuración en margen aislado (en cruzado, avisa): esa seguridad jamás se
ejecutaría.

### Vocabulario mínimo

| Palabra | Qué significa aquí |
|---|---|
| **Entrada base** (`BASE#0`) | La primera orden del ciclo. Por defecto a mercado: el ciclo empieza ya. |
| **Seguridad** (`SAFETY#i`) | Cada orden colgada por debajo de la base, post-only, esperando la caída. |
| **Separación inicial** | Distancia de la base a la primera seguridad, en % del precio. |
| **Escala de distancia** | Cada hueco entre seguridades es este múltiplo del anterior. Decide la **cobertura**. |
| **Escala de volumen** | Cada seguridad pide este múltiplo de capital respecto de la anterior. Es lo que hace de esto una martingala. |
| **Cobertura** | Cuánta caída aguanta la escalera antes de quedarse sin órdenes: `sep × (1 + d + d² + … + dⁿ⁻¹)`. |
| **Ancla** | El precio de la entrada base. Toda la escalera cuelga de él, **no del precio actual**. |
| **Take profit** | La orden de cierre, sobre el total, al `precio medio × (1 + objetivo / (100 × apalancamiento))`: el objetivo es un % de tu **margen** (a 2×, un 2,4 % del margen es un 1,2 % del precio). Se recoloca con cada seguridad ejecutada. |
| **Ciclo** | De la entrada base al cierre. Al cerrar, `Espera entre ciclos` y vuelta a empezar. |

---

## 2. Cómo funciona por dentro, paso a paso

El motor revisa el bot **cada 15 segundos**; una ejecución dispara una revisión inmediata.

### Paso 1 — Sin posición: abrir ciclo

Si no hay posición y no estás en espera entre ciclos, el bot calcula la escalera **al precio actual**, se
queda con la cantidad del nivel 0 y manda la **entrada base**: a mercado (por defecto, vía «inmediata»: se
manda una vez y no se reconcilia) o post-only al precio actual si elegiste «Límite». La nota dice
`Abriendo ciclo.`

### Paso 2 — La escalera

Con `n` seguridades, separación inicial `s`, escala de distancia `d` y escala de volumen `v`:

```
precio_i  = ancla × (1 − (s + s·d + s·d² + … + s·dⁱ⁻¹) / 100)      i = 1…n   (en corto, sumando)
peso_0    = 1        peso_i = vⁱ
margen_i  = capital asignado × peso_i / Σ pesos                       ← Σ margen_i = capital asignado
cantidad_i = margen_i × apalancamiento / precio_i
```

El reparto es **proporcional a los pesos, no «importe por orden»**: por eso el capital asignado es un techo
real y no te quedas sin margen a media escalera. La consecuencia es que **el capital se concentra en los
últimos escalones**: con `v = 1,6` y 6 seguridades, la última pesa `1,6⁶ ≈ 16,8` veces la base.

### Paso 3 — Con posición: seguridades pendientes y salida

- El **ancla es el precio de la entrada base**, guardado en el ciclo. Si se recalculara con el mercado,
  las seguridades bajarían con él y jamás llegarían a tocarse.
- Para cada seguridad **no ejecutada** desea una orden **post-only** en su precio. Si pusiste **Tope de
  exposición**, la escalera **se corta** en el escalón cuyo notional proyectado lo superaría: lo abierto,
  valorado al precio de ahora, más las seguridades que se tienden. Es proyectado, no a posteriori, y como
  lo abierto vale menos cuanto más cae el precio, un escalón entra si la posición que deja, valorada a su
  propio precio, cabe en el tope. La base entra sin mirarlo.
- Desea la **salida**: una orden **LIMIT reduce-only** sobre toda la posición al `media real × (1 +
  objetivo / (100 × apalancamiento))`. La media es la que reporta el exchange, así que al llenarse una
  seguridad la salida se recoloca sola en la siguiente revisión.
- Nota: `Ciclo abierto: 4 seguridades pendientes.`

### Paso 4 — Cierre y espera

Cuando la salida se ejecuta, el ciclo se cierra con su PnL (`CYCLE_CLOSED`), y si `Espera entre ciclos`
es mayor que cero, el bot espera (`En cooldown, 43 s para el próximo ciclo.`) antes de abrir la siguiente
entrada base.

### Paso 5 — Guardas

El motor añade el **stop-loss** si lo configuraste: una condicional nativa en `media × (1 − stop / (100 ×
apalancamiento))`, porque el stop también es un % del margen. Y evalúa las
[guardas de riesgo](./riesgo-y-liquidacion.md#6-las-guardas-del-motor-revisión-a-revisión). La propia
estrategia valida al crear el bot, al editarlo y al arrancarlo. Recorre la escalera **nivel a nivel**, con
la media de lo ya comprado y la liquidación exacta de esa media (`media × (1 − 1/L) / (1 − mantenimiento)`
en largo, [riesgo §2](./riesgo-y-liquidacion.md#2-la-fórmula-de-la-liquidación)):

- si la liquidación llega antes que una seguridad, **rechaza** la configuración en aislado y avisa en
  cruzado («A 4× la liquidación llega antes que la seguridad 6…»);
- si el que llega antes es el stop, avisa («El stop del 40 % del margen salta antes que la seguridad 6…»);
- si la escalera cabe entera pero cubre menos de la mitad de la distancia a la liquidación, avisa («La
  escalera solo cubre un 9.9 % de caída…»);
- con **Tope de exposición**, recorre solo lo que el tope deja tender: un escalón que no se tiende no
  existe, y que la liquidación llegara antes que él ya no es un error. Si la escalera se queda corta por
  el tope, lo dice («Con el tope de exposición la escalera se queda en la seguridad 3…»), y si no cabe
  ninguna seguridad, también.

La Revisión enseña lo mismo: dónde se corta la escalera y por qué, el tope incluido («El tope de
exposición no deja tender la seguridad 6…»). Además avisa si la escala de volumen
pasa de 2,5 o si el take profit, pasado a precio, no llega al 0,3 %, y comprueba el stop frente a la
liquidación ([riesgo §7](./riesgo-y-liquidacion.md#el-stop-frente-a-la-liquidación)).

---

## 3. Cómo configurarlo con poco riesgo

### Las seis reglas de oro

1. **Mira el último escalón antes que el primero.** Es el más grande y el que se ejecuta cuando la caída ya
   es grave. Si su tamaño te asusta, baja la escala de volumen, no el número de seguridades.
2. **1× o 2×.** A 1× en largo no hay liquidación (en corto sí). El apalancamiento acorta cuánta escalera
   cabe: con las escalas de la configuración A (6 seguridades, 1,3 y 1,6) y el mantenimiento del 2,5 % de
   ETH en Lighter, la app acepta en aislado escaleras de hasta un 66 % de caída a 2×, un 48 % a 3× y un
   30 % a 5×. Es más de lo que aguantaría una sola entrada (48,7 %, 31,6 % y 17,9 %) porque la media baja
   con cada escalón, y depende de la escala de volumen: con 1, se queda en un 59 %, un 40 % y un 24 %. Baja
   el apalancamiento antes que acortar la escalera.
3. **Que la escalera quepa entera, y con holgura.** La app la recorre nivel a nivel con la liquidación
   exacta de la media de lo ya comprado (paso 5), y en aislado no te deja una seguridad detrás de la
   liquidación. Que la app no avise no significa que haya holgura: mira en la Revisión cuánto queda entre
   el último escalón y la liquidación del peor caso (en la configuración A, de 1.545,36 a 926,70).
4. **Take profit «Límite», salvo que quieras garantizar el cierre.** «A mercado» espera al objetivo como
   orden condicional y cruza el libro al tocarlo: cierra seguro, pero paga taker y algo de deslizamiento.
5. **El take profit tiene que pagar la ida y vuelta.** Entrada a mercado (taker) + salida maker: por debajo
   del 0,3 % **del precio** un ciclo cerrado puede acabar en pérdida, y la app avisa. El objetivo es un %
   del margen, así que ese 0,3 % es un 0,6 % del margen a 2× y un 1,5 % a 5×; el formulario enseña debajo
   del campo su equivalente en precio. El mínimo del formulario (0,05 %) no es un buen valor.
6. **El stop-loss, más allá del último escalón.** Por encima, cierra el ciclo antes de haber terminado de
   promediar, y la app avisa de qué seguridad no llegaría. Por el otro lado lo limita la liquidación: en
   aislado no puede quedar en ella ni detrás, y si la deja a menos de medio stop, la app avisa y propone el
   más ancho válido. En la configuración A, entre el 47,5 % y el 64,9 % del margen.

Las cifras de los ejemplos salen de `preview()` sobre las fichas de mercado de
[`venue-markets.ts`](../packages/strategy-core/src/venue-markets.ts). La liquidación es la exacta de una
posición aislada con el mantenimiento que da cada ficha: 2,5 % en los pares de Lighter (admiten 20×) y 1 %
en Aster (50×). Con el bot en marcha manda la que devuelve el exchange. Los resultados en USDC son sin
comisiones, como en la Revisión.

### Configuración A — «Escalera equilibrada en ETH»

Precios del 24-08-2026 (`venue-markets.ts`), Lighter, ETH a **2.503,35 USDC**.

| Campo | Valor | % del capital |
|---|---|---|
| Par | ETH/USDC (Lighter) | |
| Apalancamiento | **2×** | |
| Capital asignado | **400 USDC** | 100 % |
| Órdenes de seguridad | **6** | |
| Separación inicial | **3 %** | |
| Escala de distancia | **1,3** | |
| Escala de volumen | **1,6** | |
| Take profit | **2,4 % del margen** (1,2 % del precio) | |
| Tipo de orden base / Modo de take profit | A mercado / **Límite** | |
| Espera entre ciclos | 1 min | |

**Qué hace esto.** La escalera, con sus tamaños (notional a 2×):

| Nivel | Precio | Caída acumulada | Notional | Margen |
|---|---|---|---|---|
| Base | 2.503,35 | — | 18,52 | 9,26 |
| S1 | 2.428,24 | 3,0 % | 29,62 | 14,81 |
| S2 | 2.330,61 | 6,9 % | 47,54 | 23,77 |
| S3 | 2.203,69 | 12,0 % | 76,03 | 38,01 |
| S4 | 2.038,70 | 18,6 % | 121,71 | 60,86 |
| S5 | 1.824,20 | 27,1 % | 194,64 | 97,32 |
| S6 | 1.545,36 | **38,3 %** | 311,54 | 155,77 |

El margen es lo que el venue retiene por cada orden: su notional entre el apalancamiento. La escalera
reparte los 400 del capital por pesos, pero la cantidad se redondea hacia abajo al paso del par (0,0001
ETH), así que cada nivel retiene algo menos de lo asignado y los siete suman 399,81.

La escalera cubre un **38,3 %** de caída. Con todos los escalones llenos la media baja a 1.807,05 y la
liquidación exacta queda en **926,70**, un 48,7 % por debajo de esa media y un 63,0 % por debajo del precio
de hoy: muy lejos del último escalón. Cabe entera con holgura porque la liquidación baja con la media, y la
media baja con cada escalón. La base mueve 18,5 USDC y el último escalón **311,5**: diecisiete veces más.
Si ETH cae a 1.900 (cuatro seguridades dentro; la quinta espera en 1.824,20), la media queda en 2.186,52 y
la salida se recoloca en 2.212,77: basta con que el precio vuelva a un 1,2 % por encima de esa media —el
2,4 % del margen a 2×— para cerrar el ciclo completo, sin recuperar los 2.503 de la entrada.

**Peor caso (vista previa).** Notional **799,62 USDC**, margen **399,81**, media **1.807,05**. Objetivo en
**1.828,74** (+1,20 % de precio, +9,60 USDC, +2,40 % del margen); liquidación en **926,70** (−48,72 %
desde la media y −62,98 % desde el precio de hoy; −389,55 USDC, −97,43 % del margen).

**El stop que le cabe.** Por debajo del 47,5 % del margen salta antes que alguna seguridad —con un 20 %,
antes que la cuarta; con un 40 %, antes que la sexta— y la app avisa («El stop del 40 % del margen salta
antes que la seguridad 6…»); por encima del 64,9 %, la liquidación queda a menos de medio stop detrás, y la
app avisa y propone ese 64,9 %. Con un 55 %, la Revisión pone el stop en 1.310,11 (−27,50 % desde la
media, −219,89 USDC) y una relación beneficio/riesgo de **0,04**: el ciclo gana un 1,2 % de precio y el
stop pierde un 27,5 %. Es la cuenta de toda martingala, dicha con números.

### Configuración B — «BTC conservador, escalera corta»

| Campo | Valor | % del capital |
|---|---|---|
| Par | BTC/USDC (Lighter) · **78.910 USDC** | |
| Apalancamiento | **3×** | |
| Capital asignado | **900 USDC** | 100 % |
| Órdenes de seguridad | **6** | |
| Separación inicial | **2 %** | |
| Escala de distancia | **1,25** | |
| Escala de volumen | **1,4** | |
| Take profit | **3 % del margen** (1 % del precio) | |
| Tope de exposición | **2.400 USDC** | 267 % |

**Qué hace esto.** Escalones en 77.332, 75.359, 72.893, 69.811, 65.958 y 61.141: cobertura del **22,5 %**.
A 3× una sola entrada se liquidaría a un 31,6 % de distancia (mantenimiento del 2,5 %); con la escalera
llena hasta donde deja el tope (la base y cinco seguridades, ver abajo) la liquidación queda en 48.317,1,
un 38,8 % por debajo del precio de hoy y muy por debajo del último escalón tendido. Tamaños: 112,8 · 157,8 · 221,6 · 310,5 · 434,2 · 608,1 · 851,7 USDC. La escala de volumen baja
(1,4) hace que el último escalón no sea desproporcionado frente al primero: se promedia más despacio a
cambio de un peor caso más plano.

El **Tope de exposición** aquí sí trabaja: con el quinto escalón lleno la posición suma 1.845 USDC; el
sexto (851,7) la llevaría a unos 2.448 valorada a su precio, por encima de 2.400, así que **no se tiende**.
La app lo avisa al crear: «El tope de exposición (2400.00) es menor que el capital por el apalancamiento
(2700.00): la posición no pasará de 2400.00.» Es deliberado: el tope recorta el escalón que más asusta.

**Peor caso (vista previa).** La Revisión aplica el tope como el motor y corta la escalera en la sexta
seguridad: «El tope de exposición no deja tender la seguridad 6». Notional **1.845,03**, margen
**615,01**, media **70.663,7**, objetivo **71.370,4** (+1,00 % de precio, +18,45 USDC, +3,00 % del
margen), liquidación **48.317,1** (−31,62 % desde la media, −38,77 % desde el precio de hoy; −583,47
USDC, −94,87 % del margen). Sin el tope, la escalera entera serían 2.696,73 de notional y la
liquidación bajaría a 46.051,9.

### Configuración C — «DOGE agresivo, escalera profunda»

| Campo | Valor | % del capital |
|---|---|---|
| Par | DOGE/USDT (Aster) · **0,09209 USDT** | |
| Apalancamiento | **2×** | |
| Capital asignado | **300 USDT** | 100 % |
| Órdenes de seguridad | **5** | |
| Separación inicial | **5 %** | |
| Escala de distancia | **1,3** | |
| Escala de volumen | **1,5** | |
| Take profit | **6 % del margen** (3 % del precio) | |

**Qué hace esto.** Escalones en 0,08748, 0,08149, 0,07371, 0,06360 y 0,05045: la escalera cubre un
**45,2 %**. Con todos llenos la media baja a 0,06268 y la liquidación exacta (mantenimiento del 1 %, el de
la ficha de Aster) queda en 0,03166, un 65,6 % por debajo del precio de hoy: cabe entera. Lo estrecho aquí
es el stop: para no saltar antes que la quinta seguridad tiene que ser de al menos un 61,6 % del margen, y
para dejar medio stop hasta la liquidación, de un 65,9 % como mucho. La base mueve 313 DOGE (28,8 USDT) y
el último escalón 4.345 DOGE (**219 USDT**): más de un tercio del capital vive en ese único nivel. En Aster
el paso de cantidad es 1 DOGE y el mínimo 5 USDT.

**Peor caso (vista previa).** Notional **599,80**, margen **299,90**, media **0,06268**, objetivo
**0,06457** (+3,01 % de precio, +18,07 USDT, +6,02 % del margen: el precio de venta se redondea al tick
hacia arriba), liquidación **0,03166** (−49,49 % desde la media, −65,62 % desde el precio de hoy).

### Checklist antes de arrancar

- [ ] ¿He mirado el tamaño del **último** escalón y lo acepto?
- [ ] ¿La Revisión tiende la escalera entera, sin cortarla por el stop ni por la liquidación, y con
  holgura entre el último escalón y la liquidación?
- [ ] ¿Apalancamiento 1× o 2×?
- [ ] ¿Modo de take profit en **Límite**?
- [ ] ¿Take profit de al menos un 0,5 % del precio? (a 2×, un 1 % del margen)
- [ ] ¿La entrada base y la primera seguridad superan 20 USDC?
- [ ] ¿Stop loss más allá del último escalón y por delante de la liquidación (o peor caso aceptado)?
- [ ] ¿`Espera entre ciclos` con algún minuto, para no reentrar en el mismo impulso?
- [ ] ¿No es Lighter? (o acepto que sus ejecuciones lleguen por sondeo, hasta 12 s tarde)

### Señales de alarma cuando ya está funcionando

| Lo que ves | Qué significa | Qué hacer |
|---|---|---|
| `Ciclo abierto: 0 seguridades pendientes` y el precio sigue bajando | Escalera agotada | Decide: esperar (con stop), aportar margen, cerrar |
| Muchos `CYCLE_CLOSED` con PnL ≈ 0 en pocos minutos | El take profit no cubre comisiones | Súbelo |
| `Abriendo ciclo.` durante mucho rato sin `FILL` | La base es «Límite» y el precio se ha ido; se recoloca cada cinco minutos | Espera, pon «A mercado» o revisa el venue |
| `ADD_SAFETY_SKIPPED` tras «Adelantar orden de seguridad» | El exchange no aceptó la seguridad manual | Mira el evento anterior y repite si procede |
| `ORDER_UNVIABLE` en las primeras seguridades | Tamaños por debajo del mínimo del par | Más capital o menos seguridades |
| `LIQUIDATION_NEAR` | Vas apalancado y la caída es grande | Aporta margen o cierra parte |

---

## 4. Lo que este bot mira y lo que no

| Campo | Realidad |
|---|---|
| **Capital asignado** | ✅ **Techo real**: `Σ margen_i = capital`. |
| **Tope de exposición** (`maxNotionalCap`) | ✅ **Sí lo consulta**, y bien: corta la escalera en el escalón cuyo notional **proyectado** superaría el tope. |
| **Espera entre ciclos** (`cooldownMinutes`) | ✅ Sí, y en caliente: el valor vigente se aplica al cerrar el siguiente ciclo. |
| **Dirección** | ✅ En corto la escalera cuelga hacia arriba y la salida es una recompra. |

Sí funcionan, aplicados por el motor: **Stop loss**, **Pérdida diaria máxima**, **Al acercarse la
liquidación**, guardas de la cuenta.

---

## 5. Limitaciones conocidas (hallazgos abiertos)

Ningún hallazgo abierto a 2026-09-06 (`specs/001-revision-integral/findings.md`). Lo que conviene saber:

> ℹ️ La app **avisa** si el take profit, pasado a precio, baja del 0,3 % (a 2×, un 0,6 % del margen): con
> una entrada taker y una salida maker, por debajo un ciclo cerrado puede acabar en pérdida. El
> **funding** de una escalera agotada esperando días no aparece en ninguna pantalla (riesgo §9).

---

## 6. Parámetros configurables, uno a uno

🔥 en caliente · 🌤️ en tibio (cancela y recoloca las órdenes; la posición sigue; pide confirmación) ·
❄️ en frío (hay que crear otro bot).

El take profit y el stop son **% del margen** desde el precio medio; la separación y el retroceso, **% del
precio**. El máximo de los dos primeros escala con el apalancamiento `L` (el formulario lo enseña ya
multiplicado), para que su tope en precio no cambie. Los bots creados antes del spec 080 se convirtieron
una vez por su propio apalancamiento: salen donde salían.

### 6.1 Configuración básica

#### Conexión de exchange · `exchangeAccountId` · ❄️ en frío

La cuenta con la que opera (real, pruebas o simulación). **Consejo**: empieza en «Simulación».

#### Par · `symbol` · ❄️ en frío

Fija el mínimo de orden, el paso de cantidad y el apalancamiento máximo. En pares baratos (DOGE) el paso
de cantidad es 1 moneda.

#### Dirección · `direction` · ❄️ en frío · por defecto **Largo**

En corto la escalera se cuelga **por encima** del precio (vende más cuanto más sube) y la salida es una
recompra por debajo de la media. La liquidación del corto queda algo más cerca que la del largo y existe
también a 1×: con un mantenimiento del 2,5 %, a un 46,3 % de subida a 2× (48,7 % en largo) y a un 95,1 % a
1×.

#### Capital asignado · `totalInvestment` · 🌤️ en tibio · mínimo 10 · ⚠️ campo de riesgo

El margen total de la escalera, repartido proporcionalmente a los pesos entre base y seguridades. **Es un
techo real.** Con apalancamiento, el peor caso en notional es el capital multiplicado por él.

**Consejo**: con 6 seguridades y escala 1,6 la base pesa un 2,3 % del capital: 400 USDC dan una base de
18,5 USDC de notional a 2×. Comprueba que la base supera el mínimo del par.

### 6.2 La escalera

#### Nº de órdenes de seguridad · `numLimitBuys` · 🌤️ en tibio · 1–30 · por defecto **6** · ⚠️ campo de riesgo

Cuántas órdenes se cuelgan por debajo de la entrada base. Cada una que entra baja tu media y **aumenta la
posición**. Más seguridades aguantan una caída más profunda, pero también es más dinero comprometido si la
caída no rebota.

**Consejo**: el número solo no dice nada: lo que decide hasta dónde aguantas es este número junto a la
separación y la escala de distancia (la cobertura).

#### Separación inicial (del precio) · `initialSeparationPct` · 🌤️ en tibio · 0,05–20 · por defecto **1**

A qué distancia de la base se cuelga la **primera** seguridad. Separaciones cortas gastan munición en
ruido; largas guardan la munición para una caída de verdad pero tardan más en bajar la media.

**Consejo**: en un par volátil como DOGE, un 1 % se toca varias veces al día; en BTC es una caída seria.

#### Escala de distancia · `stepScale` · 🌤️ en tibio · 1–3 · por defecto **1,2**

Cuánto se aleja cada seguridad respecto de la anterior. Con 1 todas van a la misma distancia; con 1,5
cada hueco es un 50 % más ancho. Decide la **cobertura** total sin añadir órdenes.

**Consejo**: la app rechaza la configuración en aislado si, con la media de lo ya comprado, la liquidación
llega antes que alguna seguridad. La escalera A (38,3 %) cabe a 3× y no a 4×: «A 4× la liquidación llega
antes que la seguridad 6, que está a un 38.3 % de caída desde la entrada…».

#### Escala de volumen · `volumeScale` · 🌤️ en tibio · 1–5 · por defecto **1,6** · ⚠️ campo de riesgo

Cuánto crece cada seguridad respecto de la anterior. Con 2, cada una compra el doble que la de antes. Es
el parámetro que hace de esto una martingala: baja la media mucho más rápido, pero concentra casi todo el
capital en los últimos escalones.

**Consejo**: por encima de 2,5 la app avisa. El reparto es proporcional al capital, así que subirlo no
gasta más dinero: mueve el que hay hacia el final de la escalera.

#### Take profit (sobre el margen) · `takeProfitPct` · 🔥 en caliente · 0,05–50·L · por defecto **2**

Beneficio sobre tu margen al que se cierra la posición entera, medido desde el precio medio, como el TP
por ROI de un exchange: a 2×, un 2 % del margen es un 1 % del precio. Se recalcula con cada seguridad
ejecutada. El máximo es un 50 % del precio: 50 veces el apalancamiento sobre el margen (100 a 2×). El
formulario enseña debajo del campo su equivalente en precio y, con la escalera llena, dónde queda y cuánto
es en USDC. El valor de fábrica, 2 %, es el 1 % del precio de siempre a 2×; con más apalancamiento, el
mismo 2 % queda más cerca.

**Consejo**: las comisiones se pagan sobre el precio: con una entrada taker y una salida maker, por debajo
del 0,3 % del precio (un 0,6 % del margen a 2×) un ciclo cerrado puede acabar en pérdida; la app lo avisa.

#### Seguir al máximo (trailing) · `trailingTakeProfit` · 🔥 en caliente · por defecto **Apagado**

Convierte el take profit en un objetivo que **sigue al precio**. Al llegar al porcentaje que pediste el bot
no cierra: empieza a seguir al máximo y solo vende cuando el precio retrocede lo que digas.

Con él encendido, el **take profit deja de ser la salida y pasa a ser la activación**, y la Revisión lo
rotula así («Objetivo · empieza a seguir»). Tu «30 %» sigue donde estaba y significa otra cosa: el punto
en el que empieza el seguimiento. Sigue siendo un % del margen; el retroceso, en cambio, es del precio.

Las tres fases, a 2× con activación en el 30 % del margen (un 15 % del precio) y retroceso del 1 %, sobre
una media de 100:

| Fase | Precio | Qué hace el bot |
|---|---|---|
| Antes de activar | 100 → 114 | **Nada**. No hay orden de beneficio en el libro; la única protección es tu stop loss, que sigue intacto |
| Se activa | 115 | Coloca un disparador en `115 × 0,99 = 113,85` |
| Sigue | 115 → 130 | Sube el disparador a `130 × 0,99 = 128,70`. **Nunca lo baja** |
| Cierra | 130 → 128,70 | Vende a mercado |

**El suelo de lo que cobras es `activación × (1 − retroceso)`**: con un 15 % de precio y un 1 %, **+13,85 %
del precio**, un +27,7 % del margen a 2×. Un trailing puede darte mucho más que un objetivo fijo, y también
un poco menos. Eso no es un fallo: es el peaje.

**No es una mejora gratis.** En marcos cortos **baja la tasa de acierto**, porque el retroceso normal de
una cripto —un 1-3 % al día sin cambiar de tendencia— lo dispara antes de tiempo. Funciona mejor cuando lo
que esperas es un movimiento grande, no ruido.

**Al encenderlo en un bot en marcha**: la orden de beneficio que hubiera en el libro se cancela en la
siguiente revisión, y si el precio todavía no ha llegado al objetivo **no se sustituye por nada** hasta que
llegue. Es lo correcto —no hay nada que asegurar por debajo del objetivo— pero conviene saberlo.

#### Retroceso para salir (del precio) · `trailingCallbackPct` · 🔥 en caliente · 0,1–10 · por defecto **1**

Cuánto tiene que caer el precio desde el máximo alcanzado para que el bot cierre, en % del precio. En corto
es al revés: cuánto tiene que subir desde el mínimo.

Es todo el compromiso de esta función: **pequeño** asegura casi todo el máximo pero te saca en la primera
sacudida; **grande** aguanta el ruido y te deja correr la tendencia, a cambio de devolver más cuando gire.

**Consejo**: míralo contra lo que respira tu par, no en abstracto. Por debajo del 0,5 % en algo que se
mueve un 1-3 % al día, sales en el primer respiro — la app te avisa.

#### Umbral para mover el disparador (bps) · `trailingRepriceBps` · 🔥 en caliente · 1–200 · por defecto **20**

Cuánto tiene que avanzar el disparador para que el bot lo **mueva de verdad** en el exchange. 20 bps son un
0,2 %. Por debajo de eso el máximo sube pero la orden se queda donde está.

Existe porque mover la orden son **dos peticiones** (cancelar y colocar). En **Lighter** el cupo son 60
peticiones por minuto **de toda tu IP**, o sea unas 25 recolocaciones: un trailing que se mueve en cada
revisión se come el presupuesto de todos tus bots de ese exchange.

**Consejo**: déjalo como está salvo en Lighter, donde conviene subirlo.

**Cómo se ejecuta, y por qué importa**: la orden que se coloca es **condicional nativa del exchange**, así
que se dispara aunque el worker de CRYPTON esté caído y aunque la caída de precio ocurra entre dos
revisiones. Lo que gestiona el motor es **dónde** ponerla, no si se ejecuta.

#### Tipo de orden base · `baseOrderType` · 🔥 en caliente · por defecto **A mercado**

Cómo entra la primera orden del ciclo. **A mercado** arranca siempre, paga taker y entra al precio del
momento. **Límite** se coloca post-only al precio del momento y espera quieta: no persigue al precio y, si
en cinco minutos no se ha ejecutado, se vuelve a colocar al precio de entonces.

**Consejo**: **A mercado** para arrancar seguro; **Límite** para ahorrar la comisión de taker si no te
importa esperar.

#### Modo de take profit · `tpMode` · 🔥 en caliente · por defecto **Límite**

**Límite** deja la salida colgada como maker: más barata, pero si el precio la roza y se va, el ciclo sigue
abierto. **A mercado** la deja como orden condicional que cruza el libro al tocar el objetivo: cierra
seguro, paga taker y algo de deslizamiento.

**Consejo**: **Límite** en pares líquidos; **A mercado** si prefieres garantizar el cierre.

### 6.3 Riesgo

#### Tope de exposición · `maxNotionalCap` · 🔥 en caliente · opcional

Tope del valor de la posición. **Aquí el motor sí lo consulta**: corta la escalera en el escalón en que el
notional proyectado lo alcanza, y la Revisión la enseña cortada ahí. Útil como segundo techo por si te
equivocas con la escala de volumen.

**Consejo**: mira el peor caso de la vista previa para elegir la cifra; en la configuración B recorta el
último escalón.

#### Stop loss (sobre el margen) · `stopLossPct` · 🔥 en caliente · 0,1–90·L · ⚠️ campo de riesgo

Pérdida sobre tu margen, medida desde la media, a la que el motor cierra la posición con una orden
condicional nativa ([riesgo §7](./riesgo-y-liquidacion.md#7-el-stop-loss)): a 2×, un 20 % del margen es un
10 % del precio. Es la única salida ordenada cuando la escalera se agota y el precio sigue bajando. Vacío
es «sin stop».

El máximo es un 90 % del precio (90·L sobre el margen), pero antes manda la liquidación: en aislado, un
stop que quede en ella o detrás es un error, y uno que la deje a menos de medio stop, un aviso. Los dos
proponen el más ancho válido, y el formulario lo aplica con «Usar el stop más ancho válido». Si la
posición del exchange tiene un apalancamiento mayor que el de la configuración, el stop se calcula con ese
y el bot avisa una vez (`LEVERAGE_SKIPPED`).

**Consejo**: **más allá del último escalón**. Por encima, cierra el ciclo antes de terminar de promediar, y
la app avisa de qué seguridad no llegaría. En la configuración A, entre el 47,5 % y el 64,9 % del margen.

#### Pérdida diaria máxima (sobre el capital) · `maxDailyLossPct` · 🔥 en caliente · 0,1–100

Pérdida realizada hoy por este bot, en % de su capital, a partir de la cual se pausa. Útil en una
estrategia que promedia: un mal día encadena varias entradas.

#### Al acercarse la liquidación · `liquidationAction` · 🔥 en caliente · por defecto **Solo avisar** · ⚠️ campo de riesgo

Solo avisar / Pausar el bot / Cerrar todo cuando la distancia a la liquidación baja del umbral de aviso.
**Consejo**: si operas a 2× o más, «Cerrar todo» duele menos que una liquidación.

### 6.4 Tiempos

#### Espera entre ciclos (min) · `cooldownMinutes` · 🔥 en caliente · 0–10080 · por defecto **1**

Espera entre el cierre de un ciclo y la apertura del siguiente. Sin espera, el bot vuelve a abrir la base
inmediatamente, a veces en mitad del mismo impulso que acaba de darle el beneficio.

**Consejo**: viene con 1 minuto. Súbelo si quieres evitar encadenar ciclos dentro de la misma vela; se
puede cambiar en caliente y se aplica al cerrar el siguiente ciclo.

### 6.5 Exchange

#### Apalancamiento · `leverage` · 🌤️ en tibio · 1–50 · por defecto **2** · ⚠️ campo de riesgo

Aquí pesa el doble que en otras estrategias: además de multiplicar pérdidas, acerca la liquidación y por
tanto **acorta cuánta escalera cabe**. La app recorre la escalera nivel a nivel y rechaza la configuración
en aislado si la liquidación de la media llega antes que alguna seguridad. Y como el take profit y el stop
van en % del margen, con más apalancamiento el mismo % queda más cerca en precio. El techo real lo ponen
el par y la regla del 5 % ([riesgo §4](./riesgo-y-liquidacion.md#4-el-semáforo-y-la-regla-del-5-)): con el
mantenimiento del 2,5 % de ETH en Lighter, 13×. Con la posición abierta no se puede cambiar (la API
responde 409, `LEVERAGE_WITH_POSITION`): movería el objetivo, el stop y la liquidación de lo ya abierto.

**Consejo**: con las escalas de la configuración A, a 2× cabe una escalera de hasta un 66 % de caída; a
5×, de un 30 % (regla 2). Baja el apalancamiento antes que acortar la escalera.

#### Modo de margen · `marginMode` · ❄️ en frío · por defecto **Aislado**

Aislado: lo máximo que pierde este bot es su margen. Cruzado: liquidación más lejos, riesgo compartido; y
si la liquidación llega antes que una seguridad, la app solo avisa, porque la real queda más lejos.
**Consejo**: **Aislado**. Una martingala es la última estrategia con la que quieres arrastrar el saldo de
los demás bots.

---

## 7. Resumen de valores de fábrica

| Campo | Por defecto | ¿Lo cambio? |
|---|---|---|
| Dirección | Largo | Según tu tesis |
| Apalancamiento | 2× | ✅ Déjalo, o 1× |
| Modo de margen | Aislado | ✅ Déjalo |
| Nº de órdenes de seguridad | 6 | Según cobertura deseada |
| Separación inicial | 1 % | 🟡 2-3 % en BTC/ETH, 3-5 % en altcoins |
| Escala de distancia | 1,2 | ✅ Déjalo o 1,3 |
| Escala de volumen | 1,6 | ✅ Déjalo; no pases de 2 |
| Take profit | 2 % del margen (1 % del precio a 2×) | ✅ Déjalo |
| Seguir al máximo (trailing) | Apagado | 🟡 Enciéndelo solo si esperas un movimiento grande |
| Retroceso para salir | 1 % | 🟡 Mídelo contra lo que respira tu par |
| Umbral para mover el disparador | 20 bps | ✅ Déjalo; súbelo en Lighter |
| Tipo de orden base | A mercado | ✅ Déjalo; «Límite» si quieres ahorrar taker |
| Modo de take profit | Límite | ✅ Déjalo; «A mercado» si quieres garantizar el cierre |
| Espera entre ciclos | 1 min | 🟡 Súbelo si encadena ciclos (en caliente) |
| Al acercarse la liquidación | Solo avisar | 🟡 «Cerrar todo» a 2× o más |

Con la escalera de fábrica (6 · 1 % · 1,2 · 1,6) la cobertura es `1 + 1,2 + 1,44 + 1,73 + 2,07 + 2,49 =
9,9 %`: a 2× la app **avisa** («La escalera solo cubre un 9.9 % de caída. Más allá el bot deja de
promediar.») porque no llega a la mitad de la distancia a la liquidación (un 48,7 % a 2× con el
mantenimiento del 2,5 %). Es una escalera corta, pensada para ruido, no para una corrección seria.

---

## 8. ¿Esta u otra?

| | **Martingala** | [GridMart](./gridmart.md) | [DCA temporizado](./tdca.md) |
|---|---|---|---|
| Entradas | Escalera colgada; entran al tocar el precio | La misma escalera | Por reloj, a mercado |
| Salida | Una, sobre el total | El satélite por un TP corto; el núcleo por una rejilla de ventas con recompras | Una, sobre el total |
| Mientras espera el rebote | La posición está quieta | La posición **trabaja** (vende y recompra trozos del núcleo) | Quieta |
| Complejidad | Media | La más alta de todas | La más baja |
| Peor caso | `capital × apalancamiento` | Igual | `importe × compras × apalancamiento` |

**Elige la martingala si**: quieres cerrar ciclos con rebotes pequeños y aceptas el peor caso completo.
**Elige GridMart si**: además quieres que la posición cobre el vaivén mientras espera, y ya entiendes la
martingala. **Elige el DCA si**: prefieres ritmo lento, pocos parámetros y 1×.
