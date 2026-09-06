import { startOfDay } from './time';

/**
 * El corte del «día» de la pérdida diaria (spec 001, F-43). La API lo hacía a
 * la medianoche del servidor y el worker a la del usuario: dos límites diarios
 * con dos días distintos. Ahora hay un solo cálculo, y estos son sus contratos.
 */
describe('startOfDay', () => {
  // 2026-09-06 03:00 UTC: ya es día 6 en UTC, todavía día 5 en América.
  const ahora = new Date('2026-09-06T03:00:00.000Z');

  it('corta a la medianoche de la zona del usuario, no a la del servidor', () => {
    // Ciudad de México va seis horas por detrás de UTC (sin horario de verano
    // desde 2022): a las 03:00 UTC son las 21:00 del día 5.
    expect(startOfDay('America/Mexico_City', ahora).toISOString()).toBe('2026-09-05T06:00:00.000Z');
  });

  it('en UTC la medianoche es la medianoche', () => {
    expect(startOfDay('UTC', ahora).toISOString()).toBe('2026-09-06T00:00:00.000Z');
  });

  it('por delante de UTC el día ya ha cambiado', () => {
    // Tokio va nueve horas por delante: a las 03:00 UTC son las 12:00 del día 6.
    expect(startOfDay('Asia/Tokyo', ahora).toISOString()).toBe('2026-09-05T15:00:00.000Z');
  });

  it('una zona desconocida cae a la del proceso en vez de fallar', () => {
    const esperado = new Date(ahora);
    esperado.setHours(0, 0, 0, 0);
    expect(startOfDay('Marte/Olympus', ahora).getTime()).toBe(esperado.getTime());
    expect(startOfDay(null, ahora).getTime()).toBe(esperado.getTime());
  });
});
