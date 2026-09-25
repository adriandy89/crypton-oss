# DCA temporizado (TDCA) — guía completa

> Estrategia `TDCA` · riesgo **MEDIO**.
> Código: [`tdca.ts`](../packages/strategy-core/src/strategies/tdca.ts) · guía in-app en [`tdca.guide.ts`](../apps/app/src/app/core/content/tdca.guide.ts).
> Conviene haber leído [riesgo y liquidación](./riesgo-y-liquidacion.md) y [buenas prácticas](./buenas-practicas.md).

---

## 1. Qué es esto, en cristiano

Es el DCA de toda la vida —comprar un importe fijo cada cierto tiempo— con una condición añadida:
**no compra por comprar, compra cuando la compra te sale mejor que lo que ya tienes**. Cada X minutos el
bot mira si toca comprar; si el precio mejora tu precio medio en lo que le exijas, si quedan compras en
el cupo, si ha pasado el intervalo y si la posición no ha tocado su tope, compra **a mercado** el importe
que le dijiste. Cada compra baja tu precio medio. Mientras haya posición mantiene viva **una orden de
cierre sobre el total**, a la distancia de la media que da el objetivo de beneficio. Cuando esa orden se
ejecuta, el ciclo termina y vuelve a empezar de cero.

El objetivo (y el stop, si lo pones) es un **% de tu margen**, como el TP/SL por ROI de un exchange; la
mejora que se exige a cada compra es un **% del precio**. A 1×, el apalancamiento de fábrica, un % del
margen es el mismo % del precio; a 3×, un take profit del 1,5 % del margen es un 0,5 % del precio.

Es la única que **opera por reloj**, no por movimiento de precio, y su comportamiento es fácil de
predecir.

### El riesgo, dicho claro

El par **cae y sigue cayendo**. Cada intervalo compras más barato, la posición crece y la media baja, pero
más despacio que el precio: el take profit, anclado a una media que se queda atrás, se aleja cada vez más
del precio. Y el cupo se gasta antes de lo que parece: lo que limita las compras es el intervalo, no la
profundidad de la caída (§3, configuración A). Cuando el cupo se agota, el bot deja de comprar y se
limita a esperar. Si además pusiste apalancamiento, promediar a la baja y apalancarse es la combinación
que más cerca deja la liquidación; la app avisa por encima de 3×.

Y un riesgo que ninguna pantalla enseña: un DCA que dura **días** paga **funding** todo ese tiempo
([riesgo §9](./riesgo-y-liquidacion.md#9-lo-que-ninguna-pantalla-te-enseña-el-funding)).

### Vocabulario mínimo

| Palabra | Qué significa aquí |
|---|---|
| **Compra** (entrada) | Cada orden a mercado del importe fijo. La primera es la `BASE#0`; las siguientes, `SAFETY#1`, `SAFETY#2`… |
| **Cupo** | «Compras máximas por ciclo». Agotado, el bot solo espera al objetivo. |
| **Intervalo** | Tiempo mínimo entre dos compras. Se cuenta siempre: es un freno, no un disparador. |
| **Media** | Tu precio medio de entrada, tal como lo reporta el exchange. |
| **Mejora mínima sobre la media** | Cuánto tiene que mejorar el precio tu media —estar por debajo en largo, por encima en corto— para que la compra cuente. Es un % del precio. |
| **Take profit** | La orden de cierre, limitada y reduce-only, sobre el total de la posición. Va en % de tu margen y se recoloca sola cada vez que cambia la media. |
| **Ciclo** | De la primera compra al cierre por take profit. Al cerrar, el cupo se resetea. |

---

## 2. Cómo funciona por dentro, paso a paso

El motor revisa el bot **cada 15 segundos**; una ejecución dispara una revisión inmediata.

### Paso 1 — La salida, siempre viva

Si hay posición, el bot desea una orden **LIMIT reduce-only** sobre **toda** la posición al precio
`media × (1 + take profit / (100 × apalancamiento))` (en corto, restando): el take profit es un % del
margen, y dividirlo por el apalancamiento da lo que tiene que moverse el precio. Cada compra cambia la
media, así que la orden se recoloca sola en la siguiente revisión. Mientras haya posición, la salida
está en el libro.

Con **Seguir al máximo** encendido esto cambia: el take profit pasa a ser el punto de **activación**, por
debajo de él **no hay orden de beneficio** —solo el stop loss— y a partir de él la salida es un disparador
que sube con el máximo y nunca baja. Ver **Seguir al máximo** en el apartado 6.1.

### Paso 2 — ¿Toca comprar? Cinco condiciones, todas a la vez

El bot solo compra si **ninguna** de estas lo bloquea; la nota del bot enumera las que bloquean:

| Condición | Bloqueo (texto de la nota) |
|---|---|
| Quedan compras en el cupo | `límite de N compras alcanzado` |
| Ha pasado el intervalo desde la última compra | `faltan 812 s para la siguiente compra` |
| Con «Comprar solo si mejora la media»: `precio ≤ media × (1 − mejora mínima / 100)` | `el precio no mejora la media en la mejora mínima exigida` |
| Ha pasado la espera entre ciclos, si la configuraste | `espera entre ciclos: faltan N s` |
| La posición no ha alcanzado su tope: «Notional máximo de la posición» o «Tope de exposición», el menor | `tope de posición alcanzado` |

La **primera compra** de un ciclo no tiene media con la que compararse: entra en cuanto arranca el bot
(o pasa la **espera entre ciclos**, si la configuraste).

### Paso 3 — La compra

A **mercado**, por `importe × apalancamiento / precio` unidades; si la compra entera no cabe bajo el tope
de la posición, compra lo que quepa. Va por la vía «inmediata» del motor: se manda una vez y no se
reconcilia (una orden a mercado o se ejecuta o no existe). El identificador de la orden es el número de
compra (`BASE#0`, `SAFETY#3`), así que dos revisiones seguidas no la duplican.

> Comprar a mercado significa **comisión de taker** en cada entrada. La salida, limitada, paga maker (con
> «Seguir al máximo» es un disparador a mercado, y paga taker también). En Hyperliquid, en el tramo
> básico, eso son un 0,045 % y un 0,015 % del precio
> ([`costes.ts`](../packages/strategy-core/src/canal/costes.ts)): el take profit, **en precio**, tiene que
> cubrirlo con holgura. A 1× es el número que pones; a 3×, un tercio.

### Paso 4 — Cierre y nuevo ciclo

Cuando el take profit se ejecuta, el ciclo se cierra con su PnL (`CYCLE_CLOSED`), el cupo vuelve a cero y
el bot empieza otro ciclo con la siguiente compra.

### Paso 5 — Guardas

El motor añade el **stop-loss** si lo configuraste: una condicional nativa a
`media × (1 − stop / (100 × apalancamiento))` (en corto, sumando), que se recoloca cuando una compra
cambia la media. Y evalúa las
[guardas de riesgo](./riesgo-y-liquidacion.md#6-las-guardas-del-motor-revisión-a-revisión) antes de
planificar.

### Lo que enseña la vista previa

La vista previa proyecta cada compra **en cuanto el precio mejora la media de lo ya comprado en la mejora
mínima**, que es la condición exacta del motor. Como la media sigue al precio hacia abajo, la escalera
proyectada es corta: con 20 compras y una mejora del 0,5 %, la vigésima queda solo un **1,77 %** por
debajo de la primera y la media, un 1,30 %. No es una predicción. Es la **media más alta** con la que
puede acabar el ciclo si se hacen todas las compras —en una caída más honda entran más abajo y la media
sale mejor—, y dice lo poco que le basta al bot para gastar el cupo si la bajada dura lo bastante.

Hasta el spec 080 se proyectaba cada compra contra la **anterior** y no contra la media: la vigésima caía
un 9,1 % y la escalera enseñada era más honda que la real (079/F-12).

Debajo, la Revisión enseña la posición como la confirmación de un exchange: entrada media, tamaño
(cantidad y notional) y margen, y sus salidas —take profit, stop si lo pusiste y liquidación si la hay—
con el precio en la retícula, el movimiento del precio desde la media y desde el último precio, el
resultado en USDC **sin comisiones** y el % sobre el margen. Con «Seguir al máximo» encendido el take
profit sale como «Objetivo · empieza a seguir»: es la activación, no el precio al que sale. Y si el stop o
la liquidación llegan antes que alguna compra, lo dice y corta ahí el recorrido.

---

## 3. Cómo configurarlo con poco riesgo

### Las cinco reglas de oro

1. **`importe × compras máximas` es tu peor caso en margen.** La app no te deja crear el bot si supera
   el capital asignado. Ponlo consciente de que puede llegar entero, y antes de lo que crees: el cupo lo
   gasta el reloj, no la profundidad.
2. **1×.** Es el valor por defecto de esta estrategia y por algo: promediar a la baja con apalancamiento es
   la receta para acercar la liquidación. La app avisa por encima de 3×. Y a 1× el take profit y el stop,
   que van en % del margen, son el mismo % del precio.
3. **El take profit, en precio, tiene que pagar taker + maker.** Por debajo del 0,3 % del precio un ciclo
   cerrado puede acabar en pérdida (0,05 % del margen es el mínimo del formulario; no es un buen valor). A
   3×, el 1,5 % de fábrica ya es solo un 0,5 % del precio.
4. **El intervalo decide el ritmo, la mejora mínima decide el filtro.** Intervalos cortos reaccionan a una
   caída del mismo día; mejoras altas reparten el cupo en más recorrido: con 20 compras, la vista previa
   las gasta en una bajada del 1,77 % al 0,5 %, del 3,51 % al 1 % y del 6,95 % al 2 %. Combínalos con la
   volatilidad del par.
5. **Pon «Notional máximo de la posición».** Es el tope propio de esta estrategia. «Tope de exposición»
   también se lee, como segundo tope, y manda el menor de los dos (§4).

### Configuración A — «Acumular BTC con paciencia»

Precios del 24-08-2026 (`venue-markets.ts`), Lighter, BTC a **78.910,1 USDC**.

| Campo | Valor | % del capital |
|---|---|---|
| Par | BTC/USDC (Lighter) | |
| Apalancamiento | **1×** | |
| Capital asignado | **500 USDC** | 100 % |
| Importe por compra | **25 USDC** | 5 % |
| Intervalo | **240 min** (4 h) | |
| Compras máximas por ciclo | **20** | |
| Comprar solo si mejora la media | Sí | |
| Mejora mínima sobre la media (del precio) | **0,5 %** | |
| Take profit (sobre el margen) | **1,5 %** (a 1×, un 1,5 % del precio) | |

**Qué hace esto.** Como máximo compromete `25 × 20 = 500 USDC`, justo el capital. La primera compra entra
al precio que haya (0,00031 BTC, 24,46 USDC: por encima del mínimo de 10 USDC y de 0,0001 BTC). Después
solo compra si BTC está al menos un 0,5 % por debajo de la media **y** han pasado 4 horas. Lo que limita
las compras es **el reloj, no la profundidad**: como la media sigue al precio hacia abajo, una bajada lenta
de solo un 1,77 % basta para gastar las veinte. Lo que no pueden es entrar en menos de **76 horas** (19
intervalos: la primera no espera). El bot cierra entero cuando BTC recupere un 1,5 % sobre la media
resultante.

**Peor caso (vista previa).** 20 compras proyectadas de 78.910,1 a 77.517,3: 0,00636 BTC, **495,35 USDC**
de notional, **495,35** de margen (a 1× son lo mismo: de los 500 del capital, el redondeo de cada
compra al paso del par deja 4,65 sin usar), media **77.885,1** y take profit en **79.053,4** (+1,50 % de precio,
+7,43 USDC, +1,50 % del margen), un 0,18 % por encima del precio de hoy. A 1× en largo no hay liquidación:
la fórmula exacta la pone en cero.

### Configuración B — «Cazar caídas rápidas en ETH»

| Campo | Valor | % del capital |
|---|---|---|
| Par | ETH/USDC (Hyperliquid) · **2.503,3 USDC** | |
| Apalancamiento | 1× | |
| Capital asignado | **600 USDC** | 100 % |
| Importe por compra | **40 USDC** | 6,7 % |
| Intervalo | **30 min** | |
| Compras máximas por ciclo | **15** | |
| Mejora mínima sobre la media (del precio) | **1,2 %** | |
| Take profit (sobre el margen) | **2 %** | |
| Notional máximo de la posición | **650 USDC** | 108 % |

**Qué hace esto.** El intervalo corto deja al bot reaccionar a un tramo de caída en el mismo día —pueden
entrar las quince en 7 horas—, y la mejora mínima del 1,2 % impide que gaste el cupo en ruido.
`40 × 15 = 600 USDC`, que cabe en el capital. El tope de 650 USDC no llega a morder con estas cifras: a 1×
la posición vale, como mucho, lo invertido más el 2 % del take profit, unos 610 USDC, antes de que el take
profit la cierre. Es el freno duro por si más adelante subes el importe o el apalancamiento.

**Peor caso (vista previa).** 15 compras de 2.503,3 a 2.406,6 (0,0159-0,0166 ETH cada una, entre 39,78 y
39,98 USDC): 0,2457 ETH, **597,99 USDC** de notional y otro tanto de margen, media **2.433,8**, take profit
en **2.482,6** (+2 %, +11,98 USDC), un 0,83 % por debajo del precio de hoy.

### Configuración C — «Comprar sin condiciones, a intervalo fijo»

El DCA clásico: desactivas la condición de la media y el bot compra cada día pase lo que pase.

| Campo | Valor | % del capital |
|---|---|---|
| Par | DOGE/USDT (Aster) · **0,09209 USDT** | |
| Apalancamiento | 1× | |
| Capital asignado | **300 USDT** | 100 % |
| Importe por compra | **15 USDT** | 5 % |
| Intervalo | **1440 min** (1 día) | |
| Compras máximas por ciclo | **20** | |
| Comprar solo si mejora la media | **No** | |
| Take profit (sobre el margen) | **5 %** | |

**Qué hace esto.** Suba o baje DOGE, entran 15 USDT diarios durante veinte días (al precio de hoy, 162
DOGE, 14,92 USDT: en Aster el paso de cantidad es 1 DOGE y el mínimo 5 USDT). A cambio, tu media puede
**empeorar** si el par sube, y el objetivo del 5 % tarda más en llegar.

La vista previa sigue proyectando las compras con la mejora mínima de fábrica del 0,5 % (es la cota que
dibuja, no lo que hará este bot), y el formulario avisa de que ese campo no se usa: **299,03 USDT** de
notional y otro tanto de margen, media **0,09089**, take profit en **0,09544**. Si pones la mejora mínima a 0
el aviso desaparece y la vista previa coloca las veinte compras al precio de hoy: media 0,09209 y take
profit en 0,09670.

### Checklist antes de arrancar

- [ ] ¿`importe × compras máximas` ≤ capital asignado? (la app lo exige)
- [ ] ¿Cada compra ≥ 20 USDC? (mínimo 10 en Lighter/HL, 5 en Aster; el paso de cantidad puede redondear)
- [ ] ¿Apalancamiento 1×, o como mucho 2×?
- [ ] ¿Take profit ≥ 0,5 % **del precio**? (dos comisiones, una de ellas taker; a 1× es el número que pones, a 2× la mitad)
- [ ] ¿«Notional máximo de la posición» puesto? (o «Tope de exposición»: manda el menor)
- [ ] ¿Intervalo acorde al horizonte? (con 20 compras el cupo dura como mínimo 19 intervalos: 9,5 h a 30 min, 76 h a 240 min, 19 días a 1440)
- [ ] ¿He mirado la financiación del par si el ciclo puede durar días?
- [ ] ¿Stop loss donde reconozco que la tesis falló, y en precio más lejos que la mejora mínima?

### Señales de alarma cuando ya está funcionando

| Lo que ves | Qué significa | Qué hacer |
|---|---|---|
| `Sin comprar: límite de 20 compras alcanzado` y el precio sigue bajando | Cupo agotado; el bot solo espera | Decide: esperar, cerrar, o aportar margen si aislado |
| `Sin comprar: el precio no mejora la media en la mejora mínima exigida` durante días | El par sube; la media no baja | Normal. Si quieres comprar igualmente, desactiva la condición |
| Ciclos cerrados con PnL ≈ 0 | Take profit que en precio no cubre taker + maker (a 3× o más, el mismo % del margen es muy poco precio) | Súbelo |
| El take profit «toca» y no cierra | Orden limitada que el precio rozó y se fue | Espera; si pasa mucho, «Tomar beneficio ya» (`TAKE_PROFIT_NOW`) cierra a mercado |
| `FILL` sin `FILL` de salida en muchos días | Posición larga abierta pagando funding | Mira la tasa de financiación en el venue |
| `LIQUIDATION_NEAR` | Estás apalancado y la caída es grande | Aporta margen o cierra parte; a 1× en largo no ocurre |

---

## 4. Lo que este bot NO mira (importante)

| Campo | Realidad |
|---|---|
| **Tope de exposición** (`maxNotionalCap`) | **Sí**, como segundo tope junto a **Notional máximo de la posición**: manda el menor de los dos. |
| **Espera entre ciclos** (`cooldownMinutes`) | **Sí.** Al cerrar un ciclo, la siguiente compra espera estos minutos; el «intervalo» sigue mandando entre compras dentro del ciclo. |
| **Capital asignado** (`totalInvestment`) | **No dimensiona las compras**: el tamaño lo da «Importe por compra». Se usa como techo declarado (la app exige `importe × compras ≤ capital`) y como denominador de la pérdida diaria y del kill-switch. |
| **Adelantar orden de seguridad** y **Recentrar la retícula** (comandos) | La app no los ofrece aquí: el DCA no tiene escalera colgada ni ancla. |

Sí funcionan: **Stop loss**, **Pérdida diaria máxima**, **Al acercarse la liquidación**, y las guardas de
la cuenta.

---

## 5. Limitaciones conocidas (hallazgos abiertos)

Confirmadas en `specs/001-revision-integral/findings.md`, abiertas a 2026-09-06.

> ⚠️ **Límite conocido (F-94, aceptado).** El intervalo se mide con el reloj del venue (hora de la
> ejecución) frente al reloj del motor; con deriva de reloj se acorta o alarga unos segundos. El
> **funding** de una posición de días no aparece en ninguna pantalla (riesgo §9).

---

## 6. Parámetros configurables, uno a uno

🔥 en caliente (siguiente revisión, sin tocar órdenes ni posición) · 🌤️ en tibio (cancela y recoloca
órdenes; la posición sigue) · ❄️ en frío (hay que crear otro bot). **Todos los campos propios del DCA
son en caliente.**

Los % **sobre el margen** —take profit y stop— tienen un máximo que escala con el apalancamiento `L`, para
que el tope en precio no cambie: 100 % del precio el take profit, 90 % el stop. A 1× los dos rangos
coinciden con el precio.

### 6.1 Configuración básica

#### Conexión de exchange · `exchangeAccountId` · ❄️ en frío

La cuenta con la que opera el bot (real, pruebas o simulación). **Consejo**: si es el primero, la cuenta
«Simulación».

#### Par · `symbol` · ❄️ en frío

Fija el mínimo de orden, el paso de cantidad, el apalancamiento máximo y el mantenimiento con el que se
calcula la liquidación. En pares baratos (DOGE) el paso de cantidad es 1 moneda: 15 USDT son 162 DOGE, no
162,9.

#### Dirección · `direction` · ❄️ en frío · por defecto **Largo**

En corto todo se invierte: vende a mercado cada intervalo si el precio **sube** por encima de la media en
la mejora mínima exigida, y la salida es una recompra por debajo de la media. Y en corto **sí** hay
liquidación a 1×: con BTC en Lighter (mantenimiento 2,5 %) la configuración A en corto la tendría un
95,12 % por encima de la media.

#### Capital asignado · `totalInvestment` · 🌤️ en tibio · mínimo 10 · ⚠️ campo de riesgo

El techo declarado del bot. **No dimensiona las compras** (eso lo hace el importe por compra), pero la app
rechaza el bot si `importe × compras máximas` lo supera, y es el denominador de la pérdida diaria.

#### Importe por compra · `amountPerBuy` · 🔥 en caliente · mínimo 1 · obligatorio

Cuánto **margen** se compromete en cada compra. Con apalancamiento, la posición que añade es este importe
multiplicado por el apalancamiento. Junto al número de compras define el techo real del bot.

**Consejo**: que no baje del mínimo del par con holgura (≥ 20 USDC). La app rechaza el bot si importe ×
compras máximas supera el capital asignado.

#### Intervalo (min) · `intervalMinutes` · 🔥 en caliente · 1–10080 · por defecto **60**

Cuánto tiene que pasar entre una compra y la siguiente. Es el ritmo del bot, y lo que de verdad limita
cuántas compras entran en una caída: intervalos cortos reaccionan a una caída del mismo día; largos
reparten las entradas a lo largo de semanas.

**Consejo**: el intervalo se cuenta siempre, también cuando el precio cumple: es un freno, no un disparador.

#### Compras máximas por ciclo · `maxBuysPerCycle` · 🔥 en caliente · 1–500 · por defecto **20** · ⚠️ campo de riesgo

Multiplicado por el importe por compra, es **exactamente** el dinero que este bot puede llegar a
comprometer. Agotado el cupo, deja de comprar y espera al objetivo.

**Consejo**: es el parámetro que convierte el DCA en algo acotado. Sin un número honesto aquí, el bot puede
seguir promediando indefinidamente.

#### Comprar solo si mejora la media · `buyOnlyIfImprovesAverage` · 🔥 en caliente · por defecto **Sí**

Activado, solo compra cuando el precio mejora tu precio medio actual —por debajo en largo, por encima en
corto—: tu media solo puede mejorar y el objetivo solo puede acercarse. Desactivado, es un DCA clásico que
compra a intervalo fijo pase lo que pase, y la media puede empeorar.

**Consejo**: activado por defecto, y es lo que distingue esta estrategia de una compra programada.

#### Mejora mínima sobre la media (del precio) · `marginBelowAveragePct` · 🔥 en caliente · 0–100 · por defecto **0,5**

Cuánto tiene que mejorar el precio tu media para que la compra cuente: estar por debajo en largo, por
encima en corto. Es un % del **precio**, así que no cambia con el apalancamiento. Con 0, cualquier precio
por debajo de la media vale. Subirlo exige caídas más serias y reparte el cupo en más recorrido: la
vista previa gasta veinte compras en una bajada del 1,77 % con un 0,5 %, del 3,51 % con un 1 % y del
6,95 % con un 2 %.

Hasta el spec 080 se llamaba «Margen bajo la media», y ese «margen» se confundía con el del
apalancamiento (079/F-18). La clave interna no ha cambiado.

**Consejo**: solo se aplica con la condición de la media activada; si la desactivas y lo dejas por encima
de 0, la app avisa de que no se usa. En pares volátiles, 1-2 % evita gastar el cupo en ruido.

#### Take profit (sobre el margen) · `takeProfitPct` · 🔥 en caliente · 0,05–100·L · por defecto **1,5**

Beneficio sobre tu margen al que se cierra la posición entera y termina el ciclo, medido desde el precio
medio: la orden va a `media × (1 + take profit / (100 × L))`. A 1× es el mismo % del precio; a 3×, un
1,5 % del margen es un 0,5 % del precio. La orden está siempre viva y se recalcula con cada compra. En
corto, un take profit que llevaría el precio a cero es un error: a 1×, el 100 %. Debajo del campo el
formulario enseña su equivalente en vivo; con la configuración A, «= 1,50 % de precio · 79.053,4
(+7,43 USDC) en el peor caso».

El valor de fábrica no cambió con el spec 080: a 1×, el apalancamiento de fábrica, el 1,5 % del precio de
antes es el 1,5 % del margen de ahora.

**Consejo**: las comisiones se pagan sobre el precio. Con una entrada taker y una salida maker, un
objetivo que en precio quede por debajo del 0,3 % puede cerrar el ciclo en pérdida. 1-2 % del precio es
razonable para un DCA.

#### Seguir al máximo (trailing) · `trailingTakeProfit` · 🔥 en caliente · por defecto **Apagado**

Convierte el take profit en un objetivo que **sigue al precio**. Al llegar al porcentaje que pediste el bot
no cierra: empieza a seguir al máximo y solo vende cuando el precio retrocede lo que digas.

Con él encendido, el **take profit deja de ser la salida y pasa a ser la activación**. Tu «15 %» sigue
donde estaba y significa otra cosa: el punto en el que empieza el seguimiento. La Revisión lo rotula así,
«Objetivo · empieza a seguir».

Las tres fases a 1×, con activación en el 15 % del margen (un 15 % del precio) y retroceso del 1 % del
precio, sobre una media de 100:

| Fase | Precio | Qué hace el bot |
|---|---|---|
| Antes de activar | 100 → 114 | **Nada**. No hay orden de beneficio en el libro; la única protección es tu stop loss, que sigue intacto |
| Se activa | 115 | Coloca un disparador en `115 × 0,99 = 113,85` |
| Sigue | 115 → 130 | Sube el disparador a `130 × 0,99 = 128,70`. **Nunca lo baja** |
| Cierra | 130 → 128,70 | Vende a mercado |

**El suelo de lo que cobras es `activación × (1 − retroceso)`**: aquí, **+13,85 %** del precio, que a 1×
es también el 13,85 % del margen. Con los valores de fábrica —take profit del 1,5 % a 1× y retroceso del
1 %— el suelo es solo un +0,485 % sobre la media, y la salida, que ahora es a mercado, paga taker. Y si
el retroceso se come la activación, la app avisa: con el 1,5 % de fábrica, un retroceso del 1,5 % o más
deja el suelo por debajo de tu media («lo mínimo que cobra queda por debajo del precio de entrada: la
operación puede cerrarse en pérdida nada más activarse»). Un trailing puede darte mucho más que un
objetivo fijo, y también un poco menos. Eso no es un fallo: es el peaje.

**No es una mejora gratis.** En marcos cortos **baja la tasa de acierto**, porque el retroceso normal de
una cripto —un 1-3 % al día sin cambiar de tendencia— lo dispara antes de tiempo. Funciona mejor cuando lo
que esperas es un movimiento grande, no ruido.

**Al encenderlo en un bot en marcha**: la orden de beneficio que hubiera en el libro se cancela en la
siguiente revisión, y si el precio todavía no ha llegado al objetivo **no se sustituye por nada** hasta que
llegue. Es lo correcto —no hay nada que asegurar por debajo del objetivo— pero conviene saberlo.

#### Retroceso para salir (del precio) · `trailingCallbackPct` · 🔥 en caliente · 0,1–10 · por defecto **1**

Cuánto tiene que caer el precio desde el máximo alcanzado para que el bot cierre, en % del **precio**: no
cambia con el apalancamiento. En corto es al revés: cuánto tiene que subir desde el mínimo.

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

### 6.2 Riesgo

#### Notional máximo de la posición · `maxPositionNotional` · 🔥 en caliente · opcional · ⚠️ campo de riesgo

Tope del valor de la posición. **Es el freno propio de esta estrategia**: alcanzado, el bot deja de comprar
aunque le quede cupo e intervalo cumplido, y si la compra entera no cabe, compra lo que quepa. La orden de
cierre sigue viva.

**Consejo**: ponlo un poco por encima de `importe × compras máximas × apalancamiento`.

#### Tope de exposición · `maxNotionalCap` · 🔥 en caliente · opcional

Segundo tope junto a «Notional máximo de la posición»: manda el menor de los dos. Déjalo vacío si el propio te basta.

#### Stop loss (sobre el margen) · `stopLossPct` · 🔥 en caliente · 0,1–90·L · ⚠️ campo de riesgo

Pérdida sobre tu margen, medida desde la media, a la que el motor cierra la posición con una orden
condicional nativa ([riesgo §7](./riesgo-y-liquidacion.md#7-el-stop-loss)): el disparo va a
`media × (1 − stop / (100 × L))` (en corto, sumando) y se recoloca cuando una compra cambia la media. A 1×
es el mismo % del precio. Vacío es «sin stop». Si el exchange tiene la posición a más apalancamiento que
la configuración, el stop se calcula con el del exchange —el más estrecho— y el bot avisa una vez
(`LEVERAGE_SKIPPED`).

Tiene que saltar antes que la liquidación: en margen aislado, un stop en la liquidación o detrás es un
error, y uno que la deje a menos de medio stop detrás, un aviso (en cruzado, los dos son avisos); el
formulario propone el más ancho válido. En un DCA tiene además una trampa propia: si en precio no queda
**más lejos que la mejora mínima**, salta antes de que llegue la segunda compra. Con la configuración A,
un stop del 0,5 % hace que la Revisión corte el recorrido antes de la segunda compra («El stop salta
antes que…»); con un 0,6 % caben las veinte.

Debajo del campo el formulario enseña su equivalente en vivo, y bajo el stop, si no cabe, el botón «Usar
el stop más ancho válido». Con la configuración A y un stop del 10 %: «= 10,00 % de precio · 70.096,6
(−49,53 USDC) en el peor caso», un 11,17 % por debajo del precio de hoy.

**Consejo**: donde reconocerías que la tesis falló; en un DCA de acumulación a 1× mucha gente lo deja vacío
a conciencia.

#### Pérdida diaria máxima (sobre el capital) · `maxDailyLossPct` · 🔥 en caliente · 0,1–100

Pérdida realizada hoy por este bot, en % de su **capital asignado** (no del margen de la posición), a partir
de la cual se pausa.

#### Al acercarse la liquidación · `liquidationAction` · 🔥 en caliente · por defecto **Solo avisar** · ⚠️ campo de riesgo

Solo avisar / Pausar el bot / Cerrar todo, cuando la distancia a la liquidación baja del umbral de aviso.
A 1× en largo no aplica: no hay liquidación.

### 6.3 Tiempos

#### Espera entre ciclos (min) · `cooldownMinutes` · 🔥 en caliente · 0–10080 · por defecto **0**

Tras cerrar un ciclo, la siguiente compra espera estos minutos. El «intervalo» sigue mandando entre compras
dentro del ciclo.

### 6.4 Exchange

#### Apalancamiento · `leverage` · 🌤️ en tibio · 1–50 · por defecto **1** · ⚠️ campo de riesgo

Multiplica ganancia y pérdida y acerca la liquidación. **Esta estrategia viene a 1×** y la app avisa por
encima de 3×: «TDCA promedia sin límite de recorrido: por encima de 3x el margen se agota rápido». También
cambia lo que significan en precio el take profit y el stop, que van en % del margen: a 3×, el take profit
de fábrica del 1,5 % es un 0,5 % del precio.

Con la posición abierta **no se puede cambiar**: la API responde 409 (`LEVERAGE_WITH_POSITION`), porque
movería en silencio el take profit, el stop y la liquidación de lo ya comprado. Se cambia sin posición.

#### Modo de margen · `marginMode` · ❄️ en frío · por defecto **Aislado**

Aislado: lo máximo que pierde este bot es su margen. Cruzado: liquidación más lejos, riesgo compartido con
los otros bots.

---

## 7. Resumen de valores de fábrica

| Campo | Por defecto | ¿Lo cambio? |
|---|---|---|
| Dirección | Largo | Según tu tesis |
| Apalancamiento | **1×** | ✅ Déjalo |
| Modo de margen | Aislado | ✅ Déjalo |
| Intervalo | 60 min | Según horizonte |
| Compras máximas por ciclo | 20 | Según capital: `importe × compras ≤ capital` |
| Comprar solo si mejora la media | Sí | ✅ Déjalo salvo DCA clásico |
| Mejora mínima sobre la media | 0,5 % del precio | 🟡 1-2 % en pares volátiles |
| Take profit | 1,5 % del margen (a 1×, del precio) | ✅ Razonable a 1× |
| Seguir al máximo (trailing) | Apagado | 🟡 Enciéndelo solo si esperas un movimiento grande |
| Retroceso para salir | 1 % del precio | 🟡 Mídelo contra lo que respira tu par |
| Umbral para mover el disparador | 20 bps | ✅ Déjalo; súbelo en Lighter |
| Notional máximo de la posición | vacío | 🔴 **Ponlo**: es el tope propio de la estrategia |
| Al acercarse la liquidación | Solo avisar | ✅ A 1× en largo no hay liquidación |
| Espera entre ciclos | 0 | ✅ Déjalo, o súbelo si no quieres que el ciclo siguiente empiece en el acto |

---

## 8. ¿Esta u otra?

| | **DCA temporizado** | [Martingala](./martingale.md) | [Rejilla clásica](./grid-classic.md) |
|---|---|---|---|
| Cuándo compra | Por **reloj**, si el precio mejora la media | Cuando el precio **toca** un escalón colgado | Cuando el precio toca una línea |
| Tamaño de cada compra | Fijo | Creciente (escala de volumen) | Fijo por línea |
| Cómo entra | A mercado (taker) | Post-only en los escalones (maker) | Post-only |
| Salida | Una sola, sobre el total | Una sola, sobre el total | Una por línea comprada |
| Peor caso | `importe × compras × apalancamiento` | `capital × apalancamiento`, concentrado en los últimos escalones | `capital × apalancamiento` |
| Apalancamiento por defecto | 1× | 2× | 2× |

**Elige el DCA si**: quieres acumular sin acertar el suelo, con pocos parámetros y a un ritmo lento.
**Elige la martingala si**: quieres que las entradas grandes ocurran en las caídas grandes y cerrar con un
rebote pequeño, aceptando su riesgo alto. **Elige la rejilla si**: el par va de lado y quieres cerrar
muchos ciclos pequeños.
