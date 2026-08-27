import { D, type MarketSpec, type Venue } from '@crypton/shared';

/**
 * Caché de especificaciones de mercado.
 *
 * Sin la spec no se puede construir NI UNA orden válida: cada precio hay que
 * redondearlo al tick del venue y cada cantidad al step, o la orden se rechaza.
 * Pedirla en cada tick sería tirar el caudal de la API a la basura, así que se
 * cachea con TTL y se refresca en segundo plano.
 */
export class MarketSpecCache {
  private specs = new Map<string, MarketSpec>();
  private fetchedAt = 0;
  private inflight: Promise<MarketSpec[]> | null = null;

  constructor(
    private readonly loader: () => Promise<MarketSpec[]>,
    private readonly ttlMs = 5 * 60_000,
  ) {}

  async all(force = false): Promise<MarketSpec[]> {
    const stale = Date.now() - this.fetchedAt > this.ttlMs;
    if (!force && !stale && this.specs.size > 0) return [...this.specs.values()];

    // Una sola petición en vuelo: al arrancar, veinte bots del mismo venue
    // piden la spec a la vez y sin esto serían veinte llamadas idénticas.
    if (!this.inflight) {
      this.inflight = this.loader()
        .then((specs) => {
          this.specs = new Map(specs.map((s) => [s.symbol, s]));
          this.fetchedAt = Date.now();
          return specs;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  async get(symbol: string): Promise<MarketSpec> {
    let spec = (await this.all()).find((s) => s.symbol === symbol);
    if (!spec) {
      // Puede ser un listado nuevo: se fuerza un refresco antes de rendirse.
      spec = (await this.all(true)).find((s) => s.symbol === symbol);
    }
    if (!spec) throw new Error('Mercado desconocido: ' + symbol);
    return spec;
  }

  peek(symbol: string): MarketSpec | undefined {
    return this.specs.get(symbol);
  }

  invalidate(): void {
    this.fetchedAt = 0;
  }
}

/** Número de decimales implícito en un tamaño de paso ('0.001' → 3). */
export function decimalsOf(step: string): number {
  const s = D(step).toFixed();
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

/** Construye el símbolo canónico que agrupa el mismo par entre venues. */
export const canonicalSymbol = (base: string, quote: string): string => base + '/' + quote;

export const marketKey = (venue: Venue, symbol: string): string => venue + ':' + symbol;
