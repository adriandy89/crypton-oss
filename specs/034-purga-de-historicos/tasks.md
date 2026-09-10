# 034 — Tareas

## Fase 1 — API

- [x] DTOs: `PurgeScope`, `PurgeQueryDto`, `PurgeDto` con el suelo declarado
- [x] `AdminMaintenanceService`: tabla de ámbitos, `estado()`, `contar()`, `purgar()`
- [x] Cerrojo compartido `crypton:lock:retention` y borrado por lotes
- [x] `AdminMaintenanceController` con `@Roles('ADMIN')` y auditoría crítica
- [x] `admin-maintenance.service.spec.ts`
- [x] Bloque en `isolation.e2e-spec.ts`

## Fase 2 — App

- [x] `AdminMaintenanceService` cliente
- [x] Pantalla `/admin/maintenance` con selector, recuento previo y confirmación
- [x] Fila en el índice de administración
- [x] `pnpm --filter app build` y `lint`

## Fase 3 — Cierre

- [x] `docs/administracion.md`: qué se purga, qué no y por qué
- [x] Índice de `specs/README.md`
- [x] `pnpm test` y `pnpm lint`
