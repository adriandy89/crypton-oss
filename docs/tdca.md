# DCA temporizado (TDCA) — guía completa

> Estrategia `TDCA` · riesgo **MEDIO**.
> Código: [`tdca.ts`](../packages/strategy-core/src/strategies/tdca.ts) · guía in-app en [`tdca.guide.ts`](../apps/app/src/app/core/content/tdca.guide.ts).
> Conviene haber leído [riesgo y liquidación](./riesgo-y-liquidacion.md) y [buenas prácticas](./buenas-practicas.md).

---

## 1. Qué es esto, en cristiano

Es el DCA de toda la vida —comprar un importe fijo cada cierto tiempo— con una condición añadida:
**no compra por comprar, compra cuando la compra te sale mejor que lo que ya tienes**. Cada X minutos el
bot mira si toca comprar; si el precio está por debajo de tu precio medio (en el margen que le exijas), si
quedan compras en el cupo, si ha pasado el intervalo y si la posición no ha tocado su tope, compra **a
mercado** el importe que le dijiste. Cada compra baja tu precio medio. Mientras haya posición mantiene
viva **una orden de cierre sobre el total**, colocada al precio medio más el objetivo de beneficio. Cuando
esa orden se ejecuta, el ciclo termina y vuelve a empezar de cero.

Es la única que **opera por reloj**, no por movimiento de precio, y la que menos parámetros
tiene. Su comportamiento es fácil de predecir: es la más sana de las cinco que no son market makers.

### El riesgo, dicho claro

El par **cae y sigue cayendo**. Cada intervalo compras más barato, la posición crece, la media baja, pero
el objetivo se aleja porque hay que recuperar el 1,5 % **sobre una media que sigue bajando**. Cuando el
cupo se agota, el bot deja de comprar y se limita a esperar. Si además pusiste apalancamiento, promediar a
la baja y apalancarse es la combinación que más cerca deja la liquidación; la app avisa por encima de 3×.

Y un riesgo que ninguna pantalla enseña: un DCA que dura **días** paga **funding** todo ese tiempo
([riesgo §9](./riesgo-y-liquidacion.md#9-lo-que-ninguna-pantalla-te-enseña-el-funding)).

### Vocabulario mínimo

| Palabra | Qué significa aquí |
|---|---|
| **Compra** (entrada) | Cada orden a mercado del importe fijo. La primera es la `BASE#0`; las siguientes, `SAFETY#1`, `SAFETY#2`… |
| **Cupo** | «Compras máximas por ciclo». Agotado, el bot solo espera al objetivo. |
| **Intervalo** | Tiempo mínimo entre dos compras. Se cuenta siempre: es un freno, no un disparador. |
| **Media** | Tu precio medio de entrada, tal como lo reporta el exchange. |
| **Margen bajo la media** | Cuánto tiene que estar el precio por debajo de la media para que la compra cuente como mejora. |
| **Take profit** | La orden de cierre, limitada y reduce-only, sobre el total de la posición. Se recoloca sola cada vez que cambia la media. |
| **Ciclo** | De la primera compra al cierre por take profit. Al cerrar, el cupo se resetea. |

---

## 2. Cómo funciona por dentro, paso a paso

El motor revisa el bot **cada 15 segundos**; una ejecución dispara una revisión inmediata.

### Paso 1 — La salida, siempre viva

Si hay posición, el bot desea una orden **LIMIT reduce-only** sobre **toda** la posición al precio
`media × (1 + take profit / 100)` (en corto, restando). Cada compra cambia la media, así que la orden se
recoloca sola en la siguiente revisión. Mientras haya posición, la salida está en el libro.

Con **Seguir al máximo** encendido esto cambia: el take profit pasa a ser el punto de **activación**, por
debajo de él **no hay orden de beneficio** —solo el stop loss— y a partir de él la salida es un disparador
que sube con el máximo y nunca baja. Ver **Seguir al máximo** en el apartado 6.1.

### Paso 2 — ¿Toca comprar? Cuatro condiciones, todas a la vez

El bot solo compra si **ninguna** de estas lo bloquea; la nota del bot enumera las que bloquean:

| Condición | Bloqueo (texto de la nota) |
|---|---|
| Quedan compras en el cupo | `límite de N compras alcanzado` |
| Ha pasado el intervalo desde la última compra | `faltan 812 s para la siguiente compra` |
| Con «Comprar solo si mejora la media»: `precio ≤ media × (1 − margen / 100)` | `el precio no mejora el medio en el margen exigido` |
| La posición no ha alcanzado «Notional máximo de la posición» | `tope de posición alcanzado` |

La **primera compra** de un ciclo no tiene media con la que compararse: entra en cuanto arranca el bot
(o pasa la **espera entre ciclos**, si la configuraste).

### Paso 3 — La compra

A **mercado**, por `importe × apalancamiento / precio` unidades. Va por la vía «inmediata» del motor: se
manda una vez y no se reconcilia (una orden a mercado o se ejecuta o no existe). El identificador de la
orden es el número de compra (`BASE#0`, `SAFETY#3`), así que dos revisiones seguidas no la duplican.

> Comprar a mercado significa **comisión de taker** en cada entrada. La salida, limitada, paga maker. En
> Hyperliquid eso son ≈ 0,035 % + 0,01 %; el take profit tiene que cubrirlo con holgura.

### Paso 4 — Cierre y nuevo ciclo

Cuando el take profit se ejecuta, el ciclo se cierra con su PnL (`CYCLE_CLOSED`), el cupo vuelve a cero y
el bot empieza otro ciclo con la siguiente compra.

### Paso 5 — Guardas

El motor añade el **stop-loss** (condicional nativa sobre la media) si lo configuraste, y evalúa las
[guardas de riesgo](./riesgo-y-liquidacion.md#6-las-guardas-del-motor-revisión-a-revisión) antes de
planificar.

### Lo que enseña la vista previa

La vista previa proyecta el **peor caso razonable**: cada compra ocurre cuando el precio ha caído el margen
exigido respecto de la media anterior. Con 20 compras y un margen de 0,5 %, la vigésima cae ≈ 9,1 % por
debajo de la primera. No es una predicción: es hasta dónde puede llegar el bot con tu configuración.

---

## 3. Cómo configurarlo con poco riesgo

### Las cinco reglas de oro

1. **`importe × compras máximas` es tu peor caso en margen.** La app no te deja crear el bot si supera
   el capital asignado. Ponlo consciente de que puede llegar entero.
2. **1×.** Es el valor por defecto de esta estrategia y por algo: promediar a la baja con apalancamiento es
   la receta para acercar la liquidación. La app avisa por encima de 3×.
3. **El take profit tiene que pagar taker + maker.** Por debajo del 0,3 % un ciclo cerrado puede acabar en
   pérdida (0,05 % es el mínimo del formulario; no es un buen valor).
4. **El intervalo decide el ritmo, el margen decide el filtro.** Intervalos cortos reaccionan a una caída
   del mismo día; márgenes altos guardan el cupo para caídas serias. Combínalos con la volatilidad del par.
5. **Pon «Notional máximo de la posición».** Es el único tope que esta estrategia lee; «Tope de
   exposición» no hace nada aquí (§4).

### Configuración A — «Acumular BTC con paciencia»

Precios del 24-08-2026 (`venue-markets.ts`), Lighter, BTC a **78.910 USDC**.

| Campo | Valor | % del capital |
|---|---|---|
| Par | BTC/USDC (Lighter) | |
| Apalancamiento | **1×** | |
| Capital asignado | **500 USDC** | 100 % |
| Importe por compra | **25 USDC** | 5 % |
| Intervalo | **240 min** (4 h) | |
| Compras máximas por ciclo | **20** | |
| Comprar solo si mejora la media | Sí | |
| Margen bajo la media | **0,5 %** | |
| Take profit | **1,5 %** | |

**Qué hace esto.** Como máximo compromete `25 × 20 = 500 USDC`, justo el capital. La primera compra entra
al precio que haya (≈ 0,00031 BTC, 24,5 USDC: por encima del mínimo de 10 USDC y de 0,0001 BTC). Después
solo compra si BTC está al menos un 0,5 % por debajo de la media **y** han pasado 4 horas. Agotar el cupo
lleva al menos 80 horas (más de 3 días). En una caída del 10 % podrían entrar unas siete u ocho compras.
El bot cierra entero cuando BTC recupere un 1,5 % sobre la media resultante.

**Peor caso (vista previa).** 20 compras proyectadas de 78.910 a 71.742: **491,88 USDC** de notional,
**500,00** de margen, media **75.211**, take profit en **76.339,5**. A 1× no hay liquidación práctica.

### Configuración B — «Cazar caídas rápidas en ETH»

| Campo | Valor | % del capital |
|---|---|---|
| Par | ETH/USDC (Hyperliquid) · **2.503 USDC** | |
| Apalancamiento | 1× | |
| Capital asignado | **600 USDC** | 100 % |
| Importe por compra | **40 USDC** | 6,7 % |
| Intervalo | **30 min** | |
| Compras máximas por ciclo | **15** | |
| Margen bajo la media | **1,2 %** | |
| Take profit | **2 %** | |
| Notional máximo de la posición | **650 USDC** | 108 % |

**Qué hace esto.** El intervalo corto deja al bot reaccionar a un tramo de caída en el mismo día, y el
margen del 1,2 % impide que gaste el cupo en ruido. `40 × 15 = 600 USDC`, que cabe en el capital. El tope
de 650 USDC de notional es el freno duro por si el precio hiciera crecer la posición más de lo previsto.

**Peor caso (vista previa).** 15 compras de 2.503,3 a 2.114,0 (≈ 0,016-0,019 ETH cada una, 39,8 USDC):
**597,73 USDC** de notional, **600,00** de margen, media **2.297**, take profit en **2.343,1**.

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
| Take profit | **5 %** | |

**Qué hace esto.** Suba o baje DOGE, entran 15 USDT diarios durante veinte días (162-179 DOGE cada vez: en
Aster el paso de cantidad es 1 DOGE y el mínimo 5 USDT). A cambio, tu media puede **empeorar** si el par
sube, y el objetivo del 5 % tarda más en llegar. La vista previa sigue proyectando las compras con el
margen del 0,5 % (es la cota que dibuja, no lo que hará este bot): **299,10 USDT** de notional, **300** de
margen, media **0,08777**, take profit en **0,09215**.

### Checklist antes de arrancar

- [ ] ¿`importe × compras máximas` ≤ capital asignado? (la app lo exige)
- [ ] ¿Cada compra ≥ 20 USDC? (mínimo 10 en Lighter/HL, 5 en Aster; el paso de cantidad puede redondear)
- [ ] ¿Apalancamiento 1×, o como mucho 2×?
- [ ] ¿Take profit ≥ 0,5 %? (dos comisiones, una de ellas taker)
- [ ] ¿«Notional máximo de la posición» puesto? (no «Tope de exposición»)
- [ ] ¿Intervalo acorde al horizonte? (30 min = un día; 240 min = una semana; 1440 = un mes)
- [ ] ¿He mirado la financiación del par si el ciclo puede durar días?
- [ ] ¿Stop loss donde reconozco que la tesis falló?

### Señales de alarma cuando ya está funcionando

| Lo que ves | Qué significa | Qué hacer |
|---|---|---|
| `Sin comprar: límite de 20 compras alcanzado` y el precio sigue bajando | Cupo agotado; el bot solo espera | Decide: esperar, cerrar, o aportar margen si aislado |
| `Sin comprar: el precio no mejora el medio…` durante días | El par sube; la media no baja | Normal. Si quieres comprar igualmente, desactiva la condición |
| Ciclos cerrados con PnL ≈ 0 | Take profit demasiado corto para taker + maker | Súbelo |
| El take profit «toca» y no cierra | Orden limitada que el precio rozó y se fue | Espera; si pasa mucho, «Recoger beneficio» cierra a mercado |
| `FILL` sin `FILL` de salida en muchos días | Posición larga abierta pagando funding | Mira la tasa de financiación en el venue |
| `LIQUIDATION_NEAR` | Estás apalancado y la caída es grande | Aporta margen o cierra parte; a 1× no ocurre |

---

## 4. Lo que este bot NO mira (importante)

| Campo | Realidad |
|---|---|
| **Tope de exposición** (`maxNotionalCap`) | **Sí**, como segundo tope junto a **Notional máximo de la posición**: manda el menor de los dos. |
| **Espera entre ciclos** (`cooldownMinutes`) | **Sí.** Al cerrar un ciclo, la siguiente compra espera estos minutos; el «intervalo» sigue mandando entre compras dentro del ciclo. |
| **Capital asignado** (`totalInvestment`) | **No dimensiona las compras**: el tamaño lo da «Importe por compra». Se usa como techo declarado (la app exige `importe × compras ≤ capital`) y como denominador de la pérdida diaria y del kill-switch. |
| **Adelantar seguridad** y **Recentrar la retícula** (comandos) | No hacen nada aquí: el DCA no tiene escalera colgada ni ancla. |

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

### 6.1 Configuración básica

#### Conexión de exchange · `exchangeAccountId` · ❄️ en frío

La cuenta con la que opera el bot (real, pruebas o simulación). **Consejo**: si es el primero, la cuenta
«Simulación».

#### Par · `symbol` · ❄️ en frío

Fija el mínimo de orden, el paso de cantidad y el apalancamiento máximo. En pares baratos (DOGE) el paso
de cantidad es 1 moneda: 15 USDT son 162 DOGE, no 162,9.

#### Dirección · `direction` · ❄️ en frío · por defecto **Largo**

En corto todo se invierte: vende a mercado cada intervalo si el precio **sube** por encima de la media en
el margen exigido, y la salida es una recompra por debajo de la media.

#### Capital asignado · `totalInvestment` · 🌤️ en tibio · mínimo 10 · ⚠️ campo de riesgo

El techo declarado del bot. **No dimensiona las compras** (eso lo hace el importe por compra), pero la app
rechaza el bot si `importe × compras máximas` lo supera, y es el denominador de la pérdida diaria.

#### Importe por compra · `amountPerBuy` · 🔥 en caliente · mínimo 1 · obligatorio

Cuánto **margen** se compromete en cada compra. Con apalancamiento, la posición que añade es este importe
multiplicado por el apalancamiento. Junto al número de compras define el techo real del bot.

**Consejo**: que no baje del mínimo del par con holgura (≥ 20 USDC). La app rechaza el bot si importe ×
compras máximas supera el capital asignado.

#### Intervalo (min) · `intervalMinutes` · 🔥 en caliente · 1–10080 · por defecto **60**

Cuánto tiene que pasar entre una compra y la siguiente. Es el ritmo del bot: intervalos cortos reaccionan
a una caída del mismo día; largos reparten las entradas a lo largo de semanas.

**Consejo**: el intervalo se cuenta siempre, también cuando el precio cumple: es un freno, no un disparador.

#### Compras máximas por ciclo · `maxBuysPerCycle` · 🔥 en caliente · 1–500 · por defecto **20** · ⚠️ campo de riesgo

Multiplicado por el importe por compra, es **exactamente** el dinero que este bot puede llegar a
comprometer. Agotado el cupo, deja de comprar y espera al objetivo.

**Consejo**: es el parámetro que convierte el DCA en algo acotado. Sin un número honesto aquí, el bot puede
seguir promediando indefinidamente.

#### Comprar solo si mejora la media · `buyOnlyIfImprovesAverage` · 🔥 en caliente · por defecto **Sí**

Activado, solo compra cuando el precio está por debajo de tu precio medio actual: tu media solo puede
mejorar y el objetivo solo puede acercarse. Desactivado, es un DCA clásico que compra a intervalo fijo pase
lo que pase, y la media puede empeorar.

**Consejo**: activado por defecto, y es lo que distingue esta estrategia de una compra programada.

#### Margen bajo la media (%) · `marginBelowAveragePct` · 🔥 en caliente · 0–100 · por defecto **0,5**

Cuánto tiene que estar el precio por debajo de tu media para que la compra cuente como mejora. Con 0,
cualquier precio bajo la media vale. Subirlo exige caídas más serias y guarda el cupo para ellas.

**Consejo**: solo se aplica con la condición de la media activada. En pares volátiles, 1-2 % evita gastar
el cupo en ruido.

#### Take profit (%) · `takeProfitPct` · 🔥 en caliente · 0,05–100 · por defecto **1,5**

Beneficio sobre el precio medio al que se cierra la posición entera y termina el ciclo. La orden está
siempre viva y se recalcula con cada compra.

**Consejo**: con una entrada taker y una salida maker, por debajo del 0,3 % un ciclo puede acabar en
pérdida. 1-2 % es razonable para un DCA.

#### Seguir al máximo (trailing) · `trailingTakeProfit` · 🔥 en caliente · por defecto **Apagado**

Convierte el take profit en un objetivo que **sigue al precio**. Al llegar al porcentaje que pediste el bot
no cierra: empieza a seguir al máximo y solo vende cuando el precio retrocede lo que digas.

Con él encendido, el **take profit deja de ser la salida y pasa a ser la activación**. Tu «15 %» sigue
donde estaba y significa otra cosa: el punto en el que empieza el seguimiento.

Las tres fases, con activación 15 % y retroceso 1 % sobre una media de 100:

| Fase | Precio | Qué hace el bot |
|---|---|---|
| Antes de activar | 100 → 114 | **Nada**. No hay orden de beneficio en el libro; la única protección es tu stop loss, que sigue intacto |
| Se activa | 115 | Coloca un disparador en `115 × 0,99 = 113,85` |
| Sigue | 115 → 130 | Sube el disparador a `130 × 0,99 = 128,70`. **Nunca lo baja** |
| Cierra | 130 → 128,70 | Vende a mercado |

**El suelo de lo que cobras es `activación × (1 − retroceso)`**: con 15 % y 1 %, **+13,85 %**. Un trailing
puede darte mucho más que un objetivo fijo, y también un poco menos. Eso no es un fallo: es el peaje.

**No es una mejora gratis.** En marcos cortos **baja la tasa de acierto**, porque el retroceso normal de
una cripto —un 1-3 % al día sin cambiar de tendencia— lo dispara antes de tiempo. Funciona mejor cuando lo
que esperas es un movimiento grande, no ruido.

**Al encenderlo en un bot en marcha**: la orden de beneficio que hubiera en el libro se cancela en la
siguiente revisión, y si el precio todavía no ha llegado al objetivo **no se sustituye por nada** hasta que
llegue. Es lo correcto —no hay nada que asegurar por debajo del objetivo— pero conviene saberlo.

#### Retroceso para salir (%) · `trailingCallbackPct` · 🔥 en caliente · 0,1–10 · por defecto **1**

Cuánto tiene que caer el precio desde el máximo alcanzado para que el bot cierre. En corto es al revés:
cuánto tiene que subir desde el mínimo.

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
aunque le quede cupo e intervalo cumplido. La orden de cierre sigue viva.

**Consejo**: aquí manda este campo, no el tope de exposición genérico. Ponlo un poco por encima de
`importe × compras máximas × apalancamiento`.

#### Tope de exposición · `maxNotionalCap` · 🔥 en caliente · opcional

Segundo tope junto a «Notional máximo de la posición»: manda el menor de los dos. Déjalo vacío si el propio te basta.

#### Stop loss (%) · `stopLossPct` · 🔥 en caliente · 0,1–90 · ⚠️ campo de riesgo

Pérdida sobre la media a la que el motor cierra la posición con una orden condicional nativa
([riesgo §7](./riesgo-y-liquidacion.md#7-el-stop-loss)). **Consejo**: donde reconocerías que la tesis
falló; en un DCA de acumulación a 1× mucha gente lo deja vacío a conciencia.

#### Pérdida diaria máxima (%) · `maxDailyLossPct` · 🔥 en caliente · 0,1–100

Pérdida realizada hoy por este bot, en % de su capital, a partir de la cual se pausa.

#### Al acercarse la liquidación · `liquidationAction` · 🔥 en caliente · por defecto **Solo avisar** · ⚠️ campo de riesgo

Solo avisar / Pausar el bot / Cerrar todo, cuando la distancia a la liquidación baja del umbral de aviso.
A 1× no aplica.

### 6.3 Tiempos

#### Espera entre ciclos (min) · `cooldownMinutes` · 🔥 en caliente · 0–10080 · por defecto **0**

Tras cerrar un ciclo, la siguiente compra espera estos minutos. El «intervalo» sigue mandando entre compras
dentro del ciclo.

### 6.4 Exchange

#### Apalancamiento · `leverage` · 🌤️ en tibio · 1–50 · por defecto **1** · ⚠️ campo de riesgo

Multiplica ganancia y pérdida y acerca la liquidación. **Esta estrategia viene a 1×** y la app avisa por
encima de 3×: «TDCA promedia sin límite de recorrido: por encima de 3× el margen se agota rápido».

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
| Margen bajo la media | 0,5 % | 🟡 1-2 % en pares volátiles |
| Take profit | 1,5 % | ✅ Razonable |
| Seguir al máximo (trailing) | Apagado | 🟡 Enciéndelo solo si esperas un movimiento grande |
| Retroceso para salir | 1 % | 🟡 Mídelo contra lo que respira tu par |
| Umbral para mover el disparador | 20 bps | ✅ Déjalo; súbelo en Lighter |
| Notional máximo de la posición | vacío | 🔴 **Ponlo**: es el único tope que lee |
| Al acercarse la liquidación | Solo avisar | ✅ A 1× no aplica |
| Espera entre ciclos | 0 | ✅ Déjalo (muerto) |

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
