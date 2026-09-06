# 001 — Tareas

## Fase 0 — Línea base

- [x] Rama `spec/001-revision-integral` creada desde `main` limpia (`63e676f`)
- [x] `pnpm build:packages` — exit 0
- [x] `pnpm test` (sin e2e) — 4948 tests en verde; anotado en `findings.md`
- [x] `pnpm lint` — 0 errores, 3 avisos en `apps/api`
- [x] `pnpm check:env` — coherente
- [x] Versiones de node, pnpm y SDKs anotadas
- [x] Commit del andamiaje: `CLAUDE.md`, `specs/README.md`, `specs/_template/`, `specs/001-revision-integral/`

## Fase 1 — Documentación oficial

- [x] Hyperliquid: tick y lote, campos de orden, tif, grouping, builder, cancel/modify, leverage y margen, límites de caudal, WS, mensajes de error — `informes/C-hyperliquid.md` y `findings.md` § Referencias
- [x] SDK `@nktkas/hyperliquid`: `order()`, `formatPrice`, `formatSize`, `cancelByCloid`, `modify`, `orderStatus`, transporte WS — `informes/C-hyperliquid.md`
- [x] Lighter: `orderBookDetails`, `create_order`, `client_order_index`, nonce, auth token, límites REST y WS, `Trade.type` — `informes/C-lighter.md` (doc cruda en el scratchpad)
- [x] SDK `zklighter-sdk`: `process_api_key_and_nonce`, `nonce_manager`, `create_order`, `create_market_order`, `cancel_order`, `cancel_all_orders`, `update_leverage`, `update_margin` — `informes/C-lighter.md`
- [x] Aster V3: firma, `POST /fapi/v3/order` y enums, filtros, pesos y `rateLimits`, listenKey, WS, hosts de testnet — `informes/C-aster.md` (doc cruda en el scratchpad); ventana de nonce de 10 s y listenKey de 60 min corregidos en `findings.md` § Referencias
- [x] Tabla de referencias completa en `findings.md`

## Fase 1b — Sondas públicas

- [x] Lista blanca de hosts: los seis de `endpoints.ts`, sin credenciales en el entorno
- [x] Sonda Hyperliquid ejecutada (mainnet y testnet)
- [x] Sonda Lighter ejecutada (mainnet y testnet)
- [x] Sonda Aster ejecutada (mainnet y testnet)
- [x] `compare.md` escrito; diferencias resumidas en `findings.md` (F-04, F-10, F-22, F-23, F-24)

## Fase 2 — Línea C: APIs

- [x] Matriz Hyperliquid (C-1…C-9) — informe en `scratchpad/review/C-hyperliquid.md`; hallazgos F-04, F-25…F-29
- [x] Matriz Lighter (C-1…C-9) — `informes/C-lighter.md`; hallazgos F-46…F-56 y confirmación de F-01, F-05, F-10, F-16, F-21
- [x] Matriz Aster (C-1…C-9) — `informes/C-aster.md`; F-09 cerrado como verificado OK; hallazgos F-69…F-79 y F-68 (transversal, Crítica)
- [x] `dry-run.ts`: paridad de ids, comisiones y liquidación con el venue envuelto — OK salvo F-45 (no modela órdenes condicionales: el stop se ejecuta en el acto)

## Fase 3 — Línea A: estrategias

- [x] Grid Classic (A-1…A-14) — `informes/A-grids.md`; F-15 (Crítica, test en rojo), F-03, F-84, F-87, F-88
- [x] Neutral Grid (A-1…A-14) — ídem; F-81, F-84, F-12, F-14
- [x] GridMart (A-1…A-14) — ídem; F-82, F-89, F-92
- [x] Martingale (A-1…A-14) — ídem; F-80, F-85, F-86, F-92
- [x] TDCA (A-1…A-14) — ídem; F-12, F-13, F-14, F-94
- [x] Market Maker v1 (A-1…A-14) — `informes/A-market-makers.md`; F-57…F-64
- [x] Market Maker v2 (A-1…A-14) — ídem
- [x] Piezas comunes A-15…A-18 — `informes/A-grids.md` §6; F-83, F-86, F-91, F-93. A-19…A-22 en `informes/A-market-makers.md` §4-7 (F-64, F-65, F-66)

## Fase 4 — Línea B: motor

- [x] B-1…B-11 — `informes/B-motor.md`; hallazgos F-31…F-37 y confirmación de F-02, F-06, F-07, F-08, F-17, F-18
- [x] B-12…B-22 — ídem; F-38…F-41

## Fase 5 — Consolidación

- [x] Hallazgos deduplicados y clasificados con la escala — F-01…F-94 (F-09 cerrado como OK; F-16 absorbido en parte por F-68 y F-47)
- [x] Test que falla escrito para cada Crítica (sin arreglo) — seis tests en rojo hasta la corrección: F-31 y F-32 (`apps/worker`), F-01 y F-46 (`lighter-signer.spec.ts`), F-68 (`write-retry.spec.ts`), F-15 (`strategies.spec.ts`)
- [x] Tabla resumen ordenada por severidad
- [x] Sección «Verificado OK» rellena (motor, Hyperliquid, Lighter, Aster, market makers, grids)
- [x] Specs de seguimiento propuestos — 002…015 en `findings.md`
- [x] **Parada**: lista de Críticas enseñada y aprobada por el usuario — 2026-09-06 («arregla las críticas y todo lo que falte»), tras F-45 corregido en el 004

## Fase 6 — Correcciones críticas

- [x] Una tarea por Crítica aprobada, con el protocolo de la constitución — un commit por corrección, test que fallaba antes y pasa después, suite del paquete y dependientes en verde:
  - [x] F-15 `77651ab` strategy-core (223) → backtest (26), worker, app
  - [x] F-68 `5603312` exchange-core → worker
  - [x] F-46 `a0845de` exchange-core (Lighter) → worker
  - [x] F-01 `bb07cfe` exchange-core (Lighter): la suite entera en verde por primera vez desde el 001
  - [x] F-31 `f6edf36` worker
  - [x] F-32 `33fc188` worker: la suite entera en verde

## Cierre

- [x] CA-1…CA-5 repasados uno a uno — CA-3: las seis Críticas corregidas con test; CA-5: `pnpm test` desde la raíz recorre TODOS los paquetes en verde (ya no se detiene en strategy-core) y `pnpm lint` limpio
- [x] `pnpm test` y `pnpm lint` en verde
- [x] Índice de `specs/README.md` actualizado
- [x] `CLAUDE.md` actualizado si cambió algo que deba saber toda sesión
- [x] Memoria de usuario actualizada
