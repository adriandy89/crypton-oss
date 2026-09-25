# 080 — % sobre margen y una Revisión de exchange profesional

Estado: `hecho` (falta CA-5, del usuario) · Tipo: `cambio` · Rama:
`spec/080-roi-y-revision-profesional` (sale de `spec/079-revision-parametros-y-calculos`)

## Objetivo

Que cada cifra que un usuario ve antes de crear un bot signifique lo mismo que en un exchange
apalancado, y que el motor haga exactamente lo que la pantalla enseña:

- los % de resultado se miden **sobre el margen**;
- las distancias entre órdenes siguen **sobre el precio**;
- hay **una sola** fórmula de liquidación;
- un stop **no puede quedar detrás** de la liquidación;
- la Revisión enseña **precio, resultado en USDC y % sobre el margen** del objetivo, del stop y de la
  liquidación.

Corrige los 28 hallazgos del 079 y los nueve que salieron durante el propio 080 (F-29 a F-37, en el
`findings.md` del 079).

## Contexto

El 079 nace de un usuario con un corto a 15× que leía «Objetivo de beneficio 71911» sin saber que era
un +225 % de su margen, con la liquidación a 5,35 % y un stop que no se veía. Ver
`specs/079-revision-parametros-y-calculos/findings.md`.

El usuario decide (2026-09-25):

| # | Decisión |
|---|---|
| D-1 | Los % de resultado, sobre el margen (ROI), con la fórmula de Binance: `precio = entrada × (1 ± ROI/apalancamiento)`. |
| D-2 | Las distancias, sobre el precio, como en Binance. |
| D-3 | Stop frente a liquidación: en aislado, error en la liquidación o detrás y aviso si queda cerca; en cruzado, solo aviso. |
| D-4 | Al cambiar el apalancamiento se mantiene el % sobre margen; el formulario propone el stop más ancho válido. |
| D-5 | Una migración convierte una vez lo guardado, y aborta si hay algún bot en marcha. |
| D-6 | No hay bots activos: se corrige todo, sin lógica vieja. |

Y aprueba el plan con P-1 a P-9 (ver `plan.md`).

## Alcance

- `packages/shared`: liquidación, ROI, contrato de la previsualización, metadatos de campo.
- `packages/strategy-core`: todas las estrategias, `common.ts`, `ladder.ts`, `stop-loss.ts` y
  `trailing-take-profit.ts`.
- `packages/exchange-core`: el simulador (mantenimiento por mercado).
- `packages/backtest`: el stop en ROI.
- `apps/worker`: el stop en ROI y sus avisos.
- `apps/api`: riesgo, asesor, supervisor y bots (`START` y apalancamiento con posición).
- `apps/app`: la Revisión, el formulario, el medidor de riesgo, las recomendaciones, los rótulos y
  las guías.
- `packages/db/prisma/migrations`: una migración de datos. `schema.prisma` no se toca.
- `docs/` y `README.md`.

## Fuera de alcance

- La lógica de decisión de AI_CHANNEL y AGENT_TRADE, que ya miden el riesgo sobre el capital.
- El fork OSS, que tendrá su propio `oss-NNN`.
- Comisiones en el resultado estimado (P-8: se rotula «sin comisiones», como Binance).

## Requisitos

- **R-1** — **ROI.** `stopLossPct`, el `takeProfitPct` de martingala, TDCA y seguimiento de
  beneficio, y el `satelliteTpPct` de GridMart, son % sobre el margen. Precio =
  `entrada × (1 ± ROI/(100·L))`, con `L` el apalancamiento de la configuración. El stop usa
  `max(L, apalancamiento de la posición en el venue)` y avisa si no coinciden.
- **R-2** — **Una sola liquidación.** La exacta, en todas partes: previsualización, validación,
  riesgo, asesor, simulador y app. La regla del 5 % se aplica por lado.
- **R-3** — **Stop frente a liquidación.**
  - En aislado: error si el stop queda en la liquidación exacta o detrás; aviso si la liquidación
    queda a menos de medio stop detrás (`HOLGURA_LIQUIDACION`).
  - En cruzado: solo aviso.
  - Los dos llevan el stop más ancho sin aviso como propuesta.
- **R-4** — **Objetivos.** En corto, un objetivo que llevaría el precio a cero o por debajo es un
  error. Los máximos de cada objetivo escalan con el apalancamiento, así que el tope en precio queda
  igual.
- **R-5** — **Valores de fábrica.** Convertidos al apalancamiento de fábrica: a ese apalancamiento el
  bot hace lo mismo que antes.
- **R-6** — **Previsualización por lado.**
  - Cada lado lleva entrada media, cantidad, nocional y margen.
  - Objetivo, stop y liquidación llevan precio, % de precio, % desde el precio de hoy, resultado en
    USDC y ROI.
  - Un recorrido del peor caso que se corta en el stop o en la liquidación.
- **R-7** — **La pantalla Revisión** enseña eso, con títulos por familia de estrategia y sin cifras
  que se contradigan.
- **R-8** — **El formulario** enseña el equivalente en precio de cada % sobre margen y propone el
  stop más ancho válido.
- **R-9** — **API.** `START` valida la configuración. Con posición abierta no se cambia el
  apalancamiento. El MM declara su nocional máximo. El asesor y el supervisor generan ROI.
- **R-10** — **Migración.** Convierte los % guardados una sola vez, aborta con un bot en marcha y
  quita el `takeProfitPct` muerto de GridMart.
- **R-11** — **Textos.** Cada % dice su base, y ninguna guía contradice al código.
- **R-12** — **El tope de exposición, en la Revisión como en el plan** (F-30, F-31).
  - Martingala, GridMart y las dos rejillas cortan el recorrido donde el tope no deja tender el
    nivel (`TOPE`). Un nivel entra si la posición que deja, valorada a su precio, cabe.
  - La validación de la escalera no rechaza niveles que el tope no deja tender.
  - La rejilla neutral aplica el tope a cada lado por separado, también en `plan()`.
  - Un tope que no deja tender ninguna línea es un error.
- **R-13** — **La tendencia no pone un stop detrás de la liquidación** (F-33). En aislado no entra si
  el stop por ATR quedaría en la liquidación o detrás, y la validación avisa con el ATR de la
  estimación.

## Criterios de aceptación

- **CA-1** — El caso del usuario (SHORT 15×, 120 USDC, BTC con mantenimiento 1,25 %) da en la
  previsualización:

  | Qué | Precio | USDC | ROI | Distancia |
  |---|---|---|---|---|
  | Liquidación | 89127 | −96,3 | | 5,35 % |
  | Stop de fábrica | 85165 | −12,0 | −10 % | |
  | Objetivo de fábrica | 82908 | +36,0 | +30 % | |

  Un stop del 90 % es error y propone 53,4 %. Test en `strategy-core`.
- **CA-2** — `pnpm build:packages` y los tests de todos los paquetes en verde (los dos rojos de la
  API sin `.env`, los mismos que en la línea base), más `pnpm lint`, `pnpm check:labels`,
  `pnpm check:env`, `pnpm --filter api build` y la compilación de la app.
- **CA-3** — La migración, probada en una base temporal: aborta con un bot en marcha, convierte bien
  y no toca lo que no debe.
- **CA-4** — No queda código de la semántica vieja: `grep` de `estimateLiquidationPrice`,
  `maxLeverageWithinDistance`, `MAX_SAFE_LEVERAGE`, `precioLiquidacionAislada` y
  `worstCaseAverageEntry`, vacío.
- **CA-5** — Del usuario: crear en la app el bot de la captura y ver la Revisión nueva.
- **CA-6** — Cada cifra de las guías (`docs/`) se ha vuelto a calcular con el código del 080, con los
  scripts de comprobación en el scratchpad, y ninguna difiere.

## Riesgos

- **Semántica.** Cambia la de un parámetro de usuario, con decisión explícita (D-1) y sin bots
  activos (D-6). La migración aborta si encuentra uno.
- **Despliegue.** API, worker y app salen juntos (P-9). Un cliente viejo manda números que el
  servidor lee como ROI: el stop le sale más estrecho en precio, nunca más ancho.
- **Backtests viejos.** Solo reproducen los mismos precios a su apalancamiento, que la migración
  conserva.

## Referencias oficiales

Las del 079: Binance (ROI y precio objetivo, resultado estimado, retroceso), Hyperliquid, Lighter y
Aster (liquidación y mantenimiento).

## Resultado y desviaciones

**Verificación (CA-2).** `pnpm build:packages` en verde. Paquete a paquete desde Git Bash:

| Paquete | Resultado |
|---|---|
| shared | 276 de 276 |
| strategy-core | 1116 de 1116 |
| exchange-core | 519 de 519 |
| backtest | 76 de 76 |
| worker | 683 de 683 |
| api | 6448 de 6449; el rojo es `app.module.spec` sin `.env`, el de la línea base |

Pasan también:

- `pnpm lint`, con los tres avisos de la API de siempre;
- `pnpm check:labels` y `pnpm check:env`;
- `pnpm --filter api build`;
- la compilación de producción de la app.

CA-4: los cinco nombres viejos no aparecen.

- **R-1, el aviso del apalancamiento del stop.** Solo salta cuando el venue tiene la posición MÁS
  apalancada que la configuración (`LEVERAGE_SKIPPED`). Es el único caso que cambia el stop: se usa el
  del venue, el más estrecho. Con un apalancamiento efectivo menor, por un margen aportado a mano, se
  queda el de la configuración y no se avisa. Si no, el stop se movería cada vez que alguien aporta
  colateral.
- **Dos regresiones del propio 080**, cazadas al rehacer las guías y corregidas con su test antes de
  cerrar:
  - una escalera en largo más profunda que el 100 % pasaba la validación a 1×, sin liquidación que
    cortara el recorrido;
  - a 1× en largo se avisaba de una liquidación que no existe.
- **Se conservan a propósito:**
  - Las opciones Largo y Corto de la dirección de la rejilla neutral, con el aviso de que no cambian
    la retícula (001/F-12). La validación las ignora y mide el corto. Quitarlas haría fallar el
    `START` de las rejillas guardadas con ellas, sin una migración que las normalice.
  - Las claves muertas que el spec 026 dejó en las configuraciones guardadas (`reanchorOnDrift`,
    `reanchorThresholdPct`, `fullCycleCooldownMinutes`). No gobiernan nada, y la migración del 080
    solo toca lo que el ROI cambia. Borrarlas es cosa de su propio spec.
- **Fuera del código:** `app.module.spec` de la API sigue pidiendo `APP_REDIRECT_WEB`, que el
  worktree no tiene porque no tiene `.env`. Ya fallaba en la línea base.
