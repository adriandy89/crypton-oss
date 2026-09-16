import { Mutability, mismoValorDeConfig, type BotConfig, type FieldMeta } from '@crypton/shared';
import type { Strategy } from './types';

export interface ChangedField {
  key: string;
  from: unknown;
  to: unknown;
  mutability: Mutability;
  labelKey: string;
}

export interface ConfigDiff {
  changed: ChangedField[];
  /**
   * El nivel MÁS restrictivo de todos los cambios. Es lo único que el motor
   * necesita mirar para decidir qué hacer:
   *   NONE → nada que aplicar.
   *   HOT  → se aplica en el siguiente tick, sin tocar órdenes ni posición.
   *   WARM → cancela y vuelve a tender la escalera; la posición no se cierra.
   *   COLD → se rechaza: habría que parar el bot y crear uno nuevo.
   */
  level: 'NONE' | Mutability;
  /** Campos COLD que el usuario ha intentado cambiar; se devuelven al rechazar. */
  coldFields: string[];
}

const RANK: Record<Mutability, number> = {
  [Mutability.HOT]: 1,
  [Mutability.WARM]: 2,
  [Mutability.COLD]: 3,
};

/**
 * Compara dos configuraciones y clasifica el cambio.
 *
 * Un campo que la estrategia no declara se trata como COLD: es la opción
 * conservadora — antes rechazar un cambio desconocido que aplicarlo a ciegas
 * sobre un bot con dinero dentro.
 */
export function diffConfig(
  strategy: Strategy<BotConfig>,
  previous: BotConfig,
  next: BotConfig,
): ConfigDiff {
  const byKey = new Map<string, FieldMeta>(strategy.meta.fields.map((f) => [f.key, f]));
  const keys = new Set([...Object.keys(previous ?? {}), ...Object.keys(next ?? {})]);

  const changed: ChangedField[] = [];
  for (const key of keys) {
    const from = (previous as Record<string, unknown>)?.[key];
    const to = (next as Record<string, unknown>)?.[key];
    // La igualdad laxa de `shared`, que es también la de la pantalla: si las dos
    // decidieran distinto qué ha cambiado, recolocar un borrador podría deshacer
    // un ajuste que el servidor no veía como edición (spec 056, A-1).
    if (mismoValorDeConfig(from, to)) continue;

    const meta = byKey.get(key);
    changed.push({
      key,
      from,
      to,
      mutability: meta?.mutability ?? Mutability.COLD,
      labelKey: meta?.labelKey ?? key,
    });
  }

  if (changed.length === 0) return { changed, level: 'NONE', coldFields: [] };

  const worst = changed.reduce<Mutability>(
    (acc, c) => (RANK[c.mutability] > RANK[acc] ? c.mutability : acc),
    Mutability.HOT,
  );

  return {
    changed,
    level: worst,
    coldFields: changed.filter((c) => c.mutability === Mutability.COLD).map((c) => c.key),
  };
}

/** Los campos de una estrategia agrupados por mutabilidad, para pintar la UI. */
export function fieldsByMutability(strategy: Strategy<BotConfig>): Record<Mutability, FieldMeta[]> {
  const out: Record<Mutability, FieldMeta[]> = {
    [Mutability.HOT]: [],
    [Mutability.WARM]: [],
    [Mutability.COLD]: [],
  };
  for (const f of strategy.meta.fields) out[f.mutability].push(f);
  return out;
}
