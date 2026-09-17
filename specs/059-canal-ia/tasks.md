# 059 — Tareas

## Fase 0 — Rama y spec

- [x] Rama `spec/059-canal-ia` desde la punta del 058 (`1777f65`)
- [x] `spec.md`, `plan.md`, `tasks.md` y fila del índice
- [x] Referencias oficiales de OpenRouter (salida estructurada, caché, uso y coste)
- [x] Línea base: la del 058

## Fase 1 — `shared` y `strategy-core`

- [x] `MotivoConsulta`, `MotivoCanal`, `RiesgoCanal`, `RespuestaModeloCanal`, `DecisionGuardada`
- [x] `EventoCanal`, `EVENTOS_MODO_IA`, prefijo y clave del vale de pausa
- [x] Vistas: `VistaCanal`, `EstadoCanalBot`, `DecisionCanalVista`, `ResumenCanalAdmin`
- [x] Puras con test: `vistaCanalDe`, `operacionCanalDe`, `lineasDelCanal`, `cifrasCanalDe`,
      `rachaDePerdidas`
- [x] `OpcionStop.medioViable` en la herramienta, con la cuenta de `construirOperacion`
- [x] `scratch.vista` en plano
- [x] La estrategia reduce el tamaño por confianza al usar una decisión de la IA
- [x] `AI_EXIT` de la estrategia → `AI_CIERRE` (INFO); tests de estrategia, runner y backtest
- [x] El worker usa `rachaDePerdidas`

## Fase 2 — Transporte

- [x] Test que falla primero: supervisor encendido y asesor apagado → la cabecera lleva la clave
- [x] `pedir()` con clave y plazo por llamada; devuelve contenido, uso y fallo
- [x] `decidirCanal()`: modelo, razonamiento, caché (`1h`, `5m`, `off`), título, uso y coste
- [x] `canalDisponible` con su interruptor y sus avisos de arranque

## Fase 3 — Contrato, render y prompt

- [x] `contrato.ts`: esquema por oferta, parser sin reparaciones, `validarEleccion`
- [x] `herramienta.ts`: `ofertaDe` y `renderHerramienta` en unidades relativas
- [x] `prompt.ts`: sistema fijo y versión con hash fijado
- [x] Test del esquema (sin números, objetos cerrados, enums = vocabulario)
- [x] Test de privacidad del render

## Fase 4 — El lazo

- [x] `AiChannelService`: reclamar, barreras, cupos, llamada, resultado, `bot_ai_loops`, eventos y
      bus
- [x] `AiChannelScheduler`: bus, sondeo, semáforo, barrido y la pausa por botón
- [x] Entorno: `.env.example` (API y docker), compose, `check:env`
- [x] `app.module.spec` con el módulo nuevo

## Fase 5 — Worker

- [x] `abrir()` devuelve si movió la fila; `valeDePausa()`
- [x] `AI_ENTRY` con los números del plan y el vale
- [x] `applyFillToCycle` con `eventoCierre`; `AI_EXIT` con resultado, R y motivo
- [x] e2e en modo `IA` sobre el simulador con la decisión escrita como la API

## Fase 6 — Avisos

- [x] `EVENT_PREF`, `MIN_SEVERITY` e iconos del canal
- [x] Teclado `ic:<vale>:pausa` en `AI_ENTRY`
- [x] Poller: `ic:` → `AI_CHANNEL_PAUSE`

## Fase 7 — Administración y acceso

- [x] `strategiesMeta(userId)` con el rol de la base
- [x] Test de `BotCommandDto`: sin `AI_INTENT`
- [x] `AdminAiChannelController` y su servicio de estado
- [x] `admin-guards.spec`, `admin-ai-channel.routes.spec` (los tres controladores en su orden) y
      la superficie del e2e de aislamiento
- [x] Una sola definición de las claves del cupo, para el lazo y la consola
- [x] Mutaciones de la fase: 62 de 62 caen

## Fase 8 — App

- [x] Etiquetas, opciones, grupos y eventos
- [x] Recarga del Modo IA solo con sus eventos
- [x] Caché de estrategias por usuario
- [x] Crear: consentimiento, sin asesor ni editor, límites por la regla de la estrategia, textos
- [x] `CanalIaService` y `canal-ia-panel`, en el detalle y en la consola
- [x] Gráfico con las líneas del canal
- [x] Consola: pastilla e interruptor global
- [x] Backtest: ventanas, tablas y reapertura
- [x] Guía de la app
- [x] `ng lint` y `ng build` sin avisos de presupuesto

## Fase 9 — Guías

- [x] La purga vacía la herramienta de las intenciones viejas (pendiente del plan aprobado)

- [x] `docs/ai-channel.md` y el índice (los 48 campos de `meta.fields`, enlaces y anclas comprobados)
- [x] `administracion.md`, `comandos-guardas-y-eventos.md`, `riesgo-y-liquidacion.md`,
      `buenas-practicas.md`, `simulacion-y-backtest.md`
- [x] `README.md` y `CLAUDE.md` (mapa e invariantes del dinero con el texto aprobado)
- [x] El backtest de la app elige velas de 5 min para un bot del canal

## Fase 10 — Cierre

- [x] Verificación completa
- [x] Mutaciones (224 de 224)
- [x] Estado del spec y del índice; memoria
- [ ] **CA-10 pendiente del usuario**: una llamada de pago aprobada
- [ ] **CA-11 pendiente del usuario**: la simulación de 48-72 h y la primera sesión real
