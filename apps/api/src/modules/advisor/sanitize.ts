import type { FieldMeta, MarketSpec } from '@crypton/shared';

/**
 * Recorte y reparacion de una configuracion propuesta.
 *
 * Todo lo de este fichero es PURO y sin dependencias de Nest: es la barandilla
 * que separa «una sugerencia» de «una configuracion que se le puede ofrecer a
 * alguien que va a poner dinero detras». Se prueba sola, sin levantar la API.
 *
 * El reparto de responsabilidades importa:
 *
 *   - Aqui se REPARA lo que se puede reparar de forma determinista: tipos,
 *     rangos del descriptor y los acoplamientos entre campos que ninguna
 *     validacion deduce mirando un campo aislado.
 *   - `validate()` y `preview()` de `strategy-core` son los que DECIDEN. Lo que
 *     no pasa por ahi se descarta; no se intenta arreglar, porque arreglar un
 *     fallo de validacion es adivinar.
 */

/**
 * Apalancamiento maximo que el servidor va a aceptar de verdad.
 *
 * NO es el 50 del descriptor ni el que admita el venue. `RiskService` rechaza
 * con 403 toda configuracion cuya distancia a liquidacion baje del 5 %, y con la
 * tasa de mantenimiento del 0,5 % esa distancia es `100/lev - 0,5`:
 *
 *     17x -> 5,382 %  pasa        19x -> 4,763 %  403
 *     18x -> 5,056 %  pasa        20x -> 4,500 %  403
 *
 * De ahi el 18. Sin este tope, un perfil «agresivo» a 20x se veria perfecto en
 * pantalla, pasaria la validacion local y moriria en un 403 al pulsar «Crear
 * bot», despues de que el usuario lo hubiera revisado todo.
 */
export const MAX_SAFE_LEVERAGE = 18;

/** Margen que se le deja a la cobertura de la escalera frente a la liquidacion. */
const COVERAGE_TARGET = 0.85;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const clamp = (v: number, min: number, max: number): number =>
  Math.min(Math.max(v, min), max);

/**
 * Cuantiza al paso del campo.
 *
 * Se ancla al minimo y no al cero: un campo que va de 0,05 a 20 con paso 0,05
 * cuantizado contra el cero puede caer en 0, que esta fuera de rango. Y se
 * redondea el resultado a diez decimales porque `Math.round(x/0.05)*0.05`
 * produce cosas como 1,3000000000000003, que luego se enseñan tal cual.
 */
function quantize(
  value: number,
  step: number | undefined,
  min: number,
): number {
  if (!step || step <= 0) return value;
  const pasos = Math.round((value - min) / step);
  return Number((min + pasos * step).toFixed(10));
}

/**
 * Lleva un valor al rango legal de su campo.
 *
 * El rango que manda es el del DESCRIPTOR, no el de `validate()`: en varios
 * campos el descriptor es mas estricto —`volumeScale` llega a 5 en el descriptor
 * y `validate` solo exige >= 1— y un valor fuera del descriptor pasaria la
 * validacion pero el formulario lo rechazaria.
 */
export function coerceField(field: FieldMeta, raw: unknown): unknown {
  switch (field.kind) {
    case 'boolean':
      return typeof raw === 'boolean' ? raw : raw === 'true';

    case 'enum': {
      const s = String(raw);
      return field.options?.includes(s)
        ? s
        : (field.default ?? field.options?.[0]);
    }

    case 'text':
      // Solo una cadena vale como cadena. `String()` sobre un objeto o un array
      // devuelve «[object Object]» o «a,b», y eso se guardaria en la
      // configuracion del bot como si fuera un valor que alguien escribio.
      return typeof raw === 'string' ? raw : '';

    default: {
      const n = num(raw);
      if (n === null) return field.default;
      const min = field.min ?? Number.NEGATIVE_INFINITY;
      const max = field.max ?? Number.POSITIVE_INFINITY;
      let v = clamp(n, min, max);
      if (field.kind === 'integer') v = Math.round(v);
      else if (Number.isFinite(min))
        v = clamp(quantize(v, field.step, min), min, max);
      return v;
    }
  }
}

/**
 * Recorta la configuracion entera contra el descriptor de la estrategia.
 *
 * Lo que no tenga descriptor se descarta: el modelo no puede inventar campos, y
 * `exchangeAccountId` y `symbol` los pone el formulario, nunca la recomendacion.
 */
export function coerceConfig(
  fields: readonly FieldMeta[],
  defaults: Record<string, unknown>,
  proposed: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...defaults };
  for (const field of fields) {
    if (field.key === 'exchangeAccountId' || field.key === 'symbol') continue;
    if (!(field.key in proposed)) continue;
    out[field.key] = coerceField(field, proposed[field.key]);
  }
  return out;
}

/**
 * Cobertura acumulada de una escalera de martingala, en porcentaje.
 *
 * Replica el calculo de `validateLadderConfig`: la separacion crece con
 * `stepScale` en cada nivel, asi que la cobertura es una serie geometrica y no
 * `numLimitBuys x separacion`. Confundirlas es lo que hace que una escalera
 * «parezca» caber y no quepa.
 */
export function ladderCoveragePct(
  numLimitBuys: number,
  initialSeparationPct: number,
  stepScale: number,
): number {
  let gap = initialSeparationPct;
  let total = 0;
  for (let i = 0; i < numLimitBuys; i++) {
    total += gap;
    gap *= stepScale;
  }
  return total;
}

/**
 * Impone los acoplamientos que ninguna validacion deduce de un solo campo.
 *
 * Se REPARA en vez de descartar porque cada arreglo de aqui es determinista y
 * conservador: siempre mueve la configuracion hacia el lado seguro. Lo que no se
 * puede arreglar asi ya lo cortara `validate()`.
 *
 * @param maxLeverageUsuario el tope propio del usuario, si lo tiene puesto.
 */
export function enforceCouplings(
  kind: string,
  config: Record<string, unknown>,
  market: MarketSpec,
  maxLeverageUsuario: number | null,
): Record<string, unknown> {
  const c = { ...config };

  // ── Apalancamiento: el mas bajo de los cuatro topes ──
  const topes = [MAX_SAFE_LEVERAGE, market.maxLeverage];
  if (maxLeverageUsuario != null) topes.push(maxLeverageUsuario);
  const lev = Math.max(1, Math.min(num(c['leverage']) ?? 1, ...topes));
  c['leverage'] = Math.floor(lev);

  // ── Martingala y GridMart: la escalera tiene que caber antes de la
  //    liquidacion, o los ultimos niveles no se ejecutarian nunca ──
  if (kind === 'MARTINGALE' || kind === 'GRIDMART') {
    const niveles = num(c['numLimitBuys']) ?? 0;
    const stepScale = num(c['stepScale']) ?? 1;
    let separacion = num(c['initialSeparationPct']) ?? 0;
    if (niveles > 0 && separacion > 0) {
      // `100/lev` es la distancia a liquidacion; se apunta al 85 % de ella para
      // dejar colchon, porque la tasa de mantenimiento con la que se estima esa
      // liquidacion esta documentada como OPTIMISTA: la real llega antes.
      const objetivo = (100 / (c['leverage'] as number)) * COVERAGE_TARGET;
      const cobertura = ladderCoveragePct(niveles, separacion, stepScale);
      if (cobertura > objetivo) {
        // Se encoge la separacion inicial en proporcion. Es el campo que menos
        // cambia el caracter de la estrategia: tocar `numLimitBuys` cambiaria
        // cuantas oportunidades tiene el bot, y `stepScale`, su forma.
        separacion = separacion * (objetivo / cobertura);
        // Se trunca al paso HACIA ABAJO, no se redondea: redondear al 0,05 mas
        // cercano puede devolver la cobertura por encima del objetivo, que es
        // justo lo que esta reparacion venia a impedir. Y si ni con el minimo
        // del descriptor cabe, se recorta el numero de niveles, que es la otra
        // palanca; bajar el apalancamiento seria cambiar la estrategia.
        const MIN_SEP = 0.05;
        const truncada = Math.max(
          MIN_SEP,
          Math.floor(separacion / MIN_SEP) * MIN_SEP,
        );
        c['initialSeparationPct'] = Number(truncada.toFixed(10));

        let nivelesFinales = niveles;
        while (
          nivelesFinales > 1 &&
          ladderCoveragePct(nivelesFinales, truncada, stepScale) > objetivo
        ) {
          nivelesFinales -= 1;
        }
        if (nivelesFinales !== niveles) c['numLimitBuys'] = nivelesFinales;
      }
    }
  }

  // ── DCA temporizado: el plan de compras no puede superar el capital ──
  if (kind === 'TDCA') {
    const capital = num(c['totalInvestment']) ?? 0;
    const compras = num(c['maxBuysPerCycle']) ?? 1;
    const porCompra = num(c['amountPerBuy']) ?? 0;
    if (capital > 0 && compras > 0 && porCompra * compras > capital) {
      // Se baja el importe por compra, no el numero de compras: el numero es lo
      // que define hasta donde promedia el bot, que es la estrategia.
      c['amountPerBuy'] = Math.max(
        1,
        Math.floor((capital / compras) * 100) / 100,
      );
    }
  }

  // ── Rejilla neutral: el ancla tiene que caer dentro del rango ──
  if (kind === 'NEUTRAL_GRID') {
    const lower = num(c['lowerPrice']);
    const upper = num(c['upperPrice']);
    const ancla = num(c['anchorPrice']);
    if (lower != null && upper != null && upper > lower && ancla != null) {
      c['anchorPrice'] = clamp(ancla, lower, upper);
    }
  }

  // ── Market makers ──
  if (kind === 'MARKET_MAKER' || kind === 'MARKET_MAKER_V2') {
    // El umbral defensivo tiene que quedar POR DEBAJO del de riesgo alto, o el
    // bot pasaria a modo defensivo despues de haber cortado entradas.
    const defensivo = num(c['defensiveThresholdPct']);
    const alto = num(c['highRiskThresholdPct']);
    if (defensivo != null && alto != null && defensivo >= alto) {
      c['defensiveThresholdPct'] = Math.max(1, Math.min(alto - 5, 99));
    }

    // La distancia minima no puede superar a las distancias de cotizacion. V1 lo
    // valida; V2 NO, asi que aqui se impone para los dos.
    const minDist = num(c['minAllowedDistanceBps']);
    const compra = num(c['buyDistanceBps']);
    const venta = num(c['sellDistanceBps']);
    if (minDist != null && compra != null && venta != null) {
      const menor = Math.min(compra, venta);
      if (minDist > menor)
        c['minAllowedDistanceBps'] = Math.max(1, Math.floor(menor));
    }
  }

  return c;
}
