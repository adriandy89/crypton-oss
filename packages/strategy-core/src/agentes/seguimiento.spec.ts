import {
  AccionSeguimiento,
  ClaseAccion,
  D,
  EfectoAccion,
  EstadoTesis,
  FamiliaAgente,
  NivelConfianza,
  ObjetivoAgente,
  RegimenMercado,
  TamanoOperacion,
  TipoStop,
  BandaApalancamiento,
  cambioSeguimientoDe,
  type Candle,
  type EstadoOperacionAgente,
  type PlanAgente,
} from '@crypton/shared';
import { mulberry32 } from '../canal/testing-canal';
import { serieNumerica } from '../canal/numeros';
import { indicadoresAgente, regimenAgente } from './mercado';
import {
  estadoOperacion,
  eventoSeguimiento,
  huellaSeguimiento,
  ofreciblesSegun,
  opcionesSeguimiento,
  tesisDe,
  type EntradaSeguimiento,
  type OperacionViva,
} from './seguimiento';
import {
  HORA,
  ahoraTras,
  mercadoAgente,
  serieRango,
  serieTendencia,
  velasDePrecios,
} from './testing-agentes';

/**
 * El seguimiento (spec 074, R-22): solo se ofrece lo que reduce el riesgo, y
 * solo lo que es válido ahora. La propiedad del final lo afirma para cualquier
 * operación: ninguna opción ensancha el stop, sube la posición ni deja más
 * pérdida al stop que la que hay.
 */

const VELAS = serieRango(7);
const ENTRADA_T = VELAS[VELAS.length - 1].t - 20 * HORA;

function plan(o: Partial<PlanAgente> = {}): PlanAgente {
  return {
    version: 1,
    simbolo: 'SOL',
    familia: FamiliaAgente.REVERSION,
    lado: 'LONG',
    intervalo: '1h',
    eleccion: {
      candidatoId: 'SOL|REVERSION|LONG|0',
      stop: TipoStop.NORMAL,
      objetivo: ObjetivoAgente.ESCALONADO,
      apalancamiento: BandaApalancamiento.BAJA,
      tamano: TamanoOperacion.COMPLETO,
      confianza: NivelConfianza.ALTA,
    },
    entradaReferencia: '100',
    entradaTope: '100',
    extremo: '98.5',
    nivelIdea: null,
    stop: '98',
    tp1: '103',
    tp2: '106',
    objetivos: [
      { precio: '103', cantidad: '0.6' },
      { precio: '106', cantidad: '0.4' },
    ],
    cantidad: '1',
    apalancamiento: 3,
    nocional: '100',
    margen: '33.33',
    riesgo: '2.11',
    riesgoPctCapital: 0.02,
    rNeto: 2,
    liquidacionEstimada: '67',
    distanciaStop: 0.02,
    barT: ENTRADA_T - HORA,
    huella: 'h',
    entradaHasta: ENTRADA_T,
    maxMinutos: 1440,
    breakevenTrasTp1: true,
    costes: { makerBps: 1.5, takerBps: 4.5, deslizamientoBps: 2 },
    ...o,
  };
}

function viva(o: Partial<OperacionViva> = {}, p: Partial<PlanAgente> = {}): OperacionViva {
  const pl = plan(p);
  return {
    plan: pl,
    entrada: '100',
    posicion: pl.cantidad,
    posicionInicial: pl.cantidad,
    stop: pl.stop,
    tp1Hecho: false,
    abiertaEn: ENTRADA_T,
    ...o,
  };
}

function seguir(
  op: OperacionViva,
  marca: string,
  velas: readonly Candle[] = VELAS,
): EntradaSeguimiento {
  const ahora = ahoraTras(velas);
  return {
    op,
    market: mercadoAgente(),
    ticker: {
      venue: 'HYPERLIQUID',
      symbol: 'SOL',
      last: marca,
      bid: marca,
      ask: marca,
      mark: marca,
      ts: ahora,
    },
    velas,
    ahora,
  };
}

const acciones = (e: EntradaSeguimiento) => opcionesSeguimiento(e).map((o) => o.accion);

describe('opcionesSeguimiento', () => {
  it('en beneficio: proteger, asegurar, reducir y cerrar, y mantener la primera', () => {
    const opciones = opcionesSeguimiento(seguir(viva(), '104'));
    expect(opciones.map((o) => o.accion)).toEqual([
      AccionSeguimiento.MANTENER,
      AccionSeguimiento.PROTEGER,
      AccionSeguimiento.ASEGURAR_MEDIO_R,
      AccionSeguimiento.ASEGURAR_UN_R,
      AccionSeguimiento.REDUCIR_TERCIO,
      AccionSeguimiento.REDUCIR_MITAD,
      AccionSeguimiento.CERRAR,
    ]);
    const porAccion = new Map(opciones.map((o) => [o.accion, o]));
    // Breakeven: 100 × (1 + 0,0011) = 100,11 → la venta redondea hacia arriba.
    expect(porAccion.get(AccionSeguimiento.PROTEGER)?.cambio).toEqual({ stopPrice: '100.11' });
    expect(porAccion.get(AccionSeguimiento.ASEGURAR_MEDIO_R)?.cambio).toEqual({ stopPrice: '101' });
    expect(porAccion.get(AccionSeguimiento.ASEGURAR_UN_R)?.cambio).toEqual({ stopPrice: '102' });
    expect(porAccion.get(AccionSeguimiento.REDUCIR_TERCIO)?.cambio).toEqual({
      positionCap: '0.666',
    });
    expect(porAccion.get(AccionSeguimiento.REDUCIR_MITAD)?.cambio).toEqual({ positionCap: '0.5' });
    expect(porAccion.get(AccionSeguimiento.CERRAR)?.cambio).toEqual({ positionCap: '0' });
    expect(porAccion.get(AccionSeguimiento.MANTENER)?.riesgoRestanteR).toBe(1);
    expect(porAccion.get(AccionSeguimiento.PROTEGER)?.riesgoRestanteR).toBe(0);
  });

  it('en pérdida no hay stop que ceñir: solo reducir o cerrar', () => {
    expect(acciones(seguir(viva(), '99'))).toEqual([
      AccionSeguimiento.MANTENER,
      AccionSeguimiento.REDUCIR_TERCIO,
      AccionSeguimiento.REDUCIR_MITAD,
      AccionSeguimiento.CERRAR,
    ]);
  });

  it('un stop que no ciñe más que el vigente no se ofrece', () => {
    const a = acciones(seguir(viva({ stop: '101' }), '104'));
    expect(a).not.toContain(AccionSeguimiento.PROTEGER);
    expect(a).not.toContain(AccionSeguimiento.ASEGURAR_MEDIO_R);
    expect(a).toContain(AccionSeguimiento.ASEGURAR_UN_R);
  });

  it('un stop pegado al precio no se ofrece: es un cierre disfrazado', () => {
    // A 102,05 el stop de 1R (102) quedaría a cinco centavos del precio.
    expect(acciones(seguir(viva(), '102.05'))).not.toContain(AccionSeguimiento.ASEGURAR_UN_R);
  });

  it('el corto, en espejo', () => {
    const corto = viva(
      {},
      {
        lado: 'SHORT',
        stop: '102',
        objetivos: [
          { precio: '97', cantidad: '0.6' },
          { precio: '94', cantidad: '0.4' },
        ],
      },
    );
    const opciones = opcionesSeguimiento(seguir(corto, '96'));
    const porAccion = new Map(opciones.map((o) => [o.accion, o]));
    // 100 × (1 − 0,0011) = 99,89 → la compra redondea hacia abajo.
    expect(porAccion.get(AccionSeguimiento.PROTEGER)?.cambio).toEqual({ stopPrice: '99.89' });
    expect(porAccion.get(AccionSeguimiento.ASEGURAR_UN_R)?.cambio).toEqual({ stopPrice: '98' });
  });

  it('reducir solo si lo que sale y lo que queda llegan a los mínimos del venue', () => {
    // 0,15 a 100 son 15 USDC: un tercio sale por 5, por debajo de los 10 de mínimo.
    const poca = viva({ posicion: '0.15', posicionInicial: '0.15' }, { cantidad: '0.15' });
    expect(acciones(seguir(poca, '104'))).not.toContain(AccionSeguimiento.REDUCIR_TERCIO);
    expect(acciones(seguir(poca, '104'))).not.toContain(AccionSeguimiento.REDUCIR_MITAD);
    expect(acciones(seguir(poca, '104'))).toContain(AccionSeguimiento.CERRAR);
  });

  it('sin posición, solo mantener', () => {
    expect(acciones(seguir(viva({ posicion: '0' }), '104'))).toEqual([AccionSeguimiento.MANTENER]);
  });
});

describe('propiedad: ninguna acción sube el riesgo (R-22, CA-4)', () => {
  it('con operaciones al azar, en los dos lados', () => {
    const azar = mulberry32(22);
    let probadas = 0;
    for (let caso = 0; caso < 400; caso++) {
      const largo = azar() < 0.5;
      const riesgo = 0.5 + azar() * 4;
      const stopInicial = largo ? 100 - riesgo : 100 + riesgo;
      // El stop vigente, entre el inicial y más allá de la entrada.
      const avance = -1 + azar() * 2.5;
      const stop = largo ? 100 + avance * riesgo : 100 - avance * riesgo;
      const marca = largo ? stop + 0.05 + azar() * 8 : stop - 0.05 - azar() * 8;
      const inicial = (0.1 + azar() * 5).toFixed(3);
      const pos = D(inicial)
        .mul(0.2 + azar() * 0.8)
        .toDecimalPlaces(3, 1)
        .toFixed();
      const op = viva(
        { stop: stop.toFixed(2), posicion: pos, posicionInicial: inicial },
        {
          lado: largo ? 'LONG' : 'SHORT',
          stop: stopInicial.toFixed(2),
          cantidad: inicial,
        },
      );
      if (!(marca > 0)) continue;
      const opciones = opcionesSeguimiento(seguir(op, marca.toFixed(2)));
      const mantener = opciones[0];
      expect(mantener.accion).toBe(AccionSeguimiento.MANTENER);
      for (const o of opciones.slice(1)) {
        probadas++;
        // Solo los dos campos, y en su forma.
        expect(cambioSeguimientoDe(o.cambio)).toEqual(o.cambio);
        if (o.cambio.stopPrice !== undefined) {
          const nuevo = D(o.cambio.stopPrice);
          expect(largo ? nuevo.gt(op.stop) : nuevo.lt(op.stop)).toBe(true);
          expect(largo ? nuevo.lt(marca) : nuevo.gt(marca)).toBe(true);
        }
        if (o.cambio.positionCap !== undefined) {
          expect(D(o.cambio.positionCap).lt(op.posicion)).toBe(true);
        }
        expect(o.riesgoRestanteR).toBeLessThanOrEqual(mantener.riesgoRestanteR + 1e-12);
        expect(o.clase).not.toBeNull();
      }
    }
    expect(probadas).toBeGreaterThan(500);
  });
});

describe('estadoOperacion', () => {
  it('las cuentas en R, sobre el riesgo inicial', () => {
    const e = estadoOperacion(seguir(viva({ stop: '100.11' }), '103'));
    expect(e.rAhora).toBe(1.5);
    expect(e.stopR).toBeCloseTo(0.055, 10);
    expect(e.objetivoR).toBe(0);
    expect(e.posicionFraccion).toBe(1);
    expect(e.tp1Hecho).toBe(false);
    expect(e.minutos).toBe(Math.round((ahoraTras(VELAS) - ENTRADA_T) / 60_000));
    expect(e.fraccionTiempo).toBeCloseTo(e.minutos / 1440, 2);
    expect(e.mfeR).toBeGreaterThanOrEqual(Math.max(0, e.rAhora));
    expect(e.maeR).toBeLessThanOrEqual(0);
  });

  it('con el primer objetivo hecho, el siguiente es el segundo', () => {
    const e = estadoOperacion(seguir(viva({ tp1Hecho: true, posicion: '0.4' }), '104'));
    expect(e.objetivoR).toBe(1);
    expect(e.posicionFraccion).toBe(0.4);
  });

  it('sin historia suficiente, la idea no se juzga', () => {
    const e = estadoOperacion(seguir(viva(), '101', VELAS.slice(-50)));
    expect(e.tesis).toBe(EstadoTesis.INTACTA);
    expect(e.motivosTesis).toEqual(['SIN_DATOS']);
    expect(e.regimen).toBe(RegimenMercado.INDEFINIDO);
  });
});

describe('tesisDe', () => {
  const juzgar = (p: Parameters<typeof tesisDe>[0], velas: readonly Candle[]) => {
    const s = serieNumerica(velas);
    return tesisDe(p, s, indicadoresAgente(s), regimenAgente(s));
  };

  it('una tendencia alcista sigue intacta mientras el precio respeta sus medias', () => {
    const velas = serieTendencia('LONG');
    const t = juzgar(
      { familia: FamiliaAgente.TENDENCIA, lado: 'LONG', extremo: '1', nivelIdea: null },
      velas,
    );
    expect(t.tesis).not.toBe(EstadoTesis.ROTA);
  });

  it('una caída por debajo de la media lenta la rompe', () => {
    const base = serieTendencia('LONG');
    const ultimo = Number(base[base.length - 1].c);
    const caida = velasDePrecios([
      ...base.map((v) => Number(v.c)),
      ...Array.from({ length: 8 }, (_, i) => ultimo - 4 * (i + 1)),
    ]);
    const t = juzgar(
      { familia: FamiliaAgente.TENDENCIA, lado: 'LONG', extremo: '1', nivelIdea: null },
      caida,
    );
    expect(t.tesis).toBe(EstadoTesis.ROTA);
    expect(t.motivos).toContain('CIERRE_TRAS_MEDIA_LENTA');
  });

  it('una ruptura que vuelve al rango, rota; que se queda en el borde, debilitada', () => {
    const velas = serieRango(7);
    const c = Number(velas[velas.length - 1].c);
    const rota = juzgar(
      { familia: FamiliaAgente.RUPTURA, lado: 'LONG', extremo: '1', nivelIdea: (c + 5).toString() },
      velas,
    );
    expect(rota.tesis).toBe(EstadoTesis.ROTA);
    expect(rota.motivos).toContain('VUELTA_AL_RANGO');
    const s = serieNumerica(velas);
    const atr = indicadoresAgente(s).atr[s.n - 1];
    const borde = juzgar(
      {
        familia: FamiliaAgente.RUPTURA,
        lado: 'LONG',
        extremo: '1',
        nivelIdea: (c + atr * 0.1).toString(),
      },
      velas,
    );
    expect(borde.motivos).toContain('DENTRO_DEL_NIVEL');
  });

  it('una reversión que marca un extremo nuevo se rompe', () => {
    const velas = serieRango(7);
    const c = Number(velas[velas.length - 1].c);
    const t = juzgar(
      {
        familia: FamiliaAgente.REVERSION,
        lado: 'LONG',
        extremo: (c + 1).toString(),
        nivelIdea: null,
      },
      velas,
    );
    expect(t.tesis).toBe(EstadoTesis.ROTA);
    expect(t.motivos).toContain('NUEVO_EXTREMO');
  });
});

describe('cuándo mira (R-24)', () => {
  const estado = (o: Partial<EstadoOperacionAgente> = {}): EstadoOperacionAgente => ({
    rAhora: 0.6,
    mfeR: 0.8,
    maeR: -0.2,
    minutos: 60,
    fraccionTiempo: 0.05,
    tp1Hecho: false,
    stopR: -1,
    posicionFraccion: 1,
    objetivoR: 0.9,
    tesis: EstadoTesis.INTACTA,
    motivosTesis: [],
    regimen: RegimenMercado.RANGO,
    sentido: null,
    ...o,
  });

  it('la huella no cambia con un precio que baila, y sí con lo que importa', () => {
    const h = huellaSeguimiento(estado(), []);
    expect(huellaSeguimiento(estado({ rAhora: 0.55, mfeR: 0.9, minutos: 75 }), [])).toBe(h);
    expect(huellaSeguimiento(estado({ rAhora: 1 }), [])).not.toBe(h);
    expect(huellaSeguimiento(estado({ tesis: EstadoTesis.DEBILITADA }), [])).not.toBe(h);
    expect(huellaSeguimiento(estado({ stopR: 0 }), [])).not.toBe(h);
  });

  it('los eventos: primer objetivo, idea rota y cambio de régimen', () => {
    expect(eventoSeguimiento(null, estado())).toBeNull();
    expect(eventoSeguimiento(estado(), estado({ rAhora: 1.2 }))).toBeNull();
    expect(eventoSeguimiento(estado(), estado({ tp1Hecho: true }))).toBe('OBJETIVO_1');
    expect(eventoSeguimiento(estado(), estado({ tesis: EstadoTesis.ROTA }))).toBe('TESIS_ROTA');
    expect(
      eventoSeguimiento(estado({ tesis: EstadoTesis.ROTA }), estado({ tesis: EstadoTesis.ROTA })),
    ).toBeNull();
    expect(eventoSeguimiento(estado(), estado({ regimen: RegimenMercado.TENDENCIA }))).toBe(
      'REGIMEN',
    );
  });
});

describe('ofreciblesSegun', () => {
  it('lo que nunca se hace no se ofrece; mantener, siempre', () => {
    const opciones = opcionesSeguimiento(seguir(viva(), '104'));
    const sinReducir = ofreciblesSegun(opciones, (c) =>
      c === ClaseAccion.REDUCIR ? EfectoAccion.NUNCA : EfectoAccion.PROPONE,
    );
    expect(sinReducir.map((o) => o.accion)).toEqual([
      AccionSeguimiento.MANTENER,
      AccionSeguimiento.CERRAR,
    ]);
    const nada = ofreciblesSegun(opciones, () => EfectoAccion.NUNCA);
    expect(nada.map((o) => o.accion)).toEqual([AccionSeguimiento.MANTENER]);
  });
});
