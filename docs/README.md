# Guía de uso

Documentación para quien va a **configurar y vigilar** un bot. Lo largo sobre arquitectura, despliegue y
código está en el [`README.md`](../README.md) de la raíz; aquí se explica qué hace cada estrategia, con
qué números, y qué **no** hace todavía.

## Por dónde empezar

1. [**Buenas prácticas**](./buenas-practicas.md): el camino simulación → testnet → mainnet, mínimos,
   apalancamiento, stop, comisiones, funding, qué mirar en la bitácora. Léelo antes que nada.
2. [Riesgo y liquidación](./riesgo-y-liquidacion.md): cómo se mide, el semáforo, las guardas del motor,
   el peor caso de cada estrategia.
3. La guía de **tu estrategia** (tabla de abajo).
4. [Simulación y backtest](./simulacion-y-backtest.md) para probarla sin dinero.

## Las siete estrategias

| Estrategia | Riesgo | En una frase | Guía | Guía in-app | Código |
|---|---|---|---|---|---|
| Rejilla clásica (`GRID_CLASSIC`) | Bajo | Compra abajo y vende arriba dentro de un rango. | [grid-classic.md](./grid-classic.md) | [`grid-classic.guide.ts`](../apps/app/src/app/core/content/grid-classic.guide.ts) | [`grid-classic.ts`](../packages/strategy-core/src/strategies/grid-classic.ts) |
| Rejilla neutral (`NEUTRAL_GRID`) | Medio | Dos lados alrededor de un ancla, con tope de exposición. | [neutral-grid.md](./neutral-grid.md) | [`neutral-grid.guide.ts`](../apps/app/src/app/core/content/neutral-grid.guide.ts) | [`neutral-grid.ts`](../packages/strategy-core/src/strategies/neutral-grid.ts) |
| DCA temporizado (`TDCA`) | Medio | Compra cada X minutos solo si mejora el precio medio. | [tdca.md](./tdca.md) | [`tdca.guide.ts`](../apps/app/src/app/core/content/tdca.guide.ts) | [`tdca.ts`](../packages/strategy-core/src/strategies/tdca.ts) |
| Martingala (`MARTINGALE`) | **Alto** | Órdenes de seguridad que se alejan y crecen. | [martingale.md](./martingale.md) | [`martingale.guide.ts`](../apps/app/src/app/core/content/martingale.guide.ts) | [`martingale.ts`](../packages/strategy-core/src/strategies/martingale.ts) |
| GridMart (`GRIDMART`) | **Alto** | Martingala con rejilla de ventas y recompras. | [gridmart.md](./gridmart.md) | [`gridmart.guide.ts`](../apps/app/src/app/core/content/gridmart.guide.ts) | [`gridmart.ts`](../packages/strategy-core/src/strategies/gridmart.ts) |
| Market Maker (`MARKET_MAKER`) | Medio | Cotiza a los dos lados y cobra el diferencial. | [market-maker.md](./market-maker.md) | [`market-maker.guide.ts`](../apps/app/src/app/core/content/market-maker.guide.ts) | [`market-maker.ts`](../packages/strategy-core/src/strategies/market-maker.ts) |
| Market Maker V2 (`MARKET_MAKER_V2`) | Medio | Diferencial compuesto con volatilidad, libro y coste de operar. | [market-maker-v2.md](./market-maker-v2.md) | [`market-maker-v2.guide.ts`](../apps/app/src/app/core/content/market-maker-v2.guide.ts) | [`market-maker-v2.ts`](../packages/strategy-core/src/strategies/market-maker-v2.ts) |

Cada guía de estrategia tiene la misma espina: qué es · cómo funciona paso a paso · cómo configurarla con
poco riesgo (configuraciones A/B/C con sus números, checklist, señales de alarma) · lo que no mira ·
**limitaciones conocidas** · parámetros uno a uno · valores de fábrica · con cuál compararla.

## Transversales

| Documento | Qué cubre |
|---|---|
| [Buenas prácticas](./buenas-practicas.md) | El camino obligatorio, mínimos, apalancamiento, stop, funding, comisiones, cuándo no usar cada bot, bitácora, Lighter, checklist |
| [Riesgo y liquidación](./riesgo-y-liquidacion.md) | Fórmula de liquidación, aislado/cruzado, semáforo 25/10 % y regla del 5 %, límites de la cuenta, guardas del motor, el stop-loss, peor caso por estrategia, funding |
| [Venues y mínimos](./venues-y-minimos.md) | Cupos de peticiones, mínimos y retículas por venue, la credencial de cada venue y qué pasa cuando caduca, testnet frente a mainnet, límites de Lighter, qué hace el motor con una orden que no cumple |
| [Simulación y backtest](./simulacion-y-backtest.md) | La cuenta «Simulación», qué simula y qué no, el backtest y sus nueve avisos |
| [Comandos, guardas y eventos](./comandos-guardas-y-eventos.md) | Los trece comandos y qué conservan el stop, en caliente/tibio/frío, las guardas, los 36 eventos con qué hacer, la nota del bot |
| [Administración](./administracion.md) | Qué ve y qué puede hacer un `ADMIN`: las tres pantallas, los dos únicos comandos sobre bots ajenos y por qué los demás no están, que deshabilitar no para los bots, qué queda registrado |
| [Market Maker V1](./market-maker.md) · [V2](./market-maker-v2.md) | Las dos guías de market making, con su comparativa |

## Convenciones

- **Coma decimal** y puntos de millar a la española: 1.191,72 USDC. **bps** = puntos básicos: 100 bps = 1 %.
- **Mutabilidad**: 🔥 en caliente (se aplica en la siguiente revisión) · 🌤️ en tibio (cancela y recoloca
  órdenes; la posición sigue) · ❄️ en frío (hay que crear otro bot).
- **Los números de los ejemplos** salen de ejecutar `validate()` y `preview()` del propio código sobre las
  fichas de mercado de [`venue-markets.ts`](../packages/strategy-core/src/venue-markets.ts) (precios del
  **24-08-2026**). Son los que enseña la vista previa de la app. Si un precio ha cambiado mucho, las
  cantidades cambian; las proporciones no.
- **Limitaciones conocidas.** Cada guía lleva bloques como este:

  > ⚠️ **Limitación conocida (F-NN, abierta a AAAA-MM-DD).** …
  > **Hasta que se corrija:** … Estado: `specs/001-revision-integral/findings.md` § F-NN.

  El identificador `F-NN` es el del hallazgo en la revisión integral
  ([`specs/001-revision-integral/findings.md`](../specs/001-revision-integral/findings.md)). Cuando el
  hallazgo se cierra, el spec que lo cierra borra o reescribe el bloque. Si ves un bloque cuyo hallazgo ya
  figura como corregido, el bloque está desfasado y manda el código.
- **Ante cualquier contradicción** entre esta guía, la ayuda in-app y el código, **manda el código**. Las
  guías citan fichero y línea para que puedas comprobarlo.

## Cómo se mantiene

Esta carpeta nace del spec [`008-guia-de-uso`](../specs/008-guia-de-uso/spec.md). Cuatro comprobaciones
la mantienen honesta: los ejemplos pasan por `preview()`; cada guía documenta exactamente los campos de
`meta.fields` de su estrategia; los enlaces relativos existen; y todo `F-NN` citado existe en la revisión
integral. Los scripts viven fuera del repositorio (scratchpad de la sesión) y se describen en el
[`plan.md`](../specs/008-guia-de-uso/plan.md) del spec.
