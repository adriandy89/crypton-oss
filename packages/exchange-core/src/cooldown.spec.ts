import { ExchangeError, Venue } from '@crypton/shared';
import { VenueCooldown } from './cooldown';
import { toExchangeError } from './errors';

/**
 * Clasificar el corte no bastaba.
 *
 * Un `THROTTLED` bien clasificado evita los REINTENTOS, pero no evita que la
 * siguiente peticion —de otro usuario, del cron, de otro bot— salga igual y se
 * lleve otro corte. Con el cortafuegos activo, cada peticion que sale confirma
 * al venue que seguimos ahi. Esto es lo que faltaba para cerrar el circulo.
 */
describe('enfriamiento tras un corte del venue', () => {
  it('sin corte previo no estorba', () => {
    const c = new VenueCooldown(Venue.LIGHTER);
    expect(c.restanteMs()).toBe(0);
    expect(() => c.comprobar()).not.toThrow();
  });

  it('un error normal NO arranca el enfriamiento', () => {
    const c = new VenueCooldown(Venue.LIGHTER);
    c.registrar(new Error('socket hang up'));
    c.registrar(toExchangeError('order price violates tick size', Venue.LIGHTER));
    expect(c.restanteMs()).toBe(0);
  });

  it('un corte arranca el enfriamiento documentado de 60 s', () => {
    const c = new VenueCooldown(Venue.LIGHTER);
    c.registrar(toExchangeError('cortado', Venue.LIGHTER, 405));
    // Lighter: «Firewall: 60 seconds, static».
    expect(c.restanteMs()).toBeGreaterThan(55_000);
    expect(c.restanteMs()).toBeLessThanOrEqual(60_000);
  });

  it('durante el enfriamiento se falla en LOCAL, sin tocar la red', () => {
    const c = new VenueCooldown(Venue.LIGHTER);
    c.registrar(toExchangeError('cortado', Venue.LIGHTER, 429));

    let lanzado: ExchangeError | null = null;
    try {
      c.comprobar();
    } catch (e) {
      lanzado = e as ExchangeError;
    }
    expect(lanzado?.kind).toBe('THROTTLED');
    // El mensaje dice lo unico accionable: cuanto queda.
    expect(lanzado?.message).toMatch(/quedan \d+ s/);
    expect(lanzado?.message).toMatch(/LIGHTER/);
  });

  /**
   * Un 418 de Aster no es un corte de un minuto: es un veto de IP ya puesto que
   * escala «from 2 minutes to 3 days» si se insiste. Se espera bastante mas.
   */
  it('un veto de IP espera mas que un corte normal', () => {
    const corte = new VenueCooldown(Venue.ASTER);
    corte.registrar(toExchangeError('slow down', Venue.ASTER, 429));

    const veto = new VenueCooldown(Venue.ASTER);
    veto.registrar(toExchangeError('banned', Venue.ASTER, 418));

    expect(veto.restanteMs()).toBeGreaterThan(corte.restanteMs());
    expect(veto.restanteMs()).toBeGreaterThan(110_000);
  });

  /**
   * Dos cortes seguidos no pueden ACORTAR el castigo: si el segundo reiniciara
   * el reloj hacia abajo, insistir saldria gratis — justo lo contrario de lo
   * que esto sirve.
   */
  it('un corte posterior no acorta un enfriamiento mas largo ya en curso', () => {
    const c = new VenueCooldown(Venue.ASTER);
    c.registrar(toExchangeError('banned', Venue.ASTER, 418));
    const trasVeto = c.restanteMs();

    c.registrar(toExchangeError('slow down', Venue.ASTER, 429));
    expect(c.restanteMs()).toBeGreaterThanOrEqual(trasVeto - 50);
  });

  it('se puede volver a llamar cuando pasa el enfriamiento', () => {
    const c = new VenueCooldown(Venue.LIGHTER);
    c.iniciar(30, 'prueba');
    expect(() => c.comprobar()).toThrow();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(c.restanteMs()).toBe(0);
        expect(() => c.comprobar()).not.toThrow();
        resolve();
      }, 60);
    });
  });
});

/**
 * Un «418» suelto dentro de un texto NO es un veto. Es el mismo fallo que tenia
 * la clasificacion de errores: un regex sobre texto arbitrario acaba casando
 * con un precio o con un nonce en base64.
 */
describe('el veto se reconoce por el estado, no por el numero suelto', () => {
  it('un precio que contiene 418 no dispara el enfriamiento largo', () => {
    const corte = new VenueCooldown(Venue.LIGHTER);
    // En crudo, como llega del SDK: el texto lleva 77418 y el estado es 429.
    corte.registrar(
      Object.assign(new Error('rate limited, last price 77418.5'), { response: { status: 429 } }),
    );

    const veto = new VenueCooldown(Venue.ASTER);
    veto.registrar(toExchangeError('banned', Venue.ASTER, 418));

    expect(corte.restanteMs()).toBeLessThan(veto.restanteMs());
    expect(corte.restanteMs()).toBeLessThanOrEqual(60_000);
  });

  it('un error de axios en crudo tambien arranca el enfriamiento', () => {
    // Es como llegan los del SDK, y era por donde el enfriamiento no saltaba:
    // la conversion a ExchangeError ocurre despues, al final de `withRetry`.
    const c = new VenueCooldown(Venue.LIGHTER);
    c.registrar(Object.assign(new Error('Request failed'), { response: { status: 405 } }));
    expect(c.restanteMs()).toBeGreaterThan(55_000);
  });
});
