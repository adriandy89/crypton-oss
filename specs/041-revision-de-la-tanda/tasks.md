# 041 — Tareas

## Fase 0 — Línea base

- [x] Rama desde `main` con 037-040 mergeados (`21da121`)
- [x] `pnpm test` verde: 6.146 tests

## Fase 1 — Los tests que fallan

- [x] F-01: la estrategia no declara `reusesOrderSlots`
- [x] F-02: primer stop en la entrada, en largo y en corto
- [x] F-03: el nocional no supera capital × apalancamiento, ni el tope de exposición
- [x] F-04: un fill de más de tres horizontes no entra en la media
- [x] Los seis fallan **por el motivo declarado** (verificado con `git stash`)

## Fase 2 — Los arreglos

- [x] Fuera `reusesOrderSlots` de `trend-follow`, con el motivo escrito en el código
- [x] `inicial` anclado en `position.entryPrice`; el seguimiento sigue mandando si va a favor
- [x] `techoNocional()` y la nota cuando recorta
- [x] Ventana de tres horizontes en `resolverMarkout`, con limpieza del pendiente
- [x] El mismo techo en `preview()` (F-05)
- [x] Un test antiguo que codificaba la conducta defectuosa, reescrito con su explicación

## Cierre

- [x] `pnpm test` · `pnpm lint` (0 errores) · `ng build` (0 errores)
- [x] `findings.md` con lo corregido, lo descartado y **lo verificado OK**
- [x] `docs/trend-follow.md`: el techo de nocional y el stop anclado en la entrada
- [x] Índice de `specs/README.md`
- [x] Memoria de usuario
