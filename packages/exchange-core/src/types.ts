import type { Observable } from 'rxjs';
import type { VenueBudget } from './venue-budget';
import type {
  Balance,
  Candle,
  CandleInterval,
  CancelRequest,
  Fill,
  MarginAction,
  MarginMode,
  MarketSpec,
  MarketTicker,
  ModifyRequest,
  OrderAck,
  OrderUpdate,
  PlaceOrderRequest,
  Position,
  PositionMode,
  PositionSide,
  Ticker,
  VenueCapabilities,
  VenueOrder,
  Venue,
} from '@crypton/shared';

/**
 * Credenciales descifradas de una cuenta de exchange. Solo viven en memoria del
 * proceso: nunca se serializan, ni se registran, ni se guardan en Redis.
 */
export type VenueCredentials =
  | {
      venue: 'HYPERLIQUID';
      /** Dirección de la wallet PRINCIPAL: es la que identifica la cuenta. */
      accountAddress: string;
      /** Clave privada de la API wallet (agent). Nunca la de la principal. */
      agentPrivateKey: string;
      /**
       * HEREDADO. La red vive ahora en `AdapterOptions.testnet`, que sale de la
       * columna `exchange_accounts.testnet`. Se sigue leyendo porque las cuentas
       * creadas antes lo llevan DENTRO del sobre cifrado y volver a abrirlas para
       * migrarlo costaría descifrar la clave de todo el mundo sin ganar nada.
       */
      testnet?: boolean;
    }
  | {
      venue: 'LIGHTER';
      accountIndex: number;
      apiKeyIndex: number;
      apiPrivateKey: string;
      /**
       * HEREDADO. La URL la decide `VENUE_ENDPOINTS` a partir de la red. Sigue
       * teniendo prioridad por los sobres ya sellados que lo llevan; la API ya
       * no lo acepta de un cliente.
       */
      baseUrl?: string;
    }
  | {
      venue: 'ASTER';
      /** Dirección del usuario (la que tiene los fondos). */
      userAddress: string;
      /** Dirección de la API wallet autorizada a firmar. */
      signerAddress: string;
      signerPrivateKey: string;
      /** HEREDADO. Ver la nota de `baseUrl` en LIGHTER. */
      baseUrl?: string;
    };

export interface AdapterOptions {
  /**
   * Código de builder/integrator que se adjunta a cada orden. Es el mecanismo
   * de monetización de los DEX soportados y requiere que el usuario lo haya
   * aprobado con su wallet principal; sin aprobación, el venue rechaza la orden
   * con el builder puesto, así que se omite mientras no esté confirmada.
   */
  builderAddress?: string;
  /** Comisión de builder en décimas de punto básico (1 = 0,0001 %). */
  builderFeeTenthBps?: number;
  /** Peticiones por segundo permitidas hacia el venue. */
  rateLimitPerSecond?: number;
  /**
   * Presupuesto compartido por venue e IP.
   *
   * `rateLimitPerSecond` acota lo que manda ESTE adaptador; esto acota lo que
   * manda todo lo que sale por la misma IP, que es el ámbito en el que los DEX
   * cuentan de verdad. Sin él, cada adaptador se creía dueño del presupuesto
   * entero y con cien de ellos el venue empezaba a devolver 429 a todos.
   */
  budget?: VenueBudget;
  /**
   * Red del venue contra la que opera este adaptador.
   *
   * Es la ÚNICA forma legítima de elegir testnet: de aquí sale la URL, que sale
   * a su vez de `VENUE_ENDPOINTS`. Se decide al construir el adaptador y no en
   * cada llamada, igual que `dryRun`, para que ningún camino posterior pueda
   * mandar una orden a la red equivocada.
   *
   * Quien lo pone es siempre el servidor a partir de `exchange_accounts.testnet`
   * —la red pertenece a la cuenta—, nunca el cliente.
   */
  testnet?: boolean;
  /**
   * URL del WebSocket del venue. Solo para pruebas: apunta a un servidor local
   * en la batería de tests. Para elegir la red del venue está `testnet`, que es
   * lo que consulta `VENUE_ENDPOINTS`.
   */
  wsUrl?: string;
}

/**
 * Interfaz única de exchange. Todo lo que diferencia a un venue de otro
 * —formato de símbolo, escalado de precios, esquema de firma, códigos de
 * error— queda encerrado detrás de esto. El motor de bots no sabe en qué DEX
 * está operando, y ese es exactamente el punto.
 */
/** Rango de velas que se pide. `endMs` ausente = hasta ahora. */
export interface CandleQuery {
  startMs: number;
  endMs?: number;
  /** Tope de velas devueltas. El adaptador lo acota a su propio `maxBars`. */
  limit?: number;
}

export interface ExchangeAdapter {
  readonly venue: Venue;

  /**
   * Lo que este venue sabe hacer. Es ESTÁTICO por venue y se declara aquí en
   * lugar de vivir en una tabla del backend o —peor— del frontend: añadir un
   * venue debe consistir en escribir su adaptador y nada más.
   */
  readonly capabilities: VenueCapabilities;

  /** Comprueba credenciales con una llamada de SOLO LECTURA. */
  verify(): Promise<{ ok: boolean; publicRef: string; detail?: string }>;

  // ── Metadatos y estado ────────────────────────────────────────
  getMarkets(): Promise<MarketSpec[]>;
  getBalances(): Promise<Balance[]>;
  getPositions(symbol?: string): Promise<Position[]>;
  getOpenOrders(symbol?: string): Promise<VenueOrder[]>;
  getTicker(symbol: string): Promise<Ticker>;

  /**
   * Precio y estadísticas de 24 h de TODOS los mercados, en una sola llamada.
   *
   * En lote y no por símbolo a propósito: la lista de mercados enseña
   * doscientos pares, y pedirlos uno a uno gastaría el presupuesto de caudal
   * de la IP entero para pintar una pantalla de solo lectura. Los tres venues
   * lo dan agregado —Hyperliquid en `metaAndAssetCtxs`, Lighter en
   * `orderBookDetails`, Aster en `ticker/24hr` sin símbolo—, así que la
   * interfaz recoge esa forma en vez de pelearse con ella.
   */
  getTickers(): Promise<MarketTicker[]>;

  /**
   * Velas OHLCV, ya normalizadas y ordenadas de más antigua a más reciente.
   *
   * Un intervalo que no esté en `capabilities.candles.intervals` es un error
   * del llamante: se comprueba ANTES de llegar al venue para poder dar un
   * mensaje legible en vez de propagar el fallo opaco que devuelve cada uno.
   */
  getCandles(symbol: string, interval: CandleInterval, query: CandleQuery): Promise<Candle[]>;

  /**
   * Ejecuciones recientes de ESTA cuenta, posteriores a `sinceMs`.
   *
   * Es la red de seguridad del ledger. Los fills llegan normalmente por
   * WebSocket, pero un stream puede caerse, reconectar tarde o —como pasaba en
   * Lighter— no existir siquiera. Sin este camino, el motor decía "se sigue
   * reconciliando por REST" mientras la contabilidad del ciclo se quedaba
   * congelada: sin fills no hay precio medio, ni PnL, ni cierre de ciclo.
   *
   * Reprocesar es gratis: el ledger deduplica por `venue_fill_id`.
   */
  getRecentFills(symbol: string, sinceMs: number): Promise<Fill[]>;

  // ── Ejecución ─────────────────────────────────────────────────
  /**
   * `clientOrderId` llega en formato CANÓNICO; cada adaptador lo traduce al
   * formato que exige su venue (hex de 16 bytes en Hyperliquid, entero en
   * Lighter, string en Aster). La traducción es determinista, de modo que el
   * motor puede reconocer sus propias órdenes comparando en espacio de venue.
   */
  placeOrder(req: PlaceOrderRequest): Promise<OrderAck>;
  cancelOrder(req: CancelRequest): Promise<void>;
  /**
   * Cancela SOLO los ids indicados.
   *
   * `cancelAll` tiene alcance de cuenta o de símbolo según el venue, así que
   * pausar un bot borraba las órdenes de los demás bots de la misma cuenta y
   * las que el usuario hubiera puesto a mano — justo lo que el reconciliador se
   * cuida de respetar. Todo camino que quiera limpiar UN bot usa esto; solo el
   * kill-switch global, que sí quiere alcance de cuenta, usa `cancelAll`.
   */
  cancelOwn(symbol: string, clientOrderIds: string[]): Promise<void>;
  cancelAll(symbol: string): Promise<void>;
  modifyOrder?(req: ModifyRequest): Promise<OrderAck>;

  // ── Configuración previa del mercado ──────────────────────────
  setLeverage(symbol: string, leverage: number, mode: MarginMode): Promise<void>;
  setPositionMode?(mode: PositionMode): Promise<void>;

  /**
   * Añade o retira colateral de una posición AISLADA.
   *
   * Es lo único que mueve el precio de liquidación sin tocar la posición: en
   * aislado la caja de esa posición es lo que la sostiene, y engordarla aleja
   * la liquidación sin comprar ni vender un solo contrato. Subir el capital
   * asignado del bot NO hace esto —solo cambia el denominador contable—, y
   * confundir las dos cosas es exactamente el error que este método existe
   * para poder evitar.
   *
   * Opcional, como `modifyOrder`: un venue que no lo porte simplemente no lo
   * declara y el llamante lo comprueba antes de ofrecérselo al usuario.
   *
   * `amountUsd` va SIEMPRE en positivo; la dirección la lleva `action`. Que el
   * signo viajara dentro del importe dejaba que un `-0` o un importe ya negado
   * por el llamante retirase margen creyendo que lo aportaba.
   *
   * `side` es el lado de la POSICIÓN, no la dirección configurada del bot: un
   * market maker es `NEUTRAL` y aun así su posición está en un lado concreto.
   */
  adjustIsolatedMargin?(
    symbol: string,
    amountUsd: string,
    action: MarginAction,
    side: PositionSide,
  ): Promise<void>;

  // ── Tiempo real ───────────────────────────────────────────────
  streamOrders(): Observable<OrderUpdate>;
  streamFills(): Observable<Fill>;
  streamTicker(symbol: string): Observable<Ticker>;

  /**
   * Vela en formación, si el venue la emite (`capabilities.candles.live`).
   *
   * Opcional porque un venue puede no servirlo: quien lo necesite
   * comprueba la capacidad y, si no está, compone la vela desde `streamTicker`
   * o vuelve a pedir la última por REST.
   */
  streamCandles?(symbol: string, interval: CandleInterval): Observable<Candle>;

  /**
   * Salud de los streams. Canal SEPARADO a propósito.
   *
   * Antes un fallo de socket se propagaba con `error()` sobre los propios
   * `Subject` de datos, y un Subject con error queda CERRADO PARA SIEMPRE: la
   * reconexión ya no podía entregar nada, así que el bot dejaba de recibir
   * fills en silencio y sin forma de recuperarse salvo recrear el adaptador.
   */
  streamHealth(): Observable<StreamHealth>;

  /** Cierra sockets y libera recursos. Idempotente. */
  close(): Promise<void>;
}

/** Estado de un stream del venue. */
export interface StreamHealth {
  stream: "orders" | "fills" | "ticker" | "candles";
  status: "UP" | "DOWN";
  symbol?: string;
  detail?: string;
}

/** Traduce el id canónico del motor al formato que acepta cada venue. */
export interface ClientOrderIdCodec {
  encode(canonical: string): string;
  /** Algunos venues necesitan el id como número (Lighter). */
  encodeNumeric?(canonical: string): number;
}
