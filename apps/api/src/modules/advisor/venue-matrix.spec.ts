import { StrategyKind } from '@crypton/db';
import { getStrategy, VENUE_MARKETS } from '@crypton/strategy-core';
import { D, type BotConfig, type MarketSpec } from '@crypton/shared';
import { buildConfig, defaultKnobs, PROFILES, type BuildContext } from './build';
import type { MarketFeatures } from './market-features';
import { coerceConfig, enforceCouplings } from './sanitize';

/**
 * TODAS las estrategias, en TODOS los mercados reales de los TRES venues.
 *
 * CADA estrategia del registro × 12 mercados × 3 perfiles × 4 capitales, cada
 * una llevada por la misma cadena que ejecuta el servidor de verdad
 * (generar → recortar → acoplar → validar → previsualizar).
 *
 * ── Lo que se comprueba, y por qué no es circular ────────────────────────────
 *
 * La tentación es comprobar el resultado de `preview()` con `normalizeOrder`,
 * que es justo lo que `preview()` usa por dentro: eso no probaría nada. Aquí las
 * reglas del venue se vuelven a derivar A MANO desde su documentación —múltiplo
 * exacto del step, múltiplo exacto del tick, cantidad mínima, notional mínimo,
 * cantidad máxima—, así que si algún día `normalizeOrder` se equivoca, estos
 * tests lo cazan en lugar de repetir su error.
 *
 * La promesa que sostienen: **si el asistente propone una configuración y el
 * servidor la acepta, TODAS sus órdenes son ejecutables en ese venue.** Un solo
 * nivel que el exchange rechace convierte al bot en lo que le pasó a `Test1`:
 * rechazos tick tras tick hasta que salta el cortacircuitos.
 */

const ESTRATEGIAS = Object.values(StrategyKind);
const CAPITALES = ['50', '200', '1000', '5000'];

/**
 * Tres regímenes de mercado reales, no uno.
 *
 * Con un solo régimen la mitad de las ramas del generador no se recorre: la
 * volatilidad decide el apalancamiento, la separación entre niveles y la
 * cobertura de la escalera.
 */
const REGIMENES: { nombre: string; f: Omit<MarketFeatures, 'mark'> }[] = [
  {
    nombre: 'tranquilo',
    f: {
      volAnnualPct: 25,
      atrPct1h: 0.15,
      atrPct1d: 1.2,
      rangePct30: 8,
      posInRange: 0.5,
      trendPct: 0.2,
      trend: 'LATERAL',
      efficiency: 0.1,
      worstDayPct: -2.5,
      tickBps: 1,
    },
  },
  {
    nombre: 'normal',
    f: {
      volAnnualPct: 70,
      atrPct1h: 0.6,
      atrPct1d: 4,
      rangePct30: 30,
      posInRange: 0.6,
      trendPct: 2.5,
      trend: 'ALCISTA',
      efficiency: 0.35,
      worstDayPct: -7,
      tickBps: 3,
    },
  },
  {
    nombre: 'salvaje',
    f: {
      volAnnualPct: 220,
      atrPct1h: 2.4,
      atrPct1d: 14,
      rangePct30: 120,
      posInRange: 0.85,
      trendPct: -6,
      trend: 'BAJISTA',
      efficiency: 0.7,
      worstDayPct: -22,
      tickBps: 12,
    },
  },
];

/** Genera la configuración igual que lo hace `AdvisorService.materialize`. */
function configurar(
  kind: StrategyKind,
  perfil: (typeof PROFILES)[number],
  market: MarketSpec,
  mark: string,
  capital: string,
  rasgos: Omit<MarketFeatures, 'mark'>,
): { config: Record<string, unknown>; ctx: BuildContext } {
  const features: MarketFeatures = { ...rasgos, mark: Number(mark) };
  const ctx: BuildContext = {
    market,
    features,
    totalInvestment: Number(capital),
    maxLeverageUsuario: null,
    direction: 'LONG',
  };
  const strategy = getStrategy(kind);
  const knobs = defaultKnobs(perfil, features);
  let config = coerceConfig(
    strategy.meta.fields,
    strategy.defaults(),
    buildConfig(kind, knobs, ctx),
  );
  config = enforceCouplings(kind, config, market, null);
  return { config, ctx };
}

/**
 * Las reglas del venue, derivadas A MANO de su documentación.
 *
 * A propósito NO se usa `normalizeOrder`: es lo que usa el preview por dentro, y
 * comprobar una cosa con ella misma no comprueba nada.
 */
function romperReglas(market: MarketSpec, price: string, qty: string): string[] {
  const fallos: string[] = [];
  const p = D(price);
  const q = D(qty);

  if (q.lte(0)) fallos.push(`cantidad ${qty} no es positiva`);
  if (p.lte(0)) fallos.push(`precio ${price} no es positivo`);

  // Múltiplo EXACTO de la retícula. Se compara el resto contra cero con la
  // aritmética decimal, no con módulo en coma flotante.
  if (!q.div(market.stepSize).mod(1).isZero()) {
    fallos.push(`cantidad ${qty} no es múltiplo del step ${market.stepSize}`);
  }
  if (!p.div(market.tickSize).mod(1).isZero()) {
    fallos.push(`precio ${price} no es múltiplo del tick ${market.tickSize}`);
  }

  if (market.minQty && q.lt(market.minQty)) {
    fallos.push(`cantidad ${qty} por debajo del mínimo ${market.minQty}`);
  }
  if (market.maxQty && q.gt(market.maxQty)) {
    fallos.push(`cantidad ${qty} por encima del máximo ${market.maxQty}`);
  }
  if (market.minNotional && p.mul(q).lt(market.minNotional)) {
    fallos.push(`notional ${p.mul(q).toFixed(4)} por debajo del mínimo ${market.minNotional}`);
  }
  return fallos;
}

describe('matriz de venues: todas las estrategias en todos los mercados reales', () => {
  describe('toda configuración aceptada produce órdenes que el venue admite', () => {
    for (const { nombre, spec, mark } of VENUE_MARKETS) {
      for (const kind of ESTRATEGIAS) {
        for (const perfil of PROFILES) {
          for (const capital of CAPITALES) {
            for (const reg of REGIMENES) {
              it(`${nombre} · ${kind} · ${perfil} · ${capital} · ${reg.nombre}`, () => {
                const { config } = configurar(kind, perfil, spec, mark, capital, reg.f);
                const strategy = getStrategy(kind);
                const paraValidar = {
                  ...config,
                  symbol: spec.symbol,
                  exchangeAccountId: 'preview',
                } as unknown as BotConfig;

                // Que una combinación NO salga es una respuesta legítima: con 50
                // de capital en un mercado con mínimo de 10 no caben seis
                // niveles. Lo que no puede pasar es que salga y no se pueda
                // ejecutar.
                if (!strategy.validate(paraValidar, spec).ok) return;

                let preview;
                try {
                  preview = strategy.preview(paraValidar, spec, mark);
                } catch {
                  return; // Tampoco es ejecutable: el servidor la rechaza.
                }
                if (!preview.valid) return;

                // Se acumulan CON su contexto y se comprueban de una vez: así el
                // fallo dice qué nivel y por qué, en vez de un `[] != [algo]`.
                const problemas = preview.levels.flatMap((nivel) =>
                  romperReglas(spec, nivel.price, nivel.qty).map(
                    (f) =>
                      `nivel ${nivel.index} (${nivel.side} ${nivel.qty} @ ${nivel.price}): ${f}`,
                  ),
                );
                expect(problemas).toEqual([]);
              });
            }
          }
        }
      }
    }
  });

  describe('con capital holgado, ninguna estrategia se queda sin proponer nada', () => {
    // Si con 5.000 de capital en un par líquido una estrategia no consigue
    // producir NI UNA configuración válida, no es que el capital sea corto: es
    // que esa estrategia está rota en ese venue.
    const LIQUIDOS = VENUE_MARKETS.filter((m) => ['BTC', 'ETH'].includes(m.spec.base));

    for (const { nombre, spec, mark } of LIQUIDOS) {
      for (const kind of ESTRATEGIAS) {
        it(`${nombre} · ${kind}`, () => {
          const salen = PROFILES.filter((perfil) => {
            const { config } = configurar(kind, perfil, spec, mark, '5000', REGIMENES[1].f);
            const strategy = getStrategy(kind);
            const cfg = {
              ...config,
              symbol: spec.symbol,
              exchangeAccountId: 'preview',
            } as unknown as BotConfig;
            if (!strategy.validate(cfg, spec).ok) return false;
            try {
              return strategy.preview(cfg, spec, mark).valid;
            } catch {
              return false;
            }
          });
          expect(salen.length).toBeGreaterThan(0);
        });
      }
    }
  });

  describe('el apalancamiento propuesto nunca supera el del venue', () => {
    for (const { nombre, spec, mark } of VENUE_MARKETS) {
      it(`${nombre} respeta maxLeverage ${spec.maxLeverage}×`, () => {
        for (const kind of ESTRATEGIAS) {
          for (const perfil of PROFILES) {
            for (const reg of REGIMENES) {
              const { config } = configurar(kind, perfil, spec, mark, '1000', reg.f);
              const lev = Number(config['leverage'] ?? 1);
              expect(lev).toBeGreaterThanOrEqual(1);
              expect(lev).toBeLessThanOrEqual(spec.maxLeverage);
            }
          }
        }
      });
    }
  });
});
