import { Injectable, signal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';

const KEY = 'crypton.network.testnet';

/**
 * La red que se está MIRANDO. Es una lente, no un interruptor de operación.
 *
 * Lo que decide contra qué libro opera un bot es la cuenta a la que está atado
 * —`exchange_accounts.testnet`, en el servidor— y esto no puede cambiarlo. Aquí
 * solo se elige qué se enseña: qué cuentas salen en la lista, de qué red se
 * piden los mercados y los precios, y si se enciende la franja de la barra.
 *
 * La separación es deliberada y es lo que hace segura la funcionalidad: un bot
 * de mainnet en marcha sigue operando en mainnet aunque la lente esté en
 * testnet, porque esta señal no llega jamás a un camino que firme una orden.
 *
 * Se guarda EN EL DISPOSITIVO, igual que los favoritos y por el mismo motivo
 * que explica `FavouriteMarketsService`: es una preferencia de lectura, no un
 * dato de la cuenta.
 */
@Injectable({ providedIn: 'root' })
export class NetworkService {
  /**
   * Signal y no una promesa: la franja y las listas se pintan con `computed`,
   * y detrás de un `await` la primera pintada saldría siempre en mainnet y
   * cambiaría de golpe medio segundo después.
   */
  private readonly _testnet = signal(false);
  readonly testnet = this._testnet.asReadonly();

  constructor() {
    void this.load();
  }

  set(testnet: boolean): void {
    if (this._testnet() === testnet) return;
    this._testnet.set(testnet);
    // Sin bloquear: la interfaz ya ha cambiado y que la escritura en disco
    // tarde no puede retrasarla.
    void Preferences.set({ key: KEY, value: testnet ? '1' : '0' }).catch(() => undefined);
  }

  toggle(): void {
    this.set(!this._testnet());
  }

  private async load(): Promise<void> {
    try {
      const { value } = await Preferences.get({ key: KEY });
      // Solo `'1'` enciende testnet. Cualquier otra cosa —ausente, corrupta, de
      // una versión anterior— cae en mainnet, que es la lectura segura: la peor
      // consecuencia de fallar hacia mainnet es ver la red que no tocaba; fallar
      // hacia testnet dejaría la cartera real escondida sin explicación.
      this._testnet.set(value === '1');
    } catch {
      // No poder leer una preferencia no puede impedir que se abra la app.
    }
  }
}
