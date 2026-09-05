# 006 — Plan

## Enfoque

Leer lo que ya se escribe. Un endpoint de lectura sobre `bot_config_revisions`, dos funciones puras
en `shared` con sus tests, y la pantalla que las usa. Primero la aritmética (sin base, sin Nest),
después el endpoint, después la pantalla.

Alternativas descartadas:

- **Servir la configuración completa de cada revisión**: ya la sirve `GET /bots/:id` para la
  vigente, y la lista sería veinte veces más pesada para pintar lo mismo que dice el `diff`.
- **Un endpoint de cronología en el servidor**: sería un cuarto endpoint que repite los tres que
  existen; la fusión es aritmética de pantalla y va a `shared` con test, como la del 002.
- **Exportar a fichero**: dos plugins nuevos de Capacitor para un caso que el portapapeles cubre.

## Ficheros afectados

| Fichero | Qué cambia | Tests que lo cubren |
|---|---|---|
| `packages/shared/src/timeline.ts`, `timeline.spec.ts` | **Nuevo.** `cronologiaPorCiclo(entradas, ciclos)` | el spec |
| `packages/shared/src/csv.ts`, `csv.spec.ts` | **Nuevo.** `aCsv(filas, columnas?)` | el spec |
| `packages/shared/src/index.ts` | exporta los dos | typecheck |
| `apps/api/src/modules/bots/bots.service.ts` | `revisions(userId, id, limit, offset)` | `bots-revisions.spec.ts` (nuevo) |
| `apps/api/src/modules/bots/bots.controller.ts` | `GET :id/revisions` | — |
| `apps/app/src/app/core/models/index.ts` | `BotConfigRevision`, `ConfigChange` | typecheck |
| `apps/app/src/app/core/services/bots.service.ts` | `revisions(id)` | typecheck |
| `apps/app/src/app/core/utils/field-labels.ts` | `labelDeClave(labelKey, key)` | — |
| `apps/app/src/app/features/bots/bot-detail.page.{ts,html}` | historial en Ajustes, vista por ciclo en Eventos, «Copiar CSV» | build |
| `apps/app/src/global.scss` | `bd-hist`, `bd-tl`, `bd-copy` | build (presupuesto) |

## Fases

| Fase | Qué | Criterio de salida |
|---|---|---|
| 0 | Rama, línea base | Rojos conocidos anotados |
| 1 | `timeline.ts` y `csv.ts` con specs | CA-1 |
| 2 | Endpoint de revisiones con test | CA-2 |
| 3 | Pantalla: historial, cronología, CSV | CA-6; CA-3..CA-5 a mano |
| 4 | Cierre: índice, memoria | Estado `hecho` cuando CA-3..CA-5 estén comprobados |

## Verificación

```bash
pnpm --filter @crypton/shared build && pnpm --filter @crypton/shared test
pnpm --filter api test && pnpm --filter api lint
pnpm --filter app build && pnpm --filter app lint
```

Desde Git Bash. A mano, con un bot simulado que tenga al menos dos ciclos cerrados y un cambio de
configuración: abrir Ajustes y ver el historial; abrir Eventos, pasar a «por ciclo» y comprobar que
las órdenes de cada ciclo cuelgan de su cabecera; copiar los ciclos y pegarlos en una hoja.
