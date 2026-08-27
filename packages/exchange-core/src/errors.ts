import { ExchangeError, type ExchangeErrorKind, type Venue } from '@crypton/shared';

/**
 * Clasificación de errores del venue.
 *
 * Sin esto, un corte de red y una clave revocada se tratarían igual, y el motor
 * o bien reintentaría eternamente algo que nunca va a funcionar, o bien pararía
 * el bot por un timeout pasajero. Cada familia tiene una reacción distinta:
 *
 *   RETRYABLE           → reintento con backoff; el bot sigue vivo.
 *   THROTTLED           → el venue nos ha cortado el grifo. NO se reintenta:
 *                         insistir es justo lo que alarga el castigo.
 *   RULES               → la orden incumple una regla del mercado: se corrige
 *                         (redondeo, mínimo) y se reintenta UNA vez.
 *   INSUFFICIENT_FUNDS  → se pausa la escalera y se avisa; reintentar solo
 *                         genera rechazos en cadena.
 *   AUTH                → bot a ERROR y aviso inmediato: hay que revisar la
 *                         credencial.
 *   FATAL               → cualquier otra cosa; se registra en crudo para poder
 *                         diagnosticarla sin adivinar.
 */

const PATTERNS: { kind: ExchangeErrorKind; re: RegExp }[] = [
  {
    kind: 'AUTH',
    re: /unauthor|invalid.?(api|key|signature)|forbidden|permission|expired.?token/i,
  },
  {
    kind: 'INSUFFICIENT_FUNDS',
    re: /insufficient|not enough|margin is insufficient|exceeds free collateral|balance/i,
  },
  {
    // Cada venue nombra lo mismo de forma distinta, y esa es toda la dificultad.
    // Binance y Hyperliquid hablan de `size` y de `notional`; Lighter dice
    // `amount`. Faltaba su vocabulario, asi que su rechazo mas comun —«invalid
    // order base or quote amount», que es como dice «esta orden no llega al
    // minimo»— caia en FATAL, y `place()` relanza todo lo que no sea RULES: un
    // nivel demasiado pequeno tumbaba el tick entero, cinco veces seguidas, y el
    // cortacircuitos pausaba el bot con la posicion abierta.
    //
    // Esta lista NO puede ser la unica defensa: el siguiente venue traera otras
    // palabras. La red de verdad es que `place()` contenga cualquier rechazo de
    // una orden suelta. Esto solo hace que el caso conocido se registre con el
    // nivel que le corresponde.
    kind: 'RULES',
    re: /min.?notional|tick.?size|lot.?size|step.?size|price.?filter|reduce.?only|precision|too small|invalid price|invalid size|post.?only|would immediately match|invalid order|base amount|quote amount|min.?base|min.?quote/i,
  },
  {
    kind: 'RETRYABLE',
    re: /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|rate.?limit|too many requests|429|502|503|504|temporarily|try again/i,
  },
];

/**
 * Extrae un mensaje legible de cualquier cosa que lance un SDK o axios.
 *
 * El orden es: primero el cuerpo de la respuesta —ahí es donde el venue
 * explica QUÉ ha rechazado—, y si no lo hay, el estado HTTP. Sin ese segundo
 * paso, un rechazo del borde sin cuerpo (CloudFront devolviendo 403 con
 * Content-Length 0) llegaba a la pantalla del usuario como «ERR_BAD_REQUEST:
 * Request failed with status code 403», que ni dice de quién es el problema ni
 * está en el idioma de la app. Ahora sale «HTTP 403».
 */
/**
 * ¿Es esto una PÁGINA WEB en vez de una respuesta de la API?
 *
 * Cuando un venue se cae de verdad, quien contesta no es su API sino el proxy
 * que tiene delante, y lo hace en HTML. La página de nginx de Lighter llegó
 * entera a la ficha del bot y a la pantalla del usuario:
 *
 *   «5 ticks seguidos fallidos (último: <html> <head><title>503 Service
 *    Temporarily Unavailable</title></head> <body><center><h1>503 Service…»
 *
 * Es el mismo problema que ya documenta `shortMessage` para el cortafuegos,
 * solo que aquel se detectaba por su huella de WAF y este no: un 503 de proxy
 * no lleva CAPTCHA ninguno, así que pasaba por «mensaje del venue» y se
 * imprimía. Se mira el PRINCIPIO del cuerpo porque una respuesta legítima de
 * la API es JSON y nunca empieza así.
 */
const HTML_RE = /^\s*(?:<!doctype\s+html|<html[\s>])/i;

/**
 * Convierte una página de error en una línea que se pueda enseñar.
 *
 * El estado manda sobre el título: «HTTP 503» es lo accionable y es idéntico
 * venga de quien venga. El `<title>` solo se usa cuando no hay estado —el SDK
 * de Lighter no siempre lo propaga— y recortado, porque tampoco es de fiar.
 */
function htmlSummary(body: string, status?: number): string {
  const titulo = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(body)?.[1]?.trim();
  if (typeof status === 'number') return `HTTP ${status}: el venue no está sirviendo la API.`;
  if (titulo) return `${titulo} — el venue no está sirviendo la API.`;
  return 'El venue respondió con una página de error en vez de con la API.';
}

export function messageOf(raw: unknown): string {
  if (raw == null) return 'Error desconocido';
  if (typeof raw === 'string') return HTML_RE.test(raw) ? htmlSummary(raw) : raw;
  if (raw instanceof Error) {
    const anyErr = raw as Error & {
      code?: string;
      response?: { data?: unknown; status?: number };
    };
    const data = anyErr.response?.data;
    // Un cuerpo vacío —cadena vacía, objeto sin claves— no explica nada: se
    // deja pasar al estado HTTP en lugar de enseñar «{}».
    if (data && (typeof data !== 'object' || Object.keys(data).length > 0)) {
      if (typeof data === 'string' && HTML_RE.test(data)) {
        return htmlSummary(data, anyErr.response?.status);
      }
      return typeof data === 'string' ? data : JSON.stringify(data);
    }
    const status = anyErr.response?.status;
    if (typeof status === 'number') return `HTTP ${status}`;
    return anyErr.code ? anyErr.code + ': ' + raw.message : raw.message;
  }
  try {
    return JSON.stringify(raw);
  } catch {
    // Ultimo recurso: aqui solo se llega si JSON.stringify se rindio, que en la
    // practica significa referencias circulares. Un "[object Object]" es peor
    // que el JSON pero mejor que quedarse sin registrar el fallo.
    // eslint-disable-next-line @typescript-eslint/no-base-to-string
    return String(raw);
  }
}

export function classify(raw: unknown, status?: number): ExchangeErrorKind {
  // El cortafuegos va PRIMERO: su respuesta contiene basura suficiente para
  // hacer saltar cualquiera de los patrones de abajo por casualidad.
  if (isThrottled(raw, status ?? statusOf(raw))) return 'THROTTLED';
  const msg = messageOf(raw);
  for (const p of PATTERNS) if (p.re.test(msg)) return p.kind;
  return 'FATAL';
}

/** El texto en crudo, sin el recorte que aplica `messageOf`. */
function rawMessageOf(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw instanceof Error) {
    const data = (raw as Error & { response?: { data?: unknown } }).response?.data;
    if (typeof data === 'string') return data;
    return raw.message;
  }
  return '';
}

/**
 * ¿Es esto un bloqueo del CORTAFUEGOS del venue?
 *
 * Se comprueba ANTES que los patrones de texto y por eso existe. La página que
 * devuelve AWS WAF son cuatro kilobytes de HTML con nonces en base64, y el
 * patrón `RETRYABLE` busca los literales `429|502|503|504` sobre el mensaje
 * entero: si un nonce contenía «503» —y a veces lo contiene— el mismo bloqueo
 * se reintentaba cuatro veces, y si no, se descartaba como fatal. El mismo
 * fallo con dos comportamientos según el azar de un base64.
 *
 * Las tres señales son las que documentan los venues:
 *   · Lighter: «You will receive HTTP 429, or HTTP 405» y la página de
 *     «Human Verification» de su WAF. Enfriamiento de 60 s.
 *   · Aster: 429 al pasarse y **418** si se insiste, con veto de IP «from 2
 *     minutes to 3 days» escalando con la reincidencia.
 */
export function isThrottled(raw: unknown, status = statusOf(raw)): boolean {
  if (status === 405 || status === 418 || status === 429) return true;
  return WAF_RE.test(rawMessageOf(raw));
}

/**
 * La huella de la página de AWS WAF. Se busca en el HTML y no en el estado
 * porque llega con códigos distintos según el venue y el momento.
 */
const WAF_RE = /Human Verification|awsWafCookieDomainList|captcha\.awswaf\.com|challenge\.js/i;

/**
 * Estado HTTP de lo que sea que haya lanzado el SDK, si lo trae.
 *
 * Acepta también un número suelto: `publicGet` tiene el `res.status` a mano y
 * pasárselo es lo natural. Sin este caso, `isThrottled(405)` devolvía false y
 * un corte del cortafuegos SIN cuerpo HTML —que es como llega la mayoría— se
 * clasificaba como fallo cualquiera.
 */
function statusOf(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (raw == null || typeof raw !== 'object') return undefined;
  const anyErr = raw as { status?: number; response?: { status?: number } };
  return anyErr.response?.status ?? anyErr.status;
}

/**
 * Recorta un mensaje del venue a algo que se pueda enseñar.
 *
 * Un cuerpo de error del venue no puede llegar entero a la pantalla: la página
 * del cortafuegos de Lighter son cuatro kilobytes de HTML, y se vieron
 * impresos encima del gráfico. El detalle completo va al log; aquí queda lo que
 * cabe en una línea.
 */
export function shortMessage(message: string, max = 200): string {
  const flat = message.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + '…';
}

/**
 * Envuelve cualquier fallo en un ExchangeError ya clasificado.
 *
 * Un corte del cortafuegos NO conserva el mensaje del venue, y es deliberado:
 * ese «mensaje» son cuatro kilobytes de HTML con un CAPTCHA dentro, y llegaron
 * a verse impresos encima del gráfico de un usuario. El cuerpo entero sigue
 * disponible en `raw` para quien lo quiera registrar; lo que sube es una frase
 * que dice lo único accionable: hay que esperar.
 */
export function toExchangeError(raw: unknown, venue?: Venue, status?: number): ExchangeError {
  if (raw instanceof ExchangeError) return raw;
  const code = status ?? statusOf(raw);
  const kind = classify(raw, code);
  if (kind === 'THROTTLED') {
    return new ExchangeError('THROTTLED', throttledMessage(venue, code), venue, raw);
  }
  return new ExchangeError(kind, messageOf(raw), venue, raw);
}

function throttledMessage(venue: Venue | undefined, status: number | undefined): string {
  const quien = venue ? String(venue) : 'El exchange';
  const codigo = status ? ` (HTTP ${status})` : '';
  // El 418 se dice aparte porque no es lo mismo: en Aster es un VETO de IP que
  // escala «from 2 minutes to 3 days» con la reincidencia. Quien lea el log
  // tiene que saber que esto no se arregla esperando un minuto.
  if (status === 418) {
    return `${quien} ha VETADO esta IP${codigo} por insistir tras un 429. El veto escala con la reincidencia.`;
  }
  return `${quien} ha limitado las peticiones de esta IP${codigo}.`;
}

export const isRetryable = (e: unknown): boolean =>
  e instanceof ExchangeError ? e.kind === 'RETRYABLE' : classify(e) === 'RETRYABLE';
