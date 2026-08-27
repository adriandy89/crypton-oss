import { randomBytes } from 'node:crypto';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DbService } from 'src/libs';
import { DEFAULT_TELEGRAM_PREFS, UpdateTelegramPrefsDto, type TelegramPrefs } from './dtos';

/**
 * Alfabeto Crockford base32: sin I, L, O ni U. Se eligen 32 símbolos exactos
 * para poder tomarlos de bytes aleatorios sin sesgo (256 = 8 × 32).
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 10;

/**
 * Diez minutos: de sobra para abrir Telegram y pegar el código, y lo bastante
 * corto como para que la ventana de adivinanza sea irrelevante.
 */
const CODE_TTL_MS = 10 * 60 * 1000;

/**
 * Vinculación de la cuenta con Telegram.
 *
 * El emparejamiento va del usuario hacia el bot y no al revés: la API genera un
 * código de un solo uso y el usuario lo envía al bot con `/start <codigo>`. Es
 * lo que demuestra que quien reclama ese chat controla la cuenta — pedir un
 * identificador de chat sin más permitiría dirigir las alertas de cualquiera a
 * un chat ajeno con solo adivinar un número.
 *
 * Esta clase no habla con Telegram: solo toca la base de datos. El envío y la
 * recepción viven en el worker, que es donde nacen los eventos.
 */
@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);

  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Código aleatorio sobre el alfabeto, sin sesgo.
   *
   * Como el alfabeto tiene exactamente 32 símbolos y 256 es múltiplo de 32,
   * `byte % 32` reparte uniforme: no hace falta descartar nada. Si algún día se
   * cambia el alfabeto a un tamaño que no divida a 256, hay que volver aquí —
   * de ahí la comprobación.
   */
  private randomCode(length: number): string {
    if (256 % ALPHABET.length !== 0) {
      throw new Error('El alfabeto debe dividir a 256 para no sesgar el código.');
    }
    const bytes = randomBytes(length);
    let out = '';
    for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
    return out;
  }

  async status(userId: string) {
    const link = await this.db.telegramLink.findUnique({
      where: { user_id: userId },
    });
    const botUsername = this.config.get<string>('TELEGRAM_BOT_USERNAME', '');

    if (!link) {
      return {
        linked: false,
        botUsername,
        prefs: DEFAULT_TELEGRAM_PREFS,
        deepLink: null,
      };
    }

    return {
      linked: link.verified_at !== null,
      botUsername,
      prefs: {
        ...DEFAULT_TELEGRAM_PREFS,
        ...((link.prefs as object) ?? {}),
      },
      // El enlace profundo solo tiene sentido mientras el código siga sin usar.
      deepLink:
        link.verified_at === null && link.link_code && botUsername
          ? `https://t.me/${botUsername}?start=${link.link_code}`
          : null,
      verifiedAt: link.verified_at,
    };
  }

  /**
   * Genera (o regenera) el código de vinculación.
   *
   * Regenerar invalida el anterior: si el usuario compartió el código por error
   * o simplemente lo perdió, pedir uno nuevo debe cerrar la puerta al viejo.
   */
  async createLinkCode(userId: string) {
    // Alfabeto Crockford base32: 32 símbolos sin las letras que se confunden al
    // leer en voz alta (I, L, O, U). 10 caracteres = 50 bits reales.
    //
    // La versión anterior partía de base64url y luego hacía `toUpperCase()` y
    // mapeaba oOiIlL01 sobre la letra 'x'. Eso no era «legible»: colapsaba ocho
    // símbolos distintos en uno solo y plegaba mayúsculas con minúsculas, así
    // que de los 64 bits de origen quedaban bastantes menos de los 40 que
    // afirmaba el comentario, y con la distribución sesgada. Aquí cada carácter
    // se toma del alfabeto con rechazo de sesgo.
    const code = this.randomCode(CODE_LENGTH);

    await this.db.telegramLink.upsert({
      where: { user_id: userId },
      create: {
        user_id: userId,
        link_code: code,
        link_code_expires_at: new Date(Date.now() + CODE_TTL_MS),
        prefs: DEFAULT_TELEGRAM_PREFS as never,
      },
      update: {
        link_code: code,
        link_code_expires_at: new Date(Date.now() + CODE_TTL_MS),
        chat_id: null,
        verified_at: null,
      },
    });

    const botUsername = this.config.get<string>('TELEGRAM_BOT_USERNAME', '');
    return {
      code,
      botUsername,
      deepLink: botUsername ? `https://t.me/${botUsername}?start=${code}` : null,
      // El código se envía al bot, no se teclea en la app: se muestra por si el
      // enlace profundo no abre Telegram (navegador de escritorio, por ejemplo).
      instructions: `Abre el chat con @${botUsername || 'el bot'} y envía: /start ${code}`,
    };
  }

  async updatePrefs(userId: string, dto: UpdateTelegramPrefsDto): Promise<TelegramPrefs> {
    const link = await this.db.telegramLink.findUnique({
      where: { user_id: userId },
    });
    if (!link) throw new NotFoundException('Todavía no has vinculado Telegram.');

    const prefs: TelegramPrefs = {
      ...DEFAULT_TELEGRAM_PREFS,
      ...((link.prefs as object) ?? {}),
      ...dto,
    };
    await this.db.telegramLink.update({
      where: { user_id: userId },
      data: { prefs: prefs as never },
    });
    return prefs;
  }

  async unlink(userId: string): Promise<void> {
    await this.db.telegramLink.deleteMany({ where: { user_id: userId } });
    this.logger.log(`Telegram desvinculado del usuario ${userId}`);
  }
}
