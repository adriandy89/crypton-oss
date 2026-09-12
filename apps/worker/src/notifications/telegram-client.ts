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
