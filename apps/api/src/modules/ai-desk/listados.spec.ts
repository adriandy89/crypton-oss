import { tarjetaAgente } from '@crypton/strategy-core';
import { BAR_T, planDePrueba } from './agentes.fixture-spec';
import {
  accionVista,
  estadoOperacionDe,
  filaCandidatoDe,
  filaPropuestaDe,
  propuestaVista,
  revisionVista,
  type FilaAccion,
  type FilaPropuestaVista,
} from './listados';

/**
 * De las filas a lo que enseña la app (spec 074): propuestas, operaciones,
 * acciones, revisiones y las filas de la tarjeta. Lo que no tiene la forma
 * esperada se enseña vacío, nunca se inventa.
 */

const T = new Date('2026-09-24T12:00:00Z');
const dec = (s: string) => ({ toString: () => s });

const ESTADO = {
  rAhora: 1.1,
  mfeR: 1.4,
  maeR: -0.2,
  minutos: 120,
  fraccionTiempo: 0.1,
  tp1Hecho: true,
  stopR: 0,
  posicionFraccion: 0.5,
  objetivoR: 2.2,
  tesis: 'INTACTA',
  motivosTesis: [],
  regimen: 'TENDENCIA',
  sentido: 'ALCISTA',
};

const accion = (extra: Partial<FilaAccion> = {}): FilaAccion => ({
  id: 'ac-1',
  action: 'PROTEGER',
  action_class: 'REDUCIR',
  state: 'APLICADA',
  reason: null,
  change: { stopPrice: '100.2' },
  decision: {
    respuesta: null,
    opcion: { accion: 'PROTEGER', riesgoRestanteR: 0 },
  },
  expires_at: T,
  decided_by: 'AUTO',
  decided_at: T,
  created_at: T,
  ...extra,
});

function fila(extra: Partial<FilaPropuestaVista> = {}): FilaPropuestaVista {
  return {
    id: 'p-1',
    agent_id: 'ag-1',
    symbol: 'BTC',
    family: 'TENDENCIA',
    side: 'LONG',
    state: 'PROPUESTA',
    reason: null,
    plan: planDePrueba({ barT: BAR_T }),
    final_plan: null,
    decision: {
      eleccion: planDePrueba().eleccion,
      respuesta: null,
      efecto: 'PROPONE',
    },
    dry_run: false,
    expires_at: T,
    decided_by: null,
    decided_at: null,
    bot_id: null,
    opened_at: null,
    closed_at: null,
    exit: null,
    realized_pnl: null,
    r_real: null,
    outcome: null,
    measured_at: null,
    created_at: T,
    agent: { name: 'Tendencias' },
    bot: null,
    actions: [],
    followup_rounds: [],
    ...extra,
  };
}

/** Una operación abierta: entró a 100 con el stop a 97, la marca va a 103. */
const abierta = (extra: Partial<FilaPropuestaVista> = {}) =>
  fila({
    state: 'ABIERTA',
    bot_id: 'b-1',
    opened_at: T,
    bot: {
      status: 'RUNNING',
      cycles: [
        {
          average_entry: dec('100'),
          scratch: {
            op: { intento: 1, enviadaEn: 1, stopInicial: '97', stop: '100.2', tp1Hecho: true },
          },
        },
      ],
      snapshots: [
        {
          position_qty: dec('0.5'),
          average_entry: dec('100'),
          mark_price: dec('103'),
          equity: dec('4.25'),
          taken_at: T,
        },
      ],
    },
    actions: [accion()],
    followup_rounds: [{ created_at: T, snapshot: { estado: ESTADO, opciones: [] } }],
    ...extra,
  });

describe('propuestaVista', () => {
  it('una propuesta pendiente: su plan, lo que se eligió y cómo se decide, sin operación', () => {
    const v = propuestaVista(fila());
    expect(v).toMatchObject({
      id: 'p-1',
      agenteId: 'ag-1',
      agente: 'Tendencias',
      real: true,
      simbolo: 'BTC',
      familia: 'TENDENCIA',
      lado: 'LONG',
      estado: 'PROPUESTA',
      efecto: 'PROPONE',
      caducaEn: T.toISOString(),
      hipotetico: null,
      medidaEn: null,
      operacion: null,
    });
    expect(v.plan?.stop).toBe('97');
    expect(v.eleccion?.stop).toBe('NORMAL');
  });

  it('lo que no tiene la forma del contrato se enseña vacío', () => {
    const v = propuestaVista(
      fila({ plan: { version: 9 }, decision: { efecto: 'EXPLOTA', eleccion: 'A' }, dry_run: true }),
    );
    expect(v).toMatchObject({ plan: null, eleccion: null, efecto: null, real: false });
  });

  it('con su medida: el resultado hipotético y cuándo se midió', () => {
    const v = propuestaVista(
      fila({ outcome: { resultado: 'STOP', r: -1, en: BAR_T + 3_600_000 }, measured_at: T }),
    );
    expect(v.hipotetico).toEqual({ resultado: 'STOP', r: -1, en: BAR_T + 3_600_000 });
    expect(v.medidaEn).toBe(T.toISOString());
  });
});

describe('operacionVista', () => {
  it('viva: el R con la marca sobre el riesgo inicial, el resultado del snapshot y el stop ceñido', () => {
    const op = propuestaVista(abierta()).operacion;
    expect(op).toMatchObject({
      botId: 'b-1',
      estadoBot: 'RUNNING',
      entrada: '100',
      marca: '103',
      posicion: '0.5',
      // El más ceñido que lleva el motor, no el del plan.
      stop: '100.2',
      tp1Hecho: true,
      // (103 − 100) / (100 − 97): 1R es lo que se arriesgaba al entrar.
      r: 1,
      resultado: '4.25',
      vistoEn: T.toISOString(),
      revision: { en: T.toISOString(), estado: ESTADO },
    });
    expect(op?.ultimaAccion).toMatchObject({ accion: 'PROTEGER', stopNuevo: '100.2' });
  });

  it('terminada: lo realizado y su R real, sin lo de ahora', () => {
    const op = propuestaVista(
      abierta({
        state: 'CERRADA',
        closed_at: T,
        exit: 'OBJETIVO',
        realized_pnl: dec('7.5000'),
        r_real: dec('1.50000000'),
      }),
    ).operacion;
    expect(op).toMatchObject({
      salida: 'OBJETIVO',
      r: 1.5,
      resultado: '7.5',
      marca: null,
      posicion: null,
      vistoEn: null,
      cerradaEn: T.toISOString(),
    });
  });

  it('sin snapshot ni ciclo, lo de ahora queda vacío; una revisión con otra forma, también', () => {
    const op = propuestaVista(
      abierta({
        bot: { status: 'RUNNING', cycles: [], snapshots: [] },
        followup_rounds: [{ created_at: T, snapshot: { estado: { ...ESTADO, rAhora: 'mucho' } } }],
      }),
    ).operacion;
    expect(op).toMatchObject({
      entrada: null,
      marca: null,
      stop: null,
      r: null,
      resultado: null,
      revision: null,
    });
  });

  it('un corto gana cuando el precio baja', () => {
    const op = propuestaVista(
      abierta({
        side: 'SHORT',
        bot: {
          status: 'RUNNING',
          cycles: [
            {
              average_entry: dec('100'),
              scratch: { op: { intento: 1, enviadaEn: 1, stopInicial: '104' } },
            },
          ],
          snapshots: [
            {
              position_qty: dec('-1'),
              average_entry: dec('100'),
              mark_price: dec('98'),
              equity: dec('2'),
              taken_at: T,
            },
          ],
        },
      }),
    ).operacion;
    expect(op?.r).toBe(0.5);
    expect(op?.stop).toBe('104');
  });
});

describe('accionVista y revisionVista', () => {
  it('una acción: lo que deja y lo que queda en riesgo', () => {
    expect(accionVista(accion())).toMatchObject({
      accion: 'PROTEGER',
      clase: 'REDUCIR',
      estado: 'APLICADA',
      stopNuevo: '100.2',
      posicionNueva: null,
      riesgoRestanteR: 0,
      respuesta: null,
      decididaPor: 'AUTO',
    });
    // Un cambio con algo más que stop y tope no se enseña como si valiera.
    expect(accionVista(accion({ change: { stopPrice: '100.2', leverage: '20' } }))).toMatchObject({
      stopNuevo: null,
      posicionNueva: null,
    });
  });

  it('una revisión: cómo iba, lo elegido y lo que habría elegido el juez', () => {
    const fila = {
      id: 'r-1',
      trigger: 'OBJETIVO_1',
      state: 'COMPLETADA',
      reason: 'ACCION',
      decision_mode: 'REGLAS',
      created_at: T,
      model: null,
      cost: null,
      decision: { accion: 'PROTEGER', juez: 'PROTEGER', respuesta: null },
      snapshot: { estado: ESTADO, opciones: [] },
    };
    expect(revisionVista(fila)).toMatchObject({
      disparador: 'OBJETIVO_1',
      modo: 'REGLAS',
      operacion: ESTADO,
      accion: 'PROTEGER',
      juez: 'PROTEGER',
      coste: null,
    });
    // Parada antes de mirar, con un coste y una acción que no existe.
    const parada = {
      ...fila,
      state: 'SALTADA',
      reason: 'BOT',
      cost: dec('0.0012000'),
      decision: { accion: 'SUBIR' },
      snapshot: null,
    };
    expect(revisionVista(parada)).toMatchObject({ operacion: null, accion: null, coste: '0.0012' });
    expect(revisionVista(fila).sinModelo).toBeNull();
  });

  it('una revisión que decidió el juez por falta de modelo lo dice (spec 078)', () => {
    const fila = {
      id: 'r-2',
      trigger: 'INTERVALO',
      state: 'COMPLETADA',
      reason: 'MANTENER',
      decision_mode: 'IA',
      created_at: T,
      model: 'x/y',
      cost: null,
      decision: {
        accion: 'MANTENER',
        juez: 'MANTENER',
        respuesta: null,
        sinModelo: 'MODELO:TIEMPO',
        fallo: 'TIEMPO',
      },
      snapshot: { estado: ESTADO, opciones: [] },
    };
    expect(revisionVista(fila)).toMatchObject({ sinModelo: 'MODELO:TIEMPO', fallo: 'TIEMPO' });
  });

  it('estadoOperacionDe exige cada campo', () => {
    expect(estadoOperacionDe(ESTADO)).toEqual(ESTADO);
    expect(estadoOperacionDe({ ...ESTADO, tesis: 'MEDIO' })).toBeNull();
    expect(estadoOperacionDe({ ...ESTADO, objetivoR: null })).not.toBeNull();
    expect(estadoOperacionDe({ ...ESTADO, motivosTesis: [1] })).toBeNull();
    expect(estadoOperacionDe(null)).toBeNull();
  });
});

describe('las filas de la tarjeta', () => {
  it('de las columnas a lo que cuenta `tarjetaAgente`', () => {
    const c = [
      filaCandidatoDe({
        eligible: true,
        chosen: true,
        outcome: { resultado: 'OBJETIVO', r: 1.6, en: 1 },
      }),
      filaCandidatoDe({
        eligible: true,
        chosen: false,
        outcome: { resultado: 'STOP', r: -1, en: 1 },
      }),
      filaCandidatoDe({ eligible: true, chosen: false, outcome: { r: 'no' } }),
    ];
    expect(c[2].rHipotetico).toBeNull();
    const p = [
      filaPropuestaDe({
        family: 'TENDENCIA',
        side: 'LONG',
        state: 'CERRADA',
        reason: null,
        outcome: { resultado: 'OBJETIVO', r: 1.6, en: 1 },
        r_real: dec('1.40000000'),
        realized_pnl: dec('7'),
        exit: 'OBJETIVO',
      }),
      filaPropuestaDe({
        family: 'RUPTURA',
        side: 'SHORT',
        state: 'RECHAZADA',
        reason: 'PERSONA',
        outcome: { resultado: 'STOP', r: -1, en: 1 },
        r_real: null,
        realized_pnl: null,
        exit: null,
      }),
    ];
    const t = tarjetaAgente(c, p);
    expect(t).toMatchObject({ propuestas: 2, tomadas: 1, rechazadas: 1, resultado: '7' });
    expect(t.elegidas).toMatchObject({ n: 1, rMedio: 1.6 });
    expect(t.noElegidas).toMatchObject({ n: 1, rMedio: -1 });
    expect(t.descartes).toMatchObject({ n: 1, rMedio: -1 });
    expect(t.brechaEjecucion).toBeCloseTo(-0.2, 10);
  });
});
