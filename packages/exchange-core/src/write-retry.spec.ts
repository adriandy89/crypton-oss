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
