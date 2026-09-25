import { D, SalidaOperacionAgente } from '@crypton/shared';
import { INDICE_REDUCCION, makeCoid } from '@crypton/strategy-core';
import { eventoDeSalidaAgente, motivoDeSalidaAgente } from './operacion-avisos';

/**
 * El aviso de salida de la operación de un agente (spec 074): por qué terminó,
 * a partir de la orden que la cerró, y con su R.
 */

const BOT = '5e6f7a8b-0000-4000-8000-000000000000';
const coid = (kind: 'STOP_LOSS' | 'TAKE_PROFIT' | 'BASE', i: number) => makeCoid(BOT, 1, kind, i);
const GANA = D('1');
const PIERDE = D('-1');

describe('motivoDeSalidaAgente', () => {
  const motivo = (
    id: string | null,
    cierre: unknown = null,
    resultado = PIERDE,
    delMotor: 'MANUAL' | 'SEGURIDAD' = 'MANUAL',
    liquidacion = false,
  ) => motivoDeSalidaAgente(id, liquidacion, cierre, resultado, delMotor);

  it('el stop, protegido si la operación no perdió', () => {
    expect(motivo(coid('STOP_LOSS', 0))).toBe(SalidaOperacionAgente.STOP);
    expect(motivo(coid('STOP_LOSS', 0), null, GANA)).toBe(SalidaOperacionAgente.STOP_PROTEGIDO);
    expect(motivo(coid('STOP_LOSS', 0), null, D(0))).toBe(SalidaOperacionAgente.STOP_PROTEGIDO);
  });

  it('un objetivo', () => {
    expect(motivo(coid('TAKE_PROFIT', 0), null, GANA)).toBe(SalidaOperacionAgente.OBJETIVO);
    expect(motivo(coid('TAKE_PROFIT', 1), null, GANA)).toBe(SalidaOperacionAgente.OBJETIVO);
  });

  it('una reducción del seguimiento', () => {
    expect(motivo(coid('TAKE_PROFIT', INDICE_REDUCCION))).toBe(SalidaOperacionAgente.SEGUIMIENTO);
  });

  it('un cierre de la estrategia, con el motivo que dejó', () => {
    const cierre = (m: string) => ({ motivo: m, intentos: 1, ultimoEn: 1 });
    const c = coid('TAKE_PROFIT', 500);
    expect(motivo(c, cierre('TIEMPO'))).toBe(SalidaOperacionAgente.TIEMPO);
    expect(motivo(c, cierre('SEGUIMIENTO'))).toBe(SalidaOperacionAgente.SEGUIMIENTO);
    expect(motivo(c, cierre('STOP'))).toBe(SalidaOperacionAgente.STOP);
    expect(motivo(c, cierre('TRAILING'), GANA)).toBe(SalidaOperacionAgente.STOP_PROTEGIDO);
    for (const m of ['STOP_NO_SALTO', 'LIQUIDACION', 'APALANCAMIENTO', 'OTRO']) {
      expect(motivo(c, cierre(m))).toBe(SalidaOperacionAgente.SEGURIDAD);
    }
    expect(motivo(c, null)).toBe(SalidaOperacionAgente.SEGURIDAD);
  });

  it('un cierre del motor: de su dueño o de una red de seguridad', () => {
    expect(motivo(coid('TAKE_PROFIT', 999), null, PIERDE, 'MANUAL')).toBe(
      SalidaOperacionAgente.MANUAL,
    );
    expect(motivo(coid('TAKE_PROFIT', 512), null, PIERDE, 'SEGURIDAD')).toBe(
      SalidaOperacionAgente.SEGURIDAD,
    );
  });

  it('la liquidación manda sobre todo', () => {
    expect(motivo(coid('STOP_LOSS', 0), null, PIERDE, 'MANUAL', true)).toBe(
      SalidaOperacionAgente.LIQUIDACION,
    );
  });

  it('sin id reconocible, lo atribuye al motor', () => {
    expect(motivo(null, null, PIERDE, 'SEGURIDAD')).toBe(SalidaOperacionAgente.SEGURIDAD);
    expect(motivo('no-es-un-id')).toBe(SalidaOperacionAgente.MANUAL);
  });
});

describe('eventoDeSalidaAgente', () => {
  it('el resultado, su R sobre la pérdida al stop declarada y el motivo', () => {
    const e = eventoDeSalidaAgente(
      { seq: 1, pnl: D('5.84') },
      '2.2',
      SalidaOperacionAgente.OBJETIVO,
      'USDC',
    );
    expect(e).toEqual({
      type: 'AGENT_EXIT',
      severity: 'INFO',
      message: 'Operación cerrada (objetivo): +5.84 USDC (+2.65 R).',
      payload: { realizedPnl: '5.84', seq: 1, r: 2.6545, motivo: 'OBJETIVO' },
    });
  });

  it('una pérdida, en negativo', () => {
    const e = eventoDeSalidaAgente({ seq: 1, pnl: D('-2.2') }, '2.2', 'STOP', 'USDC');
    expect(e.message).toBe('Operación cerrada (stop): -2.20 USDC (-1.00 R).');
    expect(e.payload?.['r']).toBe(-1);
  });

  it('sin riesgo declarado no hay R, y una liquidación avisa en WARN', () => {
    const e = eventoDeSalidaAgente({ seq: 1, pnl: D('-20') }, null, 'LIQUIDACION', 'USDC');
    expect(e.message).toBe('Operación cerrada (liquidación): -20.00 USDC.');
    expect(e.severity).toBe('WARN');
    expect(e.payload?.['r']).toBeNull();
    expect(
      eventoDeSalidaAgente({ seq: 1, pnl: D('1') }, 'x', 'STOP', 'USDC').payload?.['r'],
    ).toBeNull();
  });
});
