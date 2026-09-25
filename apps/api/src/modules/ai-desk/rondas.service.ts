import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AiMode,
  ClaseAccion,
  EfectoAccion,
  EstadoAgente,
  EstadoPropuestaAgente,
  EstadoRondaAgente,
  EventSeverity,
  EventoAgente,
  ModoDecision,
  MotivoPausaAgente,
  MotivoPropuestaAgente,
  MotivoRonda,
  TipoRondaAgente,
  candleSpanMs,
  efectoDe,
  type CandidatoAgente,
  type EleccionAgente,
  type FamiliaAgente,
  type IntervaloAgente,
  type LimitesAgente,
  type RespuestaModeloAgente,
  type RondaVista,
  type SalidaAgente,
  type SalidaAgentePar,
} from '@crypton/shared';
import {
  barreraDelDia,
  construirPropuesta,
  esElegibleAgente,
  herramientaAgente,
  juezAgente,
  leerLimitesAgente,
  ofertaAgente,
  planMedibleDe,
  ultimaCerradaEsperada,
  type HistorialAgente,
  type ParAgente,
  type PuestoOferta,
} from '@crypton/strategy-core';
import { CacheService, DbService } from 'src/libs';
import { OpenRouterClient, type RespuestaDecision } from '../advisor/openrouter.client';
import { RiskService } from '../risk/risk.service';
import { AiDeskConfig } from './ai-desk.config';
import { AiDeskAgentesService, DUENO_DE_AGENTES } from './agentes.service';
import { AiDeskAprobacionService, OrigenDecision } from './aprobacion.service';
import { AiDeskAvisosService } from './avisos.service';
import { AiDeskConsumoService } from './consumo.service';
import { esquemaEntrada, parseEntrada, recortarSinPartir, validarEntrada } from './contrato';
import { AiDeskInterruptoresService } from './interruptores.service';
import { AiDeskLecturaService } from './lectura.service';
import { systemPromptAgente, versionPromptAgente } from './prompt';
import { renderOferta } from './render';
import { textoPropuesta } from './textos';
import { SELECT_RONDA_VISTA, autonomiaDe, esCuentaReal, rondaVista } from './vistas';

/** Lo que se guarda de una respuesta fuera del contrato, para poder mirarla. */
const MAX_BRUTO = 2_000;
const BOT_VIVO = ['STARTING', 'RUNNING', 'PAUSED'] as const;

/** Lo que dejó una ronda, para quien la lanzó. */
export interface ResultadoRonda {
  rondaId: string;
  estado: EstadoRondaAgente;
  motivo: MotivoRonda | null;
  propuestaId: string | null;
}

/** Quién lanza una ronda de entrada: el reloj o una persona desde la app. */
export type DisparadorEntrada = 'INTERVALO' | 'MANUAL';

const SELECT_RONDA = {
  id: true,
  name: true,
  user_id: true,
  state: true,
  symbols: true,
  interval: true,
  families: true,
  sides: true,
  decision_mode: true,
  limits: true,
  auto_entry: true,
  auto_reduce: true,
  auto_close: true,
  sleeping_until: true,
  failures: true,
  usage_day: true,
  cost_today: true,
  exchange_account: {
    select: { id: true, venue: true, paper: true, testnet: true, status: true },
  },
  user: { select: { role: true, disabled: true } },
} as const;

type AgenteRonda = NonNullable<Awaited<ReturnType<AiDeskRondasService['leerAgente']>>>;

/** Lo que se sabe de la decisión de una ronda, para guardarlo. */
interface Decision {
  eleccion: EleccionAgente | null;
  /** Por qué no hay elección, si no la hay: NINGUNA u OFERTA. */
  motivo: MotivoRonda | null;
  juez: EleccionAgente | null;
  respuesta: RespuestaModeloAgente | null;
  fallo: string | null;
  bruto?: string;
  llamada: RespuestaDecision | null;
}

/**
 * La ronda de entrada de un agente (spec 074, R-12 a R-18): cada intervalo,
 * las operaciones posibles en sus pares, una decisión y, si la hay, una
 * propuesta.
 *
 * El reparto es el del canal: el motor calcula TODO —candidatos, stops,
 * objetivos, tamaños—, la IA o el juez eligen con enumeraciones, y nada llega
 * al exchange sin pasar por la aprobación, que vuelve a calcular con el precio
 * de ese momento. Y se pregunta poco:
 * - una ronda de intervalo por agente y vela, con índice único: dos réplicas
 *   nunca la repiten;
 * - antes de gastar se comprueba todo lo que haría inútil la llamada, en el
 *   orden del spec y cerrando ante la duda;
 * - el cupo se cuenta ANTES de llamar, y sin Redis no se llama;
 * - sin respuesta válida no hay propuesta, y cinco fallos seguidos duermen el
 *   agente seis horas.
 *
 * Todo lo que ve y decide queda en la ronda y en sus candidatos, también lo
 * que no se ofrece: con eso se mide si quien elige distingue lo bueno de lo
 * malo (spec 070).
 */
@Injectable()
export class AiDeskRondasService {
  private readonly logger = new Logger(AiDeskRondasService.name);
  /** Rondas en marcha en esta réplica. */
  private enCurso = 0;

  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly cfg: AiDeskConfig,
    private readonly interruptores: AiDeskInterruptoresService,
    private readonly lectura: AiDeskLecturaService,
    private readonly agentes: AiDeskAgentesService,
    private readonly modelo: OpenRouterClient,
    private readonly avisos: AiDeskAvisosService,
    private readonly aprobacion: AiDeskAprobacionService,
    private readonly risk: RiskService,
    private readonly consumo: AiDeskConsumoService,
  ) {}

  /** Cuántas rondas más caben ahora en esta réplica. */
  get huecos(): number {
    return Math.max(0, this.cfg.concurrencia - this.enCurso);
  }

  /**
   * Una ronda de entrada. null si no le toca a esta réplica: no hay hueco, el
   * agente no existe o la ronda de esa vela ya la hizo otra.
   *
   * El hueco se reserva ANTES del primer `await`: dos llamadas en el mismo
   * instante no pueden pasar las dos por un hueco que solo es de una.
   */
  async rondaEntrada(
    agentId: string,
    disparador: DisparadorEntrada,
    ahora = Date.now(),
  ): Promise<ResultadoRonda | null> {
    if (this.enCurso >= this.cfg.concurrencia) return null;
    this.enCurso++;
    try {
      const agente = await this.leerAgente(agentId);
      if (!agente) return null;
      // Frontera Prisma: el intervalo se validó al guardar el agente.
      const intervalo = agente.interval as IntervaloAgente;
      const barT = ultimaCerradaEsperada(ahora, intervalo);
      let rondaId: string;
      try {
        rondaId = (
          await this.db.aiDeskRound.create({
            data: {
              agent_id: agente.id,
              kind: TipoRondaAgente.ENTRADA,
              bar_t: new Date(barT),
              trigger: disparador,
              decision_mode: modoDe(agente),
            },
            select: { id: true },
          })
        ).id;
      } catch (e) {
        // La de esta vela ya la hizo otra réplica (uq_ai_desk_round_entrada).
        if ((e as { code?: string }).code === 'P2002') return null;
        throw e;
      }
      try {
        return await this.ronda(rondaId, agente, intervalo, barT, ahora);
      } catch (e) {
        this.logger.error(`Ronda ${rondaId} del agente ${agentId}: ${(e as Error).message}`);
        return this.cerrar(rondaId, EstadoRondaAgente.FALLIDA, MotivoRonda.ERROR);
      }
    } finally {
      this.enCurso--;
    }
  }

  /**
   * «Analizar ahora», desde la app (R-24): una ronda de entrada fuera del
   * reloj, con las mismas barreras. Una por minuto y agente: cada una puede
   * costar una llamada al modelo. Solo sobre un agente propio.
   */
  async analizarAhora(adminId: string, agentId: string): Promise<RondaVista> {
    const suyo = await this.db.aiDeskAgent.findFirst({
      where: { id: agentId, user_id: adminId },
      select: { id: true },
    });
    if (!suyo) throw new NotFoundException('Agente no encontrado.');
    const libre = await this.cache.setnx(`ai-desk:manual:${agentId}`, 1, 60).catch(() => false);
    if (!libre) {
      throw new HttpException(
        'Espera un minuto entre dos análisis del mismo agente.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const r = await this.rondaEntrada(agentId, 'MANUAL');
    if (!r) {
      throw new ServiceUnavailableException(
        'Ahora mismo hay demasiados análisis en curso. Vuelve a intentarlo en un momento.',
      );
    }
    const fila = await this.db.aiDeskRound.findUnique({
      where: { id: r.rondaId },
      select: SELECT_RONDA_VISTA,
    });
    if (!fila) throw new NotFoundException('Ronda no encontrada.');
    return rondaVista(fila);
  }

  async leerAgente(agentId: string) {
    return this.db.aiDeskAgent.findUnique({ where: { id: agentId }, select: SELECT_RONDA });
  }

  // ── La ronda ─────────────────────────────────────────────────────────────

  private async ronda(
    rondaId: string,
    agente: AgenteRonda,
    intervalo: IntervaloAgente,
    barT: number,
    ahora: number,
  ): Promise<ResultadoRonda> {
    const saltar = (motivo: MotivoRonda, extra: Record<string, unknown> = {}) =>
      this.cerrar(rondaId, EstadoRondaAgente.SALTADA, motivo, extra);
    const ia = modoDe(agente) === ModoDecision.IA;
    const cuenta = agente.exchange_account;

    // Las barreras, en el orden del spec (R-12). La primera que se cierra es la
    // que se anota, y ninguna gasta una llamada.
    if (!this.cfg.encendido) return saltar(MotivoRonda.IA_APAGADA);
    // En modo IA, sin clave del modelo no hay a quién preguntar: se salta sin
    // contarlo como un fallo, que dormiría al agente por algo que no es suyo.
    if (ia && !this.modelo.agentesDisponible) return saltar(MotivoRonda.IA_APAGADA);
    if (
      agente.user.role !== DUENO_DE_AGENTES.role ||
      agente.user.disabled !== DUENO_DE_AGENTES.disabled
    ) {
      return saltar(MotivoRonda.DUENO);
    }
    if (agente.state !== EstadoAgente.ACTIVO) return saltar(MotivoRonda.AGENTE);
    if (ia && agente.sleeping_until && agente.sleeping_until.getTime() > ahora) {
      return saltar(MotivoRonda.DORMIDO);
    }
    const abiertas = await this.interruptores.entradasAbiertas();
    if (abiertas === null) return saltar(MotivoRonda.REDIS);
    if (!abiertas) return saltar(MotivoRonda.INTERRUPTOR);
    if (!cuenta.paper && !['VERIFIED', 'ACTIVE'].includes(cuenta.status)) {
      return saltar(MotivoRonda.CUENTA);
    }
    const limites = leerLimitesAgente(agente.limits);
    const historial = await this.agentes.historial(agente, ahora);
    const delDia = barreraDelDia(historial, limites, ahora);
    if (delDia) {
      if (delDia === MotivoRonda.PERDIDA_DIARIA) {
        await this.pausarPorPerdida(agente, historial, limites);
      }
      return saltar(delDia);
    }
    if (await this.topeDeBots(agente.user_id)) return saltar(MotivoRonda.LIMITES_USUARIO);
    const libres = agente.symbols.filter((s) => !historial.ocupados.includes(s));
    if (libres.length === 0) return saltar(MotivoRonda.SIN_PARES);

    // El mercado de los pares libres, uno detrás de otro: el cupo por IP del
    // venue lo comparten los bots, y una ronda no tiene prisa por segundos.
    const pares: ParAgente[] = [];
    const extras: SalidaAgentePar[] = agente.symbols
      .filter((s) => historial.ocupados.includes(s))
      .map((s) => sinNada(s, 'OCUPADO'));
    for (const s of libres) {
      const l = await this.lectura.par(cuenta.venue, s, cuenta.testnet, intervalo);
      if (!l) extras.push(sinNada(s, 'SIN_MERCADO'));
      else if (l.sinTramos) extras.push(sinNada(s, 'SIN_TRAMOS'));
      else pares.push(l.par);
    }
    const [saldo, maxApalancamientoUsuario] = await Promise.all([
      this.lectura.saldoLibre(agente.user_id, cuenta.id),
      this.lectura.maxApalancamiento(agente.user_id),
    ]);
    if (saldo === null) return saltar(MotivoRonda.CUENTA);

    const base = herramientaAgente({
      limites,
      venue: cuenta.venue,
      intervalo,
      familias: agente.families as FamiliaAgente[],
      lados: agente.sides as ('LONG' | 'SHORT')[],
      pares,
      saldoLibre: saldo,
      historial,
      maxApalancamientoUsuario,
      ahora,
    });
    const salida: SalidaAgente = { ...base, pares: [...base.pares, ...extras] };
    const oferta = ofertaAgente(salida);
    const juez = juezAgente(salida);
    const conSalida = { huella: salida.huella, snapshot: salida as never };
    const deRonda = {
      id: rondaId,
      agentId: agente.id,
      barT,
      intervalo,
      maxVelas: limites.maxVelasOperacion,
    };

    if (!salida.pares.some((p) => p.mercado?.frescas)) {
      return saltar(MotivoRonda.SIN_DATOS, conSalida);
    }
    if (oferta.length === 0) {
      await this.guardarCandidatos(deRonda, salida, oferta, null, juez);
      return saltar(MotivoRonda.SIN_CANDIDATOS, conSalida);
    }

    let decision: Decision = {
      eleccion: juez,
      motivo: juez ? null : MotivoRonda.NINGUNA,
      juez,
      respuesta: null,
      fallo: null,
      llamada: null,
    };
    if (ia) {
      const huella = await this.db.aiDeskRound.findFirst({
        where: {
          agent_id: agente.id,
          kind: TipoRondaAgente.ENTRADA,
          decision_mode: ModoDecision.IA,
          state: EstadoRondaAgente.COMPLETADA,
          huella: { not: null },
          id: { not: rondaId },
        },
        orderBy: { created_at: 'desc' },
        select: { huella: true },
      });
      // La misma oferta que la última vez: preguntar otra vez sería pagar la
      // misma respuesta (R-12).
      if (huella?.huella === salida.huella) return saltar(MotivoRonda.HUELLA, conSalida);
      const cupo = await this.consumo.cupo(agente, limites, ahora);
      if (cupo) return saltar(cupo, conSalida);
      const consulta = await this.consultar(agente, salida, oferta, limites, ahora);
      if (consulta.fallo !== null) {
        return this.cerrar(
          rondaId,
          EstadoRondaAgente.FALLIDA,
          consulta.fallo === 'CONTRATO' ? MotivoRonda.CONTRATO : MotivoRonda.MODELO,
          { ...conSalida, ...this.columnasLlamada(consulta), decision: jsonDe(consulta) },
        );
      }
      decision = consulta;
    }

    await this.guardarCandidatos(deRonda, salida, oferta, decision.eleccion, juez);
    const columnas = { ...conSalida, ...this.columnasLlamada(decision) };
    if (!decision.eleccion) {
      return this.cerrar(
        rondaId,
        EstadoRondaAgente.COMPLETADA,
        decision.motivo ?? MotivoRonda.NINGUNA,
        { ...columnas, decision: jsonDe(decision) },
      );
    }
    return this.proponer(
      rondaId,
      agente,
      intervalo,
      salida,
      oferta,
      pares,
      decision,
      columnas,
      ahora,
    );
  }

  /** La consulta al modelo, con su uso anotado. Nunca lanza. */
  private async consultar(
    agente: AgenteRonda,
    salida: SalidaAgente,
    oferta: readonly PuestoOferta[],
    limites: LimitesAgente,
    ahora: number,
  ): Promise<Decision> {
    const letras = oferta.map((p) => p.letra);
    const juez = juezAgente(salida);
    const llamada = await this.modelo.decidirAgente({
      esquema: esquemaEntrada(letras),
      system: systemPromptAgente(),
      usuario: renderOferta(salida, oferta, limites, agente.sides),
      limiteMs: this.cfg.plazoLlamadaMs,
    });
    const coste = llamada.uso?.coste ?? null;
    if (llamada.contenido === null || llamada.fallo !== null) {
      const fallo = llamada.fallo ?? 'VACIA';
      await this.consumo.anotar(agente, coste, `MODELO:${fallo}`, ahora);
      return { eleccion: null, motivo: MotivoRonda.MODELO, juez, respuesta: null, fallo, llamada };
    }
    const respuesta = parseEntrada(llamada.contenido, letras);
    if (!respuesta) {
      await this.consumo.anotar(agente, coste, 'CONTRATO', ahora);
      return {
        eleccion: null,
        motivo: MotivoRonda.CONTRATO,
        juez,
        respuesta: null,
        fallo: 'CONTRATO',
        bruto: recortarSinPartir(llamada.contenido, MAX_BRUTO),
        llamada,
      };
    }
    // Una respuesta válida, opere o no, rompe la racha de fallos.
    await this.consumo.anotar(agente, coste, null, ahora);
    const v = validarEntrada(respuesta, oferta);
    return { eleccion: v.eleccion, motivo: v.motivo, juez, respuesta, fallo: null, llamada };
  }

  /** Con una elección: el plan, y la propuesta según la autonomía de entrar. */
  private async proponer(
    rondaId: string,
    agente: AgenteRonda,
    intervalo: IntervaloAgente,
    salida: SalidaAgente,
    oferta: readonly PuestoOferta[],
    pares: readonly ParAgente[],
    decision: Decision,
    columnas: Record<string, unknown>,
    ahora: number,
  ): Promise<ResultadoRonda> {
    const eleccion = decision.eleccion;
    const puesto = oferta.find((p) => p.candidato.id === eleccion?.candidatoId);
    // El mercado del par, el mismo que acaba de leer la ronda.
    const market = pares.find((p) => p.simbolo === puesto?.candidato.simbolo)?.market ?? null;
    const vidaMs = Math.min(this.cfg.vidaPropuestaMin * 60_000, candleSpanMs(intervalo));
    const limites = leerLimitesAgente(agente.limits);
    const r =
      eleccion && market
        ? construirPropuesta(salida, eleccion, {
            limites,
            venue: agente.exchange_account.venue,
            market,
            intervalo,
            ahora,
            vidaMs,
          })
        : null;
    if (!r?.plan || !puesto || !eleccion) {
      return this.cerrar(rondaId, EstadoRondaAgente.COMPLETADA, MotivoRonda.OFERTA, {
        ...columnas,
        decision: jsonDe(decision),
      });
    }

    const cuenta = agente.exchange_account;
    const real = esCuentaReal(cuenta);
    const autonomia = autonomiaDe(agente);
    const frenos = this.cfg.frenos;
    const efecto = efectoDe(ClaseAccion.ENTRAR, autonomia, frenos, real);
    const mide = efecto === EfectoAccion.MIDE;
    const motivoSombra = !mide
      ? null
      : autonomia.entrar === AiMode.OFF
        ? MotivoPropuestaAgente.SOLO_MEDIR
        : frenos.soloSombra
          ? MotivoPropuestaAgente.SOLO_SOMBRA
          : MotivoPropuestaAgente.SOLO_SIMULACION;
    const propuesta = await this.db.aiDeskProposal.create({
      data: {
        agent_id: agente.id,
        round_id: rondaId,
        candidate_key: puesto.candidato.id,
        symbol: puesto.candidato.simbolo,
        family: puesto.candidato.familia,
        side: puesto.candidato.lado,
        state: mide ? EstadoPropuestaAgente.SOMBRA : EstadoPropuestaAgente.PROPUESTA,
        reason: motivoSombra,
        // Frontera Prisma-JSON: el plan y la decisión son objetos planos.
        plan: r.plan as never,
        decision: { eleccion, respuesta: decision.respuesta, efecto } as never,
        // Lo que no es dinero de verdad —simulación o testnet— no se suma nunca
        // al que sí lo es.
        dry_run: !real,
        expires_at: new Date(ahora + vidaMs),
      },
      select: { id: true },
    });
    const resultado = await this.cerrar(
      rondaId,
      EstadoRondaAgente.COMPLETADA,
      mide ? MotivoRonda.SOMBRA : MotivoRonda.PROPUESTA,
      { ...columnas, decision: jsonDe({ ...decision, efecto }) },
    );
    const conPropuesta = { ...resultado, propuestaId: propuesta.id };
    if (mide) return conPropuesta;

    const texto = (automatico: boolean) =>
      textoPropuesta(r.plan, {
        quote: market?.quote ?? '',
        real,
        confianza: eleccion.confianza,
        texto: decision.respuesta?.texto ? decision.respuesta.texto : null,
        vidaMin: automatico ? null : Math.round(vidaMs / 60_000),
      });
    const datos = { agentId: agente.id, propuestaId: propuesta.id };
    if (efecto === EfectoAccion.APLICA) {
      await this.avisos.agente(
        agente.user_id,
        EventoAgente.PROPUESTA,
        EventSeverity.INFO,
        texto(true),
        datos,
      );
      await this.aprobacion.aprobar(agente.user_id, propuesta.id, OrigenDecision.AUTO);
      return conPropuesta;
    }
    const vale = await this.avisos.vale(
      { userId: agente.user_id, agentId: agente.id, propuestaId: propuesta.id, accionId: null },
      vidaMs / 1000,
    );
    await this.avisos.agente(
      agente.user_id,
      EventoAgente.PROPUESTA,
      real ? EventSeverity.WARN : EventSeverity.INFO,
      texto(false) + (vale ? '' : '\nApruébala desde la app.'),
      vale ? { ...datos, vale } : datos,
    );
    return conPropuesta;
  }

  // ── Lo de alrededor ──────────────────────────────────────────────────────

  /**
   * Los candidatos de la ronda, se ofrecieran o no: con ellos se mide si quien
   * elige distingue lo bueno de lo malo. Cada uno con su plan medible, su
   * intervalo y la duración máxima de entonces: si su dueño edita el agente
   * después, lo ya decidido se sigue midiendo con lo suyo.
   */
  private async guardarCandidatos(
    ronda: {
      id: string;
      agentId: string;
      barT: number;
      intervalo: IntervaloAgente;
      maxVelas: number;
    },
    salida: SalidaAgente,
    oferta: readonly PuestoOferta[],
    elegida: EleccionAgente | null,
    juez: EleccionAgente | null,
  ): Promise<void> {
    const letras = new Map(oferta.map((p) => [p.candidato.id, p.letra]));
    const medible = (c: CandidatoAgente) => {
      const plan = planMedibleDe(c, ronda.barT);
      return plan ? { ...plan, intervalo: ronda.intervalo, maxVelas: ronda.maxVelas } : undefined;
    };
    const filas = salida.pares.flatMap((p) =>
      p.candidatos.map((c) => ({
        round_id: ronda.id,
        agent_id: ronda.agentId,
        candidate_key: c.id,
        symbol: c.simbolo,
        family: c.familia,
        side: c.lado,
        letter: letras.get(c.id) ?? null,
        eligible: esElegibleAgente(c),
        chosen: elegida?.candidatoId === c.id,
        judge_choice: juez?.candidatoId === c.id,
        // Frontera Prisma-JSON: un objeto plano.
        measurable: medible(c) as never,
      })),
    );
    if (filas.length > 0) await this.db.aiDeskCandidate.createMany({ data: filas });
  }

  /** Cierra la ronda con su estado y su motivo. */
  private async cerrar(
    rondaId: string,
    estado: EstadoRondaAgente,
    motivo: MotivoRonda,
    extra: Record<string, unknown> = {},
  ): Promise<ResultadoRonda> {
    await this.db.aiDeskRound.update({
      where: { id: rondaId },
      // Frontera Prisma: el snapshot y la decisión son objetos planos.
      data: { state: estado, reason: motivo, finished_at: new Date(), ...extra } as never,
    });
    return { rondaId, estado, motivo, propuestaId: null };
  }

  private columnasLlamada(d: Pick<Decision, 'llamada'>): Record<string, unknown> {
    const l = d.llamada;
    if (!l) return {};
    return {
      model: l.modelo,
      prompt_version: versionPromptAgente(),
      latency_ms: l.latenciaMs,
      cost: l.uso?.coste ?? null,
    };
  }

  /**
   * La pérdida del día pausa el agente, una vez por día: si su dueño lo
   * reanuda, la barrera sigue cortando las entradas de ese día sin volver a
   * pausarlo ni a avisar en cada vela.
   */
  private async pausarPorPerdida(
    agente: AgenteRonda,
    historial: HistorialAgente,
    limites: LimitesAgente,
  ): Promise<void> {
    const dia = new Date(historial.dia).toISOString().slice(0, 10);
    const primera = await this.cache
      .setnx(`ai-desk:pausa-diaria:${agente.id}:${dia}`, 1, 86_400)
      .catch(() => false);
    if (!primera) return;
    const r = await this.db.aiDeskAgent.updateMany({
      where: { id: agente.id, state: EstadoAgente.ACTIVO },
      data: { state: EstadoAgente.PAUSADO, pause_reason: MotivoPausaAgente.PERDIDA_DIARIA },
    });
    if (r.count !== 1) return;
    await this.db.aiDeskProposal.updateMany({
      where: { agent_id: agente.id, state: EstadoPropuestaAgente.PROPUESTA },
      data: {
        state: EstadoPropuestaAgente.DESCARTADA,
        reason: MotivoPropuestaAgente.AGENTE_PAUSADO,
        decided_at: new Date(),
      },
    });
    await this.avisos.agente(
      agente.user_id,
      EventoAgente.PAUSADO,
      EventSeverity.WARN,
      `Pérdida del día en su tope (${limites.perdidaDiariaPct} % del capital, contando al stop lo ` +
        'abierto): el agente se pausa. Lo abierto sigue con su stop y su seguimiento. ' +
        'Reanúdalo desde la app cuando quieras.',
      { agentId: agente.id },
    );
  }

  /** El tope de bots vivos del usuario (`risk_limits.max_open_bots`), ya alcanzado. */
  private async topeDeBots(userId: string): Promise<boolean> {
    const limites = await this.risk.get(userId);
    if (limites.max_open_bots == null) return false;
    const vivos = await this.db.bot.count({
      where: { user_id: userId, status: { in: [...BOT_VIVO] } },
    });
    return vivos >= limites.max_open_bots;
  }
}

/** Un par sin nada que ofrecer, con su motivo. */
const sinNada = (simbolo: string, descarte: string): SalidaAgentePar => ({
  simbolo,
  mercado: null,
  candidatos: [],
  descartes: [descarte],
});

const modoDe = (a: { decision_mode: string }): ModoDecision =>
  a.decision_mode === ModoDecision.REGLAS ? ModoDecision.REGLAS : ModoDecision.IA;

/** Lo que se guarda de la decisión: sin la llamada entera, que ya tiene sus columnas. */
function jsonDe(d: Decision & { efecto?: EfectoAccion }): never {
  const { llamada: _llamada, ...resto } = d;
  // Frontera Prisma-JSON: un objeto plano y serializable.
  return resto as never;
}
