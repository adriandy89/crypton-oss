import { Injectable } from '@nestjs/common';
import type { Prisma } from '@crypton/db';
import { DbService, PageDto, PageMetaDto } from 'src/libs';
import type { ActivityQueryDto } from './dtos';

/** Lectura de la bitácora. Solo lee: quien escribe es `AuditService`. */
@Injectable()
export class ActivityService {
  constructor(private readonly db: DbService) {}

  async list(query: ActivityQueryDto): Promise<PageDto<unknown>> {
    const where = this.buildWhere(query);
    const skip = (query.page - 1) * query.limit;

    // Las dos consultas a la vez: el recuento no depende del listado.
    const [rows, itemCount] = await Promise.all([
      this.db.activityLog.findMany({
        where,
        // `SortOrderEnum` ya vale 'asc' | 'desc': se pasa tal cual.
        orderBy: { created_at: query.sortOrder },
        take: query.limit,
        skip,
      }),
      this.db.activityLog.count({ where }),
    ]);

    return new PageDto(
      rows.map((r) => this.toPublic(r)),
      new PageMetaDto({ pageOptions: query, itemCount }),
    );
  }

  /** Las acciones más frecuentes de una ventana. El resumen de «qué está pasando». */
  async summary(hours: number): Promise<{ action: string; outcome: string; count: number }[]> {
    const since = new Date(Date.now() - hours * 3_600_000);
    const grouped = await this.db.activityLog.groupBy({
      by: ['action', 'outcome'],
      where: { created_at: { gte: since } },
      _count: { _all: true },
      orderBy: { _count: { action: 'desc' } },
      take: 50,
    });
    return grouped.map((g) => ({
      action: g.action,
      outcome: g.outcome,
      count: g._count._all,
    }));
  }

  private buildWhere(query: ActivityQueryDto): Prisma.ActivityLogWhereInput {
    const where: Prisma.ActivityLogWhereInput = {};

    if (query.actorId) where.actor_id = query.actorId;
    if (query.actor) where.actor = query.actor;
    if (query.botId) where.bot_id = query.botId;
    // Prefijo, no igualdad: `bot.` trae todas las acciones de bots.
    if (query.action) where.action = { startsWith: query.action };
    if (query.severity) where.severity = query.severity;
    if (query.outcome) where.outcome = query.outcome;
    // Gana sobre `outcome`: es el atajo explícito a «enséñame lo que falla».
    if (query.onlyFailures === 'true') where.outcome = { not: 'OK' };

    if (query.from || query.to) {
      where.created_at = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }
    return where;
  }

  /**
   * Proyección de salida.
   *
   * El tipo del parámetro enumera lo que sale, igual que `toPublic()` en
   * exchange-accounts: añadir mañana una columna a la tabla no puede filtrarla
   * por descuido. Y `id` se pasa a string aquí y no se confía al serializador:
   * es un `BigInt` y su valor no cabe en un `number` de JavaScript.
   */
  private toPublic(row: {
    id: bigint;
    actor: string;
    actor_id: string | null;
    bot_id: string | null;
    action: string;
    severity: string;
    outcome: string;
    message: string | null;
    route: string | null;
    method: string | null;
    status_code: number | null;
    duration_ms: number | null;
    ip: string | null;
    request_id: string | null;
    meta: unknown;
    created_at: Date;
  }) {
    return {
      id: row.id.toString(),
      actor: row.actor,
      actorId: row.actor_id,
      botId: row.bot_id,
      action: row.action,
      severity: row.severity,
      outcome: row.outcome,
      message: row.message,
      route: row.route,
      method: row.method,
      statusCode: row.status_code,
      durationMs: row.duration_ms,
      ip: row.ip,
      requestId: row.request_id,
      meta: row.meta,
      createdAt: row.created_at,
    };
  }
}
