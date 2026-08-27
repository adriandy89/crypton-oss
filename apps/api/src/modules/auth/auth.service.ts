import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ActorKind, AuditOutcome, EventSeverity } from '@crypton/shared';
import { AccountStatus, Venue } from '@crypton/db';
import { AuditService, CacheService, DbService } from 'src/libs';
import type { AppPlatform } from './dtos';
import { GoogleService } from './google.service';
import type { SessionUser } from './interfaces';
import { TokenService } from './token.service';

/**
 * Cuánto puede tardar el usuario en pasar por la pantalla de Google.
 *
 * Diez minutos: de sobra para escribir una contraseña y un código de dos
 * pasos, y lo bastante corto como para que un `state` interceptado tenga una
 * ventana estrecha. Pasado ese plazo, el intento simplemente no vale.
 */
const FLOW_TTL_SEC = 10 * 60;

/**
 * Vida del vale que la app canjea por los tokens.
 *
 * Dos minutos. El vale viaja en la URL del redirect de vuelta —lo único que
 * puede viajar por ahí— y una URL acaba en el historial del navegador, así que
 * cuanto menos tiempo sirva, mejor. La app lo canjea en el mismo instante en
 * que lo recibe.
 */
const TICKET_TTL_SEC = 120;

/**
 * Cuánto dura la reautenticación antes de una operación crítica.
 *
 * Cinco minutos: el usuario acaba de identificarse en Google para conectar una
 * clave o borrar su cuenta, y encadenar dos operaciones seguidas no debería
 * obligarle a repetirlo. Más allá de eso deja de ser «acabo de identificarme».
 */
const STEP_UP_TTL_SEC = 5 * 60;

const flowKey = (state: string) => `auth:oauth:${state}`;
const ticketKey = (ticket: string) => `auth:ticket:${ticket}`;
const stepUpKey = (userId: string) => `auth:stepup:${userId}`;

/** Por qué se abrió el flujo: entrar, o demostrar que sigues siendo tú. */
type FlowPurpose = 'SIGN_IN' | 'STEP_UP';

/** Lo que se guarda mientras el usuario está en la pantalla de Google. */
interface FlowRecord {
  purpose: FlowPurpose;
  platform: AppPlatform;
  /** Se comprueba dentro del ID token: ata la respuesta a esta petición. */
  nonce: string;
  /** PKCE contra Google. Nunca sale de este servidor. */
  codeVerifier: string;
  /** SHA-256 del verificador que se guardó la app. Ver `redeemTicket`. */
  ticketChallenge: string;
  /** Solo en `STEP_UP`: de quién es la sesión que pide reautenticarse. */
  userId?: string;
}

interface TicketRecord {
  purpose: FlowPurpose;
  userId: string;
  ticketChallenge: string;
}

/** Motivos por los que el redirect de vuelta puede traer un error. */
type AuthErrorCode =
  'access_denied' | 'email_unverified' | 'account_disabled' | 'email_taken' | 'failed';

/**
 * De código estable de la excepción a código de la URL de vuelta.
 *
 * En una tabla y no leyendo el mensaje: la app llegó a decidir el flujo con una
 * expresión regular sobre el texto **en español**, y traducirlo lo rompía sin
 * que fallara nada visible. Lo que no esté aquí es `failed`, a secas.
 */
const CODIGOS_DE_ERROR: Record<string, AuthErrorCode> = {
  EMAIL_TAKEN: 'email_taken',
  EMAIL_UNVERIFIED: 'email_unverified',
  ACCOUNT_DISABLED: 'account_disabled',
};

const randomToken = () => randomBytes(32).toString('base64url');
const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');

/**
 * Acceso a la plataforma. Una sola forma de entrar: Google.
 *
 * No hay contraseñas ni segundo factor propio, y eso es una decisión de
 * seguridad, no una simplificación. Lo que no se guarda no se puede filtrar:
 * esta base de datos no contiene ni un solo hash de contraseña ni un solo
 * secreto TOTP, así que una copia robada no sirve para entrar en ningún sitio.
 * La verificación en dos pasos, las llaves de seguridad y la recuperación de la
 * cuenta las gestiona Google, que lo hace mejor que lo que cabe construir aquí.
 *
 * El flujo completo, de principio a fin:
 *
 *   1. La app sortea un `verifier`, guarda su SHA-256 como `challenge` y llama
 *      a `start`.
 *   2. La API sortea `state`, `nonce` y el `code_verifier` de PKCE, los guarda
 *      en Redis bajo el `state` y devuelve la URL de Google.
 *   3. La app abre esa URL en el NAVEGADOR DEL SISTEMA —nunca en un WebView
 *      propio: el usuario tiene que poder ver la barra de direcciones y
 *      comprobar que teclea su contraseña en google.com.
 *   4. Google redirige a `callback`, en esta API. Aquí se canjea el código, se
 *      verifica el ID token y se identifica o se crea al usuario.
 *   5. La API redirige a la app con un VALE de un solo uso. Los tokens de
 *      sesión no viajan por la URL: quedarían en el historial del navegador.
 *   6. La app canjea el vale presentando el `verifier` del paso 1. Sin él, un
 *      vale interceptado —en Android cualquier aplicación puede declarar el
 *      mismo esquema de enlace— no vale para nada.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  /** A dónde devolver el navegador según desde dónde se abriera el flujo. */
  private readonly appRedirects: Record<AppPlatform, string>;

  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly tokens: TokenService,
    private readonly google: GoogleService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    // Dos destinos fijos leídos de la configuración, y ninguno más. La app dice
    // cuál de los dos, no a dónde: si el destino viniera en la petición, esto
    // sería un redirect abierto con una sesión recién creada dentro.
    this.appRedirects = {
      web: (config.get<string>('APP_REDIRECT_WEB') ?? '').trim(),
      native: (config.get<string>('APP_REDIRECT_NATIVE') ?? '').trim(),
    };
    for (const [platform, url] of Object.entries(this.appRedirects)) {
      if (!url) {
        throw new Error(
          `Falta APP_REDIRECT_${platform.toUpperCase()}: sin ella, el acceso con Google ` +
            'no sabe a dónde devolver al usuario.',
        );
      }
    }
  }

  // ── 1. Arrancar el flujo ──────────────────────────────────────

  /**
   * Prepara un intento de acceso y devuelve la URL de Google.
   *
   * `stepUpFor` distingue los dos usos: sin él es un login normal; con él, la
   * reautenticación de una sesión que ya existe, y entonces se le pide a Google
   * que vuelva a pedir credenciales de verdad en lugar de aceptar la sesión que
   * ya tenga abierta en el navegador.
   */
  async start(params: {
    platform: AppPlatform;
    ticketChallenge: string;
    stepUpFor?: SessionUser;
  }): Promise<{ authorizationUrl: string }> {
    const state = randomToken();
    const nonce = randomToken();
    const codeVerifier = randomToken();

    const record: FlowRecord = {
      purpose: params.stepUpFor ? 'STEP_UP' : 'SIGN_IN',
      platform: params.platform,
      nonce,
      codeVerifier,
      ticketChallenge: params.ticketChallenge,
      userId: params.stepUpFor?.id,
    };
    await this.cache.set(flowKey(state), record, FLOW_TTL_SEC);

    return {
      authorizationUrl: this.google.buildAuthorizationUrl({
        state,
        nonce,
        codeChallenge: sha256(codeVerifier),
        loginHint: params.stepUpFor?.email,
        forceReauth: Boolean(params.stepUpFor),
      }),
    };
  }

  // ── 2. La vuelta de Google ────────────────────────────────────

  /**
   * Procesa el redirect de Google y devuelve a dónde mandar el navegador.
   *
   * Devuelve una URL en lugar de lanzar porque quien está al otro lado es un
   * navegador que viene de google.com: un 401 con un JSON dejaría al usuario
   * mirando una página en blanco. Los fallos se transmiten como un `error=` en
   * la URL de vuelta, y es la app la que los explica.
   */
  async handleCallback(query: { code?: string; state?: string; error?: string }): Promise<string> {
    if (!query.state) {
      // Sin `state` no se sabe ni a qué app devolver: el intento no salió de
      // aquí, o expiró hace tanto que ya no queda rastro.
      throw new BadRequestException(
        'Enlace de acceso no válido o caducado. Vuelve a intentarlo desde la aplicación.',
      );
    }

    // De un solo uso: un `state` reproducido no encuentra nada que consumir.
    const flow = await this.cache.getDel<FlowRecord>(flowKey(query.state));
    if (!flow) {
      throw new BadRequestException(
        'Enlace de acceso no válido o caducado. Vuelve a intentarlo desde la aplicación.',
      );
    }

    const back = (params: Record<string, string>) => this.appUrl(flow.platform, params);

    // El usuario cerró la pantalla de Google o denegó el permiso.
    if (query.error || !query.code) {
      return back({
        error: query.error === 'access_denied' ? 'access_denied' : 'failed',
      });
    }

    try {
      const identity = await this.google.exchangeCode({
        code: query.code,
        codeVerifier: flow.codeVerifier,
        nonce: flow.nonce,
      });

      const userId =
        flow.purpose === 'STEP_UP'
          ? await this.resolveStepUp(flow.userId, identity.sub)
          : (await this.signInWithGoogle(identity)).id;

      const ticket = randomToken();
      const record: TicketRecord = {
        purpose: flow.purpose,
        userId,
        ticketChallenge: flow.ticketChallenge,
      };
      await this.cache.set(ticketKey(ticket), record, TICKET_TTL_SEC);

      return back({ ticket });
    } catch (error) {
      return back({ error: this.errorCode(error) });
    }
  }

  // ── 3. El canje del vale ──────────────────────────────────────

  /**
   * Cambia el vale por la sesión, o por el permiso de la operación crítica.
   *
   * El `verifier` es lo que convierte esto en seguro. El vale viaja por un
   * enlace que, en Android, cualquier aplicación instalada puede declarar
   * suyo; el verificador nunca sale de la memoria de la app que abrió el
   * flujo. Quien intercepte el vale no tiene con qué canjearlo.
   */
  async redeemTicket(
    ticket: string,
    verifier: string,
  ): Promise<
    | { accessToken: string; refreshToken: string; stepUp?: undefined }
    | { stepUp: true; expiresIn: number }
  > {
    const record = await this.cache.getDel<TicketRecord>(ticketKey(ticket));
    if (!record) throw new UnauthorizedException('El acceso ha caducado. Inténtalo otra vez.');

    if (!this.matches(sha256(verifier), record.ticketChallenge)) {
      // Alguien tiene el vale pero no el verificador: o es otra aplicación que
      // ha capturado el enlace, o el flujo se ha cruzado con otro.
      this.logger.warn('Vale de acceso presentado con un verificador que no corresponde.');
      throw new UnauthorizedException('El acceso ha caducado. Inténtalo otra vez.');
    }

    const user = await this.db.user.findUnique({
      where: { id: record.userId },
    });
    if (!user || user.disabled)
      throw new UnauthorizedException({
        code: 'ACCOUNT_DISABLED',
        message: 'Cuenta deshabilitada.',
      });

    if (record.purpose === 'STEP_UP') {
      await this.cache.set(stepUpKey(user.id), true, STEP_UP_TTL_SEC);
      return { stepUp: true, expiresIn: STEP_UP_TTL_SEC };
    }

    await this.db.user.update({
      where: { id: user.id },
      data: { last_login_at: new Date() },
    });
    return this.tokens.issuePair(this.toSessionUser(user));
  }

  // ── Sesión ────────────────────────────────────────────────────

  /** Rota el refresh token y reemite el par con claims frescos. */
  async refresh(refreshToken: string) {
    const { sub, fam } = await this.tokens.consumeRefresh(refreshToken);
    const user = await this.db.user.findUnique({ where: { id: sub } });
    if (!user || user.disabled) throw new UnauthorizedException('Sesión no válida.');
    return this.tokens.reissue(this.toSessionUser(user), fam);
  }

  async signOut(refreshToken: string): Promise<void> {
    const payload = await this.tokens.peekRefresh(refreshToken);
    if (payload) await this.tokens.revokeFamily(payload.sub, payload.fam);
  }

  /**
   * Cierra la sesión en todos los dispositivos.
   *
   * Es la reacción a «creo que alguien ha entrado en mi cuenta». Sin
   * contraseña que cambiar, este es el gesto que corta el acceso ajeno desde
   * dentro de la aplicación; lo otro que hay que hacer —revisar los accesos de
   * la cuenta de Google— ya no depende de nosotros.
   */
  async signOutEverywhere(userId: string): Promise<void> {
    await this.tokens.revokeAll(userId);
    // También la reautenticación reciente: si se sospecha de un intruso, un
    // permiso vivo de operación crítica es justo lo que no debe sobrevivir.
    await this.cache.del(stepUpKey(userId));
  }

  // ── Reautenticación para operaciones críticas ─────────────────

  /**
   * O lanza, o el usuario acaba de demostrar ante Google que sigue siendo él.
   *
   * Un token de acceso dura quince minutos y no se revalida contra la base de
   * datos en cada petición: por sí solo no puede bastar para dar de alta una
   * clave capaz de operar con dinero real ni para borrar la cuenta entera. El
   * permiso se consume al usarlo, así que sirve para UNA operación.
   */
  async assertStepUp(userId: string): Promise<void> {
    const granted = await this.cache.getDel<boolean>(stepUpKey(userId));

    // Se registra AQUÍ y no en un interceptor porque esto no es un guard ni un
    // decorador: es una llamada imperativa dentro de dos controladores, así que
    // nada fuera de este método sabe que la operación exigía reautenticación.
    // Se anota tanto la concesión como la negativa: una ráfaga de negativas es
    // la señal de que alguien está probando con un token robado.
    await this.audit.recordNow({
      actor: ActorKind.USER,
      actorId: userId,
      action: 'auth.step_up',
      severity: granted ? EventSeverity.INFO : EventSeverity.WARN,
      outcome: granted ? AuditOutcome.OK : AuditOutcome.DENIED,
      message: granted ? null : 'Reautenticación exigida y no presentada.',
    });

    if (!granted) {
      throw new UnauthorizedException({
        code: 'STEP_UP_REQUIRED',
        message: 'Vuelve a identificarte con Google para continuar.',
      });
    }
  }

  /** Si hay una reautenticación viva. La app lo usa para no pedirla dos veces. */
  async hasFreshStepUp(userId: string): Promise<boolean> {
    return this.cache.exists(stepUpKey(userId));
  }

  // ── Interno ───────────────────────────────────────────────────

  /**
   * Encuentra o crea la cuenta que corresponde a esa identidad de Google.
   *
   * La clave es el `sub`, nunca el correo. El `sub` no cambia jamás; el correo
   * sí —la gente cambia de dirección, y las direcciones se reasignan dentro de
   * un dominio corporativo—. Buscar por correo convertiría heredar la dirección
   * de otro en heredar su cuenta y sus claves de exchange.
   */
  private async signInWithGoogle(identity: {
    sub: string;
    email: string;
  }): Promise<{ id: string }> {
    const existing = await this.db.user.findUnique({
      where: { google_sub: identity.sub },
    });

    if (existing) {
      if (existing.disabled)
        throw new UnauthorizedException({
          code: 'ACCOUNT_DISABLED',
          message: 'Cuenta deshabilitada.',
        });
      // El correo se refresca si en Google ha cambiado: es un dato de contacto
      // que debe seguir siendo el bueno, no la identidad.
      if (existing.email !== identity.email) {
        await this.db.user
          .update({
            where: { id: existing.id },
            data: { email: identity.email },
          })
          .catch(() => {
            // Otra cuenta ya tiene esa dirección. No se toca ninguna de las dos
            // y se entra igual: el correo viejo es un dato desactualizado, no
            // un motivo para dejar a alguien fuera de su propia cuenta.
            this.logger.warn(
              `El correo de Google de ${existing.id} ya pertenece a otra cuenta; no se actualiza.`,
            );
          });
      }
      return { id: existing.id };
    }

    // Alta. Si la dirección ya existe con otro `sub`, se corta: significa que
    // dos identidades de Google distintas reclaman el mismo correo, y adivinar
    // cuál es la legítima no es algo que deba hacer un servidor en silencio.
    const emailTaken = await this.db.user.findUnique({
      where: { email: identity.email },
      select: { id: true },
    });
    if (emailTaken) {
      throw new ConflictException({
        code: 'EMAIL_TAKEN',
        message: 'Ese correo ya pertenece a otra cuenta.',
      });
    }

    const created = await this.db.user.create({
      data: {
        google_sub: identity.sub,
        email: identity.email,
        // Nombre visible de partida, deducido del correo. No viene de Google:
        // no se piden los permisos de perfil. El usuario lo cambia cuando
        // quiera desde su perfil.
        name: this.defaultName(identity.email),
        // Google ya ha afirmado `email_verified` antes de llegar hasta aquí.
        is_email_verified: true,
        // Todo usuario nace con límites de riesgo por defecto. Dejar la tabla
        // vacía significaría que su primer bot corre sin ninguna guarda.
        //
        // `max_open_bots` va holgado a propósito: lo que cuenta
        // `RiskService.assertCanStart` son los bots EN MARCHA, sin distinguir
        // los de simulación, así que un tope estrecho haría que unos cuantos
        // bots de prueba bloquearan el primero real. Sigue siendo una guarda
        // —el usuario la ajusta en su panel de riesgo—, no un tope comercial.
        risk_limit: {
          create: {
            max_leverage: 10,
            max_open_bots: 20,
            kill_switch_drawdown_pct: 30,
            liquidation_alert_pct: 10,
          },
        },
        // Y con su conexión de SIMULACIÓN en cada venue, para poder crear un
        // bot y verlo operar sin abrir cuenta en ningún exchange ni entregar
        // una clave privada. No guardan secreto: no lo tienen.
        //
        // Se crean aquí, en el mismo `INSERT` del usuario, y no llamando al
        // servicio de conexiones —que ya depende de este módulo para la
        // reautenticación—: al revés habría un ciclo. Ese servicio las asegura
        // igualmente al listar, que es lo que cubre a quien se dio de alta
        // antes de que esto existiera.
        //
        // En MAINNET a propósito: la simulación existe para ver cómo se
        // comportaría la estrategia con dinero real, y para eso el libro que
        // mira tiene que ser el de verdad.
        exchange_accounts: {
          create: Object.values(Venue).map((venue) => ({
            venue,
            label: 'Simulación',
            status: AccountStatus.VERIFIED,
            public_ref: 'paper',
            paper: true,
            paper_balance: '10000',
            testnet: false,
            last_verified_at: new Date(),
          })),
        },
      },
      select: { id: true },
    });

    this.logger.log(`Cuenta nueva por Google: ${created.id}`);
    return created;
  }

  /**
   * Comprueba que quien acaba de identificarse en Google es el dueño de la
   * sesión que pidió reautenticarse.
   *
   * Sin esto, bastaría con identificarse con CUALQUIER cuenta de Google para
   * que el navegador volviera con un vale válido: la reautenticación
   * comprobaría que alguien está vivo al otro lado, no que sea quien dice.
   */
  private async resolveStepUp(userId: string | undefined, googleSub: string): Promise<string> {
    if (!userId) throw new UnauthorizedException('Reautenticación no válida.');

    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { id: true, google_sub: true, disabled: true },
    });
    if (!user || user.disabled)
      throw new UnauthorizedException({
        code: 'ACCOUNT_DISABLED',
        message: 'Cuenta deshabilitada.',
      });

    if (!this.matches(user.google_sub, googleSub)) {
      this.logger.warn(`Reautenticación de ${userId} completada con otra cuenta de Google.`);
      throw new UnauthorizedException('Has entrado con una cuenta de Google distinta.');
    }
    return user.id;
  }

  /** Parte local del correo, saneada. Solo es el punto de partida del nombre. */
  private defaultName(email: string): string {
    const local = email.split('@')[0]?.replace(/[^\p{L}\p{N} ._-]/gu, '') ?? '';
    return (local || 'usuario').slice(0, 128);
  }

  /** URL de vuelta a la app, con el vale o con el motivo del fallo. */
  private appUrl(platform: AppPlatform, params: Record<string, string>): string {
    const url = new URL(this.appRedirects[platform]);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  /** Traduce el fallo a un código estable que la app sepa explicar. */
  private errorCode(error: unknown): AuthErrorCode {
    if (error instanceof HttpException) {
      const cuerpo = error.getResponse();
      const code =
        typeof cuerpo === 'object' && cuerpo !== null
          ? (cuerpo as { code?: string }).code
          : undefined;
      const traducido = code ? CODIGOS_DE_ERROR[code] : undefined;
      if (traducido) return traducido;
    }

    this.logger.warn(`Acceso con Google fallido: ${String(error)}`);
    return 'failed';
  }

  /**
   * Comparación en tiempo constante.
   *
   * Ni el `sub` de Google ni el reto del vale son secretos de alto valor, pero
   * los dos deciden si se entra o no: compararlos con `===` filtra por el
   * tiempo de respuesta cuántos caracteres se han acertado.
   */
  private matches(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }

  private toSessionUser(user: {
    id: string;
    email: string;
    name: string;
    role: SessionUser['role'];
    language: string;
  }): SessionUser {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      language: user.language,
    };
  }
}
