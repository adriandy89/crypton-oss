import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import {
  EstadoAgente,
  EstadoPropuestaAgente,
  EventoOperacionAgente,
  PULSACION_AGENTE,
  TipoRondaAgente,
  esValeAgente,
  proximaRondaAgente,
  type DisparadorSeguimiento,
  type IntervaloAgente,
  type VerboAgente,
} from '@crypton/shared';
import { leerOperacionAgente, ultimaCerradaEsperada } from '@crypton/strategy-core';
import { BUS_CHANNELS, BusService, CacheService, DbService, type BusMessage } from 'src/libs';
import { AiDeskConfig } from './ai-desk.config';
import { DUENO_DE_AGENTES } from './agentes.service';
import { AiDeskAprobacionService } from './aprobacion.service';
import { AiDeskAvisosService } from './avisos.service';
import { AiDeskLecturaService } from './lectura.service';
import { AiDeskMedicionService } from './medicion.service';
import { AiDeskOperacionesService } from './operaciones.service';
import { AiDeskRondasService } from './rondas.service';
import { AiDeskSeguimientoService } from './seguimiento.service';

/**
 * Los avisos del worker que mueven una operación de un agente: su entrada, su
 * salida y la parada de su bot. Solo adelantan la conciliación, que también
 * corre por reloj.
 */
const MUEVEN_OPERACION: ReadonlySet<string> = new Set([
  EventoOperacionAgente.ENTRADA,
  EventoOperacionAgente.SALIDA,
  'BOT_STOPPED',
  'LIQUIDATED',
]);

const VERBOS: readonly string[] = ['si', 'no', 'cierra'];

/**
 * El reloj y el bus de los agentes de IA (spec 074).
 *
 * Cada `@Cron` dispara en TODAS las réplicas, así que cada uno va detrás de un
 * cerrojo, como los del canal. Y lo que llega por el bus lo reciben todas: la
 * puerta es siempre una escritura condicional —el reclamo de la aprobación, el
 * `GETDEL` del vale, el estado leído en el `where` de la conciliación—, así que
 * una sola lo hace.
 *
 * Lo que caduca y lo que se concilia corre aunque los agentes estén apagados en
 * el servidor: apagarlos no puede dejar propuestas esperando para siempre ni
 * operaciones sin su resultado. Y los botones se atienden igual: con el módulo
 * apagado, aprobar responde que está apagado, pero descartar funciona.
 */
@Injectable()
export class AiDeskScheduler implements OnModuleInit {
  private readonly logger = new Logger(AiDeskScheduler.name);

  constructor(
    private readonly bus: BusService,
    private readonly cache: CacheService,
    private readonly db: DbService,
    private readonly cfg: AiDeskConfig,
    private readonly lectura: AiDeskLecturaService,
    private readonly rondas: AiDeskRondasService,
    private readonly seguimiento: AiDeskSeguimientoService,
    private readonly aprobacion: AiDeskAprobacionService,
    private readonly operaciones: AiDeskOperacionesService,
    private readonly avisos: AiDeskAvisosService,
    private readonly medicion: AiDeskMedicionService,
  ) {}

  async onModuleInit(): Promise<void> {
    const eventos$ = await this.bus.listen(BUS_CHANNELS.BOT_EVENTS);
    eventos$.subscribe((mensaje) => {
      if (mensaje.type === PULSACION_AGENTE) {
        // Con `catch`: esto consulta la base, y una promesa sin manejar tumba el
        // proceso entero en Node (001/F-07).
        void this.onPulsacion(mensaje).catch((e: Error) =>
          this.logger.warn(`Botón de un agente sin atender: ${e.message}`),
        );
        return;
      }
      if (mensaje.botId && MUEVEN_OPERACION.has(mensaje.type)) {
        const botId = mensaje.botId;
        void this.operaciones
          .conciliar(Date.now(), botId)
          .catch((e: Error) =>
            this.logger.warn(`Operación de ${botId} sin conciliar: ${e.message}`),
          );
      }
    });
    this.logger.log('Agentes de IA escuchando');
  }

  /**
   * Alguien ha pulsado un botón de un aviso de agente. El poller del worker
   * solo hace de mensajero; el vale se canjea aquí, una vez.
   */
  async onPulsacion(mensaje: BusMessage): Promise<void> {
    const datos = mensaje.data as { vale?: unknown; verbo?: unknown } | null;
    const vale = datos?.vale;
    const verbo = datos?.verbo;
    if (!mensaje.userId || !esValeAgente(vale) || typeof verbo !== 'string') return;
    if (!VERBOS.includes(verbo)) return;
    const canjeado = await this.avisos.canjear(vale);
    if (!canjeado) return;
    // El vale dice de qué es: una propuesta de entrada o una acción de seguimiento.
    const deEntrada = await this.aprobacion.pulsacion(
      mensaje.userId,
      canjeado,
      verbo as VerboAgente,
    );
    if (!deEntrada) {
      await this.seguimiento.pulsacion(mensaje.userId, canjeado, verbo as VerboAgente);
    }
  }

  /**
   * El barrido de las rondas, cada 30 s y en TODAS las réplicas, sin cerrojo:
   * cada agente se reclama con una escritura condicional sobre su próxima
   * ronda, así que dos réplicas nunca lanzan el mismo, y cada una llena sus
   * propios huecos. Primero declara los pares de los agentes activos en el
   * flujo de precios —cada réplica anuncia lo suyo—, para que el worker tenga
   * sus tickers vivos cuando lleguen las rondas.
   *
   * Con el módulo apagado no corre nada, y se suelta el interés.
   */
  @Interval(30_000)
  async barrer(): Promise<void> {
    if (!this.cfg.encendido) {
      this.lectura.declararInteres([]);
      return;
    }
    const ahora = Date.now();
    const activos = await this.db.aiDeskAgent.findMany({
      where: { state: EstadoAgente.ACTIVO },
      select: { venue: true, symbols: true, exchange_account: { select: { testnet: true } } },
    });
    this.lectura.declararInteres(activos);

    const huecos = Math.min(this.rondas.huecos, this.cfg.barridoMax);
    if (huecos === 0) return;
    // Con el mismo filtro del dueño que la ronda: al que le quitaron el rol
    // no se le lanza nada, ni se le gasta una lectura del mercado.
    const debidos = await this.db.aiDeskAgent.findMany({
      where: {
        state: EstadoAgente.ACTIVO,
        next_round_at: { lte: new Date(ahora) },
        user: { role: DUENO_DE_AGENTES.role, disabled: DUENO_DE_AGENTES.disabled },
      },
      orderBy: { next_round_at: 'asc' },
      take: huecos,
      select: { id: true, interval: true, next_round_at: true },
    });
    for (const a of debidos) {
      const reclamado = await this.db.aiDeskAgent.updateMany({
        where: { id: a.id, next_round_at: a.next_round_at },
        data: {
          // Frontera Prisma: el intervalo se validó al guardar el agente.
          next_round_at: new Date(proximaRondaAgente(ahora, a.interval as IntervaloAgente)),
        },
      });
      if (reclamado.count !== 1) continue;
      void this.rondas
        .rondaEntrada(a.id, 'INTERVALO', ahora)
        .catch((e: Error) =>
          this.logger.warn(`Ronda del agente ${a.id} sin terminar: ${e.message}`),
        );
    }
    await this.barrerSeguimiento(ahora);
  }

  /**
   * El seguimiento de las operaciones abiertas: cada una al cerrar cada vela
   * de su agente, y al cobrar su primer objetivo (R-24). Con el agente en
   * pausa también: reducir el riesgo nunca se corta. Dos réplicas no repiten
   * una ronda: la de cada operación, vela y disparador es única.
   */
  private async barrerSeguimiento(ahora: number): Promise<void> {
    const huecos = Math.min(this.seguimiento.huecos, this.cfg.barridoMax);
    if (huecos === 0) return;
    const abiertas = await this.db.aiDeskProposal.findMany({
      where: {
        state: EstadoPropuestaAgente.ABIERTA,
        agent: {
          state: { not: EstadoAgente.ARCHIVADO },
          user: { role: DUENO_DE_AGENTES.role, disabled: DUENO_DE_AGENTES.disabled },
        },
      },
      select: {
        id: true,
        agent: { select: { interval: true } },
        bot: {
          select: {
            cycles: {
              where: { closed_at: null },
              orderBy: { seq: 'desc' },
              take: 1,
              select: { scratch: true },
            },
          },
        },
        followup_rounds: {
          where: { kind: TipoRondaAgente.SEGUIMIENTO },
          orderBy: { created_at: 'desc' },
          take: 1,
          select: { bar_t: true, trigger: true, snapshot: true },
        },
      },
    });
    let lanzadas = 0;
    for (const o of abiertas) {
      if (lanzadas >= huecos) break;
      // Frontera Prisma-JSON: el scratch lo escribe el motor; se lee con su lector.
      const scratch = (o.bot?.cycles[0]?.scratch ?? {}) as Record<string, unknown>;
      const disparador = disparadorSeguimiento(
        o.followup_rounds[0] ?? null,
        leerOperacionAgente(scratch['op'])?.tp1Hecho === true,
        // Frontera Prisma: el intervalo se validó al guardar el agente.
        ultimaCerradaEsperada(ahora, o.agent.interval as IntervaloAgente),
      );
      if (!disparador) continue;
      lanzadas++;
      void this.seguimiento
        .rondaSeguimiento(o.id, disparador, ahora)
        .catch((e: Error) => this.logger.warn(`Seguimiento de ${o.id} sin terminar: ${e.message}`));
    }
  }

  /** Caduca lo que nadie respondió a tiempo. */
  @Cron(CronExpression.EVERY_MINUTE)
  async caducar(): Promise<void> {
    if (!(await this.cache.setnx('lock:ai-desk-expire', Date.now(), 50).catch(() => false))) {
      return;
    }
    const ahora = Date.now();
    const n = (await this.aprobacion.caducar(ahora)) + (await this.seguimiento.caducar(ahora));
    if (n > 0) this.logger.debug(`${n} propuesta(s) o acción(es) de agentes caducadas.`);
  }

  /**
   * Recupera las aprobaciones colgadas y concilia las operaciones con sus bots.
   * En este orden: una aprobación recuperada con su bot en marcha pasa a
   * EJECUTANDO, y la conciliación ya la ve en la misma vuelta.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async mantener(): Promise<void> {
    if (!(await this.cache.setnx('lock:ai-desk-maintain', Date.now(), 50).catch(() => false))) {
      return;
    }
    const ahora = Date.now();
    const recuperadas = await this.aprobacion.recuperar(ahora);
    if (recuperadas > 0) this.logger.warn(`${recuperadas} aprobación(es) de agentes recuperadas.`);
    await this.operaciones.conciliar(ahora);
  }

  /**
   * Mide lo que ya se puede medir (R-25). A mitad de cada cuarto de hora y no
   * en punto: en punto cierran las velas y corren las rondas, que leen los
   * mismos pares con el mismo cupo por IP. El cerrojo dura más que una vuelta
   * larga y menos que el hueco hasta la siguiente.
   */
  @Cron('0 7,22,37,52 * * * *')
  async medir(): Promise<void> {
    if (!(await this.cache.setnx('lock:ai-desk-measure', Date.now(), 600).catch(() => false))) {
      return;
    }
    const n = await this.medicion.medir();
    if (n > 0) this.logger.debug(`${n} candidato(s) o propuesta(s) de agentes medidos.`);
  }
}

/** El primer objetivo según lo que vio una ronda de seguimiento: su `estado.tp1Hecho`. */
function tp1Visto(snapshot: unknown): boolean {
  if (typeof snapshot !== 'object' || snapshot === null) return false;
  const estado = (snapshot as { estado?: unknown }).estado;
  return (
    typeof estado === 'object' &&
    estado !== null &&
    (estado as { tp1Hecho?: unknown }).tp1Hecho === true
  );
}

/**
 * Qué despierta el seguimiento de una operación, o nada (R-24): el primer
 * objetivo cobrado desde la última ronda, o una vela cerrada que aún no tiene
 * la suya. Un primer objetivo ya atendido en esta vela no vuelve a disparar.
 */
export function disparadorSeguimiento(
  ultima: { bar_t: Date; trigger: string; snapshot: unknown } | null,
  tp1Ahora: boolean,
  barT: number,
): DisparadorSeguimiento | null {
  const mismaVela = ultima !== null && ultima.bar_t.getTime() === barT;
  if (tp1Ahora && !tp1Visto(ultima?.snapshot) && !(mismaVela && ultima.trigger === 'OBJETIVO_1')) {
    return 'OBJETIVO_1';
  }
  if (ultima === null || ultima.bar_t.getTime() < barT) return 'INTERVALO';
  return null;
}
