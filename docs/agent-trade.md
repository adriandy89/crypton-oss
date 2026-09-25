# Operación IA

> La operación de un agente de IA: entra **una sola vez** con un precio tope, pone su stop y sus
> objetivos en el exchange desde el primer momento y se detiene al cerrarse. No decide nada: los
> números los calculó el motor del agente y se recalcularon al aprobarla.

**Riesgo: ALTO.** Es una posición direccional entera, con apalancamiento. **Solo administradores**, y
**no se crea a mano**: la crea un agente de la sección IA cuando se aprueba una de sus propuestas
—desde Telegram, desde la app o sola, si su autonomía lo permite—. Cómo se configura un agente, qué
propone y cómo se decide está en [Agentes de IA](./agentes-ia.md); aquí se explica lo que hace la
operación mientras vive.

---

## 1. Qué es esto, en cristiano

Un agente mira unos pares cada vela, ve una operación posible —«largo en SOL, retroceso a la media
en tendencia»— y la propone con todos sus números: hasta qué precio entrar, dónde va el stop, uno o
dos objetivos, cuánto comprar, con qué apalancamiento y cuánto se pierde si sale mal. Si se aprueba,
nace un bot de esta estrategia con **exactamente** esos números, recalculados con el precio de ese
momento. El bot entra, protege y sale. Y ya.

No vuelve a entrar nunca: ni tras un stop, ni tras un objetivo, ni rearrancándolo a mano (R-1). La
siguiente idea del agente es otra operación, con otro bot.

### El riesgo, dicho claro

- Lo que se pierde si salta el stop está calculado de antemano, con comisiones y deslizamiento: es
  **1R**, y sale de tu «riesgo por operación» (0,5 % del capital del agente, de fábrica).
- Un hueco puede saltar el stop. El margen es **siempre aislado** y la liquidación queda **detrás
  del stop** con holgura: lo más que se pierde en un hueco es el margen de la operación.
- El agente puede equivocarse, y la tarjeta de resultados lo mide —también lo que no se toma—. Que
  proponga no quiere decir que tenga ventaja.

### Vocabulario mínimo

| Palabra | Qué significa aquí |
|---|---|
| **R** | Lo que se pierde si salta el stop con el que se entró, con costes. «+1,5 R» es ganar vez y media eso. |
| **Tope de entrada** | El peor precio al que se acepta entrar. La entrada es una orden inmediata a ese precio: si el libro se ha ido, no se llena. |
| **Tope de posición** | «La posición, como mucho esto». Es como el seguimiento del agente la reduce; cero es cerrar. |
| **Seguimiento** | Lo que el agente hace con la operación viva. Solo puede ceñir el stop o reducir la posición. |

---

## 2. Cómo funciona por dentro, paso a paso

Código: [`agent-trade.ts`](../packages/strategy-core/src/strategies/agent-trade.ts), con la gestión
de posición que comparte con el canal en
[`operacion/gestion.ts`](../packages/strategy-core/src/operacion/gestion.ts).

### Paso 1 — Nace de una propuesta aprobada

Al aprobarla, la API vuelve a calcular la entrada, la cantidad y el apalancamiento con el precio de
ese momento. Si el precio ya pasó el stop, se ha movido más de media distancia de stop o ya no cabe
en los límites, **no nace**: la propuesta caduca con su motivo. Si vale, el bot se crea por el
camino de siempre —`validate()`, `preview()`, tus límites de riesgo— y arranca (R-19).

### Paso 2 — La entrada

Una orden **inmediata con precio tope** (IOC): entra a ese precio o mejor, o no entra. Si no se
llena, se reintenta mientras dure su plazo (`entryDeadline`, cinco minutos desde la aprobación),
pero **nunca con el precio a menos de medio stop del stop**: entrar pegado al stop sería regalar la
operación. Pasado el plazo sin llenarse, el bot se detiene y la propuesta queda como «no entró».

El apalancamiento es el de la operación, y se **rebaja** si el tramo del exchange o el tope de tu
cuenta lo exigen. Nunca se sube.

### Paso 3 — El stop y los objetivos, en el exchange

Con la posición abierta, el stop es una **orden condicional nativa** del exchange y los objetivos,
órdenes límite reduce-only. Siguen ahí aunque el worker o el servidor se caigan (invariante 6). Si
en unos segundos el stop no consta en el exchange, el vigilante cierra a mercado: una operación sin
stop no se deja viva.

### Paso 4 — La vida de la operación

- **El stop solo se ciñe** (R-2). El motor guarda el más ceñido que ha visto: una configuración que
  lo aleja —la pida el seguimiento o una edición a mano— se **ignora** y se avisa
  (`AGENT_STOP_IGNORED`).
- **Primer objetivo**: sale la parte pedida (la mitad, de fábrica) y, si está activado, el stop pasa
  a la **entrada más costes** (`AGENT_BREAKEVEN`). Desde ahí lo que queda ya no puede perder.
- Si se pide, tras el primer objetivo el stop **sigue al mejor precio** a la distancia dada. Nunca
  retrocede.
- **Segundo objetivo**: sale el resto.
- **Tope de posición**: si el seguimiento lo baja, se reduce a mercado hasta él. Aplicarlo dos veces
  no reduce dos veces; subirlo después no añade nada (R-4).

### Paso 5 — Las salidas de seguridad

Cierra a mercado —y lo dice— si pasa su **duración máxima**, si el stop no salta cuando debía, si la
liquidación queda demasiado cerca o si el exchange informa **más apalancamiento** del pedido.

### Paso 6 — El final

Cerrada la posición, vencida la entrada o con una **posición ajena** en el par (R-5: no la toca,
avisa en CRITICAL y se detiene), el bot pide pararse. Su propuesta pasa a «cerrada» con su R real y
cómo salió, y la pestaña **Bots** deja de listarlo: las operaciones terminadas viven en **IA →
Operaciones**, con su resultado.

---

## 3. Cómo configurarla con poco riesgo

No se configura aquí: la configuran **los límites del agente** que la propone —riesgo por
operación, stop máximo, apalancamiento máximo, margen, objetivo mínimo…—, y todos se explican en
[Agentes de IA § El editor](./agentes-ia.md#el-editor). Lo que sí puedes hacer con una operación
viva:

| Quieres | Cómo |
|---|---|
| Que no pueda perder más de lo que ya lleva ganado | IA → la operación → aplicar «stop a la entrada» si el seguimiento lo propone, o ceñir el stop en Ajustes del bot. |
| Salir ya | «Cerrar a mercado» en IA, o el comando de siempre (`STOP_AND_CLOSE`) desde el bot. |
| Que el agente no toque nada más | Reducir y cerrar en «nunca» en su autonomía. El stop y los objetivos siguen en el exchange. |
| Pararla sin cerrar | `PAUSE` o `STOP_KEEP_POSITION`: el stop nativo sigue puesto (invariante 6). |

### Señales de alarma

| Lo que ves | Qué significa |
|---|---|
| Muchas propuestas que caducan «al aprobarla, el precio se había movido demasiado» | Apruebas tarde para el intervalo. Mira antes, o sube el intervalo. |
| «No entró» una y otra vez | El libro se va antes de la IOC. En pares poco líquidos, el agente no es para ellos. |
| `AGENT_STOP_IGNORED` | Alguien —o algo— pidió alejar el stop con la posición abierta. No se hizo. |
| `AGENT_FOREIGN_POSITION` | Hay una posición en el par que no es de la operación: operas a mano en él. Se detuvo sin tocarla. |

---

## 4. Lo que esta operación NO mira

- **El funding.** Ni lo cobra ni lo paga de forma distinta: en una operación de un día puede pesar.
- **Las noticias.** Un dato macro puede saltar el stop por un hueco: el margen aislado lo acota.
- **Si el agente acierta.** Eso lo dice la tarjeta de resultados, no la operación.

---

## 5. Parámetros, uno a uno

Todos los pone el generador del agente (`configDeOperacion`) a partir del plan aprobado. Los
**❄️ en frío** no cambian en su vida; los **🔥 en caliente** son los que el seguimiento —o tú, en
Ajustes— puede tocar, y solo en el sentido de reducir el riesgo.

#### Conexión · `exchangeAccountId` · ❄️ en frío

La cuenta del agente.

#### Par · `symbol` · ❄️ en frío

El par de la propuesta.

#### Dirección · `direction` · ❄️ en frío · por defecto **Largo**

Larga o corta, la de la propuesta.

#### Modo de margen · `marginMode` · ❄️ en frío · por defecto **Aislado**

Solo aislado: la pérdida en un hueco se acota con el margen de la operación.

#### Apalancamiento · `leverage` · ❄️ en frío · por defecto **1**

El de la operación, fijo: cambiarlo con la posición abierta movería la liquidación que se comprobó
al aprobarla. No cambia lo que se pierde en el stop; cambia el margen y la distancia a la
liquidación, que siempre queda detrás del stop.

#### Margen de la operación · `totalInvestment` · ❄️ en frío · ⚠️ campo de riesgo

El margen aislado. Es lo más que se perdería si el precio saltara más allá de la liquidación.

#### Tope de exposición · `maxNotionalCap` · 🔥 en caliente

El común de todas las estrategias. La operación no lo necesita: su tamaño es fijo desde que nace.

#### Stop loss (%) · `stopLossPct` · 🔥 en caliente

**No se usa**: la operación lleva su propio stop (`stopPrice`). Si se pone, la validación avisa.

#### Pérdida diaria máxima (%) · `maxDailyLossPct` · 🔥 en caliente

El común de todas las estrategias. La pérdida del día que cuenta es la del **agente**, que se pausa
al tocarla.

#### Al acercarse la liquidación · `liquidationAction` · 🔥 en caliente · por defecto **Cerrar todo**

Con apalancamiento y un stop que debería saltar antes, acercarse a la liquidación es una avería: se
cierra.

#### Espera entre ciclos (min) · `cooldownMinutes` · 🔥 en caliente · por defecto **0**

No aplica: la operación no tiene un segundo ciclo.

#### Tope de entrada · `entryLimitPrice` · ❄️ en frío

El peor precio de la entrada, con una holgura de 0,2 R sobre el libro del momento de aprobarla.

#### Cantidad · `quantity` · ❄️ en frío

Sale de tu riesgo por operación y de la distancia al stop: con el stop más lejos, menos cantidad
para la misma pérdida.

#### Riesgo (1 R) · `riskAmount` · ❄️ en frío

Lo que se pierde si salta el stop, con comisiones y deslizamiento. El resultado se cuenta en R con él.

#### Stop · `stopPrice` · 🔥 en caliente · ⚠️ campo de riesgo

El stop, como orden condicional del exchange. Con posición, **solo se ciñe**; un stop pedido que el
precio ya pasó cierra a mercado. «Proteger» y «Asegurar» del seguimiento lo mueven aquí.

#### Primer objetivo · `tp1Price` · 🔥 en caliente

Una orden límite reduce-only.

#### Segundo objetivo · `tp2Price` · 🔥 en caliente

Opcional. Con él, la posición sale en dos partes; sin él, entera en el primero.

#### Parte del primer objetivo (%) · `tp1Fraction` · 🔥 en caliente · por defecto **50**

Con dos objetivos, la parte que sale en el primero.

#### Stop a la entrada tras el primer objetivo · `breakevenAfterTp1` · 🔥 en caliente · por defecto **sí**

Lo que queda ya no puede perder, a cambio de salir si el precio vuelve a la entrada.

#### Seguir al precio tras el primer objetivo · `trailAfterTp1` · 🔥 en caliente · por defecto **no**

El stop sigue al mejor precio y nunca retrocede.

#### Distancia del seguimiento (%) · `trailCallbackPct` · 🔥 en caliente · por defecto **1**

A qué distancia del mejor precio va ese stop.

#### Tope de posición · `positionCap` · 🔥 en caliente

La posición, como mucho esto; **cero es cerrar**. «Reducir un tercio», «Reducir a la mitad» y
«Cerrar» del seguimiento se aplican aquí.

#### Duración máxima (min) · `maxHoldMinutes` · 🔥 en caliente · por defecto **1440**

Desde la entrada. Pasada, se cierra a mercado. Sale de la «duración máxima en velas» del agente.

#### Plazo de la entrada · `entryDeadline` · ❄️ en frío

Hasta cuándo puede entrar: cinco minutos desde la aprobación.

#### Propuesta · `agentProposalId` · ❄️ en frío

La propuesta de la que nace: enlaza la operación con su plan, su seguimiento y su medida.

---

## 6. Resumen de valores de fábrica

| Campo | Por defecto | Quién lo decide |
|---|---|---|
| Modo de margen | Aislado | Fijo |
| Parte del primer objetivo | 50 % | «Parte del primer objetivo» del agente |
| Stop a la entrada tras el primer objetivo | Sí | Límites del agente |
| Seguir al precio tras el primer objetivo | No | — |
| Duración máxima | 24 velas del intervalo | «Duración máxima» del agente |
| Al acercarse la liquidación | Cerrar todo | Fijo |

---

## 7. ¿Esta u otra?

| | **Operación IA** | [Seguimiento de beneficio](./trailing-profit.md) | [Canal con IA](./ai-channel.md) |
|---|---|---|---|
| Quién decide la entrada | Un agente propone; tú apruebas, o entra sola | Tú | Una IA dentro del bot |
| Cuántas veces entra | **Una** | Una por ciclo, muchos ciclos | Muchas, en su rango |
| Stop | Nativo desde el primer momento, solo se ciñe | Nativo, fijo | Nativo, por operación |
| Tamaño | De tu riesgo por operación | Capital × apalancamiento | De su riesgo por operación |
| Pares | Uno por operación; el agente mira varios | Uno | Uno |

---

## 8. Limitaciones conocidas

- **No hay backtest.** La estrategia lo rechaza: una operación suelta no dice nada. Lo que mide al
  agente es su tarjeta de resultados —el resultado hipotético de cada propuesta y de cada candidato,
  se tomara o no—.
- **Una operación cerrada fuera del bot** —a mano en el exchange— queda como «fuera del bot», sin R.
- **Si operas a mano en el mismo par y cuenta**, el exchange suma las posiciones: el bot solo
  gestiona la suya y una del otro lado lo detiene sin tocarla.
