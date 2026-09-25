import { historialDe, type FilaHistorial } from './historial';

/**
 * Lo operado por un agente (spec 074): de ahí salen sus límites del día. Lo
 * que importa es que lo vivo cuente como perdido al stop y que lo pendiente
 * ocupe sitio, para que ni la capacidad ni el tope diario se puedan saltar
 * repartiendo operaciones entre propuestas.
 */

const AHORA = Date.parse('2026-09-24T15:00:00Z');
const HOY = Date.parse('2026-09-24T00:00:00Z');
const hace = (min: number) => new Date(AHORA - min * 60_000);

let n = 0;
function fila(extra: Partial<FilaHistorial> = {}): FilaHistorial {
  n++;
  return {
    id: `p-${n}`,
    symbol: 'BTC',
    state: 'CERRADA',
    plan: { riesgo: '5' },
    final_plan: null,
    expires_at: new Date(AHORA + 600_000),
    decided_at: null,
    opened_at: null,
    closed_at: null,
    exit: null,
    realized_pnl: null,
    ...extra,
  };
}

/** Un plan que el lector de shared da por bueno, con el riesgo pedido. */
function plan(riesgo: string): Record<string, unknown> {
  return {
    version: 1,
    simbolo: 'BTC',
    familia: 'TENDENCIA',
    lado: 'LONG',
    intervalo: '1h',
    eleccion: {
      candidatoId: 'BTC|TENDENCIA|LONG|1',
      stop: 'NORMAL',
      objetivo: 'ESCALONADO',
      apalancamiento: 'BAJA',
      tamano: 'COMPLETO',
      confianza: 'ALTA',
    },
    entradaReferencia: '100',
    entradaTope: '100.1',
    extremo: '95',
    nivelIdea: null,
    stop: '97',
    tp1: '105',
    tp2: '110',
    objetivos: [{ precio: '105', cantidad: '1' }],
    cantidad: '1',
    apalancamiento: 3,
    nocional: '100.1',
    margen: '33.37',
    riesgo,
    riesgoPctCapital: 0.5,
    rNeto: 1.6,
    liquidacionEstimada: '70',
    distanciaStop: 0.03,
    barT: 1,
    huella: 'h',
    entradaHasta: AHORA,
    maxMinutos: 1440,
    breakevenTrasTp1: true,
    costes: { makerBps: 1.5, takerBps: 4.5, deslizamientoBps: 2 },
  };
}

describe('historialDe', () => {
  it('sin nada, un día vacío', () => {
    expect(historialDe([], [], [], AHORA)).toEqual({
      dia: HOY,
      operacionesHoy: 0,
      realizadoHoy: '0',
      riesgoAbierto: '0',
      vivas: 0,
      pendientes: 0,
      rachaPerdidas: 0,
      ultimaPerdidaEn: null,
      ultimoStopEn: {},
      ocupados: [],
    });
  });

  it('lo vivo cuenta al stop, con el plan aprobado si lo hay', () => {
    const h = historialDe(
      [
        fila({ state: 'ABIERTA', plan: plan('5'), final_plan: plan('4'), opened_at: hace(30) }),
        fila({ state: 'EJECUTANDO', symbol: 'ETH', plan: plan('3'), decided_at: hace(2) }),
        fila({ state: 'APROBANDO', symbol: 'SOL', plan: plan('2') }),
      ],
      [],
      [],
      AHORA,
    );
    expect(h.vivas).toBe(3);
    expect(h.riesgoAbierto).toBe('9');
    // La que aún se aprueba no ha entrado: no cuenta como operación del día.
    expect(h.operacionesHoy).toBe(2);
    expect(h.ocupados).toEqual(['BTC', 'ETH', 'SOL']);
  });

  it('lo pendiente ocupa su par y cuenta como pendiente, salvo lo caducado', () => {
    const h = historialDe(
      [
        fila({ state: 'PROPUESTA', symbol: 'ETH' }),
        fila({ state: 'PROPUESTA', symbol: 'SOL', expires_at: hace(1) }),
      ],
      [],
      [],
      AHORA,
    );
    expect(h.pendientes).toBe(1);
    expect(h.vivas).toBe(0);
    expect(h.ocupados).toEqual(['ETH']);
  });

  it('la que se está aprobando no se cuenta a sí misma', () => {
    const aprobando = fila({ state: 'APROBANDO', plan: plan('5') });
    const h = historialDe([aprobando], [], [], AHORA, aprobando.id);
    expect(h.vivas).toBe(0);
    expect(h.riesgoAbierto).toBe('0');
    expect(h.ocupados).toEqual([]);
  });

  it('lo realizado hoy, y las operaciones que entraron hoy', () => {
    const h = historialDe(
      [],
      [
        fila({ realized_pnl: '-4', opened_at: hace(120), closed_at: hace(60) }),
        fila({ realized_pnl: '10', opened_at: hace(300), closed_at: hace(200) }),
        // De ayer: ni cuenta en el día ni como operación de hoy.
        fila({ realized_pnl: '-50', opened_at: hace(24 * 60), closed_at: hace(20 * 60) }),
      ],
      [],
      AHORA,
    );
    expect(h.realizadoHoy).toBe('6');
    expect(h.operacionesHoy).toBe(2);
  });

  it('la racha: pérdidas seguidas desde la última cerrada', () => {
    const h = historialDe(
      [],
      [
        fila({ realized_pnl: '-1', closed_at: hace(10) }),
        fila({ realized_pnl: '-2', closed_at: hace(20) }),
        fila({ realized_pnl: '3', closed_at: hace(30) }),
        fila({ realized_pnl: '-9', closed_at: hace(40) }),
      ],
      [],
      AHORA,
    );
    expect(h.rachaPerdidas).toBe(2);
    expect(h.ultimaPerdidaEn).toBe(hace(10).getTime());
  });

  it('un cierre sin resultado conocido corta la racha', () => {
    const h = historialDe(
      [],
      [
        fila({ realized_pnl: null, exit: 'FUERA', closed_at: hace(5) }),
        fila({ realized_pnl: '-2', closed_at: hace(20) }),
      ],
      [],
      AHORA,
    );
    expect(h.rachaPerdidas).toBe(0);
    expect(h.ultimaPerdidaEn).toBeNull();
  });

  it('el último stop de cada par, también la liquidación; lo demás no', () => {
    const h = historialDe(
      [],
      [
        fila({ symbol: 'BTC', exit: 'STOP', closed_at: hace(50) }),
        fila({ symbol: 'BTC', exit: 'STOP', closed_at: hace(10) }),
        fila({ symbol: 'ETH', exit: 'LIQUIDACION', closed_at: hace(30) }),
        fila({ symbol: 'SOL', exit: 'OBJETIVO', closed_at: hace(5) }),
        fila({ symbol: 'ARB', exit: 'STOP_PROTEGIDO', closed_at: hace(5) }),
      ],
      [],
      AHORA,
    );
    expect(h.ultimoStopEn).toEqual({ BTC: hace(10).getTime(), ETH: hace(30).getTime() });
  });

  it('los pares con un bot real vivo del usuario están ocupados (invariante 11)', () => {
    const h = historialDe([], [], ['DOGE', 'BTC'], AHORA);
    expect(h.ocupados).toEqual(['BTC', 'DOGE']);
  });
});
