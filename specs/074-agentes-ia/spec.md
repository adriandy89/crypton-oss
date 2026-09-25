# 074 — Agentes de IA: analizan, proponen, ejecutan y siguen operaciones

Estado: `hecho` (faltan CA-12 a CA-14, que son del usuario, y lo Alto y lo Medio de su revisión,
el 075, que corrige el 076: `AI_DESK_ENABLE` apagado hasta entonces) · Tipo: `cambio` · Rama: `spec/074-agentes-ia` (sale de `spec/073-seccion-ia`)

## Objetivo

Dentro de la pestaña **IA** (spec 073, solo `ADMIN`), **agentes** configurables. Cada uno:
- se crea para una cuenta de un venue, con sus pares, su intervalo y sus límites;
- analiza cada intervalo y **propone operaciones direccionales de una sola vez** —entrada, stop
  nativo y uno o dos objetivos—, por Telegram y en la app;
- al aprobarlas, o solo si su autonomía lo permite, las **ejecuta** como un bot nuevo;
- mientras la operación vive, le **da seguimiento** y propone o aplica cambios que solo **reducen**
  el riesgo;
- y **mide** todo lo que propone, lo tome o no.

Se sabrá conseguido cuando:
- un agente sobre la cuenta «Simulación» complete el ciclo entero: propuesta en Telegram →
  aprobación → bot → primer objetivo → stop a la entrada → cierre, con su R en la tarjeta de
  resultados;
- un extremo a extremo automatizado con un modelo simulado haga lo mismo sobre el simulador;
- y todo pase en verde.

## Contexto

Pedido del usuario el 2026-09-24, al abrir la sección de IA:

> *«Quiero un modo IA configurable, varios tabs dentro según sea necesario. El objetivo es por
> ejemplo crear un agente que yo pueda configurar los límites entre otras cosas, por ejemplo si creo
> un agente para hyperliquid quiero que analice los pares que yo le seleccione cada un intervalo y él
> me proponga operaciones por ejemplo vía telegram similar a como existe ahora, luego que una
> operación esté funcionando la IA le debe dar seguimiento y proponerme cambios que crea según el
> nuevo análisis y los aplique automático o no según la configuración similar a como se hace ahora
> con los bots.»*

Decisiones del usuario sobre las opciones que se le plantearon:

| Tema | Decisión |
|---|---|
| Qué es una operación | **Direccional y de una sola vez**: un bot nuevo `AGENT_TRADE` que termina al cerrarse la posición |
| Autonomía | **Por tipo de acción**: entrar (de fábrica propone), reducir riesgo (de fábrica aplica), cerrar (de fábrica propone). Subir el riesgo o ensanchar un stop no existe |
| Dinero | **Real desde el primer día**. La cuenta «Simulación» sigue disponible para quien la elija |
| Entrega | **El ciclo completo de una vez**: propuestas, ejecución y seguimiento en este spec |

Lo que la casa ya sabe y este spec respeta:
- **El reparto del canal** (specs 058-062): *la IA elige entre operaciones ya calculadas, sin
  respuesta válida no hay entrada, y las salidas nunca esperan al modelo*.
- **El invariante 13**: ninguna IA fija un número por su cuenta.
- **Spec 070**: 996 llamadas reales midieron que el modelo **no distinguía** lo bueno de lo malo.
  Aquí eso se **mide**, también sobre lo que no se toma, y se enseña. No bloquea nada.
- **Spec 066**: con comisiones reales, muchas operaciones no pagan su coste. De ahí las puertas de
  coste.
- **El Modo IA** (specs 046-056) ya tiene la maquinaria de proponer y aprobar por Telegram. No sirve
  tal cual para el seguimiento: prohíbe tocar el stop con la posición abierta y no cubre
  operaciones sueltas.

## Alcance

| Área | Qué |
|---|---|
| `strategy-core` | Estrategia nueva `AGENT_TRADE` («Operación IA»). La gestión de posición del canal se **mueve** a `operacion/gestion.ts`. El motor puro del agente vive en `agentes/`: límites, familias, tasas, herramienta, juez, propuesta, seguimiento y medición |
| `shared` | Vocabulario de los agentes: enums que calcan Prisma, lectores, vales, insignia y aritmética de resultados |
| `db` | Valor `AGENT_TRADE` en `StrategyKind` (migración propia) y las tablas del agente (otra migración). **Este spec autoriza tocar `packages/db/prisma`** |
| worker | El runner aplica pausar, avisos, apalancamiento por operación y el vigilante del stop a toda estrategia `apalancamientoPorOperacion`, no solo al canal. Telegram: eventos sin bot, botones `ag` y preferencia `agentes` |
| API | Módulo `ai-desk`: agentes, rondas, contrato con el modelo, propuestas, aprobación con recálculo, ejecución, seguimiento, medición, rutas de administración y variables `AI_DESK_*`. `openrouter.client.ts` gana una carga de trabajo |
| app | La sección IA con sus pestañas (Agentes, Propuestas, Operaciones, Resultados), el editor y el detalle del agente, las propuestas, el panel de la operación en el detalle del bot y la preferencia de Telegram |
| docs | `docs/agentes-ia.md`, `docs/agent-trade.md`, las guías transversales, `README.md` y `CLAUDE.md` (mapa e invariante 13) |

## Fuera de alcance

- **Que el agente proponga bots de estrategias existentes** (rejillas, market makers…). Puede ser
  un spec posterior.
- **Plantillas de agente, guarda de correlación entre pares, ventanas macro, modelo en dos niveles,
  preguntas libres al agente por Telegram y arnés de walk-forward de las familias.** Quedan
  apuntadas como ideas.
- **Backtest de `AGENT_TRADE`**. Es una operación fechada: el agente se mide con su tarjeta.
- **Cambiar cómo `RiskService` cuenta los bots simulados.** Hoy cuenta también los simulados para
  `max_open_bots` y el nocional total. Se señala; cambiarlo afecta a todos los usuarios.
- **Desplegar.** Este spec no toca producción.
- **Portar al fork OSS.**

## Requisitos

### La operación (`AGENT_TRADE`)

- **R-1 — Una sola vez.** Entra como mucho una vez. Tras cerrarse la posición, vencer la entrada,
  invalidarse la idea o cancelarse, pide `requestStop` y **no vuelve a entrar nunca**, ni
  rearrancándola a mano.
- **R-2 — Stop nativo y monótono.** El stop es orden condicional del venue. Con posición, el motor
  guarda el más ceñido visto: una configuración que lo ensancha se **ignora**, venga de la IA o de
  una edición manual.
- **R-3 — Salidas.**
  - Primer objetivo parcial y segundo objetivo, como reduce-only.
  - Tras el primero, el stop pasa a la entrada más costes, y puede seguir al precio (trailing).
  - Cierre por tiempo y salidas de seguridad heredadas del canal: stop que no salta, liquidación
    demasiado cerca, apalancamiento distinto del pedido.
- **R-4 — Reducir y cerrar por configuración.** `positionCap` es un objetivo de nivel («la posición,
  como mucho X»). `'0'` es cerrar. Aplicarlo dos veces no reduce dos veces.
- **R-5 — Posición ajena.** Una posición que no es suya no se toca: se avisa en CRITICAL y el bot
  se para.
- **R-6 — Solo la crea un agente.** Crearla por HTTP responde `400`, y el asistente de creación no
  la ofrece. Es solo para administradores.
- **R-7 — La gestión del canal se mueve, no se copia.** Los tests del canal pasan **sin tocar una
  línea**.

### El runner

- **R-8** La operación de un agente recibe del canal lo que no depende de las intenciones de su IA:
  - `pausar`, los avisos y el apalancamiento por operación;
  - el vigilante del stop y la protección en pausa, con un contexto que **no** lee intenciones ni
    el interruptor del canal;
  - el barrido de ejecuciones antes de soltar el bot tras `STOP_AND_CLOSE`/`PANIC`;
  - y además cumple su `detener` y avisa de la salida con su R y su motivo.

  Para el canal no cambia nada: sus specs pasan sin tocarlas. Se decide por la estrategia y no por
  el flag `apalancamientoPorOperacion`: un spec del canal fija que el runner no da ese contexto a
  ninguna otra estrategia, y así sigue.

### El agente

- **R-9 — Configuración.**
  - Fijos tras crearlo: la cuenta y el venue.
  - Editables: pares (hasta `AI_DESK_MAX_WATCHLIST`), intervalo (15m/30m/1h/4h, nunca 1m: spec
    070), familias, lados, modo de decisión (IA o REGLAS), límites, autonomía por clase y
    presupuesto de consultas.
  - Crearlo, editarlo, pausarlo, reanudarlo y archivarlo pide motivo y se audita.
- **R-10 — Límites de fábrica prudentes** para dinero real, todos editables:

  | Límite | De fábrica |
  |---|---|
  | Riesgo por operación | 0,5 % |
  | Pérdida diaria | 2 % (pausa el agente) |
  | Operaciones vivas a la vez | 2 |
  | Operaciones al día | 4 |
  | Apalancamiento máximo | 10x |
  | Margen por operación | 25 % |
  | Stop máximo | 3 % |
  | Coste máximo | 0,2 R |
  | Objetivo mínimo | ≥ 15 veces el coste de ida y vuelta, y ≥ 0,5 % |
  | Beneficio/riesgo mínimo | 1,5 |
  | Espera tras un stop | 60 min |
  | Racha de pérdidas | 3 seguidas → 4 h de pausa |
  | Consultas al día | 120 |

  La validación cruzada impide combinaciones que se contradicen.
- **R-11 — Consentimiento.** Crear o activar un agente sobre una cuenta **real**, o pasar *entrar*
  a automático sobre ella, exige una casilla de consentimiento que el servidor comprueba.

### La ronda

- **R-12 — Barreras antes de gastar**, en este orden y cerrando ante la duda:
  1. interruptor del servidor;
  2. dueño `ADMIN` habilitado, leído de la base;
  3. agente activo y sin pausa por fallos;
  4. interruptor global de entradas;
  5. cuenta usable;
  6. límites del día;
  7. capacidad;
  8. límites del plan y de riesgo del usuario;
  9. pares libres (invariante 11);
  10. candidatos;
  11. huella sin cambios;
  12. cupos del agente y global, contados **antes** de llamar.

  Sin Redis no se llama.
- **R-13 — Los candidatos los calcula el motor.**
  - Familias TENDENCIA, RUPTURA y REVERSION, causales sobre velas cerradas.
  - Cada candidato lleva lado, extremo, opciones de stop con sus bandas de apalancamiento, y
    objetivos ya **validados**: coste, mínimos del venue, liquidación detrás del stop y límites
    del agente.
- **R-14 — Una llamada por ronda**, con todos los candidatos y en unidades relativas. El contrato
  es **solo enumeraciones**:
  - letra de la oferta o `NINGUNA` por defecto;
  - stop, objetivo, banda, tamaño, confianza, motivos y riesgos de listas cerradas;
  - texto de 200 caracteres como mucho;
  - esquema estricto sin ningún tipo numérico;
  - la confianza solo puede **reducir** el tamaño.
- **R-15 — Privacidad del render.** Ni símbolos, ni venue, ni precios absolutos, ni USDC, ni ids,
  ni nombres, ni textos anteriores del modelo. Un test lo recorre.
- **R-16 — Fallos.** Sin respuesta válida no hay propuesta. Cinco fallos seguidos dejan el agente
  seis horas sin consultar, con un solo aviso.
- **R-17 — Modo REGLAS.** Un juez determinista elige sin llamar a nadie. Sirve también de línea
  base.

### Propuesta, aprobación y ejecución

- **R-18 — La propuesta** guarda su plan en números y caduca (`AI_DESK_PROPOSAL_TTL_MIN`, nunca
  más que el intervalo). Llega a Telegram con dos botones y a la app. Como mucho dos mensajes con
  botones por ronda y agente.
- **R-19 — Una sola rutina de aprobación**, la misma para el botón de Telegram, la app y el modo
  automático:
  1. reclamo condicional (no puede aprobarse dos veces);
  2. dueño releído de la base;
  3. **recálculo** con datos frescos: caduca con su motivo si el precio pasó el stop, se movió más
     de media distancia de stop o ya no cumple los límites;
  4. comprobación del par;
  5. generador → `BotsService.create(startActive: false)` → `START`;
  6. si START falla, el borrador se borra;
  7. auditoría.
- **R-20 — Un bot por propuesta**, con índice único. Y una operación viva por par y agente, también
  en simulación.
- **R-21 — Conciliación.** El estado de la propuesta sigue al del bot: abierta, cerrada con su R y
  su motivo, o sin entrada. Tras una caída a media aprobación, se recupera sin duplicar.

### Seguimiento

- **R-22 — Qué puede hacer.**
  - Acciones: mantener, stop a la entrada, asegurar ½ R o 1 R, reducir ⅓ o ½, y cerrar. Solo se
    ofrecen las **válidas en ese momento**.
  - Se aplican **únicamente** tocando `stopPrice` (más ceñido) o `positionCap` (menor), por
    `updateConfig` con `expectedVersion`.
  - Un test de propiedad afirma que ninguna salida sube el riesgo.
- **R-23 — Autonomía por clase.** *Reducir riesgo* (de fábrica aplica) y *cerrar* (de fábrica
  propone). `AI_DESK_FORCE_MANUAL` pasa todo a propuesta. Un bot pausado por una persona no se
  toca.
- **R-24 — Cuándo mira.** Por su intervalo, solo si su expediente cambió, y ante eventos: primer
  objetivo, idea rota o cambio de régimen.

### Medición, avisos y administración

- **R-25 — Medición.**
  - Cada candidato y cada propuesta recibe un resultado hipotético por triple barrera, pesimista.
  - La tarjeta de resultados, por agente, separa real y simulado y incluye «¿Discrimina la IA?» y
    «Tus descartes».
  - **Nada lee la tarjeta para decidir**; un test lo afirma.
- **R-26 — Telegram.**
  - Eventos `AGENT_*` (nunca `AI_*`), también sin bot.
  - Botones `ag:<vale>:si|no|cierra`: vale de un solo uso, del chat del dueño, que caduca con la
    propuesta. Se quitan al pulsar.
  - Preferencia propia `agentes` y sección en el resumen diario.
- **R-27 — Interruptores.**
  - Interruptor global de entradas en Redis, con motivo.
  - El *kill switch* de la cuenta pausa sus agentes.
  - Variables `AI_DESK_ENABLE` (apagada hasta desplegar), `AI_DESK_FORCE_MANUAL`,
    `AI_DESK_DRY_RUN_ONLY` y `AI_DESK_SHADOW_ONLY`, estos tres **apagados** por decisión del
    usuario.
- **R-28 — Acceso.**
  - Rutas bajo `admin/ai-desk/…` con `@UseGuards(JwtAuthGuard, RolesGuard)` y `@Roles('ADMIN')` de
    clase, en `admin-guards.spec.ts`.
  - Cada administrador ve y toca solo sus agentes.
  - El rol se lee de la base en todo lo que da poder.
- **R-29 — La app** (spec 073 R-3): la sección con sus pestañas y su insignia de pendientes, el
  editor con consentimiento, el detalle del agente, las propuestas con aprobar y descartar, las
  operaciones, los resultados y el panel de la operación en el detalle del bot. Las operaciones
  cerradas no llenan la pestaña Bots.

## Criterios de aceptación

- **CA-1** `pnpm build:packages`, `pnpm test`, `pnpm lint`, `pnpm check:env` y `pnpm check:labels`
  en verde. También el tipado, el lint y el build de producción de la app, y los builds de la API y
  del worker.
- **CA-2** Los tests del canal (`ai-channel.spec.ts`, `engine.canal.spec.ts`,
  `bot-runner.canal*.spec.ts` y `canal-avisos.spec.ts`) pasan **sin cambios** tras mover su
  gestión.
- **CA-3** Tests de `AGENT_TRADE`: una sola vez sin reentrada, stop monótono ante cualquier
  secuencia de configuraciones, reducción idempotente, reparto de objetivos, salidas, posición
  ajena y `validate`/`preview`.
- **CA-4** Propiedades:
  - todo plan que sale del generador pasa `validate()` y `preview()`, y su pérdida al stop cabe en
    el riesgo;
  - ninguna acción de seguimiento sube el riesgo;
  - ningún esquema del contrato contiene tipos numéricos.
- **CA-5** Privacidad del render y versión del prompt fijadas por test.
- **CA-6** Barreras en orden, cupo antes de llamar, sin Redis no se llama, y una ronda por vela
  entre réplicas.
- **CA-7** Aprobación:
  - doble aprobación (app y Telegram) → un solo bot;
  - caducidad;
  - recálculo que invalida;
  - par ocupado;
  - START que falla → borrador borrado;
  - automático equivalente a la aprobación manual;
  - recuperación tras caída.
- **CA-8** Extremo a extremo sobre el simulador con un modelo simulado: propuesta → aprobación →
  bot → primer objetivo → stop a la entrada → segundo objetivo; y otra operación que sale por stop
  **sin volver a entrar**.
- **CA-9** Notificador y poller:
  - eventos sin bot entregados una vez;
  - teclado `ag` con `callback_data` de 64 bytes como mucho;
  - vale caducado;
  - prefijos `ia` e `ic` intactos.
- **CA-10** Migraciones probadas sobre una base temporal dentro del contenedor, sin leer ningún
  `.env`. La base del usuario no se toca.
- **CA-11** Acceso: `403` para cualquier no administrador en cada ruta, y `403` sobre el agente de
  otro administrador.
- **CA-12** *(usuario)* Un agente en simulación de punta a punta, con Telegram.
- **CA-13** *(usuario)* **Una operación real pequeña aprobada a mano**, con el stop visible en el
  exchange.
- **CA-14** *(usuario)* La barra y la sección en un móvil de 360 px.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Un fallo del generador con dinero real | Un solo camino de escritura y tres validaciones (herramienta, API y worker). Además, límites prudentes, consentimiento y *entrar* en «propone» de fábrica |
| Doble ejecución | Reclamo condicional, vale de un solo uso e índice único de bot por propuesta |
| Choque con los bots del usuario en el mismo par | Barrera de pares libres, comprobación al aprobar e invariante 11 en START |
| Seguimiento que sube el riesgo | Imposible por construcción (stop monótono en el motor, mapeo que solo ciñe o reduce) y fijado por test |
| Aprobación rancia | Recálculo con datos frescos y caducidad |
| El modelo no aporta (spec 070) | Se mide y se enseña: línea base del juez, «¿Discrimina la IA?» y modo REGLAS |
| Coste del modelo | Una llamada por ronda, huella, cupos antes de llamar, tope global y sin Redis no se llama |
| Cupo por IP de Lighter | Peticiones escalonadas por venue, caché compartida de velas y lista de pares acotada |
| Orden de despliegue | La API (migraciones) y **justo después** el worker, con `AI_DESK_ENABLE=false` hasta tener los dos |
| Operación cerrada fuera del bot | Se registra como «FUERA», sin R |

## Referencias oficiales

- OpenRouter, salida estructurada (`strict`, `require_parameters`) y caché de prompt: las mismas
  del spec 059, que ya las cita.
- Telegram Bot API, `editMessageReplyMarkup`
  (https://core.telegram.org/bots/api#editmessagereplymarkup). La usamos para quitar el teclado de
  un mensaje ya enviado, al pulsar uno de sus botones. Comprobado el 2026-09-24, al implementar el C8:
  - **La página del método no se ha podido leer.** La herramienta de consulta la corta antes de
    llegar a él, como ya se temía, así que su tabla de parámetros **no** es evidencia aquí.
  - La página oficial «Telegram Bot Features» (https://core.telegram.org/bots/features), en
    «Inline Keyboards», enlaza a ese método para esto mismo: *«To provide a better user
    experience, consider editing your keyboard when the user toggles a setting button or navigates
    to a new page – this is both faster and smoother than sending a whole new message and deleting
    the previous one.»* Y en «Bot Management»: *«Respond to `callback_query` updates by calling
    answerCallbackQuery.»*
  - La referencia de TDLib, sobre la que corre el servidor de la Bot API
    (https://core.telegram.org/tdlib/docs/classtd_1_1td__api_1_1edit_message_reply_markup.html):
    *«Edits the message reply markup; for bots only.»*, y de `reply_markup`: *«The new message
    reply markup; pass null if none.»*
  - **Cómo lo usamos:** `editMessageReplyMarkup` con `chat_id` y `message_id` y **sin**
    `reply_markup`, que es «ninguno». Si falla no se rompe nada: el vale es de un solo uso y una
    segunda pulsación contesta «Ya no está pendiente». Que quitar los botones funcione de verdad
    se comprueba con Telegram en la mano, en la CA-12.
