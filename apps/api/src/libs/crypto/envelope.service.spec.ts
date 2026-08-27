import { ConfigService } from '@nestjs/config';
import { InternalServerErrorException } from '@nestjs/common';
import { EnvelopeService, type SealedPayload } from './envelope.service';

/**
 * Tests del cifrado de credenciales.
 *
 * Es la pieza de la que depende que un volcado de la base de datos no permita
 * firmar ordenes en nombre de nadie, asi que se comprueba de verdad: que el
 * secreto no aparezca en el texto cifrado, que dos cifrados del mismo valor
 * sean distintos, que la manipulacion se detecte y que la rotacion de clave
 * funcione sin dejar credenciales ilegibles por el camino.
 */

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

const config = (values: Record<string, string>): ConfigService =>
  ({
    get: (key: string, fallback?: string) => values[key] ?? fallback ?? '',
  }) as unknown as ConfigService;

const SECRET = {
  venue: 'HYPERLIQUID',
  accountAddress: '0x1234567890123456789012345678901234567890',
  agentPrivateKey: '0xdeadbeef'.padEnd(66, '0'),
};

describe('EnvelopeService', () => {
  const service = new EnvelopeService(
    config({ CREDENTIALS_MASTER_KEY: KEY_A }),
  );

  it('descifra exactamente lo que se cifro', () => {
    const sealed = service.seal(SECRET);
    expect(service.open(sealed)).toEqual(SECRET);
  });

  it('el secreto NO aparece en ninguna parte del sobre', () => {
    const sealed = service.seal(SECRET);
    const blob = JSON.stringify(sealed);
    expect(blob).not.toContain(SECRET.agentPrivateKey);
    expect(blob).not.toContain(SECRET.accountAddress);
    expect(blob).not.toContain('HYPERLIQUID');
  });

  it('cifrar dos veces el mismo valor da resultados distintos', () => {
    // Cada sobre usa su propia clave de datos y su propio IV. Si dos cifrados
    // del mismo secreto coincidieran, se podria deducir que dos usuarios
    // comparten credencial con solo mirar la tabla.
    const a = service.seal(SECRET);
    const b = service.seal(SECRET);
    expect(a.encPayload).not.toBe(b.encPayload);
    expect(a.encDek).not.toBe(b.encDek);
    expect(a.encIv).not.toBe(b.encIv);
    // Y aun asi, los dos descifran a lo mismo.
    expect(service.open(a)).toEqual(service.open(b));
  });

  it('detecta la manipulacion del texto cifrado', () => {
    // GCM autentica: alterar la fila en base de datos hace fallar el
    // descifrado, en vez de devolver basura que acabaria interpretandose como
    // una clave privada y firmando quien sabe que.
    const sealed = service.seal(SECRET);
    const tampered: SealedPayload = {
      ...sealed,
      encPayload: flipLastByte(sealed.encPayload),
    };
    expect(() => service.open(tampered)).toThrow(InternalServerErrorException);
  });

  it('detecta la manipulacion de la etiqueta de autenticacion', () => {
    const sealed = service.seal(SECRET);
    const tampered: SealedPayload = {
      ...sealed,
      encTag: flipLastByte(sealed.encTag),
    };
    expect(() => service.open(tampered)).toThrow(InternalServerErrorException);
  });

  it('una clave maestra distinta no puede abrir el sobre', () => {
    const other = new EnvelopeService(
      config({ CREDENTIALS_MASTER_KEY: KEY_B }),
    );
    const sealed = service.seal(SECRET);
    expect(() => other.open(sealed)).toThrow();
  });

  it('acepta una clave maestra que no sea hexadecimal (comodidad de desarrollo)', () => {
    const dev = new EnvelopeService(
      config({ CREDENTIALS_MASTER_KEY: 'clave-de-desarrollo' }),
    );
    expect(dev.open(dev.seal(SECRET))).toEqual(SECRET);
  });

  it('exige que la clave maestra este configurada', () => {
    expect(() => new EnvelopeService(config({}))).toThrow(
      /CREDENTIALS_MASTER_KEY/,
    );
  });

  describe('rotacion de clave', () => {
    const rotating = new EnvelopeService(
      config({
        CREDENTIALS_MASTER_KEY: `v1:${KEY_A},v2:${KEY_B}`,
        CREDENTIALS_ACTIVE_KEY_ID: 'v2',
      }),
    );

    it('cifra con la clave ACTIVA', () => {
      expect(rotating.seal(SECRET).encKeyId).toBe('v2');
    });

    it('sigue descifrando lo cifrado con la clave antigua', () => {
      // Es lo que permite rotar sin downtime: las credenciales viejas siguen
      // funcionando mientras se recifran en segundo plano.
      const oldSealed = { ...service.seal(SECRET), encKeyId: 'v1' };
      expect(rotating.open(oldSealed)).toEqual(SECRET);
    });

    it('identifica que sobres hay que recifrar', () => {
      const oldSealed = { ...service.seal(SECRET), encKeyId: 'v1' };
      expect(rotating.needsRotation(oldSealed)).toBe(true);
      expect(rotating.needsRotation(rotating.seal(SECRET))).toBe(false);
    });

    it('recifra conservando el contenido', () => {
      const oldSealed = { ...service.seal(SECRET), encKeyId: 'v1' };
      const rotated = rotating.rotate(oldSealed);
      expect(rotated.encKeyId).toBe('v2');
      expect(rotating.open(rotated)).toEqual(SECRET);
    });

    it('falla claro si la clave con la que se cifro ya no existe', () => {
      const orphan = { ...service.seal(SECRET), encKeyId: 'v0' };
      expect(() => rotating.open(orphan)).toThrow(/v0/);
    });

    it('rechaza una clave activa que no esta configurada', () => {
      expect(
        () =>
          new EnvelopeService(
            config({
              CREDENTIALS_MASTER_KEY: `v1:${KEY_A}`,
              CREDENTIALS_ACTIVE_KEY_ID: 'v9',
            }),
          ),
      ).toThrow(/CREDENTIALS_ACTIVE_KEY_ID/);
    });
  });
});

/** Altera un byte del contenido en base64, manteniendo su longitud. */
function flipLastByte(b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  buf[buf.length - 1] ^= 0xff;
  return buf.toString('base64');
}
