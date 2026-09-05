# 007 — Tareas

Una casilla por tarea, agrupadas por fase. Se marcan al terminar, con una nota corta si hubo
sorpresas. Nada se da por hecho sin la verificación de su fase.

## Fase 0 — Línea base

- [x] Rama `spec/007-panel-operativo` creada desde `95b46c7`
- [x] Tests por paquete (`shared` 73), lint y build de la app limpios

## Fase 1 — Aritmética

- [x] `packages/shared/src/activity.ts` + spec (3 tests): `resumenPorAccion`, `fallosDe`

## Fase 2 — Pantalla

- [x] Modelos y `ActivityService` (los tipos viven junto al servicio: son de esta pantalla)
- [x] `activity.page.ts`: ventana, resumen por acción como barra apilada, filtros, lista paginada con «Cargar más», fila desplegable con `meta` e `ip`
- [x] 403 dicho con aviso; vacío dicho con la posibilidad de `AUDIT_LOG_ENABLE` apagado
- [x] Ruta `admin/activity` (mismos guards que Backtest) y enlace en Cuenta con el icono `pulse-outline`
- [x] `pnpm --filter app build` sin avisos; lint limpio
- [ ] CA-3 a mano con una cuenta ADMIN y `AUDIT_LOG_ENABLE=true`

## Cierre

- [x] Criterios de aceptación repasados — CA-1, CA-2 (por construcción: mismo guard que Backtest), CA-4 cumplidos; **CA-3 pendiente de la comprobación manual**
- [ ] Índice de `specs/README.md` a `hecho` — cuando CA-3 esté comprobado
- [x] Memoria de usuario actualizada
