# 056 — Tareas

## Fase 0 — Revisión — `0711649`

- [x] Rama: la del 055, `spec/055-los-pendientes-del-modo-ia`. Ninguno de los tres specs está en
      `main`, así que lo que se confirme se corrige dentro, como en el 047 y el 052.
- [x] Línea base: la verificación completa del 055 (`tasks.md` del 055, fase 8), sobre `4c6b8a4`.
- [x] Dos revisores independientes, en solo lectura, sobre `978f2f1..4c6b8a4`: uno el backend, otro
      la app.
- [x] `findings.md`: 20 hallazgos, ninguno Crítico. Uno Alto (A-1), siete Medios y doce Bajos.
      Todos se corrigen dentro salvo dos, descartados con su razón: R-6(a) y A-10(c).

## Fase 1 — Backend

- [x] R-1 y R-6(b), el barrido y el canal — `2c1cdf4`
- [x] R-3, la versión en el `where` y la fila antes que la revisión — `e672795`
- [x] R-4 y la parte de R-3 del supervisor: el dueño al canjear, y el mensaje de un error interno
      fuera de Telegram — `6df0fed`
- [x] R-5 y R-7, la fila por chat, la pausa y los sustitutos sueltos — `4499312`
- [x] R-8, el comentario del filtro — `dd4233e`
- [x] Lint, `tsc`, `nest build` y el build del worker, en verde antes de cada commit

## Fase 2 — `shared`, `strategy-core` y la app

- [x] A-1, una sola igualdad para la pantalla y `diffConfig` — `252bd89`
  - Los tests nuevos caen con la regla de texto anterior: 2 de 15.
  - El test de contrato de `strategy-core` compara lo que deciden las dos partes.
- [x] A-1 (la parte de la app), A-2 y A-4 a A-12 — `a899709`
- [x] `ng lint` y `ng build` limpios, sin avisos de presupuesto. El CSS nuevo va en `global.scss`:
      las dos hojas del detalle y del asistente siguen en su límite.

## Fase 3 — Documentación

- [x] R-2/A-3: la tabla de riesgos del 055, corregida. Se despliega **primero la API**.
- [x] `docs/administracion.md`:
  - la pastilla y los lectores de pantalla;
  - un bot ya manual puede cambiar sus opciones sin canal;
  - el aviso en la barra de guardar, con los choques;
  - qué cuenta como editado.
- [x] Estados de los specs 053, 054 y 055, y sus filas del índice

## Fase 4 — Verificación

- [x] `pnpm build:packages`: verde.
- [x] `pnpm test`: **7216 tests**, 23 más que el 055.
  - API: 49 suites y 5790 tests.
  - `shared`: 112.
  - worker 374, exchange-core 399, strategy-core 510 y backtest 31.
- [x] `pnpm lint`: 0 errores, con los 3 avisos previos. `check:env`: coherente. `nest build`, el
      build del worker y `ng build`: sin avisos. `tsc` de la API: limpio.
- [x] Mutaciones: **19 de 19 caen**, todas compilando (`mutaciones-056.cjs` en el scratchpad).
  - R-1: 5.
  - R-6: 2.
  - R-3: 3.
  - R-4: 2.
  - R-5: 2.
  - R-7: 2.
  - A-1: 2, una de ellas el contrato de `strategy-core`.
  - A-2: 1.
  - Los arreglos de la app sin regla en `shared` (A-4 a A-12) no tienen runner de tests: se
    verifican con `ng build` y `ng lint`.
- [x] Criterios de aceptación:
  - CA-1: cada hallazgo tiene estado en `findings.md`.
  - CA-2 y CA-3: la verificación y las mutaciones de arriba.
  - **CA-4 queda para la comprobación manual del usuario.**

## Pendiente del usuario

- [ ] **CA-4**: la comprobación manual del 055 (CA-8), y ver el aviso de la recolocación dentro de la
      barra de guardar.
