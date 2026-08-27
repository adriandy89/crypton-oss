import { BANDS, PROFILES } from './build';
import type { MarketFeatures } from './market-features';

/**
 * Contrato con el modelo.
 *
 * **El modelo no emite parametros: emite perillas.** Es la decision que sostiene
 * toda la seguridad de esta funcionalidad, y no es una preferencia de estilo.
 *
 * No es una limitacion del proveedor. En el formato de OpenAI —el que habla
 * OpenRouter— las restricciones numericas SI se soportan; en la API nativa de
 * Anthropic no. Precisamente por eso el diseño no se apoya en ellas: un esquema
 * generado desde los rangos del descriptor daria una barandilla REAL con un
 * proveedor y DECORATIVA con otro, y el enrutado no lo elegimos nosotros. Lo
 * unico que acota igual en todos, a nivel de gramatica de decodificacion, es
 * `enum`.
 *
 * Y hay una razon mejor todavia: los rangos del descriptor no son el limite de
 * verdad. El limite de verdad depende de la spec del mercado y de los topes de
 * riesgo del usuario, y el modelo no ve ninguna de las dos cosas. Quien si las
 * ve es el generador determinista que convierte estas perillas en los treinta y
 * cuatro parametros. Con eso, tres cosas dejan de poder pasar:
 *
 *   - que proponga un apalancamiento que el servidor va a rechazar,
 *   - que proponga un precio absoluto (no conoce el mark del segundo actual),
 *   - que proponga un importe en USDC (seria dejarle decidir cuanto arriesga
 *     alguien).
 */

/**
 * Version del contrato. Entra en la clave de cache: cambiarla invalida lo
 * guardado, que es justo lo que hay que hacer al tocar el prompt o el esquema.
 */
export const PROMPT_VERSION = 1;

/** El esquema de salida. Solo enumeraciones: ver la nota de arriba. */
export function knobsSchema(): Record<string, unknown> {
  const banda = { type: 'string', enum: [...BANDS] };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['propuestas'],
    properties: {
      propuestas: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'profile',
            'leverage',
            'coverage',
            'spread',
            'sizeGrowth',
            'cadence',
            'rationale',
          ],
          properties: {
            profile: { type: 'string', enum: [...PROFILES] },
            leverage: banda,
            coverage: banda,
            spread: banda,
            sizeGrowth: banda,
            cadence: banda,
            rationale: {
              type: 'string',
              description:
                'Una frase en español, máximo 200 caracteres, explicando por qué esta ' +
                'combinación encaja con este mercado. Sin cifras concretas: los números ' +
                'los calcula el servidor y podrían no coincidir.',
            },
          },
        },
      },
    },
  };
}

/**
 * El bloque estable del prompt.
 *
 * Va primero y con marca de cache: es identico para todas las peticiones de la
 * misma estrategia, asi que es donde el cache de prompt rinde. Los rasgos de
 * mercado van despues, que es lo que cambia.
 */
export function systemPrompt(): string {
  return [
    'Eres un asistente que propone configuraciones de bots de trading sobre DEX.',
    '',
    'Tu trabajo es elegir TRES combinaciones de perillas —una prudente, una',
    'equilibrada y una agresiva— adecuadas al mercado que se te describe.',
    '',
    'NO propones números: propones bandas. Un generador determinista traduce tus',
    'bandas a los parámetros concretos, respetando los límites del exchange y del',
    'usuario. Por eso no debes mencionar cifras concretas en tu explicación: las',
    'que calcule el servidor pueden no coincidir con lo que estés imaginando.',
    '',
    'Qué significa cada perilla:',
    '',
    '- leverage: cuánto apalancamiento respecto de lo que la volatilidad aconseja.',
    '  MUY_BAJA es mucho menos del sugerido; MUY_ALTA es bastante más.',
    '- coverage: cuánto recorrido en contra quieres cubrir antes de quedarte sin',
    '  escalera (o cuán ancha va la rejilla). Más cobertura = aguanta más, gana',
    '  menos por ciclo.',
    '- spread: cuánto se separan los niveles entre sí, o cuánto diferencial cotiza',
    '  un market maker. Más separación = menos operaciones, más margen por operación.',
    '- sizeGrowth: cuánto crece cada nivel respecto del anterior. Más crecimiento =',
    '  mejor precio medio si el precio sigue cayendo, más exposición si no rebota.',
    '- cadence: cada cuánto actúa el bot. Más cadencia = ciclos más cortos.',
    '',
    'Criterios que debes aplicar:',
    '',
    '1. En mercados muy volátiles, baja el apalancamiento en los tres perfiles. La',
    '   diferencia entre perfiles no puede ser mayor que la que impone el mercado.',
    '2. En mercados que se mueven en línea recta (eficiencia alta), ensancha: una',
    '   rejilla estrecha solo tiene sentido cuando el precio va y viene.',
    '3. El perfil prudente cubre MÁS recorrido en contra, no menos.',
    '4. Las tres propuestas deben ser distinguibles entre sí. Tres tarjetas casi',
    '   iguales no son tres opciones.',
  ].join('\n');
}

/** Los rasgos del mercado, ya calculados. El modelo no calcula nada. */
export function marketPrompt(
  strategy: string,
  symbol: string,
  f: MarketFeatures,
): string {
  return [
    `Estrategia: ${strategy}`,
    `Par: ${symbol}`,
    '',
    'Mercado (calculado por nosotros a partir de las velas, no lo recalcules):',
    `- Volatilidad anualizada: ${f.volAnnualPct} %`,
    `- Recorrido típico por hora: ${f.atrPct1h} %`,
    `- Recorrido típico por día: ${f.atrPct1d} %`,
    `- Rango de los últimos 30 días: ${f.rangePct30} %`,
    `- Posición dentro de ese rango: ${(f.posInRange * 100).toFixed(0)} % (0 = suelo, 100 = techo)`,
    `- Tendencia: ${f.trend} (${f.trendPct} % entre medias)`,
    `- Eficiencia del movimiento: ${f.efficiency} (0 = zigzag, 1 = línea recta)`,
    `- Peor sesión diaria del periodo: ${f.worstDayPct} %`,
    '',
    'Devuelve exactamente tres propuestas, una por perfil.',
  ].join('\n');
}
