import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { BotStatus, Prisma, Role } from '@crypton/db';
import { DbService, PageDto, PageMetaDto } from 'src/libs';
import { TokenService } from '../auth';
import { SessionRevocationService } from '../auth/session-revocation.service';
import type { AdminExchangeAccountRow, AdminUserDetail, AdminUserRow } from './admin.types';
import type { AdminUsersQueryDto } from './dtos';

/** Los estados en los que el motor tiene el bot en la mano. */
const LIVE_STATUSES: BotStatus[] = [
  BotStatus.STARTING,
  BotStatus.RUNNING,
  BotStatus.PAUSED,
  BotStatus.STOPPING,
];

/** ISO 8601, o nada. Repetir el `?.toISOString() ?? null` en treinta campos invita a olvidarlo. */
const iso = (d: Date | null | undefined): string | null => d?.toISOString() ?? null;

/** Decimal → string. Nunca `number`: invariante 1. */
const dec = (v: { toFixed(): string } | null | undefined): string | null => v?.toFixed() ?? null;

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly db: DbService,
    private readonly tokens: TokenService,
    private readonly revocacion: SessionRevocationService,
  ) {}

  async list(query: AdminUsersQueryDto): Promise<PageDto<AdminUserRow>> {
    const where = this.buildWhere(query);
    const skip = (query.page - 1) * query.limit;

    const [rows, itemCount] = await Promise.all([
      this.db.user.findMany({
        where,
        orderBy: { [query.sortBy ?? 'created_at']: query.sortOrder },
        take: query.limit,
        skip,
        select: {
          ...USER_SELECT,
          // Los recuentos en la misma consulta: la alternativa es una consulta
          // por fila, que sobre una pagina de cien usuarios son cien viajes.
          _count: { select: { exchange_accounts: true, bots: true } },
          bots: { where: { status: { in: LIVE_STATUSES } }, select: { id: true } },
        },
      }),
      this.db.user.count({ where }),
    ]);

    return new PageDto(
      rows.map((r) => this.toRow(r)),
      new PageMetaDto({ pageOptions: query, itemCount }),
    );
  }

  async detail(id: string): Promise<AdminUserDetail> {
    const user = await this.db.user.findUnique({
      where: { id },
      select: {
        ...USER_SELECT,
        bio: true,
        timezone: true,
        display_currency: true,
        updated_at: true,
        _count: { select: { exchange_accounts: true, bots: true } },
        // El `select` de las cuentas es EXPLICITO y no incluye ni un campo del
        // sobre criptografico: asi el secreto no llega siquiera a entrar en el
        // proceso, y no depende de que el mapper de abajo se acuerde de omitirlo.
        exchange_accounts: {
          select: {
            id: true,
            venue: true,
            label: true,
            status: true,
            public_ref: true,
            testnet: true,
            paper: true,
            builder_approved: true,
            last_verified_at: true,
            agent_valid_until: true,
            last_error: true,
          },
          orderBy: { created_at: 'asc' },
        },
        bots: { select: { status: true } },
        risk_limit: true,
        // Ni `chat_id` ni `link_code`: ver la cabecera de `admin.types.ts`.
        telegram_link: { select: { verified_at: true } },
      },
    });
    if (!user) throw new NotFoundException('Usuario no encontrado.');

    const botsByStatus: Partial<Record<BotStatus, number>> = {};
    for (const b of user.bots) botsByStatus[b.status] = (botsByStatus[b.status] ?? 0) + 1;
    const rl = user.risk_limit;

    return {
      ...this.toRow({
        ...user,
        bots: user.bots.filter((b) => LIVE_STATUSES.includes(b.status)),
      }),
      bio: user.bio,
      timezone: user.timezone,
      displayCurrency: user.display_currency,
      updatedAt: iso(user.updated_at),
      riskLimits: rl
        ? {
            maxNotionalPerBot: dec(rl.max_notional_per_bot),
            maxTotalNotional: dec(rl.max_total_notional),
            maxLeverage: rl.max_leverage,
            maxOpenBots: rl.max_open_bots,
            maxDailyLoss: dec(rl.max_daily_loss),
            killSwitchDrawdownPct: dec(rl.kill_switch_drawdown_pct),
            liquidationAlertPct: dec(rl.liquidation_alert_pct),
          }
        : null,
      accounts: user.exchange_accounts.map((a) => this.toAccount(a)),
      botsByStatus,
      telegram: {
        linked: user.telegram_link?.verified_at != null,
        verifiedAt: iso(user.telegram_link?.verified_at),
      },
    };
  }

  /**
   * Deshabilita la cuenta y le corta la sesion.
   *
   * Orden deliberado: primero la base, despues el corte. Al reves, si el UPDATE
   * fallara, se habria echado a alguien que sigue habilitado —molesto pero
   * recuperable—; asi, si falla el corte, la bandera queda puesta y lo unico que
   * sobrevive es su token actual, durante minutos. Por eso se devuelve
   * `sesionCortada`: «deshabilitado, pero su sesion en curso aguanta un rato» es
   * una respuesta distinta de «hecho», y quien pulsa el boton tiene que saber
   * cual le ha tocado.
   *
   * Lo que esto NO hace es parar sus bots. El worker no consulta `disabled` y no
   * deberia: dejar posiciones abiertas sin motor porque un administrador cerro
   * la cuenta seria peor que la cuenta abierta. Contener bots es otra accion, y
   * la ficha lo dice con todas las letras para que nadie suponga lo contrario.
   */
  async disable(adminId: string, id: string) {
    const target = await this.mustExist(id);

    // Ya deshabilitada: se REINTENTA el corte en vez de devolver un «hecho» a
    // ciegas. Este camino es exactamente el que se recorre cuando el intento
    // anterior dejo la bandera puesta pero no pudo escribir la marca —Redis
    // caido—, y responder que la sesion esta cortada sin haberlo intentado
    // dejaria al intruso dentro con la bendicion de la pantalla.
    if (target.disabled) {
      const reintento = await this.tokens.revokeAll(id, 'cuenta_deshabilitada');
      return {
        id,
        disabled: true,
        sesionCortada: reintento.aplicada,
        accesoResidualHasta: reintento.aplicada ? null : reintento.vigenteHasta,
      };
    }

    // Cerrarse la puerta desde dentro se arregla con un psql en produccion.
    if (id === adminId) {
      throw new ConflictException('No puedes deshabilitar tu propia cuenta.');
    }
    if (target.role === Role.ADMIN) {
      const vivos = await this.db.user.count({ where: { role: Role.ADMIN, disabled: false } });
      if (vivos <= 1) {
        throw new ConflictException(
          'Es la unica cuenta de administracion activa: deshabilitarla dejaria la plataforma sin nadie que pueda entrar aqui.',
        );
      }
    }

    await this.db.user.update({ where: { id }, data: { disabled: true } });
    const corte = await this.tokens.revokeAll(id, 'cuenta_deshabilitada');

    return {
      id,
      disabled: true,
      sesionCortada: corte.aplicada,
      accesoResidualHasta: corte.aplicada ? null : corte.vigenteHasta,
    };
  }

  /**
   * Rehabilita la cuenta y LEVANTA la marca de revocacion.
   *
   * Sin el `clear`, el usuario recien rehabilitado no podria usar ni el token
   * que le acabase de dar el login: su `iat` seguiria siendo anterior a una
   * marca que sigue viva. Las familias de refresh no se restauran —no se puede,
   * y no se debe—: vuelve a entrar con Google, que es un clic.
   */
  async enable(id: string) {
    await this.mustExist(id);
    await this.db.user.update({ where: { id }, data: { disabled: false } });
    await this.revocacion.clear(id);
    return { id, disabled: false };
  }

  /** Le echa de todos sus dispositivos. Sobre uno mismo tambien vale: no hay nada que proteger. */
  async revokeSessions(id: string) {
    await this.mustExist(id);
    const corte = await this.tokens.revokeAll(id, 'sesiones_cerradas');
    return { id, sesionCortada: corte.aplicada };
  }

  private async mustExist(id: string) {
    const user = await this.db.user.findUnique({
      where: { id },
      select: { id: true, disabled: true, role: true },
    });
    if (!user) throw new NotFoundException('Usuario no encontrado.');
    return user;
  }

  private buildWhere(query: AdminUsersQueryDto): Prisma.UserWhereInput {
    const where: Prisma.UserWhereInput = {};

    if (query.q) {
      // Por PREFIJO: un `contains` genera `LIKE '%algo%'`, que no puede usar
      // ningun indice y ademas se ejecuta dos veces (las filas y el total).
      where.OR = [
        { email: { startsWith: query.q, mode: 'insensitive' } },
        { name: { startsWith: query.q, mode: 'insensitive' } },
      ];
    }
    if (query.role) where.role = query.role;
    if (query.disabled !== undefined) where.disabled = query.disabled;
    if (query.withBots !== undefined) {
      where.bots = query.withBots ? { some: {} } : { none: {} };
    }
    if (query.from || query.to) {
      where.created_at = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }
    return where;
  }

  /**
   * La fila publica de un usuario.
   *
   * El parametro enumera lo que ENTRA, igual que `toPublic` en
   * `exchange-accounts.service.ts`: si mañana se añade una columna sensible a
   * `users`, este mapper no la conoce y no puede publicarla por descuido.
   */
  private toRow(u: {
    id: string;
    email: string;
    name: string;
    role: Role;
    disabled: boolean;
    is_email_verified: boolean;
    country: string | null;
    language: string;
    created_at: Date;
    last_login_at: Date | null;
    _count: { exchange_accounts: number; bots: number };
    bots: unknown[];
  }): AdminUserRow {
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      disabled: u.disabled,
      emailVerified: u.is_email_verified,
      country: u.country,
      language: u.language,
      createdAt: u.created_at.toISOString(),
      lastLoginAt: iso(u.last_login_at),
      bots: { total: u._count.bots, live: u.bots.length },
      exchangeAccounts: u._count.exchange_accounts,
    };
  }

  private toAccount(a: {
    id: string;
    venue: AdminExchangeAccountRow['venue'];
    label: string;
    status: AdminExchangeAccountRow['status'];
    public_ref: string;
    testnet: boolean;
    paper: boolean;
    builder_approved: boolean;
    last_verified_at: Date | null;
    agent_valid_until: Date | null;
    last_error: string | null;
  }): AdminExchangeAccountRow {
    return {
      id: a.id,
      venue: a.venue,
      label: a.label,
      status: a.status,
      publicRef: a.public_ref,
      testnet: a.testnet,
      paper: a.paper,
      builderApproved: a.builder_approved,
      lastVerifiedAt: iso(a.last_verified_at),
      agentValidUntil: iso(a.agent_valid_until),
      lastError: a.last_error,
    };
  }
}

/** Las columnas de `users` que la consola llega a leer. El resto no entra en el proceso. */
const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  disabled: true,
  is_email_verified: true,
  country: true,
  language: true,
  created_at: true,
  last_login_at: true,
} as const;
