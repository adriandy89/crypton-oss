import { createHash } from 'node:crypto';
import { D, repartoDeEjecucion, type MarketFeatures, type ResumenDeCiclos } from '@crypton/shared';
import type { Knobs } from '../advisor/build';
import {
  PERILLAS,
  type Desplazamientos,
  type Efecto,
  type EfectoDePerilla,
  type Efectos,
  type Movimiento,
} from './apply';
import { PROMPT_VERSION_REVISION, type Accion } from './decision';

/**
 * El expediente de un bot vivo, tal como lo ve el modelo.
 *
 * Extiende a todo el bot la doctrina que `advisor/market-features.ts` aplica al
 * mercado: **todo llega masticado y cuantizado, y el modelo no calcula nada**.
 * Pedirle a un modelo de lenguaje que divida una posicion entre un capital para
 * saber si esta muy expuesto es la peor forma posible de averiguarlo: cuesta
 * tokens, tarda y sale mal.
 *
 * Y una regla que aqui es mas fuerte que en el asesor: **el modelo no ve dinero
 * ni texto libre**.
 *
 *   - Nada de importes ni de precios absolutos. Todo va en porcentajes y tramos.
 *     No es solo prudencia: un numero absoluto no significa nada sin el resto del
 *     contexto —«posicion de 4.200» no dice si es mucho o poco—, mientras que
 *     «el 84 % del capital» se interpreta solo.
 *   - Nada de `bot.name` ni `bot.note`. Los escribe el usuario, asi que son la
 *     via natural de inyeccion de prompt, y no aportan NADA a la decision: un bot
 *     no se configura mejor por llamarse «el bueno».
 *
 * Desde el spec 051, una tercera: **el modelo no se lee a si mismo**. Ni sus
 * propios eventos entre las incidencias ni sus propios motivos en el historial.
 * En produccion un solo timeout del modelo acabo en veinte avisos de «fallos de
 * IA persistentes», y cada aviso alimentaba el siguiente: el expediente le
 * enseñaba «AI_ADVICE: muchos» y «AVISAR hace 30 minutos», y el modelo concluia
 * que el problema seguia sin resolverse.
 *
 * Hay un test que serializa el expediente y falla si encuentra algo que parezca
 * una credencial, un identificador, un precio o un importe.
 */

/** Tramos de una magnitud, para que la huella no cambie con cada tick. */
function tramo(v: number, cortes: readonly number[]): number {
  for (let i = 0; i < cortes.length; i++) if (v < cortes[i]) return i;
  return cortes.length;
}

/** Etiqueta legible de un tramo, que es lo que lee el modelo. */
function etiqueta(v: number, cortes: readonly number[], nombres: readonly string[]): string {
  return nombres[tramo(v, cortes)];
}

const pct = (v: number): string => `${v.toFixed(1)} %`;
const conSigno = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(1)} %`;

/** Un grupo de eventos del bot en las ultimas 24 horas. */
export interface GrupoDeEventos {
  tipo: string;
  severidad: string;
  n: number;
}

/** Lo que dice `bot_mm_stats` de un market maker. Solo los importes no viajan. */
export interface ActividadMm {
  fills: number;
  compras: number;
  ventas: number;
  maker: number;
  taker: number;
  /**
   * Pares casados: cada ejecucion que reduce la posicion. Es lo que en un
   * market maker hace de «ciclo», porque su ciclo de verdad no cierra nunca.
   */
  pares: number;
  /** Beneficio bruto de los pares casados, antes de comisiones. NO viaja. */
  margenBruto: string;
  /** Comisiones pagadas. NO viaja. */
  comisiones: string;
}

/** Un cambio anterior del supervisor sobre el bot: lo que se pidio y en que acabo. */
export interface CambioAnterior {
  accion: Accion;
  estado: 'APLICADA' | 'PROPUESTA' | 'RECHAZADA' | 'CADUCADA';
  /** Solo las perillas que se pidio mover. */
  movimientos: Partial<Record<keyof Desplazamientos, Movimiento>>;
  hace: string;
}

export interface EntradaExpediente {
  estrategia: string;
  direccion: string;
  simulado: boolean;
  estado: string;
  /** Horas desde que arrancó. */
  horasEnMarcha: number;
  knobs: Knobs;
  /** Rasgos del par AHORA. */
  mercado: MarketFeatures;
  /** Los de cuando se configuró, si se guardaron. */
  mercadoAlConfigurar: MarketFeatures | null;
  ciclos: ResumenDeCiclos;
  /** Capital asignado, solo para calcular porcentajes. NO viaja al modelo. */
  capital: string;
  /** Valor absoluto de la posición por el precio medio. Tampoco viaja. */
  expuesto: string;
  /** Resultado no realizado. Tampoco viaja. */
  noRealizado: string;
  /** Si hay posición según el último estado fresco del bot. */
  posicionAbierta: boolean;
  /**
   * Si hay estado reciente del bot (menos de diez minutos).
   *
   * Sin él, el expediente decía «sin posición abierta» —cuenta hechos— mientras
   * la guarda suponía posición abierta si el ciclo tenía inventario, y el modelo
   * leía a la vez que no hay posición y que todo está bloqueado por tenerla
   * (spec 052, F-16).
   */
  estadoFresco: boolean;
  /** Distancia a liquidación en %, o null si no hay precio de liquidación. */
  distanciaLiquidacionPct: number | null;
  ordenesVivas: number;
  /** Horas desde la última ejecución, o null si nunca ejecutó. */
  horasSinEjecutar: number | null;
  /** Eventos de las últimas 24 h, por tipo y severidad, sin filtrar. */
  grupos24h: readonly GrupoDeEventos[];
  /** Estadísticas de market maker, si las hay. */
  mm: ActividadMm | null;
  /** Realizado acumulado desde que opera. NO viaja. */
  realizadoAcumulado: string | null;
  /** Realizado de las últimas 24 h, si hay un estado de hace un día. NO viaja. */
  realizado24h: string | null;
  /** Los cambios anteriores del supervisor, de más reciente a más antiguo. */
  historial: readonly CambioAnterior[];
  /** «hace X» del último aviso a una persona dentro del enfriamiento, o null. */
  ultimoAviso: string | null;
  /** Qué cambiaría mover cada perilla un paso, o null si no se pudo calcular. */
  efectos: Efectos | null;
}

/** El expediente ya cuantizado. Es lo que se guarda y lo que se renderiza. */
export interface Expediente {
  estrategia: string;
  direccion: string;
  simulado: boolean;
  antiguedad: string;
  perillas: Record<string, string>;
  /** Una línea por perilla: qué cambiaría moverla un paso en cada sentido. */
  efectos: string[];
  mercado: {
    volatilidadAnual: string;
    recorridoHora: string;
    recorridoDia: string;
    rango30: string;
    posicionEnRango: string;
    tendencia: string;
    eficiencia: string;
    peorSesion: string;
    /** Como ha cambiado el regimen desde que se configuro. Lo que mas decide. */
    cambioDeVolatilidad: string | null;
  };
  posicion: {
    exposicion: string;
    distanciaLiquidacion: string;
    resultadoLatente: string;
    ordenesVivas: string;
    /** Solo cuando NO hay estado reciente: qué se sabe y qué se supone. */
    sinEstadoReciente: string | null;
  };
  rendimiento: {
    esMarketMaker: boolean;
    ciclosCerrados: number;
    acierto: string;
    beneficioMedio: string;
    duracionTipica: string;
    costeDeComisiones: string;
    ejecucionMaker: string | null;
    sinEjecutar: string;
    realizado: string;
    ultimas24h: string;
    ejecuciones24h: string;
    /** Solo en los market makers. */
    marketMaker: { pares: string; margen: string; compraventa: string } | null;
  };
  salud24h: Record<string, string>;
  historial: string[];
  avisoVigente: string | null;
  /** Las partes de la huella, en tramos. Se guardan para poder explicar una llamada. */
  huella: string[];
}

const ESTRATEGIAS_MARKET_MAKER = new Set(['MARKET_MAKER', 'MARKET_MAKER_V2']);

const TRAMOS_EXPOSICION = [1, 25, 50, 75, 100];
const NOMBRES_EXPOSICION = [
  'sin posición',
  'menos de un cuarto del capital',
  'entre un cuarto y la mitad',
  'entre la mitad y tres cuartos',
  'casi todo el capital',
  'más que el capital asignado',
];

const TRAMOS_LIQUIDACION = [5, 8, 15, 30];
const NOMBRES_LIQUIDACION = [
  'MUY CERCA (menos del 5 %)',
  'cerca (5-8 %)',
  'a media distancia (8-15 %)',
  'holgada (15-30 %)',
  'muy holgada (más del 30 %)',
];

const TRAMOS_HORAS = [1, 6, 24, 72, 168];
const NOMBRES_HORAS = [
  'menos de una hora',
  'unas horas',
  'menos de un día',
  'unos días',
  'una semana',
  'más de una semana',
];

const TRAMOS_CUENTA = [1, 4, 11];
const NOMBRES_CUENTA = ['ninguno', 'alguno (1-3)', 'varios (4-10)', 'muchos (más de 10)'];
const NOMBRES_EJECUCIONES = ['ninguna', 'alguna (1-3)', 'varias (4-10)', 'muchas (más de 10)'];

const TRAMOS_PARES = [1, 10, 100, 1000];
const NOMBRES_PARES = ['ninguno', 'unos pocos', 'decenas', 'cientos', 'miles'];

/** Los nombres del contrato, con el castellano al lado para leerlos. */
const NOMBRE_PERILLA: Record<keyof Desplazamientos, string> = {
  leverage: 'leverage (apalancamiento)',
  coverage: 'coverage (cobertura)',
  spread: 'spread (diferencial)',
  sizeGrowth: 'sizeGrowth (crecimiento)',
  cadence: 'cadence (cadencia)',
};

/**
 * Los eventos que SI son incidencias: avisos, errores y criticos.
 *
 * Y aun entre esos, fuera lo que no es un problema de la configuracion:
 *
 *   - `AI_*` los escribe el propio supervisor. Enseñarselos es el bucle que
 *     convirtio un timeout en veinte avisos.
 *   - `CONFIG_*` es el rastro de un cambio, muchas veces del propio supervisor.
 *   - `COMMAND_*`, `BOT_*` y `PANIC` son acciones de una persona o del ciclo de
 *     vida del bot: reanudarlo tras una caida no es una averia.
 *   - `VENUE_*` y `STREAM_*` son caidas del exchange o de su conexion: ya las
 *     avisa el motor y ninguna perilla las arregla (spec 050).
 *   - `FILL`, `CYCLE_CLOSED` y `MARGIN_ADJUSTED` son operacion normal.
 *   - `TICK_SLOW` es el cupo de peticiones del venue haciendo esperar al motor, y
 *     `LEVERAGE_SKIPPED` y `POSITION_MODE_SKIPPED` son ajustes que el venue no
 *     acepta con una posicion abierta. Ninguna perilla los arregla, y presentarlos
 *     como averia solo lleva al modelo a avisar (spec 052, F-18). `FAIR_PRICE_*`
 *     si se queda: ahi tiene que actuar una persona —cambiar la fuente de
 *     precio— y para eso esta `AVISAR`.
 *
 * Los rechazos post-only de un market maker no necesitan regla: se escriben como
 * `INFO` y el filtro de severidad ya los deja fuera, igual que ya los ignoraba el
 * disparador del planificador (spec 029).
 */
const SEVERIDADES_DE_INCIDENCIA = new Set(['WARN', 'ERROR', 'CRITICAL']);
const NO_SON_INCIDENCIAS: readonly RegExp[] = [
  /^AI_/,
  /^CONFIG_/,
  /^COMMAND_/,
  /^BOT_/,
  /^VENUE_/,
  /^STREAM_/,
  /^(PANIC|FILL|CYCLE_CLOSED|MARGIN_ADJUSTED)$/,
  /^(TICK_SLOW|LEVERAGE_SKIPPED|POSITION_MODE_SKIPPED)$/,
];

/** Las incidencias reales de las ultimas 24 h, sumadas por tipo. */
export function incidencias(grupos: readonly GrupoDeEventos[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const g of grupos) {
    if (!SEVERIDADES_DE_INCIDENCIA.has(g.severidad)) continue;
    if (NO_SON_INCIDENCIAS.some((r) => r.test(g.tipo))) continue;
    out[g.tipo] = (out[g.tipo] ?? 0) + g.n;
  }
  return out;
}

/**
 * El margen de los pares casados de un market maker, y su categoria para la
 * huella. Es la cifra que dice si un market maker funciona: el market maker V2 de LIT llevaba
 * 758 pares con el margen bruto en negativo —compraba mas caro de lo que
 * vendia— y el expediente decia «sin ciclos cerrados».
 */
function margenDePares(mm: ActividadMm): { texto: string; categoria: string } {
  if (mm.pares === 0) return { texto: 'sin pares casados todavía', categoria: 'NA' };
  const bruto = D(mm.margenBruto);
  const comisiones = D(mm.comisiones);
  if (bruto.lte(0)) {
    return {
      texto: 'NEGATIVO: compra más caro de lo que vende, antes incluso de pagar comisiones',
      categoria: 'NEG',
    };
  }
  const parte = comisiones.div(bruto).mul(100).toFixed(0);
  if (comisiones.gte(bruto)) {
    return {
      texto: `positivo, pero las comisiones se llevan el ${parte} %: pierde tras comisiones`,
      categoria: 'COM',
    };
  }
  return {
    texto: `positivo: las comisiones se llevan el ${parte} % de lo capturado`,
    categoria: 'POS',
  };
}

function compraventa(mm: ActividadMm): string {
  if (mm.compras + mm.ventas === 0) return 'sin ejecuciones';
  if (mm.ventas === 0) return 'solo compras, ninguna venta';
  if (mm.compras === 0) return 'solo ventas, ninguna compra';
  const menor = Math.min(mm.compras, mm.ventas);
  const mayor = Math.max(mm.compras, mm.ventas);
  if (menor / mayor >= 0.8) return 'equilibradas';
  return mm.compras > mm.ventas ? 'más compras que ventas' : 'más ventas que compras';
}

const ROTULO_EFECTO: Record<Exclude<Efecto, 'APLICABLE'>, string> = {
  EXTREMO: 'ya está en el extremo de su escala',
  SIN_CAMBIOS: 'no cambia nada en esta estrategia con este mercado',
  VALIDACION: 'no cabe: la configuración resultante no es válida',
  VENUE: 'no cabe en las reglas del exchange',
  RIESGO: 'bloqueado: subiría el riesgo con la posición abierta',
  CIERRE: 'bloqueado: podría cerrar la posición abierta',
  RESHAPE: 'exige recolocar las órdenes, y ahora no está permitido',
  COLD: 'no se puede cambiar con el bot creado',
  DEMASIADAS_PERILLAS: 'no aplica',
};

function listarCampos(campos: readonly string[]): string {
  if (campos.length <= 3) return campos.join(', ');
  return `${campos.slice(0, 3).join(', ')} y ${campos.length - 3} más`;
}

function describirEfecto(f: EfectoDePerilla): string {
  const lado = (mov: 'MENOS' | 'MAS'): string => {
    const efecto = f[mov];
    if (efecto !== 'APLICABLE') return `${mov} no (${ROTULO_EFECTO[efecto]})`;
    // Un escalon corto no es una perilla muerta: con la cota relativa del spec
    // 052 hay campos que solo se mueven pidiendo los DOS escalones, y decir «no»
    // le quitaba al modelo el movimiento que si servia (F-08).
    const cuanto = f.soloDoble[mov] ? `solo con MUCHO_${mov}` : 'sí';
    return `${mov} ${cuanto} (mueve ${listarCampos(f.campos[mov])})`;
  };
  return `${lado('MENOS')}; ${lado('MAS')}`;
}

/** Para la huella, en grueso: se aplica, no hace nada, o esta bloqueado. */
const codigoDeEfecto = (e: Efecto): string =>
  e === 'APLICABLE' ? 'A' : e === 'RIESGO' || e === 'CIERRE' ? 'B' : 'N';

const ESTADO_DEL_CAMBIO: Record<CambioAnterior['estado'], string> = {
  APLICADA: 'aplicado',
  PROPUESTA: 'pendiente de que una persona lo apruebe',
  RECHAZADA: 'RECHAZADO por una persona: no lo repitas sin un motivo nuevo',
  // Sin esta, el modelo no sabia que ya lo habia propuesto y lo repetia en cuanto
  // la huella cambiaba, con otro mensaje de Telegram cada vez (spec 052, F-17).
  CADUCADA: 'CADUCADO sin que nadie lo aprobara: no lo repitas sin un motivo nuevo',
};

/**
 * Construye el expediente. Aqui es donde el dinero se convierte en porcentaje y
 * deja de existir: a partir de esta funcion no hay ni un importe.
 */
export function construirExpediente(e: EntradaExpediente): Expediente {
  const capital = D(e.capital);
  const porcentajeDelCapital = (v: string): number =>
    capital.gt(0) ? D(v).div(capital).mul(100).toNumber() : 0;

  const expuestoPct = porcentajeDelCapital(e.expuesto);
  const latentePct = porcentajeDelCapital(e.noRealizado);
  const realizadoPct =
    e.realizadoAcumulado === null ? null : porcentajeDelCapital(e.realizadoAcumulado);
  const realizado24hPct = e.realizado24h === null ? null : porcentajeDelCapital(e.realizado24h);

  const cambioVol =
    e.mercadoAlConfigurar && e.mercadoAlConfigurar.atrPct1d > 0
      ? e.mercado.atrPct1d / e.mercadoAlConfigurar.atrPct1d
      : null;
  const regimen =
    cambioVol === null ? '-' : cambioVol >= 1.3 ? 'MAS' : cambioVol <= 0.77 ? 'MENOS' : 'PARECIDO';

  const esMarketMaker = ESTRATEGIAS_MARKET_MAKER.has(e.estrategia);
  const incid = incidencias(e.grupos24h);
  const ejecuciones = e.grupos24h
    .filter((g) => g.tipo === 'FILL')
    .reduce((suma, g) => suma + g.n, 0);
  const margen = e.mm ? margenDePares(e.mm) : null;
  const reparto = e.mm
    ? repartoDeEjecucion({ makerFills: e.mm.maker, takerFills: e.mm.taker })
    : null;

  const sinEjecutar =
    e.horasSinEjecutar === null
      ? 'no ha ejecutado nunca'
      : etiqueta(e.horasSinEjecutar, TRAMOS_HORAS, NOMBRES_HORAS);
  const distanciaLiquidacion = !e.posicionAbierta
    ? 'sin posición abierta'
    : e.distanciaLiquidacionPct === null
      ? 'sin precio de liquidación (colateral holgado o dato no disponible)'
      : etiqueta(e.distanciaLiquidacionPct, TRAMOS_LIQUIDACION, NOMBRES_LIQUIDACION);
  const exposicion = etiqueta(expuestoPct, TRAMOS_EXPOSICION, NOMBRES_EXPOSICION);
  const costeDeComisiones = costeDeComisionesDeCiclos(e.ciclos);

  const efectos = e.efectos;
  const huella = [
    // La version del prompt, para que un bot tranquilo se vuelva a preguntar
    // cuando el prompt cambia (spec 051, H-14).
    `v${PROMPT_VERSION_REVISION}`,
    e.estrategia,
    e.direccion,
    Object.values(e.knobs).join('.'),
    // Los mismos cortes que `featuresBucket` del asesor: tramos gruesos de lo que
    // cambia una decision, no la cifra con un decimal que cambia cada media hora.
    `atr1h:${tramo(e.mercado.atrPct1h, [0.2, 0.4, 0.7, 1.2, 2, 3.5, 6])}`,
    `atr1d:${tramo(e.mercado.atrPct1d, [1, 2, 3.5, 6, 10, 16])}`,
    `vol:${tramo(e.mercado.volAnnualPct, [30, 60, 100, 160, 250])}`,
    `tendencia:${e.mercado.trend}`,
    `eficiencia:${tramo(e.mercado.efficiency, [0.15, 0.3, 0.5])}`,
    `regimen:${regimen}`,
    `posicion:${e.posicionAbierta ? 1 : 0}`,
    `exposicion:${tramo(expuestoPct, TRAMOS_EXPOSICION)}`,
    `liquidacion:${distanciaLiquidacion}`,
    // Sin corte en cero: el latente de un market maker oscila alrededor de el
    // todo el rato, y +0,1 % y −0,1 % caian en tramos distintos, asi que cada
    // cruce costaba una llamada pagada sin informacion nueva (spec 052, F-14).
    `latente:${e.posicionAbierta ? tramo(latentePct, [-10, -5, -2, 2, 5]) : '-'}`,
    `sinEjecutar:${sinEjecutar}`,
    esMarketMaker
      ? `margen:${margen?.categoria ?? 'NA'}`
      : `acierto:${e.ciclos.aciertoPct === null ? '-' : tramo(Number(e.ciclos.aciertoPct), [25, 50, 75])}`,
    `realizado:${realizadoPct === null ? '-' : tramo(realizadoPct, [-10, -5, -2, -0.5, 0.5, 2, 5])}`,
    `24h:${realizado24hPct === null ? '-' : tramo(realizado24hPct, [-5, -2, -0.5, 0.5, 2, 5])}`,
    `incidencias:${Object.entries(incid)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([tipo, n]) => `${tipo}=${tramo(n, TRAMOS_CUENTA)}`)
      .join(',')}`,
    `efectos:${efectos ? PERILLAS.map((p) => codigoDeEfecto(efectos[p].MENOS) + codigoDeEfecto(efectos[p].MAS)).join('') : '-'}`,
    // El aviso NO entra: lo escribe el propio supervisor, asi que avisar cambiaba
    // la huella y la revision siguiente pagaba una llamada por un cambio que
    // habia provocado el —y otra al caducar—. La linea sigue en el prompt, que es
    // donde hace falta, pero ya no dispara ninguna (spec 052, F-15).
    `fresco:${e.estadoFresco ? 1 : 0}`,
  ];

  return {
    estrategia: e.estrategia,
    direccion: e.direccion,
    simulado: e.simulado,
    antiguedad: etiqueta(e.horasEnMarcha, TRAMOS_HORAS, NOMBRES_HORAS),
    perillas: {
      perfil: e.knobs.profile,
      apalancamiento: e.knobs.leverage,
      cobertura: e.knobs.coverage,
      diferencial: e.knobs.spread,
      crecimiento: e.knobs.sizeGrowth,
      cadencia: e.knobs.cadence,
    },
    efectos: efectos
      ? PERILLAS.map((p) => `${NOMBRE_PERILLA[p]}: ${describirEfecto(efectos[p])}`)
      : [],
    mercado: {
      volatilidadAnual: pct(e.mercado.volAnnualPct),
      recorridoHora: pct(e.mercado.atrPct1h),
      recorridoDia: pct(e.mercado.atrPct1d),
      rango30: pct(e.mercado.rangePct30),
      posicionEnRango: `${(e.mercado.posInRange * 100).toFixed(0)} % (0 = suelo, 100 = techo)`,
      tendencia: `${e.mercado.trend} (${pct(e.mercado.trendPct)} entre medias)`,
      eficiencia: `${e.mercado.efficiency.toFixed(2)} (0 = zigzag, 1 = línea recta)`,
      peorSesion: pct(e.mercado.worstDayPct),
      // La linea que de verdad decide, y por eso va con nombre propio: un bot no
      // esta mal configurado en abstracto, lo esta RESPECTO DE CUANDO se
      // configuro. Se da como multiplo porque es lo unico que el modelo necesita
      // para decidir si ensancha o estrecha.
      cambioDeVolatilidad:
        cambioVol === null
          ? null
          : cambioVol >= 1.3
            ? `el par se mueve ${cambioVol.toFixed(1)} veces MAS que cuando se configuró`
            : cambioVol <= 0.77
              ? `el par se mueve ${(1 / cambioVol).toFixed(1)} veces MENOS que cuando se configuró`
              : 'parecido a cuando se configuró',
    },
    posicion: {
      exposicion,
      // Sin precio de liquidacion no hay distancia, pero eso NO significa que no
      // haya posicion: el simulado no lo da, y con colateral holgado tampoco
      // existe. Decir «sin posicion abierta» con una abierta le daba al modelo dos
      // lineas que se contradecian (spec 051, H-09).
      distanciaLiquidacion,
      resultadoLatente: e.posicionAbierta
        ? `${conSigno(latentePct)} del capital`
        : 'sin posición abierta',
      // Recuento, no lista: cien ordenes enumeradas son una bomba de prompt y no
      // dicen nada que el numero no diga.
      ordenesVivas: etiqueta(e.ordenesVivas, TRAMOS_CUENTA, NOMBRES_CUENTA),
      sinEstadoReciente: e.estadoFresco
        ? null
        : 'No hay estado reciente del bot: lo de arriba puede estar desfasado y no se sabe si hay ' +
          'posición abierta. Se decide como si la hubiera, así que los movimientos que suben el ' +
          'riesgo aparecerán bloqueados.',
    },
    rendimiento: {
      esMarketMaker,
      ciclosCerrados: e.ciclos.cerrados,
      acierto: e.ciclos.aciertoPct === null ? 'sin ciclos cerrados' : `${e.ciclos.aciertoPct} %`,
      beneficioMedio:
        e.ciclos.beneficioMedio === null || capital.lte(0)
          ? 'sin ciclos cerrados'
          : `${pct(porcentajeDelCapital(e.ciclos.beneficioMedio))} del capital por ciclo`,
      duracionTipica:
        e.ciclos.duracionMedianaMs === null
          ? 'sin ciclos cerrados'
          : etiqueta(e.ciclos.duracionMedianaMs / 3_600_000, TRAMOS_HORAS, NOMBRES_HORAS),
      costeDeComisiones,
      ejecucionMaker:
        reparto === null || reparto.makerPct === null ? null : `${reparto.makerPct} % como maker`,
      sinEjecutar,
      realizado:
        realizadoPct === null
          ? 'sin datos'
          : `${conSigno(realizadoPct)} del capital desde que opera`,
      ultimas24h:
        realizado24hPct === null
          ? 'sin datos de hace un día'
          : `${conSigno(realizado24hPct)} del capital`,
      ejecuciones24h: etiqueta(ejecuciones, TRAMOS_CUENTA, NOMBRES_EJECUCIONES),
      marketMaker: esMarketMaker
        ? {
            pares: e.mm ? etiqueta(e.mm.pares, TRAMOS_PARES, NOMBRES_PARES) : 'ninguno',
            margen: margen?.texto ?? 'sin pares casados todavía',
            compraventa: e.mm ? compraventa(e.mm) : 'sin ejecuciones',
          }
        : null,
    },
    salud24h: Object.fromEntries(
      Object.entries(incid)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([tipo, n]) => [tipo, etiqueta(n, TRAMOS_CUENTA, NOMBRES_CUENTA)]),
    ),
    // Solo CAMBIOS, con sus movimientos enumerados, y nunca el motivo que escribio
    // el modelo: reinyectarle su propia prosa es lo que convertia una sospecha en
    // una certeza de un aviso al siguiente (spec 051, H-02).
    historial: e.historial.map((h) => {
      const movimientos = PERILLAS.filter((p) => h.movimientos[p] !== undefined)
        .map((p) => `${p} ${h.movimientos[p]}`)
        .join(', ');
      return `hace ${h.hace}: ${h.accion}${movimientos ? ` ${movimientos}` : ''} → ${ESTADO_DEL_CAMBIO[h.estado]}`;
    }),
    avisoVigente:
      e.ultimoAviso === null
        ? null
        : `Ya se avisó a una persona hace ${e.ultimoAviso}. Está informada: no repitas el aviso salvo que haya algo NUEVO.`,
    huella,
  };
}

/**
 * Que parte de lo capturado se llevan las comisiones en los ciclos cerrados.
 *
 * Es la cifra que dice si un bot esta operando demasiado para lo que saca, y por
 * eso se calcula aqui en vez de dejarle al modelo dividir dos importes — que
 * ademas obligaria a enseñarselos.
 */
function costeDeComisionesDeCiclos(c: ResumenDeCiclos): string {
  const bruto = D(c.neto).plus(c.comisiones);
  if (c.cerrados === 0) return 'sin ciclos cerrados';
  if (bruto.lte(0)) return 'el bot no ha capturado nada todavía';
  return `las comisiones se llevan el ${D(c.comisiones).div(bruto).mul(100).toFixed(1)} % de lo capturado`;
}

/** El expediente, en el texto que lee el modelo. */
export function expedienteAPrompt(e: Expediente): string {
  const lineas: string[] = [
    `Estrategia: ${e.estrategia}`,
    `Dirección: ${e.direccion}`,
    `Lleva operando: ${e.antiguedad}`,
  ];
  if (e.simulado) lineas.push('Es un bot SIMULADO: opera contra un simulador, no con dinero real.');

  lineas.push('', 'Perillas actuales:');
  for (const [k, v] of Object.entries(e.perillas)) lineas.push(`- ${k}: ${v}`);

  if (e.efectos.length > 0) {
    lineas.push(
      '',
      'Qué cambiaría ahora mover cada perilla un paso (calculado por nosotros; pedir otra cosa no cambia nada):',
    );
    for (const efecto of e.efectos) lineas.push(`- ${efecto}`);
  }

  lineas.push(
    '',
    'Mercado (calculado por nosotros a partir de las velas, no lo recalcules):',
    `- Volatilidad anualizada: ${e.mercado.volatilidadAnual}`,
    `- Recorrido típico por hora: ${e.mercado.recorridoHora}`,
    `- Recorrido típico por día: ${e.mercado.recorridoDia}`,
    `- Rango de los últimos 30 días: ${e.mercado.rango30}`,
    `- Posición dentro de ese rango: ${e.mercado.posicionEnRango}`,
    `- Tendencia: ${e.mercado.tendencia}`,
    `- Eficiencia del movimiento: ${e.mercado.eficiencia}`,
    `- Peor sesión diaria: ${e.mercado.peorSesion}`,
  );
  if (e.mercado.cambioDeVolatilidad) {
    lineas.push(`- CAMBIO DE RÉGIMEN: ${e.mercado.cambioDeVolatilidad}`);
  }

  lineas.push(
    '',
    'Cómo está el bot ahora:',
    `- Exposición: ${e.posicion.exposicion}`,
    `- Distancia a liquidación: ${e.posicion.distanciaLiquidacion}`,
    `- Resultado no realizado: ${e.posicion.resultadoLatente}`,
    `- Órdenes vivas: ${e.posicion.ordenesVivas}`,
  );
  if (e.posicion.sinEstadoReciente) lineas.push(`- ${e.posicion.sinEstadoReciente}`);

  lineas.push('', 'Cómo le ha ido:');
  const r = e.rendimiento;
  if (r.marketMaker) {
    lineas.push(
      '- Un market maker no cierra ciclos: se mide por sus pares casados (una compra y una venta que se compensan).',
      `- Pares casados: ${r.marketMaker.pares}`,
      `- Margen de los pares: ${r.marketMaker.margen}`,
      `- Compras y ventas: ${r.marketMaker.compraventa}`,
    );
  } else {
    lineas.push(
      `- Ciclos cerrados: ${r.ciclosCerrados}`,
      `- Acierto: ${r.acierto}`,
      `- Resultado medio: ${r.beneficioMedio}`,
      `- Duración típica de un ciclo: ${r.duracionTipica}`,
      `- Comisiones: ${r.costeDeComisiones}`,
    );
  }
  lineas.push(
    `- Resultado realizado: ${r.realizado}`,
    `- Resultado realizado en las últimas 24 h: ${r.ultimas24h}`,
    `- Ejecuciones en las últimas 24 h: ${r.ejecuciones24h}`,
    `- Desde la última ejecución: ${r.sinEjecutar}`,
  );
  if (r.ejecucionMaker) lineas.push(`- Ejecuciones: ${r.ejecucionMaker}`);

  const salud = Object.entries(e.salud24h);
  if (salud.length > 0) {
    lineas.push(
      '',
      'Incidencias de las últimas 24 h (solo avisos y errores; la operación normal no aparece aquí):',
    );
    for (const [tipo, cuantos] of salud) lineas.push(`- ${tipo}: ${cuantos}`);
  }

  if (e.historial.length > 0) {
    // Lo que impide el vaiven: sin esto el modelo sube una perilla, los
    // acoplamientos la bajan, y vuelve a subirla indefinidamente.
    lineas.push('', 'Tus cambios anteriores sobre este bot:');
    for (const h of e.historial) lineas.push(`- ${h}`);
  }

  if (e.avisoVigente) lineas.push('', e.avisoVigente);

  lineas.push('', 'Decide qué hacer con este bot.');
  return lineas.join('\n');
}

/**
 * La huella del expediente.
 *
 * Si no cambia, nada material ha cambiado y la decision anterior sigue valiendo:
 * se salta la llamada. Es la barrera que mas ahorra, y hasta el spec 051 casi no
 * ahorraba nada: se unian los campos YA FORMATEADOS y se cortaba a 64 caracteres
 * —el tamaño de la columna—, asi que solo cabian la estrategia, las perillas y
 * la volatilidad con un decimal, que cambia en cada revision. La posicion, las
 * incidencias y todo lo demas se quedaban siempre fuera del corte.
 *
 * Ahora las partes van en tramos gruesos (`Expediente.huella`) y lo que se
 * guarda es su `sha1`: 40 caracteres, quepa lo que quepa dentro. No entran ni el
 * historial ni la antiguedad, que cambian solos con el reloj sin que nada haya
 * pasado.
 */
export function expedienteBucket(e: Expediente): string {
  return createHash('sha1').update(e.huella.join('|')).digest('hex');
}
