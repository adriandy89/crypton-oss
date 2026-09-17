/**
 * Giros confirmados por cambio direccional (spec 058).
 *
 * Un giro alto solo existe cuando el precio ha BAJADO `θ` desde ese máximo, y
 * uno bajo cuando ha SUBIDO `θ` desde ese mínimo. Hasta entonces no hay giro:
 * es lo que evita el defecto del zigzag clásico, que dibuja un giro en la vela
 * de hoy y lo borra mañana (repinta).
 *
 * `θ` es `factor · ATR` con el ATR QUE HABÍA en cada vela, no el final. Así el
 * cálculo sobre un prefijo de la serie es exactamente el cálculo completo
 * filtrado por `confirmadoEn`. Esa propiedad tiene su test, porque sin ella el
 * backtest mira al futuro.
 */
import type { SerieNumerica } from './numeros';

export interface Giro {
  tipo: 'ALTO' | 'BAJO';
  /** Vela del extremo. */
  indice: number;
  precio: number;
  /** Vela en la que el giro quedó confirmado. Antes de ella, no existía. */
  confirmadoEn: number;
}

export function swingsConfirmados(s: SerieNumerica, atr: ArrayLike<number>, factor = 1.25): Giro[] {
  const giros: Giro[] = [];
  let inicio = 0;
  while (inicio < s.n && !Number.isFinite(atr[inicio])) inicio++;
  if (inicio >= s.n) return giros;

  // Sin dirección todavía: se siguen los dos extremos a la vez.
  let modo: 'NINGUNO' | 'SUBE' | 'BAJA' = 'NINGUNO';
  let maximo = s.h[inicio];
  let iMaximo = inicio;
  let minimo = s.l[inicio];
  let iMinimo = inicio;

  for (let i = inicio + 1; i < s.n; i++) {
    const umbral = factor * atr[i];
    if (!Number.isFinite(umbral) || umbral <= 0) continue;
    const alto = s.h[i];
    const bajo = s.l[i];

    if (modo === 'NINGUNO') {
      if (alto > maximo) {
        maximo = alto;
        iMaximo = i;
      }
      if (bajo < minimo) {
        minimo = bajo;
        iMinimo = i;
      }
      const subio = maximo - minimo >= umbral && iMinimo < iMaximo;
      const bajoDesde = maximo - minimo >= umbral && iMaximo < iMinimo;
      if (subio) {
        // Primero el mínimo y luego la subida: el mínimo es un giro bajo.
        giros.push({ tipo: 'BAJO', indice: iMinimo, precio: minimo, confirmadoEn: i });
        modo = 'SUBE';
      } else if (bajoDesde) {
        giros.push({ tipo: 'ALTO', indice: iMaximo, precio: maximo, confirmadoEn: i });
        modo = 'BAJA';
      }
      continue;
    }

    if (modo === 'SUBE') {
      if (alto > maximo) {
        // Un máximo nuevo no confirma nada en la misma vela: una vela no dice si
        // su mínimo llegó antes o después de su máximo.
        maximo = alto;
        iMaximo = i;
        continue;
      }
      if (maximo - bajo >= umbral) {
        giros.push({ tipo: 'ALTO', indice: iMaximo, precio: maximo, confirmadoEn: i });
        modo = 'BAJA';
        minimo = bajo;
        iMinimo = i;
      }
      continue;
    }

    // modo === 'BAJA'
    if (bajo < minimo) {
      minimo = bajo;
      iMinimo = i;
      continue;
    }
    if (alto - minimo >= umbral) {
      giros.push({ tipo: 'BAJO', indice: iMinimo, precio: minimo, confirmadoEn: i });
      modo = 'SUBE';
      maximo = alto;
      iMaximo = i;
    }
  }
  return giros;
}
