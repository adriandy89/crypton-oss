import {
  AI_TRIGGERS,
  ETIQUETA_CORTA_MODO_IA,
  type AiMode,
  type AiSetting,
  type AiSwitches,
  type AiTrigger,
  type SetAiMode,
  type SinCanalIa,
} from '../services/admin-bots.service';
import type { TelegramStatus } from '../services/telegram.service';
import { shortDate } from './format';

/**
 * El Modo IA, en piezas puras (spec 053).
 *
 * Todo lo que decide QUE se pinta —la pastilla, la frase de cuándo revisa, el
 * borrador y lo que se manda— vive aqui y no en las pantallas: lo usan la lista
 * de bots, el detalle, la consola y el asistente de creación, y cuatro copias de
 * la misma regla son cuatro sitios donde se desalinea.
 */

/**
 * Minutos entre revisiones de un bot que no fija los suyos.
 *
 * Es `INTERVALO_POR_ESTRATEGIA` de `supervisor.service.ts`, que hoy vale 30 en
 * las cuatro estrategias. Solo sirve para ESCRIBIRLO: el que cuenta es el del
 * servidor.
 */
export const INTERVALO_IA_POR_DEFECTO = 30;

/** Los limites del intervalo, los mismos que el DTO del servidor. */
export const INTERVALO_IA_MIN = 10;
export const INTERVALO_IA_MAX = 1440;

/** Lo que se edita del Modo IA de un bot. El motivo va aparte. */
export interface BorradorIa {
  mode: AiMode;
  trigger: AiTrigger;
  /** `null` = el de la estrategia. */
  reviewEveryMinutes: number | null;
  allowWarm: boolean;
}

/** Lo que se manda al guardar, sin el motivo, que se pide al confirmar. */
export type CambioIa = Omit<SetAiMode, 'reason'>;

/** Un bot sin fila de Modo IA: los valores de fabrica del servidor. */
export const BORRADOR_APAGADO: Readonly<BorradorIa> = {
  mode: 'OFF',
  trigger: 'AMBOS',
  reviewEveryMinutes: null,
  allowWarm: true,
};

/**
 * El disparador como vocabulario conocido.
 *
 * La columna es texto y puede traer uno que esta app aun no conoce; se lee como
 * el de fabrica para pintar, pero no se manda nunca de vuelta si no se tocó.
 */
export function aDisparo(trigger: string | undefined | null): AiTrigger {
  return (AI_TRIGGERS as readonly string[]).includes(trigger ?? '')
    ? (trigger as AiTrigger)
    : 'AMBOS';
}

export function borradorDe(ajuste: AiSetting | null | undefined): BorradorIa {
  if (!ajuste) return { ...BORRADOR_APAGADO };
  return {
    mode: ajuste.mode,
    trigger: aDisparo(ajuste.trigger),
    reviewEveryMinutes: ajuste.review_every_minutes ?? null,
    allowWarm: ajuste.allow_warm ?? true,
  };
}

export function minutosValidos(minutos: number | null): boolean {
  return (
    minutos === null ||
    (Number.isInteger(minutos) && minutos >= INTERVALO_IA_MIN && minutos <= INTERVALO_IA_MAX)
  );
}

/**
 * Lo que cambió entre lo guardado y el borrador.
 *
 * El modo va SIEMPRE —el servidor lo exige en cada llamada—; el resto, solo si
 * cambió. Mandar lo que no cambió pisaria en silencio un valor que el servidor
 * tiene y esta pantalla no conoce (un disparador nuevo, por ejemplo).
 */
export function cambiosDe(guardado: BorradorIa, borrador: BorradorIa): CambioIa {
  return {
    mode: borrador.mode,
    ...(borrador.trigger === guardado.trigger ? {} : { trigger: borrador.trigger }),
    ...(borrador.reviewEveryMinutes === guardado.reviewEveryMinutes
      ? {}
      : { reviewEveryMinutes: borrador.reviewEveryMinutes }),
    ...(borrador.allowWarm === guardado.allowWarm ? {} : { allowWarm: borrador.allowWarm }),
  };
}

export function mismoBorrador(a: BorradorIa, b: BorradorIa): boolean {
  return (
    a.mode === b.mode &&
    a.trigger === b.trigger &&
    a.reviewEveryMinutes === b.reviewEveryMinutes &&
    a.allowWarm === b.allowWarm
  );
}

/**
 * El borrador del Modo IA sobre lo guardado NUEVO (spec 056, A-5).
 *
 * Lo que el administrador tocó conserva su valor; lo demás toma el de la
 * lectura nueva. Antes se conservaba el borrador ENTERO en cuanto había una
 * edición, y guardar mandaba también lo no tocado: si otro dispositivo había
 * apagado el modo, cambiar aquí «recolocar» lo volvía a encender. Es la regla
 * de `recolocarBorrador` en `shared`, campo a campo.
 */
export function rebasarBorradorIa(
  base: BorradorIa,
  borrador: BorradorIa,
  nuevo: BorradorIa,
): BorradorIa {
  return {
    mode: borrador.mode === base.mode ? nuevo.mode : borrador.mode,
    trigger: borrador.trigger === base.trigger ? nuevo.trigger : borrador.trigger,
    reviewEveryMinutes:
      borrador.reviewEveryMinutes === base.reviewEveryMinutes
        ? nuevo.reviewEveryMinutes
        : borrador.reviewEveryMinutes,
    allowWarm: borrador.allowWarm === base.allowWarm ? nuevo.allowWarm : borrador.allowWarm,
  };
}

/**
 * Hasta cuándo esta dormido por fallos, o `null` si no lo esta.
 *
 * `paused_until` NO se limpia cuando el supervisor se recupera —solo al apagar
 * el modo—, así que una fecha pasada es lo normal y no significa nada. Antes la
 * consola anunciaba «se reactiva el …» con fechas de hace días.
 */
export function dormidaHasta(
  ajuste: Pick<AiSetting, 'paused_until'> | null | undefined,
  ahora = Date.now(),
): Date | null {
  if (!ajuste?.paused_until) return null;
  const fecha = new Date(ajuste.paused_until);
  return Number.isFinite(fecha.getTime()) && fecha.getTime() > ahora ? fecha : null;
}

/**
 * Si el modo, tal como lo va a ejercer el servidor, propone y espera: el manual,
 * o el automático cuando el servidor lo degrada.
 */
export function propone(
  mode: AiMode,
  interruptores: Pick<AiSwitches, 'forzarManual'> | null | undefined,
): boolean {
  return mode === 'MANUAL' || (mode === 'AUTO' && !!interruptores?.forzarManual);
}

/**
 * Por qué no le llegarían las sugerencias a quien mira, según su Telegram, o
 * `null` si le llegan (spec 055, 053/H-03). `undefined` mientras no se sabe: sin
 * dato no se bloquea nada, y decide el servidor.
 *
 * Es la regla del servidor (`supervisor/canal.ts`): un chat verificado y los
 * avisos del Modo IA sin apagar. Las preferencias llegan ya fundidas con las de
 * fábrica, donde `ai` vale `true`.
 */
export function sinCanalDe(
  status: Pick<TelegramStatus, 'linked' | 'prefs'> | null | undefined,
): SinCanalIa | null | undefined {
  if (!status) return undefined;
  if (!status.linked) return 'SIN_TELEGRAM';
  if (status.prefs && 'ai' in status.prefs && !status.prefs.ai) return 'AVISOS_IA_APAGADOS';
  return null;
}

/**
 * El canal que cuenta: lo que esta app sabe del Telegram de quien mira, y si aún
 * no lo sabe, lo que dijo el servidor (spec 056, A-4).
 *
 * Primero el del cliente porque cambia en el acto al vincular o al apagar los
 * avisos, y el del servidor solo con la siguiente lectura del Modo IA. Con `??`
 * un `null` del cliente —«sí hay canal»— caía al del servidor, y tras vincular
 * seguía el aviso rojo.
 */
export function canalEfectivo(
  status: Pick<TelegramStatus, 'linked' | 'prefs'> | null | undefined,
  interruptores: Pick<AiSwitches, 'sinCanal'> | null | undefined,
): SinCanalIa | null {
  const cliente = sinCanalDe(status);
  return cliente !== undefined ? cliente : (interruptores?.sinCanal ?? null);
}

/** Los interruptores con el canal ya resuelto por `canalEfectivo`. */
export function conCanalEfectivo(
  interruptores: AiSwitches | null | undefined,
  status: Pick<TelegramStatus, 'linked' | 'prefs'> | null | undefined,
): AiSwitches | null {
  if (!interruptores) return null;
  return { ...interruptores, sinCanal: canalEfectivo(status, interruptores) };
}

/** El motivo, para completar una frase: «… y {motivo}». */
export const TEXTO_SIN_CANAL: Readonly<Record<SinCanalIa, string>> = {
  SIN_TELEGRAM: 'no tienes Telegram vinculado',
  AVISOS_IA_APAGADOS: 'tienes apagados los avisos del Modo IA en Telegram',
};

/** Lo que falta, para completar «necesita …». */
export const FALTA_PARA_PROPONER: Readonly<Record<SinCanalIa, string>> = {
  SIN_TELEGRAM: 'un chat de Telegram vinculado',
  AVISOS_IA_APAGADOS: 'los avisos del Modo IA encendidos en Telegram',
};

/** El bot, en lo que a la pastilla le importa. */
export interface BotParaIa {
  dryRun: boolean;
  status: string;
}

/**
 * Por qué el Modo IA de este bot no esta actuando ahora, o `null` si actua.
 *
 * El orden es el de las barreras de `revisarBot`: primero lo que apaga la
 * función para todos, despues lo de este bot. Con los interruptores
 * desconocidos —el resumen no llegó— no se afirma nada sobre ellos.
 */
export function porQueNoActua(
  ajuste: AiSetting | null | undefined,
  interruptores: AiSwitches | null | undefined,
  bot: BotParaIa,
  ahora = Date.now(),
): string | null {
  if (!ajuste || ajuste.mode === 'OFF') return null;
  if (interruptores && !interruptores.encendido) {
    return 'El supervisor está apagado en el servidor: no revisa ningún bot.';
  }
  if (interruptores?.soloSimulados && !bot.dryRun) {
    return 'El servidor solo deja actuar a la IA sobre bots simulados, y este opera con dinero real.';
  }
  const dormida = dormidaHasta(ajuste, ahora);
  if (dormida) {
    return `Dormida tras varios fallos seguidos, hasta el ${shortDate(dormida)}.`;
  }
  if (bot.status !== 'RUNNING') return 'La IA solo revisa bots en marcha.';
  if (interruptores?.sinCanal && propone(ajuste.mode, interruptores)) {
    return (
      `Propone por Telegram y ${TEXTO_SIN_CANAL[interruptores.sinCanal]}: no revisa este bot ` +
      'hasta que lo arregles.'
    );
  }
  if (interruptores?.forzarManual && ajuste.mode === 'AUTO') {
    return 'El servidor obliga a proponer y esperar: no aplicará nada sola.';
  }
  return null;
}

export interface InsigniaIa {
  texto: string;
  /** Uniones literales: `strictTemplates` rechaza un `string` en `ui-badge`. */
  tone: 'brand' | 'neutral';
  variant: 'soft' | 'outline';
  activa: boolean;
  /** Por qué no actúa, para el `title`; `null` si actúa. */
  porQue: string | null;
}

/**
 * La pastilla de un bot con el Modo IA encendido, o `null` si no lo tiene.
 *
 * Dice el modo CONFIGURADO. Cuando no esta actuando sale en gris y con
 * contorno: en un movil el `title` no se ve, así que el estado tiene que leerse
 * en la propia pastilla.
 */
export function insigniaIa(
  ajuste: AiSetting | null | undefined,
  interruptores: AiSwitches | null | undefined,
  bot: BotParaIa,
  ahora = Date.now(),
): InsigniaIa | null {
  if (!ajuste || ajuste.mode === 'OFF') return null;
  const porQue = porQueNoActua(ajuste, interruptores, bot, ahora);
  const activa = porQue === null;
  return {
    texto: ETIQUETA_CORTA_MODO_IA[ajuste.mode],
    tone: activa ? 'brand' : 'neutral',
    variant: activa ? 'soft' : 'outline',
    activa,
    porQue,
  };
}

/**
 * La frase de lo que hace el supervisor con ESTE bot, con sus datos reales.
 *
 * La consola decía siempre «cada media hora y cuando cierra un ciclo», también
 * con el disparador en «solo reloj» o con otro intervalo. Con el modo apagado
 * habla en condicional: decir «revisa» de un bot que nadie revisa es mentir.
 */
export function textoDeRevision(
  guardado: Pick<BorradorIa, 'mode' | 'trigger' | 'reviewEveryMinutes'>,
): string {
  const minutos = guardado.reviewEveryMinutes ?? INTERVALO_IA_POR_DEFECTO;
  const eventos = 'al cerrar un ciclo o ante un aviso de riesgo';
  const cuando =
    guardado.trigger === 'PERIODICO'
      ? `cada ${minutos} min`
      : guardado.trigger === 'OPERACION'
        ? `solo ${eventos}, y como mucho una vez cada ${minutos} min`
        : `cada ${minutos} min, y además ${eventos}`;
  const encendido = guardado.mode !== 'OFF';
  return (
    `${encendido ? 'Un supervisor revisa' : 'Con el Modo IA encendido, un supervisor revisaría'} ` +
    `este bot ${cuando}. ${encendido ? 'Puede' : 'Podría'} mover cinco ajustes —apalancamiento, ` +
    'cobertura, diferencial, crecimiento del tamaño y cadencia—, como mucho dos a la vez y dos ' +
    'pasos cada uno.'
  );
}

/**
 * Lo que el supervisor NO puede hacer. Es lo que alguien con prisa supone al revés.
 *
 * Las órdenes sí puede moverlas, si se le deja: un cambio que recoloca cancela
 * y vuelve a tender la escalera. Decir que no las cancela nunca contradecía el
 * interruptor de las opciones avanzadas (spec 056, A-12).
 */
export const LIMITES_IA =
  'Nunca toca el capital, el par, la cuenta ni la dirección, y no puede parar el bot ni cerrar ' +
  'su posición. Solo recoloca las órdenes si se lo permites en las opciones avanzadas.';
