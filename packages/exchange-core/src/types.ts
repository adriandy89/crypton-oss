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
  NivelApalancamiento,
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
  /**
   * Lo más que se espera a una respuesta HTTP. Por defecto `HTTP_TIMEOUT_MS`.
   *
   * Solo para pruebas, como `wsUrl`: la batería provoca una conexión colgada y no
   * puede esperar diez segundos por intento (spec 050).
   */
  httpTimeoutMs?: number;
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

  /**
   * Comprueba credenciales con llamadas de SOLO LECTURA.
   *
   * `detail` es el motivo del rechazo y llega TAL CUAL al usuario, asi que se
   * escribe para el: que hizo mal y que tiene que hacer (spec 028).
   *
   * `agentValidUntil` es epoch ms de cuando caduca la firma delegada, `null` si
   * no caduca y ausente en los venues cuyas credenciales no caducan (Aster y
   * Lighter). Solo Hyperliquid lo rellena: sus API wallets duran 90 dias por
   * defecto y 180 como maximo, y al vencer los bots dejan de poder colocar y
   * cancelar con las posiciones todavia abiertas.
   */
  verify(): Promise<{
    ok: boolean;
    publicRef: string;
    detail?: string;
    agentValidUntil?: number | null;
  }>;

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
  /**
   * Fija el apalancamiento y el modo de margen del símbolo.
   *
   * Devuelve lo que el venue dice haber aplicado cuando lo dice (spec 058): el
   * canal con IA elige el apalancamiento por operación y no puede entrar con
   * otro distinto del que calculó. Sigue aceptando `void` para los dobles de
   * los tests y para quien no tenga nada que contar.
   */
  setLeverage(
    symbol: string,
    leverage: number,
    mode: MarginMode,
  ): Promise<AcuseApalancamiento | void>;
  setPositionMode?(mode: PositionMode): Promise<void>;

  /**
   * El modo de posición de la cuenta, leído del venue (spec 058).
   *
   * Solo lo declara quien puede estar en cobertura: Aster. Hyperliquid y Lighter
   * solo tienen una posición neta por mercado, y quien no lo declara se trata
   * como unidireccional. El canal con IA no entra en una cuenta en cobertura:
   * su stop y sus objetivos reducen una posición que ahí no existiría.
   */
  getPositionMode?(): Promise<PositionMode>;

  /**
   * Los tramos de apalancamiento del símbolo, de menor a mayor nocional.
   *
   * Cada tramo rige desde su nocional hasta el del siguiente, con su
   * apalancamiento máximo y su mantenimiento: por encima de cierto tamaño un par
   * de 50x deja de admitir 50x, y la liquidación se estima con otra tasa. Es lo
   * que la herramienta del canal con IA necesita para no ofrecer una operación
   * que el venue no admitiría (spec 058).
   *
   * Opcional: quien no lo declara se trata como un único tramo con el máximo y
   * el mantenimiento de la ficha del mercado.
   */
  getLeverageTiers?(symbol: string): Promise<NivelApalancamiento[]>;

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

/**
 * Lo que el venue contesta al fijar el apalancamiento (spec 058).
 *
 * `leverage` es `null` cuando la respuesta no lo confirma: Lighter solo acusa
 * que la transacción está bien formada, y quien la necesite confirmada la mira
 * en la posición. `maxNotional` solo lo da Aster, y es el nocional máximo que
 * admite ese apalancamiento en el tramo de la cuenta.
 */
export interface AcuseApalancamiento {
  leverage: number | null;
  maxNotional?: string;
}

/** Estado de un stream del venue. */
export interface StreamHealth {
  stream: 'orders' | 'fills' | 'ticker' | 'candles';
  status: 'UP' | 'DOWN';
  symbol?: string;
  detail?: string;
}

/**
 * Traduce el id canónico del motor al formato que acepta cada venue.
 *
 * `this: void` no es adorno: los codecs son objetos planos de funciones puras y
 * se usan sueltos (`codecFor(venue).encode`), separados de su objeto. Declararlo
 * dice que ninguna implementación puede depender de `this`, y de paso deja de
 * ser un aviso donde no hay nada que arreglar.
 */
export interface ClientOrderIdCodec {
  encode(this: void, canonical: string): string;
  /** Algunos venues necesitan el id como número (Lighter). */
  encodeNumeric?(this: void, canonical: string): number;
}
