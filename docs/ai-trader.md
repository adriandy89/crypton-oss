# El Bot de IA (`AI_TRADER`)

> Solo administradores. Arranca **apagado dos veces** y su ventaja **no está demostrada**. Lee el
> apartado «Lo que no sabemos» antes de ponerle dinero.

## 1. Qué es esto, en cristiano

Espera a que el precio toque el borde de una banda dibujada alrededor de su media, y apuesta a que
vuelve al centro. Nada más. Lo que lo hace distinto de un bot de rango de toda la vida son dos
cosas: que el motor **calcula nueve operaciones posibles y valida cada una antes de enseñarla**, y
que quien elige entre ellas puede ser un modelo de IA.

La frase que resume el diseño: **quien decide no puede elegir mal, porque lo que no se puede hacer
no está en la lista.**

### El riesgo, dicho claro

- Opera **con apalancamiento**, hasta 25x, calculado por operación a partir de su stop.
- Su ventaja **no está demostrada**. El bot hermano (`AI_CHANNEL`) quedó medido en R medio +0,205
  con t = 0,90 tras dos specs de trabajo: positivo, pero indistinguible de la suerte.
- **Opera muy poco, a propósito.** Rechaza la inmensa mayoría de los toques. Si buscas un bot que
  esté siempre dentro, éste no es.
- Por eso viene con `decisionMode` en **Reglas** y `observeOnly` en **Sí**: no manda una sola orden
  hasta que lo cambies tú, dos veces.

## 2. Cómo funciona por dentro, paso a paso

### Paso 1 — Cada vela cerrada de 15 minutos

No por tick. Son 96 evaluaciones al día como mucho, y eso es lo que hace que un presupuesto de
consultas signifique algo.

### Paso 2 — La señal

1. **Régimen, en velas de 1 h.** El mismo filtro que usa el canal, que es la pieza más valiosa que
   este repo ha medido: en un walk-forward descartó el 87 % de las entradas y llevó el R medio de
   −0,143 a +0,608.
2. **La banda, en velas de 15 min.** Bollinger de 20 cierres y dos desviaciones típicas.
3. **El toque.** Si el precio no está en el décimo exterior de la banda, no hay nada que hacer y no
   se gasta nada. Si lo está, **el borde decide el sentido**: abajo se compra, arriba se vende.

   Eso último importa más de lo que parece. La dirección **no la elige nadie**, y por eso el modelo
   puede contestar todas sus preguntas en paralelo sin que una dependa de otra.

### Paso 3 — La matriz de nueve

Tres distancias de stop por tres distancias de objetivo:

| Stop, en ATR(15m) | Objetivo, en fracción del camino a la media |
|---|---|
| Ceñido 1,25 · **Medido 2,00** · Holgado 3,00 | Corto 0,70 · **En la media 1,00** · Largo 1,50 |

Los dos en negrita son los que el spec 067 midió como ganadores, y son los que se aplican cuando
quien decide se abstiene.

**El borde opuesto no es una opción.** Está a cuatro sigmas, y llegar hasta él es la travesía
entera del canal. Medido sobre este mismo mercado: hundía el R medio de +0,28 a −0,21 y el acierto
del 42 % al 21 %. Revertir a la media **es** la operación.

Cada celda se valora entera —tamaño, apalancamiento, liquidación— y se valida antes de ofrecerse:
stop del lado correcto, más estrecho que tu tope, coste por debajo de tu límite, objetivo a más de
25 veces el coste de ida y vuelta, mínimos del venue, margen disponible y **liquidación
estrictamente detrás del stop**. Lo que no pasa, no se enseña.

El **apalancamiento tampoco se elige**: es siempre el menor que hace caber el margen, o sea la
liquidación más lejana posible.

### Paso 4 — Quién elige

- **Reglas** (por defecto): una tabla determinista. Entra si el régimen es de rango, el ADX está
  bajo, la banda es bastante ancha y el precio vuelve a la media deprisa. Stop medido, objetivo en
  la media. No gasta ninguna consulta.
- **IA**: el modelo recibe el estado y contesta ocho preguntas en una sola llamada. **Todavía no
  está disponible**: falta conectar el proveedor (spec 069), y el formulario lo rechaza. Se probó
  contra BTC real y funciona, pero mientras no exista el camino completo un bot en ese modo se
  quedaría mirando en silencio, y eso es peor que no ofrecerlo.

### Paso 5 — La entrada y las salidas

Entrada con una orden inmediata con precio tope: si el libro se ha ido, no se llena y no pasa nada.
El **stop y el objetivo son órdenes nativas del exchange**: siguen ahí aunque el worker muera. Lo
único que necesita al bot vivo es el cierre por tiempo.

## 3. La IA: qué ve y qué contesta

**No ve precios, ni importes, ni el símbolo, ni la hora.** Todo va en porcentajes, múltiplos de ATR
y veces el coste. Lo del símbolo es lo menos evidente y lo más importante: un ticker invoca
recuerdos de precio y de noticias que están rancios y no se pueden comprobar. Quitarlo tiene además
un efecto útil: dos montajes idénticos en dos pares reciben el mismo estado, y por tanto la misma
respuesta, y eso es lo que hace comparable a la IA con el juez de reglas.

El estado va **en inglés**, porque el modelo es más preciso en inglés y lo dice su documentación.

Las ocho preguntas: qué hacer con el toque (tomar, esperar, o entorno equivocado), tres de contexto
—¿esto revierte?, ¿el toque es agotamiento?, ¿el histórico acompaña?— y dos parejas para el stop y
el objetivo, cada una con su pregunta previa de «¿tienes una razón clara?».

**La IA nunca fija un número.** Contesta enumeraciones y probabilidades; las probabilidades pasan
por una única función que las convierte en enumeraciones antes de que nada aguas abajo las vea, y
los umbrales con los que se comparan son **campos tuyos**.

Y una regla que lo cierra: **todo lo que no es la elección principal solo puede restar.** Una
pregunta de contexto puede vetar, la confianza puede reducir el tamaño a la mitad; ninguna puede
ampliar nada.

## 4. Lo que no sabemos

Esto es lo que hay que leer dos veces.

- **Probado contra BTC real** (dieciséis llamadas sobre doce horas de velas de 15 min): el modelo
  funciona, contesta en 292 ms de mediana y gasta unos 2.200 tokens por llamada. Pero **su confianza
  no pasó de 0,61**, cuando la documentación del fabricante sugiere actuar por encima de 0,9. Los
  umbrales que vienen por defecto (0,45 y 0,60) están calibrados sobre esas dieciséis llamadas:
  **es poca muestra**, es un punto de partida medido y no un valor asentado.
- **El backtest no puede medir al modelo.** Lo dice el propio motor cuando replica esta estrategia:
  allí decide el juez de reglas. Lo que un walk-forward mide es el motor y las reglas. Para medir
  al modelo hace falta verlo en sombra con bots simulados, comparándolo con el juez.
- **El venue importa, pero al revés de lo que parece.** Medido sobre doce pares y ciento noventa
  días, con el juez de reglas:

  | | Operaciones | Al mes y par | R medio | t | Acierto |
  |---|---|---|---|---|---|
  | Sin comisión | 545 | 7,17 | **−0,107** | −1,82 | 35 % |
  | Con comisión (Hyperliquid) | 36 | 0,47 | **+0,691** | **2,80** | 58 % |

  Es contraintuitivo y tiene explicación: la puerta del coste no solo evita la imposibilidad
  aritmética, **está filtrando calidad**. Con comisiones altas casi ningún toque la pasa, y lo que
  pasa es muy bueno. Con comisiones cero deja pasar cualquier cosa y el bot toma quinientas
  operaciones mediocres. El mando que gobierna eso es `minTargetCostMultiple`, y es tuyo.

## 5. Los ajustes

Todos los campos están documentados dentro de la app, en la guía de la estrategia. Los tres que
conviene mirar antes que ninguno:

#### Quién decide · `decisionMode` · por defecto **Reglas**
De momento es la única opción: el modo IA está rechazado en el formulario hasta que el proveedor
esté conectado.

#### Solo observar · `observeOnly` · por defecto **Sí**
El bot funciona entero y apunta lo que habría hecho, sin tocar el mercado.

#### ADX máximo · `maxAdx1h` · por defecto **20** · ⚠️
El filtro más valioso que tiene. Súbelo y empezarás a comprar caídas en tendencia, que es
exactamente lo que este bot no debe hacer.

#### Objetivo mínimo sobre el coste · `minTargetCostMultiple` · por defecto **25** · ⚠️
No se puede bajar de 15, y el formulario da **error** si lo intentas. No es una preferencia: el
spec 066 midió que por debajo de quince veces el coste de ida y vuelta se pierde de media.

## 6. Antes de ponerle dinero

1. Créalo simulado, con los defectos, y **déjalo una o dos semanas en «solo observar»**.
2. Mira su histórico: qué habría hecho, cuántas veces y con qué resultado.
3. Quita «solo observar», sigue en **Reglas**, y dale capital pequeño.
4. La IA, al final del todo, y solo si la sombra dice que aporta.
