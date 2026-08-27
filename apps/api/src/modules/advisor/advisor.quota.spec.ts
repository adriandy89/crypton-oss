import { StrategyKind } from '@crypton/db';
import type { Candle, MarketSpec } from '@crypton/shared';
import { ConfigService } from '@nestjs/config';
import type { CacheService } from 'src/libs';
import { AdvisorService } from './advisor.service';
import type { MarketDataService } from '../market-data';
import type { MarketsService } from '../markets';
import type { RiskService } from '../risk';
import type { OpenRouterClient } from './openrouter.client';

/**
 * El cupo diario del asistente.
 *
 * Lo que se prueba aqui es lo unico de esta funcionalidad que tiene una FACTURA
 * detras. El resto degrada: si el modelo falla, salen las reglas y no pasa nada.
 * Si el cupo no cuenta bien, lo que sale es una factura de OpenRouter, y eso no
 * se nota mirando la aplicacion — se nota a fin de mes.
 *
 * Tres invariantes, en este orden de importancia:
 *
 *   1. Un acierto de cache NO gasta cupo. Es lo que hace que mirar el mismo par
 *      veinte veces sea gratis, y es la mitad del diseño.
 *   2. Se apunta ANTES de llamar. Contar solo los exitos convertiria el tope de
 *      veinte en un tope de veinte POR RAFAGA.
 *   3. Sin contador —Redis caido— se NIEGA. Es lo contrario de lo que hace el
 *      resto del cache, y a proposito: sin contador no hay tope.
 */

const MERCADO: MarketSpec = {
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
};

/**
 * Serie sintetica con recorrido real.
 *
 * Tiene que moverse: `buildFeatures` devuelve `null` con menos de treinta velas,
 * y una serie plana da volatilidad cero, que es el camino por el que el servicio
 * se rinde antes de llegar al cupo — el test pasaria sin probar nada.
 */
const velas = (n: number): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const c = 64000 * (1 + 0.01 * Math.sin(i / 3));
    return {
      t: i * 3_600_000,
      o: String(c),
      h: String(c * 1.004),
      l: String(c * 0.996),
      c: String(c),
      v: '10',
    };
  });

interface Fakes {
  cache: CacheService;
  modelo: OpenRouterClient;
  llamadas: () => number;
  contador: () => number;
}

function montar(opts: {
  disponible?: boolean;
  limite?: string;
  cacheado?: boolean;
  /** Lo que devuelve `incrWithExpire`: -1 simula Redis caido. */
  usosPrevios?: number;
}): { service: AdvisorService } & Fakes {
  let llamadas = 0;
  let contador = 0;

  const cache = {
    get: jest.fn(async () => (opts.cacheado ? PERILLAS : null)),
    set: jest.fn(async () => undefined),
    incrWithExpire: jest.fn(async () => {
      if (opts.usosPrevios === -1) return -1;
      contador++;
      return (opts.usosPrevios ?? 0) + contador;
    }),
  } as unknown as CacheService;

  const modelo = {
    available: opts.disponible ?? true,
    knobsFor: jest.fn(async () => {
      llamadas++;
      return PERILLAS;
    }),
  } as unknown as OpenRouterClient;

  const markets = {
    getSpec: async () => MERCADO,
  } as unknown as MarketsService;

  const marketData = {
    candles: async () => velas(300),
    tickers: async () => [{ symbol: 'BTC', last: '64000' }],
  } as unknown as MarketDataService;

  const risk = {
    get: async () => ({
      max_leverage: null,
      max_notional_per_bot: null,
      max_total_notional: null,
    }),
    currentTotalNotional: async () => 0,
  } as unknown as RiskService;

  const config = {
    get: (k: string, def?: string) =>
      k === 'AI_ADVISOR_DAILY_LIMIT' ? (opts.limite ?? '20') : def,
  } as unknown as ConfigService;

  return {
    service: new AdvisorService(markets, marketData, risk, cache, modelo, config),
    cache,
    modelo,
    llamadas: () => llamadas,
    contador: () => contador,
  };
}

const perilla = (profile: string) => ({
  knobs: {
    profile,
    leverage: 'MEDIA',
    coverage: 'MEDIA',
    spread: 'MEDIA',
    sizeGrowth: 'MEDIA',
    cadence: 'MEDIA',
  },
  rationale: 'Porque encaja con este mercado.',
});

const PERILLAS = [perilla('PRUDENTE'), perilla('EQUILIBRADA'), perilla('AGRESIVA')] as never;

const pedir = (s: AdvisorService, userId = 'u1') =>
  s.suggest(userId, {
    venue: 'HYPERLIQUID',
    symbol: 'BTC',
    strategy: StrategyKind.GRID_CLASSIC,
    totalInvestment: '1000',
  });

describe('cupo diario del asistente', () => {
  it('una respuesta cacheada no gasta cupo', async () => {
    const { service, cache, llamadas } = montar({ cacheado: true });
    const r = await pedir(service);

    expect(llamadas()).toBe(0);
    expect(cache.incrWithExpire).not.toHaveBeenCalled();
    expect(r.source).toBe('IA');
    expect(r.notice).toBeNull();
  });

  it('se apunta el uso ANTES de llamar al modelo', async () => {
    const { service, contador, llamadas } = montar({});
    await pedir(service);

    // Si se contara despues, un fallo del modelo saldria gratis y veinte
    // peticiones a la vez pasarian todas la comprobacion.
    expect(contador()).toBe(1);
    expect(llamadas()).toBe(1);
  });

  it('con el cupo agotado sirve reglas y lo dice', async () => {
    const { service, llamadas } = montar({ limite: '20', usosPrevios: 20 });
    const r = await pedir(service);

    expect(llamadas()).toBe(0);
    expect(r.source).toBe('REGLAS');
    expect(r.profiles).toHaveLength(3);
    expect(r.notice).toContain('agotado');
  });

  it('el uso numero 20 todavia entra; el 21 ya no', async () => {
    const dentro = montar({ limite: '20', usosPrevios: 19 });
    await pedir(dentro.service);
    expect(dentro.llamadas()).toBe(1);

    const fuera = montar({ limite: '20', usosPrevios: 20 });
    await pedir(fuera.service);
    expect(fuera.llamadas()).toBe(0);
  });

  it('sin contador se niega el uso en vez de abrir la mano', async () => {
    // Redis caido. El resto del cache degrada dejando pasar; aqui NO, porque lo
    // que hay al otro lado es una llamada pagada sin ningun tope.
    const { service, llamadas } = montar({ usosPrevios: -1 });
    const r = await pedir(service);

    expect(llamadas()).toBe(0);
    expect(r.source).toBe('REGLAS');
    expect(r.profiles).toHaveLength(3);
  });

  it('un limite VACIO no es un cero: cae al valor por defecto', async () => {
    // `Number('')` devuelve 0, no NaN. Sin la distincion, un
    // `AI_ADVISOR_DAILY_LIMIT=` sin valor —el estado normal de un .env a medio
    // rellenar— apagaba el asistente entero en silencio.
    const { service, llamadas } = montar({ limite: '' });
    await pedir(service);
    expect(llamadas()).toBe(1);
  });

  it('un limite que no es un numero se trata como errata, no como orden', async () => {
    const { service, llamadas } = montar({ limite: 'veinte' });
    await pedir(service);
    expect(llamadas()).toBe(1);
  });

  it('un limite de cero apaga el modelo del todo', async () => {
    const { service, llamadas } = montar({ limite: '0' });
    const r = await pedir(service);

    expect(llamadas()).toBe(0);
    expect(r.profiles).toHaveLength(3);
  });

  it('con el modelo apagado no se toca el contador ni se avisa de cupo', async () => {
    // Sin clave configurada no hay cupo que agotar: hablar de «usos agotados»
    // ahi seria mentir sobre algo que nunca estuvo encendido.
    const { service, cache } = montar({ disponible: false });
    const r = await pedir(service);

    expect(cache.incrWithExpire).not.toHaveBeenCalled();
    expect(r.source).toBe('REGLAS');
    expect(r.notice ?? '').not.toContain('agotado');
  });

  it('el contador es por usuario y por dia', async () => {
    const { service, cache } = montar({});
    await pedir(service, 'usuario-7');

    const clave = (cache.incrWithExpire as jest.Mock).mock.calls[0][0] as string;
    expect(clave).toContain('usuario-7');
    expect(clave).toMatch(/\d{4}-\d{2}-\d{2}$/);
    // Un dia de caducidad: sin ella la clave viviria para siempre y el cupo no
    // se renovaria nunca.
    expect((cache.incrWithExpire as jest.Mock).mock.calls[0][1]).toBe(86_400);
  });
});
