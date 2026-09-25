import { AiDeskLecturaService, ORIGEN_INTERES, fundingBps } from './lectura.service';

/** Lo que un agente lee del mercado y de la cuenta (spec 074). */

function montar() {
  const markets = {
    getSpec: jest.fn(async (_v: string, s: string) => {
      if (s === 'DELISTED') throw new Error('no está');
      return { symbol: s };
    }),
  };
  const marketData = {
    candles: jest.fn(async () => [{ t: 1, o: '1', h: '1', l: '1', c: '1', v: '1' }]),
    ticker: jest.fn(async () => ({ bid: '1', ask: '1', mark: '1', fundingRate: '0.0001' })),
    tramos: jest.fn(async () => []),
  };
  const stream = { fijarInteresServidor: jest.fn() };
  const bots = { capital: jest.fn(async () => ({ available: '250.5' })) };
  const risk = { get: jest.fn(async () => ({ max_leverage: 7 })) };
  const svc = new AiDeskLecturaService(
    markets as never,
    marketData as never,
    stream as never,
    bots as never,
    risk as never,
  );
  return { svc, markets, marketData, stream, bots };
}

describe('AiDeskLecturaService', () => {
  it('un par con su ficha, sus velas del intervalo, su ticker, su funding y sus tramos', async () => {
    const m = montar();
    const l = await m.svc.par('HYPERLIQUID', 'BTC', false, '15m');
    expect(l).toMatchObject({
      par: { simbolo: 'BTC', market: { symbol: 'BTC' }, fundingBps: 1, niveles: [] },
      sinTramos: false,
    });
    expect(m.marketData.candles).toHaveBeenCalledWith('HYPERLIQUID', 'BTC', '15m', {
      limit: 500,
      testnet: false,
    });
  });

  it('un par que ya no está en el catálogo no se lee', async () => {
    await expect(montar().svc.par('HYPERLIQUID', 'DELISTED', false, '1h')).resolves.toBeNull();
  });

  it('sin velas, el par queda vacío y la herramienta lo descarta; sin tramos, se marca', async () => {
    const m = montar();
    m.marketData.candles.mockRejectedValueOnce(new Error('503'));
    m.marketData.tramos.mockResolvedValueOnce(null as never);
    const l = await m.svc.par('HYPERLIQUID', 'BTC', false, '1h');
    expect(l?.par.velas).toEqual([]);
    expect(l?.sinTramos).toBe(true);
    expect(l?.par.niveles).toEqual([]);
  });

  it('el saldo libre, o null si no se puede leer', async () => {
    const m = montar();
    await expect(m.svc.saldoLibre('u-1', 'acc-1', 'BTC')).resolves.toBe('250.5');
    expect(m.bots.capital).toHaveBeenCalledWith('u-1', {
      exchangeAccountId: 'acc-1',
      symbol: 'BTC',
    });
    m.bots.capital.mockRejectedValueOnce(new Error('sin credencial'));
    await expect(m.svc.saldoLibre('u-1', 'acc-1')).resolves.toBeNull();
  });

  it('declara los pares de los agentes, por red, sin repetir', () => {
    const m = montar();
    m.svc.declararInteres([
      { venue: 'HYPERLIQUID', symbols: ['BTC', 'ETH'], exchange_account: { testnet: false } },
      { venue: 'HYPERLIQUID', symbols: ['BTC'], exchange_account: { testnet: false } },
      { venue: 'LIGHTER', symbols: ['SOL'], exchange_account: { testnet: true } },
    ]);
    expect(m.stream.fijarInteresServidor.mock.calls).toEqual([
      [ORIGEN_INTERES, ['HYPERLIQUID:BTC', 'HYPERLIQUID:ETH'], false],
      [ORIGEN_INTERES, ['LIGHTER:SOL'], true],
    ]);
  });

  it('el funding en puntos básicos, con signo; sin dato, null', () => {
    expect(fundingBps('0.0001')).toBe(1);
    expect(fundingBps('-0.00025')).toBe(-2.5);
    expect(fundingBps(undefined)).toBeNull();
    expect(fundingBps('')).toBeNull();
    expect(fundingBps('raro')).toBeNull();
  });
});
