import {
  BandaApalancamiento,
  D,
  Decimal,
  EsquemaObjetivo,
  Evidencia,
  FamiliaAgente,
  LETRAS_OFERTA,
  MAX_OFERTA_AGENTE,
  MotivoRonda,
  TipoStop,
  type Candle,
  type CandidatoAgente,
  type OpcionStop,
  type SalidaAgente,
} from '@crypton/shared';
import { mulberry32 } from '../canal/testing-canal';
import {
  barreraDelDia,
  esElegibleAgente,
  herramientaAgente,
  huellaAgente,
  ofertaAgente,
  usoDelDia,
} from './herramienta';
import {
  HORA,
  SEMILLA_REVERSION,
  ahoraTras,
  cortarEnSenal,
  entradaAgenteDePrueba,
  historialAgenteDePrueba,
  limitesDePrueba,
  parDePrueba,
  serieRango,
  serieRuptura,
  serieTendencia,
  tickerDe,
} from './testing-agentes';

/**
 * La herramienta del agente (spec 074). Lo que se fija aquí es lo que hace
 * seguro darle a elegir a un modelo: cada opción que sale viable cumple las
 * tres garantías del canal, contando además las operaciones vivas.
 */

const MINUTO = 60_000;

/** Las tres familias en los dos lados, cada una cortada en su señal. */
const SENALES: { familia: FamiliaAgente; lado: 'LONG' | 'SHORT'; velas: Candle[] }[] = (
  ['LONG', 'SHORT'] as const
).flatMap((lado) => [
  {
    familia: FamiliaAgente.TENDENCIA,
    lado,
    velas: cortarEnSenal(serieTendencia(lado), FamiliaAgente.TENDENCIA, lado),
  },
  {
    familia: FamiliaAgente.RUPTURA,
    lado,
    velas: cortarEnSenal(serieRuptura(lado), FamiliaAgente.RUPTURA, lado),
  },
  {
    familia: FamiliaAgente.REVERSION,
    lado,
    velas: cortarEnSenal(serieRango(SEMILLA_REVERSION[lado]), FamiliaAgente.REVERSION, lado),
  },
]);

describe('barreraDelDia (R-12, puntos 6 y 7)', () => {
  const l = limitesDePrueba({ capital: '1000', perdidaDiariaPct: '2' });
  const AHORA = 1_000 * HORA;

  it('nada que frene', () => {
    expect(barreraDelDia(historialAgenteDePrueba(), l, AHORA)).toBeNull();
  });

  it('en su orden: la pérdida del día manda sobre todo lo demás', () => {
    const todo = historialAgenteDePrueba({
      realizadoHoy: '-20',
      operacionesHoy: 9,
      vivas: 9,
      rachaPerdidas: 9,
      ultimaPerdidaEn: AHORA,
    });
    expect(barreraDelDia(todo, l, AHORA)).toBe(MotivoRonda.PERDIDA_DIARIA);
    expect(barreraDelDia({ ...todo, realizadoHoy: '-19.99' }, l, AHORA)).toBe(
      MotivoRonda.OPERACIONES_DIA,
    );
    expect(barreraDelDia({ ...todo, realizadoHoy: '0', operacionesHoy: 0 }, l, AHORA)).toBe(
      MotivoRonda.RACHA,
    );
  });

  it('la racha corta solo durante su espera', () => {
    const racha = historialAgenteDePrueba({ rachaPerdidas: 3, ultimaPerdidaEn: AHORA });
    expect(barreraDelDia(racha, l, AHORA + 239 * MINUTO)).toBe(MotivoRonda.RACHA);
    expect(barreraDelDia(racha, l, AHORA + 240 * MINUTO)).toBeNull();
  });

  it('lo pendiente cuenta como si entrara', () => {
    expect(barreraDelDia(historialAgenteDePrueba({ vivas: 1, pendientes: 1 }), l, AHORA)).toBe(
      MotivoRonda.CAPACIDAD,
    );
    const holgado = { ...l, maxVivas: 5, maxOperacionesDia: 10, margenPct: '10' };
    expect(barreraDelDia(historialAgenteDePrueba({ pendientes: 2 }), holgado, AHORA)).toBe(
      MotivoRonda.CAPACIDAD,
    );
  });
});

describe('herramientaAgente: los pares', () => {
  const { velas } = SENALES[0];

  it('la ronda es de la vela que acaba de cerrar', () => {
    const salida = herramientaAgente(entradaAgenteDePrueba(velas));
    expect(salida.barT).toBe(velas[velas.length - 1].t);
    expect(salida.pares[0].candidatos.length).toBeGreaterThan(0);
  });

  it('un par ocupado o en su espera tras un stop no ofrece nada', () => {
    const e = entradaAgenteDePrueba(velas);
    const ocupado = herramientaAgente({
      ...e,
      historial: historialAgenteDePrueba({ ocupados: ['SOL'] }),
    });
    expect(ocupado.pares[0]).toMatchObject({ candidatos: [], descartes: ['OCUPADO'] });
    const espera = (hace: number) =>
      herramientaAgente({
        ...e,
        historial: historialAgenteDePrueba({ ultimoStopEn: { SOL: e.ahora - hace } }),
      }).pares[0].descartes;
    expect(espera(59 * MINUTO)).toEqual(['ESPERA_STOP']);
    expect(espera(60 * MINUTO)).toEqual([]);
  });

  it('sin velas suficientes, sin precio o con la última vela vieja, nada', () => {
    const corta = herramientaAgente(entradaAgenteDePrueba(velas.slice(-100)));
    expect(corta.pares[0].descartes).toEqual(['SIN_DATOS']);
    const e = entradaAgenteDePrueba(velas);
    const sinPrecio = herramientaAgente({ ...e, pares: [parDePrueba(velas, { ticker: null })] });
    expect(sinPrecio.pares[0].descartes).toEqual(['SIN_PRECIO']);
    const tarde = herramientaAgente({ ...e, ahora: e.ahora + 2 * HORA });
    expect(tarde.pares[0].descartes).toEqual(['VELAS_ANTIGUAS']);
    // Sin la vela de la ronda, el contexto se enseña igual: dice qué se vio.
    expect(tarde.pares[0].mercado?.frescas).toBe(false);
  });

  it('con el spread por encima de una décima de ATR, nada', () => {
    const t = tickerDe(velas);
    const ancho = { ...t, ask: (Number(t.bid) + 5).toFixed(2) };
    const salida = herramientaAgente(
      entradaAgenteDePrueba(velas, { pares: [parDePrueba(velas, { ticker: ancho })] }),
    );
    expect(salida.pares[0].descartes).toEqual(['SPREAD']);
  });

  it('una vela sin cerrar no cambia nada: nunca se decide con el futuro', () => {
    const ultima = velas[velas.length - 1];
    const formandose = { ...ultima, t: ultima.t + HORA, c: '1', l: '1', o: '1', h: '500' };
    const e = entradaAgenteDePrueba(velas);
    const con = herramientaAgente({
      ...e,
      pares: [parDePrueba([...velas, formandose], { ticker: tickerDe(velas) })],
    });
    const sin = herramientaAgente(e);
    expect(con.pares).toEqual(sin.pares);
  });
});

describe('herramientaAgente: los candidatos', () => {
  it('cada familia en cada lado, con su geometría', () => {
    for (const { familia, lado, velas } of SENALES) {
      const salida = herramientaAgente(entradaAgenteDePrueba(velas));
      const c = salida.pares[0].candidatos.find((x) => x.familia === familia && x.lado === lado);
      expect(c).toBeDefined();
      if (!c) continue;
      const largo = lado === 'LONG';
      expect(c.id).toBe(`SOL|${familia}|${lado}|${salida.barT}`);
      const ref = D(c.entradaReferencia);
      const tope = D(c.entradaTope);
      // El tope de la IOC nunca es mejor que el libro.
      expect(largo ? tope.gte(ref) : tope.lte(ref)).toBe(true);
      // Stops detrás y en su orden; objetivos delante.
      const stops = c.stops.map((o) => D(o.precio));
      for (const s of stops) if (s.gt(0)) expect(largo ? s.lt(tope) : s.gt(tope)).toBe(true);
      expect(largo ? stops[0].gte(stops[1]) : stops[0].lte(stops[1])).toBe(true);
      expect(largo ? stops[1].gte(stops[2]) : stops[1].lte(stops[2])).toBe(true);
      expect(largo ? D(c.tp1).gt(tope) : D(c.tp1).lt(tope)).toBe(true);
      // En la retícula del venue.
      for (const p of [c.tp1, c.tp2, c.entradaTope]) {
        expect(D(p).mod('0.01').isZero()).toBe(true);
      }
      if (familia === FamiliaAgente.RUPTURA) expect(c.nivel).toBe(c.extremo);
      else expect(c.nivel).toBeNull();
    }
  });

  it('la evidencia negativa de verdad descarta, y solo ella', () => {
    // Un rango largo da tasas con muestra: la regla del canal, en todos los candidatos.
    const larga = cortarEnSenal(serieRango(21, 3000), FamiliaAgente.REVERSION, 'LONG');
    const salida = herramientaAgente(entradaAgenteDePrueba(larga));
    for (const c of salida.pares[0].candidatos) {
      const negativa = c.tasas?.evidencia === Evidencia.MODERADA && c.tasas.rMedio < 0;
      expect(c.descartes.includes('ESPERANZA_NEGATIVA')).toBe(negativa);
    }
  });

  it('un objetivo mínimo en % que ningún objetivo alcanza deja la opción sin esquemas', () => {
    const { velas } = SENALES[0];
    const salida = herramientaAgente(
      entradaAgenteDePrueba(velas, { limites: limitesDePrueba({ minObjetivoPct: '20' }) }),
    );
    for (const c of salida.pares[0].candidatos) {
      for (const o of c.stops) {
        if (o.motivo === 'OBJETIVO_CORTO') expect(o.esquemasViables).toEqual([]);
        expect(o.viable).toBe(false);
      }
      expect(esElegibleAgente(c)).toBe(false);
    }
  });

  it('con el día gastado contando lo abierto, ninguna opción es viable', () => {
    const { velas } = SENALES[0];
    // 2 % de 10 000 = 200: con 150 perdidos y 60 en riesgo, no queda nada.
    const salida = herramientaAgente(
      entradaAgenteDePrueba(velas, {
        historial: historialAgenteDePrueba({ realizadoHoy: '-150', riesgoAbierto: '60' }),
      }),
    );
    for (const c of salida.pares[0].candidatos) {
      expect(c.stops.every((o) => !o.viable)).toBe(true);
    }
  });
});

describe('las tres garantías, sobre entradas al azar', () => {
  it('pérdida al stop dentro del riesgo, liquidación detrás del stop y margen dentro del tope', () => {
    const azar = mulberry32(74);
    const entre = (a: number, b: number) => a + (b - a) * azar();
    let viables = 0;
    for (let caso = 0; caso < 120; caso++) {
      const { velas } = SENALES[caso % SENALES.length];
      const capital = entre(200, 50_000);
      const riesgoPct = entre(0.05, 3);
      const perdidaDiariaPct = Math.max(riesgoPct, entre(0.5, 8));
      const margenPct = entre(2, 50);
      const apalancamientoMax = 1 + Math.floor(azar() * 25);
      const usuario = azar() < 0.3 ? 1 + Math.floor(azar() * 20) : null;
      const realizadoHoy = capital * entre(-0.03, 0.02);
      const riesgoAbierto = capital * entre(0, 0.02);
      const limites = limitesDePrueba({
        capital: capital.toFixed(2),
        riesgoPct: riesgoPct.toFixed(2),
        perdidaDiariaPct: perdidaDiariaPct.toFixed(2),
        margenPct: margenPct.toFixed(1),
        apalancamientoMax,
        maxStopPct: entre(0.5, 10).toFixed(2),
      });
      const saldoLibre = (capital * entre(0.05, 2)).toFixed(2);
      const salida = herramientaAgente(
        entradaAgenteDePrueba(velas, {
          limites,
          saldoLibre,
          maxApalancamientoUsuario: usuario,
          historial: historialAgenteDePrueba({
            realizadoHoy: realizadoHoy.toFixed(2),
            riesgoAbierto: riesgoAbierto.toFixed(2),
          }),
        }),
      );
      const cap = D(limites.capital);
      const perdidaHoy = Decimal.max(
        0,
        D(realizadoHoy.toFixed(2)).minus(riesgoAbierto.toFixed(2)).neg(),
      );
      const riesgoMax = Decimal.min(
        cap.mul(limites.riesgoPct).div(100),
        cap.mul(limites.perdidaDiariaPct).div(100).minus(perdidaHoy).mul('0.9'),
      );
      const margenMax = Decimal.min(cap.mul(limites.margenPct).div(100), D(saldoLibre).mul('0.9'));
      const topeApalancamiento = Math.min(apalancamientoMax, usuario ?? 99, 50);
      for (const c of salida.pares[0].candidatos) {
        const largo = c.lado === 'LONG';
        for (const o of c.stops) {
          if (!o.viable) continue;
          viables++;
          // 1. La pérdida al stop, con costes, cabe en el riesgo y en lo que queda del día.
          expect(D(o.perdidaAlStop ?? 'NaN').lte(riesgoMax.plus('0.000001'))).toBe(true);
          for (const b of o.bandas) {
            // 2. La liquidación, detrás del stop.
            if (b.liquidacion !== null) {
              expect(largo ? D(b.liquidacion).lt(o.precio) : D(b.liquidacion).gt(o.precio)).toBe(
                true,
              );
            }
            // 3. El margen, dentro del tope, y la palanca, dentro de todos los topes.
            expect(D(b.margen).lte(margenMax.plus('0.01'))).toBe(true);
            expect(b.apalancamiento).toBeLessThanOrEqual(topeApalancamiento);
            expect(b.apalancamiento).toBeGreaterThanOrEqual(1);
          }
        }
      }
    }
    // Que la propiedad no pase en vacío.
    expect(viables).toBeGreaterThan(50);
  });
});

describe('la oferta', () => {
  const opcion = (r1: number, viable = true): OpcionStop => ({
    tipo: TipoStop.NORMAL,
    precio: '95',
    distancia: 0.05,
    viable,
    motivo: viable ? null : 'RR',
    nocional: '100',
    cantidad: '1',
    riesgo: '5',
    perdidaAlStop: '5',
    perdidaPorUnidad: '5',
    esquemasViables: viable ? [EsquemaObjetivo.MEDIA, EsquemaObjetivo.ESCALONADO] : [],
    bandas: [
      {
        banda: BandaApalancamiento.BAJA,
        apalancamiento: 2,
        margen: '50',
        liquidacion: '50',
        perdidaCatastrofica: '50',
      },
    ],
    apalancamientoMinimo: 2,
    apalancamientoMaximo: 2,
    rNetoTp1: r1,
    rNetoTp2: r1 * 2,
    costeR: 0.1,
    aciertoEquilibrioTp1: 0.4,
    aciertoEquilibrioTp2: 0.3,
    riesgoPctCapital: 0.5,
    medioViable: true,
  });
  const candidato = (id: string, wilson: number | null, r1: number): CandidatoAgente => ({
    id,
    simbolo: id,
    familia: FamiliaAgente.TENDENCIA,
    lado: 'LONG',
    entradaReferencia: '100',
    entradaTope: '100.1',
    extremo: '96',
    nivel: null,
    tp1: '105',
    tp2: '110',
    stops: [opcion(r1)],
    tasas:
      wilson === null
        ? null
        : { n: 30, aciertos: 15, rMedio: 0.1, wilsonInferior: wilson, evidencia: Evidencia.DEBIL },
    descartes: [],
  });
  const salida = (cs: CandidatoAgente[]): SalidaAgente => ({
    version: 1,
    barT: 0,
    generadaEn: 0,
    intervalo: '1h',
    pares: cs.map((c) => ({ simbolo: c.simbolo, mercado: null, candidatos: [c], descartes: [] })),
    uso: usoDelDia(historialAgenteDePrueba(), limitesDePrueba()),
    huella: '',
  });

  it('primero lo que dice el histórico, luego el R, luego el id', () => {
    const oferta = ofertaAgente(
      salida([
        candidato('C', 0.3, 1),
        candidato('A', 0.5, 1),
        candidato('B', 0.3, 2),
        candidato('D', null, 5),
        candidato('E', 0.3, 1),
      ]),
    );
    expect(oferta.map((p) => [p.letra, p.candidato.id])).toEqual([
      ['A', 'A'],
      ['B', 'B'],
      ['C', 'C'],
      ['D', 'E'],
      ['E', 'D'],
    ]);
  });

  it('solo elegibles, y como mucho ocho', () => {
    const muchos = Array.from({ length: 12 }, (_, i) => candidato(`P${10 + i}`, 0.2, 1));
    const noViable = { ...candidato('X', 0.9, 9), stops: [opcion(9, false)] };
    const descartado = { ...candidato('Y', 0.9, 9), descartes: ['ESPERANZA_NEGATIVA'] };
    const oferta = ofertaAgente(salida([...muchos, noViable, descartado]));
    expect(oferta).toHaveLength(MAX_OFERTA_AGENTE);
    expect(oferta.map((p) => p.letra)).toEqual(LETRAS_OFERTA);
    expect(oferta.map((p) => p.candidato.id)).not.toContain('X');
    expect(oferta.map((p) => p.candidato.id)).not.toContain('Y');
  });

  it('la huella solo cambia con la vela o con lo elegible', () => {
    const s = salida([candidato('A', 0.5, 1), candidato('B', 0.3, 2)]);
    const h = huellaAgente(1, s.pares);
    expect(huellaAgente(1, [...s.pares].reverse())).toBe(h);
    expect(huellaAgente(2, s.pares)).not.toBe(h);
    const menos = salida([candidato('A', 0.5, 1)]);
    expect(huellaAgente(1, menos.pares)).not.toBe(h);
  });
});

describe('usoDelDia', () => {
  it('pérdida y riesgo abierto sobre el capital', () => {
    const u = usoDelDia(
      historialAgenteDePrueba({ realizadoHoy: '-50', riesgoAbierto: '30', vivas: 1 }),
      limitesDePrueba({ capital: '1000' }),
    );
    expect(u).toMatchObject({ perdidaHoyPct: 5, riesgoAbiertoPct: 3, topeDiarioPct: 2, vivas: 1 });
  });
});

it('ahoraTras deja la última vela recién cerrada', () => {
  const { velas } = SENALES[0];
  expect(ahoraTras(velas) - velas[velas.length - 1].t).toBe(HORA + MINUTO);
});
