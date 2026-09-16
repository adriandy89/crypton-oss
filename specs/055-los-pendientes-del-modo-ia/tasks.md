# 055 — Tareas

## Fase 1 — Spec — `1a0500e`

- [x] Rama `spec/055-los-pendientes-del-modo-ia` desde `spec/054-lo-que-cambia-la-ia` (`cbb0f71`)
- [x] Hallazgos nuevos al diseñar H-05:
  - G-01, la pantalla cree editado un borrador que no se ha tocado;
  - G-02, el filtro de errores. Se confirmó con un test temporal del filtro: la confirmación WARM,
    los `issues` y el 409 llegaban como texto suelto.
- [x] Spec, plan y tareas; fila del índice. `borrador.ts` va en `shared` porque la app no tiene
      tests.

## Fase 2 — G-02, el filtro — `874dc36`

- [x] `exception.filter.spec.ts`: 3 de 8 en rojo con el filtro anterior (WARM, `issues` y
      `coldFields`), y el arreglo con `CAMPOS_DEL_CONTRATO`

## Fase 3 — H-01 y H-02 — `163f138`

- [x] CA-1 y CA-2 en rojo con el código anterior (4 de 6), y el arreglo:
  - `conElSueloDeLaV2` tras `enforceCouplings`;
  - `distanciasEnElSentidoPedido` tras el traslado.
- [x] El test de la V1 corregido: en calma el objetivo del generador está en el suelo por coste y
      estrechar no mueve nada. Se usa un par que se mueve.
- [x] `alcance.spec.ts`: la V2 deja de tener la distancia mínima como acoplamiento, y el test vigila
      el arreglo

## Fase 4 — H-03, el canal — `a2012eb`

- [x] `canal.ts` puro, con la regla del notificador: chat verificado y `prefs.ai`
- [x] Barrera del servicio antes del turno, solo si el modo efectivo propone. Si no se puede leer
      el vínculo, no se gasta. Tests en rojo antes (6).
- [x] La política usa la misma regla, y `sinCanalDe`. Tests en rojo antes (2).
- [x] `interruptores.sinCanal` en las dos lecturas del Modo IA, con el test de rutas
- [x] App:
  - la pastilla gris con el motivo;
  - el editor, el panel y el asistente con `sinCanalDe`;
  - la fila «Modo IA» en la pantalla de Telegram, solo para administradores.

## Fase 5 — H-05 y G-01, el borrador — `161dffd`

- [x] `shared/borrador.ts`: `edicionesDe` y `recolocarBorrador`, con 9 tests
- [x] API: `expectedVersion` en el DTO, que da 400 con `null`; el controlador lo pasa; los dos 409
      llevan `code`. Tests en rojo antes (5).
- [x] App:
  - lo editado se mide contra `configBase`;
  - con otra versión debajo, el borrador se recoloca en el acto y se avisa;
  - se guarda con `expectedVersion`;
  - un 409 `STALE_VERSION` relee, recoloca y lo dice.
- [x] **Desviación del plan, a mejor:** en vez de preguntar al guardar, el borrador se recoloca en
      cuanto llega la versión nueva, y el formulario enseña lo que hay de verdad. El diálogo
      «guardar igualmente» del 053, que era deshacer el ajuste, desaparece.

## Fase 6 — Tipos — `1971406`

- [x] Los tres errores de antes del 053, más uno del propio 054 (`alcance.spec.ts`, rasgos con
      literales distintos). `tsc --noEmit -p apps/api/tsconfig.json`: limpio.

## Fase 7 — Guías — `4c6b8a4`

- [x] `docs/administracion.md`:
  - fuera las dos limitaciones del 054;
  - el canal, el borrador recolocado, el sentido del diferencial y el suelo de la V2;
  - seis filtros en vez de cinco.
- [x] `docs/comandos-guardas-y-eventos.md`: `AI_SUGGESTION` sin canal

## Fase 8 — Verificación y cierre

- [x] `pnpm test`: **7193 tests**, 44 más que el 054.
  - API: 49 suites y 5777 tests.
  - `shared`: 106.
  - worker 371, exchange-core 399, strategy-core 509 y backtest 31.
- [x] `pnpm lint`: 0 errores, con los 3 avisos previos. `ng lint` limpio y `check:env` coherente.
      `nest build`, el build del worker y `ng build`, sin avisos. `tsc` de la API, limpio.
- [x] Mutaciones: **26 de 26 caen** (`mutaciones-055.cjs` en el scratchpad).
  - Filtro: 4.
  - H-01: 3.
  - H-02: 3.
  - H-03: 7.
  - H-05: 5.
  - G-01: 4.
- [x] Criterios de aceptación:
  - CA-1 a CA-7: tests, builds, lint y mutaciones. La app no tiene tests: su parte se verifica con
    `ng build` y `ng lint`, y la regla del borrador vive en `shared` con los suyos.
  - **CA-8 queda para la comprobación manual del usuario.**
- [x] Revisión (spec 056) y sus arreglos: 20 hallazgos, ninguno Crítico, corregidos en esta rama
      salvo dos descartados con su razón (`specs/056-revision-053-055/findings.md`). Uno toca a
      este spec: su tabla de riesgos decía que la app nueva funcionaba contra una API anterior, y
      es falso. **Se despliega primero la API.**
- [x] Índice y memoria
