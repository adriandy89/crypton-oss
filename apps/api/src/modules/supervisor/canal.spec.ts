import { MENSAJE_SIN_CANAL, motivoSinCanal } from './canal';

/**
 * La regla del canal de las sugerencias (spec 055, 053/H-03). Es la del
 * notificador del worker: si se separan, el supervisor gasta en sugerencias que
 * no llegan o se calla con un canal que funciona.
 */
describe('canal de las sugerencias', () => {
  const vinculado = { chat_id: '111', verified_at: new Date(), prefs: {} };

  it('con un chat verificado y las preferencias de fabrica, hay canal', () => {
    expect(motivoSinCanal(vinculado)).toBeNull();
    expect(motivoSinCanal({ ...vinculado, prefs: null })).toBeNull();
    expect(motivoSinCanal({ ...vinculado, prefs: { ai: true, fills: false } })).toBeNull();
  });

  it('sin vinculo, sin verificar o sin chat, no hay canal', () => {
    expect(motivoSinCanal(null)).toBe('SIN_TELEGRAM');
    expect(motivoSinCanal(undefined)).toBe('SIN_TELEGRAM');
    // Pedir un codigo nuevo borra la verificacion y el chat.
    expect(motivoSinCanal({ ...vinculado, verified_at: null })).toBe('SIN_TELEGRAM');
    expect(motivoSinCanal({ ...vinculado, chat_id: null })).toBe('SIN_TELEGRAM');
  });

  it('con los avisos de IA apagados, no hay canal', () => {
    expect(motivoSinCanal({ ...vinculado, prefs: { ai: false } })).toBe('AVISOS_IA_APAGADOS');
    // Cualquier valor falso apaga, como en el notificador, que hace
    // `{ ...DEFAULT_PREFS, ...prefs }[clave]`.
    expect(motivoSinCanal({ ...vinculado, prefs: { ai: null } })).toBe('AVISOS_IA_APAGADOS');
  });

  it('sin vinculo manda la falta de vinculo, aunque tambien esten apagados', () => {
    expect(motivoSinCanal({ chat_id: null, verified_at: null, prefs: { ai: false } })).toBe(
      'SIN_TELEGRAM',
    );
  });

  it('cada motivo dice que falta y donde se arregla', () => {
    expect(MENSAJE_SIN_CANAL.SIN_TELEGRAM).toContain('ningún chat vinculado');
    expect(MENSAJE_SIN_CANAL.AVISOS_IA_APAGADOS).toContain('apagados los avisos del Modo IA');
    for (const mensaje of Object.values(MENSAJE_SIN_CANAL)) {
      expect(mensaje).toContain('Cuenta → Telegram');
    }
  });
});
