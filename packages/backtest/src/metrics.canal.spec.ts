import type { BacktestOperacionView } from '@crypton/shared';
import { wilsonInferior } from '@crypton/strategy-core';
import { metricasPorSetup, ventanasConsecutivas } from './metrics';

/**
 * Spec 058. Las cifras por setup del replay son las mismas medidas que las
 * tasas base que ve la IA, y las ventanas dicen si el resultado se sostiene.
 */

const HORA = 3_600_000;

const op = (
  setup: string,
  lado: 'LONG' | 'SHORT',
  resultado: string,
  r: number,
  salidaEn: number,
): BacktestOperacionView => ({
  setup,
  lado,
  candidatoId: `${setup}-${lado}`,
  entradaEn: salidaEn - HORA,
  salidaEn,
  precioEntrada: '100',
  precioSalida: '101',
  stop: '99',
  objetivos: ['101'],
  apalancamiento: 10,
  riesgo: '10',
  resultado,
  r,
  rPlaneado: 1.5,
  salida: r > 0 ? 'OBJETIVO' : 'STOP',
});

describe('metricasPorSetup', () => {
  it('agrupa por setup y lado, con aciertos, Wilson, R medio, esperanza y factor', () => {
    const ops = [
      op('REBOTE', 'LONG', '20', 2, 1),
      op('REBOTE', 'LONG', '-10', -1, 2),
      op('REBOTE', 'LONG', '15', 1.5, 3),
      op('REBOTE', 'SHORT', '-10', -1, 4),
      op('FALSO_QUIEBRE', 'LONG', '5', 0.5, 5),
    ];

    const m = metricasPorSetup(ops);

    expect(m).toHaveLength(3);
    expect(m.find((x) => x.setup === 'REBOTE' && x.lado === 'LONG')).toEqual({
      setup: 'REBOTE',
      lado: 'LONG',
      n: 3,
      aciertos: 2,
      wilsonInferior: wilsonInferior(2, 3),
      rMedio: 2.5 / 3,
      // (20 − 10 + 15) / 3, en USDC, con la precisión de `D`.
      esperanza: '8.333333333333333333333333333333333333333',
      factorBeneficio: 3.5,
      resultado: '25',
    });
    expect(m.find((x) => x.lado === 'SHORT')).toMatchObject({
      n: 1,
      aciertos: 0,
      wilsonInferior: 0,
      factorBeneficio: 0,
      resultado: '-10',
    });
  });

  it('sin pérdidas no hay factor que dar', () => {
    expect(metricasPorSetup([op('REBOTE', 'LONG', '3', 0.3, 1)])[0].factorBeneficio).toBeNull();
  });

  it('un resultado de cero no es un acierto', () => {
    expect(metricasPorSetup([op('REBOTE', 'LONG', '0', 0, 1)])[0].aciertos).toBe(0);
  });

  it('sin operaciones, sin cifras', () => {
    expect(metricasPorSetup([])).toEqual([]);
  });
});

describe('ventanasConsecutivas', () => {
  const desde = 0;
  const hasta = 30 * HORA;

  it('parte el rango en tramos iguales y cuenta cada operación donde cerró', () => {
    const ops = [
      op('REBOTE', 'LONG', '10', 1, 2 * HORA),
      op('REBOTE', 'LONG', '-5', -0.5, 9 * HORA),
      // El borde entre tramos cuenta en el siguiente.
      op('REBOTE', 'SHORT', '7', 0.7, 10 * HORA),
      op('REBOTE', 'SHORT', '1', 0.1, 30 * HORA - 1),
    ];

    const v = ventanasConsecutivas(ops, desde, hasta, 3);

    expect(v.map((x) => [x.desde, x.hasta, x.operaciones])).toEqual([
      [0, 10 * HORA, 2],
      [10 * HORA, 20 * HORA, 1],
      [20 * HORA, 30 * HORA, 1],
    ]);
    expect(v[0]).toMatchObject({ resultado: '5', rTotal: 0.5 });
    expect(v[0].porSetup).toEqual(metricasPorSetup(ops.slice(0, 2)));
    expect(v[1].porSetup[0]).toMatchObject({ lado: 'SHORT', n: 1 });
  });

  it('un tramo sin operaciones sale vacío, no desaparece', () => {
    const v = ventanasConsecutivas([op('REBOTE', 'LONG', '10', 1, HORA)], desde, hasta, 3);
    expect(v[2]).toEqual({
      desde: 20 * HORA,
      hasta: 30 * HORA,
      operaciones: 0,
      resultado: '0',
      rTotal: 0,
      porSetup: [],
    });
  });

  it('con una sola ventana es el rango entero', () => {
    expect(ventanasConsecutivas([], desde, hasta, 1)).toEqual([
      { desde, hasta, operaciones: 0, resultado: '0', rTotal: 0, porSetup: [] },
    ]);
  });
});
