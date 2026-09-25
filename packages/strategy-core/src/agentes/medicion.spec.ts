import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  EstadoPropuestaAgente,
  FamiliaAgente,
  MotivoPropuestaAgente,
  SalidaOperacionAgente,
  TipoStop,
  type CandidatoAgente,
  type OpcionStop,
} from '@crypton/shared';
import { wilsonInferior } from '../canal/estadistica';
import {
  MUESTRA_MINIMA,
  estadisticaR,
  planMedibleDe,
  resultadoHipotetico,
  tarjetaAgente,
  type FilaCandidato,
  type FilaPropuesta,
} from './medicion';
import { HORA, T0_AGENTE, vela } from './testing-agentes';

/**
 * La medición (spec 074, R-25). Las cuentas, con cifras a mano; y la regla
 * que la hace honesta: nada del motor la lee para decidir.
 */

const SIN_COSTES = { makerBps: 0, takerBps: 0, deslizamientoBps: 0 };

describe('estadisticaR', () => {
  it('las cuentas, a mano', () => {
    const e = estadisticaR([1, -1, 2, -0.5]);
    expect(e.n).toBe(4);
    expect(e.aciertos).toBe(2);
    expect(e.rMedio).toBe(0.375);
    // sd = √(5,6875 / 3) = 1,37689…; t = 0,375 / (sd / 2) = 0,54470…
    expect(e.t).toBeCloseTo(0.5447, 4);
    expect(e.wilsonInferior).toBe(wilsonInferior(2, 4));
    expect(e.muestraPequena).toBe(true);
  });

  it('sin casos, sin media; con uno o sin dispersión, sin t', () => {
    expect(estadisticaR([])).toEqual({
      n: 0,
      aciertos: 0,
      wilsonInferior: 0,
      rMedio: null,
      t: null,
      muestraPequena: true,
    });
    expect(estadisticaR([1]).t).toBeNull();
    expect(estadisticaR([0.5, 0.5, 0.5]).t).toBeNull();
    expect(estadisticaR([Number.NaN, 1]).n).toBe(1);
  });

  it('la muestra deja de ser pequeña en 30', () => {
    expect(estadisticaR(Array(MUESTRA_MINIMA - 1).fill(1)).muestraPequena).toBe(true);
    expect(estadisticaR(Array(MUESTRA_MINIMA).fill(1)).muestraPequena).toBe(false);
  });
});

describe('resultadoHipotetico', () => {
  // La vela de la decisión cierra en 100; stop en 98, objetivo en 104.
  const decision = vela(T0_AGENTE, 100, 100, 0.1);
  const plan = {
    lado: 'LONG' as const,
    barT: T0_AGENTE,
    entrada: '100',
    stop: '98',
    objetivo: '104',
  };
  const siguientes = (...ps: [number, number, number][]) =>
    ps.map(([o, h, l], i) => ({
      t: T0_AGENTE + (i + 1) * HORA,
      o: String(o),
      h: String(h),
      l: String(l),
      c: String(o),
      v: '1',
    }));

  it('objetivo pasado: +2R sin costes', () => {
    const r = resultadoHipotetico(
      [decision, ...siguientes([100, 102, 99], [102, 104.5, 101.5])],
      plan,
      10,
      SIN_COSTES,
    );
    expect(r).toEqual({ resultado: 'OBJETIVO', r: 2, en: T0_AGENTE + 2 * HORA });
  });

  it('una vela que toca el stop y el objetivo cuenta como stop', () => {
    const r = resultadoHipotetico([decision, ...siguientes([100, 105, 97])], plan, 10, SIN_COSTES);
    expect(r?.resultado).toBe('STOP');
    expect(r?.r).toBe(-1);
  });

  it('pasadas las velas, sale por tiempo al cierre', () => {
    const r = resultadoHipotetico(
      [decision, ...siguientes([100, 101, 99.5], [101, 101.5, 100.5])],
      plan,
      2,
      SIN_COSTES,
    );
    expect(r?.resultado).toBe('TIEMPO');
    expect(r?.r).toBe(0.5);
  });

  it('sin la vela de la decisión o sin final todavía, no hay resultado', () => {
    expect(resultadoHipotetico(siguientes([100, 101, 99.5]), plan, 10, SIN_COSTES)).toBeNull();
    expect(
      resultadoHipotetico([decision, ...siguientes([100, 101, 99.5])], plan, 10, SIN_COSTES),
    ).toBeNull();
  });
});

describe('planMedibleDe', () => {
  const opcion = (tipo: TipoStop, precio: string, viable: boolean) =>
    ({ tipo, precio, viable }) as OpcionStop;
  const cand = (stops: OpcionStop[]) =>
    ({ lado: 'LONG', entradaTope: '100', tp1: '104', stops }) as CandidatoAgente;

  it('con el stop NORMAL, o el primero viable', () => {
    const todos = [
      opcion(TipoStop.AJUSTADO, '99', true),
      opcion(TipoStop.NORMAL, '98', true),
      opcion(TipoStop.AMPLIO, '97', true),
    ];
    expect(planMedibleDe(cand(todos), 5)).toEqual({
      lado: 'LONG',
      barT: 5,
      entrada: '100',
      stop: '98',
      objetivo: '104',
    });
    const sinNormal = [todos[0], { ...todos[1], viable: false }, todos[2]];
    expect(planMedibleDe(cand(sinNormal), 5)?.stop).toBe('99');
    expect(planMedibleDe(cand(todos.map((o) => ({ ...o, viable: false }))), 5)).toBeNull();
  });
});

describe('tarjetaAgente', () => {
  const fila = (o: Partial<FilaPropuesta>): FilaPropuesta => ({
    familia: FamiliaAgente.TENDENCIA,
    lado: 'LONG',
    estado: EstadoPropuestaAgente.CERRADA,
    motivo: null,
    rHipotetico: null,
    rReal: null,
    resultado: null,
    salida: null,
    ...o,
  });

  const propuestas: FilaPropuesta[] = [
    fila({ rReal: 1.5, rHipotetico: 2, resultado: '15', salida: SalidaOperacionAgente.OBJETIVO }),
    fila({ rReal: -1, rHipotetico: -1, resultado: '-10.5', salida: SalidaOperacionAgente.STOP }),
    fila({
      familia: FamiliaAgente.RUPTURA,
      lado: 'SHORT',
      rReal: 0.2,
      resultado: '2',
      salida: SalidaOperacionAgente.STOP_PROTEGIDO,
    }),
    fila({ estado: EstadoPropuestaAgente.ABIERTA }),
    fila({ estado: EstadoPropuestaAgente.SIN_ENTRADA }),
    fila({
      estado: EstadoPropuestaAgente.RECHAZADA,
      motivo: MotivoPropuestaAgente.PERSONA,
      rHipotetico: 1.8,
    }),
    fila({ estado: EstadoPropuestaAgente.CADUCADA, rHipotetico: -1 }),
    // Solo medida: no cuenta como propuesta.
    fila({ estado: EstadoPropuestaAgente.SOMBRA, rHipotetico: 3 }),
    // Una operación cerrada fuera del bot: sin R.
    fila({ salida: SalidaOperacionAgente.FUERA }),
  ];
  const candidatos: FilaCandidato[] = [
    { elegible: true, elegido: true, rHipotetico: 2 },
    { elegible: true, elegido: true, rHipotetico: -1 },
    { elegible: true, elegido: false, rHipotetico: 0.5 },
    { elegible: true, elegido: false, rHipotetico: null },
    { elegible: false, elegido: false, rHipotetico: -3 },
  ];

  it('cuenta lo ofrecido, lo tomado y cómo acabó', () => {
    const t = tarjetaAgente(candidatos, propuestas);
    expect(t.propuestas).toBe(8);
    expect(t.tomadas).toBe(6);
    expect(t.rechazadas).toBe(1);
    expect(t.caducadas).toBe(1);
    expect(t.operaciones.n).toBe(3);
    expect(t.operaciones.rMedio).toBeCloseTo(0.7 / 3, 12);
    expect(t.resultado).toBe('6.5');
  });

  it('«¿Discrimina la IA?»: lo elegido frente a lo elegible no elegido', () => {
    const t = tarjetaAgente(candidatos, propuestas);
    expect(t.elegidas.n).toBe(2);
    expect(t.elegidas.rMedio).toBe(0.5);
    expect(t.noElegidas.n).toBe(1);
    expect(t.noElegidas.rMedio).toBe(0.5);
  });

  it('«Tus descartes» son solo los que rechazó una persona', () => {
    const t = tarjetaAgente(candidatos, propuestas);
    expect(t.descartes.n).toBe(1);
    expect(t.descartes.rMedio).toBe(1.8);
  });

  it('la brecha de ejecución, y el desglose por familia y por salida', () => {
    const t = tarjetaAgente(candidatos, propuestas);
    // (1,5 − 2) y (−1 − −1): la tercera no tiene hipotético.
    expect(t.brechaEjecucion).toBe(-0.25);
    expect(t.porFamilia.map((f) => [f.familia, f.lado, f.operaciones.n])).toEqual([
      [FamiliaAgente.TENDENCIA, 'LONG', 2],
      [FamiliaAgente.RUPTURA, 'SHORT', 1],
    ]);
    expect(t.porSalida).toEqual([
      { salida: SalidaOperacionAgente.OBJETIVO, n: 1 },
      { salida: SalidaOperacionAgente.STOP, n: 1 },
      { salida: SalidaOperacionAgente.STOP_PROTEGIDO, n: 1 },
      { salida: SalidaOperacionAgente.FUERA, n: 1 },
    ]);
  });

  it('vacía, sin inventarse nada', () => {
    const t = tarjetaAgente([], []);
    expect(t).toMatchObject({ propuestas: 0, tomadas: 0, resultado: '0', brechaEjecucion: null });
    expect(t.operaciones.rMedio).toBeNull();
  });
});

describe('nada decide con la medición (R-25)', () => {
  it('ningún fichero del motor del agente importa la medición', () => {
    const dir = __dirname;
    const fuentes = readdirSync(dir).filter(
      (f) =>
        f.endsWith('.ts') &&
        !f.endsWith('.spec.ts') &&
        f !== 'medicion.ts' &&
        f !== 'testing-agentes.ts',
    );
    expect(fuentes.length).toBeGreaterThanOrEqual(7);
    for (const f of fuentes) {
      const texto = readFileSync(join(dir, f), 'utf8');
      expect({ f, importa: /from '\.\/medicion'/.test(texto) }).toEqual({ f, importa: false });
    }
  });
});
