/**
 * Formateo de cifras para la interfaz.
 *
 * Todo lo numérico se muestra con tabulación de dígitos y signo explícito
 * cuando es un resultado: en una pantalla donde se comparan varios bots de un
 * vistazo, alinear los dígitos y ver el signo de inmediato es la diferencia
 * entre leer y tener que descifrar.
 */

export function money(value: string | number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('es-ES', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/** Con signo delante: para PnL y variaciones. */
export function signed(value: string | number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return sign + money(n, decimals);
}

export function pct(value: string | number | null | undefined, decimals = 2): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  // Con toFixed el separador decimal es el punto, y en la tarjeta de un bot
  // quedaba "+412,80" junto a "+4.88 %": dos convenciones distintas en dos
  // columnas contiguas.
  return `${n > 0 ? '+' : ''}${money(n, decimals)} %`;
}

export function pnlColor(value: string | number | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n === 0) return 'medium';
  return n > 0 ? 'success' : 'danger';
}

/** Duración legible a partir de segundos: 3 d 4 h, 5 h 12 min, 42 min. */
export function uptime(seconds: number): string {
  if (!seconds || seconds < 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  // Los componentes en cero se omiten: "14 d 0 h" no aporta nada sobre "14 d",
  // y en la rejilla de cuatro metricas de la lista de bots partia en dos lineas.
  if (d > 0) return h > 0 ? `${d} d ${h} h` : `${d} d`;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  return `${m} min`;
}

export function shortDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  return d.toLocaleString('es-ES', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Volumen abreviado: 1.240.000 -> «1,24 M».
 *
 * Una lista de mercados con el volumen entero es una columna de quince dígitos
 * en la que no se distingue un millón de diez, que es justo la comparación para
 * la que está esa columna.
 */
export function compact(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return money(n / 1e9, 2) + ' B';
  if (abs >= 1e6) return money(n / 1e6, 2) + ' M';
  if (abs >= 1e3) return money(n / 1e3, 1) + ' k';
  return money(n, 2);
}

/**
 * Precio con los decimales del MERCADO, no con dos fijos.
 *
 * Con dos decimales, un par que cotiza a 0,00004182 se enseña como «0,00»: la
 * pantalla deja de decir nada justo en los mercados donde el precio importa
 * más. Los decimales salen de `price_decimals` de la spec del venue.
 */
export function price(value: string | number | null | undefined, decimals?: number | null): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  // Sin spec, se deduce de la magnitud: por debajo de 1 hacen falta más cifras.
  const d = decimals ?? (Math.abs(n) >= 1000 ? 2 : Math.abs(n) >= 1 ? 4 : 6);
  return money(n, Math.min(Math.max(d, 0), 8));
}

/**
 * Cantidad de un activo.
 *
 * Hermana de `price()` y por el mismo motivo: la base de datos guarda las
 * cantidades como decimales de 18 posiciones, y la API las sirve tal cual. Sin
 * pasar por aquí, la pantalla del bot enseñaba «0.0015» —punto inglés, sin
 * separador de millares— justo al lado de un PnL que decía «1.234,56». Dos
 * convenciones distintas en la misma tarjeta, y la de arriba tapando cuál es la
 * parte entera.
 *
 * Los decimales salen de la magnitud y no de la spec del mercado porque quien
 * pinta una cantidad no siempre tiene la spec a mano —el detalle del bot no
 * carga el catálogo—, y redondear a dos fijos convertiría media posición de
 * BTC en «0,00». Cuando haya spec, se le pasa `qtyDecimals` y manda ella.
 */
export function qty(value: string | number | null | undefined, decimals?: number | null): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  const abs = Math.abs(n);
  // Cuanto más pequeña es la cantidad, más cifras hacen falta para que diga
  // algo: 0,0004 BTC y 0,0009 BTC no pueden verse las dos como «0,00».
  const d = decimals ?? (abs >= 1000 ? 2 : abs >= 1 ? 4 : 6);
  // `maximumFractionDigits` sin mínimo: una cantidad entera se lee mejor como
  // «12» que como «12,000000», y aquí no hay columna que alinear.
  const max = Math.min(Math.max(d, 0), 8);
  const texto = n.toLocaleString('es-ES', { maximumFractionDigits: max });

  // Una posición diminuta NO puede leerse como cero.
  //
  // «0» significa «este bot está plano», que es lo contrario de la verdad y
  // justo la lectura que hace cerrar la pantalla sin mirar. Y pasa de verdad:
  // los decimales por defecto de esta función se quedan en seis, así que un
  // resto de 0,0000004 tras una ejecución parcial ya salía como cero.
  //
  // Primero se intenta con toda la precisión disponible, que casi siempre basta
  // y dice la cifra exacta. Solo si ni con ocho decimales se ve —por debajo de
  // 5e-9— se recurre a decir que hay algo sin poder decir cuánto.
  if (redondeaACero(texto)) {
    const preciso = n.toLocaleString('es-ES', { maximumFractionDigits: 8 });
    if (!redondeaACero(preciso)) return preciso;
    return n > 0 ? '≈0' : '≈-0';
  }
  return texto;
}

/** Si lo que se va a enseñar es un cero, venga de donde venga el número. */
function redondeaACero(texto: string): boolean {
  // Se deshace el formato español —punto de millares, coma decimal— antes de
  // volver a leerlo como número.
  return Number(texto.replace(/\./g, '').replace(',', '.')) === 0;
}

/** Hora corta para el eje y la leyenda del gráfico: «22/08 14:30». */
export function shortTime(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('es-ES', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Cuánto hace, en palabras cortas: «hace 12 s», «hace 3 min». */
export function ago(at: number | null | undefined): string {
  if (!at) return '—';
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `hace ${s} s`;
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  return `hace ${Math.round(s / 3600)} h`;
}
