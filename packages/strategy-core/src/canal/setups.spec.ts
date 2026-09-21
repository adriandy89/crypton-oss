import {
  Confirmacion,
  EstadoSetup,
  TipoCanal,
  TipoSetup,
  type CanalDetectado,
  type Candle,
} from '@crypton/shared';
import { atrSerie } from './estadistica';
import { serieNumerica } from './numeros';
import { detectarSetups, hayDivergencia, ladosPermitidos, type ParametrosSetups } from './setups';
import { swingsConfirmados, type Giro } from './swings';
import { QUINCE_MIN, senoidal } from './testing-canal';

/**
 * Los setups del spec 058 sobre el rango senoidal de los tests de canales:
 * soporte 98,95 y resistencia 101,05, con ATR(15m) ≈ 0,457 y eps ≈ 0,114.
 */

const CINCO = 300_000;
const quince = senoidal({ n: 200, periodo: 12 });
const s15 = serieNumerica(quince);
const atr15 = atrSerie(s15.h, s15.l, s15.c, 14);
const giros = swingsConfirmados(s15, atr15);
const refT = quince[quince.length - 1].t;

const CANAL: CanalDetectado = {
  id: 'H1',
  tipo: TipoCanal.HORIZONTAL,
  calidad: 'A',
  puntuacion: 90,
  soporte: '98.95',
  resistencia: '101.05',
  media: '100',
  pendientePorVela: 0,
  refT,
  anchuraAtr: 4.6,
  toquesSoporte: 8,
  toquesResistencia: 8,
  contencion: 1,
  cruces: 16,
  mediaVidaVelas: 4.5,
  duracionVelas: 94,
  ultimoToqueHace: 4,
  r2: null,
};

const PARAMS: ParametrosSetups = {
  minConfirmaciones: 2,
  setups: [TipoSetup.REBOTE],
  lados: ['LONG', 'SHORT'],
  inclinadoSoloAFavor: true,
};

/** Velas de 5 min que acaban en la vela de 15 min cerrada. */
function cinco(ultimas: [number, number, number, number][], desde = 100.5, hasta = 99.1): Candle[] {
  const bajada = 30;
  const velas: Candle[] = [];
  const inicio = refT + 2 * CINCO - (bajada + ultimas.length - 1) * CINCO;
  let previo = desde;
  for (let i = 0; i < bajada; i++) {
    const cierre = desde + ((hasta - desde) * (i + 1)) / bajada;
    velas.push({
      t: inicio + i * CINCO,
      o: previo.toFixed(4),
      h: (Math.max(previo, cierre) + 0.02).toFixed(4),
      l: (Math.min(previo, cierre) - 0.02).toFixed(4),
      c: cierre.toFixed(4),
      v: '10',
    });
    previo = cierre;
  }
  ultimas.forEach(([o, h, l, c], j) => {
    velas.push({
      t: inicio + (bajada + j) * CINCO,
      o: String(o),
      h: String(h),
      l: String(l),
      c: String(c),
      v: '10',
    });
  });
  return velas;
}

const TOQUE: [number, number, number, number][] = [
  [99.1, 99.12, 98.98, 99.0],
  // Mecha inferior de 0,18 en un rango de 0,30, y cierre en la mitad alta.
  [99.1, 99.22, 98.92, 99.2],
];

const detectar = (velas5: Candle[], p: Partial<ParametrosSetups> = {}, canal = CANAL) =>
  detectarSetups(serieNumerica(velas5), s15, canal, null, giros, atr15[s15.n - 1], {
    ...PARAMS,
    ...p,
  });

describe('detectarSetups — el rebote (spec 058)', () => {
  it('un toque del soporte con rechazo es un rebote largo listo', () => {
    const [c] = detectar(cinco(TOQUE));
    expect(c).toMatchObject({
      id: 'REB-L-H1',
      setup: TipoSetup.REBOTE,
      lado: 'LONG',
      estado: EstadoSetup.LISTO,
      extremo: 98.92,
    });
    expect(c.confirmaciones).toEqual(
      expect.arrayContaining([Confirmacion.MECHA, Confirmacion.RSI, Confirmacion.VOLUMEN]),
    );
  });

  it('sin las confirmaciones mínimas, solo se vigila', () => {
    const [c] = detectar(cinco(TOQUE), { minConfirmaciones: 5 });
    expect(c.estado).toBe(EstadoSetup.VIGILANDO);
  });

  it('sin tocar el borde no hay setup', () => {
    expect(
      detectar(
        cinco(
          [
            [99.4, 99.45, 99.3, 99.35],
            [99.35, 99.5, 99.3, 99.45],
          ],
          100.5,
          99.4,
        ),
      ),
    ).toEqual([]);
  });

  it('un cierre por debajo del soporte no es un rebote', () => {
    expect(detectar(cinco([TOQUE[0], [99.0, 99.02, 98.7, 98.8]]))).toEqual([]);
  });

  it('un bot solo corto no ve el rebote largo', () => {
    expect(detectar(cinco(TOQUE), { lados: ['SHORT'] })).toEqual([]);
  });

  it('el falso quiebre apagado no aparece aunque lo haya', () => {
    const velas = serieNumerica(cinco(TOQUE));
    const fq = { lado: 'LONG' as const, extremo: 98.65, indice: 190 };
    const conFq = detectarSetups(velas, s15, CANAL, fq, giros, atr15[s15.n - 1], {
      ...PARAMS,
      setups: [TipoSetup.REBOTE, TipoSetup.FALSO_QUIEBRE],
    });
    expect(conFq.map((c) => c.id)).toEqual(['REB-L-H1', 'FQ-L-H1']);
    expect(conFq[1].extremo).toBe(98.65);
    const sinFq = detectarSetups(velas, s15, CANAL, fq, giros, atr15[s15.n - 1], PARAMS);
    expect(sinFq.map((c) => c.id)).toEqual(['REB-L-H1']);
  });

  it('el rebote corto es el espejo en la resistencia', () => {
    const arriba: [number, number, number, number][] = [
      [100.9, 101.02, 100.88, 101.0],
      [100.9, 101.08, 100.78, 100.8],
    ];
    const [c] = detectar(cinco(arriba, 99.5, 100.9));
    expect(c).toMatchObject({ id: 'REB-S-H1', lado: 'SHORT', extremo: 101.08 });
    expect(c.confirmaciones).toContain(Confirmacion.MECHA);
  });
});

describe('lados y divergencia', () => {
  it('un canal inclinado al alza solo se opera en largo', () => {
    const inclinado = { ...CANAL, tipo: TipoCanal.INCLINADO, pendientePorVela: 0.03 };
    expect(ladosPermitidos(inclinado, PARAMS)).toEqual(['LONG']);
    expect(ladosPermitidos({ ...inclinado, pendientePorVela: -0.03 }, PARAMS)).toEqual(['SHORT']);
    expect(ladosPermitidos(inclinado, { ...PARAMS, inclinadoSoloAFavor: false })).toEqual([
      'LONG',
      'SHORT',
    ]);
  });

  it('divergencia: mínimo más bajo con RSI más alto', () => {
    const s = serieNumerica(senoidal({ n: 30, periodo: 12, paso: QUINCE_MIN }));
    const rsi = new Float64Array(30).fill(40);
    rsi[10] = 25;
    const giro: Giro = { tipo: 'BAJO', indice: 10, precio: 99, confirmadoEn: 12 };
    expect(hayDivergencia(s, rsi, [giro], 98.9, 'LONG')).toBe(true);
    // Sin mínimo más bajo, no la hay.
    expect(hayDivergencia(s, rsi, [giro], 99.1, 'LONG')).toBe(false);
    // Con el RSI también más bajo, tampoco.
    rsi[29] = 20;
    expect(hayDivergencia(s, rsi, [giro], 98.9, 'LONG')).toBe(false);
  });
});

/**
 * El canal de banda (spec 067). Aquí el borde no es un precio que nadie haya
 * defendido, así que las dos distancias que deciden si hay toque se miden en
 * fracción de la anchura y no en ATR: la regla que se midió entraba con
 * %B ≤ 0,1, o sea dentro del décimo exterior.
 */
describe('detectarSetups — el borde de una banda (spec 067)', () => {
  const BANDA: CanalDetectado = { ...CANAL, id: 'B1', tipo: TipoCanal.BANDA };
  // Anchura 2,10: el décimo es 0,21 y el tercio, 0,70.
  const DECIMO = 98.95 + 0.21;
  const TERCIO = 98.95 + 0.7;

  /** Un toque cuyo cierre queda a `cierre`, con mecha de rechazo. */
  const toque = (cierre: number): [number, number, number, number][] => [
    [cierre, cierre + 0.02, 98.98, cierre],
    [cierre, cierre + 0.12, 98.92, cierre],
  ];

  it('con el cierre dentro del décimo, hay rebote', () => {
    const [c] = detectar(cinco(toque(DECIMO - 0.05), 100.5, DECIMO - 0.05), {}, BANDA);
    expect(c?.setup).toBe(TipoSetup.REBOTE);
    expect(c?.lado).toBe('LONG');
  });

  it('con el cierre en el tercio, que el canal de giros aceptaría, no lo hay', () => {
    const velas = cinco(toque(TERCIO - 0.05), 100.5, TERCIO - 0.05);

    expect(detectar(velas, {}, BANDA)).toHaveLength(0);
    // Y la prueba de que la diferencia es del tipo de canal y no del fixture:
    // el mismo toque sobre un canal de giros sí se acepta.
    expect(detectar(velas, {}, CANAL)[0]?.setup).toBe(TipoSetup.REBOTE);
  });
});
