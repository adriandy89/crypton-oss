import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  claveValeAgente,
  type DatosEventoAgente,
  type EventoAgente,
  type EventSeverity,
  type ValeAgente,
} from '@crypton/shared';
import { BUS_CHANNELS, BusService, CacheService } from 'src/libs';

/**
 * Los avisos de los agentes (spec 074, R-26): los eventos sin bot que el
 * notificador del worker lleva a Telegram, y los vales de sus botones.
 *
 * Nacen en la API, así que van con `entregaForzada`: sin la marca, el
 * notificador los descarta por origen ajeno y no los entrega nadie (spec 046,
 * R-27). La entrega la reparte el propio notificador entre réplicas, por
 * propuesta o por acción.
 */
@Injectable()
export class AiDeskAvisosService {
  constructor(
    private readonly bus: BusService,
    private readonly cache: CacheService,
  ) {}

  /** Un aviso del agente. Que no salga no para nada: la fila ya está escrita. */
  async agente(
    userId: string,
    tipo: EventoAgente,
    severidad: EventSeverity,
    mensaje: string,
    datos: DatosEventoAgente,
  ): Promise<void> {
    await this.bus
      .publish(BUS_CHANNELS.BOT_EVENTS, {
        userId,
        type: tipo,
        entregaForzada: true,
        data: { ...datos, severity: severidad, message: mensaje },
      })
      .catch(() => undefined);
  }

  /**
   * Un vale nuevo para los botones de un mensaje, de un solo uso y que caduca
   * con lo que decide. Opaco: en `callback_data` caben 64 bytes, y quien lo
   * intercepte no debe poder deducir de qué propuesta es. null si Redis no lo
   * guardó: entonces el mensaje sale sin botones y se decide desde la app.
   */
  async vale(datos: ValeAgente, vidaS: number): Promise<string | null> {
    const vale = randomUUID().replace(/-/g, '');
    await this.cache.set(claveValeAgente(vale), datos, Math.max(60, Math.ceil(vidaS)));
    const guardado = await this.cache.get<ValeAgente>(claveValeAgente(vale));
    return guardado ? vale : null;
  }

  /** Canjea un vale: una vez, aunque lo pulsen dos veces o lo reciban dos réplicas. */
  canjear(vale: string): Promise<ValeAgente | null> {
    return this.cache.getDel<ValeAgente>(claveValeAgente(vale));
  }
}
