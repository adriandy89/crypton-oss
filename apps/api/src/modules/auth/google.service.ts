import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';

/**
 * Identidad que Google acredita, reducida a lo que esta plataforma necesita.
 *
 * Nada más. El ID token trae también `name`, `picture`, `locale` y otros
 * campos cuando se piden los permisos de perfil: aquí NO se piden, así que no
 * llegan, y lo que no llega no hay que guardarlo ni protegerlo ni borrarlo
 * cuando el usuario se va.
 */
export interface GoogleIdentity {
  /** `sub` del ID token: identificador estable y opaco de la cuenta. */
  sub: string;
  email: string;
}

/**
 * Permisos solicitados. `openid` para obtener el ID token y `email` para
 * saber a quién pertenece la cuenta.
 *
 * Sin `profile`: el nombre visible de CRYPTON lo pone el usuario, no Google.
 * Pedir un permiso «por si acaso» sale gratis en el momento y caro después:
 * aparece en la pantalla de consentimiento, aumenta lo que hay que custodiar y
 * obliga a justificarlo si Google verifica la aplicación.
 */
const SCOPES = ['openid', 'email'];

/**
 * Puente con Google. Es el ÚNICO sitio del proyecto que habla con Google.
 *
 * El flujo es el de código de autorización con PKCE (RFC 7636), con el
 * intercambio hecho en el servidor. Eso significa que:
 *
 *   · el `client_secret` vive solo aquí y nunca viaja al dispositivo;
 *   · el `redirect_uri` es una URL HTTPS nuestra, registrada en Google, y no
 *     un esquema propio de la app —que en Android puede reclamar cualquier
 *     otra aplicación instalada—;
 *   · el código de autorización no sirve sin el `code_verifier`, que solo
 *     existe en la memoria de esta API.
 *
 * Es lo que recomienda la RFC 8252 para aplicaciones nativas y lo que hacen
 * las apps serias; la alternativa —incrustar un formulario de Google dentro de
 * un WebView— es justamente el patrón que Google bloquea, porque enseña a los
 * usuarios a teclear su contraseña en pantallas que no puede verificar.
 */
@Injectable()
export class GoogleService {
  private readonly logger = new Logger(GoogleService.name);
  private readonly client: OAuth2Client;
  private readonly clientId: string;

  constructor(config: ConfigService) {
    this.clientId = this.require(config, 'GOOGLE_CLIENT_ID');
    this.client = new OAuth2Client({
      clientId: this.clientId,
      clientSecret: this.require(config, 'GOOGLE_CLIENT_SECRET'),
      redirectUri: this.require(config, 'GOOGLE_REDIRECT_URI'),
    });
  }

  /**
   * URL de la pantalla de Google a la que mandar al usuario.
   *
   * `state` y `nonce` los genera quien llama, porque es quien tiene que
   * guardarlos para comprobarlos a la vuelta.
   */
  buildAuthorizationUrl(params: {
    state: string;
    nonce: string;
    codeChallenge: string;
    /** Correo conocido: evita el selector de cuentas al reautenticar. */
    loginHint?: string;
    /**
     * Fuerza a Google a pedir credenciales otra vez en lugar de aceptar la
     * sesión ya abierta en el navegador. Se usa al reautenticar antes de una
     * operación crítica: sin esto, «vuelve a identificarte» sería un redirect
     * instantáneo que no demuestra nada.
     */
    forceReauth?: boolean;
  }): string {
    return this.client.generateAuthUrl({
      scope: SCOPES,
      state: params.state,
      // Se firma dentro del ID token; comprobarlo a la vuelta ata la respuesta
      // de Google a ESTA petición y no a una reproducida.
      nonce: params.nonce,
      code_challenge: params.codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
      login_hint: params.loginHint,
      // `select_account` en el login normal: en un móvil compartido, entrar sin
      // preguntar con la cuenta que hubiera abierta es un accidente esperando.
      prompt: params.forceReauth ? 'login' : 'select_account',
      // `max_age=0` obliga a una autenticación reciente de verdad. Es la parte
      // que hace que reautenticar signifique algo.
      ...(params.forceReauth ? { max_age: 0 } : {}),
      // Sin refresh token de Google: esta plataforma no llama a ninguna API de
      // Google en nombre del usuario. Solo necesita saber quién es, una vez.
      access_type: 'online',
      include_granted_scopes: false,
    });
  }

  /**
   * Canjea el código por la identidad, verificando el ID token.
   *
   * Se comprueba todo, no solo la firma:
   *
   *   · firma, emisor y caducidad, contra las claves públicas de Google
   *     (`verifyIdToken` las descarga y cachea);
   *   · `aud`, que debe ser nuestro cliente: un token emitido para otra
   *     aplicación es un token válido de otra aplicación;
   *   · `nonce`, que ata la respuesta a la petición que la inició;
   *   · `email_verified`, sin el cual el correo no prueba nada: cualquiera
   *     puede crear una cuenta de Google Workspace con la dirección de otro
   *     dominio y sin verificar.
   */
  async exchangeCode(params: {
    code: string;
    codeVerifier: string;
    nonce: string;
  }): Promise<GoogleIdentity> {
    let idToken: string | undefined;
    try {
      const { tokens } = await this.client.getToken({
        code: params.code,
        codeVerifier: params.codeVerifier,
      });
      idToken = tokens.id_token ?? undefined;

      // El access token de Google no se usa para nada: no se llama a ninguna
      // API suya. Se revoca en cuanto se tiene la identidad, para no dejar
      // vivo un permiso que nadie va a ejercer.
      if (tokens.access_token) {
        await this.client
          .revokeToken(tokens.access_token)
          .catch(() => undefined);
      }
    } catch (error) {
      // El detalle se queda en el log del servidor: al usuario, que el intento
      // no ha valido. Un mensaje que distinga «código caducado» de «código
      // inválido» solo ayuda a quien está probando códigos.
      this.logger.warn(
        `Fallo al canjear el código con Google: ${String(error)}`,
      );
      throw new UnauthorizedException(
        'No se pudo completar el acceso con Google.',
      );
    }

    if (!idToken) {
      throw new UnauthorizedException('Google no devolvió una identidad.');
    }

    const payload = await this.verifyIdToken(idToken);

    if (payload.nonce !== params.nonce) {
      this.logger.warn('ID token con nonce que no corresponde a la petición.');
      throw new UnauthorizedException(
        'No se pudo completar el acceso con Google.',
      );
    }
    if (!payload.email || payload.email_verified !== true) {
      throw new UnauthorizedException({
        code: 'EMAIL_UNVERIFIED',
        message:
          'Tu cuenta de Google no tiene el correo verificado. Verifícalo y vuelve a intentarlo.',
      });
    }

    return { sub: payload.sub, email: payload.email.toLowerCase() };
  }

  private async verifyIdToken(idToken: string) {
    try {
      const ticket = await this.client.verifyIdToken({
        idToken,
        audience: this.clientId,
      });
      const payload = ticket.getPayload();
      if (!payload?.sub) throw new Error('payload sin sub');
      return payload;
    } catch (error) {
      this.logger.warn(`ID token de Google no válido: ${String(error)}`);
      throw new UnauthorizedException(
        'No se pudo completar el acceso con Google.',
      );
    }
  }

  /**
   * Igual que `requireSecret`, pero para la configuración de Google.
   *
   * El `client_id` no es un secreto y el `redirect_uri` tampoco, así que no
   * tiene sentido exigirles longitud mínima; lo que sí se exige es que estén.
   * Una API que arranca sin ellos es una API donde nadie puede entrar, y es
   * mejor descubrirlo al desplegar que cuando lo cuenta el primer usuario.
   */
  private require(config: ConfigService, key: string): string {
    const value = (config.get<string>(key) ?? '').trim();
    if (!value) {
      throw new Error(
        `Falta ${key}. Créala en Google Cloud Console (credenciales OAuth 2.0, ` +
          'tipo "aplicación web") y añádela al .env antes de arrancar la API.',
      );
    }
    return value;
  }
}
