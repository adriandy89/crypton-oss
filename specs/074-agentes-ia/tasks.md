# 074 — Tareas

Una casilla por tarea, agrupadas por commit. Se marcan al terminar, con una nota corta si hubo
sorpresas.

## C0 — Spec
- [x] spec, plan, tareas y fila del índice

## C1 — La gestión del canal se mueve
- [x] `operacion/gestion.ts` con las piezas movidas tal cual; `ai-channel.ts` las reexporta
- [x] `opcionDeStop` con el tipo ensanchado
- [x] Tests del canal sin cambios, en verde (strategy-core 832, backtest 74, worker 621)

## C2 — Vocabulario
- [x] `shared/ia-agentes.ts` y `shared/ia-agentes-vistas.ts` con sus tests (41). Tres notas:
  - la aritmética de la tarjeta (acierto con Wilson, R medio y t) va a
    `strategy-core/agentes/medicion.ts`, junto a `wilsonInferior`: en shared habría sido una
    segunda copia. Aquí quedan `rAhora` y `resultadoEnR`;
  - `eleccionEfectiva` pasa a ser genérica —solo cambia el tipo— y la usan el canal y los
    agentes;
  - la autonomía no necesita lector: van tres columnas `AiMode` en la tabla (C6).

## C3 — El motor del agente
- [x] límites, familias, tasas, herramienta, juez, propuesta, seguimiento y medición, con tests
  (92 nuevos; strategy-core 924, worker 621, backtest 74, app y API compilan). Notas:
  - del canal se reutiliza sin copiar: `opcionDeStop` recibe ahora `EntradaDimensionado` (solo
    el tipo), el stop «a N ATR del extremo» sale a `stopDesdeExtremo`, el resumen de tasas a
    `tasasDeResultados`, y `indicadoresHora`/`medidasEn` se exportan. Los 170 tests del canal
    pasan sin tocarlos;
  - el tope diario cuenta lo abierto como si ya hubiera saltado su stop (`riesgoAbierto`), y lo
    pendiente de aprobar ocupa sitio como lo vivo;
  - al aprobar, la holgura de la IOC se mide con el stop elegido: es el único que queda;
  - `configDeOperacion` (plan → configuración del bot) va en C4, con los campos de la estrategia;
  - `shared` gana `tp1`/`tp2`/`nivelIdea` en el plan, `nivel` en el candidato, y los tipos del
    estado de una operación y de la tarjeta.

## C4 — `AGENT_TRADE`
- [x] enum, migración, estrategia, registro, flags, app, `REANCHOR_NO_APLICA`, HTTP y backtests
- [x] tests de la estrategia (CA-3) y migración en base temporal (las 29 migraciones, en orden,
  sobre `crypton_prueba_074`; el enumerado acaba en `AGENT_TRADE`). Notas:
  - «una sola vez» es «solo se entra en el ciclo 1»: el motor abre el primer ciclo con el 1 y
    cada cierre suma uno, se viera o no su ejecución;
  - `DesiredState.detener` es nuevo: la estrategia lo pide y el motor lo cumple en C5;
  - el primer objetivo se deduce del tamaño, como en el canal, pero medido contra el tope de
    posición más bajo aplicado: si no, una reducción del seguimiento parecía un objetivo cobrado;
  - el stop que sigue al precio sale a mercado si entre dos ticks el precio subió y retrocedió
    más que su distancia; el test lo cazó, junto a un `DecimalError` con el «mejor precio» vacío;
  - `configDeOperacion` y `soloReduceRiesgo` viven en la estrategia;
  - `ESTRATEGIAS_SOLO_DE_AGENTE`: el asistente no la ofrece, copiarla no la crea, la API responde
    400 al crearla por HTTP y el backtest la rechaza (en la API y en el motor de replay).

## C5 — El runner
- [x] cambio acotado y sus tests; canal sin cambios (worker 645: los 621 de antes sin tocar y 24
  nuevos). Notas:
  - un spec del canal fija que el runner no da su contexto a ninguna otra estrategia con
    apalancamiento por operación, así que lo nuevo se decide por la estrategia
    (`esEstrategiaDeAgente`) y no por el flag; R-8 dice ahora eso;
  - `detener` cancela TODO lo propio, también el stop: sobre una posición ajena podría cerrarla;
  - el aviso de salida `AGENT_EXIT` lleva el R sobre `riskAmount` y por qué terminó; el motor anota
    si un cierre suyo lo pidió su dueño o una red de seguridad;
  - las reducciones se movieron al tramo `TAKE_PROFIT#100…129`: el motor reserva del 512 al 999
    para sus cierres, y con el 520 el aviso de salida habría contado mal el motivo;
  - la estrategia avisa de la entrada llena (`AGENT_ENTRY`) una vez, con la posición real.

## C6 — Tablas
- [x] modelos, migración, retención; migración en base temporal. Las 30 migraciones en orden sobre
  `crypton_prueba_074`, con filas que ejercen los cuatro únicos parciales, el único del bot y los
  borrados (el bot borrado deja la propuesta; el agente borrado se lleva lo suyo). Borrada al
  terminar. Notas:
  - el SQL sale de `prisma migrate diff --from-schema … --to-schema …`, sin base; los índices
    parciales van a mano, con el porqué en el esquema;
  - `prisma format` realineaba bloques ajenos: el esquema lleva solo inserciones;
  - la retención vacía lo que vio cada ronda con `RETENTION_AI_DOSSIER_DAYS`; los candidatos,
    que miden al agente, no se tocan.

## C7 — Cliente del modelo y variables
- [x] `decidirAgente` y `AI_DESK_*` en los tres sitios (8 tests nuevos; los del cliente y del
  canal, 5261, pasan sin tocarlos). Notas:
  - el cuerpo de `decidirCanal` sale a un `decidir(carga, petición)` privado: las dos cargas
    cambian en la clave, el modelo, el esfuerzo, la caché y el título, y dos copias del cuerpo
    acabarían distintas en lo que no se mira;
  - `PeticionDecision`/`RespuestaDecision` son los nombres neutros; los del canal quedan de alias;
  - `agentesDisponible` y `agentesModelo`, y un aviso en el código: `agentKey`/`agentModel` y
    `AI_AGENT_*` son del Modo IA, que se llamó «agente» antes;
  - `AI_DESK_ENABLE` es el interruptor del módulo entero, no solo de las llamadas: apagado no
    hay rondas, ni aprobaciones, ni seguimiento, y los agentes de REGLAS tampoco corren;
  - el cupo por agente del servidor es 200 y el de fábrica del agente 120: manda el menor, así
    que el del agente es el que se nota; el global, 600, protege la factura;
  - las variables que aún no se leen (cupos, TTL, frenos…) las leen los C9-C13; `check:env` las
    lista como declaradas.

## C8 — Telegram
- [x] preferencia, eventos sin bot, botones `ag`, quitar teclado, resumen diario (41 tests nuevos:
  shared 247, worker 681, y 3 de la API). Notas:
  - la preferencia `agentes` va encendida de fábrica en la API, el worker y la app (fila solo
    para administradores). La vida de la operación va con ella y no con `cycles`: en estos bots
    `AGENT_EXIT` sustituye a `CYCLE_CLOSED`. Lo que pone en juego una posición o pausa al agente
    va con `risk`; el agente dormido y el stop que no se ensancha, con `errors`;
  - los eventos del agente no tienen bot: llevan `DatosEventoAgente` (lector en shared), se
    etiquetan «Agente «nombre»» —«· simulado» en la cuenta de simulación— y el cerrojo de entrega
    va por propuesta o acción: dos propuestas de una ronda en el mismo milisegundo se pisaban;
  - botones: una propuesta se ejecuta o se descarta; una acción se aplica, se descarta o se
    cierra la operación; si lo propuesto es cerrar, se cierra o se mantiene. Lo aplicado solo va
    al lote, sin botones;
  - todo lo que sale a un chat va por la misma fila, con la pausa de 1,1 s medida desde el último
    mensaje: antes los mensajes con botones salían por su cuenta;
  - el poller reenvía `AGENT_DECISION_TAKEN` con el vale, el verbo y el chat, contesta y quita los
    botones, también si el vale ya no existe. Nadie lo canjea hasta el C11;
  - el resumen diario gana la sección de agentes, real y simulado aparte, solo con la
    preferencia, y si falla el resumen sale sin ella. `PROPUESTAS_EJECUTADAS` va a shared: es el
    «operadas» del resumen y será el «tomadas» de la tarjeta;
  - `motivoSinCanal` no se toca: a diferencia del Modo IA, una propuesta también se aprueba desde
    la app, así que Telegram no es obligatorio. Si el editor avisa de que falta, lo decide el C9.
- [x] Cita literal de `editMessageReplyMarkup` anotada en el spec: la página del método sigue sin
  poder leerse entera; se citan la de «Bot Features» y la referencia de TDLib, y queda como
  comprobación de la CA-12

## C9-C13 — La API
- [x] agentes y rutas (C9; 73 tests nuevos, API 6062 y el arranque del grafo en verde). Notas:
  - módulo `ai-desk` con `AiDeskConfig` (las `AI_DESK_*`, recortadas a su rango), el interruptor
    global con su motivo, y el servicio de agentes; las rutas en la consola
    (`admin/admin-ai-desk.controller.ts`, `admin/ai-desk/…`), en `admin-guards.spec.ts`;
  - uno ajeno responde 404, como si no existiera; el rol se relee de la base al crear, editar y
    reanudar;
  - consentimiento en cuenta real al crear, al reanudar y al pasar «entrar» a automático. «Real»
    es ni simulación ni testnet;
  - los límites llegan enteros o no llegan: nada se completa con los de fábrica en silencio, y
    todos los errores salen a la vez con su campo;
  - editar va con la versión (409 si cambió) y descarta lo pendiente; pausar y archivar también.
    Archivar, solo sin operaciones vivas;
  - el *kill switch* del usuario pausa sus agentes (`KILL_SWITCH`) y descarta lo pendiente, en
    `RiskService.killSwitch`;
  - el historial del agente (`historial.ts`) cuenta lo vivo al stop, deja que lo pendiente ocupe
    su par y su sitio, y marca ocupados los pares con un bot real vivo en la cuenta;
  - la próxima ronda es el cierre de la vela en curso más 15 s (`proximaRondaAgente`, en shared);
  - el comentario de `AiDeskConfig` decía `config.get('NOMBRE')` y `check:env` lo tomó por una
    variable: se reescribió.
- [x] rondas (77 tests nuevos; API 6195). Notas:
  - `rondas.service.ts`: una ronda de intervalo por agente y vela (P2002 → otra réplica ya la
    hizo); las barreras en el orden de R-12, cada una SALTADA con su motivo y sin leer el
    mercado ni llamar; en modo IA sin clave se salta antes de llamar —contarlo como fallo
    dormiría al agente por algo que no es suyo—; la pérdida del día pausa una vez por día UTC;
  - los pares ocupados no se leen y quedan en el snapshot con su motivo; los libres se leen uno
    detrás de otro, por el cupo por IP del venue;
  - el cupo, ANTES de llamar: gasto del día, el menor entre el del agente y el del servidor, y el
    global; sin Redis no se llama. La huella evita pagar dos veces la misma oferta;
  - contrato (`contrato.ts`) solo de enumeraciones, letras de la oferta más NINGUNA; con
    confianza BAJA no se opera. Render en relativo, con los pares como «par 1», «par 2» (test de
    privacidad). Prompt fijado por huella (`agentes-v1-7f7ad5a98f4a455d`);
  - la propuesta según «entrar»: PROPONE con vale y aviso con precios para la persona; APLICA por
    la misma aprobación, con origen AUTO; MIDE en SOMBRA con su motivo. `dry_run` es «no es
    dinero real»: simulación o testnet;
  - todos los candidatos se guardan, se ofrecieran o no, con su letra, si los eligió quien
    decidía y si los habría elegido el juez;
  - el barrido (cada 30 s, sin cerrojo: el reclamo es condicional) declara los pares de los
    activos en el flujo de precios y lanza las rondas debidas; «Analizar ahora», una por minuto;
  - el detalle del agente trae sus últimas diez rondas, con las letras de la oferta sacadas otra
    vez del snapshot (`ofertaAgente` es pura);
  - un sabotaje de comprobación cazó un hueco en la aprobación: nada probaba que la propuesta
    dejara APROBANDO mientras se creaba el bot. Test añadido.
- [x] aprobación y ejecución (antes que las rondas: es por donde sale el dinero, y solo necesita
  una propuesta escrita; 56 tests nuevos, API 6119). Notas:
  - una sola rutina (`aprobacion.service.ts`) para la app, Telegram y el automático: reclamo
    condicional `PROPUESTA → APROBANDO`; el índice de una viva por par salta ahí (P2002 →
    `PAR_OCUPADO`); se relee dueño, agente, interruptor —cerrado con Redis caído—, cuenta,
    frenos y bot real vivo en el par; recálculo; `BotsService.create` con el DTO validado;
    enlace del bot ANTES del `START`; si el arranque falla, el borrador se borra;
  - toda salida deja un estado; lo inesperado, FALLIDA. Sin precio o saldo, si lo pidió una
    persona la propuesta vuelve a esperar; si fue el automático, caduca;
  - se avisa por Telegram de lo que no se abrió cuando se pulsó allí; del automático, solo las
    averías;
  - `recuperar` recoge las aprobaciones colgadas y borra los borradores de agente sin propuesta;
    la conciliación (`conciliacion.ts`) lleva la propuesta tras su bot, por reloj y por los avisos
    del worker; un bot en ERROR no cambia nada;
  - la lectura del mercado (`lectura.service.ts`) usa el ticker que deja el worker en Redis: los
    agentes declaran sus pares en el flujo de precios (`fijarInteresServidor`); si no está, el
    venue, cacheado 5 s. Los tramos, una hora; si el venue los publica y fallan, ese par no ofrece;
  - el primer test cazó el DTO: la cuenta tiene que ser un UUID, como en producción.
- [x] seguimiento (51 tests nuevos; API 6236, strategy-core 981, worker 681, backtest 75, shared
  250, app compila). Notas:
  - `Strategy.soloReduceRiesgo` (nuevo, opcional): `AGENT_TRADE` lo declara y `updateConfig` aplica
    lo que solo reduce el riesgo sin la validación ni los topes, como lo que solo apaga (062,
    F-52). Hace falta de verdad: «asegurar 1 R» deja el stop de un largo por encima de la entrada,
    y la validación de creación lo rechaza —comprobado—;
  - `juezSeguimiento` en strategy-core: solo actúa con la idea rota, debilitada con beneficio en
    juego, o con el tiempo casi agotado a favor; nunca elige lo que no se le ofrece;
  - `seguimiento.service.ts`: rondas por operación (una por vela y disparador), sin mirar el
    interruptor de entradas ni la pausa del agente; un bot que no está RUNNING —pausado por una
    persona, parado o en error— no se toca; con una acción pendiente, no se pregunta otra;
  - se aplica por `updateConfig` con la versión leída y firmante `ai-desk:<agente>`, y antes se
    comprueba `soloReduceRiesgo` contra la configuración de AHORA: si ya hay un stop más ceñido,
    DESCARTADA; si el bot cambió, FALLIDA por versión;
  - cerrar a petición del dueño va por `STOP_AND_CLOSE`, el comando de siempre: la salida queda
    como suya, no del seguimiento;
  - el consumo del modelo (cupo antes de llamar, racha de fallos) sale a `consumo.service.ts`,
    que comparten la ronda de entrada y la de seguimiento;
  - el reloj lanza el seguimiento al cerrar cada vela y al cobrar el primer objetivo
    (`disparadorSeguimiento`, puro); la conciliación descarta lo pendiente al cerrarse la
    operación; prompt del seguimiento fijado (`seguimiento-v1-b4e09a88fa1a8d44`);
  - tres sabotajes de comprobación, cazados los tres.
- [x] medición, tarjeta y lo que lee la app (59 tests nuevos en la API, 6295; 11 en strategy-core).
  Notas:
  - `medicion.service.ts`: cada candidato y cada propuesta, se tomara o no, recibe su resultado
    hipotético por triple barrera pesimista; lo que no se medirá nunca —sin plan, su vela ya
    fuera de la serie o saltada, un plan que no se puede etiquetar, o pasado su horizonte más un
    día sin velas— se cierra sin resultado, para que no tape la cola;
  - cada uno se mide con lo que se decidió con él: la ronda guarda con el candidato su intervalo
    y su duración máxima, y la propuesta los lleva en su plan. Un agente editado después no
    cambia lo ya medido;
  - las velas, una vez por serie y vuelta, y solo si ha podido cerrar una vela desde la última
    lectura; la vela en formación no cuenta. El reloj mide a los :07, :22, :37 y :52, lejos del
    cierre de las velas, cuando corren las rondas con el mismo cupo por IP;
  - la escritura es condicional (`measured_at` nulo) y la cola se recorre por lotes con cursor;
  - `listados.service.ts` y `listados.ts`: propuestas (pendientes por lo que les queda),
    operaciones (vivas con el R de ahora sobre el riesgo inicial, el stop que lleva el motor y
    la última revisión; terminadas con su R real), el detalle con lo que vio y su seguimiento,
    la operación de un bot para su panel, y los resultados: una tarjeta por agente y las de
    todos juntos, lo real y lo simulado cada uno por su lado, con lo que costó el modelo;
  - R-25 con dos tests que leen el fuente sin comentarios: nada de lo que decide —en la API y en
    el motor— lee lo medido. Los que lo leen viven aparte (`listados*`), para que decidir no
    tenga ni que importarlos;
  - nueve sabotajes de comprobación, cazados los nueve.

## C14-C16 — La app
Hecho en dos commits que compilan cada uno (lint, `ng build` sin avisos, `check:labels`; API
6295, strategy-core 992, worker 681, backtest 75, shared 250). La app no tiene tests: lo que decide
algo sale ya hecho del servidor o de shared.
- [x] sección y pestañas. Notas:
  - `AgentesIaService` (raíz): el resumen —interruptores, agentes, pendientes— con el patrón de
    `CanalIaService`; los eventos `AGENT_*` del flujo, la sesión y la vuelta tras una caída lo
    refrescan y avisan a las pantallas abiertas (`cambios`);
  - la pestaña: interruptor global con motivo y los avisos del servidor (apagado, sin modelo,
    frenos), y un segmento con una vista por componente —agentes, propuestas (n), operaciones (n),
    resultados—; `?vista=` lleva directo a una; 403 → `<app-admin-forbidden/>`;
  - insignia con las propuestas pendientes en la pestaña IA de la barra.
- [x] editor y detalle. Notas:
  - editor a pantalla completa (`/ia/agentes/nuevo`, `/ia/agentes/:id/editar`): cada sección
    dice cuándo vale; los límites se validan aquí con `validarLimitesAgente` —la misma función
    que el servidor— y con sus nombres de strategy-core (`NOMBRES_LIMITES_AGENTE`, exportado para
    esto); los errores del servidor (`errores[]`) se pintan en su campo; en cuenta real, crear o
    pasar «entrar» a automático pide la casilla de consentimiento; el 409 de versión se explica;
  - `ui-pair-sheet` con modo de varios pares (tope `maxPares`) y «Listo»;
  - detalle (`/ia/agentes/:id`): pastilla, qué hace, el día frente a sus topes con el peor día,
    lo vivo y lo que espera, los últimos análisis —solo los de ENTRADA: la API filtra ahora por
    tipo, porque los de seguimiento, uno por vela y operación, los tapaban— y los límites.
    Pausar, reanudar (en real, primero el consentimiento y luego el motivo: un diálogo de Ionic no
    mezcla casillas con texto), analizar ahora y archivar.
- [x] propuestas, operaciones, resultados, panel, Bots y Telegram. Notas:
  - las formas de las respuestas de aprobar y aplicar pasan a shared (`ResultadoDecisionAgente`,
    `ResultadoAccionAgente`), con alias en la API; y la del cuerpo al crear o editar
    (`DefinicionAgenteEntrada`);
  - detalle de propuesta (`/ia/propuestas/:id`): el plan con lo que cambió al recalcular, el
    porqué, la operación, el seguimiento (acciones con sus botones y revisiones), qué habría
    pasado y lo que vio; ejecutar en real pide confirmación; revisar y cerrar a mercado;
  - los diálogos viven una sola vez en `shared/ia/agentes-acciones.service.ts`, que usan la
    pestaña, sus pantallas y el panel del bot;
  - resultados: tarjeta de lo real y de lo simulado —nunca sumadas— y una por agente, con
    «¿Discrimina la IA?», «Tus descartes», lo que se pierde al ejecutar y el coste del modelo;
  - detalle de un bot `AGENT_TRADE`: `app-operacion-ia-panel` (solo administradores), y sin
    «Arrancar» ni ranking —ni atajo al backtest—;
  - pestaña Bots: las operaciones de agentes TERMINADAS no se listan, con un enlace a IA; las vivas
    sí, que tienen dinero dentro;
  - Telegram ya estaba (C8): la preferencia «Agentes de IA» solo para administradores;
  - los estilos compartidos de la sección van en `global.scss` (`.ia-*`), por el presupuesto de
    estilos por componente.

## C17 — Guías
- [x] `docs/agentes-ia.md`, `docs/agent-trade.md`, transversales, `README.md`, `CLAUDE.md`. Notas:
  - `agentes-ia.md`: el reparto, el editor con sus límites y su autonomía, las doce barreras de
    cada análisis tal como las enseña «Últimos análisis», la aprobación con recálculo, el
    seguimiento, lo que nunca hace, la tarjeta, Telegram, las variables `AI_DESK_*`, cómo empezar
    y las limitaciones que el spec deja escritas;
  - `agent-trade.md`, con la espina de las demás: documenta exactamente los 25 campos de
    `meta.fields` (comprobado contra el paquete compilado) y los enlaces relativos existen;
  - al día: `administracion.md` (la pestaña IA ya no está vacía), `comandos-guardas-y-eventos.md`
    (los `AGENT_*` con su severidad del código), `riesgo-y-liquidacion.md` (la regla por stop, las
    guardas heredadas y el peor caso), `buenas-practicas.md`, `docs/README.md` y el `README.md`;
  - `CLAUDE.md`: el mapa (`modules/ai-desk`, `agentes/` y `operacion/gestion.ts`, OpenRouter también
    para los agentes) y el invariante 13 (propuesta → recálculo → `BotsService.create`; el
    seguimiento solo reduce; nada que decide lee lo medido);
  - al escribirlas salieron dos frases que el código desmentía y se corrigieron antes del commit:
    el *kill switch* es del usuario —pausa todos sus agentes, no los de una cuenta— y el resultado
    de aprobar solo se avisa cuando NO se abrió.

## C18-C19 — Revisión y cierre
- [x] spec 075 de revisión: 43 hallazgos. La Crítica, F-01 (una entrada que se ve tarde dejaba la
  posición sin stop), corregida dentro en `a0116c9`; lo Alto y lo Medio van al 076 y lo Bajo al 077,
  con las 20 decisiones del usuario del 2026-09-25
- [x] verificación completa sobre `a0116c9`: 8812 tests en verde (shared 250, strategy-core 994,
  exchange-core 517, worker 681, backtest 75, API 6295); `pnpm lint` sin errores (los 3 avisos son
  de ficheros que la rama no toca); `check:env` y `check:labels` coherentes; `tsc` de la app y las
  builds de la API, el worker y la app; el `git grep` del CA-1 del 072 solo encuentra
  `typesafe-path`, una dependencia de Volar en `pnpm-lock.yaml` que no tiene que ver. Índice y
  memorias al día
- [ ] CA-12 a CA-14 del usuario
- [x] mezcla a `main` a petición del usuario (2026-09-25), antes del 076: `AI_DESK_ENABLE` sigue
  apagado en producción hasta que lo Alto y lo Medio del 075 estén corregidos
