import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../libs';

/**
 * El id del comando viaja dentro del payload: el acuse del worker (por ejemplo
 * `MARGIN_ADJUSTED`) lo lleva y así la API sabe a qué petición corresponde.
 */
/**
 * Comandos que mueven dinero sin un id propio que los haga idempotentes. El
 * resto se autoprotege: una orden repetida choca con su `clientOrderId` en la
 * base. Un ajuste de margen no tiene nada de eso, así que se marca ejecutado
 * ANTES de tocar el venue y se ejecuta como mucho una vez (001/F-08).
 */
const UNA_SOLA_VEZ = new Set(['ADJUST_MARGIN']);

function conId(payload: unknown, id: bigint): unknown {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return { ...(payload as Record<string, unknown>), commandId: id.toString() };
  }
  return payload;
}

/** Comando pendiente, ya reclamado por este proceso. */
export interface ClaimedCommand {
  id: bigint;
  botId: string;
  userId: string;
  command: string;
  /** Argumentos, para los pocos comandos que los llevan (`ADJUST_MARGIN`). */
  payload: unknown;
}

/**
 * Bandeja duradera de comandos de la API hacia el motor.
 *
 * El bus de Redis es pub/sub: entrega a quien esté escuchando en ese instante y
 * no deja rastro. Si el worker dueño del bot estaba reiniciándose, reconectando
 * a Redis, o el bot todavía no había sido adoptado, el comando se perdía EN
 * SILENCIO — y la API ya había respondido `accepted`. Para un PAUSE es molesto;
 * para un PANIC, con dinero abierto en el venue, es inaceptable.
 *
 * Ahora la fila de `bot_commands` es la verdad y el mensaje del bus solo acelera
 * la entrega. Si el aviso se pierde, el runner encuentra el comando en su
 * siguiente tick.
 */
@Injectable()
export class CommandInbox {
  private readonly logger = new Logger(CommandInbox.name);

  constructor(private readonly db: DbService) {}

  /**
   * Reclama los comandos pendientes de TODOS los bots dados, en una consulta.
   *
   * Una consulta y no una por bot: el barrido pregunta por sus doscientos
   * runners cada cinco segundos, y en el caso normal —cola vacía— eso eran
   * doscientas consultas para no encontrar nada. Así es una, contra el índice
   * parcial de pendientes.
   *
   * El paso de `claimed_at` de null a no-null se hace con un update
   * CONDICIONAL, y eso es lo que impide que dos entregas del mismo comando —el
   * aviso del bus y el barrido del tick, que llegan casi a la vez— lo ejecuten
   * dos veces. Quien pierde la carrera se lleva 0 filas y no hace nada.
   */
  async claimForBots(botIds: string[], workerId: string): Promise<Map<string, ClaimedCommand[]>> {
    const result = new Map<string, ClaimedCommand[]>();
    if (botIds.length === 0) return result;

    const pending = await this.db.botCommand.findMany({
      where: { bot_id: { in: botIds }, executed_at: null, claimed_at: null },
      orderBy: { id: 'asc' },
      // El dueño viaja con el comando: si su ejecución falla hay que poder
      // avisarle, y un aviso sin destinatario no llega a ninguna parte.
      select: {
        id: true,
        bot_id: true,
        command: true,
        payload: true,
        bot: { select: { user_id: true } },
      },
      take: 100,
    });

    for (const row of pending) {
      const { count } = await this.db.botCommand.updateMany({
        where: { id: row.id, claimed_at: null },
        data: { claimed_at: new Date(), claimed_by: workerId },
      });
      if (count !== 1) continue;
      const list = result.get(row.bot_id) ?? [];
      list.push({
        id: row.id,
        botId: row.bot_id,
        userId: row.bot.user_id,
        command: row.command,
        payload: conId(row.payload, row.id),
      });
      result.set(row.bot_id, list);
    }
    return result;
  }

  /**
   * Ejecuta un comando reclamado y lo cierra. Los que mueven dinero se cierran
   * ANTES de correr: si el proceso muriera con la transferencia hecha y el
   * comando aún abierto, quien adoptara el bot la repetiría. Si falla, queda
   * cerrado con el motivo y el fallo se propaga para que el llamante avise.
   */
  async execute(cmd: ClaimedCommand, run: () => Promise<void>): Promise<void> {
    const unaVez = UNA_SOLA_VEZ.has(cmd.command);
    if (unaVez) await this.markExecuted(cmd.id);
    try {
      await run();
    } catch (e) {
      await this.markFailed(cmd.id, (e as Error).message);
      throw e;
    }
    if (!unaVez) await this.markExecuted(cmd.id);
  }

  async markExecuted(id: bigint): Promise<void> {
    await this.db.botCommand
      .update({ where: { id }, data: { executed_at: new Date(), error: null } })
      .catch((e) =>
        this.logger.warn(`No se pudo cerrar el comando ${id}: ${(e as Error).message}`),
      );
  }

  /**
   * Un comando que falla se cierra igualmente, con el motivo.
   *
   * Dejarlo abierto lo haría reintentable para siempre: un STOP_AND_CLOSE que
   * falla porque el venue no responde volvería a intentar cerrar la posición en
   * cada tick, indefinidamente y sin que nadie lo hubiera vuelto a pedir.
   */
  async markFailed(id: bigint, error: string): Promise<void> {
    await this.db.botCommand
      .update({ where: { id }, data: { executed_at: new Date(), error } })
      // Se dice: un comando que no se pudo cerrar volverá a ejecutarse, y hay
      // que poder saber por qué (001/F-18).
      .catch((e: Error) => this.logger.warn(`No se pudo marcar fallido ${id}: ${e.message}`));
  }

  /**
   * Devuelve al estado pendiente los comandos que este worker reclamó y no
   * llegó a ejecutar. Se llama al soltar un bot: si no, el comando quedaría
   * reclamado por un proceso que ya no lo tiene y nadie lo ejecutaría jamás.
   */
  async releaseUnexecuted(botId: string, workerId: string): Promise<void> {
    await this.db.botCommand
      .updateMany({
        where: { bot_id: botId, claimed_by: workerId, executed_at: null },
        data: { claimed_at: null, claimed_by: null },
      })
      .catch((e: Error) =>
        this.logger.warn(`No se pudieron devolver los comandos de ${botId}: ${e.message}`),
      );
  }

  /**
   * Comandos reclamados hace demasiado y nunca ejecutados: el worker que los
   * cogió murió entre reclamar y ejecutar. Se liberan para que otro los recoja.
   *
   * Salvo que el worker que lo reclamó siga teniendo el lease del bot: entonces
   * no está muerto, está ejecutándolo (un venue lento, un enfriamiento de
   * 60-120 s), y devolverlo a la cola lo ejecutaría dos veces (001/F-08).
   * `holderOf` responde quién tiene hoy el lease; si no responde, este barrido
   * no recupera nada y el siguiente lo vuelve a intentar.
   */
  async recoverStale(
    olderThanMs: number,
    holderOf: (botId: string) => Promise<string | null>,
  ): Promise<number> {
    const stale = await this.db.botCommand.findMany({
      where: { executed_at: null, claimed_at: { lt: new Date(Date.now() - olderThanMs) } },
      select: { id: true, bot_id: true, claimed_by: true },
    });
    let count = 0;
    for (const row of stale) {
      const holder = await holderOf(row.bot_id);
      if (holder && holder === row.claimed_by) continue;
      const r = await this.db.botCommand.updateMany({
        where: { id: row.id, executed_at: null },
        data: { claimed_at: null, claimed_by: null },
      });
      count += r.count;
    }
    if (count > 0) this.logger.warn(`${count} comando(s) huérfano(s) devueltos a la cola.`);
    return count;
  }
}
