# 075 — Hallazgos

La severidad sigue la escala de `specs/README.md`.

Commit base: `250c7a2` (`spec/074-agentes-ia`) · Diff revisado: `c7fec40..250c7a2` (17 commits,
188 ficheros) · Fecha: 2026-09-24 · Versiones: node 24.12.0, pnpm 10.28.1 · Hosts sondeados:
ninguno.

Seis revisiones independientes en paralelo (OP, MO, WK, AP, AC, UI de `spec.md`), sin editar el
repositorio. Cada hallazgo se volvió a leer en el código antes de anotarlo; los que dos áreas
encontraron por separado se funden en una ficha. Las sondas de los revisores llaman a `plan()`,
`validate()` y `configDeOperacion()` desde `dist`, sin red; ellas y los tests de confirmación que no
están en el repositorio viven en el scratchpad de la sesión.

## Línea base

Antes de tocar nada, en `spec/075-revision-074`:

| Comprobación | Resultado |
|---|---|
| `pnpm build:packages` | verde |
| `pnpm test` | verde: shared 250, strategy-core 992, exchange-core 517, worker 681, backtest 75, API 6295 (88 suites) |
| `pnpm lint` | verde; dos avisos en `apps/api/src/modules/advisor/venue-matrix.spec.ts:189`, del spec 058 y fuera de este diff |
| `pnpm check:env` | verde |
| `pnpm check:labels` | verde |
| App: `ng lint` y `ng build` | verdes, sin avisos (al cerrar el C16 del 074); `tsc -p tsconfig.app.json` limpio (UI) |

## Referencias oficiales

Ninguna: ningún hallazgo depende de una regla de venue o SDK.

## Resumen

1 Crítica, 5 Altas, 18 Medias y 19 Bajas.

| ID | Título | Área | Severidad | Estado | Evidencia | Arreglo |
|---|---|---|---|---|---|---|
| F-01 | Una entrada propia que tarda más de 30 s en verse deja la posición propia sin stop, o con stop a medias | OP, WK | **Crítica** | corregido en 075 | `agent-trade.ts:518,635,650`; `bot-runner.ts:2691` | M |
| F-02 | Tras `STOP_AND_CLOSE` la API da la operación por cerrada fuera del bot antes de que el worker barra el cierre: la pérdida no llega al día, a la racha ni a la tarjeta | AP, WK | Alta | seguimiento 076 | `bot-runner.ts:3108-3116,3288-3292`; `conciliacion.ts:119-128` | S-M |
| F-03 | El kill switch, la pausa, la edición, el archivo y el corte global no alcanzan una aprobación ya reclamada: arranca un bot después del freno | AC | Alta | seguimiento 076 | `risk.service.ts:283-298`; `aprobacion.service.ts:157,233,356` | M |
| F-04 | Un fallo que no es HTTP tras escribirse `STARTING` deja el bot operando con la propuesta FALLIDA y un aviso de «no se ha abierto nada» | AP | Alta | seguimiento 076 | `aprobacion.service.ts:197-211,355-358,373-375` | S-M |
| F-05 | La pausa por pérdida diaria no salta nunca en operación normal, y no cuenta lo abierto aunque así se documente | MO, AP, UI | Alta | seguimiento 076 | `agentes/herramienta.ts:135`; `canal/herramienta.ts:104,176-194` | S |
| F-06 | En pausa, el vigilante del stop cierra a mercado una posición que no es de la operación | WK | Alta | seguimiento 076 | `bot-runner.ts:2794-2830,2746-2784`; `agent-trade.ts:635` | S |
| F-07 | Una operación en pausa nunca se detiene; una EJECUTANDO con el bot en ERROR o PAUSED se atasca | WK, AP | Media | seguimiento 076 | `bot-runner.ts:1183-1206`; `conciliacion.ts:74-76,135` | S |
| F-08 | Una acción de seguimiento que no termina se queda en APLICANDO para siempre y apaga el seguimiento de su operación | AP, AC | Media | seguimiento 076 | `seguimiento.service.ts:442,569,288-294` | S |
| F-09 | Aplicar una acción aprobada tarde no la revalida: bot pausado, o un stop que el precio ya cruzó que se convierte en un cierre a mercado | AP, OP, MO | Media | seguimiento 076 | `seguimiento.service.ts:525-558`; `agent-trade.ts:703-712,784-786` | S |
| F-10 | Los límites del día se cumplen a medias: al aprobar no se miran la racha ni las operaciones del día, y las pendientes no cuentan como operaciones | AP, MO | Media | seguimiento 076 | `aprobacion.service.ts:261-299`; `agentes/herramienta.ts:136,144-148` | S |
| F-11 | La guarda de spread no se vuelve a mirar al aprobar | MO | Media | seguimiento 076 | `agentes/herramienta.ts:326`; `agentes/propuesta.ts:207-271` | S |
| F-12 | Los topes de nocional del usuario no entran en el dimensionado: las aprobaciones acaban FALLIDA/CREAR | MO | Media | seguimiento 076 | `agentes/limites.ts:257`; `risk.service.ts:103-116` | M |
| F-13 | R-1 a medias: tras invalidarse o cancelarse antes de entrar, un START a mano vuelve a entrar | OP, WK | Media | seguimiento 076 | `agent-trade.ts:484,545`; `bots.service.ts:1292` | S |
| F-14 | Con tope de posición tras el primer objetivo, una reducción deja la posición sin segundo objetivo | OP | Media | seguimiento 076 | `agent-trade.ts:680,892`; `gestion.ts:109` | S |
| F-15 | `AGENT_STOP_IGNORED` falso tras cada breakeven o trailing | OP | Media | seguimiento 076 | `agent-trade.ts:695,714-717` | S |
| F-16 | `configDeOperacion` genera configuraciones que `validate()` rechaza y no reproduce el reparto del plan | OP | Media | seguimiento 076 | `agent-trade.ts:229,285,939`; `canal/herramienta.ts:676` | S |
| F-17 | Con `stopLossPct` puesto, el motor coloca un stop sobre una posición ajena antes de detenerse | OP | Media | seguimiento 076 | `bot-runner.ts:1255`; `stop-loss.ts:52`; `agent-trade.ts:458-468` | S |
| F-18 | `STOP_KEEP_POSITION` deja una posición real viva que Bots esconde e IA da por terminada | UI, AP, AC | Media | seguimiento 076 | `bots-list.page.ts:87-88`; `conciliacion.ts:119-128`; `docs/agent-trade.md` | S |
| F-19 | Una operación aprobada que no llega a entrar termina sin un solo aviso | WK | Media | seguimiento 076 | `agent-trade.ts:524-535`; `notifier.service.ts:152` | S |
| F-20 | «Ejecutar» desde Telegram sin precio o saldo vuelve a esperar en silencio | UI, AP | Media | seguimiento 076 | `aprobacion.service.ts:402-416,564-568` | S |
| F-21 | En la app, «Aplicar» una acción «cerrar» cierra a mercado sin confirmación | UI | Media | seguimiento 076 | `accion-item.component.ts`; `agentes-acciones.service.ts` | S |
| F-22 | La insignia no cuenta las acciones que esperan y no baja al caducar una propuesta | UI | Media | seguimiento 076 | `tabs.page.ts`; `agentes.service.ts:390-397` | M |
| F-23 | «¿Discrimina la IA?» dice «distingue» con cualquier diferencia de medias, y las tarjetas agregadas mezclan IA y reglas | UI | Media | seguimiento 076 | `tarjeta.component.ts`; `listados.service.ts` | M |
| F-24 | Las guías prometen cosas que el código no hace: el «peor día», el seguimiento que «nunca se corta», la pausa que cuenta lo abierto y cuatro frases más | UI, MO, AP | Media | seguimiento 076 | `docs/agentes-ia.md`, `docs/agent-trade.md`, `docs/comandos-guardas-y-eventos.md` | S |
| F-25 | Los «bots vivos» del agente no incluyen STOPPING | AP | Baja | seguimiento 077 | `aprobacion.service.ts:52`; `agentes.service.ts:55` | S |
| F-26 | El motivo de un cierre del motor sale de un campo global que cualquier comando pisa | WK | Baja | seguimiento 077 | `bot-runner.ts:3023,2056` | S |
| F-27 | `positionCap` antes de entrar no se respeta | OP | Baja | seguimiento 077 | `agent-trade.ts:537-621,793` | S |
| F-28 | Con los mismos datos, el recálculo al aprobar cambia el plan y puede subir su riesgo un 2 % | MO | Baja | seguimiento 077 | `agentes/propuesta.ts:231`; `agentes/herramienta.ts:257-263` | S |
| F-29 | `leerLimites` no aplica los rangos que su comentario promete | MO | Baja | seguimiento 077 | `agentes/limites.ts:197-235` | S |
| F-30 | La «brecha de ejecución» mezcla el esquema de objetivos y el recálculo | MO | Baja | seguimiento 077 | `agentes/medicion.ts:62-68`; `medicion.service.ts` | S |
| F-31 | `saldoLibre` da por bueno un saldo rancio o marcado como no disponible | AP, AC | Baja | seguimiento 077 | `lectura.service.ts:94-98`; `bots.service.ts:396-404` | S |
| F-32 | El R real se mide sobre el riesgo del plan aunque la IOC se llene a medias | AP, WK | Baja | seguimiento 077 | `conciliacion.ts:52-60,97`; `bot-runner.ts:2054` | S |
| F-33 | El gasto diario del modelo se puede pisar entre rondas concurrentes | AP | Baja | seguimiento 077 | `consumo.service.ts:86-96` | S |
| F-34 | «Revisar ahora» se ofrece en operaciones EJECUTANDO, que la API rechaza | UI | Baja | seguimiento 077 | `propuesta-detalle.page.ts`; `seguimiento.service.ts:234-236` | S |
| F-35 | El tope de entrada se rotula al revés en los cortos, y los límites se enseñan sin formato | UI | Baja | seguimiento 077 | `propuesta-fila.component.ts`; `plan-resumen.component.ts`; `agente-detalle.page.ts` | S |
| F-36 | El editor puede enseñar los pares de otra cuenta | UI | Baja | seguimiento 077 | `agente-editor.page.ts` (`cargarMercados`) | S |
| F-37 | Si falla el resumen, la vista Agentes gira para siempre | UI | Baja | seguimiento 077 | `agentes-vista.component.ts`; `agentes-ia.service.ts` | S |
| F-38 | Abrir el interruptor global de entradas no relee el rol de la base | AC | Baja | seguimiento 077 | `admin-ai-desk.controller.ts:60-61` | S |
| F-39 | CA-11 a medias: el PUT de un agente no está en el test de 403, y el spec pide 403 donde el código da 404 | AC | Baja | seguimiento 077 | `admin-ai-desk.routes.spec.ts`; `agentes.service.ts:365` | S |
| F-40 | `resultados` carga sin tope todos los candidatos y propuestas del administrador | AC | Baja | seguimiento 077 | `listados.service.ts` (`resultados`) | M |
| F-41 | `AiDeskConfig`: una variable vacía toma el mínimo, y la concurrencia se cuenta dos veces | AC | Baja | seguimiento 077 | `ai-desk.config.ts:19-20`; `rondas.service.ts:160`; `seguimiento.service.ts:167` | S |
| F-42 | El vale de Telegram se gasta antes de comprobar el dueño: una pulsación ajena lo quema | WK | Baja | seguimiento 077 (por confirmar) | `ai-desk.scheduler.ts:106`; `aprobacion.service.ts:452` | S |
| F-43 | `aprobar(AUTO)` no comprueba que «entrar» siga en automático | AC | Baja | seguimiento 077 | `rondas.service.ts` (`proponer`); `aprobacion.service.ts` | S |

Estados: `por confirmar` · `confirmado` · `corregido en NNN` · `seguimiento NNN` · `descartado`.
Arreglo: `S` (menos de 50 líneas) · `M` · `L` (exige spec propio).

## Fichas

### F-01 — Una entrada propia que tarda más de 30 s en verse deja la posición propia sin stop, o con stop a medias

- **Síntoma**: `entradaEnCurso` (`operacion/gestion.ts:74-89`) da por fallida una IOC si en
  `ESPERA_LLENADO_MS` (30 s) no se ven ni la posición ni su ejecución. Entonces `agent-trade.ts:518`
  anula `op` y el siguiente tick reintenta con otra IOC por la cantidad entera (`BASE#1`). Dos
  salidas, las dos sin stop sobre dinero propio:
  - **(a) Duplicada.** Si la primera sí entró, la posición es el doble. `conPosicion` solo protege
    `Decimal.min(abs, c.cantidad)` (`:650`): el stop cubre una entrada y el exceso, apalancado, se
    queda sin stop. El vigilante no lo ve porque sí hay un stop.
  - **(b) Tomada por ajena.** Si ya no se reintenta —el libro se fue, venció el plazo— y la posición
    aparece con `op` nulo, `:635` la declara ajena: `detener('POSICION_AJENA')` sin órdenes. El
    runner cancela lo propio y suelta el bot (`bot-runner.ts:2688-2700`). Queda una posición
    apalancada del propio bot, sin stop y sin nadie que la mire. Pasa aunque la ejecución ya conste
    en el ciclo (`entriesFilled > 0`).
- **Evidencia**: `gestion.ts:28,86`; `agent-trade.ts:518` «patch['op'] = null»; `:635` «if (!op ||
  largo !== c.largo || !c.cantidad) return posicionAjena(seq, qtyPos);»; `:650` «const propia =
  Decimal.min(abs, c.cantidad);»; `bot-runner.ts:2691` «await this.cancelOwnOrders();». El canal,
  en el mismo caso, protege la posición: `ai-channel.ts:914` «return posicionHuerfana(ctx, c, seq,
  qtyPos);», con stop de emergencia.
- **Impacto**: dinero real sin stop, en la estrategia que existe para no dejar nunca una posición
  sin él. Es la clase (2) de la escala: posición sin el stop configurado, o con stop de tamaño
  erróneo.
- **Cuándo pasa (criterio 1)**: con la configuración de fábrica, cuando el venue tarda más de 30 s en
  enseñar la ejecución o la posición mientras las lecturas siguen respondiendo: el secuenciador de
  Lighter atrasado (la orden es una transacción que se ejecuta después), una lectura REST rancia o
  un acuse con estado desconocido. No es lo habitual, pero pasa en incidencias, y el diseño del
  canal ya lo contemplaba. Si el usuario no lo considera «operación normal», por la regla de empate
  queda en Alta con spec de seguimiento.
- **Reproducción / test**: `agent-trade.f01.spec.ts` (en el scratchpad; se añade con el arreglo).
  Dos casos que fallan hoy por el motivo declarado:
  - «(a) no se duplica, y si se duplica, toda la posición propia lleva stop»: sale `segundaIoc: 1`
    y, con la posición en 2, `stopQty: '1.00000'`.
  - «(b) con la entrada dada por fallida, la posición propia que aparece lleva stop»: sale
    `detener: 'POSICION_AJENA'` y `stops: 0`.
- **Propuesta (contrato de arreglo)**: en `agent-trade.ts`, sin tocar el canal ni el runner:
  1. una posición del lado de la operación en el ciclo 1, habiendo salido alguna entrada del bot
     (`intentos > 0`), es de la operación aunque `op` sea nulo: se reconstruye `op` con el stop de
     la configuración y se gestiona con su stop;
  2. el stop cubre toda la posición del lado de la operación, nunca menos: el aviso de «posición
     mayor» se queda, pero el exceso no queda sin red;
  3. los dos casos del test pasan, y los 60 de `agent-trade.spec`, `gestion.spec` y
     `configuracion.spec` siguen en verde, igual que los del canal sin tocarlos.
  Tamaño M: unas 40 líneas más los tests.
- **Decisión**: el usuario aprobó corregirla dentro del 075 (2026-09-25). Corregida en `a0116c9`:
  los dos casos de `agent-trade.f01.spec.ts` pasan, y el test de «posición mayor» de
  `agent-trade.spec.ts` pasa a exigir el stop sobre toda la posición y los objetivos solo sobre la
  de la operación. Queda, a propósito, el reintento tras 30 s: si las dos IOC entran, el stop cubre
  las dos y lo peor al stop es 2R en vez de una posición sin stop.

### F-02 — Tras `STOP_AND_CLOSE` la API da la operación por cerrada fuera del bot antes de que el worker barra el cierre

- **Síntoma**: el worker cierra a mercado, escribe `STOPPED` y publica `BOT_STOPPED`
  (`bot-runner.ts:3108-3116`); el barrido de la ejecución del cierre llega después (`:3288-3292`).
  La API concilia al recibir `BOT_STOPPED` (`ai-desk.scheduler.ts:32-37,84-91`), ve el ciclo 1
  abierto y marca la propuesta CERRADA/FUERA con `r_real: null` y el realizado parcial
  (`conciliacion.ts:119-128`). Es terminal: el `AGENT_EXIT` posterior ya no corrige nada
  (`operaciones.service.ts:9,31`). Las ejecuciones que llegan por WebSocket durante el comando se
  descartan al soltar el runner (`bot-runner.ts:995,1992`).
- **Impacto**: error contable silencioso que alimenta una guarda. La pérdida de ese cierre no entra
  en la pérdida del día ni en la racha del agente (`historial.ts:90-106`), ni en la tarjeta; y la
  salida figura «fuera del bot». Lo disparan «⏹ Cerrar la operación» de Telegram, «Cerrar a
  mercado» de la app (`seguimiento.service.ts:672`), la guarda de liquidación y el kill switch.
- **Reproducción / test**: `operaciones.service.spec.ts`: propuesta ABIERTA, bot STOPPED con el ciclo
  1 abierto → `conciliar`; luego ciclo cerrado en −4,2 y `AGENT_EXIT` MANUAL → `conciliar`. Se
  espera CERRADA/MANUAL con −4,2 y −0,84 R; hoy queda FUERA sin R.
- **Propuesta**: en el worker, barrer las ejecuciones antes de escribir STOPPED y publicar el evento
  cuando es una operación de agente (y del canal); en la API, una gracia desde `stopped_at` antes de
  declarar FUERA sobre un ciclo abierto.

### F-03 — El kill switch y los demás frenos no alcanzan una aprobación ya reclamada

- **Síntoma**: `RiskService.killSwitch` (`risk.service.ts:283-298`) para los bots vivos, pausa los
  agentes ACTIVO y descarta lo que está en PROPUESTA; no toca APROBANDO ni deja marca. La aprobación
  lee el agente, sus límites y el interruptor antes de las lecturas lentas (saldo, hasta 12 s) y no
  los relee antes de `START` (`aprobacion.service.ts:157,233,291,356`). Lo mismo con pausar, editar
  y archivar (`descartarPendientes` solo toca PROPUESTA) y con cortar las entradas globales.
- **Impacto**: con «entrar» en automático sobre cuenta real, una posición nueva segundos después del
  freno de emergencia. Nace con su stop nativo: por eso Alta y no Crítica. Con «archivar», la
  operación queda colgada de un agente ARCHIVADO, sin seguimiento.
- **Reproducción / test**: `scratchpad/f1/kill-switch-carrera.spec.ts`, con `RiskService` y
  `AiDeskAprobacionService` reales y el kill switch disparado dentro de `saldoLibre`: la propuesta
  acaba EJECUTANDO y el bot recibe START después del kill switch. Falla hoy (comprobado).
- **Propuesta**: los frenos pasan también `APROBANDO → DESCARTADA` con escritura condicional (el
  enlace del bot ya borra el borrador si la propuesta salió de APROBANDO); justo antes de START,
  releer en una consulta la propuesta, el agente y el interruptor; si el paso final a EJECUTANDO no
  escribe, `STOP_AND_CLOSE` al bot.

### F-04 — Un fallo que no es HTTP tras `STARTING` deja el bot operando con la propuesta FALLIDA

- **Síntoma**: `START` escribe STARTING (`bots.service.ts:1296-1303`) y crea su evento en otra
  sentencia (`:1372-1379`); si falla la segunda —o la escritura final a EJECUTANDO—, el error no es
  HTTP, sube (`aprobacion.service.ts:355-358`) y el catch externo (`:197-211`) escribe FALLIDA/CREAR
  y avisa «no se ha abierto nada», sin mirar `bot_id`. El worker adopta el bot y entra.
- **Impacto**: una operación real fuera de la conciliación, del seguimiento, de las vivas y del
  riesgo abierto del agente, y un aviso falso. Baja probabilidad (la base cae en esa ventana), efecto
  alto. La recuperación tampoco lo arregla: una FALLIDA no se concilia (`operaciones.service.ts:9`).
- **Reproducción / test**: `aprobacion.service.spec.ts` con `bots.command` rechazando un
  `Error('Connection terminated')`: hoy acaba FALLIDA/CREAR con `bot_id` puesto y el mensaje falso.
- **Propuesta**: con `bot_id` presente, el catch deja la propuesta en APROBANDO para que
  `recuperar` decida por el estado del bot; comprobar el recuento de la escritura final; en
  `recuperar`, borrar solo si el bot sigue en DRAFT.

### F-05 — La pausa por pérdida diaria no salta nunca en operación normal

- **Síntoma**: la barrera mira solo lo realizado (`agentes/herramienta.ts:135`,
  `canal/herramienta.ts:176-182`), y el dimensionado deja que cada operación nueva arriesgue como
  mucho 0,9 × lo que queda del tope contando lo abierto (`canal/herramienta.ts:104,189-194`). Con
  pérdidas iguales a las del plan, lo realizado se acerca al tope sin llegar: la sonda del área MO
  (capital 10 000, riesgo 0,5 %, tope 2 %) pasa por 50 → 100 → 150 → 195 → 199,5 → 199,95 y la
  séptima ya no tiene opción viable, sin pausa. Al día siguiente el agente sigue solo.
- **Impacto**: la red de seguridad del plan aprobado —«pérdida diaria 2 % (pausa el agente) … hasta
  que lo reanudes»— es código muerto salvo que el deslizamiento supere lo modelado. El dinero del día
  sí queda acotado por el dimensionado. Además el tipo, el aviso y las guías dicen que cuenta lo
  abierto al stop, y no lo cuenta (`shared/ia-agentes.ts:107`, `rondas.service.ts:666`,
  `docs/agentes-ia.md`).
- **Reproducción / test**: `herramienta.spec.ts` «pérdidas al riesgo del plan acaban pausando el
  agente»: el bucle de la sonda afirma `PERDIDA_DIARIA` antes de quedarse sin opción viable. Hoy la
  barrera devuelve `null` siempre.
- **Propuesta**: que la regla sea alcanzable y la decida el usuario: pausar con una pérdida ≥ 0,9 ×
  tope —el mismo 0,9 del dimensionado—, contando o no lo abierto; y alinear el tipo, el aviso y las
  guías con lo que se decida.

### F-06 — En pausa, el vigilante del stop cierra a mercado una posición que no es de la operación

- **Síntoma**: en pausa, `protegerEnPausa` (`bot-runner.ts:2794-2830`) pide el plan y coloca sus
  stops; para una posición ajena el plan no trae stop (`agent-trade.ts:635`, `:458-469`), y
  `vigilarStop` (`:2746-2784`) no mira de quién es la posición: a los 5 s (10 en Lighter) la cierra a
  mercado con un CRITICAL `SIN_STOP`. En pausa tampoco se evalúa `detener` (F-07), así que un bot
  cuya operación ya terminó puede seguir en PAUSED indefinidamente.
- **Impacto**: una posición manual del usuario en ese par y cuenta, cerrada a mercado por un bot que
  no es suyo (rompe R-5). Requiere operar a mano un par con un bot de agente en pausa, cosa que las
  guías desaconsejan, pero la pérdida es real.
- **Reproducción / test**: `bot-runner.agente.spec.ts`: `plan: { orders: [], detener:
  'POSICION_AJENA' }`, `startPaused`, posición larga; `start()`, reloj +6 s, `tick()`: hoy aparecen el
  cierre `TAKE_PROFIT#999` y `SIN_STOP`.
- **Propuesta**: en la rama de pausa de una operación de agente, si el plan trae `detener`, no armar
  el vigilante y tratar el `detener` (F-07).

### F-07 — Una operación en pausa nunca se detiene

- **Síntoma**: la rama de pausa (`bot-runner.ts:1183-1206`) solo protege y vuelve: no procesa
  `detener`. Una operación pausada antes de entrar se queda EJECUTANDO para siempre, ocupando una de
  sus operaciones vivas, su riesgo abierto y el par; una pausada con posición que luego salta el stop
  queda CERRADA en la API pero con el bot en PAUSED ocupando el par (invariante 11). Lo mismo con el
  bot en ERROR antes de entrar (`conciliacion.ts:74-76,135`).
- **Propuesta**: en la rama de pausa de una operación de agente, planificar y, si el plan trae
  `detener` con la posición plana o ajena, detener; en la conciliación, SIN_ENTRADA para una
  EJECUTANDO con el bot en ERROR o PAUSED y el plazo de entrada vencido.

### F-08 — Una acción de seguimiento que no termina se queda en APLICANDO para siempre

- **Síntoma**: la acción automática nace APLICANDO (`seguimiento.service.ts:442`) y un error que no
  es HTTP en `updateConfig`, un `bus.publish` fallido tras confirmar o un reinicio a mitad la dejan
  así (`:569`). Nadie la recoge (`caducar` y la conciliación solo miran PROPUESTA), y el índice
  `uq_ai_desk_action_pendiente` más la barrera `PENDIENTE` (`:288-294`) apagan todas las rondas de
  esa operación, también «Revisar ahora».
- **Impacto**: se pierde lo que reduce riesgo (asegurar, reducir, cerrar con la idea rota) hasta que
  la operación cierre. El stop nativo y los objetivos siguen.
- **Reproducción / test**: `scratchpad/f1/seguimiento-colgada.spec.ts` (el spec del repo más un
  caso con `updateConfig` rechazando `Error('ECONNRESET')`): la acción sigue APLICANDO. Falla hoy
  (comprobado).
- **Propuesta**: cualquier error no HTTP deja la acción FALLIDA antes de relanzarlo; `mantener` pasa
  a FALLIDA las APLICANDO de hace más de 2 min.

### F-09 — Aplicar una acción aprobada tarde no la revalida

- **Síntoma**: `aplicar` compara solo con la configuración (`seguimiento.service.ts:546-558`); lee
  el estado del bot y no lo usa (`:525,537`). Un «proteger» o «asegurar» aprobado cuando el precio ya
  cruzó ese nivel lo convierte la estrategia en un cierre a mercado (`agent-trade.ts:703-712,784-786`),
  contado como «stop». La acción vive 30 min de fábrica. Y un bot pausado por una persona entre la
  ronda y la aplicación se toca igual (R-23).
- **Propuesta**: exigir RUNNING y volver a comprobar el stop nuevo con un ticker fresco (la holgura
  de `opcionesSeguimiento`), o descartar si la acción ya no se ofrecería.

### F-10 — Los límites del día se cumplen a medias

- **Síntoma**: `recalcularPropuesta` no llama a `barreraDelDia`, y la aprobación tampoco
  (`aprobacion.service.ts:261-299`): con «entrar» a mano, una tercera pérdida seguida no impide
  aprobar la pendiente, y con varias pendientes se supera `maxOperacionesDia` porque las pendientes
  no cuentan como operaciones del día (`agentes/herramienta.ts:136`).
- **Propuesta**: `operacionesHoy + pendientes` en la barrera; al aprobar, `barreraDelDia` con el
  historial fresco (sin la capacidad, que ya excluye la propia) y DESCARTADA/LIMITES si corta.

### F-11 — La guarda de spread no se vuelve a mirar al aprobar

- **Síntoma**: solo la ronda la aplica (`agentes/herramienta.ts:326`); ni `recalcularPropuesta` ni la
  estrategia (el canal sí, en su tick de entrada). La sonda: un libro cinco veces más ancho que la
  guarda descarta el par en la ronda pero no al aprobar. La salida por stop de un libro así puede
  costar bastante más de 1R.
- **Propuesta**: llevar el ATR a `DatosFrescos` y caducar con el spread por encima de
  `MAX_SPREAD_ATR_AGENTE` × ATR.

### F-12 — Los topes de nocional del usuario no entran en el dimensionado

- **Síntoma**: `topeNocional: null` (`agentes/limites.ts:257`); la ronda solo mira `max_open_bots`.
  Con `max_notional_per_bot` menor que el nocional del plan, cada aprobación acaba FALLIDA/CREAR
  en `create`, después de pagar la consulta.
- **Propuesta**: llevar el tope por bot y lo que quede del total a `topeNocional`.

### F-13 — R-1 a medias: un START a mano tras invalidarse vuelve a entrar

- **Síntoma**: la invalidación antes de entrar no deja marca (`agent-trade.ts:545`, patch vacío) y
  solo mira la marca del tick, no `ctx.extremos`; la única marca de «ya ocurrió» es `seq > 1`
  (`:484`). START solo exige ser administrador (`bots.service.ts:1292`). La app no ofrece «Arrancar»,
  pero la API sí lo acepta: dentro del plazo de entrada vuelve a salir `BASE#0`, y la posición queda
  fuera del agente.
- **Propuesta**: todo `detener` escribe `terminada` en el scratch y `plan()` lo mira primero; la
  invalidación usa `ctx.extremos`; la API responde 409 al START de una operación que ya arrancó.

### F-14 — Con tope tras el primer objetivo, una reducción deja la posición sin segundo objetivo

- **Síntoma**: los tramos se miden contra el tope (`agent-trade.ts:680`) y, con `tp1Hecho`, se
  descarta el primero (`:892`); si el reparto del tope no llega al mínimo sale un solo tramo
  (`gestion.ts:109`) y `slice(1)` lo deja vacío. Sonda: operación de 60 USDC, cobrado TP1, «reducir a
  la mitad» automático → sin orden en TP2, solo el stop. Y si el tope llega en el mismo tick que el
  llenado de TP1, `tp1Hecho` sale falso: sin breakeven.
- **Propuesta**: con `tp1Hecho`, el pendiente es siempre el último objetivo con toda la base; marcar
  `tp1Hecho` por la ejecución de `TAKE_PROFIT#0`, no por tamaño.

### F-15 — `AGENT_STOP_IGNORED` falso tras cada breakeven o trailing

- **Síntoma**: tras el breakeven el stop interno pasa a la entrada y la configuración sigue con el
  inicial; el tick siguiente compara (`agent-trade.ts:695,714-717`) y avisa por Telegram en WARN
  «la configuración pide el stop más lejos: se ignora». Una vez por operación que llega a TP1.
  Acostumbra a ignorar la alarma que protege R-2.
- **Propuesta**: guardar el último `stopPrice` visto de la configuración y avisar solo si cambia a
  uno más lejano.

### F-16 — `configDeOperacion` genera configuraciones que `validate()` rechaza

- **Síntoma**: con `fraccionTp1Pct = 10` la fracción sale 9,8x % tras el redondeo y `validate` la
  rechaza (`min: 10`, `agent-trade.ts:229,939`); con 4 h y más de 180 velas `maxHoldMinutes` pasa de
  43 200 (`:285`); y cuando el redondeo a 6 decimales baja, TP1 sale un paso por debajo del plan y
  dos objetivos pueden quedarse en uno. La propiedad de la CA-4 no lo detecta (usa 1 h, 24 velas).
- **Propuesta**: fracción redondeada hacia arriba o la cantidad del primer objetivo tal cual; en la
  validación de límites, `maxVelasOperacion × intervalo ≤ 43 200`.

### F-17 — Con `stopLossPct` puesto, el motor coloca un stop sobre una posición ajena

- **Síntoma**: `withStopLoss` añade un stop cuando el plan no trae uno (`stop-loss.ts:52`), también a
  un plan con `detener` (`bot-runner.ts:1255`); `posicionAjena` no trae stop. Si el dueño pone
  `stopLossPct` —documentado como «no se usa»— y hay una posición ajena, el stop se coloca antes de
  cancelar y, si ya está cruzado, cierra esa posición.
- **Propuesta**: no aplicar `withStopLoss` a un plan con `detener`, o que `validate` dé error con
  `stopLossPct` en esta estrategia.

### F-18 — `STOP_KEEP_POSITION` deja una posición real viva que Bots esconde e IA da por terminada

- **Síntoma**: la conciliación marca CERRADA/FUERA una operación parada conservando la posición
  (`conciliacion.ts:119-128`); la pestaña Bots oculta toda `AGENT_TRADE` en STOPPED sin mirar la
  posición (`bots-list.page.ts:87-88`); el detalle ya no ofrece «Arrancar»; y la guía la recomienda
  para «pararla sin cerrar» (`docs/agent-trade.md`). El par queda libre para el agente aunque la
  posición siga en el venue; la siguiente operación en ese par se para por R-5. El comando también lo
  puede dar otro administrador desde la consola.
- **Propuesta**: ocultar en Bots solo con la posición a cero; en la guía y en la hoja de acciones de
  `AGENT_TRADE`, avisar de que `STOP_KEEP_POSITION` da la operación por terminada, o quitarlo y dejar
  `PAUSE`.

### F-19 — Una operación aprobada que no llega a entrar termina sin un solo aviso

- **Síntoma**: SIN_ENTRADA e INVALIDADA avisan en INFO (`agent-trade.ts:524-535`) y el notificador
  exige WARN para `AGENT_ENTRY_DISCARDED` (`notifier.service.ts:152`); `BOT_STOPPED` sale en INFO y la
  API no publica nada al pasar a SIN_ENTRADA. Tras «✅ Ejecutar» → «Ejecutando…», el dueño puede
  creer que tiene una operación abierta.
- **Propuesta**: el fin sin entrada en WARN bajo la preferencia `agentes`, o un
  `AGENT_PROPOSAL_RESULT` al conciliar a SIN_ENTRADA.

### F-20 — «Ejecutar» desde Telegram sin precio o saldo vuelve a esperar en silencio

- **Síntoma**: `sinDatos` devuelve la propuesta a PROPUESTA sin `cerrarConAviso`
  (`aprobacion.service.ts:402-416`), contra su propio contrato (`:564-568`); el vale ya se gastó y el
  poller contestó «Ejecutando…» y quitó los botones.
- **Propuesta**: con origen TELEGRAM, `AGENT_PROPOSAL_RESULT` «sigue pendiente en la app».

### F-21 — En la app, «Aplicar» una acción «cerrar» cierra a mercado sin confirmación

- **Síntoma**: `aplicar` no confirma (`shared/ia/agentes-acciones.service.ts`), aunque el propio
  servicio dice que cerrar siempre se confirma y `cerrar()` sí lo hace. En Telegram ese botón se
  llama «⏹ Cerrar».
- **Propuesta**: confirmar al aplicar una acción `CERRAR` (y avisar si es dinero real); rotular
  «Cerrar» y «Mantener» como en Telegram.

### F-22 — La insignia no cuenta las acciones que esperan y no baja al caducar

- **Síntoma**: `resumen.pendientes` solo cuenta propuestas de entrada (`agentes.service.ts:390-397`);
  una acción «cerrar» esperando no aparece en la barra, y mientras espera el seguimiento de esa
  operación se salta (`PENDIENTE`). Caducar no emite evento, así que la insignia se queda hasta el
  siguiente `AGENT_*`.
- **Propuesta**: sumar las acciones pendientes al resumen y a la insignia; refrescar al vencer el
  primer `caducaEn`.

### F-23 — «¿Discrimina la IA?» dice «distingue» con cualquier diferencia

- **Síntoma**: el veredicto compara medias sin contraste (`tarjeta.component.ts`): 30 elegidas a
  +0,02 R frente a 400 no elegidas a +0,01 R dicen «distingue». Es la tarjeta con la que la guía
  manda decidir antes de dejar «entrar» en automático. Las tarjetas agregadas juntan agentes en modo
  IA y en modo reglas.
- **Propuesta**: veredicto de tres salidas en el servidor con un contraste de dos muestras (Welch,
  añadiendo `sd` a `EstadisticaR`); separar IA y reglas en las agregadas.

### F-24 — Las guías prometen cosas que el código no hace

- «Lo peor que puede perder en un día» (editor, detalle, guía) es capital × pérdida diaria: al stop.
  En un hueco la pérdida puede llegar a capital × margen × operaciones a la vez (500 USDC con 1 000 de
  capital y los valores de fábrica). Y «ya no puede perder» tras el stop a la entrada ignora el
  deslizamiento.
- «Reducir el riesgo nunca se corta» (`docs/agentes-ia.md`): el seguimiento se salta con
  `AI_DESK_ENABLE` apagado, sin clave del modelo o dormido, sin cupo o gasto del día —el cupo es el
  mismo que el de las entradas— y con el bot pausado. El stop nativo no depende de ello.
- La pausa por pérdida diaria «contando al stop lo abierto» (F-05).
- `AGENT_PAUSED` «por el kill switch»: el kill switch pausa sin evento (`risk.service.ts:291-298`).
- «Aplicar» y «Descartar»: la acción «cerrar» llega con «⏹ Cerrar» / «✖ Mantener», y las demás llevan
  además «⏹ Cerrar la operación» (`notifier.service.ts:763-772`).
- La propuesta «pasa a cerrada con su R real» (`docs/agent-trade.md`): si vence la entrada o hay una
  posición ajena sin haber entrado, queda «no entró»; parada sin cerrar, «cerrada» sin R.
- «La pérdida del día que cuenta es la del agente» (`docs/agent-trade.md`): el runner sigue pausando
  el bot por la pérdida diaria y el kill switch de la cuenta (`bot-runner.ts:3650-3697`).
- **Propuesta**: reescribir esas frases con lo que hace el código.

### F-25 a F-43 — Bajas

- **F-25** `BOT_VIVO` (`aprobacion.service.ts:52`, `agentes.service.ts:55`) no incluye STOPPING, que
  sí está en el índice único: con un bot real cerrándose en el par, la aprobación acaba
  FALLIDA/ARRANCAR en vez de PAR_OCUPADO. El invariante 11 se mantiene.
- **F-26** `salidaDelMotor` es un campo del runner que cualquier comando pone en MANUAL
  (`bot-runner.ts:3023`) y un reinicio vuelve a su valor: un cierre de seguridad puede figurar como
  del dueño. Guardar el origen por índice de cierre.
- **F-27** `enPlano` no lee `positionCap` (`agent-trade.ts:537-621`): con tope 0 antes de entrar,
  entra y cierra en el tick siguiente. Solo por edición a mano.
- **F-28** El recálculo mide la holgura de la IOC con el stop elegido y la ronda con el más cercano
  (`agentes/propuesta.ts:231`): con los mismos datos, el tope sube 3 ticks y el riesgo un 2 %,
  siempre dentro del límite del usuario.
- **F-29** `leerLimites` promete llevar lo que se sale del rango a lo de fábrica y no lo hace
  (`agentes/limites.ts:197-235`). Solo con una fila tocada a mano.
- **F-30** La «brecha de ejecución» mide todo al primer objetivo y con el plan propuesto, no con el
  final (`agentes/medicion.ts:62-68`): en un escalonado sale negativa sin pérdida de ejecución.
- **F-31** `saldoLibre` devuelve `available` aunque `capital()` lo marque `stale` o `unavailable`
  (`lectura.service.ts:94-98`): el recálculo puede dimensionar el margen con un saldo de hace 10 min.
- **F-32** El R real se mide sobre el riesgo del plan entero: con una IOC llena al 40 %, un stop
  completo figura como −0,4 R (`conciliacion.ts:97`). Las guardas usan el realizado y no se ven
  afectadas; la tarjeta sí.
- **F-33** `anotar` elige entre `set` e `increment` con el `usage_day` leído al empezar
  (`consumo.service.ts:86-96`): dos rondas a la vez pueden pisar `cost_today`. El cupo de Redis no se
  ve afectado.
- **F-34** «Revisar ahora» aparece con la operación EJECUTANDO y la API responde 409 («no está
  abierta»).
- **F-35** «entrada ≤» y «Entrada, como mucho» son al revés en un corto (el tope es un suelo); los
  límites del detalle se enseñan con `String(v)`, sin formato.
- **F-36** `cargarMercados` no lleva control de turno: cambiar de cuenta rápido puede dejar en la hoja
  los pares de la anterior.
- **F-37** Un error del resumen que no sea 403 se traga: la vista Agentes enseña un spinner para
  siempre, sin el interruptor global.
- **F-38** Abrir el interruptor global no relee el rol de la base (`admin-ai-desk.controller.ts:60`),
  al contrario de lo que dice el docblock de la clase; y cualquier administrador puede reabrir lo que
  cortó otro. Queda en la auditoría.
- **F-39** El test de 403 de las rutas no incluye `PUT agentes/:id`, y CA-11 pide 403 sobre el agente
  de otro administrador cuando el código —y la guía— responden 404.
- **F-40** `resultados` carga todos los candidatos medidos y todas las propuestas sin tope, y ninguna
  de las dos tablas se purga: crece con el uso, en el mismo proceso que atiende el kill switch.
- **F-41** `AiDeskConfig.num` convierte una variable vacía en 0 y la recorta al mínimo
  (`AI_DESK_TIMEOUT_MS=` deja 1 s); y la ronda de entrada y la de seguimiento llevan cada una su
  contador contra el mismo `AI_DESK_CONCURRENCY`, que así vale el doble. En el compose no pasa.
- **F-42** El vale se canjea (GETDEL) antes de comparar el dueño (`ai-desk.scheduler.ts:106`,
  `aprobacion.service.ts:452`): una pulsación ajena no aprueba nada, pero quema el vale. Solo importa
  si Telegram conserva los botones en un mensaje reenviado: por confirmar.
- **F-43** `aprobar(AUTO)` no comprueba que el efecto siga siendo APLICA: si el dueño pasa «entrar» a
  manual entre la ronda y el reclamo (milisegundos), entra igual.

## Verificado OK

- **Idempotencia y un bot por propuesta**: el reclamo condicional `PROPUESTA → APROBANDO` deja pasar
  a una sola aprobación entre app, Telegram, automático y réplicas; el vale se canjea con GETDEL; el
  enlace del bot es condicional y va antes de START; índice único sobre `bot_id`; un START que falla
  por HTTP borra el borrador. Ningún camino a dos bots (AP).
- **Invariante 11**: comprobado antes de crear, en `assertPairFree` y con el índice parcial en START
  (AP, AC).
- **Relectura al aprobar**: dueño ADMIN habilitado de la base, agente ACTIVO, `AI_DESK_ENABLE`,
  interruptor (nulo = cerrado), cuenta y frenos; recálculo con ticker, saldo, historial, tramos y ATR
  frescos, con PRECIO_PASO_STOP y PRECIO_MOVIDO (AP) —salvo lo de F-03, F-10 y F-11—.
- **Cupos**: contados antes de llamar, del agente y globales con INCR; sin Redis no se llama; solo
  `decidirAgente` llama al modelo (AP).
- **Barreras de la ronda** en el orden de R-12, una ronda de intervalo por vela entre réplicas (AP,
  UI).
- **La exención `soloReduceRiesgo` de `updateConfig`** no la puede usar nadie por `PUT /bots/:id`:
  solo la define `AGENT_TRADE`, que es de administradores con el rol leído de la base y no se crea
  por HTTP; COLD se rechaza antes; cualquier otra clave, un stop que se aleja o un tope que sube la
  desactivan (AP, OP).
- **La estrategia**: `clientOrderId` deterministas con tramos de índices que no se solapan; todo
  redondeo por `px`/`qy`; stop nativo, reduce-only y monótono ante cualquier secuencia de
  configuraciones, también en pausa y tras reiniciar; objetivos LIMIT reduce-only que nunca pasan de
  la posición; reducción por nivel e idempotente; apalancamiento que nunca sube; entrada IOC nunca a
  menos de medio stop del stop; R-1 por ciclo —salvo F-01 y F-13—; `validate`/`preview` coherentes con
  `plan()`; invariante 1 (OP).
- **El movimiento de la gestión del canal a `operacion/gestion.ts`** es fiel pieza a pieza, y los
  tests del canal pasan sin tocarlos (87/87) (OP, WK, MO).
- **El motor**: la pérdida al stop, con costes, nunca pasa de min(riesgo, 0,9 × lo que queda del día);
  apalancamiento dentro de todos los topes; liquidación detrás del stop en todas las bandas; causal
  (sin la vela en formación); los niveles cruzan a `Decimal` una vez; objetivos sobre el coste; la
  confianza solo reduce; el seguimiento solo ciñe o reduce; la triple barrera sin off-by-one; huellas
  sin colisión (MO).
- **El runner**: lo nuevo va tras `esOperacionDeAgente`; el canal no cambia; el vigilante y la
  protección en pausa cubren `AGENT_TRADE`; `detener` solo llega en plano; `onDetach` limpia los
  temporizadores; un bot STOPPED no se readopta; sin promesas sueltas ni secretos en logs (WK).
- **Telegram**: eventos sin bot con `agentId`; cerrojo de entrega por agente, propuesta o acción,
  tipo y `ts`; `callback_data` de 42 bytes como mucho; `leerCallbackAgente` estricto; `ia` e `ic`
  intactos; la cola por chat sin bucles ante un 429; el resumen diario respeta `agentes` y aísla sus
  fallos (WK).
- **Acceso**: las 20 rutas llevan las guardas de clase sin ningún override; ningún administrador ve ni
  toca lo de otro (agentes, propuestas, operaciones, acciones, detalle y bot filtran por dueño; el
  `agentId` se combina con AND); `forbidNonWhitelisted` global; el rol se relee de la base en todo lo
  que da poder salvo F-38; consentimiento de R-11 en el servidor; R-6 (la operación no se crea, copia,
  publica ni backtestea por HTTP) (AC).
- **Esquema y migraciones**: el SQL que genera `prisma migrate diff` desde el esquema de `c7fec40`
  coincide línea a línea con las dos migraciones, más los 5 índices parciales, que casan con los
  estados del código; solo CREATE; `ADD VALUE` en su propia migración (AC).
- **Operación**: `AI_DESK_ENABLE` apagado en código, `.env.example` y compose; `check:env` verde;
  crons tras `setnx`; el interruptor global se da por cerrado con Redis caído; retención de 90 días
  sin borrar filas (AC).
- **Cliente del modelo**: `decidirCanal` equivalente; `AI_DESK_ENABLE` independiente de las otras
  cargas; la clave solo viaja en `Authorization` (AC).
- **La app**: acceso por tres lados; los límites viajan con los tipos que exige la API y se validan
  con la misma función; consentimiento igual que el servidor; control de turno y `takeUntilDestroyed`
  en todas las vistas; el dinero pasa por `money`/`signed`/`price`/`qty`; el ejemplo de la guía de la
  app cuadra con los costes de HL (UI).
- **Las guías**: valores de fábrica, variables y sus defaults, las 12 barreras y su orden, tiempos de
  caducidad, severidades de los `AGENT_*` y los 25 campos de `AGENT_TRADE` coinciden con el código,
  salvo lo de F-24 (UI).

## Preguntas abiertas

1. **F-01**: ¿se considera «operación normal» que el venue tarde más de 30 s en enseñar una
   ejecución? De eso depende que sea Crítica (se corrige aquí) o Alta (spec de seguimiento).
2. **La pausa por pérdida diaria (F-05)**: ¿sobre lo realizado o sobre el peor caso (lo realizado más
   lo abierto al stop)? ¿Con umbral en el tope o en 0,9 × tope?
3. **El seguimiento sin modelo**: dormido, sin cupo o sin clave, el seguimiento se salta en vez de
   caer al juez de reglas. ¿Se quiere así, o reservar cupo para el seguimiento?
4. **Las guardas de la cuenta sobre una operación**: `killSwitchDrawdownPct` se mide sobre el margen
   de la operación; a 10× con un stop del 3 % la caída llega al 30 % antes del stop, y la guarda
   pausa el bot y le quita los objetivos (`bot-runner.ts:3650-3661,3041-3047`). ¿Se quiere que las
   guardas de la cuenta alcancen a las operaciones de los agentes?
5. **El R real (F-32)**: ¿sobre el riesgo del plan o sobre lo llenado?
6. **Capital frente a saldo**: el capital del agente no se compara con el saldo real; el margen sí se
   acota al saldo libre. ¿Tope o aviso?
7. **El recálculo con el precio a 0,49 distancias del stop** multiplica la cantidad por 1,76 con el
   mismo riesgo. ¿Se acota al tamaño aprobado?
8. **Costes fijos del venue**: los agentes no admiten costes sobrescritos; con `BUILDER_FEE_TENTH_BPS`
   en Hyperliquid o una cuenta Lighter con comisiones, 1R queda infravalorado. ¿Qué cuentas se usarán?
9. **`riesgoAbierto` tras proteger** sigue contando el riesgo inicial: conservador. ¿Proteger debería
   liberar margen del día?
10. **Tras doce cierres fallidos** (heredado del canal) la operación se queda solo con el stop, sin
    objetivos ni más intentos, hasta su tiempo máximo. ¿Se quiere así?
11. **Ensanchar el stop a mano antes de entrar** está permitido (R-2 solo protege con posición), y el
    R real deja de coincidir con `riskAmount`. ¿Intencionado?
12. **La consola de administración** enseña a otros administradores los `AGENT_TRADE` ajenos (con su
    plan) y les deja `PAUSE` y `STOP_KEEP_POSITION`. ¿Se acepta, visto F-18?
13. **El interruptor global** no lo mira el worker: una operación aprobada puede entrar hasta 5 min
    después de cortarlo. ¿Aceptable?
14. **Borrar una conexión** borra en cascada el agente y toda su medición. ¿Es lo que se quiere para la
    tarjeta?
15. **El intervalo del agente** también cambia las velas del seguimiento de las operaciones abiertas,
    aunque el editor dice que vale para los próximos análisis.
16. **Despliegue**: el 074 aplica antes la migración del 072, que aborta con un `AI_TRADER` real sin
    parar. ¿Está aplicada ya en producción?

## Respuestas del usuario (2026-09-25)

Un cuestionario con las decisiones pendientes; cada una manda sobre la propuesta de su ficha.

| # | Decisión | Dónde |
|---|---|---|
| 1 | F-01 se corrige dentro del 075 | `a0116c9` |
| 2 | Un spec 076 con **todo lo Alto y lo Medio** (F-02 a F-24) | 076 |
| 3 | La pausa diaria salta con **lo realizado más lo abierto al stop ≥ 90 % del tope** (pregunta 2) | 076, F-05 |
| 4 | Sin modelo —dormido, sin cupo o sin clave—, el seguimiento **cae al juez de reglas** (pregunta 3) | 076 |
| 5 | **Sin caída máxima por bot** en `AGENT_TRADE`; la pérdida diaria de la cuenta sigue (pregunta 4) | 076 |
| 6 | El recálculo al aprobar **nunca da más cantidad ni nocional** que lo propuesto (pregunta 7) | 076 |
| 7 | El R real **sobre lo que se llenó** (pregunta 5) | 076, F-32 |
| 8 | El stop **solo se ciñe, también antes de entrar** (pregunta 11) | 076 |
| 9 | **Aviso** en el editor si el capital supera el saldo (pregunta 6) | 076 |
| 10 | **Costes reales**: el builder fee cuando la cuenta lo paga (pregunta 8) | 076 |
| 11 | El **worker mira el interruptor global** antes de la entrada (pregunta 13) | 076 |
| 12 | La consola: **solo `PAUSE`** sobre operaciones de agente ajenas (pregunta 12) | 076, F-18 |
| 13 | Borrar una conexión **avisa** de lo que se pierde (pregunta 14) | 076 |
| 14 | Cada operación sigue con **el intervalo de su plan** (pregunta 15) | 076 |
| 15 | Proteger **no libera** margen del día (pregunta 9) | se queda así |
| 16 | Tras doce cierres fallidos, **se queda así** (pregunta 10) | se queda así |
| 17 | Las Bajas, en un **lote de limpieza tras el 076** | 077 |
| 18 | 073, 074 y 075 a `main` **ya**, sin esperar al 076, a petición del usuario el mismo día (había elegido «tras el 076» en el cuestionario) | mezcla |
| 19 | La migración del 072 **no está aplicada** en producción (pregunta 16) | despliegue |
| 20 | Portar **todo** (072-075) al fork open source tras mezclar | fork |

Mientras el 076 no esté hecho, `AI_DESK_ENABLE` sigue apagado en producción: con el módulo apagado
no corre ninguna ronda ni se crea ninguna operación, y las Altas de arriba no se pueden alcanzar.
