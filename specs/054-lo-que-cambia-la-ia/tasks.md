# 054 — Tareas

## Fase 0 — Línea base y spec

- [x] Rama `spec/054-lo-que-cambia-la-ia` desde `spec/053-modo-ia-en-la-app` (`e2924ff`). Al cerrar
      el 053 estaba verificada: API con 44 suites y 5711 tests, 7113 en total, lint con 0 errores.
- [x] Exploración del alcance con tests temporales en el scratchpad:
  - 374 640 decisiones, 241 717 propuestas;
  - el diferencial efectivo de la V2, sobre 16 050 propuestas;
  - el suelo del dueño en la V2.
- [x] Spec, plan y tareas; fila del índice — `7a0169d`

## Fase 1 — API, avisos — `d3742ac`

- [x] `mensajes.ts`: catálogo, líneas, texto, cotas
- [x] `mensajes.spec.ts`: formato (CA-3) y sincronía con la app (CA-4)
- [x] `supervisor.service.ts`:
  - `AI_SUGGESTION` y `AI_APPLIED`, más la aprobación;
  - `aplicar` recibe el texto;
  - `rehacer` devuelve también el descriptor efectivo y los desplazamientos.
- [x] `supervisor.service.spec.ts`: CA-1 y CA-2.
  - El de la moneda base usa un bot en «cantidad de moneda».
  - El de la aprobación guarda al proponer un diff falso («999») para comprobar que el aviso lleva
    el recalculado.
- [x] `nest build` y lint de la API.
  - **Encontrado de paso:** `tsc` sobre los tests de la API da tres errores de tipos que ya estaban
    en `e2924ff` (`advisor.spec.ts`, `bots-margin.spec.ts` y `supervisor.service.spec.ts`).
  - Ni jest ni `nest build` los ven. No se corrigen aquí.

## Fase 2 — API, alcance — `151594b`

- [x] `alcance.spec.ts` (CA-6).
  - Cinco escenarios: 5000, 300 con un tope de usuario, dos de 60 y un mercado violento.
  - Tarda unos 12 s; `apply.spec.ts` tarda 20.
- [x] **Sorpresa del test:** con poco capital, el apalancamiento decide cuántas capas caben y, con
      ellas, la separación mínima entre capas.
  - La exploración lo había contado como reparación, porque su capital más bajo, 40, no deja más
    de una capa.
  - La tabla, el spec y la guía lo recogen.
- [x] Endurecido: fuera de la fila de su perilla solo se acepta una reparación que el generador no
      haya movido. Sin eso, quitar `leverage` de la fila del apalancamiento pasaba, porque también es
      acoplamiento.

## Fase 3 — Worker — `949ae5f`

- [x] `MAX_TEXTO`, `recortar` y `trocear` en `telegram-client.ts`. Se aplican al lote y a la
      sugerencia.
- [x] Tests (CA-5): el lote de doce, la entidad, el emoji, la etiqueta abierta y a medias, y el
      límite exacto.

## Fase 4 — App — `359e42f`

- [x] `bd-msg` en la bitácora y `pre-line` en la cronología, los dos en `global.scss` (CA-7).
- [x] `ng build` sin avisos.

## Fase 5 — Guías — `d9647b6`

- [x] `docs/administracion.md`:
  - los modos con la lista de valores;
  - la tabla con los nombres del formulario;
  - las reparaciones y lo que nunca toca;
  - los bloques «Limitación conocida» de H-01 y H-02;
  - cómo es un aviso.
- [x] `docs/comandos-guardas-y-eventos.md`: el contenido de `AI_SUGGESTION` y `AI_APPLIED`, con un
      ejemplo.
- [x] `allowShort` fuera de las listas: el generador lo emite, pero la tendencia no lo declara y la
      fusión no lo escribe.

## Fase 6 — Verificación y cierre

- [x] `pnpm test`: **7149 tests** en verde, 36 más que el 053.
  - API: 46 suites y 5742 tests.
  - Worker: 371.
  - exchange-core 399, strategy-core 509, shared 97 y backtest 31.
- [x] `pnpm lint`: 0 errores, con los 3 avisos previos de la API. `ng lint` limpio y `pnpm check:env`
      coherente. `nest build`, el build del worker y `ng build`, sin avisos.
- [x] Mutaciones: **30 de 30 caen** (`mutaciones-054.cjs` en el scratchpad).
  - **Avisos:** nombre, valor de antes, unidad, `x` pegada, `s`, unidad del nombre, `%` implícito,
    corte a diez líneas, motivo en una línea y desplazamientos corruptos.
  - **Catálogo:** un nombre que difiere de la app, y un campo del alcance sin nombre.
  - **Servicio:** descriptor crudo, `AI_APPLIED` antiguo, aprobación sin «con tu aprobación» y
    aprobación con los valores guardados al proponer.
  - **Alcance:** un campo quitado, `leverage` quitado de su fila, un acoplamiento quitado, un campo
    prometido que no se alcanza y el generador moviendo un campo nuevo.
  - **Notificador:** el lote en un mensaje, la línea sin recortar, `trocear` sin partir y con `>=`,
    y `recortar` partiendo una entidad o medio emoji, dejando una etiqueta abierta o a medio
    escribir, o pasándose del máximo.
- [x] Criterios de aceptación:
  - CA-1 a CA-8: tests, builds, lint y mutaciones.
  - **CA-9 queda para la comprobación manual del usuario.**
- [x] Índice de `specs/README.md` en `hecho`, y memoria
