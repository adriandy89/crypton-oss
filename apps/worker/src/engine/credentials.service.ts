import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Venue } from '@crypton/shared';
import {
  createAdapter,
  createPublicAdapter,
  serviceCredentials,
  type ExchangeAdapter,
  type VenueCredentials,
} from '@crypton/exchange-core';
import { DbService, EnvelopeService, VenueBudgetProvider, type SealedPayload } from '../libs';

/**
 * Abre adaptadores autenticados a partir de las credenciales guardadas.
 *
 * Es el ÚNICO punto del worker por el que un secreto vuelve a memoria. Se
 * descifra al arrancar el bot, vive en el proceso mientras el bot opera y no se
 * escribe en ningún sitio: ni en Redis, ni en disco, ni en un log.
 *
 * La SIMULACIÓN no pasa por aquí en absoluto: va por `openPriceSource`, que no
 * tiene nada que descifrar. Ver ese método.
 */
@Injectable()
export class CredentialsService {
  private readonly logger = new Logger(CredentialsService.name);

  constructor(
    private readonly db: DbService,
    private readonly envelope: EnvelopeService,
    private readonly budget: VenueBudgetProvider,
    private readonly config: ConfigService,
  ) {}

  async openAdapter(exchangeAccountId: string, dryRun: boolean): Promise<ExchangeAdapter> {
    const account = await this.db.exchangeAccount.findUniqueOrThrow({
      where: { id: exchangeAccountId },
    });

    // Este método abre CREDENCIALES, así que solo lo usan los bots que operan de
    // verdad. Una cuenta de simulación no tiene ninguna, y llegar aquí con una
    // significaría que alguien se ha saltado el camino bueno: se para en seco en
    // lugar de intentar descifrar columnas vacías.
    if (account.paper) {
      throw new Error(
        `La cuenta ${exchangeAccountId.slice(0, 8)} es de simulación y no tiene credencial que abrir.`,
      );
    }

    // El sobre es nullable desde que existen las cuentas de simulacion, y la
    // base lo defiende con un CHECK. Llegar aqui sin el significaria que ese
    // CHECK no esta puesto: se para en seco en vez de arrastrar el nulo hasta
    // el descifrador, que fallaria diciendo algo mucho menos util.
    if (
      !account.enc_payload ||
      !account.enc_dek ||
      !account.enc_iv ||
      !account.enc_tag ||
      !account.enc_key_id
    ) {
      throw new Error(
        `La cuenta ${exchangeAccountId.slice(0, 8)} no es de simulacion y no tiene credencial guardada.`,
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

    return createAdapter(credentials, {
      dryRun,
      // La red sale de la CUENTA y de ningún otro sitio. Es lo único que decide
      // contra qué libro acaba operando esta clave, así que no puede venir de la
      // configuración del bot ni de una preferencia de la interfaz: un bot de
      // mainnet no debe poder acabar en testnet ni al revés.
      testnet: account.testnet,
      // El builder solo se adjunta si el usuario firmó la aprobación en el
      // venue: sin ella, el exchange rechaza la orden ENTERA, no solo la
      // comisión, así que ponerlo "por si acaso" rompería el bot.
      builderAddress: account.builder_approved
        ? this.config.get<string>('BUILDER_ADDRESS') || undefined
        : undefined,
      builderFeeTenthBps: account.builder_approved
        ? Number(this.config.get<string>('BUILDER_FEE_TENTH_BPS', '0')) || undefined
        : undefined,
      // Este acota lo que manda ESTA cuenta. Como el adaptador ahora se
      // comparte entre todos los bots de la cuenta (ver `AccountHub`), el
      // número por fin significa lo que dice: antes había uno por bot y diez
      // bots mandaban ochenta peticiones por segundo con el límite puesto a
      // ocho.
      rateLimitPerSecond: Number(this.config.get('VENUE_RATE_LIMIT_PER_SECOND', 8)),
      // Y este, lo que manda todo lo que sale por esta IP — incluido el feed
      // público de precios, que usa el mismo objeto.
      budget: this.budget.budget,
    });
  }

  /**
   * La fuente de precios contra la que corre la simulación.
   *
   * Sin la credencial de NINGÚN usuario, y eso es lo importante: un simulador
   * nunca firma, así que descifrar la clave de alguien para envolverla era pagar
   * el riesgo de tener un secreto en memoria a cambio de nada. Vale igual para
   * un bot simulado sobre una conexión REAL, que hasta ahora sí la descifraba.
   *
   * Lo que sí lleva es la cuenta de SERVICIO de la plataforma, y conviene ser
   * preciso: en Lighter mainnet eso devuelve un adaptador capaz de firmar. No se
   * usa para eso —solo lo envuelve el simulador, que jamás delega una escritura—
   * y es el mismo trato que le da `MarketDataService` al feed público. Quien
   * añada aquí otro uso tiene que saberlo.
   *
   * Devuelve el adaptador desnudo, no el simulador: quien lo pide —`AccountHub`—
   * lo comparte entre todos los bots simulados del mismo venue y monta un
   * `DryRunAdapter` propio encima. Cien bots, cien sandboxes, una conexión.
   */
  openPriceSource(venue: Venue, testnet: boolean): ExchangeAdapter {
    const { credentials, notice } = serviceCredentials(venue, this.config);
    // El modo elegido se anuncia UNA vez por venue: firmando o sin firmar hay un
    // factor enorme de diferencia en el cupo, y decidirlo en silencio es como se
    // llega a un incidente que nadie sabe explicar. En testnet no hay nada que
    // anunciar: allí `createPublicAdapter` descarta la cuenta de servicio.
    if (notice && !testnet) this.logger.log(notice);

    return createPublicAdapter(venue, {
      testnet,
      // La cuenta de SERVICIO de la plataforma, que es lo que sube el cupo de
      // lecturas en Lighter. No es la de ningún usuario y no puede serlo: este
      // camino existe precisamente para no descifrar la clave de nadie.
      service: credentials,
      rateLimitPerSecond: Number(this.config.get('VENUE_RATE_LIMIT_PER_SECOND', 8)),
      budget: this.budget.budget,
    });
  }
}
