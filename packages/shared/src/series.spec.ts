import { D } from './money';
import {
  SNAPSHOT_CADENCE_MS,
  SERIES_POINTS,
  alMinuto,
  bucketMsFor,
  costeDeComisionesPct,
  enMercadoPct,
  gapMsFor,
  indiceDePeorCaida,
  muestreoPorExtremos,
  repartoDeEjecucion,
  repartoPorSimbolo,
  resumenDeCiclos,
  sumaExacta,
  trazosDeSerie,
  vistaDeSerie,
  type SeriePunto,
} from './series';

const MIN = 60_000;
const HORA = 60 * MIN;
const T0 = 1_700_000_000_000;

/** `n` puntos a un minuto, con el valor que diga `f`. */
const serie = (n: number, f: (i: number) => number | string): SeriePunto[] =>
  Array.from({ length: n }, (_, i) => ({ t: T0 + i * MIN, v: String(f(i)) }));

/**
 * Generador determinista para los paseos aleatorios: un test que dependa de
 * `Math.random` falla un día de cada mil y nadie sabe por qué.
 */
const lcg = (semilla: number) => {
  let s = semilla >>> 0;
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0;
    return s / 0x1_0000_0000;
  };
};

describe('bucketMsFor y gapMsFor', () => {
  it('480 puntos son 120 cubos de cuatro filas, y dividen exacto 24 h, 7 d y 30 d', () => {
    const cubos = SERIES_POINTS / 4;
    expect(bucketMsFor(0, 24 * HORA, cubos)).toBe(12 * MIN);
    expect(bucketMsFor(0, 7 * 24 * HORA, cubos)).toBe(84 * MIN);
    expect(bucketMsFor(0, 30 * 24 * HORA, cubos)).toBe(360 * MIN);
  });

  it('nunca baja de la cadencia de escritura', () => {
    // 1 h en 120 cubos serían cubos de 30 s sobre una tabla que escribe cada
    // minuto: puros cubos vacíos. Se sube a un minuto.
    expect(bucketMsFor(0, HORA, 120)).toBe(SNAPSHOT_CADENCE_MS);
  });

  it('redondea a minutos enteros hacia arriba, para no pasarse de cubos', () => {
    // 100 min en 7 cubos = 14,28 min -> 15 min (7 cubos), no 14 (8 cubos).
    expect(bucketMsFor(0, 100 * MIN, 7)).toBe(15 * MIN);
  });

  it('el umbral de hueco crece con el cubo y nunca baja de tres cadencias', () => {
    // Con cubos de 90 min las cuatro filas que sobreviven pueden distar casi
    // hora y media sin que el bot haya parado: el umbral tiene que superarlo.
    expect(gapMsFor(SNAPSHOT_CADENCE_MS)).toBe(3 * MIN);
    expect(gapMsFor(90 * MIN)).toBe(180 * MIN);
  });

  it('con otra cadencia, el suelo del umbral son tres pasos de esa cadencia', () => {
    // La cartera escribe cada cinco minutos: dos filas seguidas distan cinco, y
    // con el umbral del bot (3 min) TODA la curva sería huecos.
    expect(gapMsFor(5 * MIN, 5 * MIN)).toBe(15 * MIN);
    expect(gapMsFor(73 * 60 * MIN, 5 * MIN)).toBe(146 * 60 * MIN);
  });

  it('alMinuto redondea hacia abajo al minuto', () => {
    const M0 = T0 - (T0 % MIN);
    expect(alMinuto(M0 + 59_999)).toBe(M0);
    expect(alMinuto(M0 + 60_000)).toBe(M0 + 60_000);
  });
});

describe('muestreoPorExtremos', () => {
  const valor = (p: SeriePunto) => D(p.v);
  const tiempo = (p: SeriePunto) => p.t;

  it('la punta profunda sobrevive con cualquier tope: es la razón de la función', () => {
    // Serie plana en 100 con UNA sola caída a 3 en el punto 1234. Un muestreo
    // cada N la borra en casi todos los topes; este la conserva en todos.
    const s = serie(5000, (i) => (i === 1234 ? 3 : 100));
    for (const max of [8, 40, 200, 1000]) {
      const out = muestreoPorExtremos(s, max, valor, tiempo);
      expect(out.some((p) => p.v === '3')).toBe(true);
      expect(out.length).toBeLessThanOrEqual(max);
    }
  });

  it('conserva el mínimo y el máximo de un paseo aleatorio', () => {
    const rnd = lcg(7);
    let v = 1000;
    const s = serie(10_000, () => {
      v += (rnd() - 0.5) * 20;
      return v.toFixed(4);
    });
    const out = muestreoPorExtremos(s, 480, valor, tiempo);
    const min = (xs: readonly SeriePunto[]) =>
      xs.reduce((m, p) => (D(p.v).lt(m) ? D(p.v) : m), D(xs[0].v));
    const max = (xs: readonly SeriePunto[]) =>
      xs.reduce((m, p) => (D(p.v).gt(m) ? D(p.v) : m), D(xs[0].v));
    expect(min(out).toFixed()).toBe(min(s).toFixed());
    expect(max(out).toFixed()).toBe(max(s).toFixed());
    expect(out.length).toBeLessThanOrEqual(480);
  });

  it('el tiempo sale estrictamente creciente y sin repetidos', () => {
    // El motor gráfico LANZA con tiempos repetidos o desordenados: aquí es
    // donde hay que garantizar que no ocurre.
    const rnd = lcg(11);
    const s = serie(3000, () => (rnd() * 100).toFixed(2));
    const out = muestreoPorExtremos(s, 100, valor, tiempo);
    for (let i = 1; i < out.length; i++) expect(out[i].t).toBeGreaterThan(out[i - 1].t);
  });

  it('es la identidad cuando la serie ya cabe', () => {
    const s = serie(50, (i) => i);
    expect(muestreoPorExtremos(s, 100, valor, tiempo)).toBe(s);
    expect(muestreoPorExtremos(s, 50, valor, tiempo)).toBe(s);
  });

  it('una serie plana se queda corta, nunca larga', () => {
    const s = serie(1000, () => 5);
    const out = muestreoPorExtremos(s, 8, valor, tiempo);
    expect(out.length).toBeLessThanOrEqual(8);
    expect(out.length).toBeGreaterThan(0);
  });

  it('con menos de 4 como tope se sube a 4 y no se rompe', () => {
    const s = serie(100, (i) => i);
    expect(muestreoPorExtremos(s, 1, valor, tiempo).length).toBeLessThanOrEqual(4);
  });
});

describe('vistaDeSerie', () => {
  const OPTS = { maxPuntos: 480, gapMs: 3 * MIN };

  it('el dinero se suma exacto: 0,1 + 0,2 es 0,3, no 0,30000000000000004', () => {
    const vista = vistaDeSerie(
      [
        { t: T0, v: '0.1' },
        { t: T0 + MIN, v: '0.4' },
      ],
      OPTS,
    );
    expect(vista?.delta).toBe('0.3');
    expect(vista?.primero).toBe('0.1');
    expect(vista?.ultimo).toBe('0.4');
  });

  it('ordena ascendente y se queda con la última escritura de un mismo instante', () => {
    // La API sirve de más nuevo a más viejo. Y ante dos filas del mismo minuto,
    // manda la que llegó después.
    const vista = vistaDeSerie(
      [
        { t: T0 + 2 * MIN, v: '3' },
        { t: T0, v: '1' },
        { t: T0 + MIN, v: '2' },
        { t: T0 + MIN, v: '20' },
      ],
      OPTS,
    );
    expect(vista?.en).toEqual([T0, T0 + MIN, T0 + 2 * MIN]);
    expect(vista?.puntos).toEqual([1, 20, 3]);
    expect(vista?.total).toBe(3);
  });

  it('la peor caída es de pico a valle, no máximo menos mínimo', () => {
    // 10 → 50 → 20 → 60. El mínimo (10) ocurre ANTES del máximo (60): esa
    // diferencia de 50 no es una caída. La caída real es 50 → 20 = 30.
    const vista = vistaDeSerie(
      serie(4, (i) => [10, 50, 20, 60][i]),
      OPTS,
    );
    expect(vista?.peorCaida).toBe('30');
    expect(vista?.peorCaidaEn).toBe(T0 + 2 * MIN);
    expect(vista?.minimo).toBe('10');
    expect(vista?.maximo).toBe('60');
    expect(vista?.minEn).toBe(T0);
    expect(vista?.maxEn).toBe(T0 + 3 * MIN);
  });

  it('sin caída, la peor caída es cero y no tiene instante', () => {
    const vista = vistaDeSerie(
      serie(5, (i) => i),
      OPTS,
    );
    expect(vista?.peorCaida).toBe('0');
    expect(vista?.peorCaidaEn).toBeNull();
  });

  it('un salto mayor que gapMs es un hueco y parte la línea', () => {
    const s = [
      ...serie(5, () => 1),
      ...serie(5, () => 2).map((p) => ({ ...p, t: p.t + 60 * MIN })),
    ];
    const vista = vistaDeSerie(s, OPTS);
    expect(vista?.huecos).toEqual([{ desde: T0 + 4 * MIN, hasta: T0 + 60 * MIN }]);
    // La línea se corta tras el último punto antes del hueco (índice 4).
    expect(vista?.cortes).toEqual([4]);
  });

  it('dos huecos, dos cortes, en orden y sin repetir', () => {
    const s = [
      ...serie(3, () => 1),
      ...serie(3, () => 2).map((p) => ({ ...p, t: p.t + 60 * MIN })),
      ...serie(3, () => 3).map((p) => ({ ...p, t: p.t + 120 * MIN })),
    ];
    expect(vistaDeSerie(s, OPTS)?.cortes).toEqual([2, 5]);
  });

  it('los huecos se miden sobre la serie completa, no sobre la muestreada', () => {
    // 5000 puntos continuos a un minuto muestreados a 8: los puntos elegidos
    // distan horas entre sí, pero NO hay hueco alguno.
    const vista = vistaDeSerie(
      serie(5000, (i) => i),
      { maxPuntos: 8, gapMs: 3 * MIN },
    );
    expect(vista?.huecos).toEqual([]);
    expect(vista?.cortes).toEqual([]);
    expect(vista?.descartados).toBe(5000 - (vista?.puntos.length ?? 0));
  });

  it('una serie agregada a cubos grandes NO se parte si el umbral es el del cubo', () => {
    // Lo que llegaría del servidor para 30 d: cuatro filas por cubo de 90 min,
    // separadas hasta 89 min. Con el umbral de la serie cruda (3 min) serían
    // cientos de huecos falsos; con el del cubo, ninguno.
    const cubo = 90 * MIN;
    const s: SeriePunto[] = [];
    for (let c = 0; c < 20; c++) {
      const t = T0 + c * cubo;
      s.push(
        { t, v: '1' },
        { t: t + 7 * MIN, v: '0' },
        { t: t + 60 * MIN, v: '2' },
        { t: t + 89 * MIN, v: '1' },
      );
    }
    expect(vistaDeSerie(s, { maxPuntos: 480, gapMs: 3 * MIN })?.huecos.length).toBeGreaterThan(10);
    expect(vistaDeSerie(s, { maxPuntos: 480, gapMs: gapMsFor(cubo) })?.huecos).toEqual([]);
  });

  it('las cifras salen de la serie COMPLETA aunque el muestreo descarte puntos', () => {
    const s = serie(5000, (i) => (i === 2222 ? -7 : 100));
    const vista = vistaDeSerie(s, { maxPuntos: 8, gapMs: 3 * MIN });
    expect(vista?.minimo).toBe('-7');
    expect(vista?.minEn).toBe(T0 + 2222 * MIN);
    expect(vista?.peorCaida).toBe('107');
  });

  it('descarta lo que no es un número en vez de lanzar', () => {
    const vista = vistaDeSerie(
      [
        { t: T0, v: '' },
        { t: T0 + MIN, v: 'NaN' },
        { t: T0 + 2 * MIN, v: '5' },
      ],
      OPTS,
    );
    expect(vista?.puntos).toEqual([5]);
    expect(vista?.total).toBe(1);
  });

  it('devuelve null con una serie vacía', () => {
    expect(vistaDeSerie([], OPTS)).toBeNull();
    expect(vistaDeSerie([{ t: T0, v: '' }], OPTS)).toBeNull();
  });

  it('indiceDePeorCaida apunta al punto pintado más cercano al fondo', () => {
    const vista = vistaDeSerie(
      serie(4, (i) => [10, 50, 20, 60][i]),
      OPTS,
    );
    expect(vista && indiceDePeorCaida(vista)).toBe(2);
    const sinCaida = vistaDeSerie(
      serie(3, (i) => i),
      OPTS,
    );
    expect(sinCaida && indiceDePeorCaida(sinCaida)).toBeNull();
  });
});

describe('trazosDeSerie', () => {
  const xs = (d: string): number[] =>
    [...d.matchAll(/[ML]\s?(-?[\d.]+),/g)].map((m) => Number(m[1]));
  const ys = (d: string): number[] => [...d.matchAll(/,(-?[\d.]+)/g)].map((m) => Number(m[1]));

  it('la X es monótona creciente y ocupa el ancho entero', () => {
    const { linea } = trazosDeSerie([1, 2, 3, 4, 5], { alto: 20, min: 1, max: 5 });
    const x = xs(linea);
    for (let i = 1; i < x.length; i++) expect(x[i]).toBeGreaterThan(x[i - 1]);
    expect(x[0]).toBe(0);
    expect(x[x.length - 1]).toBe(100);
  });

  it('la Y va invertida: el máximo arriba', () => {
    // El error de signo pinta la curva del revés y NADIE lo nota en una
    // miniserie de 16 px.
    const { linea, coords } = trazosDeSerie([0, 10], { alto: 20, min: 0, max: 10 });
    const y = ys(linea);
    expect(y[0]).toBe(20);
    expect(y[1]).toBe(0);
    // Y las coordenadas que se devuelven son LAS MISMAS que se dibujan.
    expect(coords).toEqual([
      { x: 0, y: 20 },
      { x: 100, y: 0 },
    ]);
  });

  it('un corte emite un segundo M y el área se cierra por tramos', () => {
    const { linea, area } = trazosDeSerie([1, 2, 3, 4], { alto: 10, min: 1, max: 4, cortes: [1] });
    expect(linea.match(/M/g)).toHaveLength(2);
    expect(area.match(/Z/g)).toHaveLength(2);
  });

  it('la base amplía el rango y es hasta donde se rellena el área', () => {
    // Serie toda negativa con base en cero: el cero tiene que verse, y el
    // relleno tiene que llegar al cero, no al suelo.
    const { area, baseY } = trazosDeSerie([-40, -10], { alto: 100, min: -40, max: -10, base: 0 });
    expect(baseY).toBe(0);
    expect(area.endsWith(',0 Z')).toBe(true);
    const { baseY: dentro } = trazosDeSerie([-40, 10], { alto: 100, min: -40, max: 10, base: 0 });
    expect(dentro).toBe(20);
  });

  it('una serie plana se dibuja a media altura, sin dividir por cero', () => {
    const { linea } = trazosDeSerie([5, 5, 5], { alto: 30, min: 5, max: 5 });
    expect(ys(linea).every((y) => y === 15)).toBe(true);
  });

  it('un solo punto sale como segmento de longitud cero, centrado', () => {
    const { linea } = trazosDeSerie([3], { alto: 10, min: 0, max: 10 });
    expect(linea).toBe('M50,7 L50,7');
  });

  it('sin puntos no hay trazo', () => {
    expect(trazosDeSerie([], { alto: 10, min: 0, max: 1 })).toEqual({
      linea: '',
      area: '',
      baseY: null,
      coords: [],
    });
  });
});

describe('sumaExacta', () => {
  it('suma cadenas de dinero sin coma flotante', () => {
    expect(sumaExacta(['0.1', '0.2'])).toBe('0.3');
    expect(sumaExacta(['58.20', '-46.10', '7.40'])).toBe('19.5');
    expect(sumaExacta([])).toBe('0');
  });
});

describe('resumenDeCiclos', () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  const ciclo = (seq: number, abre: number, cierra: number | null, pnl: string, fees = '0.1') => ({
    seq,
    opened_at: iso(abre),
    closed_at: cierra === null ? null : iso(cierra),
    realized_pnl: pnl,
    fees,
  });

  it('solo cuenta los cerrados, y en orden de cierre', () => {
    const r = resumenDeCiclos([
      ciclo(3, T0, T0 + HORA, '2'),
      ciclo(1, T0, T0 + 2 * HORA, '-1'),
      ciclo(4, T0, null, '99'),
    ]);
    expect(r.cerrados).toBe(2);
    expect(r.barras).toEqual([-1, 2]);
  });

  it('suma neto y comisiones con Decimal', () => {
    const r = resumenDeCiclos([
      ciclo(1, T0, T0 + HORA, '0.1', '0.1'),
      ciclo(2, T0, T0 + HORA, '0.2', '0.2'),
    ]);
    expect(r.neto).toBe('0.3');
    expect(r.comisiones).toBe('0.3');
    expect(r.beneficioMedio).toBe('0.15');
  });

  it('acierto en % y duración MEDIANA, no media', () => {
    // Tres ciclos de una hora y uno de tres días: la mediana sigue diciendo
    // «una hora», que es lo normal; la media diría veinte horas.
    const r = resumenDeCiclos([
      ciclo(1, T0, T0 + HORA, '1'),
      ciclo(2, T0, T0 + HORA, '1'),
      ciclo(3, T0, T0 + HORA, '-1'),
      ciclo(4, T0, T0 + 72 * HORA, '1'),
    ]);
    expect(r.aciertoPct).toBe('75.00');
    expect(r.duracionMedianaMs).toBe(HORA);
  });

  it('sin ciclos cerrados, sin cifras inventadas', () => {
    const r = resumenDeCiclos([ciclo(1, T0, null, '5')]);
    expect(r.cerrados).toBe(0);
    expect(r.aciertoPct).toBeNull();
    expect(r.beneficioMedio).toBeNull();
    expect(r.duracionMedianaMs).toBeNull();
    expect(r.neto).toBe('0');
  });
});

describe('costeDeComisionesPct, repartoDeEjecucion y enMercadoPct', () => {
  it('las comisiones sobre lo capturado, y null cuando no hay captura', () => {
    expect(costeDeComisionesPct('58.2', '13.2')).toBe('18.5');
    expect(costeDeComisionesPct('-5', '2')).toBeNull();
    expect(costeDeComisionesPct('10', '0')).toBeNull();
  });

  it('el reparto maker/taker en % con un decimal', () => {
    expect(repartoDeEjecucion({ makerFills: 87, takerFills: 13 })).toEqual({
      maker: 87,
      taker: 13,
      makerPct: '87.0',
    });
    expect(repartoDeEjecucion({ makerFills: 0, takerFills: 0 }).makerPct).toBeNull();
  });

  it('en mercado: fracción de puntos con posición', () => {
    expect(enMercadoPct(['0', '1', '0.5', '0'])).toBe('50');
    expect(enMercadoPct([])).toBeNull();
  });
});

describe('repartoPorSimbolo', () => {
  it('agrupa por símbolo, ordena de mayor a menor y suma exacto', () => {
    const r = repartoPorSimbolo([
      { symbol: 'BTC', qty: '0.01', price: '60000' },
      { symbol: 'ETH', qty: '-1', price: '2400' },
      { symbol: 'BTC', qty: '0.005', price: '60000' },
      { symbol: 'SOL', qty: '0', price: '140' },
    ]);
    // BTC: 0,01 + 0,005 = 0,015 x 60 000 = 900; ETH: 1 x 2 400 = 2 400. ETH manda.
    expect(r.total).toBe('3300');
    expect(r.partes.map((p) => p.symbol)).toEqual(['ETH', 'BTC']);
    expect(r.partes[1].pct).toBeCloseTo(27.27, 1);
    expect(r.partes.reduce((a, p) => a + p.pct, 0)).toBeCloseTo(100, 6);
  });

  it('sin exposición no hay partes', () => {
    expect(repartoPorSimbolo([{ symbol: 'BTC', qty: '0', price: null }])).toEqual({
      total: '0',
      partes: [],
    });
  });
});
