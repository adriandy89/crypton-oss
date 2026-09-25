# Seguimiento de beneficio

> Una operación, un objetivo a partir del cual el bot deja de mirar un precio fijo y empieza a
> seguir al máximo, y un retroceso que decide cuándo cierra.

**Riesgo: ALTO.** Es una posición direccional entera, sin escalera que promedie ni cotización que
recupere. Lee el apartado 1 antes que ningún otro.

---

## 1. Qué es esto, en cristiano

Pones dos números:

- **A partir de qué beneficio sobre tu margen quieres que el bot empiece a proteger.** Por ejemplo,
  el 30 % de fábrica: al apalancamiento de fábrica, 2×, es un +15 % del precio.
- **Cuánto retroceso del precio aguantas desde el máximo antes de cerrar.** Por ejemplo, un 1 %.

El bot abre la operación, y hasta ese +15 % del precio no hace nada más que vigilar. Al llegar,
coloca una orden de cierre un 1 % por debajo del máximo y la va subiendo con el mercado. Nunca la
baja. Cuando el precio cae hasta ella, cierra.

Los dos números no se miden igual, y es a propósito. El objetivo es un **% de tu margen**, como el
TP por ROI de un exchange: se divide por el apalancamiento para saber cuánto tiene que moverse el
precio, así que a 15× el mismo 30 % es solo un +2 % del precio. El retroceso es un **% del
precio**, como el «callback rate» del trailing de Binance, y no cambia con el apalancamiento.

La gracia es que **no tienes que adivinar el techo**. Con un objetivo fijo en +15 % del precio
cobras ese 15 % y ves cómo el precio sigue hasta el +40 % sin ti. Aquí te quedas dentro mientras
suba.

### El riesgo, dicho claro

Tres cosas que hay que saber antes de encenderlo:

1. **Siempre cobras menos que el máximo.** Devuelves el retroceso: ese es el peaje de no tener que
   adivinar el techo. Y si el precio gira justo al tocar tu objetivo, cobras **menos que con un
   objetivo fijo**. Con los valores de fábrica —30 % del margen a 2× y retroceso del 1 %— lo mínimo
   que puedes cobrar es un **+13,85 %** del precio: un 27,7 % del margen, sin comisiones.
2. **Hasta que llega al objetivo no hay ninguna protección salvo el stop loss.** Esa fase puede
   durar días. Por eso esta es **la única estrategia de CRYPTON que nace con stop loss puesto**
   (10 % del margen, un −5 % del precio a 2×). Quitarlo deja la operación entera a la intemperie.
3. **Vuelve a entrar.** Al cerrarse la operación se cierra el ciclo y, pasada la espera (60 minutos
   de fábrica), el bot abre otra. **Es un bot, no una operación suelta.** Si querías una sola,
   párralo cuando cierre.

### Vocabulario mínimo

| Palabra | Qué significa aquí |
|---|---|
| **Objetivo / activación** | El beneficio, en % de tu margen, a partir del cual empieza a seguir. **No** es el precio al que sale. |
| **Retroceso** | Cuánto tiene que caer el precio desde el máximo para cerrar, en % del precio. En corto, cuánto tiene que subir desde el mínimo. |
| **Disparador** | La orden condicional que espera en el exchange. Sube con el máximo y nunca baja. |
| **Marca** | El precio que el exchange usa para liquidar. Es el que el bot mira, porque está suavizado y un mal precio suelto no puede inventarse un máximo. |

---

## 2. Cómo funciona por dentro, paso a paso

El motor revisa el bot **cada 15 segundos**; una ejecución dispara una revisión inmediata. Pero el
precio se mira **varias veces por segundo**: el máximo se cuenta también entre revisiones.

### Paso 1 — La entrada

Dos formas, y la eliges con **Cuándo entra**:

- **Sin condición**: abre a mercado en la primera revisión, al precio que haya.
- **Cuando suba a / Cuando baje a**: el bot no coloca nada y espera a que la **marca** cruce tu
  precio. Entonces entra a mercado. Es un disparador, no una orden colgada en el libro: no ocupa
  cupo ni margen mientras espera. Si al crearlo la marca **ya está** al otro lado de tu precio, la
  condición ya se cumple y entra en el acto, al precio de ese momento; la Revisión lo avisa y lo
  calcula todo sobre el precio de hoy.

El **tamaño** es `capital asignado × apalancamiento`, recortado por el margen disponible y por el
tope de exposición si lo pusiste. **Manda el menor de los tres.** No hay un campo de tamaño aparte
a propósito: un tercer sitio donde decir cuánto dinero se pone es un sitio donde equivocarse.

### Paso 2 — La espera

Mientras el beneficio no llegue a tu objetivo, **no hay ninguna orden de beneficio en el libro**.
No es un olvido: por debajo del objetivo no hay nada que asegurar, y poner algo ahí sería salir
antes de lo que pediste.

Lo que sí hay es el **stop loss**, como orden condicional nativa del exchange, a
`entrada × (1 − stop / (100 × apalancamiento))` (en corto, sumando): con el de fábrica a 2×, un 5 %
por debajo de la entrada.

### Paso 3 — La activación

El objetivo está en `entrada × (1 + objetivo / (100 × apalancamiento))` (en corto, restando). En
cuanto el máximo lo toca, el bot:

1. Se lo apunta. **El armado es irreversible dentro de la operación**: si el precio vuelve a bajar,
   el seguimiento no se desarma. Ya hay algo que proteger.
2. Coloca el disparador en `máximo × (1 − retroceso)`.

### Paso 4 — El seguimiento

Cada revisión, el bot toma el mayor de tres cosas —el máximo que ya tenía guardado, el que ha visto
el flujo de precios desde la última revisión, y el precio de ahora— y recalcula el disparador. **Si
sale más alto, lo sube. Si sale más bajo, no hace nada.**

Solo lo mueve de verdad en el exchange cuando avanza más que el **umbral de reprecio** (0,2 % de
fábrica). Sin ese umbral, un mercado que sube despacio haría que el bot cancelara y recolocara la
orden cada quince segundos.

### Paso 5 — El cierre, y el ciclo siguiente

El disparador es una orden **condicional nativa**: se ejecuta en el exchange aunque CRYPTON esté
caído y aunque la caída ocurra entre dos revisiones. Al ejecutarse se cierra el ciclo, se borra el
máximo guardado y arranca la espera. Pasada la espera, el bot abre otra operación.

### Lo que la vista previa te enseña

La Revisión enseña la posición como la confirmación de un exchange: el lado (largo o corto), la
entrada, el tamaño (cantidad y nocional) y el margen, y debajo sus tres salidas —**Objetivo ·
empieza a seguir**, **Stop** y **Liquidación**— con el precio en la retícula, el movimiento del
precio desde la entrada y desde el último precio, el resultado en USDC **sin comisiones** y el %
sobre el margen, más la relación beneficio/riesgo. Junto al objetivo, una nota repite lo importante:
**ese precio no es al que sales**. Y un aviso da el suelo de lo que puedes cobrar.

La entrada es el precio al que va a entrar de verdad: el de hoy sin condición; el de tu disparo si
la condición espera («Calculado sobre el precio de entrada…, no sobre el de ahora»); y otra vez el
de hoy si la condición ya se cumple al crearlo («El precio de hoy ya cumple la condición de entrada:
el bot entra a mercado al crearse…»). Hasta el spec 080 la Revisión usaba el precio de disparo
también en este último caso, y enseñaba una entrada que no iba a ser la real (079/F-05).

---

## 3. Cómo configurarlo con poco riesgo

### Las cuatro reglas de oro

1. **El objetivo, en precio, por encima de lo que el par se mueve en un día normal.** Se escribe en
   % del margen, así que divídelo por el apalancamiento: a 2×, el 30 % de fábrica es un 15 % del
   precio; a 10×, un 3 %. Si BTC respira un 3 % al día y el objetivo queda en un 1 % del precio, el
   bot se activa con el ruido de la mañana.
2. **El retroceso, por encima de lo que el par se mueve en una hora.** Por debajo del 0,5 % en algo
   que se mueve un 1-3 % al día, sales en el primer respiro. La app te avisa.
3. **Deja el stop loss puesto.** Es la única red hasta que se llega al objetivo. Y tiene que saltar
   antes que la liquidación: en margen aislado la app no te deja crear un stop que quede en ella o
   detrás, y te propone el más ancho válido.
4. **Apalancamiento bajo.** Es una posición direccional entera. A 5× en BTC de Hyperliquid
   (mantenimiento 1,25 %) la liquidación está a un 18,99 % de la entrada en largo y a un 18,52 % en
   corto: una caída del 20 % te liquida si el stop no ha saltado antes. Y todo se acerca en precio:
   a 5× el stop de fábrica del 10 % es un 2 % del precio, y el objetivo del 30 %, un 6 %.

### Configuración A — «Dejar correr un movimiento en BTC»

Precios del 24-08-2026 (`venue-markets.ts`), Hyperliquid, BTC a **78.910 USDC** (mantenimiento
1,25 %).

| Campo | Valor |
|---|---|
| Par | BTC/USDC (Hyperliquid) |
| Capital asignado | 1.000 USDC |
| Apalancamiento | 2× |
| Cuándo entra | Sin condición (a mercado) |
| Beneficio al que empieza a seguir (sobre el margen) | 30 % |
| Retroceso para salir (del precio) | 1 % |
| Stop loss (sobre el margen) | 10 % |
| Espera entre ciclos | 60 min |

Abre 0,02534 BTC: 1.999,58 USDC de posición sobre 1.000 de margen. A 2×, el objetivo del 30 % del
margen es un +15 % del precio y el stop del 10 %, un −5 %. La Revisión:

| Salida | Precio | Precio desde la entrada | Resultado | Sobre el margen |
|---|---|---|---|---|
| Objetivo · empieza a seguir | 90.747 | +15,00 % | +299,95 USDC | +30,00 % |
| Stop | 74.965 | −5,00 % | −99,97 USDC | −10,00 % |
| Liquidación | 39.955 | −49,37 % | −987,12 USDC | −98,73 % |

Beneficio/riesgo, 3,00. Hasta +15 % solo protege el stop. En +15 % el disparador nace en +13,85 %
(89.840, el suelo que da el aviso): lo mínimo que puedes cobrar, un 27,7 % del margen. Si BTC se va
al +40 %, cierra en +38,6 % (un 77,2 % del margen). Si gira nada más tocar el objetivo, cobra el
13,85 % del precio: menos que un objetivo fijo del 15 %, y eso no es un fallo, es el peaje.

### Configuración B — «Comprar una caída concreta de ETH»

Aster, ETH/USDT. Supón ETH a **3.000 USDT** al crearlo.

| Campo | Valor |
|---|---|
| Par | ETH/USDT (Aster) |
| Capital asignado | 500 USDT |
| Apalancamiento | 1× |
| Cuándo entra | Cuando baje a |
| Precio de entrada | 2.800 |
| Beneficio al que empieza a seguir (sobre el margen) | 8 % |
| Retroceso para salir (del precio) | 2 % |
| Stop loss (sobre el margen) | 6 % |

A 1× el % del margen y el del precio coinciden: el objetivo del 8 % es un +8 % del precio y el stop
del 6 %, un −6 %. Mientras ETH no toque 2.800, el bot no abre nada y no cuesta nada. Si lo toca,
entra (la Revisión lo calcula sobre 2.800: 0,178 ETH, 498,40 USDT) y a 3.024,00 (+8 %, +39,87 USDT)
arma el seguimiento con el disparador en 2.963,52. Si el rebote llega a 3.300, cierra en 3.234. El
stop queda en 2.632,00 (−29,90 USDT), y a 1× en largo no hay liquidación.

**Ojo con el precio de hoy.** Si al crearlo ETH ya está en 2.800 o por debajo —el 24-08-2026
cotizaba a 2.503,35 en Aster—, la condición ya se cumple: el bot entra a mercado **en el acto**, al
precio de hoy. La Revisión lo avisa y calcula todo sobre ese precio: 0,199 ETH, objetivo en
2.703,62 y suelo en 2.649,55. Si lo que querías era esperar a que bajara, eso no es lo que va a
pasar.

### Configuración C — «Corto en un techo»

Lo mismo pero con **Dirección: Corto** y **Cuándo entra: Cuando suba a**. Todo se invierte: el bot
sigue al **mínimo** y el disparador va **por encima**, bajando con el mercado y sin subir nunca.

Con BTC a 78.910 en Hyperliquid (mantenimiento 1,25 %), 1.000 USDC a 2× y «Cuando suba a 82.000»:
si entra en 82.000, el objetivo queda en 69.700 (−15 % del precio, +300,00 USDC, +30 % del margen),
el suelo de lo que cobra en 70.397 (−14,15 %), el stop en 86.100 (+5 %, −100,00 USDC) y la
liquidación en 121.481 (+48,15 %: en corto llega antes que el 49,37 % del largo). Y en corto un
objetivo no puede llevar el precio a cero: a 2×, un 200 % del margen es un error.

### Checklist antes de arrancar

- [ ] ¿El objetivo, en precio (el % del margen entre el apalancamiento), está por encima del recorrido típico de un día del par?
- [ ] ¿El retroceso está por encima del de una hora?
- [ ] ¿El stop loss sigue puesto, y por delante de la liquidación con holgura? (la app te lo dice)
- [ ] ¿Entiendes que vas a cobrar el máximo **menos** el retroceso?
- [ ] ¿Entiendes que al cerrar vuelve a abrir?
- [ ] Con una condición de entrada: ¿el precio de hoy está todavía del lado bueno de tu disparo? Si no, entra en el acto.

### Señales de alarma cuando ya está funcionando

| Lo que ves | Qué significa |
|---|---|
| Cierra a los pocos minutos de activarse, una y otra vez | El retroceso es demasiado fino para el par. Súbelo. |
| No se activa nunca | El objetivo, en precio, está por encima de lo que el par se mueve. Bájalo, o cambia de par. |
| El stop salta antes de llegar al objetivo, repetidamente | Tu tesis direccional no está funcionando. Esto no lo arregla un parámetro. |
| Avisos de límite de peticiones en Lighter | Sube el umbral de reprecio. |

---

## 4. Lo que este bot NO mira (importante)

- **No mira velas, ni indicadores, ni tendencia.** Solo el precio y tus dos números. Si quieres que
  entre por señal técnica, la estrategia es [Tendencia](./trend-follow.md).
- **No promedia.** Una entrada y una salida. Si el precio va en contra, no compra más barato: eso
  es [Martingala](./martingale.md) o el [DCA temporizado](./tdca.md).
- **No mira el funding.** En una posición que dure días, el funding puede pesar más que el
  movimiento del precio.
- **No sabe cuánto has ganado en otras operaciones.** Cada ciclo empieza de cero.

---

## 5. Parámetros configurables, uno a uno

🔥 en caliente (siguiente revisión) · 🌤️ en tibio (cancela y recoloca órdenes) · ❄️ en frío (hay
que crear otro bot).

Los % **sobre el margen** —el objetivo y el stop— tienen un máximo que escala con el apalancamiento
`L`, para que el tope en precio no cambie: 500 % del precio el objetivo, 90 % el stop. A 2× el
formulario deja llegar a 1.000 y a 180.

#### Conexión de exchange · `exchangeAccountId` · ❄️ en frío

La cuenta con la que opera el bot (real, pruebas o simulación). Si es el primero, la cuenta
«Simulación».

#### Par · `symbol` · ❄️ en frío

Fija el mínimo de orden, el paso de cantidad, el apalancamiento máximo y el mantenimiento con el
que se calcula la liquidación.

#### Dirección · `direction` · ❄️ en frío · por defecto **Largo**

En corto todo se invierte: sigue al mínimo y el disparador va por encima, bajando con el mercado.

#### Capital asignado · `totalInvestment` · 🌤️ en tibio · mínimo 10 · ⚠️ campo de riesgo

Aquí es literalmente el tamaño de la operación: `capital × apalancamiento` es el nocional que abre,
si el margen y el tope lo permiten.

#### Tope de exposición · `maxNotionalCap` · 🔥 en caliente · opcional

El mando con el que se opera con **menos** de todo el capital asignado. Manda el menor de los tres
topes. Si queda por debajo de `capital × apalancamiento`, el formulario lo dice: con 1.500 en la
configuración A, «El tope de exposición (1500.00) es menor que el capital por el apalancamiento
(2000.00): la posición no pasará de 1500.00».

#### Cuándo entra · `activationMode` · 🔥 en caliente · por defecto **Sin condición**

**Sin condición** abre a mercado en la primera revisión. **Cuando suba a** / **Cuando baje a**
esperan a que la marca cruce tu precio, sin colocar nada en el libro mientras tanto; si al crearlo
ya lo ha cruzado, entra en el acto. Al cerrarse una operación la condición vuelve a evaluarse desde
cero para la siguiente.

#### Precio de entrada · `activationPrice` · 🔥 en caliente · opcional

El nivel que tiene que cruzar la marca. Solo se usa si la entrada no es «Sin condición», y entonces
es obligatorio. Es un disparador, no una orden límite: al cruzarse, el bot entra a mercado al precio
que haya.

#### Beneficio al que empieza a seguir (sobre el margen) · `takeProfitPct` · 🔥 en caliente · 0,1–500·L · por defecto **30**

**No es el precio al que sale.** Es el beneficio sobre tu margen, medido desde tu precio de entrada,
a partir del cual la salida deja de ser fija y empieza a seguir al máximo: a 2×, un 30 % es un
+15 % del precio; a 15×, un +2 %. En corto, un objetivo que llevaría el precio a cero es un error.
Debajo del campo el formulario enseña su equivalente en vivo; con la configuración A, «= 15,00 % de
precio · 90.747 (+299,95 USDC)».

Hasta el spec 080 era un % del precio y venía a 15; el 30 de ahora es el mismo punto al
apalancamiento de fábrica, 2×.

**Consejo**: que en precio quede por encima del recorrido típico de un día del par. Lo mínimo que
cobrarás es la activación menos el retroceso medido desde ella —un +13,85 % del precio con los
valores de fábrica—, y la Revisión te lo da en precio.

#### Retroceso para salir (del precio) · `trailingCallbackPct` · 🔥 en caliente · 0,1–10 · por defecto **1**

Cuánto tiene que caer el precio desde el máximo para que cierre, en % del **precio**: no cambia con
el apalancamiento. Pequeño asegura casi todo el máximo pero te saca en la primera sacudida; grande
aguanta el ruido y te deja correr la tendencia, a cambio de devolver más cuando gire.

La app avisa de dos cosas. Por debajo del 0,5 %, de que sales en el primer respiro. Y si el
retroceso se come la activación —en largo, con `retroceso ≥ t / (1 + t)`; en corto, con
`retroceso ≥ t / (1 − t)`, donde `t` es el objetivo en precio—, de que lo mínimo que cobras queda
del lado malo de la entrada: con un 6 % del margen a 2× (un 3 % del precio), un retroceso del 3 % ya
avisa y uno del 2,9 %, no.

**Consejo**: mídelo contra lo que respira tu par, no en abstracto.

#### Umbral para mover el disparador (bps) · `trailingRepriceBps` · 🔥 en caliente · 1–200 · por defecto **20**

Cuánto tiene que avanzar el disparador para que el bot lo mueva de verdad en el exchange. 20 bps son
un 0,2 %. Existe porque mover la orden son **dos peticiones**, y en **Lighter** el cupo son 60 por
minuto **de toda tu IP**.

#### Stop loss (sobre el margen) · `stopLossPct` · 🔥 en caliente · 0,1–90·L · por defecto **10** · ⚠️ campo de riesgo

La única protección hasta que se llega al objetivo. Esta es la única estrategia que nace con stop
puesto, y es a propósito: sin él, la app avisa de que no hay ninguna protección hasta el objetivo.
Es la pérdida sobre tu margen, medida desde la entrada: a 2×, el 10 % de fábrica es un −5 % del
precio (hasta el spec 080 era un % del precio y venía a 5: es el mismo punto a 2×). El formulario
lo enseña debajo del campo; con la configuración A, «= 5,00 % de precio · 74.965 (−99,97 USDC)».
Si el exchange tiene la posición a más apalancamiento que la configuración, el stop se calcula con
el del exchange —el más estrecho— y el bot avisa una vez (`LEVERAGE_SKIPPED`).

Tiene que saltar antes que la liquidación. En margen aislado, un stop en la liquidación o detrás es
un error, y uno que la deje a menos de medio stop detrás, un aviso; en cruzado, los dos son avisos.
Los dos proponen el más ancho válido, que el formulario aplica con un toque («Usar el stop más
ancho válido»). Con BTC en Hyperliquid (mantenimiento 1,25 %), a 2× en largo es un 65,8 % del
margen. A 15× en corto —el caso que dio pie al spec 079— y con un stop del 90 %, el formulario lo
rechaza: «A 15× la liquidación llega con un 5.35 % de movimiento en contra, al perder el 80.2 % del
margen: un stop del 90 % no saltaría nunca, el venue liquida antes. El más ancho que deja medio stop
de holgura es 53.4 %».

#### Pérdida diaria máxima (sobre el capital) · `maxDailyLossPct` · 🔥 en caliente · 0,1–100

Pérdida realizada hoy por este bot, en % de su **capital asignado** (no del margen de la posición), a
partir de la cual se pausa.

#### Al acercarse la liquidación · `liquidationAction` · 🔥 en caliente · por defecto **Solo avisar** · ⚠️ campo de riesgo

Solo avisar / Pausar el bot / Cerrar todo, cuando la distancia a la liquidación baja del umbral de
aviso. A 1× en largo no aplica: no hay liquidación.

#### Espera entre ciclos (min) · `cooldownMinutes` · 🔥 en caliente · 0–10080 · por defecto **60**

Cuánto espera desde que cierra una operación hasta que abre la siguiente. Con 0 volvería a entrar
en el mismo minuto, al precio que acaba de dejar.

#### Apalancamiento · `leverage` · 🌤️ en tibio · 1–50 · por defecto **2** · ⚠️ campo de riesgo

Multiplica ganancia y pérdida, acerca la liquidación y decide qué significan en precio el objetivo
y el stop: el mismo 30 % del margen es un 15 % del precio a 2× y un 3 % a 10×. Por encima de 10× la
app avisa con la distancia exacta a la liquidación y lo que se habrá perdido del margen al llegar.
Con la posición abierta **no se puede cambiar**: la API responde 409 (`LEVERAGE_WITH_POSITION`),
porque movería en silencio el objetivo, el stop y la liquidación de la operación abierta.

#### Modo de margen · `marginMode` · ❄️ en frío · por defecto **Aislado**

Aislado: lo máximo que pierde este bot es su margen, y un stop detrás de la liquidación no se
acepta. Cruzado: liquidación más lejos, riesgo compartido con los otros bots de la cuenta.

---

## 6. Resumen de valores de fábrica

| Campo | Por defecto | ¿Lo cambio? |
|---|---|---|
| Dirección | Largo | Según tu tesis |
| Apalancamiento | 2× | 🟡 1× si no lo tienes claro |
| Modo de margen | Aislado | ✅ Déjalo |
| Cuándo entra | Sin condición (a mercado) | Según tu tesis |
| Beneficio al que empieza a seguir | 30 % del margen (+15 % del precio a 2×) | 🔴 **Ajústalo al par**: en precio, por encima de un día típico |
| Retroceso para salir | 1 % del precio | 🔴 **Ajústalo al par**: por encima de una hora típica |
| Umbral para mover el disparador | 20 bps | ✅ Déjalo; súbelo en Lighter |
| Stop loss | 10 % del margen (−5 % del precio a 2×) | ✅ Déjalo puesto |
| Espera entre ciclos | 60 min | 🟡 Súbelo si no quieres que encadene |
| Al acercarse la liquidación | Solo avisar | 🟡 «Cerrar todo» a 2× o más |

---

## 7. ¿Esta u otra?

| | **Seguimiento de beneficio** | [Tendencia](./trend-follow.md) | [DCA temporizado](./tdca.md) |
|---|---|---|---|
| Cuándo entra | Ya, o al cruzar tu precio | Cuando rompe su canal de N velas | Por reloj, si mejora la media |
| Qué mira | El precio | Velas, canal, ATR y eficiencia | El reloj y tu precio medio |
| Tamaño | Capital × apalancamiento | `riesgo / (k × ATR)` | Importe fijo por compra |
| Salida | Sigue al máximo desde tu objetivo | Stop de ATR desde el primer momento | Precio fijo sobre la media (o que sigue, con «Seguir al máximo») |
| Objetivo de beneficio | Sí, como punto de partida | **No**, a propósito | Sí |
| Nº de entradas por ciclo | 1 | 1 | Hasta las que digas |

**Si dudas entre esta y Tendencia**: Tendencia decide **cuándo** entrar por ti y no tiene objetivo;
esta te deja decidir a ti la entrada y protege a partir de un objetivo. Tendencia es para quien no
tiene tesis; esta, para quien sí la tiene.

---

## 8. Limitaciones conocidas

- **El backtest mueve el disparador una vez por vela.** Lo mueve con el máximo que alcanzó la vela,
  como la marca de agua del motor. Pero si el precio retrocede dentro de esa misma vela, el motor
  saldría en ella y **el replay sale en la siguiente**, al precio del disparador. El aviso va con
  el resultado. Hasta el spec 057 (F-04) el replay medía el máximo sobre el cierre y salía más
  abajo de lo que saldría en real.
- **Sin funding.** Ni el bot lo mira ni el backtest lo simula. En una posición de varios días puede
  ser el mayor componente del resultado.
- **El máximo de los últimos quince segundos no sobrevive a un reinicio del worker.** Lo que se
  guarda es el máximo de la operación; el de la ventana entre revisiones vive en memoria. El peor
  caso es que el bot salga **un poco más abajo**, nunca más arriba.
