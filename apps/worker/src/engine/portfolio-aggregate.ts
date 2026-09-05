import { D } from '@crypton/shared';

/**
 * De los últimos snapshots de los bots a la fila de la cartera (spec 003).
 *
 * Es una función pura y vive aparte del servicio que la llama por la misma razón
 * que la aritmética de las series está en `@crypton/shared`: es dinero, se suma
 * con `Decimal`, y tiene que poder probarse sin base, sin Redis y sin Nest. El
 * cron (`portfolio-snapshots.service.ts`) solo lee, llama aquí y escribe.
 *
 * Lo que se decide aquí, y no en el SQL, para que quede escrito y probado:
 *
 * · Solo los bots REALES (`dry_run = false`). El resultado de un simulado es
 *   dinero que no existe y no se suma nunca al de verdad; la cartera de
 *   simulación tiene su propio bloque en la pantalla y no tiene curva.
 * · Una fila por (usuario, red). Testnet y mainnet no se mezclan: son libros
 *   distintos, y la app ya los separa con el interruptor de red.
 * · `pnl = realizado + no realizado`, la misma definición que
 *   `bot_snapshots.equity` (`bot-store.ts`), para que en cualquier instante en
 *   que existan ambas, la fila de la cartera sea la suma de las de sus bots
 *   cifra a cifra.
 * · `exposure` = Σ |posición| × precio medio, el mismo cálculo que la pantalla
 *   hacía en el 002 (`repartoPorSimbolo`). Un corto expone lo mismo que un largo.
 * · Los bots que no están en la entrada no existen: quien llama ya filtró por
 *   «snapshot con menos de diez minutos», y un bot borrado no tiene snapshots.
 *   Así es como el pasado materializado no se reescribe nunca.
 */

/** Lo que devuelve la consulta del cron por cada bot: su ÚLTIMO snapshot y a quién pertenece. */
export interface PortfolioSource {
  user_id: string;
  testnet: boolean;
  bot_id: string;
  dry_run: boolean;
  total_investment: { toString(): string };
  realized_pnl_acc: { toString(): string };
  unrealized_pnl: { toString(): string };
  position_qty: { toString(): string };
  average_entry: { toString(): string } | null;
}

/** Una fila de `portfolio_snapshots` antes de escribirla, con el dinero en cadena. */
export interface PortfolioRow {
  user_id: string;
  testnet: boolean;
  realized: string;
  unrealized: string;
  pnl: string;
  invested: string;
  exposure: string;
  bots: number;
}

export function aggregatePortfolio(filas: readonly PortfolioSource[]): PortfolioRow[] {
  const grupos = new Map<string, PortfolioSource[]>();
  for (const f of filas) {
    if (f.dry_run) continue;
    const clave = `${f.user_id}:${f.testnet ? 't' : 'm'}`;
    const lista = grupos.get(clave) ?? [];
    lista.push(f);
    grupos.set(clave, lista);
  }

  const out: PortfolioRow[] = [];
  for (const bots of grupos.values()) {
    let realized = D(0);
    let unrealized = D(0);
    let invested = D(0);
    let exposure = D(0);
    for (const b of bots) {
      realized = realized.plus(b.realized_pnl_acc.toString());
      unrealized = unrealized.plus(b.unrealized_pnl.toString());
      invested = invested.plus(b.total_investment.toString());
      const qty = D(b.position_qty.toString()).abs();
      if (!qty.isZero() && b.average_entry !== null) {
        exposure = exposure.plus(qty.mul(b.average_entry.toString()));
      }
    }
    out.push({
      user_id: bots[0].user_id,
      testnet: bots[0].testnet,
      realized: realized.toFixed(),
      unrealized: unrealized.toFixed(),
      pnl: realized.plus(unrealized).toFixed(),
      invested: invested.toFixed(),
      exposure: exposure.toFixed(),
      bots: bots.length,
    });
  }

  // Orden estable para que dos réplicas —o un test— produzcan las mismas filas
  // en el mismo orden: primero por usuario, mainnet antes que testnet.
  return out.sort((a, b) =>
    a.user_id === b.user_id
      ? Number(a.testnet) - Number(b.testnet)
      : a.user_id < b.user_id
        ? -1
        : 1,
  );
}
