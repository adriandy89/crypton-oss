import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  CLAVE_INTERRUPTOR_AGENTES,
  CLAVE_MOTIVO_INTERRUPTOR_AGENTES,
  interruptorCerrado,
  type InterruptoresAgentes,
} from '@crypton/shared';
import { CacheService } from 'src/libs';
import { OpenRouterClient } from '../advisor/openrouter.client';
import { AiDeskConfig } from './ai-desk.config';

/**
 * Las claves de los cupos diarios de consultas, por día UTC. Las cuenta la
 * ronda ANTES de llamar y las lee la consola: una sola definición, para que no
 * lean una y escriban otra.
 */
export const diaDelCupoAgentes = (ahora: number): string =>
  new Date(ahora).toISOString().slice(0, 10);
export const claveCupoAgente = (agentId: string, dia: string): string =>
  `ai:quota-desk:agent:${agentId}:${dia}`;
export const claveCupoGlobalAgentes = (dia: string): string => `ai:quota-desk:global:${dia}`;

/**
 * Los interruptores de los agentes (spec 074, R-27): los del servidor, que se
 * leen del entorno, y el global de entradas, que vive en Redis y se cambia
 * desde la consola.
 *
 * El global corta las ENTRADAS de todos los agentes a la vez. El seguimiento
 * de lo abierto no lo mira: reducir el riesgo nunca se corta. Con Redis caído
 * se da por cerrado, como el del canal: al otro lado hay dinero.
 */
@Injectable()
export class AiDeskInterruptoresService {
  constructor(
    private readonly cache: CacheService,
    private readonly cfg: AiDeskConfig,
    private readonly modelo: OpenRouterClient,
  ) {}

  /** `true` abiertas, `false` cortadas, `null` si Redis no contesta. */
  async entradasAbiertas(): Promise<boolean | null> {
    try {
      return !interruptorCerrado(await this.cache.getTextoOrThrow(CLAVE_INTERRUPTOR_AGENTES));
    } catch {
      return null;
    }
  }

  async interruptores(): Promise<InterruptoresAgentes> {
    const abiertas = await this.entradasAbiertas();
    // El motivo lo escribe `set`, en JSON. Cortadas a mano en Redis, sin motivo.
    const guardado =
      abiertas === false ? await this.cache.get<unknown>(CLAVE_MOTIVO_INTERRUPTOR_AGENTES) : null;
    const motivoEntradas = typeof guardado === 'string' ? guardado : null;
    let llamadasGlobalesHoy: number | null;
    try {
      const n = Number(
        await this.cache.getTextoOrThrow(claveCupoGlobalAgentes(diaDelCupoAgentes(Date.now()))),
      );
      llamadasGlobalesHoy = Number.isInteger(n) && n > 0 ? n : 0;
    } catch {
      llamadasGlobalesHoy = null;
    }
    return {
      encendido: this.cfg.encendido,
      modeloDisponible: this.modelo.agentesDisponible,
      modelo: this.modelo.agentesModelo,
      entradas: abiertas === null ? 'DESCONOCIDO' : abiertas ? 'ABIERTAS' : 'CERRADAS',
      motivoEntradas,
      frenos: this.cfg.frenos,
      limiteAgente: this.cfg.limiteAgente,
      limiteGlobal: this.cfg.limiteGlobal,
      llamadasGlobalesHoy,
    };
  }

  /**
   * Abre o corta las entradas de todos los agentes. Se comprueba leyendo lo
   * escrito: la caché calla sus fallos, y la consola no puede decir «cortadas»
   * si no lo están.
   */
  async fijarEntradas(abiertas: boolean, motivo: string): Promise<InterruptoresAgentes> {
    if (abiertas) {
      await this.cache.del([CLAVE_INTERRUPTOR_AGENTES, CLAVE_MOTIVO_INTERRUPTOR_AGENTES]);
    } else {
      await this.cache.set(CLAVE_INTERRUPTOR_AGENTES, 'off');
      await this.cache.set(CLAVE_MOTIVO_INTERRUPTOR_AGENTES, motivo);
    }
    const ahora = await this.entradasAbiertas();
    if (ahora === null) {
      throw new ServiceUnavailableException(
        'Redis no responde: el interruptor de las entradas no se ha podido cambiar.',
      );
    }
    if (ahora !== abiertas) {
      throw new ServiceUnavailableException(
        'El interruptor de las entradas no ha quedado como se pidió. Inténtalo de nuevo.',
      );
    }
    return this.interruptores();
  }
}
