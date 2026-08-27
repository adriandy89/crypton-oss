import type { CommonBotConfig } from '@crypton/shared';

/**
 * Contrato del manual de cada estrategia.
 *
 * El formulario de un bot se genera entero desde `FieldMeta[]`, así que el
 * usuario ve cuarenta y ocho casillas —eso tiene el market maker V2— sin que
 * nada explique qué hace la estrategia ni en qué afecta cada número. La única
 * ayuda existente era una frase corta bajo el campo, y ni siquiera estaba
 * completa.
 *
 * Aquí vive la explicación larga. El panel NO recorre este catálogo para
 * decidir qué opciones enseña: recorre el mismo `FieldMeta[]` que pinta el
 * formulario y busca aquí la ficha de cada campo. Esa dirección es la que
 * garantiza que el manual no pueda omitir una opción.
 */

export interface OptionDoc {
  /** Qué es, sin jerga. Una o dos frases. */
  what: string;
  /** En qué afecta: qué cambia en el comportamiento del bot al subirlo o bajarlo. */
  affects: string;
  /** Valor de partida razonable, o el error típico con este parámetro. */
  tip?: string;
}

/** Un caso de uso concreto, con par y precio reales. */
export interface GuideExample {
  title: string;
  venue: string;
  pair: string;
  /** Precio de referencia del ejemplo, ya formateado. */
  price: string;
  setup: { label: string; value: string }[];
  /** Qué hace el bot con esa configuración, y qué pasa si el mercado no acompaña. */
  outcome: string;
}

export type RiskLevel = 'BAJO' | 'MEDIO' | 'ALTO';

/**
 * Campos propios de una estrategia: los de su interfaz de config que no vienen
 * de `CommonBotConfig`.
 */
type OwnKeys<C> = Exclude<keyof C & string, keyof CommonBotConfig>;

/**
 * Fichas de las opciones de una estrategia.
 *
 * El tipo mapeado con `-?` es deliberado: obliga a documentar TODOS los campos
 * propios de la estrategia, incluidos los opcionales. Si mañana alguien añade un
 * parámetro a `MarketMakerV2Config`, la app no compila hasta que tenga ficha —
 * que es la única forma de que «todas sus opciones» siga siendo cierto dentro de
 * seis meses.
 *
 * Los comunes son opcionales porque ya tienen ficha compartida en
 * `COMMON_OPTION_DOCS`. Se redefinen solo cuando el campo significa algo
 * distinto dentro de esa estrategia: `priceFloor` en un market maker no es un
 * límite de rango, es el precio bajo el cual deja de abrir y solo reduce.
 */
export type GuideOptions<C> = { [K in OwnKeys<C>]-?: OptionDoc } & {
  [K in keyof CommonBotConfig & string]?: OptionDoc;
};

export interface StrategyGuide<C = unknown> {
  /** Qué es, en una frase. */
  headline: string;
  risk: RiskLevel;
  /** En que mercado brilla y por que. */
  bestFor: string;
  /** El ciclo del bot, paso a paso. */
  howItWorks: string[];
  goodWhen: string[];
  badWhen: string[];
  examples: GuideExample[];
  options: GuideOptions<C>;
}
