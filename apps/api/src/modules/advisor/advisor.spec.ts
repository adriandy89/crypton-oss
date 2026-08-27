import { StrategyKind } from '@crypton/db';
import { getStrategy } from '@crypton/strategy-core';
import type { BotConfig, MarketSpec } from '@crypton/shared';
import { buildConfig, defaultKnobs, PROFILES, type BuildContext } from './build';
import type { MarketFeatures } from './market-features';
import { coerceConfig, enforceCouplings, ladderCoveragePct, MAX_SAFE_LEVERAGE } from './sanitize';

/**
 * La red de seguridad de toda la funcionalidad.
 *
 * La promesa que le hacemos al usuario es que una recomendacion se puede aplicar
 * y crear el bot sin que el servidor la rechace. Esa promesa se sostiene aqui o
 * no se sostiene en ninguna parte: si un perfil sale con una escalera que no
 * cabe antes de la liquidacion, el usuario lo descubre con un 403 despues de
 * haberlo revisado todo.
 *
 * Se recorren las SIETE estrategias por los TRES perfiles sobre una matriz de
 * mercados sinteticos que cubre lo que rompe de verdad: volatilidad baja y alta,
 * tick grande y pequeno, notional minimo alto, y capital desde 50 hasta 5000.
 */

const ESTRATEGIAS = Object.values(StrategyKind);

/** Mercados que cubren los casos donde esto se rompe primero. */
const MERCADOS: { nombre: string; spec: MarketSpec; mark: number }[] = [
  {
    nombre: 'BTC (tick fino, notional bajo)',
    mark: 64000,
    spec: {
      venue: 'HYPERLIQUID',
      symbol: 'BTC',
      canonical: 'BTC/USDC',
      base: 'BTC',
      quote: 'USDC',
      tickSize: '1',
      stepSize: '0.00001',
      minNotional: '10',
      minQty: null,
      maxQty: null,
      maxLeverage: 40,
      priceDecimals: 1,
      qtyDecimals: 5,
      active: true,
    },
  },
  {
    nombre: 'Par barato (tick enorme en relativo)',
    mark: 0.00004182,
    spec: {
      venue: 'ASTER',
      symbol: 'PEPEUSDT',
      canonical: 'PEPE/USDT',
      base: 'PEPE',
      quote: 'USDT',
      tickSize: '0.00000001',
      stepSize: '1',
      minNotional: '5',
      minQty: null,
      maxQty: null,
      maxLeverage: 10,
      priceDecimals: 8,
      qtyDecimals: 0,
      active: true,
    },
  },
  {
    nombre: 'Mercado con notional minimo alto',
    mark: 2450,
    spec: {
      venue: 'LIGHTER',
      symbol: 'ETH',
      canonical: 'ETH/USDC',
      base: 'ETH',
      quote: 'USDC',
      tickSize: '0.01',
      stepSize: '0.001',
      minNotional: '50',
      minQty: null,
      maxQty: null,
      maxLeverage: 20,
      priceDecimals: 2,
      qtyDecimals: 3,
      active: true,
    },
  },
];

/** Regimenes de mercado: tranquilo, normal y salvaje. */
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

const CAPITALES = [50, 500, 5000];

function materializar(
  kind: StrategyKind,
  profile: (typeof PROFILES)[number],
  ctx: BuildContext,
): { config: Record<string, unknown>; ctx: BuildContext } {
  const strategy = getStrategy(kind);
  const knobs = defaultKnobs(profile, ctx.features);
  const generado = buildConfig(kind, knobs, ctx);
  let config = coerceConfig(strategy.meta.fields, strategy.defaults(), generado);
  config = enforceCouplings(kind, config, ctx.market, ctx.maxLeverageUsuario);
  return { config, ctx };
}

describe('recomendaciones de configuracion', () => {
  describe('el apalancamiento nunca supera lo que el servidor acepta', () => {
    // 18x y no 20x: `RiskService` rechaza con 403 si la distancia a liquidacion
    // baja del 5 %, y esa distancia es `100/lev - 0,5`. A 19x son 4,76 %.
    for (const kind of ESTRATEGIAS) {
      for (const profile of PROFILES) {
        for (const mercado of MERCADOS) {
          for (const regimen of REGIMENES) {
            it(`${kind} / ${profile} / ${mercado.nombre} / ${regimen.nombre}`, () => {
              const ctx: BuildContext = {
                market: mercado.spec,
                features: { ...regimen.f, mark: mercado.mark },
                totalInvestment: 1000,
                maxLeverageUsuario: null,
                direction: 'LONG',
              };
              const { config } = materializar(kind, profile, ctx);
              const lev = Number(config['leverage']);

              expect(lev).toBeGreaterThanOrEqual(1);
              expect(lev).toBeLessThanOrEqual(MAX_SAFE_LEVERAGE);
              expect(lev).toBeLessThanOrEqual(mercado.spec.maxLeverage);
              // La cuenta exacta que hace el servidor al crear el bot.
              expect(100 / lev - 0.5).toBeGreaterThanOrEqual(5);
            });
          }
        }
      }
    }
  });

  describe('los tres perfiles se distinguen de verdad', () => {
    // La regresion que motiva este bloque: la formula anterior del
    // apalancamiento (`60 / volatilidadAnual`, redondeada) colapsaba a 1 por
    // encima del 45 % de volatilidad, o sea en casi cualquier par real. Los tres
    // perfiles salian identicos y la funcion entera perdia su sentido, sin que
    // ningun test lo detectara porque todos seguian siendo VALIDOS.
    for (const kind of [
      StrategyKind.MARTINGALE,
      StrategyKind.GRID_CLASSIC,
      StrategyKind.MARKET_MAKER_V2,
    ]) {
      for (const regimen of REGIMENES) {
        it(`${kind} / ${regimen.nombre}`, () => {
          const configs = PROFILES.map((profile) => {
            const ctx: BuildContext = {
              market: MERCADOS[0].spec,
              features: { ...regimen.f, mark: MERCADOS[0].mark },
              totalInvestment: 5000,
              maxLeverageUsuario: null,
              direction: 'LONG',
            };
            return materializar(kind, profile, ctx).config;
          });

          // Dos configuraciones identicas no son dos opciones: son la misma
          // tarjeta pintada dos veces.
          const huellas = configs.map((c) => JSON.stringify(c));
          expect(new Set(huellas).size).toBe(3);

          // Y el apalancamiento tiene que ir de menos a mas con el apetito, o
          // «prudente» y «agresiva» solo se diferencian en la etiqueta.
          const lev = configs.map((c) => Number(c['leverage']));
          expect(lev[0]).toBeLessThanOrEqual(lev[2]);
        });
      }
    }
  });

  describe('el margen del peor caso nunca supera el capital', () => {
    // `validate()` y `preview()` miran el VENUE, no la cartera: una
    // configuracion que pide 120 de margen con 50 de capital pasa las dos. Sin
    // esta comprobacion se le ofrecia al usuario tal cual.
    for (const kind of ESTRATEGIAS) {
      for (const profile of PROFILES) {
        for (const mercado of MERCADOS) {
          it(`${kind} / ${profile} / ${mercado.nombre}`, () => {
            const capital = 50;
            const ctx: BuildContext = {
              market: mercado.spec,
              features: { ...REGIMENES[1].f, mark: mercado.mark },
              totalInvestment: capital,
              maxLeverageUsuario: null,
              direction: 'LONG',
            };
            const strategy = getStrategy(kind);
            const { config } = materializar(kind, profile, ctx);
            const pv = {
              ...config,
              symbol: mercado.spec.symbol,
              exchangeAccountId: 'test',
            } as unknown as BotConfig;
            if (!strategy.validate(pv, mercado.spec).ok) return;
            const preview = strategy.preview(pv, mercado.spec, String(mercado.mark));
            if (!preview.valid) return;
            // Un 2 % de holgura por los redondeos al paso del venue.
            expect(Number(preview.worstCaseMargin)).toBeLessThanOrEqual(capital * 1.02);
          });
        }
      }
    }
  });

  describe('la direccion pedida se respeta', () => {
    // Se aceptaba en el cuerpo de la peticion, se guardaba en el contexto y no
    // la leia ningun generador: pedir un bot SHORT devolvia tres configuraciones
    // LONG, con su preview calculado en LONG.
    it('SHORT se propaga en las estrategias direccionales', () => {
      const ctx: BuildContext = {
        market: MERCADOS[0].spec,
        features: { ...REGIMENES[1].f, mark: MERCADOS[0].mark },
        totalInvestment: 1000,
        maxLeverageUsuario: null,
        direction: 'SHORT',
      };
      for (const kind of [StrategyKind.MARTINGALE, StrategyKind.TDCA, StrategyKind.GRIDMART]) {
        const { config } = materializar(kind, 'EQUILIBRADA', ctx);
        expect(config['direction']).toBe('SHORT');
      }
    });

    it('los market makers cotizan a los dos lados pase lo que pase', () => {
      const ctx: BuildContext = {
        market: MERCADOS[0].spec,
        features: { ...REGIMENES[1].f, mark: MERCADOS[0].mark },
        totalInvestment: 1000,
        maxLeverageUsuario: null,
        direction: 'SHORT',
      };
      for (const kind of [StrategyKind.MARKET_MAKER, StrategyKind.MARKET_MAKER_V2]) {
        expect(materializar(kind, 'EQUILIBRADA', ctx).config['direction']).toBe('NEUTRAL');
      }
    });
  });

  describe('la escalera cabe antes de la liquidacion', () => {
    // Es el acoplamiento que ninguna validacion deduce mirando un campo solo, y
    // el que convierte una martingala razonable en una que muere a medio tender.
    for (const kind of [StrategyKind.MARTINGALE, StrategyKind.GRIDMART]) {
      for (const profile of PROFILES) {
        for (const regimen of REGIMENES) {
          it(`${kind} / ${profile} / ${regimen.nombre}`, () => {
            const ctx: BuildContext = {
              market: MERCADOS[0].spec,
              features: { ...regimen.f, mark: MERCADOS[0].mark },
              totalInvestment: 1000,
              maxLeverageUsuario: null,
              direction: 'LONG',
            };
            const { config } = materializar(kind, profile, ctx);
            const cobertura = ladderCoveragePct(
              Number(config['numLimitBuys']),
              Number(config['initialSeparationPct']),
              Number(config['stepScale']),
            );
            const distancia = 100 / Number(config['leverage']);
            expect(cobertura).toBeLessThan(distancia);
          });
        }
      }
    }
  });

  describe('toda recomendacion es valida y previsualizable', () => {
    // El test que sostiene la promesa entera. `validate()` decide y `preview()`
    // es lo unico que detecta las violaciones de tick, paso y notional minimo
    // del venue.
    for (const kind of ESTRATEGIAS) {
      for (const profile of PROFILES) {
        for (const mercado of MERCADOS) {
          for (const regimen of REGIMENES) {
            for (const capital of CAPITALES) {
              it(`${kind}/${profile}/${mercado.nombre}/${regimen.nombre}/${capital}`, () => {
                const ctx: BuildContext = {
                  market: mercado.spec,
                  features: { ...regimen.f, mark: mercado.mark },
                  totalInvestment: capital,
                  maxLeverageUsuario: null,
                  direction: 'LONG',
                };
                const strategy = getStrategy(kind);
                const { config } = materializar(kind, profile, ctx);
                const paraValidar = {
                  ...config,
                  symbol: mercado.spec.symbol,
                  exchangeAccountId: 'test',
                } as unknown as BotConfig;

                const validacion = strategy.validate(paraValidar, mercado.spec);
                const errores = validacion.issues.filter((i) => i.severity === 'ERROR');

                // Con capitales pequenos frente al notional minimo del venue hay
                // configuraciones que legitimamente NO caben: el servicio las
                // descarta y lo dice. Lo que no puede pasar es que una que se
                // declara valida luego reviente en el preview.
                if (errores.length > 0) {
                  expect(validacion.ok).toBe(false);
                  return;
                }

                const preview = strategy.preview(paraValidar, mercado.spec, String(mercado.mark));
                if (!preview.valid) {
                  // Se descarta en el servicio; aqui solo se comprueba que el
                  // motivo esta dicho y no es un fallo silencioso.
                  expect(preview.issues.length).toBeGreaterThan(0);
                  return;
                }
                // Y si dice que es valido, ningun nivel puede traer violaciones.
                for (const nivel of preview.levels) {
                  expect(nivel.violations).toEqual([]);
                }
              });
            }
          }
        }
      }
    }
  });
});
