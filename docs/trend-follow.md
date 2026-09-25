# Tendencia — guía completa

> Estrategia `TREND_FOLLOW`.
> Código: [`trend-follow.ts`](../packages/strategy-core/src/strategies/trend-follow.ts) · indicadores en [`indicadores.ts`](../packages/strategy-core/src/indicadores.ts)

---

## 1. Qué es esto, en cristiano

Casi todas las demás estrategias de la plataforma hacen variaciones de lo mismo: **comprar barato y
vender caro dentro de un rango**. Una rejilla pone escalones, un market maker pone las dos puntas,
una martingala promedia a la baja. Todas ellas viven del **ir y venir** del precio.

Esta hace lo contrario. No compra barato: **compra caro, cuando el precio acaba de romper hacia
arriba**, y espera que siga subiendo. Y vende barato cuando rompe hacia abajo.

Suena mal dicho así, y es exactamente el punto: **es la única que gana cuando el precio se va en
línea recta**, que es el escenario en el que todas las demás pierden.

### El ciclo, en cuatro frases

1. Mira el máximo y el mínimo de las últimas N velas.
2. Si el precio cierra por encima de ese máximo, **compra**. Si cierra por debajo del mínimo,
   **vende en corto**.
3. Pone un stop a cierta distancia, medida en **ATR** (cuánto se mueve este par normalmente).
4. Ese stop **va siguiendo al precio** y nunca retrocede. Cuando salta, la operación termina.

No hay objetivo de beneficio. La operación dura lo que dure la tendencia.

### El riesgo, dicho claro

**Vas a perder más veces de las que ganas.** Una ruptura acierta en torno a **cuatro de cada
diez**. Seis de cada diez operaciones se cierran en el stop, con pérdida, y eso **es el
funcionamiento normal**, no una avería.

Lo que hace que gane dinero de todos modos es que las cuatro que aciertan pueden multiplicar por
cinco o por diez lo que pierden las seis que fallan. Por eso **no hay objetivo de beneficio**: un
objetivo fijo corta justo lo que da de comer.

Si ver cinco operaciones perdedoras seguidas te va a hacer apagar el bot, esta estrategia no es
para ti — y eso no es un defecto suyo.

### Vocabulario mínimo

| Palabra | Qué significa aquí |
| --- | --- |
| **ATR** | Cuánto se mueve este par en una vela, de media. Es la unidad con la que se mide todo aquí |
| **Canal** | El máximo y el mínimo de las últimas N velas. Romperlo es la señal |
| **Eficiencia** | Cuánto del recorrido del precio es avance de verdad. 1 = línea recta, 0 = ir y venir |
| **Trailing** | El stop que va siguiendo al precio |

---

## 2. Cómo funciona por dentro

El motor revisa el bot **cada 15 segundos**, pero las decisiones se toman sobre **velas cerradas**
del intervalo que elijas. Con velas de 4 h, la señal solo puede cambiar cuatro veces al día.

### Paso 1 — ¿Hay velas suficientes?

El bot pide al motor las velas que necesita: la mayor de sus dos ventanas (canal y ATR) más cinco
de holgura. **Si no las tiene, no opera y lo dice.** Un ATR de catorce velas calculado sobre tres
es un número con toda la pinta de ser válido, y de ahí saldría el tamaño de tu posición.

Con una **posición abierta**, que falten velas no toca el stop. Pasa tras un reinicio del motor o
si el exchange limita las descargas.
- **Ya hay stop:** se queda donde estaba.
- **Todavía no había ninguno:** se pone uno de emergencia a `k × 2 %` de tu precio de entrada.
  Cuando vuelven las velas, lo sustituye el calculado con el ATR de verdad.

Hasta el spec 057 (F-02), en ese caso el stop se retiraba.

### Paso 2 — ¿Hay ruptura?

```
canal_alto = máximo de las N velas ANTERIORES a la última
canal_bajo = mínimo de esas mismas N

cierre > canal_alto  →  ruptura al alza
cierre < canal_bajo  →  ruptura a la baja
```

> **La vela que rompe no cuenta en su propio canal.** Si contara, su máximo sería el máximo y no lo
> superaría nunca.

### Paso 3 — ¿Va el mercado a algún sitio?

```
eficiencia = |recorrido neto| / suma de |movimientos|
```

Si el precio ha subido y bajado 100 veces para acabar donde empezó, la eficiencia es ~0 y **casi
cualquier ruptura será falsa**. Por debajo de `entryEfficiency` el bot no entra, y la nota lo dice.

Es el mismo número que usa el asesor para decidir si un par es terreno de rejilla, y que el market
maker V2 usa desde el spec 039 para dejar de cotizar contra la tendencia. **Aquí se lee al revés**:
lo que a una rejilla le conviene evitar es justo lo que esta busca.

### Paso 4 — ¿Cuánto se compra?

Aquí está la idea que define la estrategia:

```
distancia_al_stop = atrStopMultiplier × ATR
cantidad          = (capital × riesgo% / 100) / distancia_al_stop
```

**El tamaño sale del riesgo, no del capital.** Con el mercado nervioso la posición es pequeña; con
el mercado quieto, grande. En las dos arriesgas **exactamente lo mismo** si el stop salta. El
`riesgo%` es **Riesgo por operación (sobre el capital)**: un % del capital asignado, no del margen de
la posición, y el apalancamiento no entra en la cuenta.

> **Con un techo.** Esa división se dispara en un mercado muy tranquilo —un ATR pequeño en el
> denominador—, así que el tamaño se recorta al menor de: tu **tope de exposición**, tu **capital
> asignado × apalancamiento** y el **margen disponible × apalancamiento**. Cuando recorta,
> arriesgas **menos** del porcentaje que pediste, y la nota del bot lo dice. La Revisión aplica el
> mismo techo, salvo el margen disponible, que antes de crear el bot no se conoce.

Es lo que hace comparables dos operaciones separadas por meses, y lo que permite decir «arriesgo el
1 %» y que sea verdad.

### Paso 5 — El stop

Se coloca como **orden condicional nativa del exchange**, con `triggerPrice`: sigue ahí aunque la
plataforma se caiga entera.

```
primero: largo  stop = max(entrada − k × ATR, precio − k × ATR)
         corto  stop = min(entrada + k × ATR, precio + k × ATR)
después: largo  stop = max(stop_anterior, precio − k × ATR)
         corto  stop = min(stop_anterior, precio + k × ATR)
```

**El primero se ancla en tu precio de entrada**, no en el de ahora. Si el mercado se mueve en
contra entre la ejecución y la primera revisión, anclarlo en el precio de ahora pondría el stop
más lejos y arriesgarías más de lo que dijiste. Y si se ha movido **a favor**, el stop ya nace más
arriba: el seguimiento empieza desde el primer momento.

**Nunca se mueve en contra.** Es la única regla que convierte un stop de seguimiento en un stop de
seguimiento, y no en un stop que persigue al precio hacia abajo.

Y no se recoloca por cualquier cosa: solo cuando se ha movido más de `stopRepriceBps`. Un trailing
que se reescribe cada quince segundos son dos peticiones al exchange cada quince segundos para no
cambiar nada.

**Y tiene que saltar antes que la liquidación.** En margen aislado, antes de entrar el bot compara la
distancia del stop (`k × ATR / precio`) con la de la liquidación exacta del lado de la entrada. Si el stop
quedaría en ella o detrás, no saltaría nunca, y no entra:

> `Ruptura descartada: el stop, a 2.5 ATR, quedaría a un 5.75 %, detrás de la liquidación a 15× (5.49 %): no saltaría nunca. Baja el apalancamiento o el multiplicador del stop.`

Si cabe pero la deja a menos de medio stop detrás, entra y lo añade a la nota: `El stop queda a menos de
medio stop de la liquidación a 15× (5.49 %).` Son las dos notas de una ruptura al alza en BTC de
Hyperliquid a 15×: con un ATR del 2,30 % del precio la descarta, y con uno del 2,18 % entra con el aviso.
En cruzado entra siempre: la liquidación real queda más lejos, con el resto de la cuenta detrás.

---

## 3. Cómo configurarlo con poco riesgo

### Las cuatro reglas

1. **El riesgo por operación es el mando que importa.** Es un % del **capital**. 1 % es lo estándar.
   Con 2 %, cinco pérdidas seguidas —que son normales— se llevan un 10 % de tu capital. Por encima del
   2 % la app avisa.
2. **Apalancamiento bajo.** El stop es amplio a propósito. Con apalancamiento alto, la liquidación
   del exchange queda **por dentro** del stop, o pegada detrás. En aislado el bot lo comprueba al entrar,
   con el ATR de ese momento, y deja pasar las rupturas cuyo stop no saltaría (Paso 5): el apalancamiento
   alto te quita entradas. Al crear el bot, la app avisa con el ATR supuesto de la Revisión, un 2 % del
   precio: con 2,5 ATR el stop queda a un 5 %, y en BTC de Hyperliquid (mantenimiento del 1,25 %), con
   Lados en Neutral, el aviso sale desde 12×, donde la liquidación del corto está a un 7,00 %:
   `A 12× la liquidación llega en corto con un 7.00 % en contra, y el stop, a 2.5 ATR, solo salta antes
   mientras el ATR sea menor que un 2.80 % del precio. Con un ATR del 2 % quedaría a un 5.00 %, a menos
   de medio stop de ella. Baja el apalancamiento o el multiplicador del stop.` A 2× esa liquidación está a un 48,15 %, a
   10× a un 8,64 %, y a 15× —el máximo que admite la regla del 5 % en Neutral— a un 5,35 %. En cruzado no
   se avisa ni se descarta nada.
3. **El stop nunca por debajo de 1,5 ATR.** Más pegado no es prudencia: es salirse en el primer
   respiro del mercado, una y otra vez, pagando comisión cada vez. La app lo avisa.
4. **Deja la eficiencia mínima en 0,35 o más.** Con 0, el bot entra en cada ruptura, y en un
   lateral eso es entrar en todas las falsas.

### Configuración A — «Prueba de agua»

| Campo | Valor |
| --- | --- |
| Par | BTC/USDC o ETH/USDC |
| Lados que opera | **Neutral** (los dos) |
| Capital asignado | **200 USDC** |
| Apalancamiento | **1x** · Margen aislado |
| Resolución de las velas | **4 h** |
| Velas del canal de ruptura | 20 (unos 3 días) |
| Velas del ATR | 14 |
| Stop, en ATR | **2,5** |
| Riesgo por operación (sobre el capital) | **0,5 %** |
| Eficiencia mínima para entrar | **0,4** |

Con 200 USDC y 0,5 %, cada operación arriesga **1 USDC**. Es poco a propósito: lo que se quiere
aquí es ver cuántas veces entra, cuántas veces el stop salta enseguida, y si eso te resulta
soportable. En BTC de Hyperliquid, a 78.910 y con el ATR supuesto del 2 %, la Revisión enseña una
entrada de ejemplo de 0,00025 BTC (19,73 USDC) con el stop estimado en 74.965, un 5 % por debajo, y
−0,99 USDC si salta. No enseña liquidación: a 1× y en largo no la hay.

### Configuración B — «Uso normal»

| Campo | Valor |
| --- | --- |
| Capital asignado | 1.000 USDC |
| Apalancamiento | **2x** |
| Velas | resolución 4 h · canal de ruptura 20 · ATR 14 |
| Stop, en ATR | 2,5 |
| Riesgo por operación (sobre el capital) | **1 %** |
| Eficiencia mínima para entrar | 0,35 |
| Stop loss (sobre el margen) | **vacío** — esta estrategia pone el suyo |

**Qué enseña la Revisión** (BTC en Hyperliquid, a 78.910). Con el ATR supuesto del 2 %, el stop queda
a 2,5 × 2 % = 5 % y la posición sale de `1.000 × 1 % / 5 %` = 200 USDC: **0,00253 BTC** (199,64 USDC
tras redondear) con **99,82 USDC de margen** a 2×. Si el stop estimado salta, en 74.965, pierdes **9,98
USDC**: el 1 % del capital, que la Revisión enseña como un **−10 % del margen**, porque la posición solo
usa unos 100 de los 1.000. La liquidación del largo queda en 39.955, un 49,37 % por debajo. Los 900 USDC
que no usa no están de adorno: son la base del riesgo y, con el apalancamiento, el techo de la posición.

### Configuración C — «Lenta»

Cambia una sola cosa sobre la B: **resolución 1d**. Con el mismo canal de 20 velas, el canal cubre
unas tres semanas. Opera mucho menos y cada operación dura mucho más. Es la forma clásica de esto, y
la que peor se lleva con mirar la pantalla todos los días.

### Checklist antes de arrancar

- [ ] ¿El **riesgo por operación** es un número que puedo perder cinco veces seguidas sin cambiar
      de humor?
- [ ] ¿Apalancamiento en 1x o 2x?
- [ ] ¿El **stop** está en 2 ATR o más?
- [ ] ¿He dejado vacío el **Stop loss (sobre el margen)**? (Esta estrategia pone el suyo y ese no
      se usa; la app avisa si lo rellenas.)
- [ ] ¿He mirado en la Revisión el stop estimado y la liquidación, y hay distancia de sobra entre los
      dos? (en aislado, si la app avisa en «Stop, en ATR», el bot dejará pasar las rupturas en cuanto
      el ATR suba del máximo que dice)
- [ ] ¿Entiendo que la mayoría de los días no va a pasar nada, y que la mayoría de las operaciones
      van a perder?

---

## 4. Lo que este bot NO mira

| Campo | Realidad |
| --- | --- |
| **Stop loss (sobre el margen)** | ⚠️ **No se usa.** La estrategia emite su propio stop, calculado con el ATR y en movimiento, y el motor no añade el común encima. La app avisa si lo rellenas, y el campo no enseña equivalente en precio |
| **Espera entre ciclos** | Sin efecto: cada operación es un ciclo y el siguiente empieza cuando haya otra ruptura |

Sí funcionan: **Pérdida diaria máxima (sobre el capital)** y **Al acercarse la liquidación**,
aplicados por el motor, y el **Tope de exposición**, que recorta el tamaño de la entrada (Paso 4).

---

## 5. Cómo se lleva con las otras

**No la sustituye a ninguna: la complementa.** Es la única de la casa que gana en tendencia, y la
que peor lo pasa en lateral — justo al revés que todas las demás.

| Régimen | Rejillas y market makers | Tendencia |
| --- | --- | --- |
| Lateral | Ganan | No opera (y eso es ganar) |
| Tendencia | Acumulan del lado equivocado | Gana |
| Lateral con rupturas falsas | Ganan | Pierde poco a poco |

Tenerlas a la vez sobre el mismo par, con capital pequeño en cada una, es lo que suaviza la curva.
Tenerlas a la vez **sobre el mismo par y la misma cuenta** no se puede: el sistema solo admite un
bot real por par y cuenta.

---

## 6. Limitaciones conocidas

- **En Lighter, el filtro de funding no hace nada**: ese venue no publica la tasa
  ([venues](./venues-y-minimos.md#7-resumen-por-venue)).
- **El backtest mueve el stop una vez por vela**, no cada quince segundos. En un movimiento rápido
  eso lo deja más atrás que el motor real, así que el replay **tiende a salir peor** de lo que
  saldría en vivo, no mejor. Lo declara entre sus avisos.
- **En el backtest, el intervalo del replay tiene que dividir el de la estrategia** (15m o 1h para
  una Tendencia de 1h). Si no lo divide, no hay velas con las que decidir y no opera. Además, las
  primeras 25 velas del rango (con los valores de fábrica) se gastan en calentar el canal y el ATR
  ([simulación y backtest](./simulacion-y-backtest.md)).
- **La Revisión estima el tamaño y el stop con un ATR del 2 % del precio**, porque antes de crear el
  bot no hay velas que mirar: el stop sale rotulado «Stop · estimado». Los reales los calculará el bot
  con el ATR de verdad del par: con un mercado más nervioso, la posición será menor y el stop más
  ancho, y el riesgo en dinero el mismo. Con **Lados que opera** en Neutral enseña solo el largo; el
  corto es su espejo, salvo la liquidación, algo más cercana (a 2× en BTC de Hyperliquid, un 48,15 %
  por encima frente a un 49,37 % por debajo).
