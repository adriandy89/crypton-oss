import { Venue } from '@crypton/shared';
import { serviceCredentials, type ConfigLike } from './service-credentials';
import { createPublicAdapter } from './factory';

/**
 * La cuenta de SERVICIO decide entre dos modos que se diferencian en un factor
 * enorme de cupo, y elegir en silencio entre ellos es como se llega a un
 * incidente que nadie sabe explicar. De ahi que lo que se comprueba aqui sea
 * tanto la decision como el AVISO.
 */

/** ConfigService de mentira: un mapa con el mismo contrato de `get`. */
const config = (valores: Record<string, string>): ConfigLike => ({
  get: <T = string>(key: string, fallback?: T): T =>
    (valores[key] as unknown as T) ?? (fallback as T),
});

const CLAVE = '0x' + 'ab'.repeat(20);

describe('credenciales de servicio', () => {
  it('sin clave se sigue sin firmar, y se DICE en el aviso', () => {
    const r = serviceCredentials(Venue.LIGHTER, config({}));
    expect(r.credentials).toBeUndefined();
    // El aviso tiene que llevar el numero: es lo que hace que quien lo lea
    // entienda por que su grafico va lento.
    expect(r.notice).toContain('60');
    expect(r.notice).toContain('LIGHTER_SERVICE_PRIVATE_KEY');
  });

  it('con clave e indice validos, se firma', () => {
    const r = serviceCredentials(
      Venue.LIGHTER,
      config({
        LIGHTER_SERVICE_ACCOUNT_INDEX: '42',
        LIGHTER_SERVICE_API_KEY_INDEX: '4',
        LIGHTER_SERVICE_PRIVATE_KEY: CLAVE,
      }),
    );
    expect(r.credentials).toEqual({ accountIndex: 42, apiKeyIndex: 4, apiPrivateKey: CLAVE });
    expect(r.notice).toContain('42');
  });

  /**
   * Lighter reserva los indices 0-3 para sus aplicaciones de escritorio y
   * movil: usar uno de esos PISA la sesion de la interfaz oficial del usuario.
   * Es un fallo que no da error por ninguna parte, solo desloguea a alguien.
   */
  it.each([0, 1, 2, 3, 255, -1, 3.5])('rechaza el indice de clave %p', (indice) => {
    const r = serviceCredentials(
      Venue.LIGHTER,
      config({
        LIGHTER_SERVICE_ACCOUNT_INDEX: '42',
        LIGHTER_SERVICE_API_KEY_INDEX: String(indice),
        LIGHTER_SERVICE_PRIVATE_KEY: CLAVE,
      }),
    );
    expect(r.credentials).toBeUndefined();
    expect(r.notice).toMatch(/4 y 254/);
  });

  it('un indice de cuenta que no es numero no se cuela como NaN', () => {
    const r = serviceCredentials(
      Venue.LIGHTER,
      config({ LIGHTER_SERVICE_ACCOUNT_INDEX: 'pepe', LIGHTER_SERVICE_PRIVATE_KEY: CLAVE }),
    );
    expect(r.credentials).toBeUndefined();
  });

  it('la clave con espacios alrededor sigue valiendo', () => {
    const r = serviceCredentials(
      Venue.LIGHTER,
      config({
        LIGHTER_SERVICE_ACCOUNT_INDEX: '7',
        LIGHTER_SERVICE_PRIVATE_KEY: '  ' + CLAVE + '  ',
      }),
    );
    expect(r.credentials?.apiPrivateKey).toBe(CLAVE);
    // Y el indice por defecto es 4, el primero que Lighter deja usar.
    expect(r.credentials?.apiKeyIndex).toBe(4);
  });

  /**
   * En los otros dos venues una credencial no cambia NADA, y por eso no se
   * pide: Hyperliquid publica sus `info` sin credencial, y Aster documenta que
   * «the limits on the API are based on the IPs, not the API keys».
   */
  it.each([Venue.HYPERLIQUID, Venue.ASTER])('en %s no se pide credencial ni se avisa', (venue) => {
    const r = serviceCredentials(
      venue,
      config({ LIGHTER_SERVICE_ACCOUNT_INDEX: '42', LIGHTER_SERVICE_PRIVATE_KEY: CLAVE }),
    );
    expect(r.credentials).toBeUndefined();
    expect(r.notice).toBe('');
  });
});

describe('createPublicAdapter con cuenta de servicio', () => {
  const adaptadores: { close: () => Promise<void> }[] = [];
  afterAll(async () => {
    await Promise.allSettled(adaptadores.map((a) => a.close()));
  });

  it('construir con credenciales NO intenta firmar: el firmante es perezoso', () => {
    // Importa porque la clave de arriba es inventada. Si el firmante se creara
    // en el constructor, un valor mal puesto en el entorno tumbaria el arranque
    // del proceso entero en vez de fallar al primer uso.
    const a = createPublicAdapter(Venue.LIGHTER, {
      service: { accountIndex: 42, apiKeyIndex: 4, apiPrivateKey: CLAVE },
    });
    adaptadores.push(a);
    expect(a.venue).toBe(Venue.LIGHTER);
  });

  it('sin credenciales de servicio sigue siendo un adaptador publico', () => {
    const a = createPublicAdapter(Venue.LIGHTER);
    adaptadores.push(a);
    expect(a.venue).toBe(Venue.LIGHTER);
  });

  /**
   * Solo Aster: construir el de Hyperliquid carga su SDK, que es solo ESM y se
   * trae con `require()`, y el runtime de Jest no implementa `require(esm)`.
   * Es la misma razon por la que `VENUE_CAPABILITIES` es una constante y no se
   * construyen adaptadores para leerla.
   */
  it('a los otros venues no se les pasa la cuenta de servicio', () => {
    // No es una simplificacion: alli no sirve de nada, y meterle una credencial
    // a un adaptador que se declara publico solo amplia lo que puede romper.
    const a = createPublicAdapter(Venue.ASTER, {
      service: { accountIndex: 42, apiKeyIndex: 4, apiPrivateKey: CLAVE },
    });
    adaptadores.push(a);
    expect(a.venue).toBe(Venue.ASTER);
  });
});
