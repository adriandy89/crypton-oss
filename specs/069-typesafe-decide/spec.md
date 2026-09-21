# Spec 069 — TypeSafe decide

**Tipo**: cambio · **Rama**: `spec/069-typesafe-decide` · **Depende de**: 068

## El problema

El «Bot de IA» (`AI_TRADER`, spec 068) se llama así y **no tiene IA**. Decide una tabla de reglas.
El mando «Quién decide» ofrece `IA`, y al elegirlo `validate()` lo rechaza con un mensaje que dice
la verdad: falta conectar el proveedor.

El usuario pidió un bot donde decidiera el modelo **Jev de TypeSafe**. El spec 068 construyó el
motor, midió su cadencia por debajo del listón que él mismo se puso, y **paró antes de conectar el
proveedor**. Esa parada fue un error de reparto de papeles: la medición es un dato que el usuario
merece conocer, no un permiso que el agente se concede para no hacer lo que se le pidió. La
cadencia baja es un argumento para ajustar el motor o para operar poco, no para que el bot de IA
no tenga IA.

`TYPESAFE_AI_API_KEY` está configurada en el entorno del usuario y **no hay una sola línea de
código que la lea**: aparece solo en `docker/.env.example`.

## Lo que se hace

Conectar el proveedor y quitar el rechazo. Nada del motor del 068 cambia: la señal, la matriz de
nueve celdas, `cuantiza()`, `construirOperacionTrader()` y el juez de reglas se quedan como están
y como se midieron. Lo que se añade es **quién rellena la respuesta**: hoy solo `juezTrader()`,
a partir de aquí también Jev.

El juez **no se retira**. Es el brazo de control, el defecto y el respaldo: sin respuesta válida
del modelo no hay entrada, y `decisionMode: REGLAS` sigue siendo lo que trae un bot recién creado.

## Cómo funciona el proveedor, y qué impone

`POST https://api.typesafe.ai/v1/systemone` con `Authorization: Bearer`, cuerpo
`{state, model, questions}`, respuesta `{answers, usage}`. Tres hechos mandan sobre el diseño:

1. **Solo texto, y su idioma es el inglés.** El estado va en inglés y sin cifras con moneda, sin
   símbolo, sin fechas ni ids. Ya lo hace `trader/estado.ts` (spec 068).
2. **Las preguntas se evalúan en paralelo y en aislamiento.** Una respuesta no puede informar a
   otra. Por eso no se pregunta «¿qué candidato?» y luego «¿qué stop para ese candidato?»: hay un
   único montaje —la dirección la fija el borde tocado— y dos elecciones ortogonales encima.
3. **Devuelve números de opinión**: probabilidades y confianzas. Pasan por `cuantiza()` a
   enumeraciones antes de que nada aguas abajo los vea (invariante 13, ya escrito en el 068).

### Las ocho preguntas

Son las que se probaron contra BTC real durante el 068 y funcionaron:

| # | id | tipo | Para qué |
|---|---|---|---|
| 1 | `action` | choice (3) | `TAKE_THE_TOUCH` · `WAIT_FOR_A_BETTER_TOUCH` · `WRONG_ENVIRONMENT` |
| 2 | `regime_is_mean_reverting` | noul | El régimen, en aislamiento |
| 3 | `touch_is_exhaustion` | noul | El toque, en aislamiento |
| 4 | `history_supports_the_setup` | noul | Las tasas base, en aislamiento |
| 5-6 | `stop_width_is_determined` + `stop_width` | noul + choice (3) | El patrón `stated` |
| 7-8 | `target_depth_is_determined` + `target_depth` | noul + choice (3) | Ídem |

Las nouls 2-4 son las tres patas de la pregunta 1 preguntadas por separado. El código exige
**acuerdo**: si el enrutado dice `TOMAR` y una puerta de contexto lo veta, no se entra
(`MotivoTrader.DESACUERDO`). El desacuerdo no es un fallo, es una estadística de calibración.

**Todo lo que no es el `choice` solo puede restar.** Una noul puede vetar; la confianza puede
reducir el tamaño a la mitad. Ninguna amplía, ni sube apalancamiento, ni mueve un nivel.

## Arquitectura

| Capa | Dónde | Por qué ahí |
|---|---|---|
| El estado y las preguntas | `strategy-core/src/trader/` | `backtest` tiene que poder generar el mismo estado byte a byte para replicar el brazo del modelo sin red |
| El transporte | `apps/api/src/modules/ai-trader/typesafe.client.ts` | Segundo y último fichero que habla con un modelo |
| El lazo | `apps/api/src/modules/ai-trader/ai-trader.service.ts` | Hermano del del canal, con sus propios cupos e interruptor |

**No se extrae el lazo del canal.** El plan del 068 lo proponía; se descarta. Es código pagado con
incidentes, la ganancia es de unas doscientas líneas y la pérdida posible es un bot con dinero
dentro. Lo que sí se comparte es el vocabulario del resultado, que es lo que de verdad importaba:
dos decisiones de dos proveedores se comparan en `bot_ai_intents` sin saber de qué estrategia son.

### El reparto de intenciones: lo que hoy está roto

`AiChannelService.pendientes()` reclama **cualquier** solicitud `SOLICITADA`, sea de la estrategia
que sea. Con dos estrategias escribiendo en `bot_ai_intents`, el lazo del canal reclamaría las del
«Bot de IA», las marcaría `CONSULTANDO` y las cerraría con `ESTADO_BOT`: el bot no operaría nunca
y el motivo parecería un problema del bot. Es una condición de corrección, no una optimización.
Cómo se resuelve —soltar en el reclamo, filtrar en el sondeo— está más abajo, en «Lo que salió
distinto de lo planeado»: el filtro en el reclamo no era seguro.

## Criterios de aceptación

| id | Criterio | Listón |
|---|---|---|
| CA-1 | El modo IA se puede elegir: `validate()` ya no lo rechaza, y un bot en modo IA escribe su solicitud | verde |
| CA-2 | El cliente traduce cada modo de fallo a su `FalloModelo`, incluido el `529` como `SOBRECARGA` | verde |
| CA-3 | Ningún número del proveedor llega a `Decimal` ni a `precision.ts`: todo pasa por `cuantiza()` | verde |
| CA-4 | El lazo del canal no reclama una solicitud del «Bot de IA», ni al revés | verde |
| CA-5 | Las **afirmaciones** de `ai-channel.service.spec.ts` pasan sin tocarlas, y las claves de Redis del canal no cambian | verde |
| CA-6 | Sin clave, con el interruptor apagado o sin respuesta válida: **no hay entrada**, y el bot lo dice | verde |
| CA-7 | Batería completa, `worker`, `backtest`, typecheck de la app, `lint`, `check:env` | verde |
| CA-8 | **Manual (del usuario)**: un bot simulado en modo IA decidiendo con Jev | pendiente |

## Lo que salió distinto de lo planeado

Tres cosas, y las tres merecen quedar escritas porque cambian el diseño:

1. **El lazo del canal no se extrae.** El plan del 068 lo proponía. Al escribirlo se vio que son
   unas doscientas líneas de ganancia contra tocar un camino pagado con incidentes y con dinero
   dentro. Se descarta y se escribe un hermano.

2. **El reparto de intenciones no se resuelve con un filtro en el reclamo.** El reclamo es una
   actualización condicional —`updateMany`— y ahí un filtro por relación es terreno que no se
   puede comprobar sin base de datos; equivocarse significa que el reclamo no casa ninguna fila y
   **ningún bot recibe jamás una decisión**, en silencio, que es justo la clase de fallo que este
   repositorio ya ha pagado dos veces. Se resuelve al revés: lo que no es de un lazo se **suelta**
   —vuelve a `SOLICITADA`— y lo recoge el otro. Solo se suelta lo que es de alguien; una estrategia
   sin lazo se cierra como siempre. El filtro por relación sí va en el **sondeo** (`findMany`,
   `findFirst`), que es terreno probado en este repositorio, para que el ir y venir no ocurra en
   cada ciclo de diez segundos.

3. **CA-5 se cumple en lo que protegía, no en la letra.** El spec del canal conserva sus 148
   afirmaciones intactas; lo que sí se cambió es su **doble de base de datos**, que no entendía el
   filtro por relación. Un doble que ignora un filtro que la producción sí aplica da verde a un
   filtro que no filtra, así que dejarlo como estaba habría sido peor que tocarlo.

## Lo que se encontró de paso

`AI_TRADER` construía el id de sus intenciones como `reglas:<vela>`, sin el bot. Ese id es la
**clave primaria** de `bot_ai_intents`: dos bots de esta estrategia que decidieran la misma vela de
15 min colisionaban, el segundo se quedaba sin fila, el runner le quitaba la entrada del plan y no
operaba nunca, en silencio. El canal ya lo hacía bien. Corregido con su test.

## La corrección del propio spec: en modo IA decide la IA

La primera versión de este spec conectó el proveedor y **le dejó tres jueces encima**, todos
encendidos por defecto: un veto de las tres preguntas de contexto (`requireAgreement`), un suelo de
confianza (`minRouteConfidence`, `fullSizeConfidence`) y un umbral que descartaba su elección de
stop y objetivo para poner los valores por defecto (`statedThreshold`).

Con la confianza real del modelo —medida contra BTC, nunca pasó de 0,61— eso no era un matiz: en
las dieciséis llamadas de aquella prueba **su elección de stop se descartó las dieciséis veces**, y
la mitad de sus decisiones habrían salido a medio tamaño. Lo que decidía era el umbral.

Los cuatro pasan a cero, y sus mínimos bajan a 0 —antes eran 0,2 y 0,3, o sea que ni siquiera se
podían apagar—. Siguen siendo campos del usuario: quien quiera ese juez lo enciende.

**Lo que no se toca, porque no es corregir al modelo sino hacer ejecutable lo que elija**: el
invariante 13 —no emite precios, cantidades ni apalancamiento—, las puertas de viabilidad que
deciden qué celdas se le ofrecen, y que el stop y los objetivos sean órdenes nativas. El estado le
dice además qué opciones no están disponibles y por qué, así que elige sabiéndolo.

## Lo que no se hace

- **No se toca el motor del 068.** Ni sus defectos, ni sus puertas, ni la matriz.
- **No se toca Prisma.** `bot_ai_intents` sirve tal cual: `kind` es texto libre y `modelo`
  distingue quién decidió.
- **No se inventa un precio.** TypeSafe no publica tarifas: `coste` se escribe `null` y los
  recuentos de *tokens* se guardan en el JSON de la decisión, para reconstruir la factura cuando
  las publiquen. Meter un número imaginario en una columna `Decimal(38,18)` es peor que no saber.
- **No se sube el listón de cadencia del 068 aflojando una puerta.** Sigue midiendo lo que mide.
