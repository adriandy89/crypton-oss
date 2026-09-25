import { Injectable, inject } from '@angular/core';
import { AlertController } from '@ionic/angular/standalone';
import {
  EstadoRondaAgente,
  type AccionVista,
  type AgenteVista,
  type PropuestaVista,
  type ResultadoAccionAgente,
  type ResultadoDecisionAgente,
  type RondaVista,
} from '@crypton/shared';
import { ToastService } from '../../core/services';
import { AgentesIaService } from '../../core/services/agentes-ia.service';
import { errorText } from '../../core/utils';
import { ACCION, ladoTexto, textoDe, textoRonda } from '../../core/utils/agentes-ia';
import { AVISO_SIN_MOTIVO, CAMPO_MOTIVO, motivoValido } from '../bot/motivo';

/** Cada cuánto se mira si una ronda lanzada a mano ya terminó (spec 078). */
const SONDEO_RONDA_MS = 4_000;
/** Lo más que se espera: el plazo del modelo tiene tope de 120 s. */
const ESPERA_RONDA_MAX_MS = 3 * 60_000;

/**
 * Lo que se hace con un agente, una propuesta o una acción, con su
 * confirmación (spec 074). Lo usan la pestaña IA, sus pantallas y el panel del
 * detalle de un bot `AGENT_TRADE`: una sola vez cada diálogo, para que digan lo
 * mismo en todas.
 *
 * Lo que no se negocia:
 * - ejecutar una propuesta en una cuenta REAL pide confirmación, y dice que es
 *   dinero real y que se recalcula con el precio de ahora;
 * - pausar, reanudar y archivar llevan motivo, que va a la bitácora;
 * - reanudar un agente de una cuenta real pide el consentimiento, como al
 *   crearlo: el servidor lo exige igual;
 * - cerrar una operación siempre se confirma: sale a mercado.
 *
 * Cada método resuelve cuando la petición TERMINA, con lo que respondió el
 * servidor, o con `null` si se canceló o falló (el fallo ya se ha contado).
 */
@Injectable({ providedIn: 'root' })
export class AgentesAccionesService {
  private readonly api = inject(AgentesIaService);
  private readonly alerts = inject(AlertController);
  private readonly toast = inject(ToastService);

  // ── Propuestas ───────────────────────────────────────────────────────────

  async aprobar(p: PropuestaVista): Promise<ResultadoDecisionAgente | null> {
    if (p.real) {
      const ok = await this.confirmar(
        'Ejecutar con dinero real',
        `Se abrirá ${p.simbolo} ${ladoTexto(p.lado)} en tu cuenta REAL. Antes se recalcula con ` +
          'el precio de ahora: si ya no vale, caduca sin abrir nada. El stop y los objetivos ' +
          'quedan en el exchange desde el primer momento.',
        'Ejecutar',
      );
      if (!ok) return null;
    }
    return this.decision(() => this.api.aprobar(p.id), 'EJECUTANDO');
  }

  async rechazar(p: PropuestaVista): Promise<ResultadoDecisionAgente | null> {
    return this.decision(() => this.api.rechazar(p.id), 'RECHAZADA');
  }

  // ── Operaciones y acciones ───────────────────────────────────────────────

  async aplicar(a: AccionVista): Promise<ResultadoAccionAgente | null> {
    return this.accion(() => this.api.aplicarAccion(a.id), 'APLICADA');
  }

  async descartar(a: AccionVista): Promise<ResultadoAccionAgente | null> {
    return this.accion(() => this.api.rechazarAccion(a.id), 'RECHAZADA');
  }

  async cerrar(p: PropuestaVista): Promise<ResultadoAccionAgente | null> {
    const ok = await this.confirmar(
      'Cerrar la operación',
      `Se cierra ${p.simbolo} ${ladoTexto(p.lado)} a mercado y se cancelan su stop y sus ` +
        'objetivos.' +
        (p.real ? ' Es dinero real.' : ''),
      'Cerrar',
    );
    if (!ok) return null;
    return this.accion(() => this.api.cerrar(p.id), null);
  }

  /**
   * Una ronda de seguimiento ahora. Vuelve EN_CURSO en cuanto existe: el
   * modelo puede tardar hasta su plazo (spec 078). Quien la lanza la sigue con
   * `esperarRonda`.
   */
  async revisar(p: PropuestaVista): Promise<RondaVista | null> {
    try {
      const r = await this.api.revisar(p.id);
      await this.toast.show(
        r.estado === EstadoRondaAgente.EN_CURSO
          ? 'Revisando la operación: el resultado saldrá aquí en cuanto termine.'
          : `Revisada: ${textoRonda(r)}.`,
      );
      return r;
    } catch (e) {
      await this.toast.error(errorText(e));
      return null;
    }
  }

  /**
   * Espera a que termine una ronda lanzada a mano y avisa de cómo acabó (spec
   * 078). Recarga cada pocos segundos mientras siga EN_CURSO, hasta un tope y
   * solo mientras la pantalla siga abierta. `recargar` devuelve las rondas que
   * enseña la pantalla, ya recargadas.
   */
  async esperarRonda(
    rondaId: string,
    que: string,
    recargar: () => Promise<readonly Pick<RondaVista, 'id' | 'estado' | 'motivo'>[] | undefined>,
    abierta: () => boolean,
  ): Promise<void> {
    const limite = Date.now() + ESPERA_RONDA_MAX_MS;
    while (Date.now() < limite) {
      await new Promise((r) => setTimeout(r, SONDEO_RONDA_MS));
      if (!abierta()) return;
      const r = (await recargar())?.find((x) => x.id === rondaId);
      if (r && r.estado !== EstadoRondaAgente.EN_CURSO) {
        await this.toast.show(`${que}: ${textoRonda(r)}.`);
        return;
      }
    }
  }

  // ── Agentes ──────────────────────────────────────────────────────────────

  async pausar(a: AgenteVista): Promise<AgenteVista | null> {
    const reason = await this.motivo(
      'Pausar el agente',
      'No abrirá nada nuevo hasta que lo reanudes. Lo que ya está abierto sigue con su stop, sus ' +
        'objetivos y su seguimiento, que solo reduce el riesgo.',
    );
    if (!reason) return null;
    return this.agente(() => this.api.pausar(a.id, reason), 'Agente en pausa.');
  }

  /**
   * En una cuenta real, primero el consentimiento —un botón que lo dice— y luego
   * el motivo: un diálogo de Ionic no mezcla casillas con campos de texto.
   */
  async reanudar(a: AgenteVista): Promise<AgenteVista | null> {
    const real = a.cuenta.real;
    if (real) {
      const ok = await this.confirmar(
        'Reanudar con dinero real',
        'Volverá a analizar y a proponer —o a abrir, si entrar es automático— operaciones con ' +
          'DINERO REAL en tu cuenta.',
        'Entiendo, seguir',
      );
      if (!ok) return null;
    }
    const reason = await this.motivo(
      'Reanudar el agente',
      'Volverá a analizar y a proponer operaciones.',
      'Reanudar',
    );
    if (!reason) return null;
    return this.agente(
      () => this.api.reanudar(a.id, reason, real ? true : undefined),
      'Agente reanudado.',
    );
  }

  async archivar(a: AgenteVista): Promise<AgenteVista | null> {
    const reason = await this.motivo(
      'Archivar el agente',
      'Se retira para siempre: no vuelve a analizar nada. Sus resultados se conservan. Solo se ' +
        'puede sin operaciones vivas.',
      'Archivar',
    );
    if (!reason) return null;
    return this.agente(() => this.api.archivar(a.id, reason), 'Agente archivado.');
  }

  /**
   * Una ronda de entrada ahora, fuera del reloj. Vuelve EN_CURSO en cuanto
   * existe (spec 078); quien la lanza la sigue con `esperarRonda`.
   */
  async analizar(a: AgenteVista): Promise<RondaVista | null> {
    try {
      const r = await this.api.analizar(a.id);
      await this.toast.show(
        r.estado === EstadoRondaAgente.EN_CURSO
          ? 'Analizando: el resultado saldrá en «Últimos análisis» en cuanto termine.'
          : `Análisis: ${textoRonda(r)}.`,
      );
      return r;
    } catch (e) {
      await this.toast.error(errorText(e));
      return null;
    }
  }

  // ── Lo de dentro ─────────────────────────────────────────────────────────

  private async decision(
    llamar: () => Promise<ResultadoDecisionAgente>,
    bueno: string,
  ): Promise<ResultadoDecisionAgente | null> {
    try {
      const r = await llamar();
      await (r.estado === bueno ? this.toast.success(r.mensaje) : this.toast.warn(r.mensaje));
      return r;
    } catch (e) {
      await this.toast.error(errorText(e));
      return null;
    }
  }

  private async accion(
    llamar: () => Promise<ResultadoAccionAgente>,
    bueno: string | null,
  ): Promise<ResultadoAccionAgente | null> {
    try {
      const r = await llamar();
      const ok = bueno === null || r.estado === bueno;
      await (ok ? this.toast.success(r.mensaje) : this.toast.warn(r.mensaje));
      return r;
    } catch (e) {
      await this.toast.error(errorText(e));
      return null;
    }
  }

  private async agente(
    llamar: () => Promise<AgenteVista>,
    exito: string,
  ): Promise<AgenteVista | null> {
    try {
      const a = await llamar();
      await this.toast.success(exito);
      return a;
    } catch (e) {
      await this.toast.error(errorText(e));
      return null;
    }
  }

  private async confirmar(header: string, message: string, boton: string): Promise<boolean> {
    const alerta = await this.alerts.create({
      header,
      message,
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        { text: boton, role: 'confirm' },
      ],
    });
    await alerta.present();
    const { role } = await alerta.onDidDismiss();
    return role === 'confirm';
  }

  /** Pide un motivo; `null` si se cancela. */
  private async motivo(
    header: string,
    message: string,
    boton = 'Confirmar',
  ): Promise<string | null> {
    const alerta = await this.alerts.create({
      header,
      message,
      inputs: [CAMPO_MOTIVO],
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        {
          text: boton,
          role: 'confirm',
          handler: (datos: { reason?: string }) => {
            if (motivoValido(datos?.reason)) return true;
            void this.toast.error(AVISO_SIN_MOTIVO);
            return false;
          },
        },
      ],
    });
    await alerta.present();
    const { role, data } = await alerta.onDidDismiss<{ values?: { reason?: string } }>();
    const reason = motivoValido(data?.values?.reason);
    return role === 'confirm' ? reason : null;
  }
}

/** El texto de una acción, para los botones y los avisos. */
export const textoAccionAgente = (a: AccionVista): string => textoDe(ACCION, a.accion);
