# 014 — Tareas

- [x] Rama `spec/014-hyperliquid-tick-y-marca` desde `spec/013-lighter-mercado-y-cupo`
- [x] F-04 (shared): tests rojos en `precision.spec.ts` («recorta hacia el lado seguro…», «los enteros se respetan…», «normalizeOrder aplica la regla y es idempotente») · `2088961`
- [x] F-04 (strategy-core): «px recorta a las cifras significativas del mercado, hacia el lado seguro» · `491103a`
- [x] F-27: «avisa al abrir la decima cuenta real de Hyperliquid del proceso» · `733ac67`
- [x] F-04, F-25, F-26, F-28, F-16 (adaptador): ocho tests en `adapters/hyperliquid.spec.ts` y los de `streams.spec.ts` ajustados a las dos altas por ticker · `82c4918`
- [x] F-04b: «formatea el precio como el resto y conserva el post-only» · `225ea46`
- [x] Cierre: fichas del 001 con la decisión, tabla de specs, índice; `docs/` no citaba estos hallazgos
- [x] `pnpm build:packages`, `pnpm test`, `pnpm lint`, `pnpm check:env`
- [ ] Fuera del alcance: transporte WebSocket compartido entre cuentas (F-27, solución de fondo)
