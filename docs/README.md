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

## Las estrategias

| Estrategia | Riesgo | En una frase | Guía | Guía in-app | Código |
|---|---|---|---|---|---|
| Rejilla clásica (`GRID_CLASSIC`) | Bajo | Compra abajo y vende arriba dentro de un rango. | [grid-classic.md](./grid-classic.md) | [`grid-classic.guide.ts`](../apps/app/src/app/core/content/grid-classic.guide.ts) | [`grid-classic.ts`](../packages/strategy-core/src/strategies/grid-classic.ts) |
| Rejilla neutral (`NEUTRAL_GRID`) | Medio | Dos lados alrededor de un ancla, con tope de exposición. | [neutral-grid.md](./neutral-grid.md) | [`neutral-grid.guide.ts`](../apps/app/src/app/core/content/neutral-grid.guide.ts) | [`neutral-grid.ts`](../packages/strategy-core/src/strategies/neutral-grid.ts) |
| DCA temporizado (`TDCA`) | Medio | Compra cada X minutos solo si mejora el precio medio. | [tdca.md](./tdca.md) | [`tdca.guide.ts`](../apps/app/src/app/core/content/tdca.guide.ts) | [`tdca.ts`](../packages/strategy-core/src/strategies/tdca.ts) |
| Martingala (`MARTINGALE`) | **Alto** | Órdenes de seguridad que se alejan y crecen. | [martingale.md](./martingale.md) | [`martingale.guide.ts`](../apps/app/src/app/core/content/martingale.guide.ts) | [`martingale.ts`](../packages/strategy-core/src/strategies/martingale.ts) |
| GridMart (`GRIDMART`) | **Alto** | Martingala con rejilla de ventas y recompras. | [gridmart.md](./gridmart.md) | [`gridmart.guide.ts`](../apps/app/src/app/core/content/gridmart.guide.ts) | [`gridmart.ts`](../packages/strategy-core/src/strategies/gridmart.ts) |
| Market Maker (`MARKET_MAKER`) | Medio | Cotiza a los dos lados y cobra el diferencial. | [market-maker.md](./market-maker.md) | [`market-maker.guide.ts`](../apps/app/src/app/core/content/market-maker.guide.ts) | [`market-maker.ts`](../packages/strategy-core/src/strategies/market-maker.ts) |
| Market Maker V2 (`MARKET_MAKER_V2`) | Medio | Diferencial compuesto con volatilidad, libro y coste de operar. | [market-maker-v2.md](./market-maker-v2.md) | [`market-maker-v2.guide.ts`](../apps/app/src/app/core/content/market-maker-v2.guide.ts) | [`market-maker-v2.ts`](../packages/strategy-core/src/strategies/market-maker-v2.ts) |
| Tendencia (`TREND_FOLLOW`) | **Alto** | Rompe el rango, entra, y sale con un stop por ATR que sigue al precio. La única que gana en línea recta. | [trend-follow.md](./trend-follow.md) | [`trend-follow.guide.ts`](../apps/app/src/app/core/content/trend-follow.guide.ts) | [`trend-follow.ts`](../packages/strategy-core/src/strategies/trend-follow.ts) |
| Seguimiento de beneficio (`TRAILING_PROFIT`) | **Alto** | Una operación que deja correr el beneficio: al llegar a tu objetivo sigue al máximo y cierra al retroceder. | [trailing-profit.md](./trailing-profit.md) | [`trailing-profit.guide.ts`](../apps/app/src/app/core/content/trailing-profit.guide.ts) | [`trailing-profit.ts`](../packages/strategy-core/src/strategies/trailing-profit.ts) |
| Canal con IA (`AI_CHANNEL`) · solo administradores | **Alto** | Rebotes en el borde de un rango o canal, con el apalancamiento que permite el stop. El motor calcula las operaciones y una IA elige entre ellas. | [ai-channel.md](./ai-channel.md) | [`ai-channel.guide.ts`](../apps/app/src/app/core/content/ai-channel.guide.ts) | [`ai-channel.ts`](../packages/strategy-core/src/strategies/ai-channel.ts) |
| Operación IA (`AGENT_TRADE`) · solo administradores, no se crea a mano | **Alto** | La operación de un agente de IA: entra una vez con un precio tope, stop y objetivos en el exchange desde el primer momento, y se detiene al cerrarse. | [agent-trade.md](./agent-trade.md) | [`agent-trade.guide.ts`](../apps/app/src/app/core/content/agent-trade.guide.ts) | [`agent-trade.ts`](../packages/strategy-core/src/strategies/agent-trade.ts) |

Cada guía de estrategia tiene la misma espina: qué es · cómo funciona paso a paso · cómo configurarla con
poco riesgo (configuraciones A/B/C con sus números, checklist, señales de alarma) · lo que no mira ·
**limitaciones conocidas** · parámetros uno a uno · valores de fábrica · con cuál compararla.

## Transversales

| Documento | Qué cubre |
|---|---|
| [Buenas prácticas](./buenas-practicas.md) | El camino obligatorio, mínimos, apalancamiento, stop, funding, comisiones, cuándo no usar cada bot, bitácora, Lighter, checklist |
| [Riesgo y liquidación](./riesgo-y-liquidacion.md) | Los % sobre el margen, la fórmula exacta de la liquidación por lado, aislado/cruzado, semáforo 25/10 % y regla del 5 %, el stop frente a la liquidación, la regla por stop del canal con IA y de la operación de un agente, límites de la cuenta, guardas del motor, el stop-loss, peor caso por estrategia, funding |
| [Venues y mínimos](./venues-y-minimos.md) | Cupos de peticiones, mínimos y retículas por venue, la credencial de cada venue y qué pasa cuando caduca, testnet frente a mainnet, límites de Lighter, qué hace el motor con una orden que no cumple |
| [Simulación y backtest](./simulacion-y-backtest.md) | La cuenta «Simulación», qué simula y qué no, el backtest y sus avisos, y las cifras por setup y por tramos del canal con IA |
| [Comandos, guardas y eventos](./comandos-guardas-y-eventos.md) | Los trece comandos y qué conservan el stop, en caliente/tibio/frío, las guardas, cada evento con qué hacer (también los del Modo IA, los del canal con IA y los de los agentes), la nota del bot |
| [Administración](./administracion.md) | Qué ve y qué puede hacer un `ADMIN`: las tres pantallas, la pestaña **IA** que solo ve él, los dos únicos comandos sobre bots ajenos y por qué los demás no están, que deshabilitar no para los bots, qué queda registrado, el **Modo IA** que vigila bots vivos (su pastilla, su panel en Ajustes y cómo encenderlo al crear el bot) y el **canal con IA**: su interruptor global, su panel y sus variables |
| [Agentes de IA](./agentes-ia.md) | La pestaña IA: agentes que miran varios pares, proponen operaciones de una sola vez, las abren al aprobarlas y les dan seguimiento. El reparto, el editor y sus límites, las barreras de cada análisis, la aprobación con recálculo, el seguimiento que solo reduce riesgo, la tarjeta de resultados, Telegram, las variables y cómo empezar |
| [Canal con IA](./ai-channel.md) | El reparto entre el motor y la IA, la regla del apalancamiento por stop, los límites que se comprueban tres veces, los avisos con botón de pausa y cómo empezar |
| [Market Maker V1](./market-maker.md) · [V2](./market-maker-v2.md) | Las dos guías de market making, con su comparativa |
| [Tendencia](./trend-follow.md) | La única que gana cuando el precio se va recto, y por qué pierde más veces de las que acierta |
| [Seguimiento de beneficio](./trailing-profit.md) | El take profit que sigue al máximo, el suelo de lo que se cobra y por qué nace con stop puesto |

## Convenciones

- **Coma decimal** y puntos de millar a la española: 1.191,72 USDC. **bps** = puntos básicos: 100 bps = 1 %.
- **Los % de resultado son del margen; las distancias, del precio** (spec 080). Stop loss, take profit,
  objetivo del seguimiento y TP satélite: % del margen de la posición (a 2×, un 10 % del margen es un 5 %
  del precio). Separaciones, retrocesos, descuentos y bps: % del precio. Cada rótulo lo dice.
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
