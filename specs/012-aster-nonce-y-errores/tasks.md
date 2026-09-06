# 012 — Tareas

## Fase 0

- [x] Rama `spec/012-aster-nonce-y-errores` desde `spec/011-margen-y-modo-posicion`
- [x] Baterías en verde

## Fase 1 — Nonce (F-38, F-69, F-75) · `0846b1d`

- [x] Tests rojos (`adapters/aster.spec.ts`, nuevo): «es estrictamente creciente aunque el reloj retroceda», «dos adaptadores con el mismo firmante no repiten nonce», «el nonce se genera al enviar, no al encolar»
- [x] Diff: `nextAsterNonce()` de módulo, firma dentro de `limiter.run` en `signedRequest` y `signedRequestOnce` · exchange-core 291 · commit

## Fase 2 — Clasificación (F-75, F-77) · `62024a9`

- [x] Tests rojos: doce filas nuevas en `errors.spec.ts` con el vocabulario de Aster V3
- [x] Diff en `errors.ts` (AUTH, RULES, RETRYABLE) · commit

## Fase 3 — Deriva de reloj (F-38) · `e9475d4`

- [x] Tests rojos: «un reloj desviado mas de veinte segundos se rechaza con el motivo», «con el reloj en hora, verifica el saldo»
- [x] Diff en `verify()` (`/fapi/v3/time`, `CLOCK_DRIFT_MAX_MS`) · commit

## Fase 4 — Comisión (F-78) · `a8c37c1`

- [x] Test rojo: «la comision se contabiliza como coste sea cual sea su signo»
- [x] Diff: valor absoluto en `getRecentFills` y en el stream · commit

## Cierre

- [x] Build; worker en verde; `pnpm test`, `pnpm lint`, `pnpm check:env`
- [x] Sin bloques F-NN en `docs/` (ninguno los citaba); fichas del 001 con la decisión; índice; memoria
- [ ] Pendiente fuera del alcance del agente: confirmar con lectura firmada el signo de `commission` (F-78) y el rechazo real de un nonce repetido (F-69)
