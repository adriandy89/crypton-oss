/**
 * Por donde le llegan a su dueño las sugerencias del Modo IA (spec 055, 053/H-03).
 *
 * «Propone y espera» manda cada sugerencia a Telegram con dos botones, y es la
 * UNICA forma de aprobarla: la app no tiene cola de decisiones. Sin ese canal
 * el supervisor seguia revisando el bot, pagando cada llamada y escribiendo
 * propuestas que caducaban sin que nadie las viera. El servidor solo lo exigia
 * al encender el modo, y el canal se pierde despues de tres maneras: al
 * desvincular Telegram, al pedir un codigo nuevo —que borra la verificacion— y
 * al apagar los avisos de IA en las preferencias.
 *
 * La regla es la MISMA que aplica el notificador del worker antes de mandar un
 * `AI_SUGGESTION` (`NotifierService.linkOf` y `EVENT_PREF`): un chat verificado,
 * y la preferencia `ai` sin apagar sobre las de fabrica. Si las dos se separan,
 * o el supervisor gasta en sugerencias que no llegan, o se calla con un canal
 * que funciona.
 */

/** Por que no le llegaria una sugerencia a su dueño. */
export type SinCanal = 'SIN_TELEGRAM' | 'AVISOS_IA_APAGADOS';

/** Lo que hay que leer de `telegram_links` para decidirlo. */
export const SELECT_VINCULO = { chat_id: true, verified_at: true, prefs: true } as const;

export interface VinculoTelegram {
  chat_id: string | null;
  verified_at: Date | null;
  prefs: unknown;
}

/** El motivo por el que no hay canal, o `null` si lo hay. */
export function motivoSinCanal(vinculo: VinculoTelegram | null | undefined): SinCanal | null {
  if (!vinculo?.chat_id || !vinculo.verified_at) return 'SIN_TELEGRAM';
  // Las guardadas se funden SOBRE las de fabrica, donde `ai` vale `true`: solo
  // una clave presente y falsa la apaga, igual que en el notificador.
  const prefs = vinculo.prefs;
  if (prefs !== null && typeof prefs === 'object' && 'ai' in prefs) {
    if (!(prefs as { ai?: unknown }).ai) return 'AVISOS_IA_APAGADOS';
  }
  return null;
}

/** Lo que se le dice a quien intenta encender «propone y espera» sin canal. */
export const MENSAJE_SIN_CANAL: Readonly<Record<SinCanal, string>> = {
  SIN_TELEGRAM:
    'El modo «propone y espera» manda las sugerencias por Telegram, y no tienes ningún chat ' +
    'vinculado: no te llegaría ninguna. Vincúlalo en Cuenta → Telegram y vuelve a intentarlo.',
  AVISOS_IA_APAGADOS:
    'El modo «propone y espera» manda las sugerencias por Telegram, y tienes apagados los ' +
    'avisos del Modo IA: no te llegaría ninguna. Enciéndelos en Cuenta → Telegram y vuelve a ' +
    'intentarlo.',
};
