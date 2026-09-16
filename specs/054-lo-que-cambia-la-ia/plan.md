# 054 — Plan

## Enfoque

**La rama.** Sale de `spec/053-modo-ia-en-la-app` (`e2924ff`), no de `main`:

- el 053 no está mergeado, y este spec toca los mismos ficheros del supervisor;
- mergear el 053 lo decide el usuario;
- si se mergea antes, esta rama se rebasa sin conflicto esperado, porque el 053 no toca lo que se
  cambia aquí.

**La exploración.** Se hizo con tests temporales, que viven en el scratchpad y no en el repo. Lo que
queda en el repo es su versión reducida, `alcance.spec.ts`, con la tabla escrita a mano.

- **Por qué la tabla es a mano.** Así el test no puede darle la razón al código por construcción.
- **Por qué la matriz es reducida.** La completa tarda 115 s; esta, unos segundos.

**Los nombres.** El catálogo se copia en la API solo para los campos del alcance, no entero:

- lo que la IA no puede tocar nunca llega a un aviso suyo;
- el test de alcance obliga a añadir el nombre de un campo nuevo el día que entre;
- el test de sincronía obliga a que diga lo mismo que la app.

Mover el catálogo a `packages/shared` sería más limpio, pero toca un paquete compartido, la app
entera y el fork.

**El notificador.** Se arregla en el worker y no solo acotando los avisos en la API: el motor ya
publica mensajes sin recortar, como los errores del venue. Un lote de doce líneas largas se perdía
entero antes de este spec.

## Ficheros afectados

| Fichero | Cambio |
|---|---|
| `apps/api/src/modules/supervisor/mensajes.ts` | Nuevo, puro: `ETIQUETAS`, `lineasDeCambio`, `textoDeCambio` |
| `apps/api/src/modules/supervisor/mensajes.spec.ts` | Nuevo: formato, cotas y sincronía con la app |
| `apps/api/src/modules/supervisor/alcance.spec.ts` | Nuevo: la tabla del alcance medida sobre mercados reales |
| `apps/api/src/modules/supervisor/supervisor.service.ts` | Los avisos usan `textoDeCambio`; `aplicar` recibe el texto; `rehacer` devuelve también los campos y los desplazamientos |
| `apps/api/src/modules/supervisor/supervisor.service.spec.ts` | CA-1 y CA-2 |
| `apps/worker/src/notifications/notifier.service.ts` | `trocear` y `recortar`; se aplican al lote y a la sugerencia |
| `apps/worker/src/notifications/notifier.service.spec.ts` | CA-5 |
| `apps/app/src/app/features/bots/bot-detail.page.html` | Clase `bd-msg` en el mensaje de la bitácora |
| `apps/app/src/global.scss` | `.bd-msg` y `.bd-tl .det` con `white-space: pre-line` |
| `docs/administracion.md`, `docs/comandos-guardas-y-eventos.md` | R-8 |
| `specs/054-lo-que-cambia-la-ia/*`, `specs/README.md` | El spec y su fila |

## Fases

0. **Línea base y spec.**
   - La rama del 053 cerró verificada en `e2924ff`: API con 44 suites y 5711 tests; 7113 tests en
     total; lint con 0 errores.
   - Commit `docs(specs)`.
1. **API, avisos.** `mensajes.ts` con sus tests, y el servicio con los suyos. Commit `feat(api)`.
2. **API, alcance.** `alcance.spec.ts`. Commit `test(api)`.
3. **Worker.** El notificador y sus tests. Commit `fix(worker)`.
4. **App.** Los saltos de línea. Commit `fix(app)`.
5. **Guías.** Commit `docs`.
6. **Verificación y cierre.**
   - La verificación completa y las mutaciones.
   - `tasks.md`, la fila del índice en `hecho` y la memoria.
   - Commit `docs(specs)`.

## Verificación

- **API**, desde Git Bash:
  - `pnpm --filter api test`;
  - `pnpm --filter api build`, porque jest no ejecuta `tsc`;
  - `pnpm --filter api lint`.
- **Worker**: `pnpm --filter worker test` y `pnpm --filter worker build`.
- **App**: `pnpm --filter app lint` y `pnpm --filter app build`, que es el que mira los presupuestos.
- **Raíz**: `pnpm lint` y `pnpm check:env`.
- **Mutaciones.** Un script en el scratchpad restaura cada fichero. Cada mutación debe hacer caer
  algún test:
  - avisos con la clave en vez del nombre;
  - sin el valor de antes;
  - sin unidad;
  - sin el recorte a diez líneas;
  - el mensaje antiguo en `AI_APPLIED`;
  - la aprobación sin «con tu aprobación»;
  - `trocear` que no parte;
  - `recortar` que parte una entidad;
  - la sugerencia sin recortar;
  - un campo quitado de la tabla del alcance;
  - un acoplamiento quitado;
  - un nombre cambiado en el catálogo.
- **Fines de línea.** Edit conserva los de cada fichero; los ficheros nuevos van en LF, como los del
  053. Nada de `prettier --write` a secas: se usa `lint:fix`.
