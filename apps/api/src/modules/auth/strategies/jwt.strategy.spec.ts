import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';

/**
 * La puerta por la que pasa toda peticion autenticada de la API. Lo que se
 * prueba aqui no es passport, es que la revocacion se consulta con el dato
 * correcto y que un token revocado no entra.
 */
describe('JwtStrategy', () => {
  // Con 32 caracteres: por debajo, `requireSecret` se niega a arrancar y hace bien.
  const config = { get: () => 'secreto-de-pruebas-suficientemente-largo' } as never;
  const payload = {
    sub: 'u-1',
    email: 'laura@example.com',
    name: 'Laura',
    role: 'USER' as const,
    iat: 1_700_000_000,
  };

  const crear = (revocado: boolean) => {
    const revocacion = { isRevoked: jest.fn().mockResolvedValue(revocado) };
    return { estrategia: new JwtStrategy(config, revocacion as never), revocacion };
  };

  it('devuelve el usuario de sesion cuando el token vale', async () => {
    const { estrategia } = crear(false);
    await expect(estrategia.validate(payload)).resolves.toEqual({
      id: 'u-1',
      email: 'laura@example.com',
      name: 'Laura',
      role: 'USER',
      language: 'es', // el idioma cae a castellano cuando el claim no viaja
    });
  });

  it('respeta el idioma del token cuando viene', async () => {
    const { estrategia } = crear(false);
    await expect(estrategia.validate({ ...payload, language: 'en' })).resolves.toMatchObject({
      language: 'en',
    });
  });

  it('rechaza un token revocado, con un codigo que la app pueda distinguir', async () => {
    const { estrategia } = crear(true);
    await expect(estrategia.validate(payload)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(estrategia.validate(payload)).rejects.toMatchObject({
      response: { code: 'SESSION_REVOKED' },
    });
  });

  /**
   * El fallo mas facil de cometer aqui: preguntar por el momento actual en vez
   * de por el del token. Con `Date.now()` la comparacion siempre saldria a favor
   * del token y la revocacion no serviria para nada, sin romper ningun otro test.
   */
  it('pregunta por el iat DEL TOKEN, no por la hora actual', async () => {
    const { estrategia, revocacion } = crear(false);
    await estrategia.validate(payload);
    expect(revocacion.isRevoked).toHaveBeenCalledWith('u-1', 1_700_000_000);
  });
});
