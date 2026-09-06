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
apalancamiento**, y aparece en la vista previa antes de crear el bot. Léelo.

Con **apalancamiento**, la escalera y la liquidación tiran en la misma dirección: la app **rechaza** la
configuración si la escalera cubre más recorrido que la distancia a tu liquidación, porque los últimos
escalones jamás se ejecutarían.

### Vocabulario mínimo

| Palabra | Qué significa aquí |
|---|---|
| **Entrada base** (`BASE#0`) | La primera orden del ciclo. Por defecto a mercado: el ciclo empieza ya. |
| **Seguridad** (`SAFETY#i`) | Cada orden colgada por debajo de la base, post-only, esperando la caída. |
| **Separación inicial** | Distancia de la base a la primera seguridad, en %. |
| **Escala de distancia** | Cada hueco entre seguridades es este múltiplo del anterior. Decide la **cobertura**. |
| **Escala de volumen** | Cada seguridad pide este múltiplo de capital respecto de la anterior. Es lo que hace de esto una martingala. |
| **Cobertura** | Cuánta caída aguanta la escalera antes de quedarse sin órdenes: `sep × (1 + d + d² + … + dⁿ⁻¹)`. |
| **Ancla** | El precio de la entrada base. Toda la escalera cuelga de él, **no del precio actual**. |
| **Take profit** | La orden de cierre, sobre el total, al `precio medio × (1 + objetivo)`. Se recoloca con cada seguridad ejecutada. |
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
  exposición**, la escalera **se corta** en el escalón cuyo notional proyectado lo superaría (aquí el tope
  sí funciona: es proyectado, no a posteriori).
- Desea la **salida**: una orden **LIMIT reduce-only** sobre toda la posición al `media real × (1 +
  objetivo / 100)`. La media es la que reporta el exchange, así que al llenarse una seguridad la salida se
  recoloca sola en la siguiente revisión.
- Nota: `Ciclo abierto: 4 seguridades pendientes.`

### Paso 4 — Cierre y espera

Cuando la salida se ejecuta, el ciclo se cierra con su PnL (`CYCLE_CLOSED`), y si `Espera entre ciclos`
es mayor que cero, el bot espera (`En cooldown, 43 s para el próximo ciclo.`) antes de abrir la siguiente
entrada base.

### Paso 5 — Guardas

El motor añade el **stop-loss** (condicional nativa sobre la media) si lo configuraste, y evalúa las
[guardas de riesgo](./riesgo-y-liquidacion.md#6-las-guardas-del-motor-revisión-a-revisión). La propia
estrategia valida al crear el bot: rechaza si la **cobertura ≥ 100 / apalancamiento** (la escalera llega
más allá de la liquidación), avisa si la cobertura es menor que la mitad de esa distancia, y avisa si la
escala de volumen pasa de 2,5.

---

## 3. Cómo configurarlo con poco riesgo

### Las seis reglas de oro

1. **Mira el último escalón antes que el primero.** Es el más grande y el que se ejecuta cuando la caída ya
   es grave. Si su tamaño te asusta, baja la escala de volumen, no el número de seguridades.
2. **1× o 2×.** A 2× cabe una escalera de hasta un 50 % de caída; a 5× solo un 20 %. Baja el
   apalancamiento antes que acortar la escalera.
3. **Cobertura con holgura frente a la liquidación.** La app compara la cobertura con la distancia a la
   liquidación **del mercado** (`100 / apalancamiento − mantenimiento`); deja igualmente unos puntos de
   holgura: a 2× en BTC, cobertura ≤ 45 %.
4. **Take profit «Límite», salvo que quieras garantizar el cierre.** «A mercado» espera al objetivo como
   orden condicional y cruza el libro al tocarlo: cierra seguro, pero paga taker y algo de deslizamiento.
5. **El take profit tiene que pagar la ida y vuelta.** Entrada a mercado (taker) + salida maker: por debajo
   del 0,3 % un ciclo cerrado puede acabar en pérdida. El mínimo del formulario (0,05 %) no es un buen valor.
6. **El stop-loss, por debajo del último escalón.** Por encima, cierra el ciclo antes de haber terminado de
   promediar.

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
| Take profit | **1,2 %** | |
| Tipo de orden base / Modo de take profit | A mercado / **Límite** | |
| Espera entre ciclos | 1 min | |

**Qué hace esto.** La escalera, con sus tamaños (notional a 2×):

| Nivel | Precio | Caída acumulada | Notional | Margen |
|---|---|---|---|---|
| Base | 2.503,35 | — | 18,52 | 9,26 |
| S1 | 2.428,24 | 3,0 % | 29,62 | 14,81 |
| S2 | 2.330,61 | 6,9 % | 47,54 | 23,77 |
| S3 | 2.203,69 | 12,0 % | 76,03 | 38,02 |
| S4 | 2.038,70 | 18,6 % | 121,71 | 60,86 |
| S5 | 1.824,20 | 27,1 % | 194,64 | 97,32 |
| S6 | 1.545,36 | **38,3 %** | 311,54 | 155,77 |

La escalera cubre un **38,3 %** de caída; a 2× la liquidación estimada llega sobre el 47,5 %, así que se
agota antes de que el exchange cierre. La base mueve 18,5 USDC y el último escalón **311,5**: diecisiete
veces más. Si ETH cae a 1.900 (cinco seguridades dentro) la media ronda 2.010 y basta un rebote del 1,2 %
sobre ella para cerrar el ciclo completo.

**Peor caso (vista previa).** Notional **799,62 USDC**, margen **400,00**, media **1.807,05**, take profit
en **1.828,73**, liquidación estimada **948,70** (−62,1 % desde el precio actual; −47,5 % desde la media).

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
| Take profit | **1 %** | |
| Tope de exposición | **2.400 USDC** | 267 % |

**Qué hace esto.** Escalones en 77.332, 75.359, 72.893, 69.811, 65.958 y 61.141: cobertura del **22,5 %**
frente a un 33,3 % de distancia a la liquidación a 3×. Tamaños: 112,8 · 157,8 · 221,6 · 310,5 · 434,2 ·
608,1 · 851,7 USDC. La escala de volumen baja (1,4) hace que el último escalón no sea desproporcionado
frente al primero: se promedia más despacio a cambio de un peor caso más plano.

El **Tope de exposición** aquí sí trabaja: tras el quinto escalón la posición proyectada suma 1.845 USDC;
el sexto (851,7) la llevaría a 2.697, por encima de 2.400, así que **no se tiende**. La app lo avisa al
crear: «El tope (2400.00) es menor que el notional del bot (2700.00): no llegará a tender la escalera
completa». Es deliberado: el tope recorta el escalón que más asusta.

**Peor caso (vista previa, sin contar el tope).** Notional **2.696,73**, margen **900,00**, media
**67.350,9**, take profit **68.024,4**, liquidación estimada **46.584** (−41,0 %). Con el tope, el máximo
real son ≈ 1.845 USDC de notional y 615 de margen.

### Configuración C — «DOGE agresivo, al filo de la escalera»

| Campo | Valor | % del capital |
|---|---|---|
| Par | DOGE/USDT (Aster) · **0,09209 USDT** | |
| Apalancamiento | **2×** | |
| Capital asignado | **300 USDT** | 100 % |
| Órdenes de seguridad | **5** | |
| Separación inicial | **5 %** | |
| Escala de distancia | **1,3** | |
| Escala de volumen | **1,5** | |
| Take profit | **3 %** | |

**Qué hace esto.** Escalones en 0,08748, 0,08149, 0,07371, 0,06360 y 0,05045: la escalera cubre un
**45,2 %**, y a 2× la liquidación está sobre el 50 %: se agota justo antes, que es lo más lejos que la
app deja llegar sin rechazar la configuración (y menos holgura de la que recomienda la regla 3). La base
mueve 313 DOGE (28,8 USDT) y el último escalón 4.345 DOGE (**219 USDT**): más de un tercio del capital
vive en ese único nivel. En Aster el paso de cantidad es 1 DOGE y el mínimo 5 USDT.

**Peor caso (vista previa).** Notional **599,80**, margen **300,00**, media **0,06268**, take profit
**0,06456**, liquidación estimada **0,03197** (−65,3 %).

### Checklist antes de arrancar

- [ ] ¿He mirado el tamaño del **último** escalón y lo acepto?
- [ ] ¿Cobertura ≤ `100 / apalancamiento − 5`? (a 2×, ≤ 45 %)
- [ ] ¿Apalancamiento 1× o 2×?
- [ ] ¿Modo de take profit en **Límite**?
- [ ] ¿Take profit ≥ 0,5 %?
- [ ] ¿La entrada base y la primera seguridad superan 20 USDC?
- [ ] ¿Stop loss por debajo del último escalón (o peor caso aceptado)?
- [ ] ¿`Espera entre ciclos` con algún minuto, para no reentrar en el mismo impulso?
- [ ] ¿No es Lighter? (o acepto que sus ejecuciones lleguen por sondeo, hasta 12 s tarde)

### Señales de alarma cuando ya está funcionando

| Lo que ves | Qué significa | Qué hacer |
|---|---|---|
| `Ciclo abierto: 0 seguridades pendientes` y el precio sigue bajando | Escalera agotada | Decide: esperar (con stop), aportar margen, cerrar |
| Muchos `CYCLE_CLOSED` con PnL ≈ 0 en pocos minutos | El take profit no cubre comisiones | Súbelo |
| `Abriendo ciclo.` durante mucho rato sin `FILL` | La base es «Límite» y el precio se ha ido; se recoloca cada cinco minutos | Espera, pon «A mercado» o revisa el venue |
| `ADD_SAFETY_SKIPPED` tras «Adelantar seguridad» | El exchange no aceptó la seguridad manual | Mira el evento anterior y repite si procede |
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

Confirmadas en `specs/001-revision-integral/findings.md`, abiertas a 2026-09-06.

> ⚠️ **Limitación conocida (F-94, decide el usuario).** El mínimo de `takeProfitPct` (0,05 %) está por
> debajo de una ida y vuelta maker+taker; el **funding** de una escalera agotada esperando días no aparece
> en ninguna pantalla (riesgo §9).

---

## 6. Parámetros configurables, uno a uno

🔥 en caliente · 🌤️ en tibio (cancela y recoloca las órdenes; la posición sigue; pide confirmación) ·
❄️ en frío (hay que crear otro bot).

### 6.1 Configuración básica

#### Conexión de exchange · `exchangeAccountId` · ❄️ en frío

La cuenta con la que opera (real, pruebas o simulación). **Consejo**: empieza en «Simulación».

#### Par · `symbol` · ❄️ en frío

Fija el mínimo de orden, el paso de cantidad y el apalancamiento máximo. En pares baratos (DOGE) el paso
de cantidad es 1 moneda.

#### Dirección · `direction` · ❄️ en frío · por defecto **Largo**

En corto la escalera se cuelga **por encima** del precio (vende más cuanto más sube) y la salida es una
recompra por debajo de la media.

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

#### Separación inicial (%) · `initialSeparationPct` · 🌤️ en tibio · 0,05–20 · por defecto **1**

A qué distancia de la base se cuelga la **primera** seguridad. Separaciones cortas gastan munición en
ruido; largas guardan la munición para una caída de verdad pero tardan más en bajar la media.

**Consejo**: en un par volátil como DOGE, un 1 % se toca varias veces al día; en BTC es una caída seria.

#### Escala de distancia · `stepScale` · 🌤️ en tibio · 1–3 · por defecto **1,2**

Cuánto se aleja cada seguridad respecto de la anterior. Con 1 todas van a la misma distancia; con 1,5
cada hueco es un 50 % más ancho. Decide la **cobertura** total sin añadir órdenes.

**Consejo**: la app rechaza la configuración si la cobertura llega a `100 / apalancamiento`: a 5×, un 20 %.

#### Escala de volumen · `volumeScale` · 🌤️ en tibio · 1–5 · por defecto **1,6** · ⚠️ campo de riesgo

Cuánto crece cada seguridad respecto de la anterior. Con 2, cada una compra el doble que la de antes. Es
el parámetro que hace de esto una martingala: baja la media mucho más rápido, pero concentra casi todo el
capital en los últimos escalones.

**Consejo**: por encima de 2,5 la app avisa. El reparto es proporcional al capital, así que subirlo no
gasta más dinero: mueve el que hay hacia el final de la escalera.

#### Take profit (%) · `takeProfitPct` · 🔥 en caliente · 0,05–50 · por defecto **1**

Beneficio sobre el precio medio al que se cierra la posición entera. Se recalcula con cada seguridad
ejecutada. **Consejo**: con una entrada taker y una salida maker, por debajo del 0,3 % un ciclo cerrado
puede acabar en pérdida.

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
notional proyectado lo alcanza. Útil como segundo techo por si te equivocas con la escala de volumen.

**Consejo**: mira el peor caso de la vista previa para elegir la cifra; en la configuración B recorta el
último escalón.

#### Stop loss (%) · `stopLossPct` · 🔥 en caliente · 0,1–90 · ⚠️ campo de riesgo

Pérdida sobre la media a la que el motor cierra la posición con una orden condicional nativa
([riesgo §7](./riesgo-y-liquidacion.md#7-el-stop-loss)). Es la única salida ordenada cuando la escalera
se agota y el precio sigue bajando.

**Consejo**: **por debajo del último escalón**. Por encima, cierra el ciclo antes de terminar de promediar.

#### Pérdida diaria máxima (%) · `maxDailyLossPct` · 🔥 en caliente · 0,1–100

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
tanto **acorta cuánta escalera cabe**. La app rechaza la configuración si la escalera cubre más recorrido
que la distancia a la liquidación.

**Consejo**: a 2× cabe una escalera de hasta un 50 % de caída; a 5×, solo un 20 %.

#### Modo de margen · `marginMode` · ❄️ en frío · por defecto **Aislado**

Aislado: lo máximo que pierde este bot es su margen. Cruzado: liquidación más lejos, riesgo compartido.
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
| Take profit | 1 % | ✅ Déjalo |
| Tipo de orden base | A mercado | ✅ Déjalo; «Límite» si quieres ahorrar taker |
| Modo de take profit | Límite | ✅ Déjalo; «A mercado» si quieres garantizar el cierre |
| Espera entre ciclos | 1 min | 🟡 Súbelo si encadena ciclos (en caliente) |
| Al acercarse la liquidación | Solo avisar | 🟡 «Cerrar todo» a 2× o más |

Con la escalera de fábrica (6 · 1 % · 1,2 · 1,6) la cobertura es `1 + 1,2 + 1,44 + 1,73 + 2,07 + 2,49 =
9,9 %`: a 2× la app **avisa** de que cubre menos de la mitad de la distancia a la liquidación. Es una
escalera corta, pensada para ruido, no para una corrección seria.

---

## 8. ¿Esta u otra?

| | **Martingala** | [GridMart](./gridmart.md) | [DCA temporizado](./tdca.md) |
|---|---|---|---|
| Entradas | Escalera colgada; entran al tocar el precio | La misma escalera | Por reloj, a mercado |
| Salida | Una, sobre el total | El satélite por un TP corto; el núcleo por una rejilla de ventas con recompras | Una, sobre el total |
| Mientras espera el rebote | La posición está quieta | La posición **trabaja** (vende y recompra trozos del núcleo) | Quieta |
| Complejidad | Media | La más alta de las siete | La más baja |
| Peor caso | `capital × apalancamiento` | Igual | `importe × compras × apalancamiento` |

**Elige la martingala si**: quieres cerrar ciclos con rebotes pequeños y aceptas el peor caso completo.
**Elige GridMart si**: además quieres que la posición cobre el vaivén mientras espera, y ya entiendes la
martingala. **Elige el DCA si**: prefieres ritmo lento, pocos parámetros y 1×.
