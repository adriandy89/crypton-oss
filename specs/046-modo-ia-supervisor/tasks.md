# 046 — Tareas

Una casilla por tarea, agrupadas por fase. Se marcan al terminar, con una nota corta si hubo
sorpresas. Nada se da por hecho sin la verificación de su fase.

## Fase 0 — Línea base

- [x] Rama `spec/046-modo-ia-supervisor` creada desde `main` limpio (`a3e74dd`)
- [x] `pnpm build:packages`
- [x] `pnpm test` (sin e2e) — verde: worker 342, api 5437, strategy-core y backtest incluidos
- [x] `pnpm lint` — limpio (3 avisos preexistentes en el e2e de la API)
- [x] `pnpm check:env` — API 37 variables, worker 31, coherente
- [x] `spec.md` y `plan.md` redactados
- [x] Fila en el índice de `specs/README.md` como `borrador`

## Fase 1 — Telegram: que un aviso de la API pueda llegar

- [x] Test en `notifier.service.spec.ts` que comprueba que un `ADMIN_COMMAND` llega al chat del
      dueño. **Falló antes del cambio**, por el motivo declarado (R-27, CA-10)
- [x] `entregaForzada?: boolean` en `BusMessage`, en los dos `bus.service.ts`, con su párrafo junto
      al de `origin`
- [x] Escotilla en `notifier.service.ts`: `reservarEntrega()` con clave compuesta solo de datos del
      mensaje, para que las N réplicas compitan por la misma
- [x] Test: sin la marca se sigue descartando (el camino de alto volumen no cambia) (CA-11)
- [x] Test: con la marca y el cerrojo denegado no se entrega (la segunda réplica) (CA-11)
- [x] `admin-bots.service.ts` publica `ADMIN_COMMAND` con `severity`, `message` y la marca
- [x] `ADMIN_COMMAND` en `EVENT_PREF` (bajo `risk`, no `errors`) e `ICON`
- [x] Preferencia `ai` en `DEFAULT_PREFS` (worker), `DEFAULT_TELEGRAM_PREFS` (API), su DTO y el
      tipo de la app (sin fila en la pantalla todavía: la UI es de la fase 10)
- [x] `pnpm --filter worker test` (342) y `pnpm --filter api test` (5437), ambos verdes
- [x] Commit `a581ff7`: `fix(worker): el aviso de un comando de administracion llega a telegram`

## Fase 2 — Esquema y migración

- [x] `enum AiMode { OFF, MANUAL, AUTO }` y `enum AiDecisionState` en `schema.prisma`
- [x] `model BotAiSetting` (uno a uno opcional con `Bot`, como `BotMmStat`)
- [x] `model BotAiDecision` con `dossier`, `knobs_before`/`knobs_after` y las dos versiones
- [x] Relaciones inversas en `Bot`
- [x] Migración `20260912090000_modo_ia_supervisor`, escrita a mano y verificada: las 23
      migraciones se aplican en limpio sobre una base temporal y `migrate diff` contra el esquema
      no reporta NADA de estas tablas (solo una deriva preexistente en `paper_states`)
- [x] `AiMode` y `AiDecisionState` en `packages/shared/src/enums.ts`, calcados valor a valor
- [x] `prisma validate`, `prisma generate` y `pnpm build:packages`; api (5437), worker (342) y
      strategy-core (504) en verde
- [ ] **Pendiente**: aplicar la migración a la base de desarrollo con `pnpm prisma:deploy`. Es
      aditiva (dos tablas y dos enums nuevos, ninguna columna existente se toca), pero toca datos
      reales: se hace cuando el usuario vaya a probar (CA-12)
- [x] Commit `67308e9`: `feat(db): el modo ia y su historial de decisiones`

## Fase 3 — `apply.ts`, el corazón

- [x] Exportar `shiftBand` desde `advisor/build.ts`
- [x] `aplicarDesplazamientos(knobs, ajustes)` con tope en los extremos
- [x] `fusionarConservandoInmutables()`: parte de la vigente, pisa solo lo no-COLD del descriptor
      **efectivo**, y con test directo propio (es la función más delicada del fichero)
- [x] Refijar `exchangeAccountId`, `symbol`, `direction` y `totalInvestment`
- [x] `decidirCambio()`: la cadena entera con sus seis motivos de rechazo con nombre
- [x] Recorte de desplazamientos con inventario abierto (solo los que bajan riesgo)
- [x] Tope de apalancamiento: +1 por decisión y nunca sobre `min(18, venue, usuario)`
- [x] `stopLossPct` solo se estrecha
- [x] Tope de cuatro campos por decisión
- [x] `apply.spec.ts`: matriz de 4 estrategias x 12 mercados reales x 3 perfiles x 85 vectores,
      **sin una sola salida muda** (CA-3)
- [x] Test: los cinco `IGUAL` producen `SIN_CAMBIOS` (CA-4)
- [x] Test: `MAS` y luego `MENOS` devuelve la configuración original (CA-4)
- [x] Test: ningún campo de carácter cambia nunca (R-6)
- [x] `pnpm --filter api test` (5451) y `pnpm --filter api lint` limpios
- [x] **Pruebas de mutación**: se rompió cada salvaguarda a propósito para comprobar que el test la
      caza. Dos hallazgos: el test no detectaba nada hasta que los bots de la matriz llevaron el
      `totalInvestment` con el formato real de la base (`Decimal(38,18)`), y los dos topes no se
      ejercitaban desde la cadena, así que se probaron además directamente
- [x] **Hallazgo de diseño anotado en el código**: cambiar el apalancamiento arrastra siempre más de
      cuatro campos, así que el supervisor NO puede tocarlo en ninguna estrategia. Es deseable y se
      fija con un test, no se «arregla» subiendo el tope
- [x] Commit `08e8ece`: `feat(api): la traduccion determinista del supervisor`

## Fase 4 — El contrato con el modelo

- [x] `decision.ts`: `PROMPT_VERSION_REVISION`, acciones, confianzas, esquema y prompt de sistema
- [x] `OpenRouterClient.revisar()` con `AI_AGENT_MODEL` y `AI_AGENT_ENABLE` propios. El transporte
      se extrajo a `pedir()` en vez de duplicarlo: son 200 líneas de incidentes aprendidos
- [x] `parseRevision()` que valida la forma aunque el modo estricto la prometa, y **no repara**
- [x] `decision.spec.ts`: recorrido recursivo del esquema; ni un `minimum`, `maximum`, `oneOf`,
      `pattern` ni `number`; toda clave en `required`; `additionalProperties:false` (CA-2)
- [x] Test: banda fuera del enum tira la respuesta ENTERA; `CONTENER` se rechaza; el motivo se
      recorta y nunca se convierte con `String()`
- [x] Test: cada uno usa su modelo, apagar uno no apaga el otro, y el supervisor **no hereda**
      `OPENROUTER_MODEL` si su variable está vacía
- [x] Test: las cabeceras siguen siendo solo ASCII, con los dos títulos
- [x] Las once variables en los tres sitios; `pnpm check:env` coherente
- [x] `advisor.spec.ts` y `advisor.quota.spec.ts` pasan **sin tocar una aserción** (criterio de
      no-rotura del refactor del cliente)

## Fase 5 — El expediente

- [x] `dossier.ts`: identidad, perillas, mercado, posición, rendimiento, salud e historial, todo
      en tramos y porcentajes
- [x] `expedienteBucket()` cuantizado, al estilo de `featuresBucket`, y cabe en `VARCHAR(64)`
- [x] Render a prompt en castellano; las restricciones van en el prompt de sistema
- [x] `dossier.spec.ts`: sin credenciales, sin identificadores, sin precios absolutos, sin importes;
      `name` y `note` **ni siquiera están en el tipo de entrada** (CA-5)
- [x] Test: un bot recién nacido no imprime `null`, `NaN` ni `undefined` en ninguna línea, y dice
      explícitamente que no hay datos en vez de callarse
- [x] Test: la huella aguanta un movimiento del 0,3 %, cambia con el régimen, y **no cambia solo
      porque avance el reloj** (si no, el caché caducaría por mirar la hora)
- [x] Test: el prompt cabe en el presupuesto de tamaño

## Fase 6 — Política y superficie de administración

- [x] `supervisor.policy.service.ts`: activar, desactivar, leer; siembra de perillas con
      `defaultKnobs`, y **no se resiembran** al reconfigurar (moverían el origen de los
      desplazamientos y las decisiones anteriores dejarían de encadenar)
- [x] `admin-ai.controller.ts` con guards y `@Roles('ADMIN')` a nivel de **clase**, y `reason`
      obligatorio como en la contención
- [x] `Forbidden` si el bot no es del administrador que lo pide, y el mensaje dice **por qué**
      (CA-6). También al LEER la política, no solo al escribirla
- [x] Auditoría `WARN` con `recordNow` (el decorador no deja pasar el motivo en `meta`)
- [x] `ADMIN` salta `assertCanUseTelegram` (R-26). **Preventivo**: hoy el nivel gratuito ya trae
      `telegramAlerts`, así que ese gate no bloquea a nadie; el día que las alertas pasen a un plan
      de pago, el modo manual se habría quedado sin su único canal
- [x] `admin-guards.spec.ts` crece con el controlador nuevo: ninguna ruta nace abierta
- [x] La segunda comprobación de la frontera vive en la consulta del barrido: exige `role = ADMIN`
      y `disabled = false`, así que quitarle el rol a alguien duerme sus políticas solo
- [x] `pnpm --filter api build` limpio: el módulo nuevo no crea ciclos

## Fase 7 — El lazo, solo en manual

- [x] `supervisor.service.ts`: puerta de estado, hueco mínimo, coalescencia, caché por huella y
      las dos cuotas
- [x] `supervisor.scheduler.ts`: `@Cron` con `setnx`, suscripción a `BOT_EVENTS` y un segundo cron
      que caduca propuestas (corre aunque el Modo IA esté apagado)
- [x] `FILL` nunca entra en la tubería; `CYCLE_CLOSED` y los avisos de riesgo sí
- [x] Escritura de `bot_ai_decisions` con su expediente y su caducidad
- [x] Evento `AI_SUGGESTION` con `entregaForzada`
- [x] `AI_FAILED` estrangulado a uno por bot y hora; a los cinco fallos el modo se duerme
- [x] Tests (19): Redis caído no llama; ningún estado distinto de RUNNING se revisa; misma huella
      no llama; `MANUAL` no llama a `updateConfig`; `MANTENER` no escribe nada (CA-7, CA-8)
- [x] **Corrección de diseño importante**: se aplicaba la configuración regenerada entera, así que
      un bot ajustado a mano por su dueño producía un diff de veinte campos y moría SIEMPRE en
      `DEMASIADOS_CAMPOS`. Ahora se aplica solo el **delta** del desplazamiento —comparando lo
      generado con las perillas viejas contra las nuevas—, y todo lo demás del bot se queda como su
      dueño lo dejó. De paso el apalancamiento vuelve a ser ajustable, con su tope de +1

## Fase 8 — Modo automático

- [x] `updateConfig` acepta `opts.appliedBy`, con la misma forma que `CommandOptions`
- [x] Aplicación con `acceptRelayout` atado al nivel del diff, ni siempre ni nunca
- [x] Cortacircuitos tras cinco fallos seguidos y `paused_until`
- [x] `AI_AGENT_FORCE_MANUAL` (degrada sin tocar la base) y `AI_AGENT_DRY_RUN_ONLY`
- [x] Tope de cambios aplicados al día, distinto del cupo de llamadas
- [x] Tests (25): aplica como el dueño y por el mismo camino; deja su firma en el historial;
      `FORCE_MANUAL` degrada; el tope diario frena; si `updateConfig` rechaza, la configuración
      queda intacta y se dice (CA-8)
- [x] Las variables en los tres sitios y `pnpm check:env` coherente


## Fase 9 — Botones de Telegram

- [x] `telegram-client.ts`: `reply_markup`, `answerCallbackQuery`, `allowed_updates`, tipo ampliado
- [x] `AI_SUGGESTION` se envía **fuera del lote**, con su teclado (un teclado pertenece a UN
      mensaje: fundirlo con once líneas dejaría dos botones colgando de otro texto)
- [x] Rama de `callback_query` en el sondeo. El worker hace de **mensajero**: no aplica, no
      consulta la decisión y ni sabe de qué bot es. Publica el vale y ya
- [x] Vuelta por el bus y canje en la API con `getDel` **atómico**: dos pulsaciones aplican una
      vez sin necesidad de ningún otro cerrojo, y con N réplicas solo una gana el vale
- [x] Tests (32): vale inexistente, vale de otro usuario, decisión que ya no está pendiente, y
      configuración cambiada entre medias → caduca sin tocar el bot (CA-9)


## Fase 10 — La app

- [x] Panel del Modo IA en la ficha de bot de administración, **solo si el bot es propio**:
      ofrecer un interruptor que va a responder 403 es peor que no ofrecerlo
- [ ] Cola de decisiones con diff campo a campo — **aplazada**: el modo manual ya se aprueba desde
      Telegram, que es lo que se pidió, y la cola es la comodidad para quien prefiera la app
- [x] Modelos y servicio en `core/`, con el diálogo de motivo en `AdminActionsService`
- [x] `ng build` y `ng lint` limpios

## Cierre

- [ ] Criterios de aceptación repasados uno a uno
- [x] `docs/administracion.md` cuenta el Modo IA y sus límites
- [x] Índice de `specs/README.md` actualizado
- [ ] `CLAUDE.md` actualizado (el mapa gana el módulo del supervisor)
- [ ] Memoria de usuario actualizada
- [ ] CA-12: comprobación manual del usuario con la infraestructura levantada
