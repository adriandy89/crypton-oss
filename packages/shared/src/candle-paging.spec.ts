import {
  applyHistoryPage,
  historyStateOf,
  nextHistoryRequest,
  type HistoryLimits,
} from './candle-paging';
import type { Candle } from './candle';

const SPAN = 900_000; // 15m
const LIMITS: HistoryLimits = {
  interval: '15m',
  pageBars: 300,
  maxBars: 3000,
  maxPages: 9,
};

/** `n` velas consecutivas que TERMINAN en `endT` (inclusive). */
const serie = (endT: number, n: number): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const t = endT - (n - 1 - i) * SPAN;
    return { t, o: '1', h: '1', l: '1', c: '1', v: null };
  });

const T0 = 1_700_000_000_000 - (1_700_000_000_000 % SPAN);

describe('nextHistoryRequest', () => {
  it('pide desde la vela más antigua, sin restarle nada', () => {
    // `quantizeEnd` redondea hacia abajo al cierre de vela: `t` es la identidad,
    // mientras que `t - 1` caería al bucket anterior y generaría una SEGUNDA
    // entrada de caché para la misma ventana.
    const state = historyStateOf(serie(T0, 300));
    expect(nextHistoryRequest(state, LIMITS)).toEqual({
      endMs: T0 - 299 * SPAN,
      limit: 300,
    });
  });

  it('el tamaño de página es un escalón que el servidor admite', () => {
    // Pedir 250 costaría la misma llamada al venue que 300 y generaría una
    // entrada de caché que no comparte nadie.
    const pasos = [2, 50, 150, 300, 600, 1000, 1500];
    expect(pasos).toContain(LIMITS.pageBars);
  });

  it('no pide nada sin serie: la carga inicial es de otro camino', () => {
    expect(nextHistoryRequest(historyStateOf([]), LIMITS)).toBeNull();
  });

  it('no pide nada cuando ya no hay más, ni al llegar al techo', () => {
    const base = historyStateOf(serie(T0, 300));
    expect(nextHistoryRequest({ ...base, noMore: true }, LIMITS)).toBeNull();
    expect(nextHistoryRequest({ ...base, capped: true }, LIMITS)).toBeNull();
  });
});

describe('applyHistoryPage', () => {
  const inicial = () => historyStateOf(serie(T0, 300));

  it('una página vacía es el muro del venue, no un fallo', () => {
    // Medido contra Hyperliquid: pasadas las 5000 velas del intervalo devuelve
    // array vacío, no un error.
    const next = applyHistoryPage(inicial(), [], LIMITS);
    expect(next.noMore).toBe(true);
    expect(next.bars).toHaveLength(300);
    expect(next.pages).toBe(0);
  });

  it('el solape de una vela no duplica y deja la serie ascendente', () => {
    const state = inicial();
    const primera = state.bars[0].t;
    // El `endTime` del venue es inclusivo, así que vuelve la vela frontera.
    const page = serie(primera, 300);

    const next = applyHistoryPage(state, page, LIMITS);

    expect(next.bars).toHaveLength(599);
    expect(next.pages).toBe(1);
    const tiempos = next.bars.map((c) => c.t);
    expect(tiempos).toEqual([...tiempos].sort((a, b) => a - b));
    expect(new Set(tiempos).size).toBe(tiempos.length);
  });

  it('una página exactamente contigua, sin solape, también encaja', () => {
    const state = inicial();
    const page = serie(state.bars[0].t - SPAN, 300);

    const next = applyHistoryPage(state, page, LIMITS);

    expect(next.bars).toHaveLength(600);
    expect(next.noMore).toBe(false);
  });

  it('una página con un agujero NO se pega', () => {
    // Pegarla movería los marcadores de ejecución al lado equivocado del hueco:
    // `bucketOf` los coloca por bisección sobre los timestamps de las barras.
    const state = inicial();
    const page = serie(state.bars[0].t - 10 * SPAN, 300);

    const next = applyHistoryPage(state, page, LIMITS);

    expect(next.noMore).toBe(true);
    expect(next.bars).toHaveLength(300);
  });

  it('una página que no aporta nada nuevo corta el bucle', () => {
    // Un venue que devuelve siempre la misma ventana haría que el gráfico
    // pidiera sin parar mientras el usuario siguiera arrastrando.
    const state = inicial();
    const next = applyHistoryPage(state, state.bars.slice(0, 50), LIMITS);

    expect(next.noMore).toBe(true);
    expect(next.pages).toBe(0);
  });

  it('lo que ya había manda sobre lo que llega', () => {
    // La cola lleva la vela en formación y los precios más frescos; una página
    // de pasado no sabe nada de eso.
    const state = historyStateOf(serie(T0, 10));
    const viva = state.bars[0];
    const page = serie(viva.t, 10).map((c) => ({ ...c, c: '999' }));

    const next = applyHistoryPage(state, page, LIMITS);

    expect(next.bars.find((c) => c.t === viva.t)!.c).toBe('1');
  });

  it('sin serie previa, la página se adopta entera', () => {
    const next = applyHistoryPage(historyStateOf([]), serie(T0, 300), LIMITS);
    expect(next.bars).toHaveLength(300);
    expect(next.pages).toBe(1);
  });

  describe('techos', () => {
    it('al pasar el techo de barras deja de pedirse, y NO se recorta la cola', () => {
      // Recortar por la derecha rompería `liveBar`, la distancia a liquidación y
      // el plegado de ticks, que dependen de que la cola esté al día.
      const limits = { ...LIMITS, maxBars: 400 };
      const state = historyStateOf(serie(T0, 300));
      const ultima = state.bars.at(-1)!.t;

      const next = applyHistoryPage(state, serie(state.bars[0].t - SPAN, 300), limits);

      expect(next.capped).toBe(true);
      expect(next.bars).toHaveLength(600);
      expect(next.bars.at(-1)!.t).toBe(ultima);
      expect(nextHistoryRequest(next, limits)).toBeNull();
    });

    it('el techo de páginas es la segunda red', () => {
      const limits = { ...LIMITS, maxPages: 1 };
      const next = applyHistoryPage(
        historyStateOf(serie(T0, 300)),
        serie(T0 - 300 * SPAN, 300),
        limits,
      );
      expect(next.capped).toBe(true);
    });
  });

  it('paginar varias veces seguidas encadena sin huecos ni duplicados', () => {
    let state = historyStateOf(serie(T0, 300));

    for (let i = 0; i < 5; i++) {
      const req = nextHistoryRequest(state, LIMITS)!;
      expect(req).not.toBeNull();
      state = applyHistoryPage(state, serie(req.endMs, req.limit), LIMITS);
    }

    expect(state.pages).toBe(5);
    expect(state.bars).toHaveLength(300 + 5 * 299);
    const tiempos = state.bars.map((c) => c.t);
    expect(new Set(tiempos).size).toBe(tiempos.length);
    // Y estrictamente contiguas: un hueco aquí sería un fallo de paginación.
    for (let i = 1; i < tiempos.length; i++) {
      expect(tiempos[i] - tiempos[i - 1]).toBe(SPAN);
    }
  });
});
