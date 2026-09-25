# Agentes de IA

> Un agente mira los pares que le elijas en una cuenta, analiza cada vela, te **propone
> operaciones** con todos sus números, las abre cuando las apruebas —o solo, si le dejas— y les da
> **seguimiento** mientras viven. Y mide todo lo que propone, lo tomes o no.

**Solo administradores.** Vive en la pestaña **IA** de la barra (spec 073), que para el resto de
cuentas no existe, y todo lo que pide al servidor va bajo la guarda de administrador de la consola.
Cada operación que abre es un bot [**Operación IA**](./agent-trade.md) (`AGENT_TRADE`) de una sola
vez. Especificación: [`specs/074-agentes-ia`](../specs/074-agentes-ia/spec.md).

**Opera con dinero real desde el primer día**, si su cuenta es real (decisión del 2026-09-24): los
frenos del servidor existen pero vienen apagados. Por eso sus valores de fábrica son prudentes, y
crear o activar uno sobre una cuenta real pide tu consentimiento expreso.

---

## El reparto

Es el del [canal con IA](./ai-channel.md), llevado a varios pares y a operaciones sueltas: **el
motor calcula y valida, la IA elige, el worker ejecuta, y las salidas nunca esperan al modelo.**

| Quién | Qué hace | Qué no puede hacer |
|---|---|---|
| **El motor** ([`strategy-core/src/agentes`](../packages/strategy-core/src/agentes)) | Busca en cada par las operaciones posibles —tendencia, ruptura, reversión— y calcula **todos** sus números: entrada, tres stops, objetivos, cantidad, apalancamiento. Cada una sale validada: coste, mínimos del venue, liquidación detrás del stop y tus límites. | Elegir. |
| **La IA** (o el juez de reglas) | Elige **una letra** de la oferta, o ninguna, y el stop, el objetivo, la banda de apalancamiento, el tamaño y su confianza, **de listas cerradas**. Ve todo en unidades relativas: ni el par, ni precios, ni importes. | Poner un número. La confianza solo puede **reducir** el tamaño. |
| **La API** | Las barreras, los cupos, la propuesta, y al aprobarla **recalcula** con el precio de ahora y crea el bot por el camino de siempre (`validate`, `preview`, tus límites). | Mandar una orden. |
| **El worker** | Firma. El stop y los objetivos son órdenes nativas del exchange desde el primer momento. | Esperar al modelo para salir. |

Invariante 13: ninguna IA escribe configuración ni fija un número. El seguimiento cambia la
configuración de una operación solo por `updateConfig`, como cualquier persona, y **solo para
reducir el riesgo**.

---

## El editor

**IA → Agentes → Nuevo agente.** Pantalla completa, como el asistente de bots. Cada sección dice
cuándo vale lo que cambias:

| Sección | Qué se elige | Cuándo vale |
|---|---|---|
| **Quién es** | El nombre y la **cuenta** —real, de simulación o testnet— | La cuenta es **fija** tras crearlo |
| **Qué mira** | Los **pares** (hasta `AI_DESK_MAX_WATCHLIST`, 12 de fábrica), las **velas** (15 min, 30 min, 1 h o 4 h: nunca un minuto, spec 070), las **familias**, el **sentido** y **quién elige**: la IA o el juez de reglas | Próximos análisis |
| **Límites** | Los de la tabla de abajo | Próximas operaciones: las abiertas siguen con su plan |
| **Qué hace solo** | La autonomía de cada clase de acción | Ya |
| **Presupuesto del modelo** | Consultas y gasto al día | Ya |

Guardar pide un **motivo**, que queda en la bitácora, y **descarta las propuestas que esperaban**:
se calcularon con lo de antes. En una cuenta real, crear el agente —o pasar «entrar» a automático—
pide marcar «Entiendo que este agente opera con DINERO REAL»; el servidor lo comprueba igual (R-11).

Los límites se validan en la pantalla con la misma función que el servidor
([`limites.ts`](../packages/strategy-core/src/agentes/limites.ts)), y cada error sale al lado de su
campo.

### Las familias

| Familia | Qué busca |
|---|---|
| **Tendencia** | Un retroceso a la media en una tendencia con fuerza (ADX ≥ 20). |
| **Ruptura** | La salida de un rango tras una compresión de Bollinger. |
| **Reversión** | Un toque de banda en un rango, con el RSI en un extremo. |

Los umbrales son de manual y la tarjeta de resultados los mide; no se ajustan a una muestra.

### Los límites

Todos se cuentan sobre el **capital del agente** —lo que le asignas, no el saldo de la cuenta—:
así «0,5 % por operación» dice lo mismo el día que la cuenta ha ganado y el que ha perdido.

| Límite | De fábrica | Qué hace |
|---|---|---|
| Riesgo por operación | 0,5 % | Lo que se pierde si salta el stop, con costes: **1R**. De aquí sale la cantidad. |
| Pérdida diaria | 2 % | Contando **al stop** lo que está abierto. Al tocarla, el agente se **pausa hasta que lo reanudes**. |
| Operaciones a la vez | 2 | |
| Operaciones al día | 4 | Día UTC. |
| Apalancamiento máximo | 10× | El motor elige uno igual o menor, con la liquidación detrás del stop. |
| Margen por operación | 25 % | El margen aislado: lo que se pierde si salta la liquidación. |
| Stop máximo | 3 % | Distancia del stop a la entrada. |
| Coste máximo | 0,2 R | Lo más que pueden llevarse comisiones y deslizamiento de 1R. |
| Objetivo mínimo | 15 veces el coste de ida y vuelta, y 0,5 % | Un objetivo que no paga sus costes no se ofrece. |
| Beneficio/riesgo mínimo | 1,5 | |
| Parte del primer objetivo | 50 % | |
| Stop a la entrada tras el primer objetivo | Sí | |
| Duración máxima | 24 velas | Pasadas, se cierra a mercado. |
| Espera tras un stop | 60 min | En ese par. |
| Pérdidas seguidas | 3 → 240 min de pausa | Corta las entradas del agente. |
| Consultas al día | 120 | El servidor tiene su propio tope, y manda el menor. |
| Gasto al día | 5 USD | En el modelo, con lo que OpenRouter dice que costó cada llamada. Una llamada cortada por tiempo se cobra entera y no dice cuánto: la app la cuenta aparte, «sin coste conocido», y este tope no la ve. La acota el de consultas, que se cuenta antes de llamar (spec 078). |

La validación cruzada impide lo que se contradice: una pérdida diaria menor que el riesgo de una
operación, más operaciones a la vez que al día, o márgenes que sumen más del 100 % del capital.

La línea **«Lo peor que puede perder en un día»** bajo la pérdida diaria es capital × pérdida
diaria, en la moneda de la cuenta.

### La autonomía

Cada clase de acción, por separado (decisión del 2026-09-24). Subir el riesgo o alejar el stop **no
es ninguna**: no existe.

| Clase | De fábrica | Opciones |
|---|---|---|
| **Entrar** | Te lo propone | Te lo propone · Entra solo · Solo mide |
| **Reducir el riesgo** | Lo hace solo | Lo hace solo · Te lo propone · Nunca |
| **Cerrar** | Te lo propone | Te lo propone · Cierra solo · Nunca |

«Solo mide» analiza y registra lo que habría propuesto, sin ofrecerlo ni abrirlo: riesgo cero para
ver cómo trabaja.

---

## Cada análisis

Al cerrar cada vela —más quince segundos para que el exchange la publique— el agente hace una
**ronda**. Antes de gastar nada mira sus barreras, en este orden, y la primera que se cierra es la
que se anota (R-12). Son las que responden a **«¿por qué no propone nada?»**, en el detalle del
agente → «Últimos análisis»:

1. agentes apagados en el servidor (`AI_DESK_ENABLE`), o en modo IA sin clave del modelo;
2. el dueño ya no es administrador (se lee de la base, no de la sesión);
3. el agente no está activo, o duerme tras fallos del modelo;
4. entradas cortadas por el interruptor global —con Redis caído, cortadas—;
5. la cuenta no se puede usar;
6. los límites del día: pérdida diaria, operaciones, racha de pérdidas;
7. sin sitio para otra operación;
8. tus límites de riesgo de la cuenta no dejan más bots;
9. todos sus pares ocupados —por una operación suya o por un bot real tuyo en ese par y cuenta
   (invariante 11)—;
10. ninguna operación posible;
11. **la misma oferta que la vez anterior**: preguntar otra vez sería pagar la misma respuesta;
12. sin consultas o sin presupuesto hoy, contados **antes** de llamar. Sin Redis no se llama.

Pasadas las barreras hay **una sola consulta** por ronda, con todas las operaciones posibles. Sin
respuesta válida no hay propuesta; cinco fallos seguidos dejan al agente **seis horas** sin
consultar, con un solo aviso (R-16). En modo **reglas** decide un juez determinista y no se paga
nada; es también la línea base con la que se compara a la IA.

«Analizar ahora», en el detalle del agente, hace una ronda fuera del reloj con las mismas barreras.
La app la enseña «analizando…» en cuanto empieza y avisa al terminar: el modelo puede tardar hasta
el plazo de `AI_DESK_TIMEOUT_MS` (90 s de fábrica), y esperarlo dentro de la petición la cortaría.
Entre dos del mismo agente pasa como poco un minuto más ese plazo: cada una puede costar una
consulta. «Revisar ahora», en una operación, funciona igual.

---

## Las propuestas

Una propuesta llega a **Telegram** con «✅ Ejecutar» y «✖ Descartar», y a **IA → Propuestas**, con
su cuenta atrás: caduca a los 15 minutos (`AI_DESK_PROPOSAL_TTL_MIN`), nunca más que la vela. Un
agente tiene como mucho **dos** esperando. El mensaje trae los precios para una persona: entrada,
stop, objetivos, la pérdida al stop en la moneda y en % del capital, y «DINERO REAL» si lo es.

**Ejecutar** es la misma rutina desde el botón, desde la app o en automático (R-19):

1. se reclama la propuesta —no se puede aprobar dos veces, ni desde dos sitios a la vez—;
2. se relee el dueño, el agente, el interruptor, la cuenta y el par;
3. **se recalcula con el precio de ahora**. Caduca con su motivo si el precio ya pasó el stop, se
   ha movido más de media distancia de stop o ya no cabe en los límites;
4. se crea el bot por `BotsService.create`, se enlaza a la propuesta **antes** de arrancarlo, y
   arranca. Si el arranque falla, el borrador se borra.

Desde la app, ejecutar una propuesta de una cuenta real pide una confirmación. El detalle de una
propuesta enseña el plan —con flechas, lo que cambió al recalcular—, por qué la eligió quien
decidía, lo que vio en cada par y qué habría pasado con ella.

---

## El seguimiento

Mientras la operación vive, el agente la mira al cerrar cada vela —solo si algo cambió desde la
última vez—, al cobrarse el primer objetivo y cuando se lo pides («Revisar ahora»). Elige entre las
acciones **válidas en ese momento** (R-22):

| Acción | Qué hace |
|---|---|
| Mantener | Nada. Siempre está, y es la respuesta por defecto. |
| Stop a la entrada | El stop, a la entrada más los costes. |
| Asegurar ½ R · Asegurar 1 R | El stop, donde deja ganado eso. |
| Reducir un tercio · Reducir a la mitad | La posición, a mercado. |
| Cerrar | Toda la posición, a mercado. |

**Todas reducen el riesgo.** Se aplican solo tocando el stop —más ceñido— o el tope de posición
—menor—, por `updateConfig` con la versión que se leyó, y se comprueban tres veces: el motor solo
ofrece lo que ciñe o reduce, la API lo vuelve a mirar contra la configuración de ahora y la
estrategia no ensancha su stop aunque se lo pidan. Un test de propiedad lo fija.

- **Un bot pausado por una persona no se toca.** Ni uno parado o en error.
- **Pausar el agente no para el seguimiento**, ni el interruptor global de entradas.
- **Sin modelo, decide el juez de reglas** (spec 078): si el modelo falla o no responde a tiempo, si
  el agente duerme tras sus fallos, si no quedan consultas o no hay clave, la vela no se salta. El
  juez solo elige entre lo que la autonomía ya ofrece, que solo reduce el riesgo, y la ronda lo dice
  («sin modelo»). Un fallo del modelo sigue contando para dormirlo.
- El seguimiento sí se para con `AI_DESK_ENABLE` apagado o con el bot pausado. El stop y los
  objetivos siguen en el exchange igual: no dependen de él.
- Con una acción esperando respuesta no se pregunta otra.

---

## Lo que nunca hace

- **Subir el riesgo o alejar el stop.** No existe la acción, y la estrategia lo ignoraría.
- **Mandar una orden desde la API.** Solo el worker firma, como con cualquier bot.
- **Poner un número.** El modelo emite enumeraciones; los números los calcula el motor.
- **Abrir dos operaciones en el mismo par** el mismo agente, ni una en un par donde tengas un bot
  real en esa cuenta.
- **Decidir con sus propios resultados.** Lo medido se enseña; nada de lo que decide lo lee, y dos
  tests lo afirman (R-25).
- **Reanudarse solo** tras tocar su pérdida diaria: lo decides tú.

---

## Resultados

**IA → Resultados**: una tarjeta de lo real y otra de lo simulado —**nunca se suman**; testnet va
con lo simulado— y una por agente.

Todo lo que el agente tuvo delante se **mide**, se tomara o no: cada operación posible de cada
ronda y cada propuesta reciben su **resultado hipotético** por triple barrera —entrando al cierre de
la vela de la decisión, con su stop, su primer objetivo y su duración máxima, con costes—. Es
pesimista: una vela que toca el stop y el objetivo cuenta como stop. Se mide a los :07, :22, :37 y
:52 de cada hora, cuando la vela ya lo resuelve.

| Línea | Qué dice |
|---|---|
| Propuestas | Cuántas, cuántas se tomaron, cuántas descartaste y cuántas caducaron. |
| Operaciones cerradas | Su R medio, el acierto con su **límite inferior de Wilson** y el número de casos. |
| **¿Discrimina la IA?** | El R hipotético de lo que eligió frente a lo que tuvo delante y no eligió. Si no va claramente por encima, el modelo no aporta —es lo que midió el spec 070—. |
| **Tus descartes** | Lo que habría dado lo que descartaste. |
| Al ejecutar | El R real menos el hipotético de lo ejecutado: lo que se pierde por aprobar tarde o entrar peor. |
| Por familia y cómo salieron | Dónde funciona y dónde no. |
| Coste de la IA | Consultas y dólares, por agente. |

Por debajo de **30 casos**, cualquier cifra lleva «muestra pequeña»: todavía no dice nada.

---

## Telegram

Con Telegram conectado, la preferencia **«Agentes de IA»** (Cuenta → Telegram, solo la ven los
administradores) trae:

| Evento | Qué es |
|---|---|
| `AGENT_PROPOSAL` | Una propuesta, con sus botones si se decide a mano; si entra sola, avisa de que entra. |
| `AGENT_PROPOSAL_RESULT` | Si al pulsar «Ejecutar» en Telegram no se abrió, por qué; y las averías del automático. Lo que sí se abre llega con `AGENT_ENTRY` al llenarse. |
| `AGENT_ACTION` | Una acción del seguimiento: con «Aplicar» y «Descartar» si te la propone; si la aplicó sola, qué hizo. |
| `AGENT_ENTRY` · `AGENT_EXIT` | La operación entró; salió, con su R y cómo. |
| `AGENT_BREAKEVEN` · `AGENT_STOP_TIGHTENED` · `AGENT_REDUCED` | El stop a la entrada, ceñido, o la posición reducida. |
| `AGENT_PAUSED` · `AGENT_CIERRE_FALLIDO` · `AGENT_FOREIGN_POSITION` · `AGENT_OPERACION_PERDIDA` | Riesgo: van con la preferencia de riesgo. |
| `AGENT_SLEEPING` · `AGENT_STOP_IGNORED` · `AGENT_ENTRY_DISCARDED` | Errores y cosas raras: van con la de errores. |

Los botones llevan un **vale de un solo uso**, del chat del dueño, que caduca con la propuesta: la
primera pulsación lo gasta y quita los botones. El resumen diario de las 21:00 trae una sección de
agentes, con lo real y lo simulado por separado. Todos los tipos empiezan por `AGENT_`, nunca por
`AI_`: esos son del Modo IA y del canal.

---

## Interruptores y variables

- **El interruptor global de entradas**, arriba en la pestaña IA: corta o abre las entradas de
  **todos** los agentes, con motivo. Lo abierto sigue con su stop, sus objetivos y su seguimiento.
- **El *kill switch*** (Cuenta → Riesgo) pausa **todos** tus agentes —con el motivo «kill switch»— y
  descarta lo que esperaba. Reanudarlos es cosa tuya, uno a uno.
- **Las variables del servidor** (`docker/.env`), todas `AI_DESK_*` —las `AI_AGENT_*` son del Modo
  IA—:

| Variable | De fábrica | Qué hace |
|---|---|---|
| `AI_DESK_ENABLE` | `false` | Apagado, no corre ninguna ronda, tampoco en modo reglas. Lo que caduca y lo que se concilia sigue corriendo. |
| `AI_DESK_MODEL` · `AI_DESK_REASONING` · `AI_DESK_PROMPT_CACHE` | `anthropic/claude-sonnet-5` · `medium` · `1h` | El modelo y cómo se le llama. |
| `AI_DESK_TIMEOUT_MS` | `90000` | Plazo de cada llamada, con tope en 120 000. Con `medium` el modelo puede pensar 4000 tokens antes de responder: con menos de 90 s se corta, y **una llamada cortada se cobra entera**. Por debajo de lo que pide el razonamiento (`low` 45 000, `medium` 90 000, `high` 120 000) la API lo avisa al arrancar. |
| `AI_DESK_DAILY_LIMIT` · `AI_DESK_GLOBAL_DAILY_LIMIT` | 200 · 600 | Consultas al día por agente y en toda la plataforma. |
| `AI_DESK_CONCURRENCY` · `AI_DESK_SWEEP_MAX` | 2 · 5 | Rondas a la vez, y agentes por barrido. |
| `AI_DESK_PROPOSAL_TTL_MIN` · `AI_DESK_ACTION_TTL_MIN` | 15 · 30 | Lo que vive una propuesta y una acción esperando. |
| `AI_DESK_MAX_WATCHLIST` | 12 | Pares por agente. |
| `AI_DESK_FORCE_MANUAL` | `false` | Todo lo automático pasa a propuesta. |
| `AI_DESK_DRY_RUN_ONLY` | `false` | Nada se abre en una cuenta real: se mide. |
| `AI_DESK_SHADOW_ONLY` | `false` | Nada se ejecuta en ninguna cuenta: se registra y se mide. |

Los tres frenos vienen **apagados** por decisión del usuario: son para cortar algo raro sin
redesplegar, no una segunda opinión sobre tu configuración. Cuando alguno está encendido, la
pestaña IA lo dice. La clave del modelo es la de OpenRouter de siempre, y
[`openrouter.client.ts`](../apps/api/src/modules/advisor/openrouter.client.ts) sigue siendo el
único fichero de la API que habla con él.

---

## Cómo empezar

1. **Un agente sobre la cuenta de simulación, en modo reglas.** No paga nada y enseña cómo
   trabaja: qué ve, qué propone y por qué no propone.
2. **El mismo en modo IA**, y deja correr hasta tener **más de 30 casos** en la tarjeta. Mira
   «¿Discrimina la IA?» y «Tus descartes» antes de fiarte de nada.
3. **En real, pequeño**: poco capital, «entrar» en «te lo propone», y aprueba a mano. La primera
   vez, comprueba en el exchange que el stop está puesto.

---

## Limitaciones conocidas

- **La ventaja no está demostrada.** El spec 070 midió, con 996 llamadas reales, que un modelo no
  distinguía lo bueno de lo malo en el canal. Por eso aquí todo se mide y se enseña.
- **Lighter y su cupo por IP** (60 peticiones por minuto): cada agente lee sus pares uno tras otro
  en cada vela. Con muchos pares en Lighter, las rondas compiten con tus bots.
- **Una operación cerrada fuera del bot** queda como «fuera del bot», sin R.
- **Tus límites de riesgo de la cuenta cuentan también los bots simulados** (se señala, no se
  cambia): con muchos bots de simulación, la barrera 8 puede cortar a un agente real.
- **Orden de despliegue**: primero la API —con sus migraciones— y justo después el worker, con
  `AI_DESK_ENABLE=false` hasta tener los dos.
