# Riesgo y liquidación — cómo se mide y qué hace el motor

> Código: [`liquidation.ts`](../packages/shared/src/liquidation.ts) (la fórmula), [`risk.ts`](../apps/app/src/app/core/utils/risk.ts) (el semáforo de la app), [`risk.service.ts`](../apps/api/src/modules/risk/risk.service.ts) (los límites de tu cuenta) y `checkRiskGuards()` en [`bot-runner.ts`](../apps/worker/src/engine/bot-runner.ts) (las guardas que corren en cada revisión).
> Las guías de estrategia enlazan aquí. Léelo entero una vez; después basta con volver a la tabla que necesites.

---

## 1. Las cinco cifras que importan

| Cifra | Qué es | Dónde la ves |
|---|---|---|
| **Capital asignado** (`totalInvestment`) | El **margen** que el bot puede usar. No sale de tu cuenta ni se transfiere a ningún sitio: es el techo que el bot se autoimpone al repartir sus órdenes. | Formulario del bot · tarjeta del bot |
| **Notional** (exposición) | Cantidad × precio. Con apalancamiento `L`, una escalera completa mueve **capital × L** de notional. | Vista previa (el tamaño de cada lado y, aparte, lo que suman todas las órdenes) · resumen del bot |
| **Peor caso** | Todos los niveles ejecutados, **lado a lado**: la posición de cada lado —entrada media, tamaño y margen— y sus tres salidas, el objetivo, el stop y la liquidación. | Vista previa, antes de crear el bot |
| **% sobre el margen** (ROI) | Lo que ganas o pierdes sobre el margen de la posición, como el TP/SL por ROI de un exchange. El stop, los take profit, el objetivo del seguimiento y el satélite de GridMart se miden así. | Formulario (con su equivalente en precio y en USDC) · vista previa |
| **Distancia a liquidación** | Cuánto puede moverse el precio **en contra** antes de que el exchange cierre la posición por ti. En %. | Vista previa (desde la entrada y desde el último precio) · lista de bots · cartera · detalle · gráfico |

Regla que hay que interiorizar: **el apalancamiento no cambia cuánto pones, cambia cuánto pierdes por cada
punto que el precio se mueve en contra, y acerca la liquidación**. Dos bots con 500 USDC de capital, uno a
1× y otro a 5×, arriesgan los mismos 500 USDC; el segundo los pierde con una caída cinco veces menor.

**Los % de resultado van sobre el margen; las distancias, sobre el precio** (spec 080). Un stop del 10 %
es perder el 10 % del margen de la posición, sea cual sea el apalancamiento:

```
precio de salida = precio medio × (1 ± ROI / (100 · L))      (+ a favor del largo, − del corto)
```

A 2× un stop del 10 % está a un 5 % del precio; a 10×, a un 1 %. Es la fórmula de la calculadora de
futuros de Binance. Las **distancias** —separación de la escalera, retroceso del seguimiento, descuento
de recompra, mejora mínima del DCA, bps de un market maker, stop ATR de la tendencia— siguen en % del
precio, también como en Binance, donde el «callback rate» del trailing es un % del precio. Hasta el
spec 080 los % de resultado eran del precio: a 15×, un «objetivo del 15 %» era un +225 % del margen sin
que ninguna pantalla lo dijera.

---

## 2. La fórmula de la liquidación

Antes de que exista posición, la app, la API, el asesor, el simulador y el backtest calculan la
liquidación con **una sola** fórmula, la exacta de una posición **aislada** (la que documenta
Hyperliquid), en `precioLiquidacion` y `distanciaLiquidacion` de
[`liquidation.ts`](../packages/shared/src/liquidation.ts):

```
LARGO : liquidación = precio_medio × (1 − 1/L) / (1 − mmr)
CORTO : liquidación = precio_medio × (1 + 1/L) / (1 + mmr)

distancia (largo) = (1/L − mmr) / (1 − mmr)
distancia (corto) = (1/L − mmr) / (1 + mmr)        (en fracción; × 100 para el %)
```

La del corto es siempre la más estrecha. Hasta el spec 080 convivía con una aproximación lineal
(`1/L − mmr`) que en el corto salía optimista, y la misma pantalla enseñaba tres distancias distintas.

`mmr` es la **tasa de margen de mantenimiento del mercado**: la que publica el venue si la ficha la
trae (Lighter), y si no, la mitad del margen inicial a su apalancamiento máximo (BTC a 40× en
Hyperliquid → 1,25 %; ETH a 25× → 2 %; DOGE a 10× → 5 %). Traducido a una tabla, con BTC en
Hyperliquid (1,25 %):

| Apalancamiento | Distancia a la liquidación (largo · corto) | Margen perdido al llegar | Lectura |
|---|---|---|---|
| 1× | sin liquidación · 97,5 % | — · 97,5 % | En largo el precio tendría que llegar a cero; en corto, casi duplicarse |
| 2× | 49,4 % · 48,1 % | 98,7 % · 96,3 % | El precio tiene que moverse a la mitad |
| 3× | 32,5 % · 31,7 % | 97,5 % · 95,1 % | |
| 5× | 19,0 % · 18,5 % | 94,9 % · 92,6 % | Ya es una caída «normal» de una altcoin en una semana mala |
| 10× | 8,9 % · 8,6 % | 88,6 % · 86,4 % | Un día volátil |
| 15× | 5,5 % · 5,35 % | 82,3 % · 80,2 % | El **máximo en corto** que la API acepta en BTC (ver §4) |
| 16× | 5,06 % · 4,94 % | 81,0 % · — | El **máximo en largo**; en corto, rechazado |
| 17× | 4,69 % · 4,58 % | — | Rechazado en los dos lados |

La tercera columna es lo que se ha perdido del margen cuando el precio llega a la liquidación (la
distancia por el apalancamiento): el resto es el mantenimiento, que el venue se queda al liquidar. Es
el número que manda sobre el stop (§7): un stop que pierde más que eso no salta nunca.

> ⚠️ **Sigue siendo una estimación.** El exchange aplica una escala de margen de mantenimiento **por
> tramos**: cuanto mayor es la posición, mayor la tasa; la ficha usa el tramo más bajo. Por eso la app
> etiqueta el número como «estimación» y **en cuanto hay posición abierta manda el precio de liquidación
> que devuelve el venue**, no este.

Cuando el bot ya tiene posición, todas las pantallas enseñan la distancia calculada por la API una sola
vez con el precio de liquidación **real** del exchange y el precio de marca del último snapshot.

---

## 3. Aislado frente a cruzado

| Modo de margen | Qué respalda la posición | Liquidación | Riesgo para los otros bots |
|---|---|---|---|
| **Aislado** (`ISOLATED`) | Solo el margen de esta posición | Llega **antes** | Ninguno: lo máximo que pierde este bot es su margen |
| **Cruzado** (`CROSS`) | Toda la caja libre de la cuenta, repartida entre las posiciones abiertas en proporción a su notional | Llega **más lejos** | Una posición perdedora **arrastra el saldo de los demás bots de esa cuenta** |

El modo es ❄️ **en frío**: no se puede cambiar con el bot creado. Ojo con los valores de fábrica:
**Rejilla neutral, Market Maker y Market Maker V2 vienen en cruzado**; el resto, en aislado. La vista
previa te lo recuerda: en cruzado rotula la liquidación como **cota** (la real depende del saldo de toda
la cuenta y de las demás posiciones), y en la rejilla neutral y los market makers enseña **cada lado con
su propia liquidación**: las compras son un largo y las ventas un corto, nunca la misma posición.

El aviso de dinero real de la Revisión lo dice según el modo: en aislado, lo más que se pierde en una
liquidación es el margen asignado; en cruzado, una liquidación puede llevarse el saldo libre de la cuenta.

---

## 4. El semáforo y la regla del 5 %

La distancia a liquidación se pinta igual en todas las pantallas, también en el medidor del formulario y
en las configuraciones sugeridas (`LIQ_WARN_PCT` y `LIQ_DANGER_PCT` en
[`risk.ts`](../apps/app/src/app/core/utils/risk.ts)):

| Distancia | Color | Qué significa |
|---|---|---|
| **≥ 25 %** | 🟢 verde | Cómodo. Un movimiento diario normal no te acerca. |
| **10 % – 25 %** | 🟡 ámbar | Vigila. Una vela mala te deja en rojo. |
| **< 10 %** | 🔴 rojo | Peligro. Es el umbral por defecto del aviso `LIQUIDATION_NEAR`. |
| sin dato | gris | Sin posición, o el venue no ha devuelto precio de liquidación. |

La barra **satura al 40 %**: por encima de eso la distancia deja de ser información y la barra sale llena.

**La regla del 5 %.** Al crear, editar o arrancar un bot, la distancia exacta de §2 **del lado que
manda** tiene que ser del 5 % o más; si no, la configuración se rechaza (`validateCommon` en
[`common.ts`](../packages/strategy-core/src/common.ts) y `topeDeApalancamiento` en
[`risk.service.ts`](../apps/api/src/modules/risk/risk.service.ts)):

> «A 17× la liquidación llega con un 4.69 % de movimiento en contra (mantenimiento del 1.25 %), por
> debajo del mínimo del 5 %: el máximo aquí es 16×.»

El tope depende de la tasa de mantenimiento del par y del lado, porque el corto liquida antes:

| Par (mantenimiento) | Máximo en largo | Máximo en corto |
|---|---|---|
| BTC en Hyperliquid (1,25 %) | 16× | 15× |
| ETH (2 %) | 14× | 14× |
| DOGE (5 %) | 10× | 9× |

Una dirección NEUTRAL puede acabar en corto, así que se mide contra el corto. El formulario aplica **la
misma regla con la misma tasa** y te dice el tope de ese mercado antes de crear el bot; la API la repite
al guardar y **al arrancar**, contra el mercado de ese día. Por encima de 10× la app avisa con la
distancia exacta y lo que se habrá perdido del margen al llegar: «A 12× la liquidación llega con un
7.17 % de movimiento en contra, cuando la pérdida alcanza el 86.1 % del margen».

Con la posición abierta **no se puede cambiar el apalancamiento** (la API responde 409,
`LEVERAGE_WITH_POSITION`): con el stop y los objetivos en % del margen, cambiarlo movería en silencio los
precios de las salidas de una posición viva.

### La regla por stop (el Canal con IA y la Operación IA)

La [Operación IA](./agent-trade.md) de los agentes usa esta misma regla, con la misma función del
motor: su apalancamiento lo calcula el agente al proponerla —y otra vez al aprobarla— con el colchón
de tres stops y su propio tope (10× de fábrica), y la validación de la estrategia exige la
liquidación detrás del stop con holgura. Lo que sigue se explica con el canal.

El [Canal con IA](./ai-channel.md) no usa la regla del 5 %: cada operación lleva su stop desde el
primer momento, así que la distancia a la liquidación se exige **contra ese stop**. Con `s` la
distancia al stop en tanto por uno de la entrada y `mmr` la tasa de mantenimiento del tramo:

```
distancia exigida = el mayor de (colchón · s) y (3 ATR de 1 h / precio)     colchón ≥ 3
apalancamiento    = floor(1 / (mmr + distancia · (1 + mmr)))
tope              = el menor de ese número, 25, tu tope del bot, el del tramo, el del par y el de tu cuenta
```

Así la liquidación queda **al menos a tres stops** de la entrada. Un stop más ancho da menos
apalancamiento, y el tamaño sale del riesgo, no del apalancamiento: **la pérdida al stop es la misma
a 5x que a 25x**. Lo que cambia es el margen inmovilizado y lo que se perdería si un hueco saltara el
stop, que tiene su propio tope (25 % del capital de fábrica).

Ejemplo del test de la herramienta, con 1.000 USDC y un 1 % de riesgo en un par con mantenimiento del
1 %: stop a 0,21 de una entrada de 100,05. La regla permite hasta 29x y el tope lo deja en 25x. A 25x
la operación inmoviliza 125 USDC y liquida en 97,02, con el stop en 99,84. A 13x, lo mínimo que
permite el margen máximo, inmovilizaría 241 USDC y liquidaría en 93,29. En las tres bandas, el stop
cuesta 10 USDC.

Al crear o editar, la API y el formulario aplican aquí el tope y no el 5 %: «El apalancamiento de esta
estrategia llega como mucho a 25× en este par».

**Recomendación de la casa:** 1× o 2× en todo lo que retenga inventario (rejillas, DCA, escaleras) y
nunca por encima de 3× en las estrategias que promedian en contra (la propia app avisa en el DCA
temporizado por encima de 3×). En Martingala y GridMart la app recorre la escalera **nivel a nivel**,
con la media de lo ya comprado y la liquidación exacta de esa media: si la liquidación llega antes que
una seguridad, rechaza la configuración en aislado (en cruzado, avisa), porque esa seguridad no se
ejecutaría jamás; si el que llega antes es el stop, avisa; y si la escalera cabe pero cubre menos de la
mitad del camino hasta la liquidación, también avisa.

---

## 5. Los límites de tu cuenta

En la pantalla **Riesgo** (`/risk`) fijas los topes que valen para **todos** tus bots. Se crean con
valores de fábrica la primera vez que entras; ninguno admite cero («cero» no significa «sin límite»,
significa que la plataforma se apaga, y por eso está prohibido).

| Límite | Qué corta | Cuándo se comprueba |
|---|---|---|
| Apalancamiento máximo | Ningún bot puede crearse ni **seguir corriendo** por encima | Al crear, al editar y **en cada revisión** del bot (un bot viejo con apalancamiento por encima del tope nuevo se pausa) |
| Notional máximo por bot | `capital × apalancamiento` al crear; la posición viva en cada revisión | Creación y revisión |
| Notional máximo total | La suma de todos tus bots | Creación y cada minuto en la revisión |
| Bots abiertos máximos | Cuántos pueden estar arrancados a la vez | Al arrancar |
| Pérdida diaria máxima (USDC) | PnL realizado **de todos tus bots** en el día | Al arrancar y en cada revisión |
| Kill-switch por pérdida acumulada (%) | Pérdida acumulada del bot sobre su capital asignado | Cada revisión |
| Aviso de liquidación (%) · por defecto **10** | A qué distancia salta `LIQUIDATION_NEAR` | Cada revisión |

**Cuándo llega un límite nuevo a un bot que ya está en marcha.** El motor relee tus topes cada minuto,
y la lectura se comparte entre todos tus bots durante veinte segundos: un cambio muerde en menos de
dos minutos, sin parar nada. Vale en los dos sentidos —bajar un tope pausa al bot que lo incumpla,
subirlo deja de pausarlo— y reanudar un bot relee los topes antes de arrancarlo, así que no puede
rebotar contra el tope viejo.

Un bot pausado por una guarda **no se reanuda solo** cuando la condición desaparece: el motor no pone
a operar lo que no le has pedido. Lo que sí hace es retirar el aviso de su tarjeta y avisarte con
`RISK_GUARD_CLEARED` de que ya puedes reanudarlo tú.

Y el **kill-switch global** (`POST /risk/kill-switch`, el botón rojo de la pantalla): marca **todos** tus
bots para parar y cerrar; el worker, que es quien tiene las claves, cancela y cierra. Es el único
comando con alcance de cuenta: los comandos de un bot nunca tocan las órdenes de otro.

---

## 6. Las guardas del motor, revisión a revisión

El motor revisa cada bot **cada 15 segundos** y antes de planificar nada evalúa estas guardas
(`checkRiskGuards`, [`bot-runner.ts`](../apps/worker/src/engine/bot-runner.ts)). Si una salta, el bot
**se pausa, no se cierra**: cerrar realizaría la pérdida al instante y en el peor momento; pausar detiene
el sangrado y te deja la decisión.

| Guarda | Condición | Qué hace |
|---|---|---|
| Apalancamiento | El del bot supera tu límite. Se mira **haya posición o no**. | Pausa |
| Notional por bot | `|posición| × marca` supera tu límite por bot | Pausa |
| Notional total | La suma de tus bots supera tu límite total | Pausa |
| **Liquidación cerca** | Distancia al precio de liquidación **del venue** < «Aviso de liquidación» (10 %) | Evento CRITICAL (con enfriamiento de unos minutos) y, según **Al acercarse la liquidación**: **Solo avisar** (defecto) no toca nada · **Pausar el bot** pausa · **Cerrar todo** cierra a mercado |
| Kill-switch por pérdida acumulada | `pérdida acumulada del bot / capital asignado ≥ %` | Pausa |
| Pérdida diaria de la cuenta | PnL realizado de hoy de todos tus bots < −límite | Pausa |
| Pérdida diaria del bot (%) | `stopLoss diario` del propio bot sobre su capital | Pausa |
| Colocaciones fallidas | 20 fallos pasajeros seguidos al colocar órdenes | Pausa |
| Revisiones fallidas | 5 errores seguidos **del propio bot** en el ciclo del motor (algo más de un minuto) | Pausa |
| Venue sin servicio | El exchange no responde: HTTP 5xx, timeouts, error de red, 429 | **No pausa**: el bot espera (ver abajo) |
| Precio externo desfasado | El bot cotiza contra Binance y lleva > 15 s sin dato | La estrategia deja de cotizar; aviso `FAIR_PRICE_STALE` |

**Qué significa «pausa» aquí** (`pauseForRisk`): el bot deja de planificar, **cancela sus órdenes
manteniendo el stop-loss** (a partir de ese momento el stop es la única defensa de la posición), pasa a
`PAUSADO` con el motivo, y escribe un evento **CRITICAL** `RISK_GUARD_TRIPPED` que termina con una de
estas tres coletillas:

- «El stop loss sigue vivo en el exchange.»
- «Atención: la posición queda SIN stop loss.» (no configuraste `stopLossPct` y la estrategia no pone
  el suyo)
- «Atención: hay un stop loss configurado pero NO consta colocado en el exchange. Revísalo.» En
  Tendencia, que pone su propio stop, dice «la estrategia pone su propio stop loss pero NO consta…».

«Consta» es lo que el motor ve **en el libro del exchange** en cada revisión, no solo lo que llegó a
colocar él: tras un reinicio del worker, un stop que ya estaba cuenta como vivo. Hasta el spec 057
(F-09) Tendencia recibía siempre «SIN stop loss», con su stop puesto.

Si el bot consta **sin posición** —la ha leído una revisión y no ha entrado ninguna ejecución desde
entonces—, la alerta dice «no tenía posición abierta» en lugar de cualquiera de las tres. Si no se sabe,
por ejemplo tras una racha de revisiones fallidas, dice «si tenía posición abierta, sigue abierta» con la
coletilla del stop: el motor no presume que siga plano.

Un bot pausado sigue latiendo: mira su posición y avisa de la liquidación, pero no toca el libro.

**Una caída del venue no pausa.** Pausar mientras el exchange no responde no protege nada: no acepta
órdenes, la cancelación de la pausa fallaría igual y el stop nativo sigue donde estaba. Lo único que
conseguía era dejar el bot pausado cuando el venue volvía. Ahora el bot **espera**:

- Espacia sus revisiones, el doble cada vez, hasta una por minuto.
- A la tercera revisión fallida avisa una vez con `VENUE_UNAVAILABLE`, y lo recuerda cada 30 minutos.
- Deja «<venue> no responde…» en su tarjeta sin cambiar de estado.
- Cuando el venue contesta, avisa con `VENUE_RECOVERED` y reconcilia como tras un reinicio del worker.

Un bot simulado aguanta además hasta 20 s con el último precio conocido, igual que uno real. Los fallos
que **no** son del venue (un error del propio bot) siguen pausando a los cinco.

**En el Canal con IA** cuatro guardas funcionan distinto:

- **Liquidación.** Se mide el **camino** de la entrada a la liquidación: a dos tercios salta
  `LIQUIDATION_NEAR` en CRITICAL y actúa «Al acercarse la liquidación», que aquí viene en **Cerrar
  todo**. Por debajo no avisa: el porcentaje de aviso de tu cuenta no aplica.
- **Pérdida diaria del bot.** Al llegar al tope, la estrategia deja de abrir **hasta las 00:00 UTC**
  y vuelve sola, sin pausar. La guarda solo pausa si un hueco lleva la pérdida a **1,5 veces** el
  tope, y entonces la pausa dura hasta las 00:00 UTC: reanudarlo antes no abre entradas y la guarda
  lo vuelve a pausar. El día del canal va en UTC.
- **Caída máxima.** Si el resultado realizado cae desde su mejor punto más de lo configurado (15 %),
  el bot se pausa y lo reanudas tú. El mejor punto se cuenta **desde tu última reanudación**: al
  reanudar, la caída vuelve a cero y el bot tiene otra vez todo el margen.
- **Vigilante del stop.** Tras una entrada, si el stop no aparece en el libro a los 5 segundos (10
  en Lighter), el bot **cierra la posición a mercado** y avisa en CRITICAL (`SIN_STOP`). También con
  el bot pausado: pausado repone su stop si falta, y si no sale, cierra.

Cada intento de cierre se lleva su propio identificador, así que uno que se ejecute a medias no
impide el siguiente, y el aviso `SIN_STOP` se repite como mucho una vez por minuto mientras dure
(spec 062, F-05). Con el bot **pausado**, la guarda de liquidación de las estrategias con
apalancamiento por operación —hoy, el canal con IA y la operación de un agente— **cierra de
verdad**, que es lo que promete «Al acercarse la liquidación»; en el resto de estrategias sigue
avisando y esperándote (spec 062, F-12).

**La Operación IA** (spec 074) hereda del canal la guarda de liquidación, el vigilante del stop y la
protección en pausa. No tiene pérdida diaria ni caída máxima propias: sus límites del día son los de
su agente, que se pausa entero al tocar su pérdida diaria —contando al stop lo que tiene abierto—.

> ℹ️ **Semántica fijada (F-11, 2026-09-06).** El kill-switch del bot mide la **pérdida acumulada sobre el
> capital asignado**, no la caída desde el máximo: es un tope de pérdida absoluta, y así se rotula en la
> app («Pérdida acumulada que pausa el bot»). La pérdida diaria de la cuenta y la del bot cortan el día a
> la misma medianoche, la de tu zona horaria.

---

## 7. El stop-loss

Si rellenas **Stop loss (sobre el margen)**, el motor —no la estrategia— añade al plan una orden
**condicional nativa del exchange** (`withStopLoss`, [`stop-loss.ts`](../packages/strategy-core/src/stop-loss.ts)):

- Es un **% del margen** de la posición (spec 080): el disparo va a `media × (1 ∓ stop/(100·L))`. A 2×
  un stop del 10 % está a un 5 % del precio; a 10×, a un 1 %. El formulario enseña junto al campo su
  equivalente en precio y en USDC.
- `L` es el apalancamiento de la configuración, que es el que el motor fija en el venue. Si la posición
  del venue tiene uno **mayor** —la cuenta ya lo tenía puesto, u otro cliente lo cambió—, el stop se
  calcula con ese, que da el disparo más cerca, y el bot avisa una vez (`LEVERAGE_SKIPPED`, WARN) de que
  no coinciden.
- Se calcula sobre el **precio medio real** de la posición, en la dirección del **signo de la posición**
  (no de la dirección declarada: un market maker o una rejilla neutral cambian de lado solos).
- Se redondea **un tick hacia la entrada**: salta antes, nunca después.
- Es `reduceOnly` sobre la posición entera y vive **en el exchange**: se dispara aunque la plataforma
  esté caída.
- Sobrevive a `PAUSE`, `STOP_KEEP_POSITION`, «Recentrar la retícula» y a todas las pausas por guarda.
  Lo cancela `CANCEL_ALL_ORDERS`; `STOP_AND_CLOSE` y `PANIC` lo cancelan **solo después de que el cierre
  haya salido**: si el exchange no acepta el cierre, el stop se queda, el bot pasa a pausado y lo dice en
  CRITICAL.
- **Tendencia, el Canal con IA y la Operación IA ponen su propio stop** y no leen este campo: el de
  Tendencia sigue al precio por ATR, el del canal sale del extremo del toque y el de la operación de
  un agente es el de su plan, que **solo se ciñe**. En los tres, «Stop loss (sobre el margen)» no hace nada.
- Si el exchange lo **rechaza**, el evento es CRITICAL una vez por forma de orden y el motor lo
  reintenta en cada revisión (no entra en cuarentena como el resto de órdenes). Un fallo **pasajero** al
  colocarlo (un corte de red) se reintenta en el mismo instante y, si tampoco sale, es CRITICAL.
- Su tamaño mínimo se mide sobre la **posición al precio de marca**, no al precio de disparo: un stop al
  −10 % de una posición de 10,5 USDC cabe aunque al disparo valiera 9,45.
- La API rechaza un stop no positivo o por encima del 90 % del precio (el 90·L % del margen) y una
  pérdida diaria máxima no positiva, igual que el formulario. Vacío es «sin stop».
- En el simulador es una condicional en reposo que se dispara con el precio de marca, igual que en un
  venue real.

### El stop frente a la liquidación

Un stop más ancho que la distancia a la liquidación **no salta nunca**: el venue liquida antes y se
pierde el margen entero, con el usuario creyendo que tenía una pérdida máxima. Desde el spec 080 la app
y la API lo comprueban con la distancia exacta de §2 (`validarStopFrenteALiquidacion`):

| Situación | En aislado | En cruzado |
|---|---|---|
| El stop queda en la liquidación o detrás | **Error**: no se crea | Aviso: la real queda más lejos, pero no se puede contar con ello |
| La liquidación queda a menos de **medio stop** detrás del stop | Aviso: un deslizamiento o una mecha pueden liquidar antes de que salga | Aviso |
| En largo, un stop del 100 % del precio o más | Error: llevaría el disparo a cero | Error |

Los tres proponen **el stop más ancho que deja medio stop de holgura** —la misma regla que usan desde
los specs 058 y 074 el canal con IA y los agentes—, y el formulario lo aplica con un toque («Usar el stop
más ancho válido»). Con el corto a 15× en BTC del caso que dio pie al spec 079:

> «A 15× la liquidación llega con un 5.35 % de movimiento en contra, al perder el 80.2 % del margen: un
> stop del 90 % no saltaría nunca, el venue liquida antes. El más ancho que deja medio stop de holgura es
> 53.4 %.»

No se mide así en las estrategias que ponen su propio stop, pero tampoco se les escapa. El Canal con IA
y la Operación IA eligen el apalancamiento de cada operación con su stop, y la liquidación queda siempre
a tres stops o más. La Tendencia no sabe su stop hasta la ruptura, porque sale del ATR de ese momento:
en aislado, **no entra** si ese stop quedaría en la liquidación o detrás («Ruptura descartada: el stop,
a 2.5 ATR, quedaría a un 10.27 %, detrás de la liquidación a 10× (8.86 %)…»), y si cabe con menos de
medio stop de holgura entra y lo anota. Al crearla, la app avisa con el ATR de la estimación (un 2 % del
precio) y dice a partir de qué volatilidad ese apalancamiento deja de caber.

**Dónde ponerlo.** En las escaleras (Martingala, GridMart), que su precio quede **más allá del último
escalón**: si salta antes, cierra el ciclo sin haber terminado de promediar, y la app te dice qué
seguridad no llegaría. En una rejilla, más allá del extremo del rango. En un DCA, donde estés dispuesto
a reconocer que la tesis falló. En todos, por delante de la liquidación con holgura: la app no te deja
otra cosa en aislado.

Al recolocarse (cambió la posición o la media) se cancela el viejo y se pone el nuevo; la ventana entre
ambos dura una llamada al venue. Ponerlo **antes** de cancelar exigiría un id distinto por encarnación
del stop y queda para un spec posterior.

---

## 8. El peor caso de cada estrategia

Lo que la vista previa llama «peor caso» es **todos los niveles ejecutados**, lado a lado: cada lado
recorre sus entradas en el orden en que el precio las tocaría yendo en contra, con la media de lo ya
lleno, y se **corta** donde el stop o la liquidación de esa media llegan antes que el nivel siguiente, o
donde el **Tope de exposición** no deja tender el nivel —la Revisión dice en qué nivel y por qué—. El
tope se aplica como en el motor: un nivel entra si la posición que deja, valorada a su propio precio,
cabe en él (lo abierto vale menos cuanto más se ha ido el precio). Lo que el tope no deja tender tampoco
cuenta en los totales «de todas las órdenes»; lo que cortan el stop o la liquidación sí, porque se
coloca aunque no llegue a llenarse. Sobre la posición resultante enseña el objetivo, el stop y la
liquidación con su precio, el movimiento desde la entrada y desde el último precio, el resultado en USDC
**sin comisiones** y el % sobre el margen, más la relación beneficio/riesgo.

El margen es siempre lo que el venue retiene por cada orden: su notional, ya redondeado a la retícula del
par, entre el apalancamiento. Por eso sale un poco por debajo del capital: redondear cada cantidad hacia
abajo deja algo sin usar. Cómo se calcula en cada una:

| Estrategia | Peor caso (notional) | Margen en el peor caso | Lo que hay que saber |
|---|---|---|---|
| Rejilla clásica | **capital × apalancamiento** (todas las líneas compradas) | ≈ capital | La vista previa cuenta **todas** las líneas: basta con que el precio suba por encima del rango y lo recorra entero hacia abajo. Con `Tope de exposición`, las que caben, de la más alta hacia abajo; y un tope menor que una sola línea es un error, porque la rejilla no pondría ninguna orden. |
| Rejilla neutral | La suma de las líneas de **un** lado —las compras si cae, las ventas si sube—: más o menos la mitad de capital × apalancamiento. La Revisión enseña cada lado aparte | ≈ capital en total (todas las órdenes, de los dos lados); cada lado, el suyo | `Exposición máxima` —o el tope común, el menor de los dos— acota **cada lado por separado**, de la línea más cercana al ancla hacia fuera, y la Revisión enseña cada lado cortado ahí. Un tope que no deja tender ni la línea más cercana es un error. |
| DCA temporizado | `importe × compras máximas × apalancamiento` | `importe × compras máximas` (≤ capital, la app lo exige) | Un DCA que dura días paga **funding** todo ese tiempo (§9). |
| Martingala | Σ de los escalones = **capital × apalancamiento** | ≈ capital | `Tope de exposición` corta la escalera en el escalón que ya no cabe, y la Revisión la enseña cortada ahí, o antes si el stop o la liquidación llegan antes que un escalón. El último escalón suele ser el mayor de todos. |
| GridMart | Igual que Martingala | ≈ capital | La rejilla de ventas no añade exposición: vende trozos de lo comprado. |
| Market Maker (V1 y V2) | **Valor máximo de la posición**, en cualquiera de los dos sentidos. Es también el nocional que cuenta en tus límites | Ese valor ÷ apalancamiento | `capital asignado` **no** dimensiona nada aquí: es la base del ROI y de la pérdida diaria. Y no tienen `Tope de exposición`: su tope es el valor máximo de la posición. |
| Tendencia | `riesgo por operación / (multiplicador × ATR)` en cantidad, **acotado** por `capital × apalancamiento`, el margen disponible y el `Tope de exposición` | Ese notional ÷ apalancamiento | Lo que se arriesga **no** es el notional: es el `riesgo por operación`, porque el stop está puesto desde el primer momento. Si el tope recorta, se arriesga **menos** de lo declarado y la nota del bot lo dice. En aislado, una ruptura cuyo stop quedaría en la liquidación o detrás no se opera. |
| Seguimiento de beneficio | **capital × apalancamiento** en una sola posición, acotado por el margen disponible y el `Tope de exposición` | ≈ capital | No hay escalera: la posición entera existe desde el primer minuto. Y hasta llegar al objetivo la única red es el `stop loss`, que por eso viene puesto de fábrica (10 % del margen, un 5 % del precio a 2×). Al cerrarse **vuelve a abrir** pasada la espera. |
| Canal con IA | `riesgo / (distancia al stop + costes)`, acotado por `capital × nocional máximo`, `capital × apalancamiento` y el `Tope de exposición`. Es lo que cuenta como notional del bot en tus límites | notional ÷ apalancamiento, como mucho el `margen máximo` (25 % del capital) | Lo que se arriesga es el `riesgo por operación`: el stop está en el libro desde el llenado. En un hueco que salte el stop, lo más que se pierde es el margen de la operación. |
| Operación IA | La cantidad de su plan: `riesgo / (distancia al stop + costes)` sobre el capital del **agente**, con sus topes de margen y de apalancamiento | El de su plan, como mucho el `margen por operación` del agente (25 % de fábrica) | Como en el canal: lo que se arriesga es 1R, y en un hueco, el margen. **Una sola vez**: al cerrarse no vuelve a abrir. Un agente abre como mucho sus `operaciones a la vez` (2 de fábrica), y su pérdida diaria cuenta lo abierto al stop. |

---

## 9. Lo que ninguna pantalla te enseña: el funding

Los perpetuos cobran o pagan **financiación** de forma periódica (cada hora o cada ocho horas, según el
venue) a quien mantiene posición abierta. **La plataforma no lo modela ni lo muestra en ninguna parte**:
ni en el preview, ni en el PnL del bot, ni en el backtest (que lo declara en sus avisos de fidelidad).
En posiciones que duran días —un DCA en marcha, una escalera agotada esperando el rebote, una rejilla
con inventario— puede ser el mayor componente del resultado.

**Hasta que se modele:** mira la tasa de financiación del par en la web del exchange antes de dejar un
bot con inventario varios días, y cuenta con ella al fijar el take profit.
Estado: sin spec que lo modele; anotado en `specs/001-revision-integral/findings.md` § F-94.

---

## 10. Limitaciones conocidas de este capítulo

| Id | Qué | Hasta que se corrija |
|---|---|---|
| F-11 | Kill-switch = pérdida acumulada, no caída desde máximo (decisión de producto pendiente) | Trátalo como tope absoluto |

El spec `009-protecciones-y-cierre` (septiembre de 2026) corrigió el orden de «Parar y cerrar» (F-33),
la recolocación del stop (F-35), el mínimo al disparo (F-91), la acotación de `stopLossPct` y
`maxDailyLossPct` en la API (parte de F-13) y dos fallos de contabilidad de órdenes (F-36, F-37). El spec
`019-validacion-y-parametros-muertos` cerró el resto de F-13 (la API acota lo que el formulario acota), la
tasa de mantenimiento por mercado (F-93), el tope de apalancamiento explicado (F-44), el doble cómputo del
propio bot al editarlo (F-42) y la medianoche de la pérdida diaria (F-43).

El spec `080-roi-y-revision-profesional` (revisión en el `079`) pasó los % de resultado a % del margen,
dejó una sola fórmula de liquidación —la exacta, por lado—, añadió la regla del stop frente a la
liquidación, comprueba la escalera nivel a nivel, enseña la Revisión por lados, vuelve a validar al
arrancar, bloquea el cambio de apalancamiento con posición y hace que el simulador use el mantenimiento
de cada mercado (079/F-01 a F-29). Al rehacer las guías con él salieron y se cerraron F-30 a F-37: la
Revisión aplica el tope de exposición como el motor, la rejilla neutral lo aplica por lado, la tendencia no
entra con el stop detrás de la liquidación y el margen de cada nivel es su nocional entre el
apalancamiento.

El spec `057-stops-velas-y-simulador` corrigió dos cosas del stop:
- **Ya no se recoloca en cada revisión (057/F-01).** El motor comparaba el precio de ejecución que
  informa el exchange con el del stop deseado, lo daba por cambiado y lo cancelaba y volvía a
  colocar cada quince segundos, con la posición sin red entre medias. Ahora compara el disparo.
- **Tendencia ya no suelta su stop si le faltan velas (057/F-02).**
