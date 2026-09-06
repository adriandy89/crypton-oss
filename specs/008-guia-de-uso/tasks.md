# 008 — Tareas

## Fase 0 — Línea base

- [x] Rama `spec/008-guia-de-uso` creada desde `main` (`d8f8f20`) limpia
- [x] `pnpm build:packages`
- [x] Baterías: strategy-core 223, worker 268, exchange-core 276, backtest 26, shared 73; lint 0 errores (3 avisos api); `check:env` coherente; typecheck app ok

## Fase A — Revisión de las estrategias

- [x] `coherencia-estrategias.cjs` ejecutado (C1-C8); salida en `informes/revision-estrategias.md` §6
- [x] `informes/revision-estrategias.md` con veredicto y tabla de estado por estrategia

## Fase 1 — Ejemplos

- [x] `verificar-ejemplos.cjs` con los 15 ejemplos: 14 válidos a la primera; el C de la rejilla neutral (20 niveles, ×1,8) inválido → 12 niveles, ×1,5, corregido también en la guía in-app. Salida en el informe §7

## Fase 2 — Transversales que enlazan las guías

- [x] `docs/riesgo-y-liquidacion.md`
- [x] `docs/comandos-guardas-y-eventos.md`

## Fase 3 — Guías por estrategia

- [x] `docs/grid-classic.md`
- [x] `docs/tdca.md`
- [x] `docs/martingale.md`
- [x] `docs/gridmart.md`
- [x] `docs/neutral-grid.md`

## Fase 4 — Resto de transversales e índice

- [x] `docs/venues-y-minimos.md`
- [x] `docs/simulacion-y-backtest.md`
- [x] `docs/buenas-practicas.md`
- [x] `docs/README.md`
- [x] §«Limitaciones conocidas», sección de comunes (H4) y frases corregidas («techo duro», «armado para siempre», «la app avisa») en `market-maker.md` / `market-maker-v2.md`

## Fase 5 — Textos acompañantes y comparativa

- [x] `README.md`: «seis» → «siete», «once» → «trece» (`REPAIR`, `ADJUST_MARGIN`), árbol con `docs/` y `specs/`, enlaces a `docs/README.md` y `buenas-practicas.md`
- [x] `CLAUDE.md`: regla `grep F-NN docs/` en SDD; «Dónde leer más» → `docs/README.md`
- [x] `field-labels.ts` (6 textos) y guías in-app (`common-options`, `ladder-options`, `neutral-grid`, `gridmart`, `martingale`, `market-maker`, `market-maker-v2`): solo cadenas; `pnpm --filter app build` y `lint` en verde
- [x] Comparativa con la documentación pública de una plataforma competidora: informe interno del repositorio privado, no se publica en esta edición

## Cierre

- [x] CA-1: `verificar-ejemplos.cjs` → `0 ejemplo(s) en rojo`
- [x] CA-2: `comprobar-parametros.cjs` → las siete guías OK (18/20/18/18/27/38/48 claves)
- [x] CA-3: `comprobar-enlaces.cjs` → 170 enlaces relativos, 0 rotos
- [x] CA-4: los 46 `F-NN` citados en `docs/` existen en `findings.md` (35 con ficha `###`; F-55 a F-67 en la tabla resumen y en `informes/A-market-makers.md`)
- [x] CA-5: `pnpm --filter app build` y `lint` en verde
- [ ] CA-6 (manual, usuario): teclear las configuraciones A/B/C en el asistente y comparar con los bloques «Peor caso» (salvo F-88 y F-14)
- [x] Al cerrar 009 y 010: borrar o reescribir los bloques «Limitación conocida» de los F-NN corregidos (`grep -rn "F-NN" docs/`)
- [x] Índice de `specs/README.md` actualizado (008 en curso)
- [x] `CLAUDE.md` actualizado
- [x] Memoria de usuario actualizada (al cerrar la tanda 008-010)
