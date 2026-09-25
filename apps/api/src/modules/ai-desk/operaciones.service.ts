import { Injectable, Logger } from '@nestjs/common';
import { EstadoAccionAgente, EstadoPropuestaAgente, planAgenteDe } from '@crypton/shared';
import { DbService } from 'src/libs';
import { conciliacion, type CicloOperacion } from './conciliacion';

/** Las operaciones que se concilian en cada vuelta, como mucho. */
const LOTE = 200;

const EN_CURSO = [EstadoPropuestaAgente.EJECUTANDO, EstadoPropuestaAgente.ABIERTA];

/**
 * Las operaciones de los agentes, al día con sus bots (spec 074, R-21).
 *
 * La conciliación corre por reloj y cuando el worker avisa de algo del bot
 * —la entrada, la salida, la parada—: el aviso solo adelanta, porque pub/sub
 * no garantiza la entrega, y el reloj recoge lo que se pierda.
 *
 * Solo lee bots y escribe propuestas, y siempre con el estado que leyó en el
 * `where`: dos réplicas conciliando a la vez escriben una vez.
 */
@Injectable()
export class AiDeskOperacionesService {
  private readonly logger = new Logger(AiDeskOperacionesService.name);

  constructor(private readonly db: DbService) {}

  /** Concilia lo que está en curso, o solo la operación de un bot. Devuelve cuántas cambiaron. */
  async conciliar(ahora: number, soloBot: string | null = null): Promise<number> {
    const filas = await this.db.aiDeskProposal.findMany({
      where: {
        state: { in: EN_CURSO },
        ...(soloBot ? { bot_id: soloBot } : {}),
      },
      orderBy: { updated_at: 'asc' },
      take: LOTE,
      select: {
        id: true,
        state: true,
        opened_at: true,
        plan: true,
        final_plan: true,
        bot_id: true,
        bot: {
          select: {
            status: true,
            cycles: {
              where: { seq: 1 },
              select: {
                entries_filled: true,
                qty: true,
                realized_pnl: true,
                opened_at: true,
                last_entry_at: true,
                closed_at: true,
              },
            },
          },
        },
      },
    });
    let cambiadas = 0;
    for (const f of filas) {
      try {
        const c = f.bot?.cycles[0];
        const ciclo: CicloOperacion | null = c
          ? {
              entries_filled: c.entries_filled,
              qty: c.qty.toString(),
              realized_pnl: c.realized_pnl.toString(),
              opened_at: c.opened_at,
              last_entry_at: c.last_entry_at,
              closed_at: c.closed_at,
            }
          : null;
        const motivoSalida =
          ciclo?.closed_at && f.bot_id ? await this.motivoSalida(f.bot_id) : null;
        const cambio = conciliacion(
          {
            state: f.state,
            opened_at: f.opened_at,
            riesgo: (planAgenteDe(f.final_plan) ?? planAgenteDe(f.plan))?.riesgo ?? null,
          },
          { estado: f.bot?.status ?? null, ciclo, motivoSalida },
          new Date(ahora),
        );
        if (!cambio) continue;
        const r = await this.db.aiDeskProposal.updateMany({
          where: { id: f.id, state: f.state },
          data: cambio,
        });
        cambiadas += r.count;
        // Una operación terminada ya no tiene nada que decidir: lo que esperaba
        // respuesta del seguimiento deja de esperarla.
        if (r.count === 1 && cambio.state !== EstadoPropuestaAgente.ABIERTA) {
          await this.db.aiDeskAction.updateMany({
            where: { proposal_id: f.id, state: EstadoAccionAgente.PROPUESTA },
            data: { state: EstadoAccionAgente.DESCARTADA, reason: 'CERRADA' },
          });
        }
      } catch (e) {
        // Una operación que no se puede conciliar no para a las demás.
        this.logger.warn(`La operación ${f.id} no se ha podido conciliar: ${(e as Error).message}`);
      }
    }
    return cambiadas;
  }

  /** Cómo salió, según el aviso `AGENT_EXIT` del bot. */
  private async motivoSalida(botId: string): Promise<string | null> {
    const e = await this.db.botEvent.findFirst({
      where: { bot_id: botId, type: 'AGENT_EXIT' },
      orderBy: { created_at: 'desc' },
      select: { payload: true },
    });
    // Frontera Prisma-JSON: el payload lo escribe el worker; se mira su forma aquí.
    const motivo = (e?.payload as { motivo?: unknown } | null | undefined)?.motivo;
    return typeof motivo === 'string' ? motivo : null;
  }
}
