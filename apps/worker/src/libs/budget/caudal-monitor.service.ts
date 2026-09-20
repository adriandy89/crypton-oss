import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { consumirVentana } from '@crypton/exchange-core';

/** Cada cuánto se mira lo acumulado. */
const VENTANA_MS = 60_000;

/** Un aviso por clave cada cuarto de hora; el resto va al log de depuración. */
const ENFRIAMIENTO_MS = 15 * 60_000;

/**
 * Vigilante del caudal (spec 065).
 *
 * El presupuesto duerme en vez de fallar, que es lo correcto, pero eso deja una
 * degradación que no se ve: el tick no falla, el cortacircuitos no salta y el
 * bot aparece «operando» con el latido estirado. La única señal era `TICK_SLOW`,
 * que llega cuando el usuario YA ha perdido el ritmo.
 *
 * Esto mira lo acumulado cada minuto y avisa ANTES. No manda nada a Telegram a
 * propósito: es un problema de la instalación —demasiados bots para el cupo de
 * esa IP—, no de un bot concreto, y el dueño de un bot no podría hacer nada.
 */
@Injectable()
export class CaudalMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CaudalMonitorService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly avisadoHasta = new Map<string, number>();

  onModuleInit(): void {
    this.timer = setInterval(() => this.revisar(), VENTANA_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Mira lo ocurrido desde la última vez. Pública para el test. */
  revisar(): void {
    const lineas = consumirVentana();
    const ahora = Date.now();

    for (const { clave, texto, duele } of lineas) {
      if (!duele || ahora < (this.avisadoHasta.get(clave) ?? 0)) {
        this.logger.debug(texto);
        continue;
      }
      this.avisadoHasta.set(clave, ahora + ENFRIAMIENTO_MS);
      this.logger.warn(
        `${texto} El cupo de ese venue se cuenta por IP y lo comparten todos los procesos que ` +
          'salen por ella: o sobran bots para ese cupo, o alguien está pidiendo de más.',
      );
    }
  }
}
