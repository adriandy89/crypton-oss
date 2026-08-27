import { ExchangeError, type Venue } from '@crypton/shared';
import { classify } from './errors';

/**
 * Enfriamiento tras un corte del venue.
 *
 * Clasificar el corte no basta. Un `THROTTLED` bien clasificado evita los
 * reintentos automáticos, pero no evita que la SIGUIENTE petición —de otro
 * usuario, de otro bot, del cron— salga igual y se lleve otro corte. Con el
 * cortafuegos activo, cada petición que sale es una que confirma al venue que
 * seguimos ahí:
 *
 *   · Lighter documenta «Firewall: 60 seconds, static» de enfriamiento.
 *   · Aster avisa de que insistir tras un 429 acaba en **418**, con veto de IP
 *     que escala «from 2 minutes to 3 days» según la reincidencia.
 *
 * Así que cuando el venue nos corta, se deja de llamar y se falla en local
 * hasta que pase el enfriamiento. Fallar rápido y sin red es además mejor para
 * quien llama: la respuesta es inmediata y dice cuánto queda.
 *
 * El ámbito es el ADAPTADOR, que es el mismo que el de la conexión: la API y el
 * worker mantienen uno por venue, así que todo lo que sale de ese proceso hacia
 * ese venue comparte el enfriamiento.
 */
export class VenueCooldown {
  private hasta = 0;
  private ultimoMotivo = '';

  constructor(private readonly venue: Venue) {}

  /** Milisegundos que quedan de enfriamiento. 0 si se puede llamar. */
  restanteMs(): number {
    return Math.max(0, this.hasta - Date.now());
  }

  /**
   * Entra en enfriamiento. Si ya estaba en uno más largo, se respeta el más
   * largo: dos cortes seguidos no pueden acortar el castigo.
   */
  iniciar(ms: number, motivo: string): void {
    this.hasta = Math.max(this.hasta, Date.now() + ms);
    this.ultimoMotivo = motivo;
  }

  /**
   * Lanza si estamos en enfriamiento, SIN tocar la red.
   *
   * El mensaje dice los segundos que quedan porque es lo único accionable que
   * se le puede contar a quien esté mirando la pantalla.
   */
  comprobar(): void {
    const restante = this.restanteMs();
    if (restante <= 0) return;
    throw new ExchangeError(
      'THROTTLED',
      `${this.venue} nos tiene limitados; quedan ${Math.ceil(restante / 1000)} s. ` +
        `No se manda la petición para no alargar el corte.`,
      this.venue,
      this.ultimoMotivo,
    );
  }

  /**
   * Registra el resultado de una llamada: si fue un corte, arranca el
   * enfriamiento; cualquier otra cosa —incluido un error normal— lo deja como
   * está.
   *
   * Un 418 de Aster no es un corte de un minuto: es un veto de IP que ya está
   * puesto y que escala si insistimos, así que se espera bastante más. La
   * duración no la publica el venue —«from 2 minutes to 3 days»—, de modo que
   * se toma el extremo corto documentado y se reintenta desde ahí en vez de
   * inventarse una cifra.
   */
  registrar(e: unknown): void {
    // Se CLASIFICA aquí, no se exige que llegue ya clasificado.
    //
    // Es donde esto fallaba: los SDK lanzan errores de axios en crudo y la
    // conversión a `ExchangeError` ocurre más tarde, al final de `withRetry`.
    // Pidiendo un `ExchangeError` ya hecho, el enfriamiento no se activaba
    // nunca por el camino que más importa —el catálogo, que es justo el que el
    // cortafuegos estaba cortando— y cada petición seguía saliendo a la red.
    // Un `ExchangeError` ya viene clasificado y su `kind` MANDA. Pasarlo otra
    // vez por `classify` lo perdía: ese mira el texto y el estado HTTP, y el
    // mensaje limpio de un corte —«ha limitado las peticiones de esta IP»— no
    // casa con ningún patrón, así que volvía como FATAL y el enfriamiento no
    // arrancaba nunca por ese camino.
    const kind = e instanceof ExchangeError ? e.kind : classify(e);
    if (kind !== 'THROTTLED') return;
    const texto = e instanceof ExchangeError ? e.message : String((e as Error)?.message ?? e);
    // El veto se reconoce por el ESTADO o por marcas inequivocas, nunca por un
    // «418» suelto en el texto: un precio de 77418 o un nonce en base64 lo
    // contienen por casualidad, y eso convertiria un corte de un minuto en dos.
    // Es el mismo fallo que ya tenia la clasificacion de errores.
    const esVeto = statusDe(e) === 418 || /HTTP 418|VETADO/.test(texto);
    this.iniciar(esVeto ? BAN_MS : CORTE_MS, texto.slice(0, 200));
  }
}

/** Enfriamiento de un corte normal. Lighter: «Firewall: 60 seconds, static». */
const CORTE_MS = 60_000;

/**
 * Espera tras un veto de IP. Aster: «from 2 minutes to 3 days». Se toma el
 * extremo CORTO —el único número concreto que da— y se reintenta desde ahí:
 * esperar de más cuando ya se ha levantado sería tan malo como no esperar.
 */
const BAN_MS = 120_000;

/** El estado HTTP de un error de SDK, si lo trae. Ver `registrar`. */
function statusDe(e: unknown): number | undefined {
  if (e == null || typeof e !== 'object') return undefined;
  const any = e as { status?: number; response?: { status?: number } };
  return any.response?.status ?? any.status;
}
