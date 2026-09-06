# 015 — Tareas

- [x] Rama `spec/015-liquidaciones-y-streams-por-venue` desde `spec/014-hyperliquid-tick-y-marca`
- [x] F-05: test rojo «una ejecucion forzada por el venue llega marcada como liquidacion» · diff · `70be23f`
- [x] F-70: tests rojos «… emite un fill marcado como liquidacion» (cinco marcas) y «una ejecucion normal no se marca»
- [x] F-72: «el ticker lleva la ultima marca recibida, no el punto medio» · F-73: «listenKeyExpired reabre el socket de usuario con un listenKey nuevo» · F-74: «acota startTime a siete dias y manda endTime» · diff · `cfa50ac`
- [x] Cierre: bloques de F-05/F-70 reescritos en `docs/`; fichas del 001; tabla de specs; índice
- [x] `pnpm build:packages`, `pnpm test`, `pnpm lint`, `pnpm check:env`
- [ ] Fuera del alcance del agente: confirmar con lectura firmada el `Trade.type` real de una liquidación en Lighter y el `-1127` de Aster
