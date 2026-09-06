# 013 — Tareas

## Fase 0

- [x] Rama `spec/013-lighter-mercado-y-cupo` desde `spec/012-aster-nonce-y-errores`; baterías en verde

## Clasificación y `safely()` (F-52, F-50, F-51)

- [x] Tests rojos: once filas de Lighter en `errors.spec.ts`; cinco mensajes en «cancelar lo que ya no existe es un no-op»
- [x] Diffs y commits `720031c`, `94a3316`

## Mercado, IOC y cupo (F-47, F-16, F-48) · `4fafcea`

- [x] Tests rojos: «una MARKET sale con un 5 % de holgura en contra y su acuse no dice FILLED», «una venta a mercado lleva la holgura hacia abajo», «una LIMIT con IOC sale como IOC», «un Too Many Requests en una escritura es THROTTLED, no se reintenta y enfria»
- [x] Diff en `placeOrder` y `unwrap` · exchange-core 309 · commit

## Tope de órdenes (F-50, F-23) · `2758f1e`

- [x] Test rojo: «avisa cuando la configuracion tiende mas ordenes de las que admite el venue»
- [x] `MarketSpec.maxActiveOrders`, `buildPreview`, catálogos de Lighter (30) y Aster (200) · strategy-core 232, build, worker 295, backtest 26 · commit

## Cabecera, duplicado y nonce (F-49, F-52, F-53) · `93c5a8b`

- [x] Tests rojos: «las lecturas de cuenta del SDK van con la cabecera authorization», «un indice de cliente duplicado devuelve la orden que ya esta en el libro», «si el contador de nonce sigue a cero tras cargarlo, la carga se reintenta»
- [x] Diff: copia viva de cabeceras del SDK, `acuseSiYaEstaba`, `signerReady` · exchange-core 312 · commit

## Edad y resuscripción (F-55, F-56) · `1e3c9a3`

- [x] Tests rojos: «la hora de creacion de una orden viva es la del venue», «reenvia los primeros cincuenta canales de golpe y espacia el resto»
- [x] Diff: `creadaEn`, `resubscribePaced`, `onOpen` · exchange-core 314 · commit

## Cierre

- [x] Bloques F-47, F-50 y F-55 reescritos en `docs/`; F-54 citado como abierto
- [x] Fichas del 001 con la decisión; tabla de specs; índice de `specs/README.md`
- [x] `pnpm build:packages`, `pnpm test`, `pnpm lint`, `pnpm check:env`
- [ ] Fuera del alcance del agente: F-54 (stream de cuenta), umbrales de 21734/21735, unidad de `initial_margin_fraction`, comportamiento del secuenciador ante una IOC que no cruza
