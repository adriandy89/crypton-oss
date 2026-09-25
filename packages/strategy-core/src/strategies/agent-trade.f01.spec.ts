import {
  D,
  LevelKind,
  StrategyKind,
  type BotConfig,
  type BotContext,
  type DesiredState,
} from '@crypton/shared';
import { ESPERA_LLENADO_MS } from '../operacion/gestion';
import { getStrategy } from '../registry';
import { BASE_CONFIG, makeContext, makeCycle, makePosition } from '../testing';

/**
 * Spec 075, F-01 (confirmación): una entrada PROPIA que tarda más de
 * `ESPERA_LLENADO_MS` en verse —ni la posición ni la ejecución— hace que el
 * plan dé la entrada por fallida (`op: null`) y reintente con otra IOC. Si la
 * primera sí entró, la posición propia queda con el stop de una sola entrada,
 * o, si ya no se reintenta, se toma por ajena y el bot se detiene sin stop.
 */

const s = getStrategy(StrategyKind.AGENT_TRADE);
const AHORA = 50_000_000;

const CFG = {
  ...BASE_CONFIG,
  leverage: 5,
  totalInvestment: '20',
  liquidationAction: 'CLOSE_ALL',
  entryLimitPrice: '100.1',
  entryDeadline: AHORA + 5 * 60_000,
  quantity: '1',
  riskAmount: '2.2',
  agentProposalId: 'p-1',
  stopPrice: '98',
  tp1Price: '104',
  tp2Price: '108',
  tp1Fraction: '50',
  breakevenAfterTp1: true,
  trailAfterTp1: false,
  trailCallbackPct: '1',
  maxHoldMinutes: 1440,
  positionCap: null,
};

function ctx(o: {
  now: number;
  scratch: Record<string, unknown>;
  qty?: string;
  entradas?: number;
}): BotContext {
  const base = makeContext({
    strategy: StrategyKind.AGENT_TRADE,
    config: CFG as unknown as BotConfig,
    price: '100',
    position: o.qty ? { ...makePosition(o.qty, '100.05', '100'), leverage: 5 } : null,
    now: o.now,
  });
  return {
    ...base,
    cycle: makeCycle({
      entriesFilled: o.entradas ?? 0,
      averageEntry: o.entradas ? '100.05' : null,
      scratch: { cycleSeq: 1, ...o.scratch },
    }),
  };
}

const stops = (d: DesiredState) => d.orders.filter((x) => x.levelKind === LevelKind.STOP_LOSS);
const bases = (d: DesiredState) => d.orders.filter((x) => x.levelKind === LevelKind.BASE);

describe('F-01: una entrada propia que se ve tarde', () => {
  it('(a) si la primera IOC se vio tarde y entraron las dos, toda la posición propia lleva stop', () => {
    // 1. Sale BASE#0.
    const d1 = s.plan(ctx({ now: AHORA, scratch: {} }));
    expect(bases(d1)).toHaveLength(1);
    const op0 = (d1.scratchPatch as { op: Record<string, unknown> }).op;
    // 2. Pasan 30 s sin verse ni la posición ni la ejecución: se da por fallida.
    const t2 = AHORA + ESPERA_LLENADO_MS + 1;
    const d2 = s.plan(ctx({ now: t2, scratch: { op: op0, intentos: 1 } }));
    // 3. El siguiente tick reintenta con otra IOC por la cantidad entera.
    const d3 = s.plan(ctx({ now: t2 + 8_000, scratch: { ...d2.scratchPatch, intentos: 1 } }));
    const segunda = bases(d3);
    // 4. Las dos entraron: la posición propia es 2 y el ciclo lo sabe.
    const op1 = (d3.scratchPatch as { op?: Record<string, unknown> } | undefined)?.op;
    const d4 = s.plan(
      ctx({ now: t2 + 20_000, scratch: { op: op1, intentos: 2 }, qty: '2', entradas: 2 }),
    );
    // El reintento es a propósito: pasados 30 s sin verla, la entrada se da por
    // fallida y, mientras valga, se intenta otra vez.
    expect(segunda).toHaveLength(1);
    // Si las dos entraron, el stop cubre toda la posición: nada propio sin red.
    const stop = stops(d4)[0];
    expect({ stopQty: stop?.qty ?? null, cubre: stop !== undefined && D(stop.qty).eq(2) }).toEqual({
      stopQty: '2.00000',
      cubre: true,
    });
  });

  it('(b) con la entrada dada por fallida, la posición propia que aparece lleva stop', () => {
    // La ejecución de la IOC ya consta en el ciclo, pero `op` se anuló a los 30 s.
    const d = s.plan(
      ctx({
        now: AHORA + ESPERA_LLENADO_MS + 60_000,
        scratch: { op: null, intentos: 1 },
        qty: '1',
        entradas: 1,
      }),
    );
    expect({ detener: d.detener ?? null, stops: stops(d).length }).toEqual({
      detener: null,
      stops: 1,
    });
  });
});
