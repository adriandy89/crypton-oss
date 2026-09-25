# 074 — Plan

## Enfoque

**El motor calcula y valida, la IA elige, el worker ejecuta, y las salidas nunca esperan al
modelo.** Todo lo que convierte decisiones en números vive en `strategy-core` como funciones puras,
así que se puede probar con tests y recorrer con propiedades. La API orquesta: lee el mercado,
pregunta, guarda, aprueba y crea bots por el camino de siempre. El worker ejecuta y avisa. La app
enseña y deja decidir.

Tres piezas se reutilizan en vez de reescribirse:
- **La gestión de posición del canal** se *mueve* tal cual a `operacion/gestion.ts`. Es la parte
  pagada con incidentes (specs 060-062), y copiarla sería perder el siguiente arreglo en una de las
  dos copias.
- **`opcionDeStop` / `preciosDeEntrada`** del canal dimensionan cada candidato. Solo se ensancha un
  tipo de parámetro.
- **La maquinaria de proponer y aprobar** del Modo IA: vale de un solo uso, recálculo al aprobar,
  cupos antes de llamar y cerrojos. Se copia su *patrón*, no su código, porque sus reglas prohíben
  justo lo que aquí hace falta: ceñir el stop con la posición abierta.

Alternativas descartadas:
- **Usar el Modo IA para el seguimiento.** No toca stop ni objetivo con posición, y no cubre
  operaciones sueltas.
- **Usar «Seguimiento de beneficio» como vehículo.** Vuelve a entrar al cerrar, su stop va en % y
  no tiene objetivos fijos ni parciales.
- **Comandos nuevos para reducir o mover el stop.** Los objetivos de nivel en configuración HOT son
  idempotentes por construcción y pasan por el único camino de escritura.

## Fases y commits

Cada commit deja el árbol compilando y en verde.

| # | Commit | Contenido | Verificación |
|---|---|---|---|
| C0 | `docs(specs)` | spec, plan, tareas y fila del índice | — |
| C1 | `refactor(strategy-core)` | `operacion/gestion.ts`: mover la gestión del canal y ensanchar el tipo de `opcionDeStop` | tests del canal **sin cambios** en strategy-core, backtest y worker; `gestion.spec.ts` |
| C2 | `feat(shared)` | `ia-agentes.ts`: enums, lectores de JSON, vales, `insigniaAgente` y aritmética de resultados | tests de shared |
| C3 | `feat(strategy-core)` | `agentes/`: límites, familias, tasas, herramienta, juez, propuesta, seguimiento y medición | causalidad, propiedades y valores calculados a mano |
| C4 | `feat!` | `AGENT_TRADE` entera: enum de shared y Prisma con su migración, estrategia, registro, listas de flags, app (modelos, etiquetas, guía, field-labels), `REANCHOR_NO_APLICA`, rechazo por HTTP y en backtests | strategy-core, worker, backtest, API, `check:labels`, tipado y build de la app, migración en base temporal |
| C5 | `feat(worker)` | el runner para toda estrategia `apalancamientoPorOperacion` | `bot-runner.agente*.spec.ts`; specs del canal sin cambios |
| C6 | `feat(db)` | tablas del agente, migración `…_agentes_ia` y retención del expediente | migración en base temporal; retención |
| C7 | `feat(api)` | `decidirAgente()` en el cliente del modelo y las variables `AI_DESK_*` | spec del cliente; `check:env` |
| C8 | `feat(worker,api,app)` | Telegram: preferencia `agentes`, eventos sin bot, botones `ag`, quitar el teclado al pulsar y resumen diario | notifier y poller |
| C9 | `feat(api)` | agentes: CRUD, política, rutas de administración e interruptor global | guardas, rutas y validación |
| C10 | `feat(api)` | rondas: lectura, barreras, cupos, herramienta, contrato, prompt, render, propuestas, REGLAS y sombra | contrato, privacidad, barreras, réplicas y fallos |
| C11 | `feat(api)` | aprobación: recálculo, creación, START, limpieza, automático, conciliación y recuperación | CA-7 |
| C12 | `feat(api)` | seguimiento, más `soloReduceRiesgo` en la estrategia y en `updateConfig` | mapeo que solo ciñe o reduce, obsoleto, cupos |
| C13 | `feat(api)` | medición y tarjeta de resultados | etiquetado, estadística y «nada lee la tarjeta» |
| C14 | `feat(app)` | la sección IA: servicio, insignia, pestañas, interruptor, 403 | tipado, lint y build de la app |
| C15 | `feat(app)` | editor y detalle del agente, selector múltiple de pares | ídem |
| C16 | `feat(app)` | propuestas, operaciones, resultados, panel del bot, Bots y preferencia de Telegram | ídem |
| C17 | `docs` | guías, `README.md`, `CLAUDE.md` (mapa e invariante 13) | enlaces |
| C18 | revisión | spec **075** de revisión antes de dinero real, sobre esta rama | `findings.md` |
| C19 | cierre | verificación completa, índice, memorias; mezcla a `main` con el visto bueno del usuario | CA-1…CA-11 |

## Ficheros principales

| Fichero | Qué |
|---|---|
| `packages/strategy-core/src/operacion/gestion.ts` | nuevo, con lo movido de `strategies/ai-channel.ts` |
| `packages/strategy-core/src/strategies/agent-trade.ts` | nuevo: la estrategia |
| `packages/strategy-core/src/agentes/*.ts` | nuevo: el motor puro del agente |
| `packages/shared/src/ia-agentes.ts` | nuevo: el vocabulario |
| `packages/db/prisma/schema.prisma` + dos migraciones | `AGENT_TRADE` y las tablas `ai_desk_*` |
| `apps/worker/src/engine/bot-runner.ts` | el cambio acotado de R-8 (el fichero se ha leído entero) |
| `apps/worker/src/notifications/{notifier,telegram-poller}.service.ts`, `telegram-client.ts` | Telegram |
| `apps/api/src/modules/ai-desk/*` | nuevo: el módulo |
| `apps/api/src/modules/advisor/openrouter.client.ts` | la carga `decidirAgente` |
| `apps/api/src/modules/bots/{bots.service,bots.controller}.ts` | `soloReduceRiesgo` y el rechazo por HTTP |
| `apps/app/src/app/features/ia/*` | la sección |

## Verificación

```bash
pnpm build:packages && pnpm test
pnpm lint && pnpm check:env && pnpm check:labels
cd apps/app && pnpm exec tsc -p tsconfig.app.json --noEmit && cd ../..
pnpm --filter app lint && pnpm --filter app build
pnpm --filter api build && pnpm --filter worker build
```

Migraciones: una base temporal dentro de `crypton-db`, con las migraciones aplicadas en orden con
`psql` y filas de prueba. Sin leer ningún `.env`. Se borra al terminar.
