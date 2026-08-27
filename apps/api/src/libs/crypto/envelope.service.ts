import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Cifrado de sobre (envelope encryption) para las credenciales de firma.
 *
 * El esquema tiene dos niveles a propósito:
 *
 *   1. Cada credencial se cifra con una DEK (clave de datos) ALEATORIA y única.
 *   2. Esa DEK se cifra con la clave maestra del servidor.
 *
 * Lo que compra el segundo nivel: rotar la maestra solo obliga a recifrar las
 * DEK (32 bytes por fila), no las credenciales enteras; y un volcado de la
 * tabla `exchange_accounts` sin la maestra no permite firmar ni una orden.
 *
 * Se usa AES-256-GCM y no CBC porque GCM AUTENTICA: si alguien manipula el
 * texto cifrado en la base de datos, el descifrado falla en vez de devolver
 * basura que acabaría interpretándose como una clave privada.
 */

export interface SealedPayload {
  encPayload: string;
  encDek: string;
  encIv: string;
  encTag: string;
  encKeyId: string;
}

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits: el tamaño recomendado para GCM
const DEK_BYTES = 32;

@Injectable()
export class EnvelopeService {
  private readonly logger = new Logger(EnvelopeService.name);
  private readonly masterKeys = new Map<string, Buffer>();
  private readonly activeKeyId: string;

  constructor(config: ConfigService) {
    // Formato admitido: "clave" (una sola, id 'v1') o "id1:clave1,id2:clave2"
    // para poder rotar sin downtime — las credenciales antiguas siguen
    // descifrándose con su clave mientras las nuevas ya usan la actual.
    const raw = config.get<string>('CREDENTIALS_MASTER_KEY', '');
    if (!raw) {
      throw new Error(
        'Falta CREDENTIALS_MASTER_KEY. Sin ella no se pueden guardar credenciales de exchange.',
      );
    }

    const entries = raw.includes(':') ? raw.split(',') : ['v1:' + raw];
    for (const entry of entries) {
      const [id, value] = entry.split(':');
      if (!id || !value) continue;
      this.masterKeys.set(id.trim(), this.deriveKey(value.trim()));
    }
    if (this.masterKeys.size === 0) {
      throw new Error(
        'CREDENTIALS_MASTER_KEY no contiene ninguna clave válida.',
      );
    }

    const active = config.get<string>('CREDENTIALS_ACTIVE_KEY_ID', '');
    this.activeKeyId = active || [...this.masterKeys.keys()][0];
    if (!this.masterKeys.has(this.activeKeyId)) {
      throw new Error(
        'CREDENTIALS_ACTIVE_KEY_ID no coincide con ninguna clave configurada.',
      );
    }
    this.logger.log(
      `Cifrado de credenciales listo (${this.masterKeys.size} clave/s, activa: ${this.activeKeyId})`,
    );
  }

  /**
   * Admite la maestra en hex de 64 caracteres (32 bytes exactos) o cualquier
   * cadena, que se pasa por SHA-256 para obtener los 32 bytes. Lo segundo es
   * una comodidad de desarrollo: en producción debe ser hex aleatorio.
   */
  private deriveKey(value: string): Buffer {
    if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, 'hex');
    return createHash('sha256').update(value, 'utf8').digest();
  }

  /** Cifra un objeto y devuelve el sobre listo para persistir. */
  seal(plaintext: unknown): SealedPayload {
    const master = this.masterKeys.get(this.activeKeyId)!;
    const dek = randomBytes(DEK_BYTES);
    const iv = randomBytes(IV_BYTES);

    const cipher = createCipheriv(ALGORITHM, dek, iv);
    const payload = Buffer.concat([
      cipher.update(JSON.stringify(plaintext), 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    // La DEK se cifra con su propio IV, que se antepone al resultado: reutilizar
    // un IV en GCM rompe la confidencialidad, así que nunca se comparte.
    const dekIv = randomBytes(IV_BYTES);
    const dekCipher = createCipheriv(ALGORITHM, master, dekIv);
    const encDek = Buffer.concat([dekCipher.update(dek), dekCipher.final()]);
    const dekTag = dekCipher.getAuthTag();

    return {
      encPayload: payload.toString('base64'),
      encDek: Buffer.concat([dekIv, dekTag, encDek]).toString('base64'),
      encIv: iv.toString('base64'),
      encTag: tag.toString('base64'),
      encKeyId: this.activeKeyId,
    };
  }

  /** Descifra un sobre. Lanza si el contenido ha sido manipulado. */
  open<T>(sealed: SealedPayload): T {
    const master = this.masterKeys.get(sealed.encKeyId);
    if (!master) {
      throw new InternalServerErrorException(
        `La credencial se cifró con la clave "${sealed.encKeyId}", que ya no está configurada.`,
      );
    }

    try {
      const dekBlob = Buffer.from(sealed.encDek, 'base64');
      const dekIv = dekBlob.subarray(0, IV_BYTES);
      const dekTag = dekBlob.subarray(IV_BYTES, IV_BYTES + 16);
      const dekCipher = dekBlob.subarray(IV_BYTES + 16);

      const dekDecipher = createDecipheriv(ALGORITHM, master, dekIv);
      dekDecipher.setAuthTag(dekTag);
      const dek = Buffer.concat([
        dekDecipher.update(dekCipher),
        dekDecipher.final(),
      ]);

      const decipher = createDecipheriv(
        ALGORITHM,
        dek,
        Buffer.from(sealed.encIv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(sealed.encTag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(sealed.encPayload, 'base64')),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString('utf8')) as T;
    } catch (e) {
      // El mensaje se queda deliberadamente vago: distinguir "clave incorrecta"
      // de "datos manipulados" da información a quien esté probando.
      this.logger.error(
        'Fallo al descifrar una credencial',
        (e as Error).message,
      );
      throw new InternalServerErrorException(
        'No se pudo descifrar la credencial.',
      );
    }
  }

  /** true si el sobre está cifrado con una clave distinta de la activa. */
  needsRotation(sealed: Pick<SealedPayload, 'encKeyId'>): boolean {
    return sealed.encKeyId !== this.activeKeyId;
  }

  /** Recifra con la clave activa. Usado por el job de rotación. */
  rotate(sealed: SealedPayload): SealedPayload {
    return this.seal(this.open(sealed));
  }
}
