import { HttpClient } from '@angular/common/http';
import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import type { CapitalSnapshot } from '../models';
import { NetworkService } from './network.service';

/**
 * Cuanto vale el saldo cacheado en el cliente.
 *
 * DIEZ segundos, deliberadamente por debajo de los quince que cachea el
 * servidor. Asi el gesto manual de refrescar llega de verdad a la API en vez de
 * rebotar contra este memo y devolver exactamente lo mismo: un boton de
 * refrescar que no refresca es peor que no tenerlo.
 */
const MEMO_MS = 10_000;

/**
 * El saldo real de las conexiones de exchange, y con que topes choca.
 *
 * Hasta ahora la app no sabia cuanto dinero habia en ninguna parte: el campo
 * «Capital asignado» del asistente se rellenaba a ciegas y el desfase se
 * descubria en marcha, como un `INSUFFICIENT_FUNDS` del venue con la escalera
 * ya medio tendida.
 *
 * Regla de la casa, y aqui importa mas que en ningun otro servicio: `load()`
 * NUNCA lanza. El saldo es informacion de apoyo, y ninguna pantalla puede
 * quedarse a medias —ni impedir crear un bot— porque un exchange no conteste.
 */
/**
 * Con que se indexa un saldo.
 *
 * La conexion sola no basta desde que la simulacion es por BOT: dos bots de la
 * misma conexion tienen saldos distintos, y guardarlos bajo la misma clave hacia
 * que el ultimo en responder pisara al otro.
 */
const claveSaldo = (accountId: string, botId?: string): string =>
  botId ? `${accountId}:${botId}` : accountId;

@Injectable({ providedIn: 'root' })
export class WalletService {
  private readonly http = inject(HttpClient);
  private readonly network = inject(NetworkService);
  private readonly base = `${environment.apiUrl}/bots/capital`;

  /**
   * Saldo por conexion.
   *
   * Un mapa y no una sola instantanea porque hay dos consumidores con formas
   * distintas: el asistente mira una cuenta cada vez, y la pantalla de
   * conexiones las lista todas. La clave es SOLO el id de la cuenta —el simbolo
   * no entra— asi que `position` refleja la ultima peticion; hoy no lo consume
   * nadie, y cuando lo haga habra que separar esa parte.
   */
  readonly balances = signal<ReadonlyMap<string, CapitalSnapshot>>(new Map());

  readonly loading = signal(false);

  /**
   * Fallos SEGUIDOS al pedir el saldo.
   *
   * Un contador y no un booleano, por el mismo motivo que documenta
   * `MarketDataService.tickersFailures`: un fallo suelto en un movil es normal
   * y no merece alarmar a nadie.
   */
  readonly failures = signal(0);

  private readonly memo = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<void>>();

  constructor() {
    // Cambio de lente: lo que hay en pantalla es de la OTRA red.
    //
    // Vaciarlo no es cosmetico. Un saldo de mainnet debajo de la franja de
    // testnet es exactamente la confusion que la franja existe para impedir, y
    // aqui son dolares de verdad. Mismo patron `redAnterior` que ya usan
    // `MarketDataService` y la propia pagina del asistente.
    let redAnterior: boolean | null = null;
    effect(() => {
      const testnet = this.network.testnet();
      if (redAnterior === null) {
        redAnterior = testnet;
        return;
      }
      if (redAnterior === testnet) return;
      redAnterior = testnet;
      untracked(() => this.clear());
    });
  }

  /**
   * El saldo, si ya se ha pedido.
   *
   * El bot forma parte de la clave porque en una conexion de SIMULACION cada
   * uno tiene su propio sandbox: guardando solo por conexion, el saldo del
   * ultimo que respondiera se servia como el de todos.
   */
  of(accountId: string, botId?: string): CapitalSnapshot | undefined {
    return this.balances().get(claveSaldo(accountId, botId));
  }

  /**
   * Pide el saldo de una conexion, y la posicion abierta en el par si se da.
   *
   * @param opts.force salta el memo local. Es lo que hace el refresco manual.
   */
  load(
    accountId: string,
    symbol?: string,
    opts: { force?: boolean; botId?: string } = {},
  ): Promise<void> {
    if (!accountId) return Promise.resolve();

    // El bot entra en la clave: en una conexion de simulacion cada uno tiene su
    // propio saldo, asi que memorizar por (cuenta, par) le habria servido a uno
    // el sandbox de otro.
    const key = `${accountId}:${symbol ?? '-'}:${opts.botId ?? '-'}`;
    const at = this.memo.get(key) ?? 0;
    if (!opts.force && Date.now() - at < MEMO_MS && this.of(accountId, opts.botId)) {
      return Promise.resolve();
    }

    // Un solo vuelo por clave. Entrar al paso «Parámetros» dispara la carga por
    // el efecto de paso y por el cambio de par casi a la vez; sin esto salen dos
    // peticiones identicas, y cada una puede acabar en un descifrado de clave en
    // el servidor.
    const running = this.inflight.get(key);
    if (running && !opts.force) return running;

    const run = this.fetch(accountId, symbol, key, opts.botId).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, run);
    return run;
  }

  private async fetch(
    accountId: string,
    symbol: string | undefined,
    key: string,
    botId?: string,
  ): Promise<void> {
    this.loading.set(true);
    try {
      const params: Record<string, string> = { exchangeAccountId: accountId };
      if (symbol) params['symbol'] = symbol;
      if (botId) params['botId'] = botId;

      const snapshot = await firstValueFrom(
        this.http.get<CapitalSnapshot>(this.base, { params }),
      );

      const next = new Map(this.balances());
      next.set(claveSaldo(accountId, botId), snapshot);
      this.balances.set(next);
      this.memo.set(key, Date.now());

      // El endpoint responde 200 aunque el venue no conteste, asi que «no ha
      // fallado la peticion» no significa «hay saldo»: quien lo dice es
      // `unavailable`, y por eso los fallos se cuentan mirandolo a el.
      this.failures.set(snapshot.unavailable ? this.failures() + 1 : 0);
    } catch {
      // Se cuenta y se CONSERVA lo anterior. Vaciar aqui dejaria la cabecera en
      // blanco por un corte de red de dos segundos.
      this.failures.update((n) => n + 1);
    } finally {
      this.loading.set(false);
    }
  }

  /** Suelta lo que hubiera. Lo llama el cambio de red y el asistente al salir. */
  clear(): void {
    this.balances.set(new Map());
    this.failures.set(0);
    this.memo.clear();
  }
}
