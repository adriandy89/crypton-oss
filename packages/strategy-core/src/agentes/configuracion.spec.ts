import {
  D,
  FamiliaAgente,
  NivelConfianza,
  ObjetivoAgente,
  StrategyKind,
  TamanoOperacion,
  Venue,
  type BotConfig,
  type Candle,
  type EleccionAgente,
} from '@crypton/shared';
import { mulberry32 } from '../canal/testing-canal';
import { getStrategy } from '../registry';
import { configDeOperacion } from '../strategies/agent-trade';
import { herramientaAgente, ofertaAgente } from './herramienta';
import { construirPropuesta } from './propuesta';
import {
  SEMILLA_REVERSION,
  cortarEnSenal,
  entradaAgenteDePrueba,
  limitesDePrueba,
  serieRango,
  serieRuptura,
  serieTendencia,
} from './testing-agentes';

/**
 * Del plan al bot (spec 074, CA-4): todo plan que sale del generador, vuelto
 * configuración de `AGENT_TRADE`, pasa `validate()` y `preview()` de la
 * estrategia, y su pérdida al stop es la del plan. Si alguna vez no pasara, la
 * aprobación fallaría al crear el bot —que es lo seguro—, pero sería una
 * propuesta que el agente ofreció sin poder cumplirla.
 */

const SERIES: Candle[][] = (['LONG', 'SHORT'] as const).flatMap((lado) => [
  cortarEnSenal(serieTendencia(lado), FamiliaAgente.TENDENCIA, lado),
  cortarEnSenal(serieRuptura(lado), FamiliaAgente.RUPTURA, lado),
  cortarEnSenal(serieRango(SEMILLA_REVERSION[lado]), FamiliaAgente.REVERSION, lado),
]);

describe('configDeOperacion', () => {
  it('cada plan generado valida, se previsualiza y lleva su riesgo', () => {
    const estrategia = getStrategy(StrategyKind.AGENT_TRADE);
    const azar = mulberry32(74_4);
    const uno = <T>(xs: readonly T[]): T => xs[Math.floor(azar() * xs.length)];
    let planes = 0;
    for (let caso = 0; caso < 120; caso++) {
      const velas = SERIES[caso % SERIES.length];
      const riesgoPct = (0.1 + azar() * 2).toFixed(2);
      const limites = limitesDePrueba({
        capital: (500 + azar() * 20_000).toFixed(2),
        riesgoPct,
        perdidaDiariaPct: (Number(riesgoPct) + azar() * 4).toFixed(2),
        apalancamientoMax: 1 + Math.floor(azar() * 25),
        fraccionTp1Pct: (10 + Math.floor(azar() * 80)).toString(),
        breakevenTrasTp1: azar() < 0.5,
      });
      const entrada = entradaAgenteDePrueba(velas, { limites });
      const salida = herramientaAgente(entrada);
      const market = entrada.pares[0].market;
      const ctx = {
        limites,
        venue: Venue.HYPERLIQUID,
        market,
        intervalo: '1h' as const,
        ahora: entrada.ahora,
        vidaMs: 300_000,
      };
      for (const { candidato } of ofertaAgente(salida)) {
        for (const o of candidato.stops.filter((x) => x.viable)) {
          const eleccion: EleccionAgente = {
            candidatoId: candidato.id,
            stop: o.tipo,
            objetivo: uno(Object.values(ObjetivoAgente)),
            apalancamiento: uno(o.bandas).banda,
            tamano: uno(Object.values(TamanoOperacion)),
            confianza: NivelConfianza.ALTA,
          };
          const plan = construirPropuesta(salida, eleccion, ctx).plan;
          if (!plan) continue;
          planes++;
          const config = configDeOperacion(plan, {
            exchangeAccountId: 'cuenta-1',
            agentProposalId: 'propuesta-1',
          }) as unknown as BotConfig;
          const v = estrategia.validate(config, market);
          expect({
            plan: plan.simbolo,
            errores: v.issues.filter((i) => i.severity === 'ERROR'),
          }).toEqual({ plan: plan.simbolo, errores: [] });
          const p = estrategia.preview(config, market, plan.entradaReferencia);
          expect(p.valid).toBe(true);
          // Lo que arriesga el bot es lo que el plan dijo, y cabe en el límite.
          expect(config['riskAmount']).toBe(plan.riesgo);
          expect(
            D(plan.riesgo).lte(D(limites.capital).mul(limites.riesgoPct).div(100).plus('1e-9')),
          ).toBe(true);
          // La parte del primer objetivo reproduce el reparto del plan.
          if (plan.objetivos.length === 2) {
            const parte = D(config['quantity'] as string)
              .mul(config['tp1Fraction'] as string)
              .div(100);
            expect(parte.minus(plan.objetivos[0].cantidad).abs().lte('0.000001')).toBe(true);
          } else {
            expect(config['tp2Price']).toBeNull();
          }
          // Nace con su stop y sin tope: el seguimiento es el que lo cambia.
          expect(config['stopPrice']).toBe(plan.stop);
          expect(config['positionCap']).toBeNull();
          expect(config['entryDeadline']).toBe(plan.entradaHasta);
        }
      }
    }
    expect(planes).toBeGreaterThan(50);
  });
});
