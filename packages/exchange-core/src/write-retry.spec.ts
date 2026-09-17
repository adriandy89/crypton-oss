import { ExchangeError, Venue } from '@crypton/shared';
import { withWriteRetry } from './rate-limit';

/**
 * Spec 001 — test de confirmación de F-68 (AS-3 en `informes/C-aster.md`).
 *
 * `withWriteRetry` existe para NO reenviar a ciegas: ante un fallo reintentable
 * pregunta al venue si la orden entró (`verify`) y solo reenvía si no. Pero si
 * la pregunta misma falla —503 sostenido, nonce rechazado, 429—, el `catch` la
 * convierte en «no entró» y se reenvía igual. Una MARKET que sí había entrado
 * se dobla. La doc de Aster sobre el 503: «the execution status is UNKNOWN and
 * could have been a success».
 *
 * Está en ROJO a propósito hasta que llegue la corrección aprobada.
 */
describe('withWriteRetry — cuando no se puede saber si la orden entró', () => {
  it('no reenvía si la comprobación falla: el estado es desconocido, no «no entró»', async () => {
    const retryable = new ExchangeError('RETRYABLE', 'HTTP 503', Venue.ASTER);
    const envios: number[] = [];
    const send = jest.fn(async () => {
      envios.push(envios.length + 1);
      if (envios.length === 1) throw retryable;
      return { clientOrderId: 'x', venueOrderId: 'v-2', status: 'FILLED' as const, ts: 0 };
    });
    // La comprobación también falla: el venue está caído para todo.
    const verify = jest.fn(async () => {
      throw new ExchangeError('RETRYABLE', 'HTTP 503', Venue.ASTER);
    });

    await expect(
      withWriteRetry(send, verify, { venue: Venue.ASTER, baseDelayMs: 1 }),
    ).rejects.toBeInstanceOf(ExchangeError);
    // Un solo envío: sin saber si el primero entró, el segundo puede doblar la posición.
    expect(send).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
  });
});

/**
 * Spec 057, F-06. El error de estado desconocido salía como un RETRYABLE más, y
 * el motor marcaba la fila REJECTED: el tick siguiente volvía a mandar la orden.
 * Ahora viaja marcado. Y el ÚLTIMO intento fallido tampoco se daba por
 * comprobado: podía haber entrado sin que nadie lo preguntara.
 */
describe('withWriteRetry — el estado desconocido viaja marcado (spec 057, F-06)', () => {
  const fallo = () => new ExchangeError('RETRYABLE', 'HTTP 503', Venue.ASTER);
  const acuse = { clientOrderId: 'x', venueOrderId: 'v-1', status: 'FILLED' as const, ts: 0 };
  type Acuse = typeof acuse;
  const error = (p: Promise<unknown>) =>
    p.then(() => null).catch((e: unknown) => e as ExchangeError);

  it('si la comprobación falla, el error dice que el estado es desconocido', async () => {
    const e = await error(
      withWriteRetry<Acuse>(
        () => Promise.reject(fallo()),
        () => Promise.reject(fallo()),
        { venue: Venue.ASTER, baseDelayMs: 1 },
      ),
    );
    expect(e).toBeInstanceOf(ExchangeError);
    expect(e?.estadoDesconocido).toBe(true);
  });

  it('tras el último intento también se pregunta: si entró, se devuelve su acuse', async () => {
    const send = jest.fn(() => Promise.reject(fallo()));
    const verify = jest
      .fn<Promise<Acuse | null>, []>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(acuse);

    await expect(withWriteRetry(send, verify, { attempts: 3, baseDelayMs: 1 })).resolves.toBe(
      acuse,
    );
    expect(send).toHaveBeenCalledTimes(3);
    expect(verify).toHaveBeenCalledTimes(3);
  });

  it('si tras el último intento no entró, el error es el del envío, y se sabe', async () => {
    const send = jest.fn(() => Promise.reject(fallo()));
    const verify = jest.fn<Promise<Acuse | null>, []>().mockResolvedValue(null);

    const e = await error(withWriteRetry(send, verify, { attempts: 2, baseDelayMs: 1 }));
    expect(e?.kind).toBe('RETRYABLE');
    expect(e?.estadoDesconocido).toBe(false);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('si la comprobación del último intento falla, es desconocido', async () => {
    const send = jest.fn(() => Promise.reject(fallo()));
    const verify = jest
      .fn<Promise<Acuse | null>, []>()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(fallo());

    const e = await error(withWriteRetry(send, verify, { attempts: 2, baseDelayMs: 1 }));
    expect(e?.estadoDesconocido).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('un rechazo que no se reintenta no se comprueba ni es desconocido', async () => {
    const send = jest.fn(() => Promise.reject(new ExchangeError('RULES', 'tick', Venue.ASTER)));
    const verify = jest.fn<Promise<Acuse | null>, []>();

    const e = await error(withWriteRetry(send, verify, { baseDelayMs: 1 }));
    expect(e?.kind).toBe('RULES');
    expect(e?.estadoDesconocido).toBe(false);
    expect(verify).not.toHaveBeenCalled();
  });
});
