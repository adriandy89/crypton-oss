# Tendencia — guía completa

> Estrategia `TREND_FOLLOW`.
> Código: [`trend-follow.ts`](../packages/strategy-core/src/strategies/trend-follow.ts) · indicadores en [`indicadores.ts`](../packages/strategy-core/src/indicadores.ts)

---

## 1. Qué es esto, en cristiano

Las otras ocho estrategias de la plataforma hacen variaciones de lo mismo: **comprar barato y
vender caro dentro de un rango**. Una rejilla pone escalones, un market maker pone las dos puntas,
una martingala promedia a la baja. Todas viven del **ir y venir** del precio.

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
el mercado quieto, grande. En las dos arriesgas **exactamente lo mismo** si el stop salta.

> **Con un techo.** Esa división se dispara en un mercado muy tranquilo —un ATR pequeño en el
> denominador—, así que el tamaño se recorta al menor de: tu **tope de exposición**, tu **capital
> asignado × apalancamiento** y el **margen disponible × apalancamiento**. Cuando recorta,
> arriesgas **menos** del porcentaje que pediste, y la nota del bot lo dice.

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

---

## 3. Cómo configurarlo con poco riesgo

### Las cuatro reglas

1. **El riesgo por operación es el mando que importa.** 1 % es lo estándar. Con 2 %, cinco pérdidas
   seguidas —que son normales— se llevan un 10 % de tu capital.
2. **Apalancamiento bajo.** El stop es amplio a propósito. Con apalancamiento alto, la liquidación
   del exchange queda **por dentro** del stop y te saca él antes que tu estrategia.
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
| Resolución | **4 h** |
| Canal de ruptura | 20 velas (unos 3 días) |
| ATR | 14 velas |
| Stop | **2,5 ATR** |
| Riesgo por operación | **0,5 %** |
| Eficiencia mínima | **0,4** |

Con 200 USDC y 0,5 %, cada operación arriesga **1 USDC**. Es poco a propósito: lo que se quiere
aquí es ver cuántas veces entra, cuántas veces el stop salta enseguida, y si eso te resulta
soportable.

### Configuración B — «Uso normal»

| Campo | Valor |
| --- | --- |
| Capital asignado | 1.000 USDC |
| Apalancamiento | **2x** |
| Resolución | 4 h · Canal 20 · ATR 14 |
| Stop | 2,5 ATR |
| Riesgo por operación | **1 %** |
| Eficiencia mínima | 0,35 |
| Stop loss (%) | **vacío** — esta estrategia pone el suyo |

### Configuración C — «Lenta»

Cambia solo dos cosas sobre la B: **resolución 1d** y **canal 20** (unas tres semanas). Opera
mucho menos y cada operación dura mucho más. Es la forma clásica de esto, y la que peor se lleva
con mirar la pantalla todos los días.

### Checklist antes de arrancar

- [ ] ¿El **riesgo por operación** es un número que puedo perder cinco veces seguidas sin cambiar
      de humor?
- [ ] ¿Apalancamiento en 1x o 2x?
- [ ] ¿El **stop** está en 2 ATR o más?
- [ ] ¿He dejado el **stop loss por porcentaje** vacío? (Esta estrategia pone el suyo; la app
      avisa si pones los dos.)
- [ ] ¿Entiendo que la mayoría de los días no va a pasar nada, y que la mayoría de las operaciones
      van a perder?

---

## 4. Lo que este bot NO mira

| Campo | Realidad |
| --- | --- |
| **Stop loss (%)** | ⚠️ **No se usa.** La estrategia emite su propio stop, calculado con el ATR y en movimiento. La app avisa si lo rellenas |
| **Espera entre ciclos** | Sin efecto: cada operación es un ciclo y el siguiente empieza cuando haya otra ruptura |

Sí funcionan, aplicados por el motor: **Pérdida diaria máxima**, **Tope de exposición** y **Al
acercarse la liquidación**.

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
- **La vista previa estima el tamaño con un ATR del 2 % del precio**, porque antes de crear el bot
  no hay velas que mirar. El real lo calculará el bot con el ATR de verdad del par.
