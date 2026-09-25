import { Injectable, Logger } from '@nestjs/common';
import { D, EventSeverity, EventoAgente, MotivoRonda, type LimitesAgente } from '@crypton/shared';
import { CacheService, DbService } from 'src/libs';
import { AiDeskConfig } from './ai-desk.config';
import { AiDeskAvisosService } from './avisos.service';
import {
  claveCupoAgente,
  claveCupoGlobalAgentes,
  diaDelCupoAgentes,
} from './interruptores.service';

/** Fallos seguidos del modelo antes de dormir las consultas del agente (R-16). */
export const TOPE_FALLOS_AGENTE = 5;
export const PAUSA_FALLOS_AGENTE_MS = 6 * 3_600_000;
const DIA_MS = 86_400_000;

/** Lo que el consumo mira de un agente. */
export interface AgenteConsumo {
  id: string;
  user_id: string;
  usage_day: Date | null;
  cost_today: { toString(): string };
}

/**
 * Lo que gasta un agente en el modelo (spec 074): el cupo, contado ANTES de
 * llamar, y la llamada anotada después, con su coste y la racha de fallos. Lo
 * comparten la ronda de entrada y la de seguimiento: las dos gastan del mismo
 * cupo y cuentan en la misma racha.
 */
@Injectable()
export class AiDeskConsumoService {
  private readonly logger = new Logger(AiDeskConsumoService.name);

  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly cfg: AiDeskConfig,
    private readonly avisos: AiDeskAvisosService,
  ) {}

  /**
   * ¿Cabe otra llamada? null si cabe, o por qué no. Se cuenta ANTES de llamar:
   * contando solo los aciertos, varias rondas a la vez pasarían todas antes de
   * que terminara ninguna. Primero el gasto del día del agente, luego su cupo
   * —el menor entre el suyo y el del servidor— y por último el global. Sin
   * Redis no hay contador, y sin contador no se llama.
   */
  async cupo(
    agente: AgenteConsumo,
    limites: LimitesAgente,
    ahora: number,
  ): Promise<MotivoRonda | null> {
    const deHoy = agente.usage_day?.getTime() === Math.floor(ahora / DIA_MS) * DIA_MS;
    const gastado = deHoy ? D(agente.cost_today.toString()) : D(0);
    if (gastado.gte(limites.gastoDiaUsd)) return MotivoRonda.GASTO;
    const dia = diaDelCupoAgentes(ahora);
    const tope = Math.min(limites.consultasDia, this.cfg.limiteAgente);
    const suyas = await this.cache
      .incrWithExpire(claveCupoAgente(agente.id, dia), 86_400)
      .catch(() => -1);
    if (suyas < 0) return MotivoRonda.REDIS;
    if (suyas > tope) return MotivoRonda.CUPO_AGENTE;
    const global = await this.cache
      .incrWithExpire(claveCupoGlobalAgentes(dia), 86_400)
      .catch(() => -1);
    if (global < 0) return MotivoRonda.REDIS;
    if (global > this.cfg.limiteGlobal) {
      this.logger.warn('Cupo diario global de los agentes agotado.');
      return MotivoRonda.CUPO_GLOBAL;
    }
    return null;
  }

  /**
   * La llamada en el uso del día y la racha de fallos. A los cinco seguidos el
   * agente deja de consultar seis horas, con un solo aviso (R-16).
   */
  async anotar(
    agente: AgenteConsumo,
    coste: string | null,
    fallo: string | null,
    ahora: number,
  ): Promise<void> {
    const dia = new Date(Math.floor(ahora / DIA_MS) * DIA_MS);
    const importe = coste ?? '0';
    const uso =
      agente.usage_day?.getTime() === dia.getTime()
        ? { calls_today: { increment: 1 }, cost_today: { increment: importe } }
        : { usage_day: dia, calls_today: 1, cost_today: importe };
    const racha = fallo ? { failures: { increment: 1 }, last_error: fallo } : { failures: 0 };
    const fila = await this.db.aiDeskAgent.update({
      where: { id: agente.id },
      data: { ...uso, ...racha },
      select: { failures: true },
    });
    if (fallo && fila.failures === TOPE_FALLOS_AGENTE) {
      await this.db.aiDeskAgent.update({
        where: { id: agente.id },
        data: { sleeping_until: new Date(ahora + PAUSA_FALLOS_AGENTE_MS), failures: 0 },
      });
      await this.avisos.agente(
        agente.user_id,
        EventoAgente.DORMIDO,
        EventSeverity.WARN,
        'La IA del agente falla repetidamente: no consultará durante 6 h. Lo abierto sigue con ' +
          'su stop y sus objetivos.',
        { agentId: agente.id },
      );
    }
  }
}
