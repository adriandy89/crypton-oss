# 007 — Plan

## Enfoque

Solo pantalla. La API ya tiene los dos endpoints con filtros, paginación y guarda de rol; lo que
falta es leerlos. La única aritmética —fundir las filas `(acción, resultado, recuento)` del resumen
en una fila por acción con sus tres recuentos— va a `shared` con test, como manda el precedente de
`candle-paging.ts`.

Alternativas descartadas:

- **Un endpoint nuevo de resumen «ya fundido»**: el que hay devuelve exactamente lo que hace falta
  en 50 filas como mucho; fundirlas es aritmética de pantalla.
- **Gráficas de la bitácora**: no hay agregación por tiempo en el servidor y montarla sería un spec
  de API, no de pantalla.
- **Pintar la `ip` en la lista**: dato personal; se deja al desplegable.

## Ficheros afectados

| Fichero | Qué cambia | Tests que lo cubren |
|---|---|---|
| `packages/shared/src/activity.ts`, `activity.spec.ts` | **Nuevo.** `resumenPorAccion(filas)` | el spec |
| `packages/shared/src/index.ts` | lo exporta | typecheck |
| `apps/app/src/app/core/models/index.ts` | `ActivityEntry`, `ActivityPage`, `ActivitySummaryRow` | typecheck |
| `apps/app/src/app/core/services/activity.service.ts`, `index.ts` | **Nuevo.** `list(query, page)`, `summary(hours)` | typecheck |
| `apps/app/src/app/features/admin/activity.page.ts` | **Nuevo.** La pantalla, con plantilla y estilos en línea | build (presupuesto) |
| `apps/app/src/app/app.routes.ts` | ruta `admin/activity` | build |
| `apps/app/src/app/features/account/account.page.ts` | enlace «Actividad» bajo Administración | build |

## Fases

| Fase | Qué | Criterio de salida |
|---|---|---|
| 0 | Rama, línea base | — |
| 1 | `resumenPorAccion` con spec | CA-1 |
| 2 | Servicio, modelos, pantalla, ruta, enlace | CA-2, CA-4; CA-3 a mano |
| 3 | Cierre | Índice, memoria |

## Verificación

```bash
pnpm --filter @crypton/shared build && pnpm --filter @crypton/shared test
pnpm --filter app build && pnpm --filter app lint
```

A mano, con una cuenta `ADMIN` y `AUDIT_LOG_ENABLE=true` en la API: entrar en Cuenta →
Administración → Actividad; cambiar la ventana; encender «solo fallos»; cargar más de una página;
desplegar una fila y ver `meta` e `ip`. Con una cuenta sin rol, comprobar que la ruta redirige.
