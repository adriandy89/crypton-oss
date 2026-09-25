import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FrenosAgentes } from '@crypton/shared';

/**
 * Las variables `AI_DESK_*` de los agentes de IA (spec 074), leídas en un solo
 * sitio. `apps/api/.env.example` explica cada una.
 *
 * Se leen en cada acceso y no una vez al arrancar: son baratas, y así un test
 * —o una réplica con otro entorno— ve lo que hay. Un número fuera de su rango
 * se recorta al rango, y uno que no se entiende deja el de fábrica: una
 * variable mal escrita no puede apagar un tope ni abrir uno.
 */
@Injectable()
export class AiDeskConfig {
  constructor(private readonly config: ConfigService) {}

  private num(nombre: string, defecto: number, min: number, max: number): number {
    const v = Number(this.config.get<string>(nombre, String(defecto)));
    return Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : defecto;
  }

  /**
   * El módulo entero en este servidor. Apagado no corre ninguna ronda —ni de IA
   * ni de reglas—, no se aprueba nada y no hay seguimiento. Lo abierto sigue con
   * su stop y sus objetivos en el exchange.
   *
   * Cada variable se lee con su nombre escrito entero dentro de `config.get` o
   * de `this.num`, sin construirlo: es lo que busca `pnpm check:env` para saber
   * qué se lee.
   */
  get encendido(): boolean {
    return this.config.get<string>('AI_DESK_ENABLE', 'false') === 'true';
  }

  /**
   * Los frenos, apagados de fábrica por decisión del usuario. Se leen juntos
   * porque `efectoDe` los mira juntos.
   */
  get frenos(): FrenosAgentes {
    return {
      forzarManual: this.config.get<string>('AI_DESK_FORCE_MANUAL', 'false') === 'true',
      soloSimulacion: this.config.get<string>('AI_DESK_DRY_RUN_ONLY', 'false') === 'true',
      soloSombra: this.config.get<string>('AI_DESK_SHADOW_ONLY', 'false') === 'true',
    };
  }

  /** Consultas al día por agente: manda el menor entre esto y las de sus límites. */
  get limiteAgente(): number {
    return this.num('AI_DESK_DAILY_LIMIT', 200, 1, 10_000);
  }

  get limiteGlobal(): number {
    return this.num('AI_DESK_GLOBAL_DAILY_LIMIT', 600, 1, 1_000_000);
  }

  /** Consultas a la vez en esta réplica. */
  get concurrencia(): number {
    return this.num('AI_DESK_CONCURRENCY', 2, 1, 16);
  }

  /** Agentes que mira cada barrido. */
  get barridoMax(): number {
    return this.num('AI_DESK_SWEEP_MAX', 5, 1, 100);
  }

  /** El plazo de una llamada, con el tope de 25 s del transporte. */
  get plazoLlamadaMs(): number {
    return this.num('AI_DESK_TIMEOUT_MS', 20_000, 1_000, 25_000);
  }

  /** Lo que vive una propuesta de entrada sin respuesta, en minutos. */
  get vidaPropuestaMin(): number {
    return this.num('AI_DESK_PROPOSAL_TTL_MIN', 15, 1, 240);
  }

  /** Lo que vive una acción de seguimiento propuesta, en minutos. */
  get vidaAccionMin(): number {
    return this.num('AI_DESK_ACTION_TTL_MIN', 30, 1, 1_440);
  }

  /** Los pares de un agente, como mucho. */
  get maxPares(): number {
    return this.num('AI_DESK_MAX_WATCHLIST', 12, 1, 50);
  }
}
