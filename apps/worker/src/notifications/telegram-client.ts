import { Logger } from '@nestjs/common';

/**
 * Cliente mínimo de la API de bots de Telegram.
 *
 * Se escribe a mano en lugar de traer una librería: solo hacen falta tres
 * métodos, y una dependencia más en el proceso que descifra claves de firma
 * tiene un coste que no compensa por ahorrar cuarenta líneas.
 */

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; username?: string };
    text?: string;
  };
  /**
   * La pulsacion de un boton (spec 046).
   *
   * `data` es lo que se puso en el teclado al enviar el mensaje, y Telegram lo
   * limita a 64 BYTES: por eso ahi solo viaja un identificador opaco y el verbo,
   * nunca el id del bot ni nada que describa el cambio.
   */
  callback_query?: {
    id: string;
    from: { id: number; username?: string };
    message?: { message_id: number; chat: { id: number } };
    data?: string;
  };
}

/** Un teclado en linea: filas de botones, cada uno con su `callback_data`. */
export interface InlineKeyboard {
  inline_keyboard: { text: string; callback_data: string }[][];
}

export class TelegramClient {
  private readonly logger = new Logger(TelegramClient.name);
  private readonly base: string;

  constructor(private readonly token: string) {
    this.base = `https://api.telegram.org/bot${token}`;
  }

  get enabled(): boolean {
    return this.token.length > 0;
  }

  /**
   * Envía un mensaje. Devuelve false en vez de lanzar: una alerta que no llega
   * no debe tumbar el tick de un bot que sí está operando bien.
   */
  async sendMessage(chatId: string, text: string, teclado?: InlineKeyboard): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const res = await this.call('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        ...(teclado ? { reply_markup: teclado } : {}),
        // Los mensajes son cortos y autocontenidos; la vista previa de enlaces
        // solo añadiría ruido en un canal que se lee de un vistazo.
        disable_web_page_preview: true,
      });
      return res.ok === true;
    } catch (e) {
      this.logger.warn(`No se pudo enviar a Telegram: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * Long polling. `timeout` alto a propósito: mantiene la conexión abierta
   * esperando, en lugar de machacar la API cada segundo para no encontrar nada.
   */
  async getUpdates(offset: number, timeoutSeconds = 30): Promise<TelegramUpdate[]> {
    if (!this.enabled) return [];
    const res = await this.call(
      'getUpdates',
      // `callback_query` desde el spec 046. Ampliar esto cambia lo que devuelve
      // `getUpdates` para TODO el mundo, asi que el manejador ignora en silencio
      // cualquier pulsacion que no reconozca.
      { offset, timeout: timeoutSeconds, allowed_updates: ['message', 'callback_query'] },
      // El fetch debe aguantar más que el propio long poll, o lo cortaría él.
      (timeoutSeconds + 10) * 1000,
    );
    return (res.result as TelegramUpdate[]) ?? [];
  }

  /**
   * Contesta a la pulsacion de un boton.
   *
   * No es opcional aunque no se quiera decir nada: hasta que Telegram recibe
   * esto, el boton se queda con el reloj girando en el movil de quien lo pulso.
   * Se traga los fallos como `sendMessage`, por lo mismo: que no se pueda
   * confirmar una pulsacion no puede tumbar el sondeo.
   */
  async answerCallbackQuery(id: string, texto?: string): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const res = await this.call('answerCallbackQuery', {
        callback_query_id: id,
        ...(texto ? { text: texto, show_alert: false } : {}),
      });
      return res.ok === true;
    } catch (e) {
      this.logger.warn(`No se pudo contestar a un botón: ${(e as Error).message}`);
      return false;
    }
  }

  async getMe(): Promise<{ username?: string } | null> {
    if (!this.enabled) return null;
    try {
      const res = await this.call('getMe', {});
      return (res.result as { username?: string }) ?? null;
    } catch {
      return null;
    }
  }

  private async call(
    method: string,
    body: Record<string, unknown>,
    timeoutMs = 15_000,
  ): Promise<{ ok?: boolean; result?: unknown; description?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.base}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const json = (await response.json()) as { ok?: boolean; description?: string };
      if (!json.ok) throw new Error(json.description ?? `Telegram ${method} fallo`);
      return json;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Escapa lo que Telegram interpretaría como marcado HTML. */
export const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * El texto con cada sustituto suelto cambiado por «�».
 *
 * Un sustituto suelto —medio emoji, de un texto recortado por unidades UTF-16—
 * no es UTF-8 válido, y Telegram rechaza el mensaje ENTERO, con las demás líneas
 * del lote dentro. Los textos de los avisos vienen de muchos sitios (el motivo
 * del modelo, un error del venue), así que se sanea aquí, al final
 * (spec 056, R-7).
 */
export const bienFormado = (texto: string): string =>
  texto.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');

/**
 * Lo más largo que se manda en un mensaje.
 *
 * Telegram rechaza entero, con un 400, un texto de más de 4096 caracteres
 * (contados tras interpretar las entidades), y `sendMessage` solo deja un aviso
 * en el log: un lote demasiado largo se perdía completo sin que el usuario lo
 * supiera (spec 054). Aquí se mide el texto con las entidades SIN interpretar,
 * que nunca es más corto, y con margen.
 */
export const MAX_TEXTO = 4000;

/** Lo que `recortar` puede añadir detrás del corte: los cierres y los puntos. */
const HOLGURA_DEL_CORTE = 16;

/**
 * Recorta una línea que no cabe en un mensaje sin romper su HTML.
 *
 * Las líneas del notificador llevan el nombre del bot entre `<b>` y el resto
 * pasado por `escapeHtml`. Un corte a ciegas puede dejar una entidad a medias
 * (`&am`), una etiqueta sin cerrar o medio emoji, y Telegram rechaza el mensaje
 * ENTERO por no poder interpretarlo: el recorte convertiría un aviso largo en
 * ningún aviso.
 */
export function recortar(linea: string, max = MAX_TEXTO): string {
  if (linea.length <= max) return linea;
  let corte = linea.slice(0, max - HOLGURA_DEL_CORTE);

  // Medio par sustituto: el emoji se quita entero.
  const ultimo = corte.charCodeAt(corte.length - 1);
  if (ultimo >= 0xd800 && ultimo <= 0xdbff) corte = corte.slice(0, -1);

  // Una entidad sin cerrar. Tras `escapeHtml` todo `&` abre una, así que basta
  // con mirar si el último `&` va detrás del último `;`.
  const amp = corte.lastIndexOf('&');
  if (amp > corte.lastIndexOf(';')) corte = corte.slice(0, amp);

  // Una etiqueta a medio escribir, y luego las que quedaron abiertas.
  const abre = corte.lastIndexOf('<');
  if (abre > corte.lastIndexOf('>')) corte = corte.slice(0, abre);
  let cierres = '';
  for (const etiqueta of ['i', 'b']) {
    const abiertas = corte.split(`<${etiqueta}>`).length - 1;
    const cerradas = corte.split(`</${etiqueta}>`).length - 1;
    if (abiertas > cerradas) cierres += `</${etiqueta}>`;
  }
  return `${corte}…${cierres}`;
}

/**
 * Reparte las líneas de un lote en mensajes que Telegram acepta: en orden, sin
 * perder ninguna y sin partir una línea entre dos mensajes.
 */
export function trocear(lineas: readonly string[], max = MAX_TEXTO): string[] {
  const out: string[] = [];
  let actual = '';
  for (const bruta of lineas) {
    const linea = recortar(bruta, max);
    if (actual && actual.length + 1 + linea.length > max) {
      out.push(actual);
      actual = linea;
    } else {
      actual = actual ? `${actual}\n${linea}` : linea;
    }
  }
  if (actual) out.push(actual);
  return out;
}
