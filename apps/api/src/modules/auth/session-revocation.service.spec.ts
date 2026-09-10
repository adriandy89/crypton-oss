import { CacheUnavailableError } from 'src/libs';
import { SessionRevocationService } from './session-revocation.service';

/**
 * La revocacion de sesion, que es lo unico que separa «deshabilitado en la base
 * de datos» de «deshabilitado de verdad». Todo con dobles: no hace falta Redis
 * para probar la politica, y la politica es lo que puede salir mal.
 */
describe('SessionRevocationService', () => {
  const USER = 'u-1';

  const crear = (opts: { failOpen?: boolean; staleMaxMs?: number } = {}) => {
    const cache = {
      getOrThrow: jest.fn<Promise<number | null>, [string]>().mockResolvedValue(null),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };
    const audit = { record: jest.fn() };
    const bus = { publish: jest.fn().mockResolvedValue(undefined) };
    const config = {
      get: (clave: string, porDefecto?: unknown) => {
        if (clave === 'JWT_ACCESS_TTL') return '15m';
        if (clave === 'AUTH_REVOCATION_FAIL_OPEN') {
          return opts.failOpen === false ? 'false' : undefined;
        }
        if (clave === 'AUTH_REVOCATION_STALE_MAX_MS') return opts.staleMaxMs ?? porDefecto;
        return porDefecto;
      },
    };
    const svc = new SessionRevocationService(
      cache as never,
      audit as never,
      bus as never,
      config as never,
    );
    return { svc, cache, audit, bus };
  };

  /** Segundos, que es como viaja `iat` dentro del token. */
  const seg = (ms: number) => Math.floor(ms / 1000);

  describe('comparacion contra el iat', () => {
    it('sin marca, no hay nada revocado', async () => {
      const { svc } = crear();
      await expect(svc.isRevoked(USER, seg(Date.now()))).resolves.toBe(false);
    });

    it('un token emitido ANTES de la marca esta revocado', async () => {
      const { svc, cache } = crear();
      const marca = Date.now();
      cache.getOrThrow.mockResolvedValue(marca);
      await expect(svc.isRevoked(USER, seg(marca) - 10)).resolves.toBe(true);
    });

    it('un token emitido DESPUES de la marca vale', async () => {
      const { svc, cache } = crear();
      const marca = Date.now();
      cache.getOrThrow.mockResolvedValue(marca);
      await expect(svc.isRevoked(USER, seg(marca) + 10)).resolves.toBe(false);
    });

    /**
     * El borde del segundo. `iat` va en segundos y la marca en milisegundos, asi
     * que el segundo en que se revoca es ambiguo: no se puede distinguir un token
     * firmado antes de la revocacion de uno firmado despues. Se resuelve del lado
     * seguro —el segundo entero cuenta como revocado— y estos dos casos fijan esa
     * decision para que nadie la invierta «simplificando» el redondeo.
     */
    it('un token del mismo segundo que la revocacion NO sobrevive', async () => {
      const { svc, cache } = crear();
      const ahora = 1_700_000_000_500; // ...:20.500
      jest.spyOn(Date, 'now').mockReturnValue(ahora);
      cache.getOrThrow.mockImplementation(async () => cache.set.mock.calls[0][1] as number);

      await expect(svc.revoke(USER, 'cuenta_deshabilitada')).resolves.toMatchObject({
        aplicada: true,
      });
      await expect(svc.isRevoked(USER, seg(ahora))).resolves.toBe(true);
      jest.restoreAllMocks();
    });

    it('un token del segundo SIGUIENTE ya vale', async () => {
      const { svc, cache } = crear();
      const ahora = 1_700_000_000_500;
      jest.spyOn(Date, 'now').mockReturnValue(ahora);
      cache.getOrThrow.mockImplementation(async () => cache.set.mock.calls[0][1] as number);

      await svc.revoke(USER, 'cuenta_deshabilitada');
      await expect(svc.isRevoked(USER, seg(ahora) + 1)).resolves.toBe(false);
      jest.restoreAllMocks();
    });

    it('escribe la marca con TTL de sobra sobre el access token y confirma la escritura', async () => {
      const { svc, cache } = crear();
      cache.getOrThrow.mockImplementation(async () => cache.set.mock.calls[0][1] as number);

      const res = await svc.revoke(USER, 'sesiones_cerradas');

      const [clave, , ttl] = cache.set.mock.calls[0];
      expect(clave).toBe(`auth:revoked:${USER}`);
      expect(ttl).toBe(900 + 60); // JWT_ACCESS_TTL=15m, mas el margen de reloj
      expect(res.aplicada).toBe(true);
      expect(res.vigenteHasta).toBeInstanceOf(Date);
    });

    /**
     * `CacheService.set` se traga sus errores, asi que sin la relectura esto
     * devolveria «hecho» con Redis caido. Un administrador que deshabilita una
     * cuenta comprometida tiene que saber si el corte fue real.
     */
    it('si la marca no se pudo escribir, lo DICE en vez de mentir', async () => {
      const { svc, cache } = crear();
      cache.getOrThrow.mockRejectedValue(new CacheUnavailableError('GET'));

      const res = await svc.revoke(USER, 'cuenta_deshabilitada');

      expect(res.aplicada).toBe(false);
      // Y aun asi dice HASTA CUANDO puede seguir valiendo el token del usuario:
      // es justo el dato que necesita quien acaba de cerrar una cuenta y tiene
      // que saber cuanto rato le queda dentro a quien estaba usandola.
      expect(res.vigenteHasta.getTime()).toBeGreaterThan(Date.now());
    });

    it('clear borra la clave Y el recuerdo en memoria', async () => {
      const { svc, cache } = crear();
      const marca = Date.now();
      cache.getOrThrow.mockResolvedValue(marca);
      await svc.isRevoked(USER, seg(marca) - 10); // deja el recuerdo

      await svc.clear(USER);
      expect(cache.del).toHaveBeenCalledWith(`auth:revoked:${USER}`);

      // Y con Redis caido ya no lo recuerda revocado: si solo se borrase la
      // clave, este proceso seguiria rechazando al usuario rehabilitado.
      cache.getOrThrow.mockRejectedValue(new CacheUnavailableError('GET'));
      await expect(svc.isRevoked(USER, seg(marca) - 10)).resolves.toBe(false);
    });
  });

  describe('Redis caido', () => {
    it('a quien ya sabiamos revocado se le sigue negando el paso', async () => {
      const { svc, cache } = crear();
      const marca = Date.now();
      cache.getOrThrow.mockResolvedValue(marca);
      await svc.isRevoked(USER, seg(marca) - 10); // lectura buena: lo recuerda

      cache.getOrThrow.mockRejectedValue(new CacheUnavailableError('GET'));
      await expect(svc.isRevoked(USER, seg(marca) - 10)).resolves.toBe(true);
    });

    it('a un usuario desconocido se le deja pasar, y la degradacion se cuenta UNA vez', async () => {
      const { svc, cache, audit } = crear();
      cache.getOrThrow.mockRejectedValue(new CacheUnavailableError('GET'));

      for (let i = 0; i < 5; i++) {
        await expect(svc.isRevoked(`otro-${i}`, seg(Date.now()))).resolves.toBe(false);
      }
      expect(audit.record).not.toHaveBeenCalled(); // aun degradado: nada que cerrar

      cache.getOrThrow.mockResolvedValue(null); // Redis vuelve
      await svc.isRevoked(USER, seg(Date.now()));

      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record.mock.calls[0][0]).toMatchObject({
        action: 'auth.revocation_degraded',
        meta: { peticiones: 5 },
      });
    });

    it('un recuerdo rancio no se usa: se deja pasar y se cuenta', async () => {
      const { svc, cache } = crear({ staleMaxMs: 1 });
      const marca = Date.now();
      cache.getOrThrow.mockResolvedValue(marca);
      await svc.isRevoked(USER, seg(marca) - 10);

      jest.spyOn(Date, 'now').mockReturnValue(marca + 5_000); // el recuerdo caduco
      cache.getOrThrow.mockRejectedValue(new CacheUnavailableError('GET'));
      await expect(svc.isRevoked(USER, seg(marca) - 10)).resolves.toBe(false);
      jest.restoreAllMocks();
    });

    /** La palanca del spec 033. Existe el test para que no sea decorativa. */
    it('con AUTH_REVOCATION_FAIL_OPEN=false se rechaza a todo el mundo', async () => {
      const { svc, cache } = crear({ failOpen: false });
      cache.getOrThrow.mockRejectedValue(new CacheUnavailableError('GET'));
      await expect(svc.isRevoked(USER, seg(Date.now()))).resolves.toBe(true);
    });
  });
});
