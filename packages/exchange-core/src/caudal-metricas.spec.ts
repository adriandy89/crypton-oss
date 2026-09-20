/**
 * Los contadores de espera en el caudal (spec 065).
 *
 * Existen porque el presupuesto duerme en vez de fallar: sin ellos, la única
 * señal de que un bot no mantiene el ritmo era el aviso que le llega al usuario
 * cuando ya lo ha perdido.
 */
import { Venue } from '@crypton/shared';
import {
  anotarCola,
  anotarConcesion,
  caudalDeVenue,
  claveCaudal,
  consumirVentana,
  instantaneaDeCaudal,
  reiniciarCaudal,
} from './caudal-metricas';
import { MemoryVenueBudget } from './venue-budget';

const HL_READ = claveCaudal(Venue.HYPERLIQUID, false, 'read');

describe('contadores de caudal', () => {
  it('una concesión sin espera cuenta, pero no como espera', () => {
    anotarConcesion(HL_READ, 0);
    expect(instantaneaDeCaudal().get(HL_READ)).toMatchObject({
      concesiones: 1,
      esperadas: 0,
      esperaTotalMs: 0,
      esperaMaxMs: 0,
    });
  });

  it('la espera se suma y se guarda la peor', () => {
    anotarConcesion(HL_READ, 100);
    anotarConcesion(HL_READ, 900);
    anotarConcesion(HL_READ, 50);
    expect(instantaneaDeCaudal().get(HL_READ)).toMatchObject({
      concesiones: 3,
      esperadas: 3,
      esperaTotalMs: 1050,
      esperaMaxMs: 900,
    });
  });

  it('de la cola se guarda lo más larga que se la ha visto', () => {
    anotarCola(HL_READ, 3);
    anotarCola(HL_READ, 11);
    anotarCola(HL_READ, 2);
    expect(instantaneaDeCaudal().get(HL_READ)?.colaMax).toBe(11);
  });

  it('la red y la prioridad no se mezclan, pero el venue las suma', () => {
    anotarConcesion(claveCaudal(Venue.HYPERLIQUID, false, 'read'), 10);
    anotarConcesion(claveCaudal(Venue.HYPERLIQUID, false, 'write'), 400);
    anotarConcesion(claveCaudal(Venue.HYPERLIQUID, true, 'read'), 9999);
    anotarConcesion(claveCaudal(Venue.LIGHTER, false, 'read'), 7);

    expect(caudalDeVenue(Venue.HYPERLIQUID)).toMatchObject({
      concesiones: 2,
      esperaTotalMs: 410,
      esperaMaxMs: 400,
    });
    expect(caudalDeVenue(Venue.HYPERLIQUID, true).concesiones).toBe(1);
  });

  it('la instantánea es una copia: quien vigila no puede alterar lo que mide', () => {
    anotarConcesion(HL_READ, 10);
    const foto = instantaneaDeCaudal();
    foto.get(HL_READ)!.concesiones = 999;
    expect(instantaneaDeCaudal().get(HL_READ)?.concesiones).toBe(1);
  });

  it('reiniciar deja los contadores a cero', () => {
    anotarConcesion(HL_READ, 10);
    reiniciarCaudal();
    expect(instantaneaDeCaudal().size).toBe(0);
  });

  /**
   * La propiedad de la que depende el aviso del motor: mide lo que esperó un
   * tick restando el total de antes al de después, así que una ventana del
   * vigilante que cayera en medio no puede llevarse los totales por delante.
   */
  it('consumir una ventana NO borra los totales: solo los máximos', () => {
    anotarConcesion(HL_READ, 4_000);
    anotarCola(HL_READ, 8);
    consumirVentana();

    const tras = instantaneaDeCaudal().get(HL_READ)!;
    expect(tras.concesiones).toBe(1);
    expect(tras.esperaTotalMs).toBe(4_000);
    expect(tras.esperaMaxMs).toBe(0);
    expect(tras.colaMax).toBe(0);
  });

  it('cada ventana cuenta lo suyo, no lo de la anterior', () => {
    anotarConcesion(HL_READ, 100);
    anotarConcesion(HL_READ, 100);
    expect(consumirVentana()[0].texto).toMatch(/2 peticiones, 2 esperaron/);

    anotarConcesion(HL_READ, 0);
    expect(consumirVentana()[0].texto).toMatch(/1 peticiones, 0 esperaron/);

    // Y sin actividad nueva, no hay línea que dar.
    expect(consumirVentana()).toHaveLength(0);
  });

  it('una ventana duele por espera o por cola, y lo dice', () => {
    anotarConcesion(HL_READ, 3_500);
    expect(consumirVentana()[0].duele).toBe(true);

    anotarConcesion(HL_READ, 10);
    anotarCola(HL_READ, 9);
    expect(consumirVentana()[0].duele).toBe(true);

    anotarConcesion(HL_READ, 10);
    expect(consumirVentana()[0].duele).toBe(false);
  });

  /** La razón de que esto exista: medir donde de verdad se duerme. */
  it('el presupuesto anota lo que hace esperar, sin que nadie se lo pida', async () => {
    const budget = new MemoryVenueBudget({
      ratePerSecond: { [Venue.HYPERLIQUID]: 100 },
      burstSeconds: 1,
    });
    await budget.take(Venue.HYPERLIQUID, 95, 'write', false);
    await budget.take(Venue.HYPERLIQUID, 40, 'read', false);

    const lectura = instantaneaDeCaudal().get(HL_READ)!;
    expect(lectura.concesiones).toBe(1);
    expect(lectura.esperadas).toBe(1);
    expect(lectura.esperaMaxMs).toBeGreaterThan(100);

    // Y una concesión inmediata no cuenta como espera.
    reiniciarCaudal();
    const libre = new MemoryVenueBudget();
    await libre.take(Venue.HYPERLIQUID, 2, 'read', false);
    expect(instantaneaDeCaudal().get(HL_READ)).toMatchObject({ concesiones: 1, esperadas: 0 });
  });
});
