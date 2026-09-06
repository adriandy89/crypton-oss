/**
 * Medianoche en la zona del usuario, expresada en hora absoluta.
 *
 * Se usa el desfase que `Intl` reporta para ESA zona en ese instante, así que
 * el corte del día es el que el usuario tiene en su reloj y no el del
 * contenedor —que en Docker es UTC y no coincide con casi nadie.
 *
 * Vive en `shared` porque la misma pérdida diaria la comprueban dos procesos:
 * la API al arrancar un bot y el worker en cada tick. Cada uno tenía su propio
 * corte (la API, la medianoche del servidor) y para un usuario fuera de UTC un
 * bot podía arrancar y pausarse en el primer tick, o al revés (001/F-43).
 *
 * `now` se inyecta para poder probarlo; por defecto es el reloj.
 */
export function startOfDay(timezone: string | null | undefined, now: Date = new Date()): Date {
  if (!timezone) return medianocheLocal(now);
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
    // Diferencia entre la hora local del usuario y la UTC, en milisegundos.
    const asUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') % 24,
      get('minute'),
      get('second'),
    );
    const offset = asUtc - now.getTime();
    return new Date(Date.UTC(get('year'), get('month') - 1, get('day')) - offset);
  } catch {
    // Zona desconocida: se cae a la del proceso en vez de fallar. Un límite
    // diario que se corta a la hora equivocada es malo; no comprobarlo, peor.
    return medianocheLocal(now);
  }
}

function medianocheLocal(now: Date): Date {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return midnight;
}
