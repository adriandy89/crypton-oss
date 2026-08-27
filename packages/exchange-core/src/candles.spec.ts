import { ExchangeError, type Candle } from '@crypton/shared';
import { checkInterval, finishCandles, resolveRange } from './candles';

/**
 * `resolveRange` y `finishCandles` no tenían ni un test, y la paginación del
 * gráfico hacia atrás depende ENTERA de ellos: uno deriva el principio del rango
 * a partir del final, y el otro decide por qué extremo se recorta cuando el
 * venue devuelve de más. Equivocar ese extremo no rompe nada visible — devuelve
 * velas correctas, solo que las de hace tres días.
 */

const SPAN = 900_000; // 15m
const AHORA = 1_700_000_100_000;

const vela = (t: number): Candle => ({ t, o: '1', h: '1', l: '1', c: '1', v: null });

describe('resolveRange', () => {
  it('deriva el principio desde el final cuando solo se da el límite', () => {
    const r = resolveRange('15m', { startMs: 0, endMs: AHORA, limit: 100 }, 5000, AHORA);

    // El `+1` no es un despiste: casi todos los venues incluyen la vela en
    // formación, así que pedir exactamente `limit` devuelve `limit - 1` cerradas.
    expect(r.endMs).toBe(AHORA);
    expect(r.startMs).toBe(AHORA - SPAN * 101);
    expect(r.limit).toBe(100);
  });

  it('respeta un endMs en el pasado: es como se pagina hacia atrás', () => {
    const fin = AHORA - 300 * SPAN;
    const r = resolveRange('15m', { startMs: 0, endMs: fin, limit: 300 }, 5000, AHORA);

    expect(r.endMs).toBe(fin);
    expect(r.startMs).toBe(fin - SPAN * 301);
  });

  it('acota el límite al máximo del venue', () => {
    // Lighter sirve 500 como mucho: pedirle 1500 devuelve 500 igualmente.
    const r = resolveRange('15m', { startMs: 0, endMs: AHORA, limit: 1500 }, 500, AHORA);
    expect(r.limit).toBe(500);
  });

  it('un límite absurdo no produce un rango absurdo', () => {
    expect(resolveRange('15m', { startMs: 0, endMs: AHORA, limit: 0 }, 5000, AHORA).limit).toBe(1);
    expect(resolveRange('15m', { startMs: 0, endMs: AHORA, limit: -5 }, 5000, AHORA).limit).toBe(1);
  });

  it('un startMs explícito manda sobre el derivado', () => {
    const r = resolveRange('15m', { startMs: 1000, endMs: AHORA, limit: 100 }, 5000, AHORA);
    expect(r.startMs).toBe(1000);
  });

  it('nunca devuelve un principio posterior al final', () => {
    const r = resolveRange('15m', { startMs: AHORA + 999, endMs: AHORA, limit: 10 }, 5000, AHORA);
    expect(r.startMs).toBeLessThanOrEqual(r.endMs);
  });
});

describe('finishCandles', () => {
  it('recorta por DELANTE y conserva las más recientes', () => {
    // Es la propiedad de la que depende paginar hacia atrás. Recortar por el
    // otro extremo devolvería velas perfectamente válidas... de hace tres días,
    // y el gráfico terminaría en el pasado sin que nada pareciera fallar.
    const entrada = Array.from({ length: 10 }, (_, i) => vela(AHORA + i * SPAN));

    const salida = finishCandles(entrada, 3);

    expect(salida).toHaveLength(3);
    expect(salida[0]!.t).toBe(AHORA + 7 * SPAN);
    expect(salida[2]!.t).toBe(AHORA + 9 * SPAN);
  });

  it('ordena una serie que llega al revés', () => {
    // Bybit sirve su lista en orden inverso, y un venue puede cambiar de opinión.
    const salida = finishCandles([vela(300), vela(100), vela(200)], 10);
    expect(salida.map((c) => c.t)).toEqual([100, 200, 300]);
  });

  it('quita duplicados quedándose con el último', () => {
    const salida = finishCandles([{ ...vela(100), c: '1' }, { ...vela(100), c: '9' }], 10);
    expect(salida).toHaveLength(1);
    expect(salida[0]!.c).toBe('9');
  });

  it('descarta velas con tiempo no finito en vez de propagarlas', () => {
    const salida = finishCandles([vela(100), { ...vela(NaN) }, vela(200)], 10);
    expect(salida.map((c) => c.t)).toEqual([100, 200]);
  });

  it('una serie más corta que el tope pasa entera', () => {
    expect(finishCandles([vela(100), vela(200)], 10)).toHaveLength(2);
  });
});

describe('checkInterval', () => {
  it('devuelve el intervalo estrechado a la lista del venue', () => {
    expect(checkInterval('HYPERLIQUID', ['1m', '15m'] as const, '15m')).toBe('15m');
  });

  it('un intervalo no soportado falla con la lista de los que sí, y como RULES', () => {
    // RULES y no FATAL: no es un fallo del venue ni de la red, es una petición
    // que incumple una regla conocida. Así no se reintenta sola.
    try {
      checkInterval('LIGHTER', ['1m', '15m'] as const, '8h');
      throw new Error('debería haber lanzado');
    } catch (e) {
      expect(e).toBeInstanceOf(ExchangeError);
      expect((e as ExchangeError).kind).toBe('RULES');
      expect((e as Error).message).toContain('1m, 15m');
    }
  });
});
