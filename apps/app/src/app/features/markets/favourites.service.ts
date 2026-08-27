import { Injectable, signal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import { venueKey } from '@crypton/shared';
import type { Venue } from '../../core/models';

const KEY = 'crypton.markets.favourites';

/**
 * Pares marcados como favoritos.
 *
 * Se guardan EN EL DISPOSITIVO y no en el servidor a propósito: es una
 * preferencia de lectura, no un dato de la cuenta, y llevarla al servidor
 * significaría una tabla, un endpoint y una migración para algo que no cambia
 * ni una orden. Si el usuario cambia de móvil, marcar cuatro pares otra vez
 * cuesta menos que todo eso.
 *
 * La clave es `VENUE:SYMBOL`: el mismo activo en dos plataformas son dos
 * mercados distintos, con su propio precio y su propia liquidez. Y por el mismo
 * motivo lleva tambien la RED —`venueKey`—: el BTC de testnet no es el de
 * mainnet. Mainnet no lleva sufijo, asi que los favoritos ya guardados siguen
 * valiendo sin migrar nada.
 */
@Injectable({ providedIn: 'root' })
export class FavouriteMarketsService {
  /**
   * Signal y no una promesa: la lista se pinta con `computed`, y con un Set
   * detrás de un `await` la primera pintada saldría sin ningún favorito y
   * saltarían todos de golpe medio segundo después.
   */
  private readonly keys = signal<ReadonlySet<string>>(new Set());

  constructor() {
    void this.load();
  }

  /**
   * La clave de un par EN UNA RED.
   *
   * Existe como metodo y no como plantilla suelta en cada pantalla porque no
   * coincide con la clave `VENUE:SIMBOLO` que esas pantallas ya manejan: esa es
   * el formato de cable con el que se declara el interes al servidor y no puede
   * llevar la red dentro. Dos claves parecidas y con proposito distinto es
   * exactamente como se cruzan; teniendo esta un nombre, no hay duda.
   */
  keyOf(venue: Venue, symbol: string, testnet: boolean): string {
    return `${venueKey(venue, testnet)}:${symbol}`;
  }

  has(key: string): boolean {
    return this.keys().has(key);
  }

  toggle(key: string): void {
    const next = new Set(this.keys());
    if (!next.delete(key)) next.add(key);
    this.keys.set(next);
    // Sin bloquear: el usuario ya ve la estrella encendida, y que la escritura
    // en disco tarde no puede retrasar la interfaz.
    void Preferences.set({ key: KEY, value: JSON.stringify([...next]) }).catch(() => undefined);
  }

  private async load(): Promise<void> {
    try {
      const { value } = await Preferences.get({ key: KEY });
      if (!value) return;
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) {
        this.keys.set(new Set(parsed.filter((k): k is string => typeof k === 'string')));
      }
    } catch {
      // Un valor corrupto no puede impedir que se abra la pantalla: se ignora y
      // la próxima escritura lo sustituye por uno bueno.
    }
  }
}
