/**
 * El motivo que piden las acciones de administración.
 *
 * Una sola definicion para la consola y para el Modo IA: el servidor exige lo
 * mismo en las dos (entre 3 y 200 caracteres), y dos copias del campo acabarian
 * pidiendo cosas distintas.
 */

export const MOTIVO_MINIMO = 3;
export const MOTIVO_MAXIMO = 200;

/** El campo de texto del diálogo. */
export const CAMPO_MOTIVO = {
  name: 'reason',
  type: 'text' as const,
  placeholder: 'Motivo (queda en la bitácora)',
  attributes: { maxlength: MOTIVO_MAXIMO },
};

export const AVISO_SIN_MOTIVO = 'Escribe el motivo: queda en la bitácora.';

/** El motivo limpio, o `null` si no llega al minimo. */
export function motivoValido(texto: string | null | undefined): string | null {
  const limpio = (texto ?? '').trim();
  return limpio.length >= MOTIVO_MINIMO && limpio.length <= MOTIVO_MAXIMO ? limpio : null;
}
