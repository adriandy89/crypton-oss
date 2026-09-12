import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BANDS, PROFILES, type Band, type Knobs, type Profile } from './build';
import type { MarketFeatures } from './market-features';
import { knobsSchema, marketPrompt, systemPrompt } from './prompt';

/**
 * El unico fichero del proyecto que habla con un modelo de lenguaje.
 *
 * Se llama por el proveedor y no por el modelo a proposito: contra lo que se
 * habla es OpenRouter, y el modelo es una variable de entorno. Un fichero
 * llamado `claude.client.ts` que apunta a otro host es una mentira que se
 * descubre tarde.
 *
 * Todo lo que sale de aqui son PERILLAS: enumeraciones que un generador
 * determinista convierte en parametros. Nada de lo que devuelva este cliente
 * llega al usuario sin pasar antes por `validate()` y `preview()`.
 *
 * Degrada en silencio por diseño. Sin clave configurada, con el interruptor
 * apagado, con la API caida, con tiempo de espera agotado o con una respuesta
 * que no cumple el esquema, devuelve `null` y el servicio sirve los perfiles
 * deterministas. Una funcion de conveniencia no puede dejar sin crear bots a
 * nadie.
 *
 * Se usa `fetch` y no un SDK: el repo no tiene cliente HTTP y los adaptadores de
 * exchange ya hablan asi. Añadir una dependencia para una sola llamada POST es
 * peor negocio que las veinte lineas de abajo.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Tope de tokens de la respuesta.
 *
 * Holgado a proposito: con razonamiento, lo que el modelo piensa cuenta contra
 * este mismo tope. OpenRouter traduce `effort: 'low'` en un presupuesto de
 * razonamiento del 20 % de este numero —1600 tokens— y exige que el tope sea
 * ESTRICTAMENTE mayor que ese presupuesto. La salida util son ~600 tokens, asi
 * que sobra sitio para las dos cosas.
 */
const MAX_TOKENS = 8_000;

/** Por debajo del interceptor global de 80 s, dejando margen al plan B. */
const TIMEOUT_MS = 25_000;

interface RespuestaOpenRouter {
  choices?: {
    finish_reason?: string;
    message?: { content?: string | null; refusal?: string | null };
  }[];
  error?: { code?: number; message?: string };
}

/**
 * El primer origen de `PUBLIC_APP_URL`, y solo si se puede mandar tal cual.
 *
 * Dos motivos, y ninguno es teorico:
 *
 *   - Esa variable es una LISTA separada por comas —asi la lee `main.ts` para el
 *     CORS—, de modo que mandarla entera pondria «http://a,http://b» de
 *     referente en el panel.
 *   - Un dominio internacionalizado sin convertir a punycode traeria caracteres
 *     por encima de 255, y eso hace que `fetch` lance antes de salir.
 */
function referenteValido(bruto: string): string {
  const primero = (bruto || '').split(',')[0]?.trim() ?? '';
  return primero && /^[ -~]+$/.test(primero) ? primero : 'https://example.invalid';
}

@Injectable()
export class OpenRouterClient {
  private readonly logger = new Logger(OpenRouterClient.name);
  private readonly apiKey: string;
  private readonly model: string;
  private readonly referer: string;
  /**
   * La clave del supervisor, con su propio interruptor (spec 046).
   *
   * Es la MISMA clave de OpenRouter —la cuenta es una— pero el interruptor es
   * otro, y eso es deliberado: el asesor responde a alguien que esta mirando la
   * pantalla y el supervisor gasta solo, en bucle, sin que nadie lo pida. Tienen
   * que poder encenderse y apagarse por separado.
   */
  private readonly agentKey: string;
  private readonly agentModel: string;

  constructor(private readonly config: ConfigService) {
    // Se lee con `get` y NO con `requireSecret`: sin clave la API tiene que
    // arrancar igual. Tumbar el servidor entero por una ayuda del asistente
    // seria un intercambio pesimo.
    const apiKey = this.config.get<string>('OPENROUTER_API_KEY', '');
    const enabled = this.config.get<string>('AI_ADVISOR_ENABLE', 'false') === 'true';

    this.apiKey = enabled ? apiKey : '';
    this.model = this.config.get<string>('OPENROUTER_MODEL', 'anthropic/claude-sonnet-5');
    this.referer = referenteValido(this.config.get<string>('PUBLIC_APP_URL', ''));

    const agentEnabled = this.config.get<string>('AI_AGENT_ENABLE', 'false') === 'true';
    this.agentKey = agentEnabled ? apiKey : '';
    // SIN caida a `OPENROUTER_MODEL` si esta vacia, y a proposito: no son el
    // mismo trabajo. Clasificar un par de un solo disparo con quince
    // enumeraciones de salida no es lo mismo que juzgar un expediente con
    // historial, rendimiento y estado sobre un bot con dinero dentro. Se querra
    // poder subir uno sin subir el otro, y ver las dos lineas separadas en la
    // factura.
    this.agentModel = this.config.get<string>('AI_AGENT_MODEL', 'anthropic/claude-sonnet-5');

    if (agentEnabled && !apiKey) {
      this.logger.warn(
        'AI_AGENT_ENABLE está activo pero falta OPENROUTER_API_KEY: ' +
          'el Modo IA no podrá revisar ningún bot.',
      );
    }

    if (enabled && !apiKey) {
      this.logger.warn(
        'AI_ADVISOR_ENABLE está activo pero falta OPENROUTER_API_KEY: ' +
          'se servirán configuraciones calculadas por reglas.',
      );
    } else if (!enabled && apiKey) {
      // El caso simétrico, y el que más despista: quien pone la clave da por
      // hecho que con eso basta. Sin esta línea, el asistente se queda apagado y
      // NADA en el log lo explica — el interruptor está en otra variable.
      this.logger.warn(
        'Hay OPENROUTER_API_KEY pero AI_ADVISOR_ENABLE no está a «true»: ' +
          'el asistente sigue apagado y se servirán configuraciones por reglas.',
      );
    }
  }

  get available(): boolean {
    return this.apiKey !== '';
  }

  /** Si el SUPERVISOR puede llamar. Independiente de `available`, ver el constructor. */
  get agentAvailable(): boolean {
    return this.agentKey !== '';
  }

  /**
   * El modelo con el que decide el supervisor.
   *
   * Se expone para que quede EN LA FILA de cada decision: la columna existe para
   * poder comparar despues decisiones tomadas por modelos distintos, y eso tiene
   * que poder verse, no adivinarse (spec 047, F-03).
   */
  get agentModelId(): string {
    return this.agentModel;
  }

  /**
   * Pide tres combinaciones de perillas para este mercado.
   *
   * Devuelve `null` ante cualquier problema: quien llama ya tiene un plan B, y
   * es preferible a servir una recomendacion a medias.
   */
  async knobsFor(
    strategy: string,
    symbol: string,
    features: MarketFeatures,
  ): Promise<{ knobs: Knobs; rationale: string }[] | null> {
    if (!this.available) return null;
    const contenido = await this.pedir(this.body(strategy, symbol, features), 'recomendaciones');
    return contenido === null ? null : this.parse(contenido);
  }

  /**
   * Pide al modelo que revise un bot que YA esta operando (spec 046).
   *
   * Vive aqui y no en un cliente propio porque este sigue siendo, por diseño, el
   * unico fichero del proyecto que habla con un modelo de lenguaje. Lo que
   * cambia respecto del asesor es el modelo —`AI_AGENT_MODEL`, su propia
   * variable—, el interruptor y el esquema; el transporte, con sus doscientas
   * lineas de incidentes aprendidos, es el mismo.
   *
   * Devuelve el JSON en crudo: la forma la valida `parseRevision`, que es quien
   * conoce el contrato. Aqui solo se sabe de HTTP.
   */
  async revisar(
    esquema: { name: string; schema: Record<string, unknown> },
    system: string,
    usuario: string,
  ): Promise<string | null> {
    if (!this.agentAvailable) return null;
    return this.pedir(
      {
        model: this.agentModel,
        max_tokens: MAX_TOKENS,
        // Mas esfuerzo que en el asesor, y a proposito: alli se eligen tres
        // ternas de enumeraciones sobre unos rasgos de mercado; aqui se juzga un
        // expediente con historial, rendimiento y estado, y la decision de
        // MANTENER o no vale lo que vale.
        reasoning: { effort: 'medium', exclude: true },
        response_format: {
          type: 'json_schema',
          json_schema: { name: esquema.name, strict: true, schema: esquema.schema },
        },
        provider: { require_parameters: true },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: usuario },
        ],
      },
      'revision',
      'Crypton bot supervisor',
    );
  }

  /**
   * El transporte: una peticion, dos intentos y un solo presupuesto de tiempo.
   *
   * Extraido del cuerpo de `knobsFor` al añadir la revision (spec 046). Todo lo
   * que hay aqui es conocimiento pagado con averias —el reintento solo de lo que
   * puede salir bien, el cuerpo que hay que cancelar a mano, los errores que
   * llegan con HTTP 200, la negativa en su propio campo, el truncado por
   * `max_tokens`, el `TypeError` que no es un fallo de red— y duplicarlo para el
   * supervisor habria sido perderlo a la mitad.
   *
   * `que` solo entra en los mensajes de log, para que se sepa cual de las dos
   * llamadas fallo.
   */
  private async pedir(
    cuerpo: Record<string, unknown>,
    que: string,
    titulo = 'Crypton bot advisor',
  ): Promise<string | null> {
    try {
      const json = JSON.stringify(cuerpo);

      // Un solo presupuesto de tiempo para los dos intentos: dos esperas
      // completas de 25 s se comerian el interceptor global de 80 s entre esto y
      // las dos series de velas que ya se han pedido antes de llegar aqui.
      const limite = Date.now() + TIMEOUT_MS;
      let res: Response | null = null;

      for (let intento = 1; intento <= 2; intento++) {
        const restante = limite - Date.now();
        // Menos de un segundo no da para nada: mejor rendirse que mandar una
        // peticion condenada a abortarse a medio camino.
        if (restante < 1_000) break;

        const r = await fetch(OPENROUTER_URL, {
          method: 'POST',
          headers: this.headers(titulo),
          body: json,
          signal: AbortSignal.timeout(restante),
        });

        // Se reintenta SOLO lo que puede salir bien a la segunda. Un 401 o un
        // 402 van a fallar igual y reintentarlos solo gasta el presupuesto.
        //
        // El reintento no es un lujo: el uso de cupo ya esta apuntado antes de
        // llegar aqui, asi que un 502 pasajero le costaria al usuario uno de sus
        // veinte usos del dia a cambio de nada.
        const reintentable = !r.ok && (r.status >= 500 || r.status === 429);
        // `res` se queda con la ULTIMA respuesta que llegó, pase lo que pase.
        // Si el primer intento diera 5xx y ya no quedara tiempo para el segundo,
        // descartarla dejaria el fallo sin registrar en ninguna parte.
        const hayTiempo = limite - Date.now() >= 1_000;
        if (!reintentable || intento === 2 || !hayTiempo) {
          res = r;
          break;
        }
        // El cuerpo se descarta a mano: sin leerlo ni cancelarlo, la conexion
        // queda ocupada hasta que pase el recolector.
        await r.body?.cancel().catch(() => undefined);
      }

      if (!res) return null;
      if (!res.ok) return this.reportarFallo(res);

      const datos = (await res.json()) as RespuestaOpenRouter;

      // OpenRouter devuelve algunos errores con HTTP 200 y el fallo en el
      // cuerpo: hay que mirarlo antes de leer `choices`.
      if (datos.error) {
        this.logger.debug(
          `El modelo no respondió (${datos.error.code ?? '?'}): ${datos.error.message ?? ''}`,
        );
        return null;
      }

      const eleccion = datos.choices?.[0];
      if (!eleccion) return null;

      // Una negativa por seguridad tambien llega con 200, en su propio campo.
      if (eleccion.message?.refusal) {
        this.logger.warn(`El modelo declinó la petición de ${que}.`);
        return null;
      }
      // Truncado: el JSON estara a medias y `parse()` fallaria igual, pero en
      // silencio. Se registra como aviso porque significa que el tope se ha
      // quedado corto, y eso hay que verlo en el log, no deducirlo de que las
      // recomendaciones «siempre salen por reglas».
      if (eleccion.finish_reason === 'length') {
        this.logger.warn(
          'La respuesta del modelo se truncó por max_tokens: se usan reglas. ' +
            'Si se repite, hay que subir MAX_TOKENS.',
        );
        return null;
      }

      return eleccion.message?.content ?? '';
    } catch (e) {
      // El tiempo de espera agotado llega como `TimeoutError` desde
      // `AbortSignal.timeout`. Se registra aparte porque significa otra cosa que
      // un fallo de red: el modelo estaba pensando de mas.
      const nombre = (e as Error)?.name;
      if (nombre === 'TimeoutError' || nombre === 'AbortError') {
        this.logger.debug(`El modelo tardó más de ${TIMEOUT_MS} ms: se usan reglas.`);
      } else if (e instanceof TypeError) {
        // Un TypeError aqui NO es un problema de red: es una peticion mal
        // construida por nosotros —una cabecera con un carácter ilegal, un
        // cuerpo que no se puede serializar— y `fetch` la rechaza antes de
        // abrir el socket. Va como error y no como depuracion porque si no,
        // un fallo permanente nuestro se disfraza de caida ajena pasajera.
        this.logger.error(`Petición a OpenRouter mal formada, no llegó a salir: ${e.message}`);
      } else {
        this.logger.debug(`Fallo al pedir ${que}: ${String(e)}`);
      }
      return null;
    }
  }

  /**
   * Las cabeceras.
   *
   * Estan en su propio metodo por una razon concreta: los valores de cabecera
   * HTTP son ByteString, y `fetch` LANZA ante un solo caracter por encima de
   * 255. Un guion largo en el titulo —lo natural al escribirlo en español— hacia
   * que la peticion no llegara a salir NUNCA. Y como el fallo aparecia en el
   * catch general, se registraba como un problema de red cualquiera y la funcion
   * servia reglas para siempre mientras el cupo se seguia gastando.
   *
   * Todo lo que salga de aqui va en ASCII, y hay un test que lo comprueba.
   */
  private headers(titulo: string): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      // Identifican la llamada en el panel de OpenRouter. Sin ellas todo el
      // gasto aparece como «desconocido», que es justo lo que no quieres cuando
      // hay que averiguar quien se esta comiendo el saldo.
      'HTTP-Referer': this.referer,
      // Distingue las dos cargas en el panel de OpenRouter. Es la forma barata
      // de ver por separado lo que gasta el asesor y lo que gasta el supervisor
      // sin abrir una segunda cuenta.
      'X-Title': titulo,
    };
  }

  /**
   * El cuerpo de la peticion.
   *
   * Sin `temperature` ni `top_p`. `temperature` SI la admite este modelo —lo
   * dice su ficha en OpenRouter—, asi que no mandarla es una decision: la salida
   * ya viene acotada por el esquema a quince enumeraciones, de modo que bajar la
   * temperatura no puede hacerla mas correcta y subirla solo cambiaria cual de
   * las combinaciones validas sale. `top_p` directamente no figura entre los
   * parametros admitidos, y mandarlo solo serviria para que se ignore.
   */
  private body(
    strategy: string,
    symbol: string,
    features: MarketFeatures,
  ): Record<string, unknown> {
    return {
      model: this.model,
      max_tokens: MAX_TOKENS,
      // Elegir tres ternas de enumeraciones no da para mas: subir el esfuerzo
      // aqui es pagar tokens de razonamiento por una decision que ya viene
      // acotada por el esquema.
      reasoning: { effort: 'low', exclude: true },
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'perillas',
          strict: true,
          schema: knobsSchema(),
        },
      },
      // NO es una precaucion de manual: este modelo se sirve desde varios
      // proveedores y algunos NO soportan salidas estructuradas. Sin esto, una
      // parte de las peticiones acabaria en uno que IGNORA el esquema — el
      // modelo devolveria texto libre, `parse()` fallaria y la funcion caeria a
      // las reglas de forma intermitente y sin motivo aparente, que es de los
      // fallos mas caros de diagnosticar.
      provider: { require_parameters: true },
      // SIN marcador de cache de prompt, y medido antes de quitarlo: el bloque
      // estable son ~530 tokens y el minimo cacheable de Sonnet son 1024. Un
      // `cache_control` aqui no se activaria NUNCA — seria un adorno que aparenta
      // una optimizacion que no existe. Quien ahorra de verdad las llamadas es el
      // cache de perillas del servicio, que se salta la peticion entera.
      messages: [
        { role: 'system', content: systemPrompt() },
        { role: 'user', content: marketPrompt(strategy, symbol, features) },
      ],
    };
  }

  /**
   * Registra un fallo HTTP con el nivel que le corresponde.
   *
   * La distincion importa: 401 y 402 son problema del OPERADOR y hay que verlos
   * en el log de errores; los demas son ruido pasajero que el plan B ya cubre.
   * Sin separarlos, un saldo agotado se confunde con una caida de OpenRouter y
   * se busca donde no es.
   */
  private async reportarFallo(res: Response): Promise<null> {
    const cuerpo = await res.text().catch(() => '');
    if (res.status === 401) {
      this.logger.error('La clave de OpenRouter no es válida.');
    } else if (res.status === 402) {
      this.logger.error(
        'OpenRouter rechaza la llamada por saldo insuficiente: ' +
          'recarga la cuenta o el asistente seguirá usando solo reglas.',
      );
    } else if (res.status === 429) {
      this.logger.warn('OpenRouter está limitando el ritmo: se usan reglas.');
    } else {
      this.logger.debug(`El modelo no respondió (${res.status}): ${cuerpo.slice(0, 300)}`);
    }
    return null;
  }

  /**
   * Valida la forma de la respuesta.
   *
   * Las perillas NO se reparan: si no cumplen el esquema, la respuesta entera no
   * es de fiar y se cae al plan B. Reparar aqui seria adivinar que quiso decir
   * un modelo que ya se ha salido del contrato.
   *
   * Se valida aunque el modo estricto prometa que no hace falta: la promesa la
   * cumple el proveedor, y el proveedor lo elige el enrutador.
   */
  private parse(raw: string): { knobs: Knobs; rationale: string }[] | null {
    let datos: unknown;
    try {
      datos = JSON.parse(raw);
    } catch {
      return null;
    }

    const propuestas = (datos as { propuestas?: unknown[] })?.propuestas;
    if (!Array.isArray(propuestas) || propuestas.length !== 3) return null;

    const esBanda = (v: unknown): v is Band => BANDS.includes(v as Band);
    const salida: { knobs: Knobs; rationale: string }[] = [];
    const perfilesVistos = new Set<Profile>();

    for (const p of propuestas) {
      const o = p as Record<string, unknown>;
      const profile = o['profile'] as Profile;
      if (!PROFILES.includes(profile) || perfilesVistos.has(profile)) return null;
      perfilesVistos.add(profile);

      if (
        !esBanda(o['leverage']) ||
        !esBanda(o['coverage']) ||
        !esBanda(o['spread']) ||
        !esBanda(o['sizeGrowth']) ||
        !esBanda(o['cadence'])
      ) {
        return null;
      }

      salida.push({
        knobs: {
          profile,
          leverage: o['leverage'],
          coverage: o['coverage'],
          spread: o['spread'],
          sizeGrowth: o['sizeGrowth'],
          cadence: o['cadence'],
        },
        // Lo unico del modelo que se pinta TAL CUAL en la interfaz, asi que se
        // trata como lo que es: texto ajeno.
        //
        // Se exige que SEA una cadena en vez de convertirla. `String()` sobre un
        // objeto da «[object Object]», y eso acabaria de explicacion en una
        // tarjeta. Y se recorta aqui sin fiarse del modelo: el limite de
        // longitud es una descripcion del esquema, no algo que la API imponga.
        rationale: typeof o['rationale'] === 'string' ? o['rationale'].slice(0, 240) : '',
      });
    }

    return salida;
  }
}
