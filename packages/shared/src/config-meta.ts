/**
 * Mutabilidad de cada parámetro: es lo que permite ofrecer "ajustable al máximo
 * también con el bot corriendo" sin que un cambio inocente cierre una posición.
 *
 * - HOT  : se aplica en el siguiente tick. El diff ajusta órdenes; la posición
 *          no se toca en ningún caso.
 * - WARM : obliga a cancelar y volver a tender la escalera. La posición sigue
 *          intacta: no se cierra nada, solo se recolocan órdenes.
 * - COLD : inmutable. Cambiarlo significaría un bot distinto (otro par, otro
 *          venue, otra dirección), así que se exige parar y crear uno nuevo.
 */
export const Mutability = { HOT: 'HOT', WARM: 'WARM', COLD: 'COLD' } as const;
export type Mutability = (typeof Mutability)[keyof typeof Mutability];

export type FieldKind =
  | 'number'
  | 'percent'
  | 'money'
  | 'integer'
  | 'boolean'
  | 'enum'
  | 'price'
  | 'text';

/**
 * Sección del formulario en la que cae el campo. La app agrupa por aquí, así que
 * una estrategia con 30 parámetros se lee sin scroll infinito.
 */
export type FieldGroup =
  | 'core'
  | 'risk'
  | 'quoting'
  | 'timing'
  | 'levels'
  | 'dynamicSpread'
  | 'priceSource'
  | 'activation'
  | 'venue';

/**
 * Control con el que se pinta. Es una PISTA, no una obligación: si la app no
 * conoce el valor, cae al control por defecto de su `kind`.
 *
 * `segment` existe porque un enum de dos o tres opciones cortas se lee mucho
 * mejor como grupo de botones que como desplegable, y es lo que el usuario
 * espera de un formulario de trading.
 */
export type FieldControl = 'input' | 'segment' | 'select' | 'toggle';

/**
 * Descriptor de un campo de configuración. La app genera el formulario a partir
 * de esto (label, unidad, min/max, paso y badge de mutabilidad), así que añadir
 * un parámetro a una estrategia no requiere tocar la UI.
 */
export interface FieldMeta {
  key: string;
  kind: FieldKind;
  mutability: Mutability;
  /** Clave i18n; el texto vive en los ficheros de Transloco. */
  labelKey: string;
  helpKey?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: readonly string[];
  required: boolean;
  default?: unknown;
  /** Marca los campos que la UI debe destacar como sensibles al riesgo. */
  risky?: boolean;
  /** Sección del formulario. Sin esto, el campo cae en `core`. */
  group?: FieldGroup;
  /**
   * Sufijo que se pinta dentro del input: `USDC`, `bps`, `sec`, `%`, `x`.
   * No participa en ningún cálculo; es la unidad que el usuario está tecleando.
   */
  unit?: string;
  /** true = vive dentro del colapsable «Más parámetros». */
  advanced?: boolean;
  control?: FieldControl;
  /** Orden dentro de su grupo; sin esto se respeta el orden de declaración. */
  order?: number;
}

export interface StrategyMeta {
  kind: string;
  labelKey: string;
  descriptionKey: string;
  fields: readonly FieldMeta[];
}

/** Resultado de validar una config contra el mercado y los límites de riesgo. */
export interface ValidationIssue {
  field: string | null;
  message: string;
  severity: 'ERROR' | 'WARNING';
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}
