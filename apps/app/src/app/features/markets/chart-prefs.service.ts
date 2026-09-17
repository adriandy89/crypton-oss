import { Injectable, signal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import { esClaveIndicador, type ClaveIndicador } from '@crypton/strategy-core';
import type { ChartSeriesKind } from '../../shared/chart';

const KEY = 'crypton.chart.prefs';
/** Sube cuando la forma guardada deja de ser compatible: lo viejo se descarta. */
const VERSION = 1;

/** Las capas del bot sobre el gráfico, tal y como las enciende la leyenda. */
export interface CapasGrafico {
  ladder: boolean;
  planned: boolean;
  fills: boolean;
  liquidation: boolean;
  events: boolean;
  canal: boolean;
}

export interface AjustesGrafico {
  kind: ChartSeriesKind;
  volumen: boolean;
  resultado: boolean;
  capas: CapasGrafico;
  indicadores: ClaveIndicador[];
}

/** Lo que ve quien abre el gráfico por primera vez, y a lo que se vuelve si lo
 *  guardado no se entiende. */
export const AJUSTES_DE_FABRICA: AjustesGrafico = {
  kind: 'candles',
  volumen: true,
  resultado: false,
  capas: { ladder: true, planned: true, fills: true, liquidation: true, events: true, canal: true },
  indicadores: [],
};

/**
 * Lo que el gráfico recuerda de una visita a otra (spec 061).
 *
 * Se guarda EN EL DISPOSITIVO y no en el servidor, con el mismo criterio que
 * los favoritos: es una preferencia de lectura, no un dato de la cuenta, y
 * llevarla al servidor significaría una tabla, un endpoint y una migración para
 * algo que no cambia ni una orden.
 *
 * `@capacitor/preferences` y no `localStorage` a pelo: en web escribe justo
 * ahí, y en el móvil en el almacén nativo, que es donde tiene que estar. Es el
 * patrón que ya usan los favoritos y la lente de red.
 *
 * El intervalo NO se guarda: viaja en la URL, y abrir siempre en el último que
 * se miró cambiaría lo que se pide al venue sin que nadie lo haya pedido.
 */
@Injectable({ providedIn: 'root' })
export class ChartPrefsService {
  /**
   * Signal y no una promesa: la pantalla se construye con lo que haya y lo
   * guardado llega un instante después; detrás de un `await` la primera pintada
   * saldría siempre de fábrica.
   */
  private readonly _ajustes = signal<AjustesGrafico>(AJUSTES_DE_FABRICA);
  readonly ajustes = this._ajustes.asReadonly();

  /** «Ya se ha mirado el almacén». Falso también mientras la lectura falla. */
  private readonly _cargado = signal(false);
  readonly cargado = this._cargado.asReadonly();

  constructor() {
    void this.cargar();
  }

  /** Guarda lo que cambie, sin bloquear: la interfaz ya lo ha aplicado. */
  guardar(parcial: Partial<AjustesGrafico>): void {
    const siguiente = { ...this._ajustes(), ...parcial };
    this._ajustes.set(siguiente);
    void Preferences.set({
      key: KEY,
      value: JSON.stringify({ v: VERSION, ...siguiente }),
    }).catch(() => undefined);
  }

  private async cargar(): Promise<void> {
    try {
      const { value } = await Preferences.get({ key: KEY });
      if (value) this._ajustes.set(leer(value));
    } catch {
      // No poder leer una preferencia no puede impedir que se abra el gráfico:
      // se queda lo de fábrica y la próxima escritura lo deja bien.
    } finally {
      this._cargado.set(true);
    }
  }
}

/**
 * De lo guardado a unos ajustes válidos.
 *
 * Nada se da por bueno: una versión distinta, un JSON roto o un indicador que
 * ya no existe caen en el valor de fábrica, campo a campo. Es la misma regla
 * que la lente de red: ante la duda, lo seguro.
 */
function leer(bruto: string): AjustesGrafico {
  const dato: unknown = JSON.parse(bruto);
  if (typeof dato !== 'object' || dato === null) return AJUSTES_DE_FABRICA;
  const o = dato as Record<string, unknown>;
  if (o['v'] !== VERSION) return AJUSTES_DE_FABRICA;

  const capas = { ...AJUSTES_DE_FABRICA.capas };
  const guardadas = o['capas'];
  if (typeof guardadas === 'object' && guardadas !== null) {
    for (const clave of Object.keys(capas) as (keyof CapasGrafico)[]) {
      const v = (guardadas as Record<string, unknown>)[clave];
      if (typeof v === 'boolean') capas[clave] = v;
    }
  }

  const indicadores = Array.isArray(o['indicadores'])
    ? o['indicadores'].filter((c): c is ClaveIndicador => esClaveIndicador(c))
    : [];

  return {
    kind: o['kind'] === 'bars' ? 'bars' : 'candles',
    volumen: typeof o['volumen'] === 'boolean' ? o['volumen'] : AJUSTES_DE_FABRICA.volumen,
    resultado: typeof o['resultado'] === 'boolean' ? o['resultado'] : AJUSTES_DE_FABRICA.resultado,
    capas,
    indicadores,
  };
}
