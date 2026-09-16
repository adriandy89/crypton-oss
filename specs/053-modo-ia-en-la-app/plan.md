# 053 — Plan

## Enfoque

Seis pasos con su commit, en orden de dependencia: primero la API —empezando por H-02 con su test
en rojo—, luego los datos y componentes de la app, luego las pantallas, luego las tarjetas y al
final la documentación. La app nunca decide nada que no decida el servidor: todo lo que pinta
(pastilla, cobertura, interruptores) sale de la API, y lo que la app se ahorra de preguntar solo es
comodidad.

Alternativas descartadas:

- **Poner el Modo IA en `GET /bots`.** Tocaría `BotSummary` —el tipo compartido que consumen todas
  las pantallas— y la consulta más leída del sistema para todos los usuarios, por un dato que solo
  existe para administradores. Y el módulo de bots dejaría de ignorar el Modo IA, que es una acción
  de administración.
- **`GET /admin/bots/ai`.** `GET /admin/bots/:id` se registra antes y su `@IsUUID` respondería 400.
- **Solo `margin-top: auto` en el pie.** Casa los bordes inferiores, no los superiores: una nota de
  dos líneas junto a una de una deja 18 px de diferencia.
- **Una pastilla en la consola para los bots de todos.** Obligaría a leer la política de bots
  ajenos, que el spec 046 prohibió a propósito.

## Ficheros afectados

| Fichero | Qué cambia | Tests que lo cubren |
|---|---|---|
| `apps/api/src/modules/supervisor/supervisor.scheduler.ts` | H-02: filtro del dueño en `onEvento` | `supervisor.scheduler.spec.ts` (nuevo) |
| `apps/api/src/modules/supervisor/supervisor.policy.service.ts` | `DUENO_CON_MODO_IA`, H-01, `encendidosDe`, `cubierta` | `supervisor.policy.spec.ts` |
| `apps/api/src/modules/supervisor/supervisor.service.ts` | `interruptores()` | `supervisor.service.spec.ts` |
| `apps/api/src/modules/supervisor/dtos/index.ts` | H-04 | `supervisor.dtos.spec.ts` (nuevo) |
| `apps/api/src/modules/admin/admin-ai.controller.ts` | prefijo `admin`, `GET ai`, respuestas | `admin-ai.routes.spec.ts` (nuevo), `admin-guards.spec.ts` |
| `apps/api/test/isolation.e2e-spec.ts` | superficie y frontera del listado | e2e |
| `apps/app/src/app/core/services/admin-bots.service.ts` | tipos, etiquetas, `aiOverview()` | `ng build` |
| `apps/app/src/app/core/utils/modo-ia.ts` (nuevo) | pastilla y frase, puras | `ng build` |
| `apps/app/src/app/core/services/modo-ia.service.ts` (nuevo) | estado compartido | `ng build` |
| `apps/app/src/app/shared/bot/modo-ia-*.ts` (nuevos) | acciones, editor y panel | `ng build` |
| `apps/app/src/app/features/admin/*` | ficha y lista de la consola | `ng build` |
| `apps/app/src/app/features/bots/*` | lista, detalle y asistente | `ng build`, arnés |
| `apps/app/src/app/core/utils/labels.ts` | eventos `AI_*` | `ng build` |

## Fases

| Fase | Qué | Criterio de salida |
|---|---|---|
| 0 | Línea base y spec | build, 5650 tests, lint y `check:env` anotados |
| 1 | API: H-02, H-01, H-04 y el resumen | tests nuevos en verde, H-02 visto en rojo antes; `nest build` |
| 2 | App: datos y acciones | `ng build` y `ng lint` |
| 3 | App: editor y panel; la ficha de la consola los usa | `ng build` y `ng lint` |
| 4 | App: lista, detalle, consola, asistente y etiquetas | `ng build` y `ng lint` |
| 5 | Tarjetas alineadas | arnés a 1100 y 390 px; `ng build` sin aviso de presupuesto |
| 6 | Documentación, índice y memoria | estado `hecho` |

## La pieza delicada: el pie de las tarjetas

Desde 900 px la lista es una rejilla de dos columnas. Cada tarjeta ocupa **dos filas** de esa
rejilla (`grid-row: span 2`) y las toma prestadas (`grid-template-rows: subgrid`): la primera para
el cuerpo y la segunda para el pie. Como las dos tarjetas de una fila comparten esas dos pistas, el
pie más alto fija la altura del pie de las dos, y los dos recuadros empiezan y terminan a la vez.

Tres detalles que no se pueden perder:

- **La tarjeta tiene exactamente dos hijos.** Un subgrid no crea filas implícitas: un tercer hijo
  se montaría encima de otro.
- **El pie existe siempre**, vacío si no hay nota. El margen, el borde y el relleno de la tarjeta
  se aplican como margen de los hijos que tocan cada borde; sin nadie en la pista de abajo, el
  relleno inferior no contaría.
- **El hueco entre filas pasa a ser margen de la tarjeta.** Con hueco en la rejilla, la separación
  entre cuerpo y pie de una misma tarjeta sería ese hueco y una fila sin notas crecería. El
  espacio entre cuerpo y pie lo pone el propio pie.

Si el arnés demuestra que el navegador no cuenta el margen del subgrid, la variante B deja el hueco
en la rejilla y anula el del subgrid, apoyándose en la regla que reparte la diferencia como margen.

## Verificación

- API, desde Git Bash: `pnpm --filter api exec jest --silent`, `pnpm --filter api build`,
  `pnpm --filter api lint`.
- e2e: `pnpm infra:up`, `pnpm test:isolation` (rojo conocido: 033/F-01), `pnpm infra:down`.
- App: `pnpm --filter app lint` y `pnpm --filter app build`.
- Raíz: `pnpm lint` y `pnpm check:env`.
- Formateo con `lint:fix` de cada paquete, nunca `prettier --write` a secas (convertiría CRLF en LF).
- Mutaciones con un script en el scratchpad: una por salvaguarda nueva, cada una tiene que tumbar
  su test.
- Arnés del CSS en el scratchpad: la hoja real compilada con `sass`, cinco filas de casos, medidas
  con `getBoundingClientRect` y Edge sin interfaz a 1100 y 390 px, con capturas.
