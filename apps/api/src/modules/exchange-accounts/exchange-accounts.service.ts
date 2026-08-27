import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createAdapter,
  createPublicAdapter,
  serviceCredentials,
  type ExchangeAdapter,
  type VenueBudget,
  type VenueCredentials,
} from '@crypton/exchange-core';
import { AccountStatus, Venue } from '@crypton/db';
import { DbService, EnvelopeService, type SealedPayload } from 'src/libs';
import { CreateExchangeAccountDto, UpdateExchangeAccountDto } from './dtos';

/** Etiqueta de las conexiones de simulación. Es fija: no la elige el usuario. */
export const PAPER_LABEL = 'Simulación';

/** Capital de partida de una cuenta de simulación recién creada. */
export const PAPER_DEFAULT_BALANCE = '10000';

/**
 * Estados de bot que impiden tocar la simulación de su cuenta.
 *
 * Cambiar el capital o reiniciar con un bot en marcha dejaría al simulador del
 * worker y a la base contando cosas distintas.
 */
const LIVE_BOT_STATUSES = [
  'STARTING',
  'RUNNING',
  'PAUSED',
  'STOPPING',
] as const;

/**
 * Alta, verificación y borrado de credenciales de exchange.
 *
 * Regla que atraviesa todo el servicio: el secreto entra por el DTO, se cifra
 * y no vuelve a salir NUNCA de aquí en claro. Ni en respuestas, ni en logs, ni
 * en mensajes de error. Lo único que se devuelve al cliente es `public_ref`,
 * que es un dato público del venue.
 */
@Injectable()
export class ExchangeAccountsService {
  private readonly logger = new Logger(ExchangeAccountsService.name);

  constructor(
    private readonly db: DbService,
    private readonly envelope: EnvelopeService,
    private readonly config: ConfigService,
  ) {}

  async list(userId: string) {
    // Se asegura ANTES de listar, y no solo en el alta, porque el alta no es el
    // único camino: hay usuarios anteriores a que esto existiera, y un venue
    // nuevo en el enum tampoco lo trae nadie. Es un `createMany` que casi
    // siempre no escribe nada.
    await this.ensurePaperAccounts(userId);

    const accounts = await this.db.exchangeAccount.findMany({
      where: { user_id: userId },
      orderBy: [{ venue: 'asc' }, { created_at: 'asc' }],
    });
    return accounts.map((a) => this.toPublic(a));
  }

  /**
   * Garantiza que el usuario tiene su conexión de simulación en cada venue.
   *
   * Es lo que permite crear un bot simulado sin haber conectado nada: hasta
   * ahora un bot —simulado o no— exigía una credencial verificada, así que
   * para no arriesgar un dólar había que abrir cuenta en el exchange y entregar
   * una clave privada. Estas filas no guardan secreto alguno.
   *
   * Siempre en MAINNET: la simulación existe para ver cómo se comportaría la
   * estrategia con dinero real, y para eso el libro tiene que ser el de verdad.
   *
   * Lo que falta se decide por la BANDERA `paper` y no por la etiqueta. Confiar
   * en que `skipDuplicates` chocara contra la clave única —que lleva el
   * `label`— hacía que renombrar la conexión de simulación dejara de colisionar
   * y el siguiente listado creara otra, y otra en el siguiente renombrado.
   * `skipDuplicates` se conserva para lo que sí resuelve: dos peticiones a la
   * vez, y la migración que las siembra.
   */
  async ensurePaperAccounts(userId: string): Promise<void> {
    const existentes = await this.db.exchangeAccount.findMany({
      where: { user_id: userId, paper: true },
      select: { venue: true },
    });
    const cubiertos = new Set(existentes.map((a) => a.venue));
    const faltan = Object.values(Venue).filter((v) => !cubiertos.has(v));
    if (faltan.length === 0) return;

    await this.db.exchangeAccount.createMany({
      data: faltan.map((venue) => ({
        user_id: userId,
        venue,
        label: PAPER_LABEL,
        status: AccountStatus.VERIFIED,
        public_ref: 'paper',
        paper: true,
        paper_balance: PAPER_DEFAULT_BALANCE,
        testnet: false,
        last_verified_at: new Date(),
      })),
      skipDuplicates: true,
    });
  }

  async create(userId: string, dto: CreateExchangeAccountDto) {
    const seedWarning = CreateExchangeAccountDto.assertNoSeedPhrase(dto);
    if (seedWarning) throw new BadRequestException(seedWarning);

    const credentials = this.buildCredentials(dto);
    // La red se resuelve UNA vez y la usan tanto la verificación como la fila:
    // dos lecturas separadas podrían discrepar y dejar guardada como de testnet
    // una credencial que se verificó contra mainnet.
    //
    // El `|| dto.hyperliquid?.testnet` cubre a un cliente sin actualizar, que
    // todavía manda la bandera dentro del bloque de Hyperliquid.
    const testnet = dto.testnet === true || dto.hyperliquid?.testnet === true;

    // La red entra en la comprobación igual que en la clave única de la tabla:
    // «Principal» en mainnet y «Principal» en testnet del mismo venue son dos
    // conexiones distintas y no compiten por el nombre.
    const duplicate = await this.db.exchangeAccount.findFirst({
      // `paper: false` porque la conexión de simulación no compite por la
      // etiqueta: no la elige el usuario y la pantalla no la lee. Sin esto,
      // llamar «Simulación» a una conexión de verdad chocaba contra la simulada
      // con un mensaje que hablaba de una conexión que el usuario no creó.
      where: {
        user_id: userId,
        venue: dto.venue,
        testnet,
        label: dto.label,
        paper: false,
      },
      select: { id: true },
    });
    if (duplicate) {
      throw new ConflictException(
        `Ya tienes una conexión con esa etiqueta en ${dto.venue}` +
          (testnet ? ' (testnet).' : '.'),
      );
    }

    // Se verifica ANTES de guardar: una credencial que no funciona no debería
    // ocupar sitio ni dar la impresión de estar lista para operar.
    // Contra la red que se va a guardar, no contra mainnet siempre: verificar en
    // una red y guardar la otra daría por buena una credencial que no existe
    // donde va a operar.
    const adapter = this.adapterFor(credentials, false, false, testnet);
    let verification: { ok: boolean; publicRef: string; detail?: string };
    try {
      verification = await adapter.verify();
    } finally {
      await adapter.close().catch(() => undefined);
    }

    if (!verification.ok) {
      throw new BadRequestException(
        'No se ha podido verificar la credencial: ' +
          (verification.detail ?? 'motivo desconocido'),
      );
    }

    const sealed = this.envelope.seal(credentials);
    const account = await this.db.exchangeAccount.create({
      data: {
        user_id: userId,
        venue: dto.venue,
        label: dto.label,
        status: AccountStatus.VERIFIED,
        public_ref: verification.publicRef,
        enc_payload: sealed.encPayload,
        enc_dek: sealed.encDek,
        enc_iv: sealed.encIv,
        enc_tag: sealed.encTag,
        enc_key_id: sealed.encKeyId,
        testnet,
        last_verified_at: new Date(),
      },
    });

    this.logger.log(
      `Conexión ${dto.venue} verificada para el usuario ${userId}`,
    );
    return this.toPublic(account);
  }

  async update(userId: string, id: string, dto: UpdateExchangeAccountDto) {
    const current = await this.mustOwn(userId, id);

    // La etiqueta de la conexión de simulación no es del usuario: la pantalla la
    // nombra por lo que es —«simulación»— e ignora este campo, así que cambiarla
    // no se vería y solo serviría para que dejara de reconocerse a sí misma.
    if (dto.label !== undefined && current.paper) {
      throw new BadRequestException(
        'La conexión de simulación no se renombra.',
      );
    }

    if (dto.paperBalance !== undefined) {
      if (!current.paper) {
        throw new BadRequestException(
          'El capital de partida solo existe en la conexión de simulación: en una real lo decide tu saldo en el exchange.',
        );
      }
      // Un capital de cero o negativo no es una simulación pobre: es una que no
      // puede colocar ni una orden y cuyo saldo disponible sale en rojo desde el
      // primer tick. El tope de arriba no es una opinión sobre cuánto se puede
      // simular, es lo que cabe en la columna.
      const capital = Number(dto.paperBalance);
      if (
        !Number.isFinite(capital) ||
        capital <= 0 ||
        capital > 1_000_000_000
      ) {
        throw new BadRequestException(
          'El capital de partida tiene que ser mayor que cero y como mucho 1.000.000.000.',
        );
      }
      // Con un bot en marcha, cambiar el capital dejaría al simulador del motor
      // y a lo que enseña la app contando cosas distintas: el saldo nuevo solo
      // llegaría al reabrir el adaptador, y hasta entonces la cartera mentiría.
      await this.assertPaperIdle(id);
    }

    const account = await this.db.exchangeAccount.update({
      where: { id },
      data: {
        ...(dto.label !== undefined ? { label: dto.label } : {}),
        ...(dto.builderApproved !== undefined
          ? { builder_approved: dto.builderApproved }
          : {}),
        ...(dto.paperBalance !== undefined
          ? { paper_balance: dto.paperBalance }
          : {}),
      },
    });

    // Cambiar el capital de partida es empezar de cero: el estado guardado
    // arrastra el saldo viejo, y conservarlo convertiría «simular con 500» en
    // «simular con 500 más lo que ya llevabas».
    if (dto.paperBalance !== undefined)
      await this.resetPaperState(id, dto.paperBalance);

    return this.toPublic(account);
  }

  /**
   * Devuelve la simulación a su punto de partida.
   *
   * Deja el saldo en el capital configurado y sin posiciones ni órdenes. El
   * histórico de los bots —sus ejecuciones y sus ciclos— no se toca: eso es de
   * cada bot y se borra borrando el bot.
   */
  async resetPaper(userId: string, id: string) {
    const account = await this.mustOwn(userId, id);
    if (!account.paper) {
      throw new BadRequestException(
        'Solo se puede reiniciar la conexión de simulación: una real la lleva el exchange.',
      );
    }
    await this.assertPaperIdle(id);
    await this.resetPaperState(
      id,
      account.paper_balance?.toFixed() ?? PAPER_DEFAULT_BALANCE,
    );
    this.logger.log(`Simulación reiniciada en la conexión ${id.slice(0, 8)}`);
    return this.toPublic(account);
  }

  /**
   * Devuelve a su punto de partida los sandboxes de TODOS los bots de esta
   * conexión.
   *
   * Cada bot simulado tiene el suyo, así que reiniciar «la simulación» de una
   * conexión es reiniciarlos todos: es lo que el usuario espera de un botón que
   * está en la conexión y no en cada bot.
   *
   * Las filas se ESCRIBEN en vez de borrarse, y esa es toda la gracia: el epoch
   * es lo único que hace segura la carrera contra un simulador que siga vivo en
   * un worker —tarda hasta treinta segundos en cerrarse por inactividad y su
   * última escritura resucitaría lo que se acaba de tirar—, y un epoch borrado
   * no defiende de nada, porque ese simulador volvería a crear la fila con el
   * suyo y se saldría con la suya.
   *
   * No hay saldo memorizado que tirar: la cartera de una conexión de simulación
   * no se cachea, justamente para que un reinicio se vea en el acto. Ver
   * `BotsService.readWallet`.
   */
  private async resetPaperState(id: string, balance: string): Promise<void> {
    // Solo los que tienen algo que reiniciar: los simulados que YA guardaron un
    // sandbox, más los que están vivos aunque todavía no hayan guardado —esos
    // tienen un simulador en memoria en algún worker y hay que invalidárselo con
    // el epoch—. Un bot parado hace tres meses y sin fila no necesita nada:
    // `PaperStateStore.load` le dará el capital de partida cuando y si arranca.
    // Sin este filtro, cada reinicio sembraba una fila por cada bot que hubiera
    // existido nunca en la conexión.
    const bots = await this.db.bot.findMany({
      where: {
        exchange_account_id: id,
        dry_run: true,
        OR: [
          { paper_state: { isNot: null } },
          { status: { in: [...LIVE_BOT_STATUSES] } },
        ],
      },
      select: { id: true, paper_state: { select: { epoch: true } } },
    });
    if (bots.length === 0) return;

    const limpio = {
      balance,
      realized_pnl: '0',
      fees_paid: '0',
      seq: 0,
      positions: [] as never,
      orders: [] as never,
    };

    await this.db.$transaction(
      bots.map((bot) =>
        this.db.paperState.upsert({
          where: { bot_id: bot.id },
          create: {
            bot_id: bot.id,
            ...limpio,
            epoch: (bot.paper_state?.epoch ?? 0) + 1,
          },
          update: { ...limpio, epoch: (bot.paper_state?.epoch ?? 0) + 1 },
        }),
      ),
    );
  }

  /** Ningún bot vivo sobre esta conexión, o no se toca su simulación. */
  private async assertPaperIdle(id: string): Promise<void> {
    const vivo = await this.db.bot.findFirst({
      where: {
        exchange_account_id: id,
        status: { in: [...LIVE_BOT_STATUSES] },
      },
      select: { id: true, name: true },
    });
    if (vivo) {
      throw new ConflictException(
        `Para eso hay que parar antes los bots que están usando esta simulación (${vivo.name}).`,
      );
    }
  }

  /** Reverifica contra el venue y refleja el resultado en el estado. */
  async verify(userId: string, id: string) {
    const account = await this.mustOwn(userId, id);

    // Una cuenta de simulación no tiene credencial que comprobar. Se responde
    // que está bien en vez de fallar porque desde fuera es una conexión más, y
    // un error aquí sonaría a que la simulación está rota.
    if (account.paper) return this.toPublic(account);

    const adapter = await this.openAdapter(userId, id);
    try {
      const result = await adapter.verify();
      const updated = await this.db.exchangeAccount.update({
        where: { id: account.id },
        data: {
          status: result.ok ? AccountStatus.VERIFIED : AccountStatus.ERROR,
          last_verified_at: result.ok ? new Date() : account.last_verified_at,
          last_error: result.ok ? null : (result.detail ?? 'Error desconocido'),
        },
      });
      return this.toPublic(updated);
    } finally {
      await adapter.close().catch(() => undefined);
    }
  }

  /**
   * Elimina la credencial. Antes exige que no queden bots vivos usándola: si se
   * borrara con bots corriendo, sus órdenes quedarían huérfanas en el venue sin
   * nadie que las cancele.
   */
  async remove(userId: string, id: string): Promise<void> {
    const account = await this.mustOwn(userId, id);

    // La conexión de simulación es de la casa y se recrearía al siguiente
    // listado. Lo que el usuario quiere cuando pulsa aquí es empezar de cero,
    // y para eso está `resetPaper`.
    if (account.paper) {
      throw new BadRequestException(
        'La conexión de simulación no se elimina. Si quieres empezar de cero, reinicia la simulación.',
      );
    }
    const activeBots = await this.db.bot.count({
      where: {
        exchange_account_id: id,
        status: { in: ['STARTING', 'RUNNING', 'PAUSED', 'STOPPING'] },
      },
    });
    if (activeBots > 0) {
      throw new ConflictException(
        `Hay ${activeBots} bot(s) usando esta conexión. Párelos antes de eliminarla.`,
      );
    }
    await this.db.exchangeAccount.delete({ where: { id } });
  }

  /**
   * Crea un adaptador ya autenticado a partir de la credencial guardada.
   * Es el ÚNICO punto por el que el secreto vuelve a memoria, y el llamante
   * está obligado a cerrar el adaptador cuando termine.
   *
   * `userId` NO es opcional, y por eso va primero: este método descifra una
   * clave privada capaz de operar con dinero. Antes recibía solo el id de la
   * cuenta y hacía `findUnique`, de modo que un llamante que eligiera mal la
   * cuenta —y había dos que la elegían sin filtrar por dueño— provocaba el
   * descifrado de la clave de otro usuario. Con la firma actual, olvidarse del
   * dueño no compila.
   */
  async openAdapter(
    userId: string,
    accountId: string,
    dryRun = false,
    opts: { budget?: VenueBudget } = {},
  ): Promise<ExchangeAdapter> {
    const account = await this.db.exchangeAccount.findFirst({
      where: { id: accountId, user_id: userId },
    });
    if (!account) throw new NotFoundException('Conexión no encontrada.');

    // Una conexión de simulación no tiene sobre que abrir. Se devuelve un
    // adaptador de precios envuelto en el simulador, y el envoltorio NO es
    // decorativo: `createPublicAdapter` con la cuenta de servicio devuelve en
    // Lighter mainnet un adaptador que SÍ puede firmar —con la cuenta de la
    // plataforma, además—, así que sin `dryRun` esta puerta entregaría un
    // firmante a quien solo venía a leer un precio.
    //
    // El simulador va sin estado a propósito. El sandbox ya no es de la conexión
    // sino de cada bot (`paper_states`), y vive en el worker que tiene su lease;
    // montar aquí una segunda copia daría un saldo que nadie guarda y que
    // discreparía a la primera ejecución. Lo único que se pide por esta puerta
    // con una cuenta simulada es el precio de referencia. El saldo simulado se
    // lee de la base — ver `BotsService.fetchPaperWallet`.
    if (account.paper) {
      return createPublicAdapter(account.venue, {
        dryRun: true,
        testnet: account.testnet,
        service: serviceCredentials(account.venue, this.config).credentials,
        budget: opts.budget,
      });
    }

    // El sobre es nullable desde que existen las cuentas de simulación, y la
    // base lo defiende con un CHECK. Llegar aquí sin él querría decir que ese
    // CHECK no está puesto: se para en seco en lugar de arrastrar el nulo hasta
    // el descifrador.
    if (
      !account.enc_payload ||
      !account.enc_dek ||
      !account.enc_iv ||
      !account.enc_tag ||
      !account.enc_key_id
    ) {
      throw new BadRequestException(
        'Esa conexión no tiene credencial guardada.',
      );
    }

    const sealed: SealedPayload = {
      encPayload: account.enc_payload,
      encDek: account.enc_dek,
      encIv: account.enc_iv,
      encTag: account.enc_tag,
      encKeyId: account.enc_key_id,
    };
    const credentials = this.envelope.open<VenueCredentials>(sealed);
    return this.adapterFor(
      credentials,
      dryRun,
      account.builder_approved,
      account.testnet,
      opts.budget,
    );
  }

  /**
   * El código de builder se adjunta SOLO con la aprobación firmada en el venue;
   * sin ella, el exchange rechaza la orden entera. En el alta todavía no hay
   * aprobación posible, así que no se adjunta. Hoy estos adaptadores solo
   * verifican y leen precios —no firman órdenes—, pero el criterio es el mismo
   * que aplica el worker y no debe divergir.
   */
  private adapterFor(
    credentials: VenueCredentials,
    dryRun = false,
    builderApproved = false,
    testnet: boolean,
    // Sin presupuesto, cada lectura sale «gratis» y no la cuenta nadie. La API
    // y el worker comparten IP de salida, y los DEX cuentan sus limites por IP:
    // es la misma razon que documenta `MarketDataService` para sus adaptadores
    // publicos. Un endpoint que el movil de cada usuario puede pedir cada 30 s
    // tiene que entrar en la misma cuota que las ordenes de los bots.
    budget?: VenueBudget,
  ): ExchangeAdapter {
    return createAdapter(credentials, {
      dryRun,
      testnet,
      budget,
      builderAddress: builderApproved
        ? this.config.get<string>('BUILDER_ADDRESS') || undefined
        : undefined,
      builderFeeTenthBps: builderApproved
        ? Number(this.config.get<string>('BUILDER_FEE_TENTH_BPS', '0')) ||
          undefined
        : undefined,
    });
  }

  private buildCredentials(dto: CreateExchangeAccountDto): VenueCredentials {
    switch (dto.venue) {
      case Venue.HYPERLIQUID:
        if (!dto.hyperliquid)
          throw new BadRequestException(
            'Faltan las credenciales de Hyperliquid.',
          );
        return { venue: 'HYPERLIQUID', ...dto.hyperliquid };
      case Venue.LIGHTER:
        if (!dto.lighter)
          throw new BadRequestException('Faltan las credenciales de Lighter.');
        return { venue: 'LIGHTER', ...dto.lighter };
      case Venue.ASTER:
        if (!dto.aster)
          throw new BadRequestException('Faltan las credenciales de Aster.');
        return { venue: 'ASTER', ...dto.aster };
      default:
        throw new BadRequestException('Venue no soportado.');
    }
  }

  private async mustOwn(userId: string, id: string) {
    const account = await this.db.exchangeAccount.findFirst({
      where: { id, user_id: userId },
    });
    if (!account) throw new NotFoundException('Conexión no encontrada.');
    return account;
  }

  /** Proyección pública: aquí es donde se garantiza que el secreto no sale. */
  private toPublic(account: {
    id: string;
    venue: Venue;
    label: string;
    status: AccountStatus;
    public_ref: string;
    builder_approved: boolean;
    testnet: boolean;
    paper: boolean;
    paper_balance: { toFixed: () => string } | null;
    last_verified_at: Date | null;
    last_error: string | null;
    created_at: Date;
  }) {
    return {
      id: account.id,
      venue: account.venue,
      label: account.label,
      status: account.status,
      publicRef: account.public_ref,
      builderApproved: account.builder_approved,
      testnet: account.testnet,
      // La app necesita distinguirlas para no ofrecer «reverificar» sobre algo
      // que no tiene credencial, para no mezclar su resultado con el del dinero
      // de verdad, y para dejar claro por qué su bot solo puede simular.
      paper: account.paper,
      paperBalance: account.paper_balance?.toFixed() ?? null,
      lastVerifiedAt: account.last_verified_at,
      lastError: account.last_error,
      createdAt: account.created_at,
    };
  }
}
