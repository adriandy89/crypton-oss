import { Evidencia, TipoCanal, TipoSetup, type Candle } from '@crypton/shared';
import { COSTES_VENUE } from './costes';
import { atrSerie, wilsonInferior } from './estadistica';
import { serieNumerica, type SerieNumerica } from './numeros';
import { swingsConfirmados } from './swings';
import {
  claveTasas,
  etiquetarTripleBarrera,
  etiquetasHistoricas,
  evidenciaDe,
  resumirTasas,
  tasasBase,
  type Etiqueta,
  type ParametrosTasas,
} from './tasas-base';
import { QUINCE_MIN, T0_CANAL, mejorTiempo, senoidal, vela } from './testing-canal';

const SIN_COSTES = { makerBps: 0, takerBps: 0, deslizamientoBps: 0 };
const HL = COSTES_VENUE.HYPERLIQUID;

/** Velas de 15 min a partir de filas [apertura, máximo, mínimo, cierre]. */
const serie = (filas: [number, number, number, number][]): SerieNumerica =>
  serieNumerica(
    filas.map(([o, h, l, c], i) => ({
      t: T0_CANAL + i * QUINCE_MIN,
      o: String(o),
      h: String(h),
      l: String(l),
      c: String(c),
      v: '10',
    })),
  );

const ENTRADA: [number, number, number, number] = [100, 100.2, 99.8, 100];

describe('etiquetarTripleBarrera', () => {
  it('el objetivo antes que el stop: OBJETIVO y su R', () => {
    const s = serie([ENTRADA, [100, 101, 99.5, 100.8], [100.8, 102.1, 100.5, 101.9]]);
    expect(etiquetarTripleBarrera(s, 0, 'LONG', 100, 99, 102, 24, SIN_COSTES)).toEqual({
      lado: 'LONG',
      indice: 0,
      entrada: 100,
      stop: 99,
      objetivo: 102,
      salida: 2,
      resultado: 'OBJETIVO',
      r: 2,
    });
  });

  it('una vela que toca los dos cuenta como stop', () => {
    const s = serie([ENTRADA, [100, 102.5, 98.9, 101]]);
    expect(etiquetarTripleBarrera(s, 0, 'LONG', 100, 99, 102, 24, SIN_COSTES)).toMatchObject({
      resultado: 'STOP',
      salida: 1,
      r: -1,
    });
  });

  it('un hueco más allá del stop sale a la apertura: peor que −1R', () => {
    const s = serie([ENTRADA, [98.5, 98.8, 98.2, 98.6]]);
    expect(etiquetarTripleBarrera(s, 0, 'LONG', 100, 99, 102, 24, SIN_COSTES)?.r).toBeCloseTo(
      -1.5,
      12,
    );
  });

  it('llegar al objetivo sin pasarlo no basta, como en el backtest', () => {
    const justo = serie([ENTRADA, [100, 102, 99.5, 101.9], [101.9, 102, 101, 101.5]]);
    expect(etiquetarTripleBarrera(justo, 0, 'LONG', 100, 99, 102, 2, SIN_COSTES)).toMatchObject({
      resultado: 'TIEMPO',
      salida: 2,
    });
    const corto = serie([ENTRADA, [100, 100.5, 98, 98.1], [98.1, 99, 98, 98.5]]);
    expect(etiquetarTripleBarrera(corto, 0, 'SHORT', 100, 101, 98, 2, SIN_COSTES)?.resultado).toBe(
      'TIEMPO',
    );
  });

  it('la barrera de tiempo sale al cierre', () => {
    const s = serie([ENTRADA, [100, 101, 99.5, 100.8], [100.8, 101.4, 100.2, 100.5]]);
    expect(etiquetarTripleBarrera(s, 0, 'LONG', 100, 99, 102, 2, SIN_COSTES)).toMatchObject({
      resultado: 'TIEMPO',
      salida: 2,
      r: 0.5,
    });
  });

  it('sin velas para resolverla no hay etiqueta', () => {
    const s = serie([ENTRADA, [100, 101, 99.5, 100.8], [100.8, 101.4, 100.2, 100.5]]);
    expect(etiquetarTripleBarrera(s, 0, 'LONG', 100, 99, 102, 5, SIN_COSTES)).toBeNull();
  });

  it('el corto, en espejo', () => {
    const s = serie([ENTRADA, [100, 100.5, 97.9, 98.2]]);
    expect(etiquetarTripleBarrera(s, 0, 'SHORT', 100, 101, 98, 24, SIN_COSTES)).toMatchObject({
      resultado: 'OBJETIVO',
      r: 2,
    });
    const arriba = serie([ENTRADA, [100, 101.2, 99, 99.5]]);
    expect(
      etiquetarTripleBarrera(arriba, 0, 'SHORT', 100, 101, 98, 24, SIN_COSTES)?.resultado,
    ).toBe('STOP');
  });

  it('un stop del lado equivocado no se etiqueta', () => {
    const s = serie([ENTRADA, [100, 101, 99.5, 100.8]]);
    expect(etiquetarTripleBarrera(s, 0, 'LONG', 100, 100.5, 102, 24, SIN_COSTES)).toBeNull();
    expect(etiquetarTripleBarrera(s, 0, 'SHORT', 100, 99.5, 98, 24, SIN_COSTES)).toBeNull();
  });

  it('con costes, como la herramienta: el stop es −1R exacto y el objetivo paga comisiones', () => {
    const stop = serie([ENTRADA, [100, 100.1, 98.9, 99.2]]);
    expect(etiquetarTripleBarrera(stop, 0, 'LONG', 100, 99, 102, 24, HL)?.r).toBeCloseTo(-1, 12);
    const tp = serie([ENTRADA, [100, 102.1, 99.5, 101.9]]);
    // (2 − 100·0,00045 − 102·0,00015) / (1 + 100·0,00045 + 99·0,00065)
    expect(etiquetarTripleBarrera(tp, 0, 'LONG', 100, 99, 102, 24, HL)?.r).toBeCloseTo(
      1.9397 / 1.10935,
      12,
    );
  });
});

describe('evidencia y resumen', () => {
  it('los umbrales: < 20 insuficiente, ≤ 60 débil, > 60 moderada', () => {
    expect([19, 20, 60, 61].map(evidenciaDe)).toEqual([
      Evidencia.INSUFICIENTE,
      Evidencia.DEBIL,
      Evidencia.DEBIL,
      Evidencia.MODERADA,
    ]);
  });

  it('resume por setup y lado, con Wilson', () => {
    const base = { entrada: 100, stop: 99, objetivo: 102, salida: 3 };
    const etiquetas: Etiqueta[] = [
      { ...base, setup: TipoSetup.REBOTE, lado: 'LONG', indice: 1, resultado: 'OBJETIVO', r: 2 },
      { ...base, setup: TipoSetup.REBOTE, lado: 'LONG', indice: 5, resultado: 'STOP', r: -1 },
      { ...base, setup: TipoSetup.REBOTE, lado: 'LONG', indice: 9, resultado: 'TIEMPO', r: 0.5 },
      { ...base, setup: TipoSetup.REBOTE, lado: 'SHORT', indice: 2, resultado: 'STOP', r: -1.2 },
    ];
    const t = resumirTasas(etiquetas);
    expect(t.get(claveTasas(TipoSetup.REBOTE, 'LONG'))).toEqual({
      n: 3,
      aciertos: 2,
      rMedio: 0.5,
      wilsonInferior: wilsonInferior(2, 3),
      evidencia: Evidencia.INSUFICIENTE,
    });
    expect(t.get(claveTasas(TipoSetup.REBOTE, 'SHORT'))).toMatchObject({
      n: 1,
      aciertos: 0,
      rMedio: -1.2,
    });
    expect(t.has(claveTasas(TipoSetup.FALSO_QUIEBRE, 'LONG'))).toBe(false);
  });
});

const PARAMS: ParametrosTasas = {
  ventana: 96,
  tiposPermitidos: [TipoCanal.HORIZONTAL, TipoCanal.INCLINADO],
  invalidacionAtr: 0.35,
  calidadMinima: 'B',
  costes: HL,
  maxVelas: 24,
  setups: [TipoSetup.REBOTE],
  lados: ['LONG', 'SHORT'],
  inclinadoSoloAFavor: true,
};

const etiquetar = (velas: Candle[], p: Partial<ParametrosTasas> = {}): Etiqueta[] => {
  const s = serieNumerica(velas);
  const atr = atrSerie(s.h, s.l, s.c, 14);
  return etiquetasHistoricas(s, atr, swingsConfirmados(s, atr), { ...PARAMS, ...p });
};

/** El rango senoidal de los tests de canales y, a partir de `n`, una subida limpia. */
function rangoYSubida(n: number, subida: number): Candle[] {
  const velas = senoidal({ n, periodo: 12 });
  let previo = Number(velas[velas.length - 1].c);
  for (let i = 0; i < subida; i++) {
    const cierre = previo + 0.3;
    velas.push(vela(T0_CANAL + (n + i) * QUINCE_MIN, previo, cierre));
    previo = cierre;
  }
  return velas;
}

describe('etiquetasHistoricas', () => {
  it('en un rango limpio, los toques de los dos bordes acaban en el objetivo', () => {
    const etiquetas = etiquetar(senoidal({ n: 400, periodo: 12 }));
    const largos = etiquetas.filter((e) => e.lado === 'LONG');
    const cortos = etiquetas.filter((e) => e.lado === 'SHORT');
    expect(largos.length).toBeGreaterThan(5);
    expect(cortos.length).toBeGreaterThan(5);
    expect(etiquetas.every((e) => e.setup === TipoSetup.REBOTE)).toBe(true);
    expect(etiquetas.every((e) => e.resultado === 'OBJETIVO' && e.r > 0)).toBe(true);
    // El objetivo es la media del canal (100) y la entrada, el cierre del toque.
    for (const e of largos) {
      expect(e.objetivo).toBeCloseTo(100, 6);
      expect(e.entrada).toBeLessThan(99.7);
    }
  });

  it('las etiquetas de un mismo lado no se solapan', () => {
    const etiquetas = etiquetar(senoidal({ n: 400, periodo: 12 }));
    for (const lado of ['LONG', 'SHORT'] as const) {
      const delLado = etiquetas.filter((e) => e.lado === lado);
      for (let i = 1; i < delLado.length; i++) {
        expect(delLado[i].indice).toBeGreaterThan(delLado[i - 1].salida);
      }
    }
  });

  it('no mira al futuro: lo que ya se resolvió no cambia con las velas que llegan después', () => {
    const corte = 300;
    const completa = etiquetar(rangoYSubida(corte, 120));
    const prefijo = etiquetar(rangoYSubida(corte, 0));
    const resueltas = completa.filter((e) => e.salida <= corte - 1);
    expect(resueltas.length).toBeGreaterThan(5);
    for (const e of resueltas) expect(prefijo).toContainEqual(e);
  });

  it('una ruptura acaba con el canal: nada se etiqueta en la subida', () => {
    const etiquetas = etiquetar(rangoYSubida(300, 120));
    expect(etiquetas.every((e) => e.indice < 305)).toBe(true);
  });

  it('una ruptura de un ATR o más acaba con el canal aunque el precio vuelva', () => {
    const velas = senoidal({ n: 260, periodo: 12 });
    // La vela 200 cierra 1,3 ATR por debajo del soporte; la 201 vuelve y toca.
    velas[200] = { ...velas[200], h: '99.55', l: '98.3', c: '98.35' };
    velas[201] = { ...velas[201], o: '98.35', h: '99.1', l: '98.3', c: '99.05' };
    velas[202] = { ...velas[202], o: '99.05' };
    const etiquetas = etiquetar(velas, { setups: [TipoSetup.REBOTE, TipoSetup.FALSO_QUIEBRE] });
    // Hasta la siguiente búsqueda del canal (vela 207), nada.
    expect(etiquetas.filter((e) => e.indice >= 200 && e.indice <= 207)).toEqual([]);
    expect(etiquetas.some((e) => e.indice > 207)).toBe(true);
  });

  it('el falso quiebre: cierre fuera por menos de un ATR y vuelta dentro', () => {
    const velas = senoidal({ n: 260, periodo: 12 });
    // La vela 200 cierra por debajo del soporte (98,95) y la 201 vuelve dentro.
    velas[200] = { ...velas[200], h: '99.55', l: '98.7', c: '98.8' };
    velas[201] = { ...velas[201], o: '98.8', h: '99.1', l: '98.75', c: '99.05' };
    velas[202] = { ...velas[202], o: '99.05' };
    const conFq = etiquetar(velas, { setups: [TipoSetup.REBOTE, TipoSetup.FALSO_QUIEBRE] });
    const fq = conFq.filter((e) => e.setup === TipoSetup.FALSO_QUIEBRE);
    expect(fq).toHaveLength(1);
    expect(fq[0]).toMatchObject({
      lado: 'LONG',
      indice: 201,
      entrada: 99.05,
      resultado: 'OBJETIVO',
    });
    // El stop cuelga del extremo de la ruptura, medio ATR por debajo.
    expect(fq[0].stop).toBeLessThan(98.7);
    // Apagado, esa vela es un rebote.
    const sinFq = etiquetar(velas);
    expect(sinFq.some((e) => e.setup === TipoSetup.FALSO_QUIEBRE)).toBe(false);
    expect(sinFq.some((e) => e.indice === 201)).toBe(true);
  });

  it('un bot solo largo no etiqueta cortos', () => {
    const etiquetas = etiquetar(senoidal({ n: 400, periodo: 12 }), { lados: ['LONG'] });
    expect(etiquetas.length).toBeGreaterThan(0);
    expect(etiquetas.every((e) => e.lado === 'LONG')).toBe(true);
  });

  it('sin canal de la calidad pedida no hay etiquetas', () => {
    let x = 7;
    const azar = () => {
      x = (x * 16807) % 2147483647;
      return x / 2147483647;
    };
    // Un paseo aleatorio: no hay rango que medir.
    const paseo: Candle[] = [];
    let p = 100;
    for (let i = 0; i < 400; i++) {
      const abre = p;
      p += (azar() - 0.5) * 0.8;
      paseo.push(vela(T0_CANAL + i * QUINCE_MIN, abre, p));
    }
    expect(etiquetar(paseo, { calidadMinima: 'A' }).length).toBeLessThan(
      etiquetar(senoidal({ n: 400, periodo: 12 }), { calidadMinima: 'A' }).length,
    );
  });
});

describe('tasasBase: rendimiento', () => {
  // Los 50 ms de CA-3 se miden sobre `dist`, donde estas mil velas tardan unos
  // 3 ms. Bajo jest, y con toda la suite en paralelo, el umbral solo caza un
  // algoritmo que se dispara (ver `analizarMercado: rendimiento`).
  it('mil velas no se disparan', () => {
    const s = serieNumerica(senoidal({ n: 1000, periodo: 12 }));
    const atr = atrSerie(s.h, s.l, s.c, 14);
    const giros = swingsConfirmados(s, atr);
    expect(mejorTiempo(() => tasasBase(s, atr, giros, PARAMS), 5)).toBeLessThan(150);
  });
});
