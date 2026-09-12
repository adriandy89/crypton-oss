# 046 — Modo IA: un supervisor que vigila bots vivos

Estado: `hecho` (falta CA-12 manual y aplicar la migración) · Tipo: `cambio` · Rama: `spec/046-modo-ia-supervisor`

## Objetivo

Que un bot que ya está operando pueda tener un **agente de IA vigilándolo**: que mire sus
parámetros, su rendimiento real y el estado actual del par, y decida si esa configuración sigue
teniendo sentido. Con dos modos — **automático**, que aplica el cambio, y **manual**, que lo propone
por Telegram y espera a que una persona decida.

Se sabrá que está hecho cuando un bot de un administrador en automático ajuste sus distancias solo
al cambiar la volatilidad del par, dejando su rastro en `bot_config_revisions` con `applied_by`
propio; y cuando el mismo bot en manual mande esa propuesta a Telegram con dos botones y no toque
absolutamente nada hasta que alguien pulse.

## Contexto

CRYPTON ya tiene un asesor de IA, pero solo sabe **hacer nacer bots**: `AdvisorService.suggest()`
propone tres configuraciones al crear uno y se desentiende. A partir de ahí el bot vive con los
parámetros del primer día aunque el mercado haya cambiado de régimen por completo. Un market maker
configurado con 20 bps de diferencial en una semana tranquila sigue cotizando a 20 bps cuando la
volatilidad se ha triplicado, y ahí ese diferencial ya no cubre ni las comisiones.

Lo que falta es lo contrario del asesor: no aconsejar al nacer, sino **vigilar lo que ya corre**. De
ahí el nombre: `advisor` aconseja, `supervisor` supervisa. Nombres distintos para trabajos distintos.

Nace de una petición directa del usuario, no de un hallazgo. Por eso es spec de **cambio** y no de
revisión. El hallazgo de `ADMIN_COMMAND` (R-9) aparece por el camino, sobre una línea que este spec
tiene que tocar de todas formas.

### Lo que ya existe y se reutiliza

| Pieza | Dónde | Para qué sirve aquí |
|---|---|---|
| `OpenRouterClient` | `apps/api/src/modules/advisor/openrouter.client.ts` | El único fichero del proyecto que habla con un modelo. Gana un método, no un hermano. |
| `buildConfig`, `defaultKnobs`, `shiftBand` | `apps/api/src/modules/advisor/build.ts` | Perillas a parámetros, de forma determinista. |
| `coerceConfig`, `enforceCouplings` | `apps/api/src/modules/advisor/sanitize.ts` | La barandilla, pura: recorta al descriptor y repara hacia menos riesgo. |
| `diffConfig`, `camposEfectivos` | `packages/strategy-core` | Clasifica el cambio en HOT/WARM/COLD y dice qué campos están activos. |
| `BotsService.updateConfig` | `apps/api/src/modules/bots/bots.service.ts:977` | **El único camino de escritura seguro.** |
| `MarketFeatures`, `resumenDeCiclos`, `repartoDeEjecucion` | `packages/shared` | El expediente, ya masticado. |
| `NotifierService`, `TelegramClient`, `TelegramPollerService` | `apps/worker/src/notifications/` | Telegram entero: preferencias, agrupación, cerrojos, vinculación. |
| `RetentionService` | `apps/worker/src/engine/retention.service.ts` | Ya corre cada hora tras cerrojo: la purga nueva entra ahí, sin cron nuevo. |

## Alcance

- **`apps/api/src/modules/supervisor/`** — el módulo nuevo. Tres ficheros puros (`apply.ts`,
  `decision.ts`, `dossier.ts`) y tres de Nest (servicio, planificador, política).
- **`apps/api/src/modules/admin/admin-ai.controller.ts`** — la superficie HTTP, con `@Roles('ADMIN')`.
- **`apps/api/src/modules/advisor/`** — `OpenRouterClient` gana `revisar()`; `build.ts` exporta
  `shiftBand`; el módulo exporta el cliente. Nada más cambia de conducta.
- **`apps/api/src/modules/bots/bots.service.ts`** — `updateConfig` acepta `opts.appliedBy`.
- **`apps/worker/src/notifications/`** — la escotilla de entrega, la preferencia `ai`, los botones.
- **`apps/worker/src/engine/retention.service.ts`** — purga del expediente.
- **`apps/api/src/libs/bus/` y `apps/worker/src/libs/bus/`** — `entregaForzada` en `BusMessage`.
- **`packages/db/prisma`** — enum `AiMode` y dos tablas. **Autorizado explícitamente por este spec**
  (`CLAUDE.md` lo prohíbe sin uno que lo pida).
- **`packages/shared/src/enums.ts`** — `AiMode`, calcado valor a valor.
- **`apps/app/src/app/features/admin/`** — panel del Modo IA y cola de decisiones.
- Las cuatro estrategias del alcance: `MARKET_MAKER`, `MARKET_MAKER_V2`, `TREND_FOLLOW`,
  `TRAILING_PROFIT`.

## Fuera de alcance

- **Las otras cinco estrategias** (`GRID_CLASSIC`, `NEUTRAL_GRID`, `TDCA`, `MARTINGALE`, `GRIDMART`).
  Decisión del usuario. En grids, martingala y gridmart los campos que de verdad importan están
  marcados `reshapes`, así que un cambio de forma se rechaza en cuanto el ciclo tiene inventario: el
  supervisor acertaría poco y gastaría igual.
- **Que el supervisor pueda parar, pausar, cerrar o cancelar nada.** Decisión del usuario. Su
  vocabulario es la configuración y solo la configuración: no emite ni un comando.
- **Modo IA para usuarios que no son administradores**, y **modo automático sobre bots ajenos**: eso
  exigiría un consentimiento del propietario que hoy no existe, y es spec propio.
- **Backtestear la propuesta antes de aplicarla.** Es lo más atractivo que queda fuera:
  `@crypton/backtest` ya es dependencia de la API y `runReplay` existe. Spec 047.
- **Reversión automática por mal resultado.** Revertir es manual y explícito.
- **Multiagente, herramientas, function-calling o streaming.** Una llamada, un JSON, un esquema.
- **Caché de prompt.** Medido en el asesor: el bloque estable no llega al mínimo de 1024 tokens de
  Sonnet, así que un `cache_control` sería un adorno que aparenta una optimización inexistente.

## Requisitos

### El modo y su frontera

- **R-1** Un bot puede tener Modo IA en uno de tres estados: `OFF` (por defecto, y lo que tiene todo
  bot que no lo haya encendido), `MANUAL` o `AUTO`. Vive en una tabla propia, no en `bots` ni en la
  configuración de la estrategia.
- **R-2** El Modo IA **solo se activa sobre bots propios de un usuario con rol `ADMIN`**. Se hace
  cumplir en tres sitios independientes: al activar (`Forbidden` si el bot no es suyo), al barrer (la
  consulta exige `role = 'ADMIN'`, de modo que quitarle el rol a alguien duerme sus políticas sin que
  nadie tenga que acordarse) y al aplicar (se escribe como el dueño, con `mustOwn` intacto). Así la
  frontera del spec 033 —sobre un bot ajeno un administrador solo puede `PAUSE` y
  `STOP_KEEP_POSITION`— no se toca: esto es el dueño operando su propio bot con una herramienta.
- **R-3** Activar o desactivar el Modo IA exige un motivo, se audita con severidad `WARN` y actor
  `ADMIN`, y deja un evento en el bot.

### El contrato con el modelo

- **R-4** El modelo **no emite parámetros ni valores numéricos**: emite una acción
  (`MANTENER`/`AJUSTAR`/`AVISAR`) y cinco **desplazamientos** enumerados
  (`MUCHO_MENOS`…`MUCHO_MAS`, es decir −2…+2) sobre las perillas que el bot ya tiene guardadas. El
  esquema JSON no contiene ni un `minimum`, ni un `maximum`, ni un `number`, y hay un test que lo
  recorre entero y lo afirma.
- **R-5** Las perillas de referencia se **guardan** por bot, sembradas con `defaultKnobs` al activar.
  Es obligatorio porque `buildConfig` no es invertible: la configuración de un bot que lleva tres
  semanas no dice con qué perillas nació, y sin punto de partida no hay desde dónde desplazarse.
- **R-6** **El perfil no se desplaza nunca.** No es un detalle: `buildConfig` deriva del perfil
  campos que definen qué clase de bot es —`limitAction`, `baseOrderType`, `stopOnRangeExit`,
  `autoAdjustDistance`—, y `limitAction` es `HOT`, así que ningún filtro de mutabilidad lo
  protegería. Con el perfil congelado son estables por construcción.
- **R-7** El modelo **no ve dinero ni texto libre escrito por una persona**. El expediente va en
  porcentajes y tramos; nunca un precio absoluto, nunca un importe, nunca `bot.name` ni `bot.note`
  (que son la vía natural de inyección de prompt).

### Lo que se puede cambiar, y lo que no

- **R-8** Toda propuesta pasa por la **misma cadena que el asesor**, y por el mismo camino de
  escritura que un usuario: `buildConfig` → fusión conservadora → `coerceConfig` →
  `enforceCouplings` → `validate()` → `preview()` → `assertWithinLimits` → `diffConfig` →
  `BotsService.updateConfig`. No hay un segundo camino de escritura. Es lo que convierte «la IA no
  puede proponer algo peligroso» en estructura y no en confianza.
- **R-9** La fusión **parte de la configuración vigente**, no de la generada: solo se pisan campos
  del descriptor con `mutability !== COLD` que `buildConfig` haya producido. `exchangeAccountId`,
  `symbol`, `direction` y `totalInvestment` se refijan explícitamente al valor vigente, porque
  `buildConfig` los escribe incondicionalmente y ninguno es asunto del supervisor. El importe menos
  que ninguno: decidirlo sería dejarle al modelo decidir cuánto arriesga alguien.
- **R-10** Topes duros que ninguna respuesta del modelo puede cruzar: el apalancamiento sube como
  mucho **un punto por decisión** y nunca por encima de `min(MAX_SAFE_LEVERAGE, market.maxLeverage,
  tope del usuario)`; `stopLossPct` solo se **estrecha**, nunca se ensancha ni se apaga; como mucho
  **cuatro campos** cambian por decisión; y con inventario abierto solo se honran los desplazamientos
  que **bajan** el riesgo.
- **R-11** Un cambio que resulte `COLD` es **un fallo nuestro, no del modelo**: significa que la
  fusión goteó. Se registra con severidad `ERROR` y hay test exhaustivo de que no ocurre.
- **R-12** Los campos marcados `reshapes` no se cambian si el ciclo tiene escalones ejecutados. Se
  descarta **antes** de llamar a `updateConfig`, que lanzaría `RESHAPE_WITH_INVENTORY`.
- **R-13** El supervisor nunca actúa sobre un bot que no esté `RUNNING`. En `ERROR` la premisa está
  rota —con el adaptador averiado la configuración no es el problema— y en `LIQUIDATED` no queda nada
  que ajustar.

### Cuándo revisa, y cuánto cuesta

- **R-14** Dos disparadores: **periódico** (30 min por defecto) y **por operación**. «Operación»
  significa **`CYCLE_CLOSED`**, nunca `FILL`: para un market maker un fill no es un acontecimiento
  —genera decenas por minuto— y lo que hay que juzgar es una media, no un evento. También disparan
  los avisos de riesgo: `RISK_GUARD_TRIPPED`, `LIQUIDATION_NEAR`, `INSUFFICIENT_FUNDS`,
  `POSITION_BELOW_MINIMUM` y `ORDER_REJECTED` con severidad `WARN` o superior.
- **R-15** Cinco barreras deterministas **antes** de gastar una llamada: el filtro por tipo, un hueco
  mínimo entre llamadas del mismo bot, coalescencia en Redis, un caché de decisión por huella
  cuantizada del expediente, y dos cuotas diarias (por bot y global).
- **R-16** Si Redis no responde, **se deniega la llamada**. Es lo contrario de lo que hace el resto
  del caché, que degrada abriendo la mano, y el motivo es el mismo que ya documenta el cupo del
  asesor: al otro lado hay una factura, y sin contador no hay tope.
- **R-17** El coste escala con (bots en Modo IA) × (revisiones por bot), y no se puede amortizar
  entre usuarios como hace el asesor —cuya clave de caché no lleva el bot a propósito—. La cuota
  global es lo que salva la factura si alguien enciende el modo en doscientos bots.

### Cuando algo falla

- **R-18** Si el modelo no contesta, caduca, rechaza o devuelve algo fuera del esquema, **no hay plan
  B determinista**: no se toca nada. Es la asimetría deliberada con el asesor, donde las reglas
  rellenan un formulario que una persona va a revisar; aquí reescribirían en silencio un bot vivo
  porque el modelo estaba caído.
- **R-19** Todo fallo se notifica, pero **estrangulado a uno por bot y hora**. Un OpenRouter caído
  que avisa en cada ventana enseña al usuario a silenciar el canal justo antes del aviso que sí
  importaba (lección del spec 029).
- **R-20** Tres interruptores: `AI_AGENT_ENABLE` apaga todo; `AI_AGENT_FORCE_MANUAL` degrada todo
  `AUTO` a `MANUAL` sin tocar la base —«deja de aplicar, sigue sugiriendo», que es el que de verdad
  se quiere a las tres de la mañana—; y `AI_AGENT_DRY_RUN_ONLY`, encendido en esta entrega, lo limita
  a bots simulados.

### El rastro

- **R-21** Cada decisión se guarda, **incluido el expediente que vio el modelo**. Sin él, una
  decisión rara es imposible de explicar seis meses después, y es lo primero que se mira cuando una
  configuración automática sale mal. La fila no se borra nunca, por lo mismo que
  `bot_config_revisions`: es la única explicación posible de por qué un bot con dinero dentro cambió
  de configuración solo. Lo que sí se vacía pasado un plazo es la columna del expediente, que es el
  grueso del peso.
- **R-22** Revertir es llamar a `updateConfig` con la configuración de la revisión anterior. No hace
  falta mecanismo nuevo: `bot_config_revisions` no se purga jamás, y la reversión es a su vez una
  revisión, que es lo correcto y lo auditable.

### Telegram

- **R-23** El modo manual notifica por Telegram con **botones de aprobar y descartar**. El botón no
  inventa nada: dispara una propuesta ya traducida, validada y acotada, y al pulsar se **rehace
  desde las perillas contra el mercado de ahora** —pasando otra vez por `validate()` y
  `preview()`— y se comprueba que la versión de configuración no haya cambiado. Una aprobación de
  hace una hora no aplica una configuración calculada hace una hora; si al rehacerla ya no cabe, la
  sugerencia caduca y se dice. *(Prometido aquí y no cumplido hasta el spec 047, F-04.)*
- **R-24** El botón lleva un **token opaco de un solo uso**, y se exige que el chat que pulsa sea el
  del dueño de la decisión. Un chat que no coincide recibe una respuesta neutra que no confirma
  siquiera que la decisión exista — el mismo criterio que el canje de códigos de vinculación.
- **R-25** Un aviso del supervisor es `INFO` y tiene que llegar igualmente, así que gana su propia
  preferencia (`ai`) en vez de publicarse como `WARN` para colarse por la vía genérica: eso sería
  mentir en la severidad. Los fallos sí van con los errores, porque quien silencia al supervisor no
  quiere dejar de saber que está roto.
- **R-26** Vincular Telegram no está limitado de ninguna forma, así que el modo manual es alcanzable
  para cualquier administrador que lo vincule. *(En la versión de la que deriva este proyecto las
  alertas eran función de un plan de pago y hacía falta una excepción para `ADMIN`; aquí no hay
  planes, de modo que el requisito se cumple solo.)*

### El defecto que aparece por el camino

- **R-27** **`ADMIN_COMMAND` no llega nunca a Telegram**, y su propio comentario dice que eso es
  «indefendible». Dos causas independientes: el notificador descarta los eventos cuyo origen no es
  el proceso que publicó —correcto para el caudal de fills, equivocado para lo que nace en la API—, y
  además el evento se publica sin `severity` ni `message`, de modo que la vía genérica, que exige
  `WARN` o más, tampoco lo entregaría. Es una red de seguridad documentada que es código muerto:
  **Alta** en la escala de `specs/README.md`. Se corrige aquí porque este spec tiene que tocar esa
  misma línea de todas formas, y con un test que falla antes del cambio.

## Criterios de aceptación

- **CA-1** `packages/strategy-core`, `apps/api` y `apps/worker` pasan sus tests, `pnpm lint` sale
  limpio y `pnpm check:env` no reporta ninguna variable sin declarar. Jest desde Git Bash.
- **CA-2** Un test recorre el esquema JSON del contrato entero y falla si aparece un `minimum`, un
  `maximum`, un `number` o una propiedad que no esté en `required` (R-4).
- **CA-3** La matriz exhaustiva de `apply.spec.ts` pasa para las cuatro estrategias sobre
  configuraciones vivas realistas y una muestra sembrada de los vectores de desplazamiento. Para cada
  caso, sin una sola salida muda: sin campos `COLD` en el diff; `exchangeAccountId`, `symbol`,
  `direction` y `totalInvestment` idénticos; ningún campo de carácter cambiado; ninguna perilla
  movida más de dos bandas; `validate()` sin errores; `preview()` sin violaciones; como mucho cuatro
  campos cambiados (R-6, R-9, R-10, R-11).
- **CA-4** Dos invariantes de conducta, en el mismo fichero: los cinco desplazamientos a `IGUAL`
  producen `level === 'NONE'` y no escriben revisión (la inacción sale gratis), y un `MAS` seguido de
  un `MENOS` devuelve **exactamente** la configuración original (sin oscilación).
- **CA-5** Un test serializa el expediente y falla si encuentra algo que parezca una credencial, un
  identificador de cuenta o de usuario, un precio absoluto, un importe en moneda, o el nombre o la
  nota del bot (R-7).
- **CA-6** Activar el Modo IA sobre un bot ajeno lanza `Forbidden` **aunque quien lo pida sea
  administrador**, y el barrido no devuelve bots cuyo dueño ha dejado de ser `ADMIN` (R-2).
- **CA-7** Con Redis simulado como caído no se llama al modelo ni una vez. Doscientos fills en un
  minuto no provocan ninguna llamada. Un bot en `ERROR` nunca se ajusta (R-13, R-14, R-16).
- **CA-8** En `MANUAL` no se llama a `updateConfig`: se escribe una propuesta con su caducidad. En
  `AUTO` se llama con `appliedBy` propio y la revisión resultante es idéntica en forma a una escrita
  por un usuario (R-8).
- **CA-9** Aprobar una propuesta cuya versión de configuración ha cambiado la marca caducada y **no
  toca el bot**. Pulsar dos veces el mismo botón aplica una sola vez (R-23, R-24).
- **CA-10** Un `ADMIN_COMMAND` disparado desde la consola llega al Telegram del dueño. El test que lo
  comprueba **falla antes del cambio**, que es lo que demuestra que el defecto era real (R-27).
- **CA-11** Un evento de origen ajeno **sin** la marca de entrega forzada se sigue descartando: el
  camino de alto volumen no cambia de conducta. Con la marca y el cerrojo denegado —la segunda
  réplica— tampoco se entrega (R-27).
- **CA-12** Comprobación manual del usuario con la infraestructura levantada: activar el Modo IA en
  manual sobre un bot simulado de market maker, forzar una revisión, recibirla en Telegram con sus
  dos botones, pulsar aplicar, y ver la revisión nueva en el historial de configuración del bot con
  el `applied_by` del supervisor.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| **Choca con el principio 6** de `specs/README.md`: «no cambiarle la conducta a un bot en marcha». | Activar el Modo IA **es** la decisión explícita del usuario que ese principio exige. `OFF` por defecto, opt-in por bot, `DRY_RUN_ONLY` en esta entrega, y todo reversible desde `bot_config_revisions`. |
| **El vaivén**: ajusta y a la hora siguiente deshace. | Desplazamientos acotados a ±2, las tres últimas decisiones dentro del expediente, tope de cambios aplicados al día, enfriamiento entre cambios que recolocan la escalera, y el test de CA-4. |
| **La fusión conservadora es la función más peligrosa del spec**: un descuido ahí reescribe un campo COLD de un bot con dinero dentro. | Es pura, exhaustivamente probada (CA-3), y `diffConfig` rechazando COLD es la red que hay detrás. |
| **Churn de comisiones**: cada cambio WARM cancela y vuelve a tender. | Interruptor por bot, enfriamiento de seis horas, y la guarda de inventario. |
| **Tocar el notificador afecta a todos los usuarios**, no solo a los del Modo IA. | La escotilla es opt-in **por mensaje**: sin la marca, ni una línea de conducta cambia. Tres tests cubren las tres ramas (CA-10, CA-11). |
| **Ampliar `allowed_updates` cambia lo que devuelve `getUpdates`** para todo el mundo. | El sondeo ignora en silencio cualquier callback que no reconozca. |
| **El planificador compite con el camino HTTP** por el bucle de eventos de la API. | Barrido en serie, tope de bots por vuelta, y casi todo el tiempo es espera de red, no CPU. Si llegara a molestar, mover **solo el planificador** al worker es un cambio local: la decisión y la escritura se quedan donde están. |
| **Un `chat_id` no es identidad suficiente** para autorizar un cambio sobre dinero. | Token de un solo uso, comprobación de propiedad del chat, recálculo y revalidación al aplicar, y caducidad corta. El peor caso de un Telegram comprometido es aplicar una sugerencia que ya era segura, nunca fabricar una configuración arbitraria. La app ofrece la misma aprobación. |
| **Tocar `packages/db/prisma`**, que `CLAUDE.md` prohíbe sin spec que lo pida. | Este spec lo pide y lo acota: un enum y dos tablas nuevas; ninguna columna de las existentes se toca. |

## Referencias oficiales

Ninguna regla de venue ni de SDK sostiene este spec: no se habla con ningún exchange, no se firma
nada y no se manda ninguna orden. Las dos dependencias externas son la API de OpenRouter —ya en uso
por el asesor, con su cliente y sus tests— y la API de bots de Telegram, también ya en uso. Lo único
nuevo de Telegram son los teclados en línea y el `callback_query`, cuyo límite de 64 bytes en
`callback_data` condiciona el diseño del token y queda anotado en `plan.md`.
