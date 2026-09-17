# 059 — Plan

## Enfoque

El 058 dejó al worker escribiendo la solicitud y esperando la decisión. Aquí se cierra el lazo por
el lado de la API, con el mismo reparto que el Modo IA (specs 046-056):
- la API solo pregunta;
- el worker calcula y ejecuta;
- ninguna IA escribe un número.

Encima van el producto (avisos, administración y app) y las guías.

Se construye de dentro afuera, y cada pieza tiene su test antes de pasar a la siguiente:
1. las piezas puras (vocabulario, contrato, render y prompt);
2. el transporte;
3. el lazo;
4. los eventos del worker;
5. los avisos;
6. la administración;
7. la app;
8. las guías.

## Decisiones que conviene no deshacer

- **El modelo no ve ids.** Los ids de los candidatos llevan la hora del primer toque del canal
  (`REB-L-H<epoch>`). La herramienta renderizada los cambia por etiquetas neutras (`A`, `B`…), el
  esquema acepta solo esas etiquetas o `NINGUNA`, y la API las traduce a ids antes de escribir la
  decisión.
- **El esquema se construye por solicitud.** El enum de `opcion` son las etiquetas de ESA oferta:
  una elección fuera de la oferta no pasa el esquema estricto, y si llega igual, el parser la
  rechaza.
- **La decisión que se guarda es la efectiva.**
  - La confianza solo reduce el tamaño: por debajo de `ALTA` el tamaño es `MEDIO`, aunque el
    modelo pida `COMPLETO`.
  - `bot_ai_intents.decision` lleva arriba la elección efectiva, que es lo único que lee el worker
    (`eleccionDe` ignora el resto). Dentro, en `respuesta`, va lo que dijo el modelo.
  - La estrategia aplica la misma reducción al leerla: segunda línea de defensa, con test.
- **Un fallo del modelo no es un «no».**
  - `FALLIDA` suma al contador de fallos; con 5 seguidos, 6 h sin consultas.
  - `SIN_ENTRADA` es una respuesta válida que no opera: `NO_OPERAR`, fuera de la oferta, confianza
    corta o modo sombra.
  - Un tiempo agotado por culpa de un plazo que ya venía recortado (la solicitud llegó tarde) no es
    un fallo del modelo: `CADUCADA` (`PLAZO`), y no cuenta.
- **Con la IA apagada, la API sigue cerrando solicitudes.** No llama, pero cierra cada una con su
  motivo (`IA_APAGADA`). Así el administrador ve por qué el bot no entra y las filas no se quedan en
  `SOLICITADA`.
- **Los cupos se cuentan antes de llamar**, en Redis y por día UTC, como los del supervisor. Con
  Redis caído no se llama.
- **La clave del transporte va por llamada.** `headers()` usaba siempre la del asesor (hallazgo
  latente, abajo).
- **Los eventos `AI_*` del canal no recargan el Modo IA.** Hoy la app recarga el Modo IA con
  cualquier `AI_*`. Pasa a una lista cerrada en `shared` (`EVENTOS_MODO_IA`).
- **`AI_EXIT` sustituye a `CYCLE_CLOSED` en estos bots.** Lleva lo mismo (`realizedPnl`, `seq`)
  más el R y el motivo.
  - El aviso de la estrategia que hoy se llama `AI_EXIT` (cierre a mercado ordenado) pasa a
    `AI_CIERRE`, en INFO: ya no es la salida, es la orden de salir.
- **El botón «⏸ Pausar» lleva un vale opaco**, como los del Modo IA (`ic:<vale>:pausa`), nunca el
  id del bot.
  - El vale es de un solo uso y va atado al dueño.
  - Lo canjea la API, que vuelve a leer el rol de la base y pausa por `BotsService.command`, con
    auditoría.

## Hallazgo latente (se corrige aquí, con su test)

Con `AI_AGENT_ENABLE=true` y `AI_ADVISOR_ENABLE=false`, `headers()` manda `Bearer ` sin clave, y el
supervisor recibe un 401 en cada revisión. El test que falla primero es: supervisor encendido,
asesor apagado → la cabecera lleva la clave. Se corrige pasando la clave de cada llamada a
`headers()`.

## El vocabulario (`packages/shared/src/ia-canal.ts`)

**`MotivoConsulta`.** Por qué la API cerró una solicitud sin decisión utilizable. Va a
`bot_ai_intents.motivo`:
- barreras: `IA_APAGADA`, `DUENO`, `ESTADO_BOT`, `PAUSA_FALLOS`, `INTERRUPTOR`, `REDIS`,
  `CUPO_BOT` y `CUPO_GLOBAL`;
- respuestas sin entrada: `NO_OPERAR`, `OFERTA`, `CONFIANZA` y `SOMBRA`;
- fallos: `MODELO` y `CONTRATO`;
- tiempo: `PLAZO`.

**Contrato del modelo:**
- `MotivoCanal`: `CANAL_CLARO`, `CANAL_JUSTO`, `REGIMEN_RANGO`, `REGIMEN_DUDOSO`,
  `CONFIRMACIONES_FUERTES`, `CONFIRMACIONES_JUSTAS`, `EVIDENCIA_FAVORABLE`, `EVIDENCIA_ESCASA`,
  `EVIDENCIA_DESFAVORABLE`, `RECOMPENSA_BUENA`, `RECOMPENSA_POBRE`, `COSTE_ALTO`, `DIA_TENSO` y
  `NINGUNO`.
- `RiesgoCanal`: `RUPTURA`, `TENDENCIA_CERCANA`, `LIQUIDEZ`, `VOLATILIDAD`, `RACHA`,
  `TOPE_DIARIO_CERCA`, `FUNDING` y `NINGUNO`.
- `RespuestaModeloCanal`: la respuesta validada, con la etiqueta.
- `DecisionGuardada`: `EleccionOperacion` más `respuesta`.

**Eventos:**
- `EventoCanal`: `AI_DECISION`, `AI_ENTRY`, `AI_EXIT`, `AI_CIERRE`, `AI_ENTRY_DISCARDED`,
  `AI_DAY_STOP`, `AI_BREAKEVEN`, `AI_CIERRE_FALLIDO`, `AI_POSICION_HUERFANA` y `SIN_STOP`.
- `EVENTOS_MODO_IA`: `AI_MODE`, `AI_SUGGESTION`, `AI_APPLIED`, `AI_ADVICE`, `AI_FAILED` y
  `AI_DECISION_TAKEN`.

**Botón de pausa:** `PREFIJO_BOTON_CANAL = 'ic'` y `claveValeCanal(vale)` (`ic:vale:<vale>`).

**Vistas para la app y la API:**
- `EstadoCanalBot`, `DecisionCanalVista`, `ResumenCanalAdmin`;
- `VistaCanal`: lo que el plan deja en el scratch.

**Funciones puras, con test:**
- `vistaCanalDe(scratch)`: frontera JSON; valida o devuelve `null`.
- `operacionDe(scratch)`: la operación viva.
- `lineasDelCanal(canal, desde, hasta)`: los puntos de las tres líneas, inclinadas incluidas, para
  el gráfico.
- `cifrasCanalDe(metrics)`: `porSetup`, `ventanas` y `operaciones` de un backtest guardado.
- `rachaDePerdidas(resultados)`: la usan el worker y la API.

**En `OpcionStop`:** el campo nuevo `medioViable` (el tamaño `MEDIO` llega al mínimo del venue).
Lo calcula la herramienta con la misma cuenta que `construirOperacion`.

## El transporte (`advisor/openrouter.client.ts`)

- **Nuevo `decidirCanal(p)`:**
  - entra: `{ esquema, system, usuario, limiteMs }`;
  - devuelve: `{ contenido: string | null; uso: UsoModelo | null; fallo: FalloModelo | null;
    latenciaMs: number }`.
- **Configuración.** El modelo, el razonamiento y la caché salen del entorno
  (`AI_CHANNEL_MODEL`, `AI_CHANNEL_REASONING`, `AI_CHANNEL_PROMPT_CACHE`), leído en el constructor
  como el resto del cliente.
- **`UsoModelo`:** `tokensEntrada`, `tokensSalida`, `tokensCacheLeidos`, `tokensCacheEscritos`,
  `tokensRazonamiento` y `coste` (cadena decimal, o null).
  - OpenRouter devuelve el uso en todas las respuestas (`usage.cost`, en créditos = USD). El número
    del JSON cruza a `Decimal` una sola vez, como cualquier número externo.
- **`FalloModelo`:** `SIN_CLAVE`, `HTTP`, `TIEMPO`, `NEGATIVA`, `TRUNCADA`, `RED` o `VACIA`. Se
  registra en `bot_ai_loops.ultimo_error`.
- **Caché del prompt.** El mensaje de sistema va como bloque de texto con
  `cache_control: { type: 'ephemeral', ttl: '1h' }`. Con `5m` se usa el TTL por defecto; con
  `off`, sin marcador.
  - El prompt de sistema pasa de 1.024 tokens, el mínimo cacheable de los Sonnet que documenta
    OpenRouter.
  - CA-10 comprueba con una llamada real que la caché se activa.
- **`pedir()`** pasa a devolver `{ contenido, uso, fallo }`, con la clave y el plazo por llamada.
  `knobsFor()` y `revisar()` siguen devolviendo solo el contenido, así que sus llamantes no cambian.
- **Clave propia:** `AI_CHANNEL_ENABLE` + `OPENROUTER_API_KEY` → `canalDisponible`, independiente
  del asesor y del supervisor.
- **Cabecera.** `X-Title: Crypton AI channel` (ASCII: lo vigila el test de cabeceras).

## Las piezas puras (`apps/api/src/modules/ai-channel/`)

### `contrato.ts`

- **Versión.** `VERSION_CONTRATO_CANAL = 1`.
- **`esquemaDecision(etiquetas)`.** Todas las claves van en `required`, con
  `additionalProperties: false` y sin tipos ni restricciones numéricas:
  - `veredicto`, `opcion` (etiquetas + `NINGUNA`), `stop`, `objetivo`, `apalancamiento`, `tamano`
    y `confianza`, con los enums de `shared`;
  - `motivo1`-`motivo3` (`MotivoCanal`), y `riesgo1` y `riesgo2` (`RiesgoCanal`);
  - `motivo`, un texto de como mucho 200 caracteres sin cifras (lo dicen la descripción y el
    prompt; el parser lo recorta sin partir pares sustitutos).
- **`parseDecision(raw, etiquetas)`.** No repara nada:
  - rechaza un JSON inválido, un array, una clave que falte o sobre, y cualquier enum fuera de su
    lista;
  - `OPERAR` con `NINGUNA` es una contradicción y también se rechaza (`CONTRATO`).
- **`validarEleccion(respuesta, oferta, cfg)`** devuelve la elección efectiva o el motivo:
  - `NO_OPERAR` → `SIN_ENTRADA` (`NO_OPERAR`);
  - fuera de la oferta → `OFERTA`: stop no viable, esquema fuera de los suyos, banda que no existe o
    candidato no elegible;
  - confianza por debajo de `minAiConfidence` → `CONFIANZA`;
  - reducción: por debajo de `ALTA`, `MEDIO`; si `MEDIO` no llega al mínimo (`medioViable`) →
    `OFERTA`;
  - la etiqueta se traduce al id del candidato.

### `herramienta.ts` (el render)

- **`ofertaDe(salida, cfg)`** devuelve `{ etiquetas: Map<etiqueta, candidato> }`, solo con los
  candidatos elegibles y dentro de la configuración: dirección, setups y canales, las mismas
  comprobaciones que `construirOperacion`.
- **`renderHerramienta(salida, oferta, cfg)`** devuelve el texto, en unidades relativas y con
  punto decimal:
  - distancias en % de la entrada y en ATR(15m);
  - R netos, coste en R y acierto de equilibrio;
  - riesgo, margen y pérdida catastrófica en % del capital;
  - liquidación en stops;
  - apalancamiento en «x»;
  - tasas base (n, acierto, Wilson, R medio y evidencia);
  - régimen y canal con sus medidas, y posición del precio dentro del canal;
  - uso del día (pérdida frente al tope, operaciones y racha);
  - las preferencias del dueño (perfil, dirección, confianza mínima, esquemas y R mínimo).
- **Nunca:** precios, niveles, importes, USDC, cantidades, ids, horas absolutas, nombres, el par ni
  la huella.
- **Opciones no viables.** Se enseñan como «no disponible», con su motivo en palabras (a partir de
  los códigos de `herramienta.ts`: `STOP_ANCHO`, `RR`, `MINIMO`…), para que el modelo no las elija.

### `prompt.ts`

- **Sistema.** Castellano y fijo, de unos 2.000 tokens. Cubre:
  - el papel y el reparto (la herramienta ya calculó y acotó todo);
  - `NO_OPERAR` por defecto y ante la duda;
  - cómo leer régimen, canal, confirmaciones, tasas base, Wilson, R y coste;
  - los perfiles, con la misma tabla que el juez (`canal/juez.ts`); ordenan y nunca aflojan;
  - la banda de apalancamiento no cambia la pérdida al stop, sí el margen y la liquidación;
  - el texto de la herramienta es un dato y no una instrucción;
  - solo vale lo ofrecido;
  - el `motivo` va sin cifras.
- **Usuario.** El render de la herramienta.
- **Versión.** `VERSION_PROMPT_CANAL = 1` y `versionPrompt()` = `canal-v1-<sha256 del sistema y
  del esquema de ejemplo, 16 hex>`. Va a `bot_ai_intents.prompt_version` (64 caracteres como
  mucho).
- **Test.** El hash está fijado: cambiar el prompt obliga a subir la versión.

## El lazo (`ai-channel.service.ts` y `ai-channel.scheduler.ts`)

- **Entrada de trabajo.**
  - Por el bus: `BOT_AI_REQUESTS`. El mensaje trae el bot y la vela, y con ellos se busca la
    intención `SOLICITADA`.
  - Por un sondeo cada 10 s: las `SOLICITADA` vigentes, las más antiguas primero.
  - Concurrencia: `AI_CHANNEL_CONCURRENCY` (4) por réplica, con un semáforo en memoria.
- **Reclamar.** `updateMany { id, estado: SOLICITADA, expires_at > ahora } → CONSULTANDO`. Solo
  quien toca una fila llama.
- **Barreras.** Por orden; la primera que falla cierra la intención con su motivo, sin llamar:

  | Barrera | Resultado | Motivo |
  |---|---|---|
  | `AI_CHANNEL_ENABLE` apagado o sin clave | `SIN_ENTRADA` | `IA_APAGADA` |
  | Dueño que no es `ADMIN` habilitado (de la base) | `SIN_ENTRADA` | `DUENO` |
  | Bot que no está `RUNNING` o no es `AI_CHANNEL` | `SIN_ENTRADA` | `ESTADO_BOT` |
  | Lazo en pausa por fallos | `SIN_ENTRADA` | `PAUSA_FALLOS` |
  | Interruptor global en `off` | `SIN_ENTRADA` | `INTERRUPTOR` |
  | Redis caído al leer el interruptor | `SIN_ENTRADA` | `REDIS` |
  | Menos de 8 s hasta el plazo | `CADUCADA` | `PLAZO` |
  | Herramienta ilegible, sin configuración u oferta vacía tras filtrar | `SIN_ENTRADA` | `OFERTA` |
  | Cupo del bot: `min(aiDailyCallBudget, AI_CHANNEL_DAILY_LIMIT)` | `SIN_ENTRADA` | `CUPO_BOT` |
  | Cupo global: `AI_CHANNEL_GLOBAL_DAILY_LIMIT` | `SIN_ENTRADA` | `CUPO_GLOBAL` |
  | Redis caído al contar | `SIN_ENTRADA` | `REDIS` |

  La oferta se mira antes del cupo: una oferta vacía no gasta una llamada. El cupo se consume en
  la barrera; lo que se cuenta es la llamada que se va a hacer.
  - El interruptor se lee en crudo (`getTextoOrThrow`) y con la regla de `shared`
    (`interruptorCerrado`), la misma que el worker: `off` a mano, sin comillas, también cierra.
- **Llamada.** El plazo es `min(AI_CHANNEL_TIMEOUT_MS, vence − ahora − 3 s)`, con
  `AI_CHANNEL_TIMEOUT_MS` topado en 25 s.
- **Resultado:**
  - sin respuesta → `FALLIDA` (`MODELO`); si fue por tiempo con el plazo recortado, `CADUCADA`
    (`PLAZO`) y no cuenta;
  - respuesta inválida → `FALLIDA` (`CONTRATO`);
  - en los dos casos de `FALLIDA`: `fallos + 1`, a los 5 pausa de 6 h y `AI_FAILED` como mucho uno
    por hora por bot (`ai:fail-canal:<bot>`);
  - respuesta válida → `fallos = 0`; y después:
    - `NO_OPERAR` → `SIN_ENTRADA` (`NO_OPERAR`);
    - validación que falla → `SIN_ENTRADA` (`OFERTA` o `CONFIANZA`);
    - modo sombra → `SIN_ENTRADA` (`SOMBRA`), con la decisión efectiva guardada;
    - si no → `DECIDIDA`.
  - Con respuesta o sin ella, si hubo llamada: `llamadas_hoy + 1` y `coste_hoy + coste`, con el día
    UTC (se reinician al cambiar de día).
  - Siempre se escriben `modelo`, `prompt_version`, `latencia_ms` y `coste`; la decisión, si la
    hay.
  - La escritura final es condicional a `CONSULTANDO`: si el worker ya la caducó, se registra y no
    se pisa.
- **Después.**
  - `AI_DECISION` en la línea de tiempo, en INFO y sin `entregaForzada`: no va a Telegram.
  - `BOT_AI_INTENTS` al worker, solo si quedó `DECIDIDA`.
- **Barrido.** Cada minuto, con cerrojo: `SOLICITADA`, `CONSULTANDO` o `DECIDIDA` vencidas hace más
  de 30 s → `CADUCADA` (`PLAZO`).
- **El módulo.**
  - Importa `AdvisorModule` (el cliente) y `BotsModule` (la pausa).
  - Nunca importa `ExchangeAccountsModule`.

## El worker

- **`AI_ENTRY`.**
  - Cuándo: en `despuesDelCanal()`, cuando la intención pasa de verdad a `ABIERTA`. `abrir()`
    devuelve si movió la fila, y así un reinicio con la posición abierta no repite el aviso.
  - Texto: lado, cantidad, entrada media, apalancamiento, nocional, stop, objetivos, riesgo en USDC,
    R planeado y liquidación estimada.
  - `payload`: `{ intentId, vale }`. El vale sale de `intents.valeDePausa(bot)`, que lo guarda en
    Redis (`ic:vale:<vale>` → `{ userId, botId }`, 24 h).
- **`AI_EXIT`.**
  - Cuándo: al cerrarse el ciclo, en lugar de `CYCLE_CLOSED`.
  - Cómo: `applyFillToCycle` gana la opción `eventoCierre(cierre)`, que devuelve el evento que se
    emite (por defecto, el `CYCLE_CLOSED` de siempre).
  - El runner captura `op` y `cierre` del scratch ANTES de aplicar el llenado, porque el ciclo
    nuevo los borra.
  - Motivo: `STOP_LOSS` → stop (o breakeven si ya lo estaba); `TAKE_PROFIT#0/1` → objetivo;
    `TAKE_PROFIT#500+` → el motivo del cierre; liquidación; lo demás, cierre manual.
  - R = resultado / `plan.riesgo`.
  - `payload`: `{ realizedPnl, seq, r, motivo, intentId }`.
- **`AI_CIERRE`.** El aviso de la estrategia que hoy es `AI_EXIT`, en INFO.
- **La vista.** En plano, el plan deja `scratch.vista` con:
  - el régimen, el sentido y el canal (tipo, calidad, niveles, pendiente y `refT`);
  - la vela y la nota.

  Así el panel y el gráfico ven el canal aunque no haya setup. Con posición, el canal es el de
  `op.plan.canal`.
- **La confianza en la estrategia.** Al usar una decisión de la IA, por debajo de `ALTA` el tamaño
  es `MEDIO` (la misma regla que la API).
- **Retención.** La purga horaria vacía `bot_ai_intents.snapshot` con el plazo del expediente del
  Modo IA (`RETENTION_AI_DOSSIER_DAYS`, 90 días). La fila no se borra nunca. Estaba en el plan
  aprobado y no lo había hecho ni el 058 ni este spec: se añade en la fase 9, con su test y cuatro
  mutaciones.
- **`medioViable`** en la herramienta.

## Avisos (`notifications/`)

- **`EVENT_PREF`:**
  - `AI_ENTRY` y `AI_EXIT` → `cycles`;
  - `AI_DAY_STOP`, `SIN_STOP`, `AI_CIERRE_FALLIDO` y `AI_POSICION_HUERFANA` → `risk` (hoy caen en
    `errors` por la vía genérica; un CRITICAL de posición sin stop no puede depender de la
    preferencia de errores);
  - `AI_ENTRY_DISCARDED` → `errors`, con `MIN_SEVERITY` WARN (el «no se llenó» es INFO y se queda en
    la línea de tiempo).
- **Iconos.** `AI_ENTRY` 📥, `AI_EXIT` 📤, `AI_DAY_STOP` ⛔, `AI_ENTRY_DISCARDED` ↩️.
- **Botón.** `tecladoDe()` añade, con un vale válido (32 hex), `⏸ Pausar el bot` →
  `ic:<vale>:pausa`. Un mensaje con teclado sale solo y al momento; ya es así.
- **Poller.** Acepta `ic:<vale>:pausa` además de `ia:…`, con exactamente tres partes y el vale
  en hexadecimal.
  - Publica `AI_CHANNEL_PAUSE` en `BOT_EVENTS`, sin `botId`.
  - Contesta «Pausando…».
- **`AI_DECISION` no se entrega**, y lo fija un test.

## La pausa desde Telegram (API)

1. El planificador del canal escucha `AI_CHANNEL_PAUSE`.
2. `getDel('ic:vale:<vale>')` hace el vale de un solo uso, también entre réplicas.
3. El vale tiene que ser del usuario del chat.
4. El dueño tiene que seguir siendo `ADMIN` habilitado, leído de la base.
5. `BotsService.command(dueño, bot, { command: 'PAUSE' })`. Un bot que ya no está vivo da 409 y
   se ignora.
6. `audit.recordNow` (`bot.ai_channel.pause_button`, WARN), porque no pasa por el interceptor.

## Administración y acceso

- **Listado de estrategias.** `strategiesMeta(userId)` lee el rol de la base
  (`esAdministradorHabilitado`). Enseña `AI_CHANNEL` solo a un administrador habilitado.
  - El test del 058 que la ocultaba a todos se reescribe.
  - La app guarda la lista por usuario.
- **`BotCommandDto`.** Un test fija la lista de comandos: `AI_INTENT` no existe y da 400.
- **Controlador nuevo `AdminAiChannelController`** (`@Controller('admin')`, guardas de clase,
  registrado detrás de `AdminAiController`):

  | Ruta | Qué |
  |---|---|
  | `GET admin/ai-channel` | Interruptores del servidor, estado del interruptor global, cupo global de hoy y los bots `AI_CHANNEL` propios con su lazo |
  | `PUT admin/ai-channel/entries` | `{ abiertas, reason }`. Escribe o borra `crypton:ai-channel:entries`; sin Redis, 503. Auditado (`admin.ai_channel.entries_open` o `…_close`, WARN) |
  | `GET admin/bots/:id/ai-channel` | Estado del bot (propio; si no, 403): interruptores, lazo, «Hoy» y las últimas 5 decisiones |
  | `GET admin/bots/:id/ai-channel/decisiones` | Paginado por cursor (`antes`, `limite` ≤ 50) |
  | `GET admin/bots/:id/ai-channel/decisiones/:intentId` | Una decisión con su herramienta completa |

  - **«Hoy».** Sale de `bot_cycles`: operaciones, realizado, % del capital frente al tope y racha
    (`rachaDePerdidas`). Las llamadas y el coste salen de `bot_ai_loops`.
  - **Tests.** `admin-guards.spec` incluye el controlador nuevo. `admin-ai-channel.routes.spec` monta
    los tres controladores en su orden: `admin/ai-channel` no lo captura el detalle, y un USER recibe
    403 en todas.
  - **e2e de aislamiento.** Se añaden las rutas a su lista de superficie.

## La app

- **Etiquetas.**
  - `EVENT_LABELS` para los eventos del canal.
  - `FIELD_LABELS` y ayudas `strategy.aiChannel.*` para todos los campos.
  - `OPTION_LABELS` para los valores nuevos, con excepciones por campo: `MEDIA` es la línea media en
    los esquemas y la confianza media en `minAiConfidence`; `NEUTRAL` es «Ambas» en la dirección
    del canal.
  - Títulos de grupo por estrategia (`groupLabel(grupo, estrategia)`).
- **Modo IA.** Se recarga solo con `EVENTOS_MODO_IA`, en `ModoIaService` y en el detalle.
- **Crear.**
  - **Tarjeta.** Solo llega a administradores (la lista viene del servidor), con la insignia de
    riesgo alto y la de administración.
  - **Paso de revisión.** Casilla obligatoria con el texto aprobado; sin ella no se crea.
  - **Sin asesor y sin editor del Modo IA.** Se usa `esEstrategiaSoloAdmin`, así que el editor ya
    no parpadea mientras carga `/admin/ai`.
  - **Límites.** `limitIssues` usa la regla de la estrategia: con `reglaLiquidacion: POR_STOP`, el
    tope es `min(25, máximo del par)` y no se aplica la regla del 5 %. El nocional es el que
    declara (`nocionalMaximo`).
  - **Paso 4.** Los textos de la escalera cambian en este bot: «Calcular los límites», «Esto es lo
    que puede arriesgar».
- **`canal-ia-panel.component.ts`** (`shared/bot/`, estilos propios):
  - estado del lazo: IA encendida, modelo, sombra, interruptor global, fallos y pausa;
  - régimen y canal (`scratch.vista`);
  - operación viva (`scratch.op.plan` y el ciclo);
  - «Hoy»: pérdida frente al tope, operaciones, llamadas y coste;
  - últimas decisiones, con la elección, los motivos y el texto;
  - acciones: pausar el bot (comando `PAUSE`, con confirmación que dice que se cancelan los
    objetivos y queda solo el stop) y encender o apagar entradas (`entriesEnabled` por
    `updateConfig`, con la versión leída). Sin motivo: `PATCH /bots/:id/config` no lo lleva, y el
    cambio queda en el historial de configuración.

  Va en el detalle del bot, en la pestaña Resumen, y en la hoja de la consola para los bots
  propios, donde sustituye al panel del Modo IA y se alimenta del detalle del dueño
  (`GET /bots/:id`). Lee el estado con `CanalIaService` y el mercado del `scratch` del ciclo, y
  se relee con los eventos del canal de su bot.
- **Gráfico.**
  - `price-chart` gana la entrada `canal`: tres `LineSeries` (soporte, resistencia y media)
    calculadas con `lineasDelCanal`, que se retiran al cambiar de serie.
  - En la página, una capa «Canal» en la leyenda.
- **Consola.**
  - Pastilla del canal con `pastilla()` de `CanalIaService` (consulta, sombra, en pausa,
    apagada o sin entradas) en la lista de la consola, en la lista de bots y en la cabecera del
    detalle.
  - Interruptor global en el hub de administración, con motivo obligatorio. Va en su propio
    componente, que pide sus datos y no pinta nada si no llegan: el hub sigue sin poder fallar.
- **Caché de estrategias.** Por usuario y rol, guardando la promesa: dos pantallas comparten la
  petición y un fallo no se queda guardado.
- **Backtest.**
  - `ventanasConsecutivas` (1-6) cuando el bot es del canal.
  - Tabla por setup y tabla de ventanas.
  - Al reabrir un backtest guardado, las cifras salen de `cifrasCanalDe(run.metrics)`.
- **Presupuestos.** Los componentes nuevos llevan su CSS. Las hojas que están al límite no crecen:
  lo que haga falta va a `global.scss` con prefijo.

## Guías

- **`docs/ai-channel.md`** (plantilla de `trailing-profit.md`): qué hace, el reparto IA/motor,
  parámetros, límites, avisos, panel, pausa, modo sombra, costes, y cómo empezar (backtest,
  simulación, capital pequeño).
- **`docs/README.md`**: la fila de la estrategia.
- **`administracion.md`**: la sección del canal, con el interruptor y su auditoría.
- **`comandos-guardas-y-eventos.md`**:
  - la sección «Canal con IA» con sus eventos;
  - las guardas;
  - la nota de que en estos bots `CYCLE_CLOSED` es `AI_EXIT`.
- **`riesgo-y-liquidacion.md`**:
  - la regla por stop, con un ejemplo;
  - el tope diario hasta las 00:00 UTC, frente a la pausa de las demás;
  - su fila en la tabla.
- **`buenas-practicas.md`** y **`simulacion-y-backtest.md`** (calentamiento,
  `ventanasConsecutivas`, cifras por setup y aviso del juez).
- **`README.md` raíz** (tabla de estrategias).
- **`CLAUDE.md`:**
  - el mapa: el módulo `ai-channel` y que `openrouter.client.ts` sirve a los tres;
  - las invariantes 1 y 13 con el texto aprobado del plan.
- **`ai-channel.guide.ts`** de la app, al día.

## Entorno (API)

| Variable | Defecto | Qué |
|---|---|---|
| `AI_CHANNEL_ENABLE` | `false` | Interruptor de la IA del canal |
| `AI_CHANNEL_MODEL` | `anthropic/claude-sonnet-5` | Modelo |
| `AI_CHANNEL_REASONING` | `medium` | Esfuerzo de razonamiento (`low`, `medium`, `high`) |
| `AI_CHANNEL_TIMEOUT_MS` | `20000` | Plazo de la llamada, topado en 25.000 |
| `AI_CHANNEL_DAILY_LIMIT` | `48` | Techo por bot al día |
| `AI_CHANNEL_GLOBAL_DAILY_LIMIT` | `400` | Techo global al día |
| `AI_CHANNEL_PROMPT_CACHE` | `1h` | `1h`, `5m` u `off` |
| `AI_CHANNEL_SHADOW_ONLY` | `false` | Registra y nunca ejecuta |
| `AI_CHANNEL_CONCURRENCY` | `4` | Consultas a la vez por réplica |

`OPENROUTER_API_KEY` se reutiliza. Las variables van en `apps/api/.env.example`, en
`docker/.env.example` y en el compose, y `pnpm check:env` los cruza.

## Fases

| Fase | Qué | Salida |
|---|---|---|
| 0 | Rama, spec y línea base | Verde |
| 1 | `shared` y `strategy-core`: vocabulario, vistas y funciones puras; `medioViable`, `vista` y la confianza en la estrategia; `AI_EXIT` → `AI_CIERRE` | Tests de los paquetes, del worker y del backtest |
| 2 | Transporte: `decidirCanal`, uso, coste, caché y la clave por llamada | Tests del cliente |
| 3 | Contrato, render y prompt | Tests de contrato, privacidad y versión |
| 4 | El lazo, la pausa por botón y el entorno | Tests del servicio y del planificador; `check:env`; el grafo de Nest arranca |
| 5 | Worker: `AI_ENTRY`, `AI_EXIT` sin `CYCLE_CLOSED`, vale de pausa; e2e en modo `IA` | Tests del runner, del store y e2e |
| 6 | Avisos y poller | Tests del notificador y del poller |
| 7 | Administración y acceso | Tests de rutas, guardas, 403 y DTO |
| 8 | App | `ng lint` y `ng build` dentro de presupuesto |
| 9 | Guías y `CLAUDE.md` | Revisión de enlaces y conteos |
| 10 | Verificación, mutaciones y cierre | CA-1 a CA-9 |

## Mutaciones previstas (CA-8)

**Contrato y render:**
- el parser acepta una clave de más, una opción fuera de las etiquetas u `OPERAR` + `NINGUNA`;
- la validación no mira si el stop es viable, ni el esquema, ni la confianza mínima, ni la
  reducción de tamaño, ni `medioViable`;
- el render lleva un precio o el id.

**El lazo:**
- el cupo se cuenta después de llamar;
- Redis caído deja llamar;
- el reclamo o la escritura final sin condición de estado;
- el umbral de fallos pasa de 5 a 6;
- sin estrangular `AI_FAILED`;
- la sombra decide;
- sin barrera de dueño, de estado o de plazo;
- el tiempo recortado cuenta como fallo.

**Cliente:**
- la clave del asesor en el canal;
- `cache_control` con `off`.

**Worker:**
- `AI_ENTRY` tras un reinicio;
- `CYCLE_CLOSED` en el canal;
- el R con el denominador equivocado;
- la estrategia sin reducir por confianza;
- `medioViable` con la cantidad entera.

**Avisos y pausa:**
- el teclado ausente;
- el poller con otro número de partes;
- el vale leído sin borrarlo;
- el vale de otro usuario.

**Administración:**
- el interruptor sin auditoría;
- el listado enseña el canal a un USER.

## Verificación

- Jest desde Git Bash, con `pnpm build:packages` antes de worker, backtest y API.
- Por paquete: los tests, `pnpm lint`, `pnpm check:env`, `pnpm --filter api build`, el build del
  worker con `tsc`, y `pnpm --filter app lint` y `build` (presupuestos).
- Fines de línea con `eol.cjs`; `eslint --fix`, nunca `prettier --write`.
- `app.module.spec.ts` construye el grafo con el módulo nuevo.

## Referencias oficiales

Ver `spec.md`.

## Cierre (fase 10)

**Decisiones tomadas al implementar**, cada una con su test o su nota:
- **Las claves del cupo** tienen una sola definición (`claveCupoBot`, `claveCupoGlobal`,
  `diaDelCupo`), que usan el lazo y la consola.
- **`eleccionDe` vive en `shared`**: la usan el worker para ejecutar y la consola para enseñar.
- **Cortar las entradas de un bot** desde su panel va sin motivo: `PATCH /bots/:id/config` no lo
  lleva, y el cambio queda en el historial de configuración, con la versión leída.
- **La ficha de la consola** de un bot propio del canal enseña su panel en lugar del Modo IA, y lo
  alimenta con el detalle del dueño.
- **La retención de `bot_ai_intents.snapshot`**, que pedía el plan aprobado y no hacía nadie, entra
  en la fase 9 (`ddbb2d3`).
- **El backtest de la app** elige velas de 5 min para un bot del canal (`f1a0813`): con otras, la
  API responde 400.
- **`AI_FAILED`** se rotula «La IA no pudo actuar»: lo emiten el Modo IA y el canal por motivos
  distintos.

**Mutaciones.** Caen las 224:

| Fase | Qué | Caen |
|---|---|---|
| 1 | Vocabulario, vistas, `medioViable`, la confianza en la estrategia | 30 de 30 |
| 2 | El transporte | 19 de 19 |
| 3 | Contrato, render y prompt | 31 de 31 |
| 4 | El lazo, las barreras, los cupos y la pausa por botón | 46 de 46 |
| 5 | Los eventos del worker | 19 de 19 |
| 6 | Avisos y poller | 13 de 13 |
| 7 | Acceso y consola | 62 de 62 |
| 9 | La retención de la herramienta | 4 de 4 |

Las previstas de la sección «Mutaciones previstas» están repartidas en esas tandas. La app no tiene
tests (`sin tests de UI por ahora`): su criterio es el lint y la build dentro de presupuesto.

**Verificación completa** (desde Git Bash, con `pnpm build:packages` antes):
- tests paquete a paquete, todos en verde;
- `pnpm lint`, con los 3 avisos de siempre de la API;
- `pnpm check:env`;
- builds de la API, del worker y de la app, esta sin avisos de presupuesto;
- `tsc` de la API y del worker;
- fines de línea de los 101 ficheros de la rama, sin ninguno mixto.

| Paquete | Tests al cerrar el 058 | Tests al cerrar el 059 |
|---|---|---|
| shared | 133 | 201 |
| strategy-core | 742 | 758 |
| exchange-core | 481 | 481 |
| worker | 519 | 564 |
| backtest | 64 | 64 |
| API | 5815 | 5988 |

**Criterios de aceptación:**

| CA | Estado |
|---|---|
| CA-1 | Hecho: el esquema sin tipos ni restricciones numéricas, objetos cerrados y enums iguales al vocabulario; el parser no repara nada |
| CA-2 | Hecho: el test de privacidad del render |
| CA-3 | Hecho: cada barrera con su test, el cupo antes de llamar, sin Redis no se llama y dos réplicas hacen una llamada |
| CA-4 | Hecho: el e2e en modo `IA` sobre el simulador (solicitud → decisión escrita como la API → la mitad por confianza media → stop y objetivos → salida por el stop; una respuesta fallida no abre nada ni se vuelve a pedir en la vela). Las decisiones tardías, de otra huella o fuera de la oferta las rechazan la estrategia y la API, con sus tests |
| CA-5 | Hecho: formato, botón de pausa y sin `CYCLE_CLOSED` duplicado |
| CA-6 | Hecho: rutas montadas en su orden, guardas de clase, 403 y la superficie del e2e |
| CA-7 | Hecho: `ng lint` y `ng build` sin avisos |
| CA-8 | Hecho: 224 de 224 |
| CA-9 | Hecho: la verificación de arriba |
| CA-10 | **Pendiente del usuario:** una llamada de pago aprobada para comprobar la caché, el uso y el razonamiento |
| CA-11 | **Pendiente del usuario:** la simulación de 48-72 h y la primera sesión real |

**Lo que no se ha comprobado aquí:** la app en un navegador (solo lint y build) y cualquier llamada
real al modelo.

**Sin merge, sin push y sin desplegar.**
- La rama sale de la del 058, que sale de la del 057; el 057 espera la aprobación del usuario.
- Orden de despliegue: migración (058) → worker → API → app. Con `AI_CHANNEL_ENABLE=false` la API
  cierra cada solicitud con su motivo y ningún bot del canal en modo IA abre nada.
- El 060 (revisión) va después de la simulación, con al menos 100 decisiones.
