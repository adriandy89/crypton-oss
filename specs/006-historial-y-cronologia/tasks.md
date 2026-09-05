# 006 — Tareas

Una casilla por tarea, agrupadas por fase. Se marcan al terminar, con una nota corta si hubo
sorpresas. Nada se da por hecho sin la verificación de su fase.

## Fase 0 — Línea base

- [x] Rama `spec/006-historial-y-cronologia` creada desde `d9e5311` (`main`)
- [x] Tests por paquete (`shared` 73, `api` bots 55, resto igual que al cierre del 005), lint y build limpios

## Fase 1 — Aritmética

- [x] `packages/shared/src/timeline.ts` + spec (5 tests) — `533835c`
- [x] `packages/shared/src/csv.ts` + spec (4 tests)

## Fase 2 — API

- [x] `BotsService.revisions` + `GET /bots/:id/revisions`, con `mustOwn` y `select` sin `config`
- [x] `bots-revisions.spec.ts` — 3 tests sobre `revisionPublica` (el mapeo tolerante del `diff`)

## Fase 3 — App

- [x] Modelo (`BotConfigRevision`, `ConfigChange`), cliente y `labelDeClave` (`fieldLabel` acepta ahora `Pick<FieldMeta, 'key' | 'labelKey'>`)
- [x] Ajustes: historial de revisiones con nombre legible del campo y valores de antes y después (`textoDeConfig`)
- [x] Eventos: vista «por ciclo» (`bot-timeline.ts` adapta; `cronologiaPorCiclo` agrupa); las ejecuciones se piden al abrirla y se refrescan solo si ya se abrió
- [x] «Copiar CSV» en ciclos y órdenes con `@capacitor/clipboard`, con el aviso de los decimales
- [x] `pnpm --filter app build` sin avisos; lint limpio
- [ ] CA-3, CA-4 y CA-5 a mano — bot simulado con dos ciclos y un cambio de configuración

## Cierre

- [x] Criterios de aceptación repasados — CA-1, CA-2, CA-6 cumplidos; **CA-3, CA-4 y CA-5 pendientes de la comprobación manual**
- [ ] Índice de `specs/README.md` a `hecho` — cuando CA-3..CA-5 estén comprobados
- [x] Memoria de usuario actualizada
