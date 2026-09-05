import { aggregatePortfolio, type PortfolioSource } from './portfolio-aggregate';

/**
 * La aritmética de la fila de la cartera (spec 003, CA-2).
 *
 * Lo que se fija: que el dinero se sume exacto, que testnet y mainnet no se
 * mezclen, que los simulados no entren, que `bots` cuente los que aportan y que
 * sin entrada no salga nada —ni una fila a cero, que se leería como «la cartera
 * vale cero» en vez de «no se midió».
 */

const dec = (v: string) => ({ toString: () => v });

const fila = (o: Partial<PortfolioSource> & { bot_id: string }): PortfolioSource => ({
  user_id: 'u1',
  testnet: false,
  dry_run: false,
  total_investment: dec('100'),
  realized_pnl_acc: dec('0'),
  unrealized_pnl: dec('0'),
  position_qty: dec('0'),
  average_entry: null,
  ...o,
});

describe('aggregatePortfolio', () => {
  it('suma exacto: 0,1 + 0,2 es 0,3, no 0,30000000000000004', () => {
    const [r] = aggregatePortfolio([
      fila({ bot_id: 'a', realized_pnl_acc: dec('0.1'), unrealized_pnl: dec('0.7') }),
      fila({ bot_id: 'b', realized_pnl_acc: dec('0.2'), unrealized_pnl: dec('-0.4') }),
    ]);
    expect(r.realized).toBe('0.3');
    expect(r.unrealized).toBe('0.3');
    // pnl = realizado + no realizado, la definición de `bot_snapshots.equity`.
    expect(r.pnl).toBe('0.6');
    expect(r.invested).toBe('200');
    expect(r.bots).toBe(2);
  });

  it('una fila por usuario y red: testnet y mainnet no se mezclan', () => {
    const out = aggregatePortfolio([
      fila({ bot_id: 'a', realized_pnl_acc: dec('10') }),
      fila({ bot_id: 'b', testnet: true, realized_pnl_acc: dec('-3') }),
      fila({ bot_id: 'c', user_id: 'u2', realized_pnl_acc: dec('1') }),
    ]);
    expect(out.map((r) => [r.user_id, r.testnet, r.pnl, r.bots])).toEqual([
      ['u1', false, '10', 1],
      ['u1', true, '-3', 1],
      ['u2', false, '1', 1],
    ]);
  });

  it('los simulados no entran, ni en la suma ni en la cuenta de bots', () => {
    const out = aggregatePortfolio([
      fila({ bot_id: 'a', realized_pnl_acc: dec('5') }),
      fila({ bot_id: 'sim', dry_run: true, realized_pnl_acc: dec('1000') }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].pnl).toBe('5');
    expect(out[0].bots).toBe(1);
  });

  it('la exposición es |posición| × precio medio: un corto expone igual que un largo', () => {
    const [r] = aggregatePortfolio([
      fila({ bot_id: 'largo', position_qty: dec('0.5'), average_entry: dec('60000') }),
      fila({ bot_id: 'corto', position_qty: dec('-1'), average_entry: dec('2500') }),
      // Sin posición no hay exposición aunque haya precio medio viejo.
      fila({ bot_id: 'plano', position_qty: dec('0'), average_entry: dec('99999') }),
      // Con posición y sin precio medio no se inventa nada.
      fila({ bot_id: 'raro', position_qty: dec('1'), average_entry: null }),
    ]);
    expect(r.exposure).toBe('32500');
    expect(r.bots).toBe(4);
  });

  it('sin snapshots recientes no sale ninguna fila: cero medido y nada medido no son lo mismo', () => {
    expect(aggregatePortfolio([])).toEqual([]);
    expect(aggregatePortfolio([fila({ bot_id: 'sim', dry_run: true })])).toEqual([]);
  });
});
