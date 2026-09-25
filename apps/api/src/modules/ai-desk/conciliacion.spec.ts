import { conciliacion, rReal, type CicloOperacion } from './conciliacion';

/**
 * El estado de una operación sigue al de su bot (spec 074, R-21). Lo que se
 * fija: una operación no se da por cerrada sin su ciclo o sin su bot, se cierra
 * con su R, y un bot en ERROR —que se puede reparar, con su stop en el
 * exchange— no cambia nada.
 */

const AHORA = new Date('2026-09-24T15:00:00Z');
const ENTRADA = new Date('2026-09-24T12:05:00Z');
const CIERRE = new Date('2026-09-24T14:30:00Z');

const ciclo = (extra: Partial<CicloOperacion> = {}): CicloOperacion => ({
  entries_filled: 1,
  qty: '1',
  realized_pnl: '0',
  opened_at: new Date('2026-09-24T12:00:00Z'),
  last_entry_at: ENTRADA,
  closed_at: null,
  ...extra,
});

const ejecutando = { state: 'EJECUTANDO', opened_at: null, riesgo: '5' };
const abierta = { state: 'ABIERTA', opened_at: ENTRADA, riesgo: '5' };

describe('conciliacion', () => {
  it('la entrada llena abre la operación, con la hora de la entrada', () => {
    expect(
      conciliacion(ejecutando, { estado: 'RUNNING', ciclo: ciclo(), motivoSalida: null }, AHORA),
    ).toEqual({ state: 'ABIERTA', opened_at: ENTRADA });
  });

  it('sin entrada todavía, nada cambia', () => {
    const sinEntrada = ciclo({ entries_filled: 0, qty: '0', last_entry_at: null });
    expect(
      conciliacion(ejecutando, { estado: 'RUNNING', ciclo: sinEntrada, motivoSalida: null }, AHORA),
    ).toBeNull();
    expect(
      conciliacion(ejecutando, { estado: 'STARTING', ciclo: null, motivoSalida: null }, AHORA),
    ).toBeNull();
  });

  it('el ciclo cerrado cierra la operación, con lo realizado, su R y cómo salió', () => {
    const cerrado = ciclo({ closed_at: CIERRE, realized_pnl: '7.5', qty: '0' });
    expect(
      conciliacion(abierta, { estado: 'STOPPED', ciclo: cerrado, motivoSalida: 'OBJETIVO' }, AHORA),
    ).toEqual({
      state: 'CERRADA',
      opened_at: ENTRADA,
      closed_at: CIERRE,
      exit: 'OBJETIVO',
      realized_pnl: '7.5',
      r_real: '1.5',
    });
  });

  it('un cierre rápido, de EJECUTANDO a CERRADA sin pasar por ABIERTA', () => {
    const cerrado = ciclo({ closed_at: CIERRE, realized_pnl: '-5' });
    const c = conciliacion(
      ejecutando,
      { estado: 'STOPPED', ciclo: cerrado, motivoSalida: 'STOP' },
      AHORA,
    );
    expect(c).toMatchObject({ state: 'CERRADA', exit: 'STOP', r_real: '-1', opened_at: ENTRADA });
  });

  it('sin aviso de salida reconocible, la salida es FUERA, pero el R se cuenta igual', () => {
    const cerrado = ciclo({ closed_at: CIERRE, realized_pnl: '2' });
    for (const motivo of [null, 'INVENTADA']) {
      expect(
        conciliacion(abierta, { estado: 'STOPPED', ciclo: cerrado, motivoSalida: motivo }, AHORA),
      ).toMatchObject({ exit: 'FUERA', r_real: '0.4' });
    }
  });

  it('el bot terminó sin entrar: SIN_ENTRADA', () => {
    const vacio = ciclo({ entries_filled: 0, qty: '0', last_entry_at: null });
    expect(
      conciliacion(ejecutando, { estado: 'STOPPED', ciclo: vacio, motivoSalida: null }, AHORA),
    ).toEqual({ state: 'SIN_ENTRADA', reason: 'SIN_LLENADO', closed_at: AHORA });
  });

  it('el bot parado con la posición abierta: FUERA, sin R, con lo realizado hasta ahí', () => {
    const parcial = ciclo({ realized_pnl: '3' });
    expect(
      conciliacion(abierta, { estado: 'STOPPED', ciclo: parcial, motivoSalida: null }, AHORA),
    ).toEqual({
      state: 'CERRADA',
      opened_at: ENTRADA,
      closed_at: AHORA,
      exit: 'FUERA',
      realized_pnl: '3',
      r_real: null,
    });
  });

  it('un bot en ERROR no cambia nada: se repara, y su stop sigue en el exchange', () => {
    expect(
      conciliacion(abierta, { estado: 'ERROR', ciclo: ciclo(), motivoSalida: null }, AHORA),
    ).toBeNull();
    expect(
      conciliacion(abierta, { estado: 'PAUSED', ciclo: ciclo(), motivoSalida: null }, AHORA),
    ).toBeNull();
  });

  it('sin bot: si nunca entró, SIN_ENTRADA; si estaba abierta, FUERA', () => {
    expect(
      conciliacion(ejecutando, { estado: null, ciclo: null, motivoSalida: null }, AHORA),
    ).toMatchObject({ state: 'SIN_ENTRADA' });
    expect(
      conciliacion(abierta, { estado: null, ciclo: null, motivoSalida: null }, AHORA),
    ).toMatchObject({ state: 'CERRADA', exit: 'FUERA', realized_pnl: null, r_real: null });
  });

  it('el R: lo realizado sobre el riesgo, y sin riesgo no hay R', () => {
    expect(rReal('10', '4')).toBe('2.5');
    expect(rReal('-3', '3')).toBe('-1');
    expect(rReal('1', '0')).toBeNull();
    expect(rReal('1', null)).toBeNull();
    expect(rReal('1', 'raro')).toBeNull();
  });
});
