# 051 — El supervisor que solo avisa

Estado: `en curso` · Tipo: `cambio` · Rama: `spec/051-el-supervisor-que-solo-avisa`

## Objetivo

Que el Modo IA haga su trabajo:

- un bot sano no genera mensajes;
- el modelo ve el rendimiento real del bot, también el de un market maker;
- sus ajustes se aplican en el sentido pedido, se acumulan, y nunca suben el riesgo ni cierran una
  posición abierta.

Se sabrá que está hecho cuando, en producción, los tres bots en Modo IA pasen 24 horas con como
mucho un aviso cada uno, sus decisiones lleven `prompt_version = 2` y el expediente del market maker V2 de LIT
enseñe su margen por par en vez de «sin ciclos cerrados».

## Contexto

Nace de un incidente, no de un hallazgo de revisión. El 2026-09-15 el usuario pegó una captura de
Telegram con decenas de mensajes «El supervisor recomienda revisar este bot: …» y pidió revisarlo
todo para que la IA funcione. Por eso es spec de **cambio** con su propia revisión dentro (H-NN),
como el 050.

Lo que se midió en producción (`main` = `0d3ad2e`, contenedores de la API y el worker levantados el
2026-09-13), sobre tres bots simulados de un administrador en Hyperliquid:

| Bot | Estrategia | Modo |
|---|---|---|
| market maker de BTC | MARKET_MAKER | AUTO |
| market maker de HYPE | MARKET_MAKER | AUTO |
| market maker V2 de LIT | MARKET_MAKER_V2 | MANUAL |

- **108 decisiones `AVISAR`** en tres días, cada una con su mensaje de Telegram. Solo **un cambio
  aplicado** y dos sugerencias (una caducada y otra rechazada por el dueño).
- **60 llamadas pagadas al día**: los tres bots agotan a diario su cupo de 20. La huella que debía
  ahorrarlas casi nunca coincide.
- **Un único `AI_FAILED` real**, un timeout de 25 s el 14/09 a las 11:00. Durante las 24 horas
  siguientes el modelo escribió unos 20 avisos de «fallos de IA persistentes»: lo leía en las
  incidencias del propio expediente.
- **Cero ciclos cerrados** en los tres bots desde el arranque. Un market maker declara
  `keepCycleOnFlat` y no cierra ciclo nunca. Su rendimiento está en `bot_mm_stats`: el market maker V2 de LIT
  lleva 758 pares casados con margen bruto −16,6, comisiones 16,8 y realizado −33,4 sobre 500 de
  capital. El modelo no lo veía.
- El market maker de BTC aplicó «diferencial MENOS, cadencia MAS». Las perillas guardadas siguieron en `MEDIA`,
  y cuatro llamadas más pidieron lo mismo y acabaron en `SIN_CAMBIOS`.

Antecedentes: el supervisor es del spec 046, con la revisión del 047. El 049 hizo que la API
arrancara con él. El 050 cambió la conducta del motor ante una caída del venue, y de ahí salen los
tipos `VENUE_*`.

## Decisiones del usuario (2026-09-15, preguntadas antes de tocar nada)

1. **Contención inmediata.** Pausar el Modo IA de los tres bots (`paused_until`) hasta desplegar el
   arreglo. Hecho el 2026-09-15 a las 21:22 UTC, con plazo de tres días.
2. **Avisos.** Como mucho **un `AI_ADVICE` por bot cada 24 horas**. La decisión se guarda siempre.
3. **Ajustes.** **Relativos y como mucho dos perillas por decisión.** Cada campo se desplaza sobre su
   valor vivo lo mismo que se desplaza en la configuración generada, nunca en sentido contrario, y
   los campos de una perilla se mueven juntos. Con posición abierta no pasa nada que suba el riesgo.
   **Sustituye el tope de cuatro campos de R-10 del spec 046.**
4. **Despliegue.** Lo hace Claude: merge a `main`, `push` a `origin`, `git pull` y rebuild de la API
   en el servidor, y vigilancia en solo lectura.

Decisiones técnicas tomadas por Claude a partir de esas cuatro o de un precedente, anotadas para que
se puedan revisar:

- **Importes proporcionales** (`vigente × después / antes`, redondeo hacia abajo) y el resto de
  campos numéricos **aditivos**. Sumar el delta de un importe a un bot ajustado a mano puede dejar su
  tope de posición en 1, y en un perfil prudente eso cierra la posición en el siguiente tick.
- **Enfriamiento WARM de seis horas** entre dos cambios WARM aplicados **por el supervisor**. Se lee
  de `bot_ai_decisions`, sin migración. Una aprobación humana queda exenta, igual que del tope diario
  (047, F-09).
- `VENUE_*` y `STREAM_*` **no** son incidencias del expediente: ya los avisa el motor y no se
  arreglan con perillas. Es la línea del spec 050.

## Hallazgos

Severidad según la escala de `specs/README.md`. **No se aplica el modificador de simulación**:
producción tiene `AI_AGENT_DRY_RUN_ONLY=false`, así que nada de esto se limita a bots simulados.

| Id | Sev. | Qué pasa | Evidencia |
|---|---|---|---|
| H-01 | Media | `AVISAR` no tiene estrangulador: cada revisión que avisa es un Telegram. El notificador no tiene enfriamiento por bot. | `supervisor.service.ts:343-349`; `notifier.service.ts:209-264` |
| H-02 | Media | **El expediente se lee a sí mismo.** `salud24h` agrupa TODOS los eventos de 24 h: los `AI_*` del supervisor, los `CONFIG_*` de su propio cambio, `FILL` (520 al día en lit), `ORDER_REJECTED` INFO por post-only (la conducta normal de un MM) y acciones humanas (`BOT_RESUMED`, `COMMAND_REPAIR`). El historial repite «AVISAR hace 30 minutos, 1 hora, 2 horas» y el modelo lo lee como un problema sin resolver. | `supervisor.service.ts:870-892`; `dossier.ts:228-233, 303-314` |
| H-03 | Media | Un market maker no cierra ciclos (`keepCycleOnFlat`), así que acierto, resultado medio, duración y comisiones salen «sin ciclos cerrados» siempre. `bot_mm_stats` y el realizado acumulado del snapshot no se usan. | `market-maker.ts:488-495`; `bot-store.ts:779-794`; `supervisor.service.ts:854-859, 933` |
| H-04 | Media | Las perillas no se guardan al aplicar. `last_apply_at` no se escribe nunca. | `supervisor.service.ts:410-432`; `schema.prisma:860` |
| H-05 | **Alta** | **La traducción escribe valores absolutos del generador sobre lo vivo.** (a) En lit, «diferencial MAS» pondría `buyDistanceBps` de 12 a 3. (b) En un bot ajustado a mano, «apalancamiento MUCHO_MENOS» multiplicaría `orderSizePerSide` por 1,9 y `maxBotPositionValue` por 5, y son tres campos, así que el tope de cuatro no lo para. (c) `coerceConfig` re-cuantiza la configuración entera y cambia campos que nadie pidió (`'12.5'` → 13, `null` → `''`). (d) El diferencial de la V2 mueve siete campos y muere siempre en `DEMASIADOS_CAMPOS`. Los tests construyen el bot vivo con el mismo `buildConfig` y las mismas perillas, y por eso nunca lo vieron. | `apply.ts:183-192, 266-353`; `sanitize.ts:91-116`; `apply.spec.ts:72-88`; `supervisor.service.spec.ts:51-72` |
| H-06 | **Alta** | Con inventario, `recortarConInventario` deja pasar «cobertura MAS» por ser «menos riesgo», que solo es cierto en las escaleras (fuera del alcance del 046). En un MM la cobertura sube `defensiveThresholdPct` y `highRiskThresholdPct` (70→94 y 80→100 en la propuesta real de lit), así que el modo defensivo llega más tarde. Además el «inventario» de un MM son los niveles de un ciclo que no cierra nunca: siempre es mayor que cero. | `apply.ts:101-111`; `build.ts:480-481`; `market-maker.ts:90-93` |
| H-07 | Media | La huella se construye y luego se corta a 64 caracteres: solo entran la estrategia, las perillas y la volatilidad anual y el ATR diario con 0,1 puntos de resolución. Casi toda revisión acaba en una llamada pagada, y ni la posición ni las incidencias entran nunca en la huella. | `dossier.ts:333-353` |
| H-08 | Media | El modelo no sabe qué movimiento tiene efecto. El diferencial de btc ya cotiza en el suelo por coste y «estrechar» no cambia nada; en TRAILING el diferencial y el crecimiento no producen ningún campo. Pide lo imposible y vuelve a pedirlo. | `build.ts:403-419, 651-680` |
| H-09 | Media | «Distancia a liquidación: sin posición abierta» con una posición abierta: el simulado no da `liquidation_price`. | `dossier.ts:198-201` |
| H-10 | Baja | El cupo global se incrementa antes de mirar el del bot, así que un bot con el suyo agotado sigue gastando el de la plataforma. | `supervisor.service.ts:104-124` |
| H-11 | **Alta** | El enfriamiento de seis horas entre cambios que recolocan la escalera, la mitigación del churn de comisiones en la tabla de riesgos del 046, no existe en el código. Es una red de seguridad documentada que es código muerto. | `specs/046-modo-ia-supervisor/spec.md` (Riesgos) |
| H-12 | Baja | El prompt de sistema dice «con dinero dentro» también a un bot simulado. | `decision.ts:175-177` |
| H-13 | Media | `aplicar()` da por `APLICADA` una respuesta `{ applied: false }` de `updateConfig`. Y como su `try` envuelve también las escrituras posteriores, un fallo al anotar un cambio ya aplicado se registra como `FALLIDA` con el aviso «no pudo aplicar su cambio». | `supervisor.service.ts:410-449`; `bots.service.ts:1019-1025` |
| H-14 | Media | La huella se guarda antes de saber si el modelo contestó. Con una huella estable, un timeout dejaría el bot sin revisar hasta que cambiara otra cosa. Tampoco lleva la versión del prompt, así que un bot tranquilo no se volvería a preguntar con el prompt nuevo. | `supervisor.service.ts:229` |
| H-15 | **Alta** | **Movimientos que parecen de menos riesgo cierran la posición abierta.** Estrechar `stopLossPct` (el precio del stop sale de la entrada: un largo que pierde un 4 % con el stop al 3 % salta al instante). En TRAILING, mover `takeProfitPct` o `trailingCallbackPct` puede dejar el disparo por encima del precio. En un MM con `limitAction` distinto de `PAUSE_ENTRIES`, bajar `maxBotPositionValue` por debajo de la exposición aplana la posición. El 046 prohíbe al supervisor cerrar posiciones. | `stop-loss.ts:56`; `trailing-take-profit.ts:298-306`; `mm-shared.ts:1003-1011` |

## Alcance

- `apps/api/src/modules/supervisor/`: `apply.ts`, `dossier.ts`, `decision.ts`,
  `supervisor.service.ts` y sus `*.spec.ts`.
- `apps/api/.env.example`, `docker/.env.example`, `docker/docker-compose.yml`: la variable
  `AI_AGENT_ADVICE_COOLDOWN_H`.
- `scripts/check-env.mjs`: que vea las lecturas `this.num('X', …)`.
- `docs/administracion.md`, sección del Modo IA.
- Operación en producción: la contención, el despliegue de la API y la corrección de datos de las
  perillas del market maker de BTC.

## Fuera de alcance

- **`packages/db/prisma`.** No hace falta migración: `last_apply_at` ya existe y todos los motivos
  nuevos caben en `discard_reason VARCHAR(24)`. El comentario del esquema que enumera los motivos
  queda desfasado y se documenta en el código.
- **El worker, `strategy-core`, `shared` y `exchange-core`.** Ni una línea.
- **La conducta de las estrategias.** Por qué el market maker V2 de LIT pierde en cada par es asunto de su
  configuración. Proponer ensancharla es trabajo del supervisor y decidirlo, del dueño.
- **La app.** Cola de decisiones, mandos de disparador e intervalo, rótulos de los eventos `AI_*`.
  Aplazado desde el 047.
- **Estrangular los `AI_FAILED`** que nacen al aplicar o al canjear un botón: son raros y siempre
  siguen a una acción.
- **El botón de una sugerencia ya caducada** que contesta «Aplicando…» y no hace nada.
- **La caché de prompt.**
- **`AI_AGENT_DRY_RUN_ONLY` en producción.** Está a `false`. Se recomienda ponerlo a `true` hasta
  verificar este spec, pero es un `.env` que no toca Claude.

## Requisitos

### Avisos

- **R-1** (H-01) Como mucho un `AI_ADVICE` por bot en `AI_AGENT_ADVICE_COOLDOWN_H` horas (24 por
  defecto), con un turno en Redis como el de `ai:fail`. Un `AVISAR` sin turno se guarda como
  `DESCARTADA` con `discard_reason = 'AVISO_REPETIDO'`: sin `bot_event`, sin publicar y sin retirar
  la propuesta anterior. Con Redis caído no se avisa.

### El expediente

- **R-2** (H-02) Las incidencias son solo eventos `WARN`, `ERROR` o `CRITICAL`, y nunca `AI_*`,
  `CONFIG_*`, `COMMAND_*`, los de ciclo de vida (`BOT_*`), `MARGIN_ADJUSTED`, `FILL`,
  `CYCLE_CLOSED`, `VENUE_*` ni `STREAM_*`. Las ejecuciones de 24 horas se cuentan aparte, como
  actividad.
- **R-3** (H-02) El historial solo trae **cambios** (aplicados, pendientes y rechazados) con los
  movimientos en enumeraciones, nunca el `motivo` que escribió el modelo. De los avisos, como mucho
  una línea que dice que ya se avisó a una persona y que no se repita salvo novedad.
- **R-4** (H-03) Un market maker se mide por sus pares casados y su margen bruto por par frente a
  las comisiones, con el realizado acumulado en porcentaje del capital. No se imprimen las líneas de
  ciclos cerrados. Toda estrategia lleva el realizado de las últimas 24 horas.
- **R-5** (H-09) Sin posición: «sin posición abierta». Con posición y sin precio de liquidación, se
  dice eso, no que no hay posición.
- **R-6** (H-08) El expediente dice, por perilla y sentido, si un movimiento tiene efecto y qué
  campos mueve, calculado con la misma cadena que aplica.
- **R-7** (H-07, H-14) La huella es un `sha1` de sus partes en tramos, sin truncar. Lleva la versión
  del prompt, la posición, las incidencias filtradas, los efectos y si hay un aviso vigente. Solo se
  guarda tras una respuesta válida del modelo.
- **R-8** (H-12) Prompt v2 (`PROMPT_VERSION_REVISION = 2`, mismo esquema): simulado o real según el
  expediente; qué es la cobertura en un market maker; cómo juzgar un MM por su margen por par; como
  mucho dos perillas; pedir solo lo que tiene efecto; `AVISAR` solo si hace falta una persona ya y
  no se arregla con perillas.

### La traducción

- **R-9** (H-05) Por cada campo que difiere entre la configuración generada con las perillas de antes
  y la de después:
  - **aditivo** (`vigente + (después − antes)`, redondeado al paso) en los campos numéricos;
  - **proporcional** con redondeo hacia abajo en los importes;
  - enumerados y booleanos solo si el valor vivo coincide con el de antes;
  - acotado al descriptor, y se descarta si queda igual o va en sentido contrario al generado;
  - nunca se re-cuantiza lo que no se mueve.
- **R-10** (decisión 3) Como mucho dos perillas distintas de `IGUAL` por decisión, o se descarta
  entera (`DEMASIADAS_PERILLAS`). Desaparece el tope de cuatro campos.
- **R-11** (H-06, H-15) Con posición abierta (snapshot fresco con cantidad; sin snapshot, el
  inventario del ciclo):
  - ningún campo de riesgo de la estrategia se mueve en su sentido arriesgado (`RIESGO`);
  - no cambia ningún campo que pueda disparar un cierre (`CIERRE`): el stop en las cuatro
    estrategias, y además el objetivo y el retroceso en TRAILING;
  - en un MM que no pausa entradas, el tope de posición no baja de 1,25 veces la exposición
    (`CIERRE`).
- **R-12** Si las cinco perillas van a `IGUAL`, `SIN_CAMBIOS` directo: la inacción sale gratis
  aunque haya algo que reparar.

### Aplicar

- **R-13** (H-04, H-13) `aplicar()` solo marca `APLICADA` lo que `updateConfig` aplicó. Tras aplicar
  guarda las perillas y `last_apply_at`, y un fallo en esas escrituras posteriores no se convierte en
  «no pudo aplicar».
- **R-14** (H-10) El cupo del bot se comprueba antes que el global.
- **R-15** (H-11) Un cambio WARM automático se descarta si el supervisor aplicó otro WARM en las seis
  horas anteriores. Una aprobación humana no pasa por ahí.

### Entorno y documentación

- **R-16** `pnpm check:env` detecta las variables que se leen con `this.num('X', …)`.
- **R-17** `docs/administracion.md` deja de prometer «como mucho cuatro parámetros» y cuenta lo nuevo:
  dos perillas, ajuste relativo, la guarda de posición, qué ve el modelo, un aviso cada 24 horas y
  la variable nueva.

## Criterios de aceptación

- **CA-1** `pnpm build:packages`, `pnpm test`, `pnpm lint` y `pnpm check:env` en verde desde Git
  Bash, incluido el test de arranque de la API (049).
- **CA-2** Matriz de bots **ajustados a mano** en `apply.spec.ts` (semilla fija, las cuatro
  estrategias). Cada resultado es un motivo conocido o un cambio en el que:
  - cada campo movido va en el sentido del delta generado;
  - nada fuera de lo movido o de los acoplamientos cambia;
  - `validate()` y `preview()` salen limpios y hay como mucho dos perillas;
  - con posición abierta no hay ningún movimiento arriesgado.
- **CA-3** Casos reales como tests con nombre:
  - lit V2 (12/14 bps), «diferencial MAS» → 14/16, nunca 3;
  - MM ajustado 300/2000, «apalancamiento MUCHO_MENOS» → unos 200 y unos 1333,33, nunca 1.
- **CA-4** Guardas con nombre:
  - cobertura MAS de un MM con posición → `RIESGO`;
  - cadencia MAS de TRAILING con posición → `CIERRE`;
  - MM prudente con cobertura MENOS cerca del tope → `CIERRE`, y con `PAUSE_ENTRIES` pasa;
  - tres perillas → `DEMASIADAS_PERILLAS`;
  - CA-4 del 046 (todo `IGUAL` → `NONE`; MAS y luego MENOS vuelve al original) también sobre bots
    ajustados a mano.
- **CA-5** Con el expediente real de lit (520 `FILL`, 19 `ORDER_REJECTED` INFO, 20 `AI_ADVICE`,
  margen negativo), el prompt:
  - no contiene `AI_`, `FILL` ni `ORDER_REJECTED` INFO;
  - dice que el margen por par es NEGATIVO y que un MM no cierra ciclos;
  - no dice «sin ciclos cerrados»;
  - sigue sin importes (CA-5 del 046).
- **CA-6** La huella tiene 40 caracteres hexadecimales. No cambia con el reloj, el historial ni ±0,1
  puntos de volatilidad, y sí con las incidencias, la versión del prompt, la posición, los efectos y
  el aviso vigente.
- **CA-7** Servicio:
  - un segundo `AVISAR` dentro de la ventana se guarda y no publica nada;
  - aplicar guarda las perillas y `last_apply_at`;
  - `applied: false` no es `APLICADA`;
  - con el cupo del bot agotado el global no se toca;
  - un WARM a una hora de otro se descarta y a siete no;
  - si el modelo falla no se guarda la huella.
- **CA-8** Cada salvaguarda nueva, rota a propósito, hace caer su test.
- **CA-9** En producción, en solo lectura tras desplegar:
  - las decisiones llevan `prompt_version = 2`;
  - como mucho un `AI_ADVICE` por bot;
  - el expediente de lit trae el bloque de market maker y los efectos, sin `AI_` ni `FILL` en las
    incidencias.
- **CA-10** Del usuario: 24 horas de Telegram tranquilo con el Modo IA reactivado.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| **Cambia cómo el supervisor modifica un bot vivo** (principio 6). | Es decisión explícita del usuario (decisión 3). Matriz a mano con semilla, guardas de posición, mutaciones rotas a propósito, y la recomendación de `AI_AGENT_DRY_RUN_ONLY=true` hasta verificar. |
| **El prompt nuevo cambia la conducta del modelo** de formas que un test no ve. | Se verifica en producción sobre los tres bots simulados (CA-9). La versión va en la fila y en la huella, así que las decisiones v1 y v2 se pueden comparar. |
| **El estrangulador vive en Redis.** | Un `FLUSH` permite un aviso de más; con Redis caído no se avisa. Es el mismo criterio que `reservarEntrega` del notificador. Lo que ahorra llamadas es la huella, no esto. |
| **El expediente crece** con el bloque MM y los efectos. | El test de tamaño se mantiene. Si se pasa, se recorta texto, no datos. |
| **Diez traducciones por revisión** para calcular los efectos. | CPU puro (dos `buildConfig`, `validate` y `preview` por llamada), sin E/S, una vez cada media hora como mucho. |
| **Datos en producción** (perillas de btc, pausa). | Una fila por bot, con `SELECT` antes y después. La pausa caduca sola a los tres días. |

## Referencias oficiales

Ninguna regla de venue ni de SDK sostiene este spec: no se habla con ningún exchange, no se firma
nada y no se manda ninguna orden. La única dependencia externa es OpenRouter, ya en uso, y su
contrato de salida no cambia.
