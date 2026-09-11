# Seguimiento de beneficio

> Una operación, un objetivo a partir del cual el bot deja de mirar un precio fijo y empieza a
> seguir al máximo, y un retroceso que decide cuándo cierra.

**Riesgo: ALTO.** Es una posición direccional entera, sin escalera que promedie ni cotización que
recupere. Lee el apartado 1 antes que ningún otro.

---

## 1. Qué es esto, en cristiano

Pones dos números:

- **A partir de qué beneficio quieres que el bot empiece a proteger.** Por ejemplo, un 15 %.
- **Cuánto retroceso aguantas desde el máximo antes de cerrar.** Por ejemplo, un 1 %.

El bot abre la operación, y hasta ese 15 % no hace nada más que vigilar. Al llegar, coloca una
orden de cierre un 1 % por debajo del máximo y la va subiendo con el mercado. Nunca la baja. Cuando
el precio cae hasta ella, cierra.

La gracia es que **no tienes que adivinar el techo**. Con un objetivo fijo del 15 % cobras el 15 %
y ves cómo el precio sigue hasta el 40 % sin ti. Aquí te quedas dentro mientras suba.

### El riesgo, dicho claro

Tres cosas que hay que saber antes de encenderlo:

1. **Siempre cobras menos que el máximo.** Devuelves el retroceso: ese es el peaje de no tener que
   adivinar el techo. Y si el precio gira justo al tocar tu objetivo, cobras **menos que con un
   objetivo fijo**. Con 15 % y 1 %, lo mínimo que puedes cobrar es **+13,85 %**.
2. **Hasta que llega al objetivo no hay ninguna protección salvo el stop loss.** Esa fase puede
   durar días. Por eso esta es **la única estrategia de CRYPTON que nace con stop loss puesto**
   (5 %). Quitarlo deja la operación entera a la intemperie.
3. **Vuelve a entrar.** Al cerrarse la operación se cierra el ciclo y, pasada la espera (60 minutos
   de fábrica), el bot abre otra. **Es un bot, no una operación suelta.** Si querías una sola,
   párralo cuando cierre.

### Vocabulario mínimo

| Palabra | Qué significa aquí |
|---|---|
| **Objetivo / activación** | El beneficio a partir del cual empieza a seguir. **No** es el precio al que sale. |
| **Retroceso** | Cuánto tiene que caer desde el máximo para cerrar. En corto, cuánto tiene que subir desde el mínimo. |
| **Disparador** | La orden condicional que espera en el exchange. Sube con el máximo y nunca baja. |
| **Marca** | El precio que el exchange usa para liquidar. Es el que el bot mira, porque está suavizado y un mal precio suelto no puede inventarse un máximo. |

---

## 2. Cómo funciona por dentro, paso a paso

El motor revisa el bot **cada 15 segundos**; una ejecución dispara una revisión inmediata. Pero el
precio se mira **varias veces por segundo**: el máximo se cuenta también entre revisiones.

### Paso 1 — La entrada

Dos formas, y la eliges con **Cuándo entra**:

- **A mercado**: abre en la primera revisión, al precio que haya.
- **Cuando suba a / Cuando baje a**: el bot no coloca nada y espera a que la **marca** cruce tu
  precio. Entonces entra a mercado. Es un disparador, no una orden colgada en el libro: no ocupa
  cupo ni margen mientras espera.

El **tamaño** es `capital asignado × apalancamiento`, recortado por el margen disponible y por el
tope de exposición si lo pusiste. **Manda el menor de los tres.** No hay un campo de tamaño aparte
a propósito: un tercer sitio donde decir cuánto dinero se pone es un sitio donde equivocarse.

### Paso 2 — La espera

Mientras el beneficio no llegue a tu objetivo, **no hay ninguna orden de beneficio en el libro**.
No es un olvido: por debajo del objetivo no hay nada que asegurar, y poner algo ahí sería salir
antes de lo que pediste.

Lo que sí hay es el **stop loss**, como orden condicional nativa del exchange.

### Paso 3 — La activación

En cuanto el máximo toca tu objetivo, el bot:

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

El nivel de entrada con su tamaño y el precio del objetivo, más un aviso que repite lo importante:
**ese precio no es al que sales**, y te da el suelo de lo que puedes cobrar.

---

## 3. Cómo configurarlo con poco riesgo

### Las cuatro reglas de oro

1. **El objetivo, por encima de lo que el par se mueve en un día normal.** Si BTC respira un 3 % al
   día y pones el objetivo en el 1 %, el bot se activa con el ruido de la mañana.
2. **El retroceso, por encima de lo que el par se mueve en una hora.** Por debajo del 0,5 % en algo
   que se mueve un 1-3 % al día, sales en el primer respiro. La app te avisa.
3. **Deja el stop loss puesto.** Es la única red hasta que se llega al objetivo.
4. **Apalancamiento bajo.** Es una posición direccional entera. A 5× una caída del 20 % te liquida
   antes de que ninguna de tus órdenes tenga nada que decir.

### Configuración A — «Dejar correr un movimiento en BTC»

| Campo | Valor |
|---|---|
| Par | BTC/USDC |
| Capital asignado | 1.000 USDC |
| Apalancamiento | 2× |
| Cuándo entra | A mercado |
| Beneficio al que empieza a seguir | 15 % |
| Retroceso para salir | 1 % |
| Stop loss | 5 % |
| Espera entre ciclos | 60 min |

Abre 2.000 USDC de posición. Hasta +15 % solo protege el stop. En +15 % el disparador nace en
+13,85 %. Si BTC se va al +40 %, cierra en +38,6 %. Si gira nada más tocar el objetivo, cobra el
13,85 %.

### Configuración B — «Comprar una caída concreta de ETH»

| Campo | Valor |
|---|---|
| Par | ETH/USDT |
| Capital asignado | 500 USDT |
| Apalancamiento | 1× |
| Cuándo entra | Cuando baje a |
| Precio de entrada | 2.800 |
| Beneficio al que empieza a seguir | 8 % |
| Retroceso para salir | 2 % |
| Stop loss | 6 % |

Mientras ETH no toque 2.800, el bot no abre nada y no cuesta nada. Si lo toca, entra y a +8 %
(3.024) arma el seguimiento con el disparador en 2.963.

### Configuración C — «Corto en un techo»

Lo mismo pero con **Dirección: Corto** y **Cuándo entra: Cuando suba a**. Todo se invierte: el bot
sigue al **mínimo** y el disparador va **por encima**, bajando con el mercado y sin subir nunca.

### Checklist antes de arrancar

- [ ] ¿El objetivo está por encima del recorrido típico de un día del par?
- [ ] ¿El retroceso está por encima del de una hora?
- [ ] ¿El stop loss sigue puesto?
- [ ] ¿Entiendes que vas a cobrar el máximo **menos** el retroceso?
- [ ] ¿Entiendes que al cerrar vuelve a abrir?
- [ ] ¿El apalancamiento deja la liquidación más lejos que tu stop?

### Señales de alarma cuando ya está funcionando

| Lo que ves | Qué significa |
|---|---|
| Cierra a los pocos minutos de activarse, una y otra vez | El retroceso es demasiado fino para el par. Súbelo. |
| No se activa nunca | El objetivo está por encima de lo que el par se mueve. Bájalo, o cambia de par. |
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

#### Dirección · `direction` · ❄️ en frío · por defecto **Largo**

En corto todo se invierte: sigue al mínimo y el disparador va por encima, bajando con el mercado.

#### Capital asignado · `totalInvestment` · 🌤️ en tibio · ⚠️ campo de riesgo

Aquí es literalmente el tamaño de la operación: `capital × apalancamiento` es el nocional que abre,
si el margen y el tope lo permiten.

#### Tope de exposición · `maxNotionalCap` · 🔥 en caliente

El mando con el que se opera con **menos** de todo el capital asignado. Manda el menor de los tres
topes.

#### Cuándo entra · `activationMode` · 🔥 en caliente · por defecto **A mercado**

**A mercado** abre en la primera revisión. **Cuando suba a** / **Cuando baje a** esperan a que la
marca cruce tu precio, sin colocar nada en el libro mientras tanto.

#### Precio de entrada · `activationPrice` · 🔥 en caliente

El nivel que tiene que cruzar la marca. Solo se usa si la entrada no es «A mercado». Es un
disparador, no una orden límite: al cruzarse, el bot entra a mercado al precio que haya.

#### Beneficio al que empieza a seguir (%) · `takeProfitPct` · 🔥 en caliente · 0,1–500 · por defecto **15**

**No es el precio al que sale.** Es el beneficio, sobre tu precio de entrada, a partir del cual la
salida deja de ser fija y empieza a seguir al máximo.

**Consejo**: por encima del recorrido típico de un día del par. Lo mínimo que cobrarás es este
número menos el retroceso.

#### Retroceso para salir (%) · `trailingCallbackPct` · 🔥 en caliente · 0,1–10 · por defecto **1**

Cuánto tiene que caer el precio desde el máximo para que cierre. Pequeño asegura casi todo el
máximo pero te saca en la primera sacudida; grande aguanta el ruido y te deja correr la tendencia, a
cambio de devolver más cuando gire.

**Consejo**: mídelo contra lo que respira tu par, no en abstracto.

#### Umbral para mover el disparador (bps) · `trailingRepriceBps` · 🔥 en caliente · 1–200 · por defecto **20**

Cuánto tiene que avanzar el disparador para que el bot lo mueva de verdad en el exchange. 20 bps son
un 0,2 %. Existe porque mover la orden son **dos peticiones**, y en **Lighter** el cupo son 60 por
minuto **de toda tu IP**.

#### Stop loss (%) · `stopLossPct` · 🔥 en caliente · por defecto **5** · ⚠️ campo de riesgo

La única protección hasta que se llega al objetivo. Esta es la única estrategia que nace con stop
puesto, y es a propósito.

#### Espera entre ciclos (min) · `cooldownMinutes` · 🔥 en caliente · por defecto **60**

Cuánto espera desde que cierra una operación hasta que abre la siguiente. Con 0 volvería a entrar
en el mismo minuto, al precio que acaba de dejar.

---

## 6. Resumen de valores de fábrica

| Campo | Por defecto | ¿Lo cambio? |
|---|---|---|
| Dirección | Largo | Según tu tesis |
| Apalancamiento | 2× | 🟡 1× si no lo tienes claro |
| Modo de margen | Aislado | ✅ Déjalo |
| Cuándo entra | A mercado | Según tu tesis |
| Beneficio al que empieza a seguir | 15 % | 🔴 **Ajústalo al par**: por encima de un día típico |
| Retroceso para salir | 1 % | 🔴 **Ajústalo al par**: por encima de una hora típica |
| Umbral para mover el disparador | 20 bps | ✅ Déjalo; súbelo en Lighter |
| Stop loss | 5 % | ✅ Déjalo puesto |
| Espera entre ciclos | 60 min | 🟡 Súbelo si no quieres que encadene |
| Al acercarse la liquidación | Solo avisar | 🟡 «Cerrar todo» a 2× o más |

---

## 7. ¿Esta u otra?

| | **Seguimiento de beneficio** | [Tendencia](./trend-follow.md) | [DCA temporizado](./tdca.md) |
|---|---|---|---|
| Cuándo entra | Ya, o al cruzar tu precio | Cuando rompe su canal de N velas | Por reloj, si mejora la media |
| Qué mira | El precio | Velas, canal, ATR y eficiencia | El reloj y tu precio medio |
| Tamaño | Capital × apalancamiento | `riesgo / (k × ATR)` | Importe fijo por compra |
| Salida | Sigue al máximo desde tu objetivo | Stop de ATR desde el primer momento | Precio fijo sobre la media |
| Objetivo de beneficio | Sí, como punto de partida | **No**, a propósito | Sí, fijo |
| Nº de entradas por ciclo | 1 | 1 | Hasta las que digas |

**Si dudas entre esta y Tendencia**: Tendencia decide **cuándo** entrar por ti y no tiene objetivo;
esta te deja decidir a ti la entrada y protege a partir de un objetivo. Tendencia es para quien no
tiene tesis; esta, para quien sí la tiene.

---

## 8. Limitaciones conocidas

- **El backtest sigue al máximo con retraso.** El replay corre una revisión por vela y mide el
  máximo sobre el cierre, así que no ve ni el recorrido dentro de la vela ni lo que el motor ve
  entre revisiones. Los dos huecos empujan en la misma dirección: **el replay sale por debajo de lo
  que saldría en real**. El aviso va con el resultado.
- **Sin funding.** Ni el bot lo mira ni el backtest lo simula. En una posición de varios días puede
  ser el mayor componente del resultado.
- **El máximo de los últimos quince segundos no sobrevive a un reinicio del worker.** Lo que se
  guarda es el máximo de la operación; el de la ventana entre revisiones vive en memoria. El peor
  caso es que el bot salga **un poco más abajo**, nunca más arriba.
