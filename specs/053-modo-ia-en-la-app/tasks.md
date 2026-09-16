# 053 — Tareas

## Fase 0 — Línea base

- [x] Rama `spec/053-modo-ia-en-la-app` desde `main` limpia (`978f2f1`)
- [x] `pnpm build:packages`: verde
- [x] API: 41 suites, **5650 tests** en verde
- [x] `pnpm lint`: 0 errores (los 3 avisos previos de la API)
- [x] `pnpm check:env`: coherente
- [x] Spec, plan y tareas; fila del índice — `674dc5f`

## Fase 1 — API

- [x] H-02: `supervisor.scheduler.spec.ts` **en rojo por el motivo declarado** (revisaba el bot de
      un USER y el de una cuenta deshabilitada), arreglo y en verde — `ad15809`
- [x] `DUENO_CON_MODO_IA`, una sola constante para el barrido y el disparo por eventos
- [x] H-01: `AI_MODE` escrito y publicado sin entrega forzada; su fallo no tumba el cambio —
      `b2fdc20`
- [x] H-04: `trigger` y `allowWarm` validan si vienen, `null` incluido; `reviewEveryMinutes`
      declara su `null`; `mode` obligatorio en Swagger. El test del DTO **fallaba con el cuerpo
      antiguo** en los dos casos de `null` — `b2fdc20`
- [x] `interruptores()`, `encendidosDe()`, `estrategias()`, `cubierta` — `926dbe8`
- [x] Controlador con prefijo `admin` y `GET ai`; la bitácora del `PUT` guarda también las opciones
- [x] Test de rutas con supertest: los dos controladores montados en el orden del módulo
- [x] e2e: la superficie gana las tres rutas del Modo IA (faltaban las dos del 046) y la frontera
      del resumen
- [x] `nest build` y lint de la API: verdes; API **44 suites, 5711 tests**

## Fase 2 — App: datos — `f136388`

- [x] Tipos, etiquetas y `aiOverview()` en `admin-bots.service.ts`
- [x] `core/utils/modo-ia.ts`
- [x] `core/services/modo-ia.service.ts`, con número de secuencia y mapa inmutable
- [x] `shared/bot/modo-ia-acciones.service.ts` y `shared/bot/motivo.ts`; `AdminActionsService`
      sin `modoIa`. Comprobado en el código de Ionic 8.8 que el cierre de la alerta trae
      `{ values: { reason } }` con el rol del botón

## Fase 3 — App: componentes — `f136388`

- [x] `app-modo-ia-editor`
- [x] `app-modo-ia-panel`, con el borrador en un `linkedSignal` que conserva lo que se edita
- [x] La ficha de la consola usa el panel, con estado de error y `guardandoIa` que cubre el `PUT`

## Fase 4 — App: pantallas — `a70d618`

- [x] Lista: pastilla y refresco
- [x] Detalle: pastilla en la cabecera, panel arriba de Ajustes, marca «IA» en el historial
- [x] H-05, solo aviso: el aviso encima de la barra de guardar y, además, **una confirmación al
      guardar**. La barra es `sticky` y un aviso en el flujo podía no verse al pulsar
- [x] Consola: pastilla y leyenda (solo si hay algún bot propio encendido)
- [x] Asistente: sección del paso 4, bloqueo y encendido tras crear; un solo aviso si falla
- [x] Etiquetas `AI_*`
- [x] **Desviación del plan:** el JSDoc huérfano de `bot-detail.page.ts` (encima de `publicado`)
      no se toca. Está pegado a la línea de planes, que el fork no tiene, y reescribirlo
      aseguraba un conflicto al portar. `esAdmin` lleva su propio comentario

## Fase 5 — Tarjetas — `e1281b5`

- [x] Plantilla con `.cuerpo` y `.pie`; `sin-pie` en la tarjeta sin nota
- [x] SCSS con `subgrid` y respaldo, comentarios con `//`
- [x] Arnés (Chrome sin interfaz; Edge no escribe el `--dump-dom` por la salida estándar en
      Windows) a 1100 px y a 390 px dentro de un iframe (la ventana no baja de 500), con y sin
      `subgrid`, contra la hoja de antes
- [x] **Sorpresa del arnés:** con un marcador de pie vacío, una fila con una sola nota y la otra
      tarjeta más alta crecía 43 px (el cuerpo alto de una más el pie de la otra). Se cambió a
      que el cuerpo de la tarjeta sin nota ocupe las dos filas: la fila queda como la más alta de
      antes y el marcador deja de hacer falta

## Fase 6 — Documentación y verificación

- [x] `docs/administracion.md`, `docs/comandos-guardas-y-eventos.md`, `docs/README.md` —
      `6bbc31f`
- [x] Verificación completa:
  - `pnpm test`: **7113 tests** en verde. API 44 suites y 5711 tests (61 más que la línea base),
    worker 366, exchange-core 399, strategy-core 509, shared 97 y backtest 31.
  - `pnpm lint`: 0 errores, con los 3 avisos previos de la API. `ng lint`: todo limpio.
  - `pnpm check:env` coherente, y `nest build` y `ng build` sin un solo aviso de presupuesto.
- [x] Mutaciones: **15 de 15 caen** (`mutaciones-053.cjs` en el scratchpad). Cubren cada
      salvaguarda de H-01, H-02 y H-04, el filtro, el `select` y los modos del resumen, la
      cobertura, la clave del modelo en los interruptores, el prefijo de la ruta, y los
      interruptores y el motivo del controlador.
- [x] e2e con la infraestructura local, 107 de 108:
  - Con permiso del usuario, antes se aplicaron a la base de desarrollo las tres migraciones del
    046 que nunca se le aplicaron. Son aditivas y ya estaban en producción.
  - El único rojo es el conocido 033/F-01.
  - Los casos nuevos pasan: 403 y 401 en las tres rutas del Modo IA, y el resumen no enseña el
    bot de otro.
  - Los contenedores se pararon después con `stop`, como estaban.
- [x] Criterios de aceptación:
  - CA-1: arnés.
  - CA-3 a CA-9: tests, e2e, builds y mutaciones.
  - **CA-2 y CA-10 quedan para la comprobación manual del usuario.**
- [x] Índice de `specs/README.md` a `hecho`
- [x] Memoria
