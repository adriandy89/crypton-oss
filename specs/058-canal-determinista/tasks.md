# 058 — Tareas

## Fase 0 — Rama y spec

- [x] Rama `spec/058-canal-determinista` desde la punta del 057 (`8635d88`)
- [x] `spec.md`, `plan.md`, `tasks.md` y fila del índice
- [x] Línea base: la del 057 (7280 tests)

## Fase 1 — `shared`

- [x] `ia-canal.ts`: enums del canal, `CandidatoOperacion`, `SalidaHerramienta`, `DecisionIa`,
      `HistorialOperaciones`, `NivelApalancamiento`, `PlanOperacion`, `SolicitudIa`
- [x] Regla por stop en `liquidation.ts` (`apalancamientoPorStop`), con tests a mano y la
      derivación del corto
- [x] El contrato de `BotContext`/`DesiredState`/órdenes
- [ ] `StrategyKind.AI_CHANNEL`: pasa a la fase 3, junto al esquema de Prisma (los enums lo calcan)

## Fase 2 — `canal/`

- [x] `numeros.ts`, `estadistica.ts`
- [x] `velas.ts`, `swings.ts` (propiedad de no repintado)
- [x] `canales.ts`, `regimen.ts`, `setups.ts`
- [x] `costes.ts`, `config.ts` (`DEFAULTS_CANAL`), `herramienta.ts` (ejemplo trabajado exacto),
      `construirOperacion`
- [x] `tasas-base.ts` (sin mirar al futuro), `juez.ts`, `analisis.ts` (caché LRU)
- [x] Fuzz de 10.000 casos y rendimiento (sobre `dist`, en el cierre: análisis 4,1 ms, tasas
      2,7 ms; los umbrales de jest solo cazan un algoritmo que se dispara)
- [x] 18 mutaciones de la herramienta y la regla por stop: las 18 caen

## Fase 3 — La estrategia

- [x] Contrato nuevo en `types.ts`
- [x] `validateCommon` con `reglaLiquidacion: 'POR_STOP'`; `MAX_APALANCAMIENTO_POR_STOP` en `shared`
- [x] `ai-channel.ts`: `validate`, `preview`, `plan` (con posición, en plano, salidas)
- [x] Registro y baterías genéricas, con la hermana «solo el canal pide series»
- [x] `StrategyKind.AI_CHANNEL` en `shared` y en el esquema (la migración, en la fase 5)
- [x] App, lo mínimo para compilar: unión, etiqueta, línea del selector, guía v1 y filtro de la
      consola (el resto de la app sigue en el 059)
- [x] 20 mutaciones de la estrategia: las 20 caen

## Fase 4 — Acceso mínimo

- [x] `ESTRATEGIAS_SOLO_ADMIN` en `shared`: una lista para todos los sitios
- [x] Planes y semilla sin `AI_CHANNEL`; un plan sembrado con ella no la abre
- [x] Listado sin ella para nadie; vista previa, `create`, edición y `START` solo para un
      administrador habilitado, con el rol leído de la base
- [x] Asesor y supervisor lo rechazan; sus baterías lo excluyen con su razón
- [x] Ranking: ni se publica, ni se copia, ni cuenta
- [x] `RiskService` con la regla por stop y el nocional que declara la estrategia

## Fase 5 — Migración

- [x] Esquema y migración `20260917120000_canal_ia` (`AI_CHANNEL`, `AiIntentState`,
      `bot_ai_intents` con su índice único parcial, `bot_ai_loops`, `bots.max_notional`), generada con
      `prisma migrate diff` sin tocar ninguna base
- [x] `prisma:deploy` local; el diff de la base contra el esquema solo enseña una diferencia anterior
      y ajena (`fk_paper_state_bot`)
- [x] Las intenciones del juez llevan el bot en su id (`reglas:<bot>:<vela>`): el worker crea la fila
      con él

## Fase 6 — exchange-core

- [x] `getLeverageTiers` (HL con las tablas del catálogo, Aster con `leverageBracket` firmado,
      Lighter con un tramo; el simulador, los de su fuente) con fixtures
- [x] `setLeverage` con acuse (`leverage` que confirma el venue, `maxNotional` de Aster),
      `expiresAt` (Lighter `order_expiry`; Aster y HL no lo tienen) y `getPositionMode` (Aster)
- [x] Simulador: IOC que casa o se cancela, `TRADE_THROUGH` y caducidad; HL: «no casa» →
      `CANCELED`; Aster: IOC con `RESULT`
- [x] Lighter: la límite IOC va sin caducidad (hallazgo latente: el firmante la rechazaba)
- [x] 45 mutaciones de `exchange-core`: las 45 caen

## Fase 7 — Worker

- [x] Series y TTL, tick al cierre
- [x] Apalancamiento por operación, vigilante del stop
- [x] Guardas (tope diario, liquidación por stop), historial
- [x] Intenciones (store y bus), candado, interruptor, tope por venue, Aster
- [x] e2e sobre el simulador en modo `REGLAS`
- [x] Mutaciones del worker y de lo que toca de la API

## Fase 8 — Backtest

- [x] Series, historial, tramos, juez; apalancamiento; `TRADE_THROUGH`
- [x] `metricasPorSetup`, coherencia con `tasasBase`
- [x] API: calentamiento, aviso del juez, `ventanasConsecutivas`
- [x] Mutaciones del backtest, de las tasas base y de la API del backtest

## Fase 9 — Cierre

- [x] Verificación completa y mutaciones
- [x] Estado del spec y del índice; memoria
- [ ] **CA-9 pendiente del usuario**: walk-forward con el juez antes de la primera sesión real
