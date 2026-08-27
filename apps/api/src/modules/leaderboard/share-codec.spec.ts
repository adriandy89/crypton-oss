import { Mutability, type BotConfig, type FieldMeta } from '@crypton/shared';
import { getStrategy } from '@crypton/strategy-core';
import { expandFromShare, sanitizeForShare } from './share-codec';

/**
 * Tests del saneado para copy-trading.
 *
 * Lo que se comprueba aqui es que compartir un bot no filtre dos cosas —con que
 * cuenta opera y cuanto dinero mueve su autor— y que al copiarlo los importes se
 * redimensionen al capital de quien copia. Un fallo silencioso aqui haria que
 * alguien con 100 USDC desplegara un bot dimensionado para 50.000.
 */

/**
 * Metadatos de la estrategia, como los declara `strategy-core`.
 *
 * Tiene que incluir TODOS los campos que lleva `ORIGINAL`, porque el saneado
 * funciona por lista blanca: lo que no esta declarado no se comparte. Este
 * fixture omitia `leverage` y `marginMode` —que las estrategias de verdad si
 * declaran— y por eso parecia que el filtro se comia parametros legitimos.
 */
const FIELDS: FieldMeta[] = [
  {
    key: 'totalInvestment',
    kind: 'money',
    mutability: Mutability.WARM,
    labelKey: 'x',
    required: true,
  },
  {
    key: 'amountPerBuy',
    kind: 'money',
    mutability: Mutability.HOT,
    labelKey: 'x',
    required: true,
  },
  {
    key: 'maxNotionalCap',
    kind: 'money',
    mutability: Mutability.HOT,
    labelKey: 'x',
    required: false,
  },
  {
    key: 'takeProfitPct',
    kind: 'percent',
    mutability: Mutability.HOT,
    labelKey: 'x',
    required: true,
  },
  {
    key: 'numLimitBuys',
    kind: 'integer',
    mutability: Mutability.WARM,
    labelKey: 'x',
    required: true,
  },
  {
    key: 'volumeScale',
    kind: 'number',
    mutability: Mutability.WARM,
    labelKey: 'x',
    required: true,
  },
  {
    key: 'direction',
    kind: 'enum',
    mutability: Mutability.COLD,
    labelKey: 'x',
    required: true,
  },
  {
    key: 'leverage',
    kind: 'integer',
    mutability: Mutability.WARM,
    labelKey: 'x',
    required: true,
  },
  {
    key: 'marginMode',
    kind: 'enum',
    mutability: Mutability.COLD,
    labelKey: 'x',
    required: true,
  },
];

const ORIGINAL = {
  exchangeAccountId: 'acc-del-autor',
  symbol: 'BTC',
  direction: 'LONG',
  leverage: 3,
  marginMode: 'ISOLATED',
  totalInvestment: '10000',
  amountPerBuy: '500',
  maxNotionalCap: '25000',
  takeProfitPct: '1.5',
  numLimitBuys: 6,
  volumeScale: '1.6',
} as unknown as BotConfig;

describe('sanitizeForShare', () => {
  const shared = sanitizeForShare(ORIGINAL, FIELDS, 'MARTINGALE');

  it('no comparte con que cuenta ni en que par operaba el autor', () => {
    const blob = JSON.stringify(shared);
    expect(blob).not.toContain('acc-del-autor');
    expect(shared.params['exchangeAccountId']).toBeUndefined();
    expect(shared.params['symbol']).toBeUndefined();
  });

  it('no comparte el capital del autor de ninguna forma', () => {
    // Ni como parametro, ni como proporcion, ni como "referencia informativa".
    // Ese campo existia y devolvia el importe exacto con dos decimales, que es
    // precisamente lo que este codec existe para no revelar.
    expect(shared.params['totalInvestment']).toBeUndefined();
    expect(shared.ratios['totalInvestment']).toBeUndefined();
    expect(shared).not.toHaveProperty('originalInvestment');
    expect(JSON.stringify(shared)).not.toContain('10000');
  });

  it('descarta las claves sin metadatos en vez de publicarlas', () => {
    // Antes esto era una lista negra: lo que no se reconocia pasaba tal cual.
    // Un campo nuevo de una estrategia, o uno cuyos metadatos aun no existieran,
    // se publicaba entero con el importe que llevara dentro.
    const conExtra = sanitizeForShare(
      {
        ...ORIGINAL,
        campoDesconocido: '4321',
        apiSecretoDelAutor: 'no-deberia-salir',
      },
      FIELDS,
      'TDCA',
    );
    expect(conExtra.params['campoDesconocido']).toBeUndefined();
    expect(JSON.stringify(conExtra)).not.toContain('no-deberia-salir');
  });

  it('convierte los importes a proporcion del capital', () => {
    // 500 de 10.000 = 5 %; 25.000 de 10.000 = 250 %.
    expect(Number(shared.ratios['amountPerBuy'])).toBeCloseTo(0.05, 8);
    expect(Number(shared.ratios['maxNotionalCap'])).toBeCloseTo(2.5, 8);
  });

  it('deja intacto todo lo que define la FORMA de la estrategia', () => {
    // Porcentajes, multiplicadores y contadores son justo lo que se quiere
    // copiar: no dependen del tamano de la cuenta.
    expect(shared.params['takeProfitPct']).toBe('1.5');
    expect(shared.params['numLimitBuys']).toBe(6);
    expect(shared.params['volumeScale']).toBe('1.6');
    expect(shared.params['leverage']).toBe(3);
    expect(shared.params['direction']).toBe('LONG');
  });

  it('lleva version de formato', () => {
    expect(shared.v).toBe(1);
    expect(shared.strategy).toBe('MARTINGALE');
  });

  it('no revienta si el capital original era cero', () => {
    const zero = sanitizeForShare({ ...ORIGINAL, totalInvestment: '0' }, FIELDS, 'MARTINGALE');
    expect(zero.ratios['amountPerBuy']).toBe('0');
  });
});

describe('expandFromShare', () => {
  const shared = sanitizeForShare(ORIGINAL, FIELDS, 'MARTINGALE');

  it('redimensiona los importes al capital de quien copia', () => {
    // Quien copia pone 200: el 5 % son 10, no los 500 del autor.
    const copied = expandFromShare(shared, {
      exchangeAccountId: 'mi-cuenta',
      symbol: 'ETH',
      totalInvestment: '200',
    });
    expect(copied['amountPerBuy']).toBe('10.00');
    expect(copied['maxNotionalCap']).toBe('500.00');
    expect(copied['totalInvestment']).toBe('200.00');
  });

  it('usa la cuenta y el par de quien copia, no los del autor', () => {
    const copied = expandFromShare(shared, {
      exchangeAccountId: 'mi-cuenta',
      symbol: 'ETH',
      totalInvestment: '200',
    });
    expect(copied['exchangeAccountId']).toBe('mi-cuenta');
    expect(copied['symbol']).toBe('ETH');
  });

  it('conserva la forma de la estrategia sin escalarla', () => {
    const copied = expandFromShare(shared, {
      exchangeAccountId: 'mi-cuenta',
      symbol: 'ETH',
      totalInvestment: '200',
    });
    expect(copied['takeProfitPct']).toBe('1.5');
    expect(copied['numLimitBuys']).toBe(6);
    expect(copied['volumeScale']).toBe('1.6');
    expect(copied['leverage']).toBe(3);
  });

  it('ida y vuelta con el mismo capital reproduce el original', () => {
    const copied = expandFromShare(shared, {
      exchangeAccountId: 'acc-del-autor',
      symbol: 'BTC',
      totalInvestment: '10000',
    });
    expect(Number(copied['amountPerBuy'])).toBeCloseTo(500, 6);
    expect(Number(copied['maxNotionalCap'])).toBeCloseTo(25000, 6);
    expect(copied['takeProfitPct']).toBe('1.5');
  });

  it('mantiene la proporcion aunque el capital cambie de orden de magnitud', () => {
    const tiny = expandFromShare(shared, {
      exchangeAccountId: 'x',
      symbol: 'BTC',
      totalInvestment: '50',
    });
    const huge = expandFromShare(shared, {
      exchangeAccountId: 'x',
      symbol: 'BTC',
      totalInvestment: '500000',
    });
    expect(Number(tiny['amountPerBuy']) / 50).toBeCloseTo(0.05, 6);
    expect(Number(huge['amountPerBuy']) / 500000).toBeCloseTo(0.05, 6);
  });
});

describe('integracion con las estrategias reales', () => {
  it('el resultado de copiar sigue siendo valido para la estrategia', () => {
    // La prueba que de verdad importa: que lo copiado no solo tenga los numeros
    // bien, sino que pase la validacion de la estrategia como cualquier otra
    // configuracion creada a mano.
    const strategy = getStrategy('MARTINGALE');
    const config = {
      exchangeAccountId: 'acc-1',
      symbol: 'BTC',
      direction: 'LONG',
      leverage: 2,
      marginMode: 'ISOLATED',
      totalInvestment: '1000',
      numLimitBuys: 4,
      initialSeparationPct: '1',
      stepScale: '1.2',
      volumeScale: '1.6',
      takeProfitPct: '1',
    } as unknown as BotConfig;

    const blob = sanitizeForShare(config, strategy.meta.fields, 'MARTINGALE');
    const copied = expandFromShare(blob, {
      exchangeAccountId: 'acc-2',
      symbol: 'ETH',
      totalInvestment: '300',
    });

    const market = {
      venue: 'HYPERLIQUID' as const,
      symbol: 'ETH',
      canonical: 'ETH/USDC',
      base: 'ETH',
      quote: 'USDC',
      tickSize: '0.1',
      stepSize: '0.001',
      minNotional: '10',
      minQty: null,
      maxQty: null,
      maxLeverage: 25,
      priceDecimals: 1,
      qtyDecimals: 3,
      active: true,
    };

    expect(strategy.validate(copied, market).ok).toBe(true);
  });

  it('ningun campo monetario de ninguna estrategia se filtra en crudo', () => {
    // Barrido sobre las seis: si manana se anade una estrategia con un campo
    // `money` nuevo, este test lo detecta sin que haya que acordarse de nada.
    for (const kind of [
      'GRID_CLASSIC',
      'NEUTRAL_GRID',
      'TDCA',
      'MARTINGALE',
      'GRIDMART',
      'MARKET_MAKER',
    ] as const) {
      const strategy = getStrategy(kind);
      const config = {
        ...strategy.defaults(),
        exchangeAccountId: 'acc-1',
        symbol: 'BTC',
        totalInvestment: '1000',
        amountPerBuy: '100',
        orderSizePerSide: '100',
        maxBotPositionValue: '5000',
        maxNotionalCap: '3000',
      } as unknown as BotConfig;

      const blob = sanitizeForShare(config, strategy.meta.fields, kind);
      const moneyKeys = strategy.meta.fields
        .filter((f) => f.kind === 'money' && f.key !== 'totalInvestment')
        .map((f) => f.key);

      for (const key of moneyKeys) {
        if (config[key] === undefined) continue;
        expect(blob.params[key]).toBeUndefined();
        expect(blob.ratios[key]).toBeDefined();
      }
    }
  });
});
