import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable } from 'rxjs';
import type {
  Balance,
  Candle,
  CandleInterval,
  CancelRequest,
  Fill,
  MarginMode,
  MarketSpec,
  MarketTicker,
  OrderAck,
  OrderUpdate,
  PlaceOrderRequest,
  Position,
  Ticker,
  Venue,
  VenueCapabilities,
  VenueOrder,
} from '@crypton/shared';
import { venueKey } from '@crypton/shared';
import type { CandleQuery, ExchangeAdapter, StreamHealth } from '@crypton/exchange-core';
import { DryRunAdapter } from '@crypton/exchange-core';
import { MarketDataService } from '../marketdata';
import { CredentialsService } from './credentials.service';
import { PaperStateStore } from './paper-state.store';

/** Cuánto vale una lectura de estado de cuenta antes de repetirla. */
const DEFAULT_STATE_TTL_MS = 1000;

/**
 * Margen antes de cerrar el adaptador de una cuenta sin bots.
 *
 * Un reequilibrado suelta un bot y adopta otro de la misma cuenta un instante
 * después; cerrar y reabrir el WebSocket en ese hueco costaría más que
 * esperar.
 */
const IDLE_GRACE_MS = 30_000;

/**
 * Cuánto se espera antes de guardar el estado de una simulación.
 *
 * Una rejilla que se llena entera dispara veinte cambios en el mismo tick; sin
 * agrupar serían veinte escrituras a la base por algo que solo hay que guardar
 * una vez. Un segundo es lo bastante corto como para que un `docker restart`
 * —que da treinta de gracia— nunca pille nada sin guardar, porque además se
 * fuerza el guardado al cerrar.
 */
const PAPER_SAVE_DEBOUNCE_MS = 1_000;

interface Cached<T> {
  value: T;
  at: number;
  inflight: Promise<T> | null;
}

interface AccountEntry {
  adapter: ExchangeAdapter;
  refs: number;
  dryRun: boolean;
  /**
   * Ya no está en el mapa: se cerró o la desalojaron.
   *
   * Existe para que los temporizadores en vuelo sepan pararse. Un reintento de
   * guardado se reprograma solo, y sin esto un fallo persistente de la base
   * —una cuenta borrada, por ejemplo— dejaba un latido de un segundo avisando
   * para siempre sobre un adaptador ya cerrado.
   */
  closed: boolean;
  idleSince: number | null;
  positions: Map<string, Cached<Position[]>>;
  openOrders: Map<string, Cached<VenueOrder[]>>;
  balances: Cached<Balance[]> | null;
  /**
   * Presente solo en las cuentas de SIMULACIÓN: lo que hace falta para que su
   * estado sobreviva a un reinicio de este proceso.
   */
  paper: {
    botId: string;
    /**
     * Este worker ya no tiene derecho a escribir este sandbox.
     *
     * Es una bandera y no un `paper = null` porque `release` necesita seguir
     * SABIENDO que esto es un simulador para cerrarlo en el acto: anulándolo, un
     * bot cuyo lease se perdía dejaba su simulador rondando un minuto, suscrito
     * al ticker y casando órdenes sin nadie detrás.
     */
    abandoned: boolean;
    epoch: number;
    simulator: DryRunAdapter;
    dirty: boolean;
    timer: NodeJS.Timeout | null;
    /** Guardado en vuelo, para no solapar dos escrituras del mismo estado. */
    saving: Promise<void> | null;
  } | null;
}

/**
 * Un adaptador por CUENTA de exchange, no por bot.
 *
 * Antes cada `BotRunner` recibía el suyo. Diez bots de una misma cuenta
 * significaban diez descifrados de la misma clave privada, diez firmantes en
 * memoria, diez conexiones WebSocket a la misma dirección —cada una recibiendo
 * los fills de las otras nueve para descartarlos— y diez limitadores de caudal
 * independientes, cada uno creyéndose dueño del presupuesto entero de una
 * cuenta que es una sola. Con `VENUE_RATE_LIMIT_PER_SECOND=8`, diez bots
 * mandaban ochenta peticiones por segundo contra un límite de ocho.
 *
 * Aquí se comparte todo lo que es de la cuenta y NADA que cruce esa frontera:
 * la clave se descifra una vez, el mapa está indexado por
 * `exchange_account_id`, y dos cuentas —aunque sean del mismo usuario— no
 * comparten ni conexión ni caché. Los precios, que sí son públicos, viven en
 * `MarketDataService` y se comparten globalmente.
 *
 * Como efecto lateral, la clave privada tiene MENOS presencia en memoria que
 * antes, no más: una copia por cuenta en lugar de una por bot.
 */
@Injectable()
export class AccountHub implements OnModuleDestroy {
  private readonly logger = new Logger(AccountHub.name);
  private readonly accounts = new Map<string, AccountEntry>();
  /**
   * Una fuente de precios por venue+red, compartida por todos los simuladores.
   * Ver `priceSource`.
   */
  private readonly priceSources = new Map<string, ExchangeAdapter>();
  /** Aperturas en curso, para que dos bots adoptados a la vez no dupliquen. */
  private readonly opening = new Map<string, Promise<AccountEntry>>();
  private readonly stateTtlMs: number;
  private sweeper: NodeJS.Timeout | null = null;

  constructor(
    private readonly credentials: CredentialsService,
    private readonly marketData: MarketDataService,
    private readonly paperStore: PaperStateStore,
    config: ConfigService,
  ) {
    this.stateTtlMs = Number(config.get('ACCOUNT_STATE_TTL_MS', DEFAULT_STATE_TTL_MS));
    this.sweeper = setInterval(() => void this.closeIdle(), IDLE_GRACE_MS);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    // El estado de las simulaciones se guarda ANTES de cerrar los adaptadores:
    // un redespliegue es el caso normal, no el raro, y perder ahí las
    // posiciones abiertas es justo lo que hacía que la simulación no sirviera
    // para dejarla corriendo días.
    await Promise.allSettled([...this.accounts.values()].map((a) => this.flushPaper(a)));
    await Promise.allSettled([...this.accounts.values()].map((a) => a.adapter.close()));
    // Marcadas antes de vaciar el mapa: cualquier temporizador que siguiera en
    // vuelo tiene que encontrarse la entrada cerrada y no reprogramarse.
    for (const entry of this.accounts.values()) entry.closed = true;
    this.accounts.clear();
    // Las fuentes se cierran AL FINAL: los simuladores no las cierran ellos
    // —no son suyas— y quedarían conexiones al venue abiertas tras el apagado.
    await Promise.allSettled([...this.priceSources.values()].map((a) => a.close()));
    this.priceSources.clear();
  }

  /**
   * Entrega a un bot su vista de la cuenta.
   *
   * Lo devuelto cumple `ExchangeAdapter` entero, así que el runner no sabe —ni
   * necesita saber— que está compartiendo conexión con sus hermanos.
   */
  async open(
    exchangeAccountId: string,
    botId: string,
    venue: Venue,
    symbol: string,
    dryRun: boolean,
    testnet: boolean,
  ): Promise<ExchangeAdapter> {
    // Real: un adaptador por CUENTA, compartido por todos sus bots. Es lo que
    // evita descifrar la misma clave diez veces y mandar ochenta peticiones por
    // segundo con el límite puesto a ocho.
    //
    // Simulado: un adaptador por BOT. Su sandbox es suyo —saldo, posición y
    // libro propios—, y así dos simulados sobre el mismo par no se pisan y dos
    // workers no escriben el mismo estado. No cuesta conexiones: todos los
    // simuladores de un venue comparten UNA fuente de precios (ver
    // `priceSource`), que es lo único que sale a la red.
    const key = dryRun ? `${exchangeAccountId}:sim:${botId}` : `${exchangeAccountId}:real`;

    let entry = this.accounts.get(key);

    // Un simulador ocioso sigue en el mapa hasta treinta segundos, y en ese rato
    // el usuario puede haber reiniciado su simulación desde la app. Entregarlo
    // tal cual arrancaría el bot sobre el saldo y las posiciones de ANTES,
    // mientras la pantalla enseña la cuenta limpia; y todo lo que operara ahí
    // acabaría en la basura al rechazarse su escritura por epoch.
    //
    // Solo se comprueba con el recuento a cero: con handles vivos no puede haber
    // habido reinicio —la API lo exige— y reemplazar la entrada ahí sí rompería
    // el recuento.
    if (entry && dryRun && entry.refs === 0) {
      const actual = await this.paperStore.epochOf(botId);
      // Se vuelve a mirar TODO después del await: en ese hueco otro `open()`
      // pudo haber hecho ya el relevo —y entonces esta entrada ya no está en el
      // mapa— o haber tomado una referencia, y desalojar con handles vivos deja
      // un recuento que no baja nunca y un adaptador que no se cierra.
      const vigente = this.accounts.get(key);
      if (vigente === entry && entry.refs === 0) {
        if (!entry.paper || entry.paper.epoch !== actual) {
          this.evict(key, entry);
          await entry.adapter.close().catch(() => undefined);
          this.logger.log(`Sandbox de ${botId.slice(0, 8)} descartado: su simulación se reinició`);
          entry = undefined;
        }
      } else {
        entry = vigente;
      }
    }

    if (!entry) {
      // Single-flight: dos bots de la misma cuenta adoptados en la misma
      // ráfaga entraban aquí a la vez, ambos veían el hueco y ambos abrían
      // adaptador — dos descifrados y una conexión huérfana que nadie cerraba.
      let pending = this.opening.get(key);
      if (!pending) {
        pending = this.create(key, exchangeAccountId, botId, venue, dryRun, testnet);
        this.opening.set(key, pending);
        // `then(limpiar, limpiar)` y NO `finally()`: la promesa que devuelve
        // `finally` hereda el rechazo de `pending`, y como nadie la esperaba, un
        // fallo al abrir la cuenta —una conexión de exchange borrada con un bot
        // vivo, un hipo de la base al adoptar— era un `unhandledRejection` que
        // `main.ts` convierte en apagar el proceso: caían los 250 bots del
        // worker. `pending` sí se espera justo debajo; esta copia solo limpia
        // el mapa y no debe fallar nunca (001/F-31).
        const limpiar = () => this.opening.delete(key);
        void pending.then(limpiar, limpiar);
      }
      entry = await pending;
    }

    entry.refs++;
    entry.idleSince = null;
    // La red NO entra en la clave del mapa: ya está en `exchangeAccountId`, que
    // pertenece a una sola red y no cambia. Va al handle porque es lo que este
    // necesita para pedir el precio al feed público de la red correcta.
    return new AccountHandle(this, entry, key, venue, symbol, this.marketData, testnet);
  }

  private async create(
    key: string,
    exchangeAccountId: string,
    botId: string,
    venue: Venue,
    dryRun: boolean,
    testnet: boolean,
  ): Promise<AccountEntry> {
    const entry: AccountEntry = {
      adapter: undefined as never,
      refs: 0,
      dryRun,
      closed: false,
      idleSince: null,
      positions: new Map(),
      openOrders: new Map(),
      balances: null,
      paper: null,
    };

    if (dryRun) {
      // El estado se recupera de la base ANTES de construir el simulador: es lo
      // que le devuelve el saldo, las posiciones y las órdenes que tenía cuando
      // este proceso —u otro— se fue. Sin esto, cada reinicio devolvía la
      // simulación a su punto de partida mientras las órdenes y las ejecuciones
      // seguían guardadas, y el bot quedaba discutiendo con su propio libro.
      const loaded = await this.paperStore.load(botId);
      const simulator = new DryRunAdapter(this.priceSource(venue, testnet), {
        startingBalance: loaded.startingBalance,
        initialState: loaded.state ?? undefined,
        // La fuente NO es suya: la comparten todos los simuladores de este venue
        // y la cierra el hub. Sin esto, el primer bot en apagarse le dejaba sin
        // precios a los demás.
        closeSource: false,
        // El simulador solo avisa; agrupar y escribir es cosa de aquí, porque
        // esto se llama desde dentro de la ejecución de una orden y una
        // escritura ahí pondría la latencia de la base en medio de un fill.
        onStateChange: () => this.markPaperDirty(key),
      });
      entry.adapter = simulator;
      entry.paper = {
        botId,
        abandoned: false,
        epoch: loaded.epoch,
        simulator,
        dirty: false,
        timer: null,
        saving: null,
      };
    } else {
      entry.adapter = await this.credentials.openAdapter(exchangeAccountId, false);
    }

    this.accounts.set(key, entry);
    this.logger.log(
      dryRun
        ? `Sandbox de ${botId.slice(0, 8)} abierto (${venue}, simulación)`
        : `Cuenta ${exchangeAccountId.slice(0, 8)} abierta (${venue})`,
    );
    return entry;
  }

  /**
   * La fuente de precios de un venue, compartida por todos sus simuladores.
   *
   * Es la pieza que hace barato el sandbox por bot: cien bots simulados en
   * Lighter son cien simuladores en memoria y UNA conexión al venue. Sin esto
   * serían cien limitadores de caudal creyéndose cada uno dueño del cupo, que es
   * exactamente el problema que este hub existe para resolver.
   *
   * Va sin credenciales a propósito, y eso vale también para un bot simulado
   * sobre una conexión REAL: el simulador no firma nada, así que descifrar su
   * clave para envolverla era pagar el riesgo de tener un secreto en memoria a
   * cambio de nada.
   */
  private priceSource(venue: Venue, testnet: boolean): ExchangeAdapter {
    const clave = venueKey(venue, testnet);
    let source = this.priceSources.get(clave);
    if (!source) {
      source = this.credentials.openPriceSource(venue, testnet);
      this.priceSources.set(clave, source);
      this.logger.log(`Fuente de precios abierta para ${clave} (simulación)`);
    }
    return source;
  }

  // ═══════════════════════════════════════════════════════════════
  // Estado de las cuentas de simulación
  // ═══════════════════════════════════════════════════════════════

  /**
   * Anota que hay algo que guardar y programa la escritura.
   *
   * Se agrupa a propósito: una rejilla que se llena entera avisa una vez por
   * nivel y el estado que hay que guardar es el mismo para todas.
   */
  private markPaperDirty(key: string): void {
    const entry = this.accounts.get(key);
    if (!entry?.paper) return;
    entry.paper.dirty = true;
    this.schedulePaperSave(entry);
  }

  /** Programa la escritura, si no hay ya una programada. */
  private schedulePaperSave(entry: AccountEntry): void {
    if (!entry.paper || entry.paper.abandoned || entry.paper.timer || entry.closed) return;
    entry.paper.timer = setTimeout(() => {
      if (!entry.paper) return;
      entry.paper.timer = null;
      void this.savePaper(entry);
    }, PAPER_SAVE_DEBOUNCE_MS);
    // Guardar la simulación no debe mantener vivo el proceso: si el worker está
    // apagándose, el cierre ordenado ya fuerza el último guardado.
    entry.paper.timer.unref?.();
  }

  /**
   * Vuelca el estado del simulador a la base.
   *
   * Si el guardado se rechaza es porque el usuario reinició la simulación
   * mientras este adaptador seguía vivo: deja de intentarlo, porque lo que
   * tiene en memoria ya no es el estado de nadie.
   */
  private async savePaper(entry: AccountEntry): Promise<void> {
    const paper = entry.paper;
    if (!paper || paper.abandoned || !paper.dirty) return;
    if (paper.saving) {
      // Ya hay una escritura en vuelo con un estado más viejo. Se vuelve a
      // programar en lugar de esperarla y darse por hecho: si la escritura tarda
      // más que el agrupado y luego el bot se queda quieto, este estado no lo
      // guardaba nadie hasta cerrar, y un `kill -9` en medio lo perdía.
      this.schedulePaperSave(entry);
      return;
    }

    paper.dirty = false;
    const run = this.paperStore
      .save(paper.botId, paper.epoch, paper.simulator.exportState())
      .then((ok) => {
        if (ok) return;
        // Rechazada: o el usuario reinició la simulación, o la cuenta la lleva
        // otro worker. `PaperStateStore` ya lo ha dicho en el log.
        //
        // NO se desarma la persistencia, que es lo que se hacía antes: dejaba el
        // simulador operando sin que nadie guardara nada y, al cerrarse, tiraba
        // en silencio todo lo que llevaba hecho. Se sigue intentando en cada
        // cambio, que es un reintento con la cadencia justa —solo hay algo que
        // guardar cuando algo ha pasado— y permite recuperar la cuenta en cuanto
        // el otro worker la suelte.
        //
        // Tampoco se saca del mapa, por tentador que parezca: `release()` busca
        // la entrada por su clave, así que desalojarla con handles vivos deja un
        // recuento que ya no baja nunca —el adaptador no se cierra y sus
        // suscripciones al ticker quedan colgando— y, peor, hace que un
        // `release` tardío descuente de la entrada NUEVA que haya bajo la misma
        // clave, pudiendo cerrarle el adaptador a bots que están operando. De
        // que un simulador con el epoch pasado no se reparta se encarga
        // `open()`.
        paper.dirty = true;
      })
      .catch((e: unknown) => {
        // Se vuelve a marcar sucio Y se reprograma: marcarlo sin más dejaba el
        // reintento a merced de que llegara otra operación. Si el bot se
        // quedaba quieto justo después, un fallo pasajero de la base costaba
        // todo lo ejecutado desde la última escritura buena.
        paper.dirty = true;
        this.schedulePaperSave(entry);
        this.logger.warn(
          `No se pudo guardar el sandbox de ${paper.botId.slice(0, 8)}: ${(e as Error).message}`,
        );
      })
      .finally(() => {
        paper.saving = null;
      });

    paper.saving = run;
    return run;
  }

  /**
   * Saca una cuenta del mapa si sigue siendo la que está ahí.
   *
   * La comprobación de identidad importa: entre que se decide desalojar y que
   * se hace, otro camino puede haber puesto una entrada NUEVA bajo la misma
   * clave, y tirarla sería dejar sin adaptador a los bots que ya la usan.
   */
  private evict(key: string, entry: AccountEntry): void {
    if (this.accounts.get(key) === entry) this.accounts.delete(key);
    entry.closed = true;
    if (entry.paper?.timer) {
      clearTimeout(entry.paper.timer);
      entry.paper.timer = null;
    }
  }

  /** Guardado final, antes de soltar el adaptador. */
  private async flushPaper(entry: AccountEntry): Promise<void> {
    const paper = entry.paper;
    // Abandonado: este worker perdió el lease del bot y ya no tiene derecho a
    // escribir. Forzar el guardado aquí es justo lo que le pisaría el sandbox al
    // worker que lo ha adoptado. Ver `abandonPaper`.
    if (!paper || paper.abandoned) return;
    if (paper.timer) {
      clearTimeout(paper.timer);
      paper.timer = null;
    }
    // Se espera a lo que haya en vuelo ANTES de forzar: `savePaper` reprograma
    // cuando encuentra una escritura en curso, y al cerrar ya no queda nadie que
    // atienda ese temporizador.
    if (paper.saving) await paper.saving.catch(() => undefined);
    // Se fuerza aunque no esté marcado: cerrar sin guardar es exactamente el
    // fallo que esta tabla viene a arreglar, y una escritura de más al cerrar
    // no le cuesta nada a nadie.
    paper.dirty = true;
    await this.savePaper(entry);
  }

  /**
   * Este worker ha perdido el derecho a escribir el sandbox de un bot.
   *
   * Se llama al perder su lease, y ANTES de soltar el runner. Sin esto, el
   * guardado final que hace `release` escribía con el epoch que cargó al abrir
   * —el mismo que tiene el worker que ya lo ha adoptado— y le pisaba lo que
   * llevara hecho. El epoch protege del reinicio de simulación, no de un relevo
   * entre procesos; de eso protege el lease, y la forma de respetarlo es no
   * escribir cuando ya no se tiene.
   *
   * Lo que hay en memoria se descarta: el nuevo dueño ya cargó lo último
   * guardado y a partir de ahí manda él.
   */
  abandonPaper(botId: string): void {
    for (const entry of this.accounts.values()) {
      if (entry.paper?.botId !== botId) continue;
      entry.paper.abandoned = true;
      entry.paper.dirty = false;
      if (entry.paper.timer) {
        clearTimeout(entry.paper.timer);
        entry.paper.timer = null;
      }
    }
  }

  /** Suelta una referencia. El adaptador se cierra en el barrido de inactivos. */
  release(key: string): void {
    const entry = this.accounts.get(key);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0) return;

    entry.idleSince = Date.now();

    // Un sandbox que se queda sin bot se guarda y se CIERRA aquí mismo. No
    // espera al barrido de inactivos, y no es una optimización:
    //
    // · El simulador sigue suscrito al ticker mientras viva, y cada tick casa
    //   sus órdenes en reposo. Un sandbox huérfano seguía operando solo, treinta
    //   segundos largos, sin ningún bot detrás.
    // · Y si el bot se soltó porque se perdió su lease, otro worker lo adopta en
    //   cuanto caduca. Ese fantasma escribía con el MISMO epoch encima de lo que
    //   el nuevo dueño ya estaba haciendo, y no había nada que lo detuviera.
    //
    // La gracia de treinta segundos existe para no reabrir conexiones al venue,
    // y aquí no hay ninguna que reabrir: la fuente de precios se comparte y se
    // queda. Reconstruir un simulador es leer una fila.
    if (entry.paper) {
      void this.flushPaper(entry)
        .catch(() => undefined)
        .then(() => {
          // Otro bot pudo haberlo tomado mientras se guardaba: solo se cierra lo
          // que sigue sin dueño.
          if (entry.refs > 0) return;
          this.evict(key, entry);
          return entry.adapter.close().catch(() => undefined);
        });
    }
  }

  private async closeIdle(): Promise<void> {
    for (const [id, entry] of this.accounts) {
      if (entry.refs > 0 || entry.idleSince === null) continue;
      if (Date.now() - entry.idleSince < IDLE_GRACE_MS) continue;

      // Se guarda ANTES de sacarla del mapa. Al revés, un `open()` que llegara
      // mientras se escribía no encontraba nada, construía un SEGUNDO simulador
      // desde el estado todavía sin guardar y con el mismo epoch: los dos se
      // pisaban y las operaciones de uno se perdían.
      await this.flushPaper(entry).catch(() => undefined);

      // Y por eso mismo hay que volver a mirar: si alguien la adoptó mientras
      // se guardaba, ahora está en uso y cerrarla le dejaría el adaptador
      // muerto en la mano.
      if (entry.refs > 0) continue;

      this.evict(id, entry);
      await entry.adapter.close().catch(() => undefined);
      this.logger.log(`Cuenta ${id.slice(0, 8)} cerrada por inactividad`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Lecturas compartidas
  // ═══════════════════════════════════════════════════════════════

  /**
   * Una lectura con caché corta y petición única en vuelo.
   *
   * El TTL es de un segundo: lo justo para que los bots de una misma cuenta que
   * laten a la vez compartan la respuesta, y lo bastante corto para que la
   * siguiente vuelta vea el efecto de lo que se acaba de mandar. Las escrituras
   * además invalidan, así que después de colocar o cancelar no se lee nada
   * viejo.
   */
  private async shared<T>(
    slot: Cached<T> | null,
    set: (c: Cached<T>) => void,
    load: () => Promise<T>,
  ): Promise<T> {
    if (slot && Date.now() - slot.at < this.stateTtlMs) return slot.value;
    if (slot?.inflight) return slot.inflight;

    const holder: Cached<T> = slot ?? {
      value: undefined as never,
      at: 0,
      inflight: null,
    };
    holder.inflight = load()
      .then((value) => {
        holder.value = value;
        holder.at = Date.now();
        return value;
      })
      .finally(() => {
        holder.inflight = null;
      });
    set(holder);
    return holder.inflight;
  }

  getPositions(entry: AccountEntry, symbol: string): Promise<Position[]> {
    const slot = entry.positions.get(symbol) ?? null;
    return this.shared(
      slot,
      (c) => entry.positions.set(symbol, c),
      () => entry.adapter.getPositions(symbol),
    );
  }

  getOpenOrders(entry: AccountEntry, symbol: string): Promise<VenueOrder[]> {
    const slot = entry.openOrders.get(symbol) ?? null;
    return this.shared(
      slot,
      (c) => entry.openOrders.set(symbol, c),
      () => entry.adapter.getOpenOrders(symbol),
    );
  }

  getBalances(entry: AccountEntry): Promise<Balance[]> {
    return this.shared(
      entry.balances,
      (c) => {
        entry.balances = c;
      },
      () => entry.adapter.getBalances(),
    );
  }

  /** Tras escribir, lo cacheado deja de ser cierto. */
  invalidate(entry: AccountEntry, symbol: string): void {
    entry.positions.delete(symbol);
    entry.openOrders.delete(symbol);
    entry.balances = null;
  }
}

/**
 * La vista que un bot tiene de su cuenta.
 *
 * Cumple `ExchangeAdapter` entero para que el runner no cambie ni una línea.
 * Lo que hace de más: servir precios del feed público compartido, agrupar las
 * lecturas de estado con las de sus bots hermanos, e invalidar esa caché en
 * cuanto escribe. Y su `close()` NO cierra la conexión de la cuenta: solo
 * suelta la referencia.
 */
class AccountHandle implements ExchangeAdapter {
  readonly venue: Venue;
  private released = false;
  /** ¿Este handle llegó a tomar una suscripción del feed público? */
  private tickerAcquired = false;
  private tickerStream: Observable<Ticker> | null = null;

  constructor(
    private readonly hub: AccountHub,
    private readonly entry: AccountEntry,
    private readonly key: string,
    venue: Venue,
    private readonly symbol: string,
    private readonly marketData: MarketDataService,
    private readonly testnet: boolean,
  ) {
    this.venue = venue;
  }

  // ── Datos de mercado ────────────────────────────────────────────
  //
  // En REAL van al feed público compartido. En SIMULACIÓN van al adaptador de
  // la cuenta, y no es una preferencia: el simulador casa las órdenes en
  // reposo CUANDO le pasan precios por getTicker/streamTicker. Servirle el
  // precio desde el feed lo dejaba ciego — ninguna orden simulada se ejecutaba
  // jamás, con la simulación siendo la puerta de entrada de todo usuario.
  getTicker(symbol: string): Promise<Ticker> {
    if (this.entry.dryRun) return this.entry.adapter.getTicker(symbol);
    return this.marketData.ticker(this.venue, symbol, this.testnet);
  }

  streamTicker(symbol: string): Observable<Ticker> {
    if (this.entry.dryRun) return this.entry.adapter.streamTicker(symbol);
    // Una sola adquisición por handle: la referencia del feed se toma una vez
    // y `close()` devuelve exactamente lo tomado — ni más, ni menos.
    if (!this.tickerStream) {
      this.tickerAcquired = true;
      this.tickerStream = this.marketData.subscribe(this.venue, symbol, this.testnet);
    }
    return this.tickerStream;
  }

  getMarkets(): Promise<MarketSpec[]> {
    return this.entry.adapter.getMarkets();
  }

  /**
   * Capacidades del venue. Se delegan tal cual: son estáticas por plataforma y
   * no dependen ni de la cuenta ni de si el bot es simulado.
   */
  get capabilities(): VenueCapabilities {
    return this.entry.adapter.capabilities;
  }

  /**
   * Velas y precios de 24 h.
   *
   * El motor no los usa —reconcilia contra el libro, no contra un gráfico—,
   * pero forman parte de la interfaz y delegarlos cuesta dos líneas. Van al
   * adaptador de la cuenta y no al feed compartido porque son lecturas
   * puntuales, no suscripciones: no hay ninguna referencia que devolver.
   */
  getTickers(): Promise<MarketTicker[]> {
    return this.entry.adapter.getTickers();
  }

  getCandles(symbol: string, interval: CandleInterval, query: CandleQuery): Promise<Candle[]> {
    return this.entry.adapter.getCandles(symbol, interval, query);
  }

  // ── Estado de la cuenta: compartido entre sus bots ──────────────
  getPositions(symbol?: string): Promise<Position[]> {
    return this.hub.getPositions(this.entry, symbol ?? this.symbol);
  }

  getOpenOrders(symbol?: string): Promise<VenueOrder[]> {
    return this.hub.getOpenOrders(this.entry, symbol ?? this.symbol);
  }

  getBalances(): Promise<Balance[]> {
    return this.hub.getBalances(this.entry);
  }

  getRecentFills(symbol: string, sinceMs: number): Promise<Fill[]> {
    return this.entry.adapter.getRecentFills(symbol, sinceMs);
  }

  verify(): Promise<{ ok: boolean; publicRef: string; detail?: string }> {
    return this.entry.adapter.verify();
  }

  // ── Escritura: invalida lo cacheado ────────────────────────────
  async placeOrder(req: PlaceOrderRequest): Promise<OrderAck> {
    try {
      return await this.entry.adapter.placeOrder(req);
    } finally {
      this.hub.invalidate(this.entry, req.symbol);
    }
  }

  async cancelOrder(req: CancelRequest): Promise<void> {
    try {
      await this.entry.adapter.cancelOrder(req);
    } finally {
      this.hub.invalidate(this.entry, req.symbol);
    }
  }

  async cancelOwn(symbol: string, clientOrderIds: string[]): Promise<void> {
    try {
      await this.entry.adapter.cancelOwn(symbol, clientOrderIds);
    } finally {
      this.hub.invalidate(this.entry, symbol);
    }
  }

  async cancelAll(symbol: string): Promise<void> {
    try {
      await this.entry.adapter.cancelAll(symbol);
    } finally {
      this.hub.invalidate(this.entry, symbol);
    }
  }

  async setLeverage(symbol: string, leverage: number, mode: MarginMode): Promise<void> {
    try {
      await this.entry.adapter.setLeverage(symbol, leverage, mode);
    } finally {
      this.hub.invalidate(this.entry, symbol);
    }
  }

  // ── Tiempo real de la cuenta ───────────────────────────────────
  //
  // El stream es de la CUENTA, así que un bot recibe también los eventos de sus
  // hermanos. Filtrarlos aquí exigiría saber a qué bot pertenece cada orden, y
  // eso ya lo resuelve el ledger: `recordFill` busca la orden por bot y
  // devuelve false si no es suya. Se prefiere esa comprobación —que es un
  // índice— a duplicar aquí la lógica de pertenencia.
  streamOrders(): Observable<OrderUpdate> {
    return this.entry.adapter.streamOrders();
  }

  streamFills(): Observable<Fill> {
    return this.entry.adapter.streamFills();
  }

  streamHealth(): Observable<StreamHealth> {
    return this.entry.adapter.streamHealth();
  }

  /**
   * Suelta la referencia. La conexión de la cuenta sigue viva para el resto.
   *
   * Idempotente a propósito: el mismo handle puede cerrarse desde más de un
   * camino (desenganche del barrido y apagado del proceso), y una liberación
   * doble restaría una referencia que pertenece a OTRO bot — su cuenta se
   * cerraría con él dentro.
   */
  // Hoy no espera nada, pero devolver promesa es parte del contrato: quien lo
  // llama hace `await ... .catch()`, y quitar el `async` cambiaria la firma de
  // un metodo de ciclo de vida que otras implementaciones si necesitan
  // asincrono.
  // eslint-disable-next-line @typescript-eslint/require-await
  async close(): Promise<void> {
    if (this.released) return;
    this.released = true;
    if (this.tickerAcquired) this.marketData.release(this.venue, this.symbol, this.testnet);
    this.hub.release(this.key);
  }
}
