# 055 — Plan

## Enfoque

**Base y cierre.** La rama sale de `spec/054-lo-que-cambia-la-ia` (`cbb0f71`), igual que el 054
salió del 053: ninguno de los dos está en `main` todavía. Al terminar, los tres se integran en
`main` con un merge `--no-ff` cada uno, en orden.

**Orden de trabajo.** Cada arreglo empieza por el test que falla, y se hace un commit por arreglo.

**La revisión y el fork.** La revisión que pidió el usuario va después y es el spec 056, sobre esta
misma rama, como el 047 sobre el 046. El port al fork va después de la revisión.

## Ficheros afectados

| Fichero | Cambio |
|---|---|
| `apps/api/src/modules/supervisor/apply.ts` | H-01: la V2 conserva su suelo tras `enforceCouplings`. H-02: `distanciasEnElSentidoPedido` tras el traslado. |
| `apps/api/src/modules/supervisor/apply.spec.ts` | CA-1 y CA-2 |
| `apps/api/src/modules/supervisor/alcance.spec.ts` | La V2 deja de tener la distancia mínima como acoplamiento |
| `apps/api/src/modules/supervisor/canal.ts` (+ spec) | Nuevo, puro: `motivoSinCanal(link)` |
| `apps/api/src/modules/supervisor/supervisor.service.ts` (+ spec) | La barrera del canal (H-03) |
| `apps/api/src/modules/supervisor/supervisor.policy.service.ts` (+ spec) | Encender «propone y espera» con la misma regla; `sinCanalDe(userId)` |
| `apps/api/src/modules/admin/admin-ai.controller.ts` (+ routes spec) | `interruptores.sinCanal` en las tres respuestas |
| `apps/api/src/modules/bots/dtos/index.ts`, `bots.controller.ts`, `bots.service.ts` (+ specs) | H-05: `expectedVersion` y el `code` del 409 |
| `apps/api/src/libs/common/filters/exception.filter.ts` (+ spec nuevo) | G-02 |
| `advisor.spec.ts`, `bots-margin.spec.ts`, `supervisor.service.spec.ts` | Los tres errores de tipos |
| `apps/app/src/app/core/services/admin-bots.service.ts` | `AiSwitches.sinCanal` |
| `apps/app/src/app/core/utils/modo-ia.ts` | `porQueNoActua` con el canal; `sinCanalDe(status)` para el editor, el panel y el asistente |
| `apps/app/src/app/shared/bot/modo-ia-editor.component.ts`, `modo-ia-panel.component.ts`, `features/bots/bot-create.page.ts` | La misma regla del canal |
| `apps/app/src/app/core/services/bots.service.ts` | `updateConfig` con `expectedVersion` |
| `packages/shared/src/borrador.ts` (+ spec) | Nuevo, puro: `edicionesDe` y `recolocarBorrador`, con la misma igualdad que la pantalla |
| `apps/app/src/app/features/bots/bot-detail.page.ts` | H-05 y G-01 |
| `docs/administracion.md`, `docs/comandos-guardas-y-eventos.md` | R-7 |

## Fases

1. Spec, plan, tareas y la fila del índice.
2. G-02, el filtro. Va primero porque H-05 depende de él. Commit `fix(api)`.
3. H-01 y H-02, en `apply.ts`. Commit `fix(api)`.
4. H-03, el canal: API y app. Commit `fix`.
5. H-05 y G-01, el borrador: API y app. Commit `fix`.
6. Los tipos de los tests. Commit `test(api)`.
7. Guías. Commit `docs`.
8. Verificación completa, mutaciones y cierre.

## Verificación

- **Paquetes.** `pnpm build:packages`, `pnpm --filter @crypton/shared test` y los tests del worker
  y del backtest, por la regla de la casa para `shared`.
- **API y worker.**
  - `pnpm --filter api test`, `pnpm --filter api build` y `tsc --noEmit -p apps/api/tsconfig.json`.
  - `pnpm --filter worker test`.
- **App.** `pnpm --filter app lint` y `pnpm --filter app build`, que es el que mira los presupuestos.
  `bot-detail.page.scss` está en el límite: aquí no se toca.
- **Raíz.** `pnpm test`, `pnpm lint` y `pnpm check:env`.
- **Mutaciones.** Un script en el scratchpad, una por arreglo como mínimo:
  - el filtro sin los campos nuevos;
  - la V2 sin conservar su suelo;
  - las distancias sin el sentido;
  - la barrera del canal quitada, o sin mirar `prefs.ai`, o aplicada también al automático;
  - el DTO que deja pasar `null`;
  - el controlador que no pasa la versión;
  - el 409 sin `code`.
- **Fines de línea.** Edit conserva los de cada fichero; los nuevos van en LF.
