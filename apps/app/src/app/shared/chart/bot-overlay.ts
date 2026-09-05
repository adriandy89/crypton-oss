import { agruparSucesos } from '@crypton/shared';
import type { BotDetail, BotEvent, BotFill, BotLevel, BotOrder } from '../../core/models';

/**
 * Traduce el estado de un bot a lo que se pinta encima del grafico.
 *
 * Vive aparte del componente de grafico por una razon concreta: el componente
 * no sabe nada de bots ni de escaleras, y el dia que haya que dibujar otra cosa
 * —una alerta de precio, el rango de una estrategia— se anade aqui sin tocar el
 * motor grafico.
 */

/**
 * QUE significa una linea. Elige el color.
 *
 * No confundir con `ghost`, que dice en que ESTADO esta. Son dos ejes
 * independientes a proposito: fundirlos en un `kind: 'planned'` pintaria del
 * mismo color un take profit planificado y una orden de seguridad planificada,
 * y borraria justo lo que se viene a mirar en esa capa.
 */
export type OverlayKind = 'buy' | 'sell' | 'takeProfit' | 'stopLoss' | 'average' | 'liquidation';

/** Trazo de la linea. Es la senal que sobrevive a una captura en blanco y negro. */
export type OverlayStyle = 'solid' | 'dashed' | 'largeDashed' | 'dotted';

/** Una linea horizontal en el grafico, en el precio exacto de la orden. */
export interface OverlayLine {
  id: string;
  price: number;
  kind: OverlayKind;
  /** Rotulo corto que se pinta a la izquierda de la linea: `SAF#3`, `TP#1`. */
  title: string;
  style: OverlayStyle;
  width: 1 | 2;
  /**
   * Nivel DESEADO, todavia no colocado en el exchange.
   *
   * Se pinta atenuado y punteado. Sin esta distincion seria una mentira de las
   * gordas: un nivel planificado no protege nada mientras no este puesto.
   */
  ghost: boolean;
  /**
   * Si lleva rotulo en el eje de precios. Lo decide `conRotulos()` al final de
   * `buildBotOverlay`; ausente, vale `!ghost`, que era la regla de antes.
   */
  axisLabel?: boolean;
}

/** Una ejecucion ya hecha, como marcador en su precio real. */
export interface OverlayMarker {
  id: string;
  /** ms epoch: el componente lo pasa a la escala del motor grafico. */
  timeMs: number;
  side: 'BUY' | 'SELL';
  /** Precio de ejecucion. Medio ponderado si el marcador agrupa varias. */
  price: number;
  /** Cantidad total del grupo. */
  qty: number;
  /** Cuantas ejecuciones se han fundido aqui. 1 = una sola. */
  count: number;
  text: string;
}

/**
 * Un suceso del bot —o varios de la misma vela— como marcador sobre la barra.
 *
 * No lleva precio: un suceso ocurre en un instante, no en un precio, así que se
 * ancla a la vela y no a la escala. `tone` decide forma y color: cuadrado ámbar
 * para lo grave, círculo neutro para lo que solo explica (spec 005, R-2).
 */
export interface OverlayEventMarker {
  id: string;
  timeMs: number;
  tone: 'warn' | 'info';
  text: string;
  count: number;
}

export interface BotOverlay {
  lines: OverlayLine[];
  /**
   * Rango que hay que poder ver para que la escalera entera quepa.
   *
   * Es lo que convierte «un grafico con unas rayas» en algo util: al entrar
   * desde un bot, un grafico ajustado solo a las velas puede dejar fuera de
   * pantalla justo la orden de seguridad que interesa mirar.
   */
  span: { min: number; max: number } | null;
  /**
   * Ordenes vivas que NO se han podido situar en el grafico.
   *
   * Cero es «esta todo pintado». Cualquier otra cosa hay que decirla: el
   * principio de este fichero es no mentir sobre lo que hay en el exchange, y
   * callar una orden viva es la otra mitad de esa mentira.
   */
  skipped: number;
}

/**
 * Rotulo corto de un nivel: `GRID_BUY` + 3 -> `GRID#3`.
 *
 * Exportado para que el detalle del bot use el MISMO rotulo que el grafico: la
 * misma orden se llamaba `GRID_BUY#3` en una pantalla y `GRID#3` en la de al
 * lado, a un toque de distancia (spec 002, F-09).
 */
export function levelTitle(level: { level_kind: string; level_index: number }): string {
  const short: Record<string, string> = {
    BASE: 'BASE',
    SAFETY: 'SAF',
    GRID_BUY: 'GRID',
    GRID_SELL: 'GRID',
    TAKE_PROFIT: 'TP',
    STOP_LOSS: 'SL',
    QUOTE_BID: 'BID',
    QUOTE_ASK: 'ASK',
  };
  const kind = short[level.level_kind] ?? level.level_kind;
  return level.level_index > 0 ? `${kind}#${level.level_index}` : kind;
}

/**
 * De que va la linea, a partir del tipo de nivel y del lado.
 *
 * El tipo manda sobre el lado: un take profit es una venta, pero pintarlo del
 * rojo de las ventas lo haria indistinguible del nivel que te saca perdiendo.
 */
function lineKind(levelKind: string, side: 'BUY' | 'SELL'): OverlayKind {
  if (levelKind === 'TAKE_PROFIT') return 'takeProfit';
  if (levelKind === 'STOP_LOSS') return 'stopLoss';
  return side === 'BUY' ? 'buy' : 'sell';
}

/**
 * De que lado esta un nivel PLANIFICADO.
 *
 * `BotLevel` no tiene columna `side` —la orden todavia no existe—, asi que hay
 * que deducirlo, y hacerlo mal pinta media escalera del color contrario.
 *
 * El tipo de nivel manda cuando ya lleva el lado dentro: una rejilla neutral
 * tiene niveles de compra Y de venta a la vez, igual que un market maker cotiza
 * a los dos lados, y ahi ni la direccion del bot ni `reduce_only` distinguen
 * nada. Solo cuando el tipo no dice el lado —BASE, SAFETY, TAKE_PROFIT,
 * STOP_LOSS— se recurre a `reduce_only` cruzado con la direccion: lo que abre
 * posicion va en el sentido del bot y lo que la cierra, en el contrario. Es lo
 * que hace que en un bot SHORT la orden BASE salga como venta y no como compra.
 */
function levelSide(
  level: { kind: string; reduce_only: boolean },
  direction: 'LONG' | 'SHORT' | 'NEUTRAL',
): 'BUY' | 'SELL' {
  if (level.kind === 'GRID_BUY' || level.kind === 'QUOTE_BID') return 'BUY';
  if (level.kind === 'GRID_SELL' || level.kind === 'QUOTE_ASK') return 'SELL';
  const corto = direction === 'SHORT';
  // Cierra posicion: al reves que la direccion. La abre: en su mismo sentido.
  return level.reduce_only ? (corto ? 'BUY' : 'SELL') : corto ? 'SELL' : 'BUY';
}

/** Trazo de cada tipo de linea. Ver la nota de `overlayPalette()`. */
const STYLE_OF: Record<OverlayKind, OverlayStyle> = {
  buy: 'solid',
  sell: 'dashed',
  // Guion largo: es una venta, pero no la misma venta.
  takeProfit: 'largeDashed',
  // Continua y gruesa, como la liquidacion pero en ambar: son las dos lineas
  // que marcan donde se acaba la partida, y tienen que leerse igual de rapido.
  stopLoss: 'solid',
  average: 'dashed',
  liquidation: 'solid',
};

const WIDTH_OF: Record<OverlayKind, 1 | 2> = {
  buy: 1,
  sell: 1,
  takeProfit: 1,
  stopLoss: 2,
  average: 1,
  liquidation: 2,
};

const VIVAS = new Set(['PENDING', 'OPEN', 'PARTIALLY_FILLED']);

const finite = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * El precio al que dibujar una orden viva.
 *
 * Una orden a MERCADO no lleva precio limite, y descartarla por eso escondia
 * justo la que mas importa: una entrada en vuelo. Si ya tiene ejecucion parcial,
 * su precio medio la situa bien; si todavia no, no hay nivel que dibujar y se
 * cuenta como no situada en vez de desaparecer sin dejar rastro.
 */
function orderPrice(order: BotOrder): number | null {
  return finite(order.price) ?? finite(order.avg_price);
}

/**
 * Severidad, para decidir que gana cuando dos niveles caen al mismo precio.
 *
 * De mas grave a menos: lo que te saca de la posicion antes que lo que te mete.
 */
const SEVERITY: Record<OverlayKind, number> = {
  liquidation: 5,
  stopLoss: 4,
  takeProfit: 3,
  sell: 2,
  buy: 1,
  average: 0,
};

/**
 * Funde las lineas que caen en el mismo precio.
 *
 * Dos price lines superpuestas no se ven como una: sus etiquetas del eje se
 * pisan y ninguna de las dos se lee. Pasa con normalidad —un take profit y el
 * techo de la rejilla suelen coincidir— y el resultado era una etiqueta ilegible
 * justo en el precio mas importante del grafico.
 *
 * @param decimals precision del mercado. Sin ella se comparan los numeros tal
 *   cual, que coge el caso frecuente (el motor calculo el mismo valor) pero se
 *   pierde los empates a nivel de tick.
 */
function collapse(lines: OverlayLine[], decimals?: number | null): OverlayLine[] {
  const grupos = new Map<string, OverlayLine[]>();
  for (const line of lines) {
    const clave =
      decimals === null || decimals === undefined
        ? String(line.price)
        : line.price.toFixed(decimals);
    const grupo = grupos.get(clave);
    if (grupo) grupo.push(line);
    else grupos.set(clave, [line]);
  }

  return [...grupos.values()].map((grupo) => {
    if (grupo.length === 1) return grupo[0];
    const ganadora = grupo.reduce((a, b) => (SEVERITY[b.kind] > SEVERITY[a.kind] ? b : a));
    // Dos rotulos como mucho: a partir de ahi la etiqueta del eje no cabe y se
    // vuelve a perder lo que este colapso venia a arreglar.
    const titulos = grupo.map((l) => l.title);
    const title = titulos.length <= 2 ? titulos.join('+') : `${titulos[0]}+${titulos.length - 1}`;
    // Fantasma solo si TODAS lo son: una planificada tapada por una orden ya
    // colocada esta, de hecho, colocada.
    const ghost = grupo.every((l) => l.ghost);
    return {
      ...ganadora,
      // El id junta los de todo el grupo para que siga siendo estable entre
      // refrescos: con el refresco en vivo, un id que baila recrea la linea.
      id: grupo.map((l) => l.id).join('+'),
      title,
      ghost,
      // El trazo se RECALCULA y no se hereda del ganador.
      //
      // Los dos ejes se deciden por separado —`kind` lo pone el ganador por
      // severidad, `ghost` lo pone el grupo entero—, asi que heredar el trazo
      // los mezclaba: un stop loss planificado que gana a una compra ya
      // colocada salia punteado (de la planificada) pero con `ghost: false`,
      // o sea dibujado a plena opacidad y sin desaparecer al apagar la capa de
      // previstas. Dos senales diciendo cosas distintas de la misma linea.
      style: ghost ? 'dotted' : STYLE_OF[ganadora.kind],
      width: ghost ? 1 : WIDTH_OF[ganadora.kind],
    } satisfies OverlayLine;
  });
}

/**
 * Construye la capa a partir del detalle del bot.
 *
 * Solo entran las ordenes VIVAS: una orden cancelada o ya ejecutada no esta en
 * el exchange, y pintarla como si estuviera es exactamente la clase de mentira
 * que hace que un grafico deje de servir para decidir.
 *
 * @param levels escalera DESEADA (`GET /bots/:id/levels`). Los niveles todavia
 *   sin colocar se pintan atenuados: son los que dicen hasta donde aguanta el
 *   bot, y sin ellos el grafico solo enseña el tramo ya tendido.
 * @param opts.priceDecimals precision del mercado, para fundir empates.
 */
export function buildBotOverlay(
  bot: BotDetail,
  levels: BotLevel[] = [],
  opts: { priceDecimals?: number | null } = {},
): BotOverlay {
  const lines: OverlayLine[] = [];
  const prices: number[] = [];
  let skipped = 0;
  /** Ordenes ya dibujadas, para no repetir su nivel planificado encima. */
  const colocadas = new Set<string>();

  for (const order of bot.openOrdersList) {
    if (!VIVAS.has(order.status)) continue;
    colocadas.add(order.client_order_id);
    const price = orderPrice(order);
    if (price === null) {
      skipped += 1;
      continue;
    }
    const kind = lineKind(order.level_kind, order.side);
    lines.push({
      id: order.client_order_id,
      price,
      kind,
      title: levelTitle(order),
      style: STYLE_OF[kind],
      width: WIDTH_OF[kind],
      ghost: false,
    });
    prices.push(price);
  }

  // ── Escalera planificada ──
  //
  // Solo la del ciclo VIVO. El endpoint no filtra por ciclo, asi que sin esta
  // guarda un bot con veinte ciclos a la espalda pintaria las veinte escaleras
  // una encima de otra. Y sin ciclo abierto no se pinta ninguna: no hay
  // escalera vigente que enseñar.
  const cicloVivo = bot.cycle?.seq;
  if (cicloVivo !== undefined) {
    for (const level of levels) {
      if (level.state !== 'PLANNED') continue;
      if (level.cycle_seq !== cicloVivo) continue;
      // Ya esta puesta: se dibuja como orden real, no como intencion.
      if (colocadas.has(level.client_order_id)) continue;
      const price = finite(level.target_price);
      if (price === null) continue;
      const kind = lineKind(level.kind, levelSide(level, bot.direction));
      lines.push({
        id: `plan:${level.client_order_id}`,
        price,
        kind,
        title: levelTitle({ level_kind: level.kind, level_index: level.level_index }),
        style: 'dotted',
        width: 1,
        ghost: true,
      });
      // NO entran en `prices`: una seguridad planificada un 40 % mas abajo
      // aplastaria las velas hasta volverlas ilegibles, igual que la
      // liquidacion. Se ve si cae dentro del rango que ya se esta mirando.
    }
  }

  const average = finite(bot.averageEntry);
  if (average !== null) {
    lines.push({
      id: 'average',
      price: average,
      kind: 'average',
      title: 'MEDIO',
      style: STYLE_OF.average,
      width: WIDTH_OF.average,
      ghost: false,
    });
    prices.push(average);
  }

  const liquidation = finite(bot.liquidationPrice);
  if (liquidation !== null) {
    lines.push({
      id: 'liquidation',
      price: liquidation,
      kind: 'liquidation',
      title: 'LIQ',
      style: STYLE_OF.liquidation,
      width: WIDTH_OF.liquidation,
      ghost: false,
    });
    // La liquidacion NO entra en `span`: suele estar muy lejos y forzar el
    // grafico a incluirla aplastaria las velas hasta volverlas ilegibles. Se
    // dibuja si cae dentro, y si no, la pantalla ya da la distancia en cifras.
  }

  // Sin `markers`: las ejecuciones no salen del detalle del bot sino del
  // ledger de fills, que es otra llamada. Devolver aqui un array siempre vacio
  // invitaba a usarlo y a no ver ni un marcador sin entender por que.
  return {
    lines: conRotulos(collapse(lines, opts.priceDecimals)),
    span: prices.length ? { min: Math.min(...prices), max: Math.max(...prices) } : null,
    skipped,
  };
}

/** A partir de cuantas ordenes de la escalera dejan de rotularse todas. */
const MAX_ROTULOS_ESCALERA = 4;

/**
 * Que lineas llevan rotulo en el eje.
 *
 * Una martingala de doce niveles pintaba doce etiquetas en el eje y no se leia
 * ninguna: el motor grafico ya bajaba la densidad de las marcas de precio a
 * partir de cuatro lineas y `collapse` fundia los empates, pero eso era un
 * parche sobre un problema de forma. Lo que el operador lee de una escalera no
 * son doce precios: es hasta donde llega. Asi que con mas de cuatro ordenes
 * vivas se rotulan solo los EXTREMOS de cada lado —la compra mas baja y la
 * venta mas alta— y la BASE, y el resto quedan como trazos: siguen ahi, con su
 * tono y su trazo, pero sin pelearse por el eje. Lo que no es escalera —precio
 * medio, take profit, stop, liquidacion— se rotula siempre: son las lineas que
 * dicen donde se acaba la partida. Las previstas siguen sin rotulo, como antes.
 */
function conRotulos(lines: OverlayLine[]): OverlayLine[] {
  const escalera = lines.filter((l) => !l.ghost && (l.kind === 'buy' || l.kind === 'sell'));
  if (escalera.length <= MAX_ROTULOS_ESCALERA) {
    return lines.map((l) => ({ ...l, axisLabel: !l.ghost }));
  }
  const conEtiqueta = new Set<string>();
  const compras = escalera.filter((l) => l.kind === 'buy');
  const ventas = escalera.filter((l) => l.kind === 'sell');
  if (compras.length) conEtiqueta.add(compras.reduce((a, b) => (b.price < a.price ? b : a)).id);
  if (ventas.length) conEtiqueta.add(ventas.reduce((a, b) => (b.price > a.price ? b : a)).id);
  const base = escalera.find((l) => l.title.startsWith('BASE'));
  if (base) conEtiqueta.add(base.id);
  return lines.map((l) => ({
    ...l,
    axisLabel: !l.ghost && ((l.kind !== 'buy' && l.kind !== 'sell') || conEtiqueta.has(l.id)),
  }));
}

/**
 * A que vela pertenece una ejecucion.
 *
 * Con la serie cargada se busca en ella; solo sin serie se recurre a dividir por
 * la duracion del intervalo. La diferencia importa de verdad a partir de `3d`:
 * `floor(t / span)` cuenta desde el 1 de enero de 1970, que fue jueves, asi que
 * las velas semanales calculadas asi empiezan en jueves mientras el venue las
 * abre el lunes. Dos ejecuciones de la misma barra caian en cubos distintos y
 * salian como dos marcadores encima de la misma vela — justo el amontonamiento
 * que esta agrupacion existe para evitar. Con `1M` no hay ni division posible:
 * los meses no duran lo mismo.
 *
 * Busqueda binaria por la ultima vela que empieza en o antes de la ejecucion. La
 * serie viene ascendente de la API (ver `loadCandles`).
 */
export function bucketOf(at: number, span: number, bars: readonly number[] | null): number {
  if (!bars) return Math.floor(at / span) * span;
  // Anterior a la primera vela cargada: se queda en ella. El marcador cae en el
  // borde izquierdo del grafico, que es donde de verdad esta su vela.
  if (at <= bars[0]) return bars[0];
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bars[mid] <= at) lo = mid;
    else hi = mid - 1;
  }
  return bars[lo];
}

/**
 * Marcadores de ejecucion, a partir del LEDGER de fills.
 *
 * Se usan los fills y no las ordenes ejecutadas por una razon que se nota en
 * cuanto hay una martingala corriendo: una orden parcialmente ejecutada tiene
 * VARIAS ejecuciones, a precios y horas distintos, y pintarla como un solo
 * punto en su hora de cierre coloca el marcador donde no ocurrio nada.
 *
 * Se AGRUPAN por vela y por lado. Un market maker ejecuta decenas de veces
 * dentro de la misma barra, y una flecha por ejecucion daba un muro de flechas
 * identicas apiladas en la misma columna: no se leia ni cuantas eran ni a que
 * precio. Compras y ventas no se funden entre si —promediarlas inventaria un
 * precio en el que no paso nada— y el precio del grupo es la media ponderada
 * por cantidad, que es el precio al que de verdad se opero.
 *
 * @param opts.bucketMs duracion de la vela que se esta mirando. Es la reserva.
 * @param opts.barsMs marcas de tiempo de las velas cargadas, ascendentes. Es lo
 *   que se usa cuando hay serie: ver la nota de `bucketOf`.
 */
export function buildFillMarkers(
  fills: BotFill[],
  opts: { bucketMs: number; barsMs?: readonly number[] },
): OverlayMarker[] {
  const span = Number.isFinite(opts.bucketMs) && opts.bucketMs > 0 ? opts.bucketMs : 60_000;
  const bars = opts.barsMs && opts.barsMs.length > 0 ? opts.barsMs : null;

  interface Grupo {
    timeMs: number;
    side: 'BUY' | 'SELL';
    /** Suma de precio x cantidad, para la media ponderada. */
    notional: number;
    qty: number;
    /** Suma simple de precios: reserva si la cantidad total sale cero. */
    sumaPrecios: number;
    count: number;
    titulos: Set<string>;
    id: string;
  }

  const grupos = new Map<string, Grupo>();

  for (const f of fills) {
    const at = Date.parse(f.executed_at);
    if (!Number.isFinite(at)) continue;
    const price = Number(f.price);
    // Un precio ilegible producia un marcador sin sitio donde ponerse: ahora
    // que el marcador se ancla al precio, eso ya no es un detalle cosmetico.
    if (!Number.isFinite(price) || price <= 0) continue;
    const qty = Number(f.qty);
    const cantidad = Number.isFinite(qty) && qty > 0 ? qty : 0;

    const cubo = bucketOf(at, span, bars);
    const clave = `${cubo}|${f.side}`;
    const grupo = grupos.get(clave);
    if (grupo) {
      grupo.notional += price * cantidad;
      grupo.qty += cantidad;
      grupo.sumaPrecios += price;
      grupo.count += 1;
      grupo.titulos.add(levelTitle(f.order));
    } else {
      grupos.set(clave, {
        timeMs: cubo,
        side: f.side,
        notional: price * cantidad,
        qty: cantidad,
        sumaPrecios: price,
        count: 1,
        titulos: new Set([levelTitle(f.order)]),
        id: `${cubo}:${f.side}`,
      });
    }
  }

  return (
    [...grupos.values()]
      .map((g): OverlayMarker => {
        // Media ponderada por cantidad; si el ledger trae cantidades a cero
        // —no deberia, pero es un ledger— cae a la media simple en vez de
        // emitir un NaN que dejaria el marcador sin dibujar.
        const price = g.qty > 0 ? g.notional / g.qty : g.sumaPrecios / g.count;
        const titulos = [...g.titulos];
        const text =
          g.count === 1
            ? titulos[0]
            : titulos.length === 1
              ? `${titulos[0]} ×${g.count}`
              : `${g.side === 'BUY' ? 'COMPRA' : 'VENTA'} ×${g.count}`;
        return {
          id: g.id,
          timeMs: g.timeMs,
          side: g.side,
          price,
          qty: g.qty,
          count: g.count,
          text,
        };
      })
      // Ascendente: la API sirve el ledger de la mas reciente a la mas antigua y
      // el motor grafico espera los marcadores en orden creciente de tiempo.
      .sort((a, b) => a.timeMs - b.timeMs)
  );
}

/**
 * Rótulos cortos de los sucesos que se pintan. `eventLabel()` da la frase
 * entera para la bitácora; sobre una vela caben ocho letras.
 */
const EVENT_SHORT: Record<string, string> = {
  GRID_REANCHORED: 'RECENTRO',
  SAFETY_ADDED: 'SAF+',
  MARGIN_ADJUSTED: 'MARGEN',
  CONFIG_RELOADED: 'CONFIG',
  RISK_GUARD_TRIPPED: 'GUARDA',
  LIQUIDATION_NEAR: 'LIQ',
  LIQUIDATED: 'LIQUIDADO',
  ORDER_REJECTED: 'RECHAZO',
  ORDER_UNVIABLE: 'INVIABLE',
  ORDER_RETRY: 'REINTENTO',
  INSUFFICIENT_FUNDS: 'FONDOS',
  PANIC: 'PÁNICO',
  AUTH_ERROR: 'AUTH',
  STREAM_ERROR: 'FLUJO',
  TICK_ERROR: 'ERROR',
  FAIR_PRICE_STALE: 'PRECIO',
  FAIR_PRICE_UNAVAILABLE: 'PRECIO',
  MARKET_SPEC_CHANGED: 'REGLAS',
  START_FAILED: 'ARRANQUE',
  ACTION_FAILED: 'FALLO',
};

/**
 * Marcadores de suceso, a partir de la bitácora del bot (spec 005, R-2).
 *
 * Misma tubería que `buildFillMarkers`: se agrupan por vela —con las velas
 * cargadas mandando sobre la aritmética, ver `bucketOf`— y salen ascendentes.
 * Qué entra y cómo se funde lo decide `agruparSucesos` en `@crypton/shared`,
 * que es lo que tiene test; aquí solo se ponen los rótulos.
 */
export function buildEventMarkers(
  events: readonly BotEvent[],
  opts: { bucketMs: number; barsMs?: readonly number[] },
): OverlayEventMarker[] {
  const span = Number.isFinite(opts.bucketMs) && opts.bucketMs > 0 ? opts.bucketMs : 60_000;
  const bars = opts.barsMs && opts.barsMs.length > 0 ? opts.barsMs : null;
  const grupos = agruparSucesos(
    events.map((e) => ({ type: e.type, severity: e.severity, at: Date.parse(e.created_at) })),
    (at) => bucketOf(at, span, bars),
  );
  return grupos.map((g) => {
    const corto = EVENT_SHORT[g.tipos[0]] ?? g.tipos[0];
    const text =
      g.count === 1 ? corto : g.tipos.length === 1 ? `${corto} ×${g.count}` : `${g.count} sucesos`;
    return { id: `${g.t}:${g.tono}`, timeMs: g.t, tone: g.tono, text, count: g.count };
  });
}
