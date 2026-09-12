import { D, type MarketFeatures, type ResumenDeCiclos } from '@crypton/shared';
import type { Knobs } from '../advisor/build';
import type { Accion } from './decision';

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
  /** Distancia a liquidación en %, o null si no hay posición. */
  distanciaLiquidacionPct: number | null;
  ordenesVivas: number;
  /** maker/taker de los market maker, si los hay. */
  makerPct: string | null;
  /** Horas desde la última ejecución, o null si nunca ejecutó. */
  horasSinEjecutar: number | null;
  /** Recuento de eventos por tipo en las últimas 24 h. */
  eventos24h: Record<string, number>;
  /** Las últimas decisiones del supervisor, de más reciente a más antigua. */
  historial: { accion: Accion; hace: string }[];
}

/** El expediente ya cuantizado. Es lo que se guarda y lo que se renderiza. */
export interface Expediente {
  estrategia: string;
  direccion: string;
  simulado: boolean;
  antiguedad: string;
  perillas: Record<string, string>;
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
  };
  rendimiento: {
    ciclosCerrados: number;
    acierto: string;
    beneficioMedio: string;
    duracionTipica: string;
    costeDeComisiones: string;
    ejecucionMaker: string | null;
    sinEjecutar: string;
  };
  salud24h: Record<string, string>;
  historial: string[];
}

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

  const cambioVol =
    e.mercadoAlConfigurar && e.mercadoAlConfigurar.atrPct1d > 0
      ? e.mercado.atrPct1d / e.mercadoAlConfigurar.atrPct1d
      : null;

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
      exposicion: etiqueta(expuestoPct, TRAMOS_EXPOSICION, NOMBRES_EXPOSICION),
      distanciaLiquidacion:
        e.distanciaLiquidacionPct === null
          ? 'sin posición abierta'
          : etiqueta(e.distanciaLiquidacionPct, TRAMOS_LIQUIDACION, NOMBRES_LIQUIDACION),
      resultadoLatente:
        expuestoPct < 1
          ? 'sin posición abierta'
          : `${latentePct >= 0 ? '+' : ''}${latentePct.toFixed(1)} % del capital`,
      // Recuento, no lista: cien ordenes enumeradas son una bomba de prompt y no
      // dicen nada que el numero no diga.
      ordenesVivas: etiqueta(e.ordenesVivas, TRAMOS_CUENTA, NOMBRES_CUENTA),
    },
    rendimiento: {
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
      costeDeComisiones: costeDeComisiones(e.ciclos),
      ejecucionMaker: e.makerPct === null ? null : `${e.makerPct} % como maker`,
      sinEjecutar:
        e.horasSinEjecutar === null
          ? 'no ha ejecutado nunca'
          : etiqueta(e.horasSinEjecutar, TRAMOS_HORAS, NOMBRES_HORAS),
    },
    salud24h: Object.fromEntries(
      Object.entries(e.eventos24h)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([tipo, n]) => [tipo, etiqueta(n, TRAMOS_CUENTA, NOMBRES_CUENTA)]),
    ),
    historial: e.historial.map((h) => `${h.accion} hace ${h.hace}`),
  };
}

/**
 * Que parte de lo capturado se llevan las comisiones.
 *
 * Es la cifra que dice si un bot esta operando demasiado para lo que saca, y por
 * eso se calcula aqui en vez de dejarle al modelo dividir dos importes — que
 * ademas obligaria a enseñarselos.
 */
function costeDeComisiones(c: ResumenDeCiclos): string {
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

  lineas.push(
    '',
    'Cómo le ha ido:',
    `- Ciclos cerrados: ${e.rendimiento.ciclosCerrados}`,
    `- Acierto: ${e.rendimiento.acierto}`,
    `- Resultado medio: ${e.rendimiento.beneficioMedio}`,
    `- Duración típica de un ciclo: ${e.rendimiento.duracionTipica}`,
    `- Comisiones: ${e.rendimiento.costeDeComisiones}`,
    `- Desde la última ejecución: ${e.rendimiento.sinEjecutar}`,
  );
  if (e.rendimiento.ejecucionMaker) {
    lineas.push(`- Ejecuciones: ${e.rendimiento.ejecucionMaker}`);
  }

  const salud = Object.entries(e.salud24h);
  if (salud.length > 0) {
    lineas.push('', 'Incidencias de las últimas 24 h:');
    for (const [tipo, cuantos] of salud) lineas.push(`- ${tipo}: ${cuantos}`);
  }

  if (e.historial.length > 0) {
    // Lo que impide el vaiven: sin esto el modelo sube una perilla, los
    // acoplamientos la bajan, y vuelve a subirla indefinidamente.
    lineas.push('', 'Tus decisiones anteriores sobre este bot:');
    for (const h of e.historial) lineas.push(`- ${h}`);
  }

  lineas.push('', 'Decide qué hacer con este bot.');
  return lineas.join('\n');
}

/**
 * La huella del expediente, cuantizada.
 *
 * Si no cambia, el REGIMEN no ha cambiado y la decision anterior sigue valiendo:
 * se reutiliza sin pagar otra llamada. Cuantizar no es una optimizacion, es lo
 * que hace que la cache sirva de algo — con los valores crudos, un movimiento de
 * un centimo generaria una clave nueva y cada revision seria una llamada.
 *
 * Es el mismo patron que `featuresBucket` del asesor, y por eso entra lo mismo:
 * tramos gruesos de lo que de verdad cambia una decision. No entran ni el
 * historial ni la antiguedad, que cambian solos con el reloj sin que nada haya
 * pasado.
 */
export function expedienteBucket(e: Expediente): string {
  return [
    e.estrategia,
    Object.values(e.perillas).join(''),
    e.mercado.volatilidadAnual,
    e.mercado.recorridoDia,
    e.mercado.tendencia,
    e.mercado.eficiencia,
    e.mercado.cambioDeVolatilidad ?? '-',
    e.posicion.exposicion,
    e.posicion.distanciaLiquidacion,
    e.rendimiento.sinEjecutar,
    e.rendimiento.costeDeComisiones,
    Object.entries(e.salud24h)
      .map(([k, v]) => `${k}${v}`)
      .join(''),
  ]
    .join('|')
    .replace(/\s+/g, '')
    .slice(0, 64);
}
