import { DEFAULTS_AGENTE } from '@crypton/strategy-core';
import { SIN_FRENOS, type InterruptoresAgentes } from '@crypton/shared';
import { BAR_T, candidatoDePrueba, salidaDePrueba } from './agentes.fixture-spec';
import {
  agenteVista,
  autonomiaDe,
  cuentaDe,
  paresDeRonda,
  rondaVista,
  type FilaAgente,
  type FilaRonda,
} from './vistas';

/** Un agente, tal y como lo enseña la app (spec 074). */

const AHORA = Date.parse('2026-09-24T15:00:00Z');

const INTERRUPTORES: InterruptoresAgentes = {
  encendido: true,
  modeloDisponible: true,
  modelo: 'anthropic/claude-sonnet-5',
  entradas: 'ABIERTAS',
  motivoEntradas: null,
  frenos: { ...SIN_FRENOS },
  limiteAgente: 200,
  limiteGlobal: 600,
  llamadasGlobalesHoy: 3,
};

function fila(extra: Partial<FilaAgente> = {}): FilaAgente {
  return {
    id: 'ag-1',
    name: 'Tendencias',
    state: 'ACTIVO',
    pause_reason: null,
    symbols: ['BTC', 'ETH'],
    interval: '1h',
    families: ['TENDENCIA'],
    sides: ['LONG', 'SHORT'],
    decision_mode: 'IA',
    limits: { capital: '1000', ...DEFAULTS_AGENTE },
    auto_entry: 'MANUAL',
    auto_reduce: 'AUTO',
    auto_close: 'MANUAL',
    next_round_at: new Date('2026-09-24T16:00:15Z'),
    failures: 0,
    sleeping_until: null,
    last_error: null,
    usage_day: new Date('2026-09-24T00:00:00Z'),
    calls_today: 7,
    cost_today: '0.042',
    version: 3,
    created_at: new Date('2026-09-20T10:00:00Z'),
    archived_at: null,
    exchange_account: {
      id: 'acc-1',
      label: 'Principal',
      venue: 'HYPERLIQUID',
      paper: false,
      testnet: false,
    },
    ...extra,
  };
}

const vista = (f: FilaAgente, i = INTERRUPTORES) =>
  agenteVista(f, { vivas: 1, pendientes: 2 }, i, AHORA);

describe('agenteVista', () => {
  it('el agente entero, con su uso de hoy y su pastilla', () => {
    expect(vista(fila())).toEqual({
      id: 'ag-1',
      nombre: 'Tendencias',
      estado: 'ACTIVO',
      motivoPausa: null,
      cuenta: {
        id: 'acc-1',
        nombre: 'Principal',
        venue: 'HYPERLIQUID',
        simulacion: false,
        testnet: false,
        real: true,
      },
      pares: ['BTC', 'ETH'],
      intervalo: '1h',
      familias: ['TENDENCIA'],
      lados: ['LONG', 'SHORT'],
      modo: 'IA',
      limites: { capital: '1000', ...DEFAULTS_AGENTE },
      autonomia: { entrar: 'MANUAL', reducir: 'AUTO', cerrar: 'MANUAL' },
      version: 3,
      proximaRonda: '2026-09-24T16:00:15.000Z',
      dormidoHasta: null,
      fallos: 0,
      ultimoError: null,
      consultasHoy: 7,
      costeHoy: '0.042',
      vivas: 1,
      pendientes: 2,
      insignia: 'ACTIVO',
      creadoEn: '2026-09-20T10:00:00.000Z',
      archivadoEn: null,
    });
  });

  it('los contadores de otro día cuentan cero', () => {
    const v = vista(fila({ usage_day: new Date('2026-09-23T00:00:00Z') }));
    expect([v.consultasHoy, v.costeHoy]).toEqual([0, '0']);
  });

  it('el motivo de la pausa, solo en pausa', () => {
    expect(vista(fila({ state: 'PAUSADO', pause_reason: 'KILL_SWITCH' })).motivoPausa).toBe(
      'KILL_SWITCH',
    );
    expect(vista(fila({ state: 'ACTIVO', pause_reason: 'MANUAL' })).motivoPausa).toBeNull();
  });

  it('la pastilla dice si va a abrir algo: apagado, cortado, sin modelo, reglas, mide', () => {
    expect(vista(fila(), { ...INTERRUPTORES, encendido: false }).insignia).toBe('APAGADO');
    expect(vista(fila(), { ...INTERRUPTORES, entradas: 'CERRADAS' }).insignia).toBe('CORTADO');
    expect(vista(fila(), { ...INTERRUPTORES, modeloDisponible: false }).insignia).toBe(
      'SIN_MODELO',
    );
    expect(
      vista(fila({ decision_mode: 'REGLAS' }), { ...INTERRUPTORES, modeloDisponible: false })
        .insignia,
    ).toBe('REGLAS');
    expect(vista(fila({ auto_entry: 'OFF' })).insignia).toBe('MIDE');
    expect(vista(fila({ sleeping_until: new Date(AHORA + 3_600_000) })).insignia).toBe('DORMIDO');
  });

  it('la cuenta de simulación y la de testnet no son dinero real', () => {
    const cuenta = fila().exchange_account;
    expect(cuentaDe({ ...cuenta, paper: true }).real).toBe(false);
    expect(cuentaDe({ ...cuenta, testnet: true }).real).toBe(false);
  });

  it('una autonomía guardada que no se entiende cuenta como OFF, que es lo prudente', () => {
    expect(autonomiaDe({ auto_entry: 'SIEMPRE', auto_reduce: 'AUTO', auto_close: '' })).toEqual({
      entrar: 'OFF',
      reducir: 'AUTO',
      cerrar: 'OFF',
    });
  });
});

describe('rondaVista', () => {
  const fila = (extra: Partial<FilaRonda> = {}): FilaRonda => ({
    id: 'r-1',
    kind: 'ENTRADA',
    bar_t: new Date(BAR_T),
    trigger: 'INTERVALO',
    state: 'COMPLETADA',
    reason: 'PROPUESTA',
    decision_mode: 'IA',
    created_at: new Date(BAR_T + 3_615_000),
    finished_at: new Date(BAR_T + 3_630_000),
    model: 'x/y',
    latency_ms: 1234,
    cost: '0.004',
    decision: {
      eleccion: {
        candidatoId: candidatoDePrueba().id,
        stop: 'NORMAL',
        objetivo: 'ESCALONADO',
        apalancamiento: 'BAJA',
        tamano: 'COMPLETO',
        confianza: 'ALTA',
      },
      juez: null,
      respuesta: null,
      fallo: null,
    },
    snapshot: salidaDePrueba(),
    proposals: [{ id: 'p-1' }],
    ...extra,
  });

  it('la ronda, con lo que eligió y lo que vio par a par, con las letras de su oferta', () => {
    const v = rondaVista(fila());
    expect(v).toMatchObject({
      id: 'r-1',
      tipo: 'ENTRADA',
      estado: 'COMPLETADA',
      motivo: 'PROPUESTA',
      modo: 'IA',
      coste: '0.004',
      propuestaId: 'p-1',
      eleccion: { candidatoId: candidatoDePrueba().id },
      juez: null,
    });
    // Las letras no se guardan: salen del mismo snapshot, igual que en la ronda.
    expect(v.pares).toEqual([
      {
        simbolo: 'BTC',
        descartes: [],
        candidatos: [{ familia: 'TENDENCIA', lado: 'LONG', elegible: true, letra: 'A' }],
      },
      {
        simbolo: 'ETH',
        descartes: [],
        candidatos: [{ familia: 'RUPTURA', lado: 'SHORT', elegible: true, letra: 'B' }],
      },
      { simbolo: 'SOL', descartes: ['OCUPADO'], candidatos: [] },
    ]);
  });

  it('un snapshot vaciado por la retención deja la ronda sin pares, no sin vista', () => {
    expect(paresDeRonda(null)).toEqual([]);
    expect(paresDeRonda({ version: 2 })).toEqual([]);
    expect(rondaVista(fila({ snapshot: null, decision: null, proposals: [] }))).toMatchObject({
      pares: [],
      eleccion: null,
      propuestaId: null,
    });
  });
});
