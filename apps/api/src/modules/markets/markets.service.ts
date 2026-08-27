import {
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { MarketSpec } from '@crypton/shared';
import { createPublicAdapter } from '@crypton/exchange-core';
import { Venue } from '@crypton/db';
import { CacheService, DbService } from 'src/libs';

/**
 * Sincroniza y sirve los metadatos de mercado.
 *
 * Estos datos —tick, step, notional mínimo, apalancamiento máximo— son los que
 * deciden si una orden es válida antes de mandarla. Se guardan en BD y no solo
 * en memoria del worker por dos motivos: la API los necesita para validar y
 * pintar el preview sin credenciales del usuario, y así un venue caído no deja
 * la aplicación sin poder mostrar nada.
 */
@Injectable()
export class MarketsService implements OnModuleInit {
  private readonly logger = new Logger(MarketsService.name);

  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
  ) {}

  /**
   * El catálogo de pares.
   *
   * `select` explícito, no la fila entera. Dos razones, y la segunda importa
   * más que el ahorro: enumera lo que sale, así que añadir mañana una columna a
   * `markets` no empieza a mandarla sola a todos los móviles. Lo que se
   * enumera es exactamente el modelo `Market` que ya declara el cliente; `id`,
   * `min_qty`, `max_qty` y `updated_at` no los lee nadie y los tres `numeric`
   * ocupan veinte caracteres cada uno. Medido sobre los 935 pares activos: 342
   * KB la fila entera, 154 KB así.
   *
   * `take` es un fusible, no una página. Estaba en 500 y hay 935 pares
   * activos —177 Hyperliquid, 212 Lighter, 546 Aster—; como ordena por venue,
   * los últimos 435 de Aster NO EXISTÍAN para la aplicación: ni en la lista, ni
   * en el buscador, ni al crear un bot. Se sube muy por encima del catálogo
   * real para que siga acotando una consulta desbocada sin recortar nada de lo
   * que hay.
   *
   * Sin paginar a propósito. Comprimido son 11 KB —el proxy ya declara gzip
   * para `application/json`— y se pide UNA vez por apertura, con caché en el
   * cliente. Paginar añadiría un viaje por página y, sobre todo, rompería el
   * orden por volumen de la lista: el volumen no está en esta tabla, viene de
   * los tickers, así que ordenar por él exige tener el catálogo entero.
   */
  async list(venue?: Venue, search?: string, testnet = false) {
    return this.db.market.findMany({
      where: {
        ...(venue ? { venue } : {}),
        testnet,
        active: true,
        ...(search
          ? {
              OR: [
                { symbol: { contains: search, mode: 'insensitive' as const } },
                {
                  canonical: { contains: search, mode: 'insensitive' as const },
                },
              ],
            }
          : {}),
      },
      select: {
        venue: true,
        testnet: true,
        symbol: true,
        canonical: true,
        base: true,
        quote: true,
        tick_size: true,
        step_size: true,
        min_notional: true,
        // Los pide `MarketSpec`, y sin ellos el preview que la app calcula en local
        // no detectaria las mismas violaciones que el del servidor.
        min_qty: true,
        max_qty: true,
        max_leverage: true,
        price_decimals: true,
        qty_decimals: true,
        active: true,
      },
      orderBy: [{ venue: 'asc' }, { symbol: 'asc' }],
      take: 5_000,
    });
  }

  /**
   * Spec en el formato que consumen strategy-core y exchange-core.
   *
   * La red es parte de la identidad del mercado, no un filtro opcional: el tick
   * y el step de testnet no son los de mainnet, y devolver los que no son deja
   * al bot construyendo ordenes que el venue rechaza una por una.
   */
  async getSpec(
    venue: Venue,
    symbol: string,
    testnet = false,
  ): Promise<MarketSpec> {
    const market = await this.db.market.findUnique({
      where: { venue_testnet_symbol: { venue, testnet, symbol } },
    });
    if (!market) {
      throw new NotFoundException(
        `El mercado ${symbol} no está disponible en ${venue}` +
          (testnet ? ' (testnet).' : '.'),
      );
    }
    return {
      venue: market.venue,
      symbol: market.symbol,
      canonical: market.canonical,
      base: market.base,
      quote: market.quote,
      tickSize: market.tick_size.toString(),
      stepSize: market.step_size.toString(),
      minNotional: market.min_notional?.toString() ?? null,
      minQty: market.min_qty?.toString() ?? null,
      maxQty: market.max_qty?.toString() ?? null,
      maxLeverage: market.max_leverage,
      priceDecimals: market.price_decimals,
      qtyDecimals: market.qty_decimals,
      active: market.active,
    };
  }

  /**
   * Refresca los mercados de un venue con un adaptador SIN credenciales.
   *
   * Antes se tomaba prestada «cualquier conexión verificada» del venue, lo que
   * significaba descifrar la clave privada de un usuario cualquiera —elegido
   * por orden de verificación— para leer unos metadatos que son públicos. Ni el
   * cron ni el endpoint tienen por qué tocar el secreto de nadie.
   *
   * Efecto colateral bueno: ahora se sincroniza aunque todavía no haya ninguna
   * cuenta conectada en ese venue, así que el catálogo de mercados está listo
   * antes de que el primer usuario llegue.
   */
  async syncVenue(venue: Venue, testnet = false): Promise<number> {
    const adapter = createPublicAdapter(venue, { testnet });
    try {
      const specs = await adapter.getMarkets();
      await this.upsertAll(specs, testnet);
      const red = testnet ? ' (testnet)' : '';
      this.logger.log(
        `${specs.length} mercados sincronizados en ${venue}${red}`,
      );
      return specs.length;
    } finally {
      await adapter.close().catch(() => undefined);
    }
  }

  private async upsertAll(
    specs: MarketSpec[],
    testnet: boolean,
  ): Promise<void> {
    // En serie y no en paralelo: son unos cientos de filas y hacerlo a la vez
    // agotaría el pool de conexiones sin ganar nada apreciable.
    for (const spec of specs) {
      const data = {
        canonical: spec.canonical,
        base: spec.base,
        quote: spec.quote,
        tick_size: spec.tickSize,
        step_size: spec.stepSize,
        min_notional: spec.minNotional,
        min_qty: spec.minQty,
        max_qty: spec.maxQty,
        max_leverage: spec.maxLeverage,
        price_decimals: spec.priceDecimals,
        qty_decimals: spec.qtyDecimals,
        active: spec.active,
      };
      await this.db.market.upsert({
        where: {
          venue_testnet_symbol: {
            venue: spec.venue,
            testnet,
            symbol: spec.symbol,
          },
        },
        create: { venue: spec.venue, testnet, symbol: spec.symbol, ...data },
        update: data,
      });
    }
  }

  /**
   * Cada 15 minutos. En Hyperliquid no es opcional: su tick depende de la
   * magnitud del precio, así que un mercado que se mueve mucho cambia de tick
   * y las órdenes empezarían a rechazarse con la spec vieja.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async syncAll(): Promise<void> {
    // Un solo replica sincroniza. `@Cron` dispara en TODAS: con varias, cada
    // ciclo hacía N veces las mismas llamadas al venue y N veces los mismos
    // cientos de upserts, compitiendo por las mismas filas.
    if (!(await this.cache.setnx('lock:markets-sync', Date.now(), 300))) return;

    // LAS DOS REDES, SIEMPRE.
    //
    // Antes testnet solo se sincronizaba si ya existia una cuenta de testnet, y
    // eso ponia el catalogo detras de la cuenta cuando el orden natural es el
    // contrario: mirar los mercados, y luego conectar. El resultado era una
    // pantalla de Mercados VACIA para quien encendia la lente sin cuentas, y
    // hasta diez minutos de espera —lo que tarda el siguiente ciclo— antes de
    // poder crear el primer bot en testnet.
    //
    // Lo que ahorraba era tres llamadas cada diez minutos sobre catalogos de
    // 210, 18 y 3 mercados. No compensaba.
    for (const venue of Object.values(Venue)) {
      for (const testnet of [false, true]) {
        try {
          await this.syncVenue(venue, testnet);
        } catch (e) {
          const red = testnet ? ' (testnet)' : '';
          this.logger.warn(
            `No se pudo sincronizar ${venue}${red}: ${(e as Error).message}`,
          );
        }
      }
    }
  }

  /**
   * Sincroniza al arrancar, sin bloquear el arranque.
   *
   * El cron corre cada diez minutos, asi que un despliegue nuevo —o uno que se
   * reinicia con la tabla vacia— podia pasar ese rato entero sirviendo un
   * catalogo que no existe: la lista de mercados vacia y la creacion de bots
   * respondiendo «mercado no disponible». El cerrojo `lock:markets-sync` que ya
   * usa `syncAll` impide que varias replicas lo hagan a la vez.
   *
   * `void` a proposito: si un venue no responde, la API tiene que arrancar
   * igual. Lo que no puede es quedarse esperando a tres DEX para servir un
   * `/health`.
   */
  onModuleInit(): void {
    void this.syncAll().catch((e) => {
      this.logger.warn(
        `Sincronizacion inicial incompleta: ${(e as Error).message}`,
      );
    });
  }
}
