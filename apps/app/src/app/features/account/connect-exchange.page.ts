import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonList,
  IonNote,
  IonSegment,
  IonSegmentButton,
  IonSpinner,
  IonTitle,
  IonToggle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { lockClosedOutline, warningOutline } from 'ionicons/icons';
import { ExchangeAccountsService, NetworkService, ToastService } from '../../core/services';
import type { Venue } from '../../core/models';
import { errorText, parseHttpError } from '../../core/utils';
import { AuthService } from '../../core/auth';

/** Lo que hay que pedir en cada venue, y como se obtiene. */
const VENUE_HELP: Record<Venue, { title: string; steps: string[] }> = {
  HYPERLIQUID: {
    title: 'API wallet de Hyperliquid',
    steps: [
      'Entra en app.hyperliquid.xyz con tu wallet (o en app.hyperliquid-testnet.xyz para testnet).',
      'Ve a Mas → API y crea una API wallet (agent).',
      'Copia la dirección de tu cuenta principal y la clave privada del agente.',
      'La clave privada solo se muestra UNA vez: guardala antes de cerrar.',
    ],
  },
  LIGHTER: {
    title: 'Clave de API de Lighter',
    steps: [
      'Entra en app.lighter.xyz con tu wallet (o en testnet.app.lighter.xyz para testnet).',
      'Genera una clave de API y anota su índice.',
      'Necesitas el índice de cuenta, el índice de la clave y la clave privada.',
      'Configura el apalancamiento de cada mercado antes de crear el bot.',
    ],
  },
  ASTER: {
    title: 'API wallet de Aster',
    steps: [
      'Entra en asterdex.com/api-wallet con tu wallet (o en asterdex-testnet.com/en/api-wallet).',
      'Crea una API wallet y copia su dirección y su clave privada.',
      'Necesitas también la dirección de tu wallet principal (la que tiene los fondos).',
      'Fija el modo de posición y de margen de cada mercado antes de operar.',
    ],
  },
};

/**
 * Valida el destino de vuelta que llega en `?next=`.
 *
 * Se valida porque el valor viaja en la URL —y un enlace profundo lo escribe
 * cualquiera— y acaba en `navigateByUrl`: aceptarlo tal cual sería una
 * redirección abierta dentro de la propia app, con una sesión recién
 * reautenticada dentro. Solo pasa una ruta interna: una sola barra al
 * principio, nunca dos, y sin barra invertida —que el navegador normaliza
 * a otro dominio—.
 */
function rutaInterna(valor: string | null): string | null {
  if (!valor || !valor.startsWith('/') || valor.startsWith('//')) return null;
  if (valor.includes('\\')) return null;
  return valor;
}

@Component({
  selector: 'app-connect-exchange',
  standalone: true,
  imports: [
    FormsModule,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonBackButton,
    IonContent,
    IonSegment,
    IonSegmentButton,
    IonList,
    IonItem,
    IonInput,
    IonToggle,
    IonButton,
    IonNote,
    IonIcon,
    IonSpinner,
  ],
  templateUrl: './connect-exchange.page.html',
  styleUrl: './connect-exchange.page.scss',
})
export class ConnectExchangePage implements OnInit {
  private readonly accounts = inject(ExchangeAccountsService);
  private readonly network = inject(NetworkService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);

  /**
   * A dónde volver al terminar.
   *
   * Esta pantalla se abre desde dos sitios, y en cada uno conectar significa
   * algo distinto: desde la pestaña de cuenta es el fin en sí mismo, y desde
   * el paso 1 del asistente de bots es solo el requisito. Sin esto, el
   * segundo caso acababa igualmente en la pestaña de cuenta y el usuario
   * perdía a media configuración lo que venía a hacer.
   */
  private readonly next = rutaInterna(this.route.snapshot.queryParamMap.get('next'));
  readonly volverA = this.next ?? '/tabs/account';

  readonly venue = signal<Venue>('HYPERLIQUID');
  readonly busy = signal(false);
  readonly seedWarning = signal(false);

  /** Mientras sea true, el formulario ni se muestra: primero, quién eres. */
  readonly necesitaReauth = signal(true);

  label = 'Principal';

  /**
   * Red de la cuenta que se esta conectando.
   *
   * Arranca en el valor de la lente —si estas mirando testnet, lo normal es que
   * la cuenta que vas a conectar sea de testnet— y no en el `true` fijo que
   * habia antes, que solo valia para Hyperliquid y creaba en testnet a quien no
   * tocara el interruptor.
   *
   * Es una COPIA y no la señal, y aqui eso es lo correcto: en cuanto se pinta
   * el formulario esto pasa a ser una decision del usuario, y el interruptor de
   * abajo la cambia. Seguir a la lente despues de eso reescribiria en silencio
   * la red de la cuenta que se esta creando, que decide contra que libro
   * operaran sus bots. Se deja anotado porque el patron del repo es el
   * contrario y esta excepcion se lee como un olvido.
   */
  testnet = this.network.testnet();

  // Hyperliquid
  hlAccount = '';
  hlKey = '';

  // Lighter
  ltAccountIndex: number | null = null;
  ltKeyIndex: number | null = null;
  ltKey = '';

  // Aster
  asUser = '';
  asSigner = '';
  asKey = '';

  readonly help = computed(() => VENUE_HELP[this.venue()]);

  constructor() {
    addIcons({ lockClosedOutline, warningOutline });
  }

  /**
   * La reautenticación se resuelve al ENTRAR, no al guardar.
   *
   * En web, ir a Google descarga la aplicación entera: pedirla después de que
   * el usuario haya pegado su clave privada le borraría el formulario y le
   * obligaría a sacarla otra vez del exchange.
   *
   * Y se pide con un botón, no redirigiendo solo: mandar a alguien a una
   * pantalla de Google sin decirle por qué es justo el reflejo que no conviene
   * enseñarle a nadie que custodia claves.
   */
  async ngOnInit(): Promise<void> {
    try {
      this.necesitaReauth.set(!(await this.auth.hasFreshStepUp()));
    } catch {
      // Si no se puede consultar, se pide: darla por buena sin comprobarla se
      // saltaría el control entero.
      this.necesitaReauth.set(true);
    }
  }

  /** Sale hacia Google; al volver, `/auth/callback` trae de vuelta a esta ruta. */
  async confirmarIdentidad(): Promise<void> {
    this.busy.set(true);
    try {
      // Se conserva el `next` para que la vuelta de Google no pierda a dónde
      // iba. Sin él, la cadena guardada sigue siendo exactamente la de antes.
      await this.auth.startStepUp(
        this.next ? `/accounts/new?next=${encodeURIComponent(this.next)}` : '/accounts/new',
      );
    } catch (e) {
      await this.toast.error(errorText(e));
      this.busy.set(false);
    }
  }

  /**
   * Aviso inmediato si lo pegado parece una frase semilla.
   *
   * La API también lo rechaza, pero avisar aquí —antes de enviar nada— importa:
   * una seed viaja por la red aunque el servidor la descarte después.
   */
  onKeyInput(value: string): void {
    this.seedWarning.set(value.trim().split(/\s+/).length >= 12);
  }

  canSubmit(): boolean {
    if (this.seedWarning() || !this.label.trim()) return false;
    switch (this.venue()) {
      case 'HYPERLIQUID':
        return !!this.hlAccount && !!this.hlKey;
      case 'LIGHTER':
        return this.ltAccountIndex !== null && this.ltKeyIndex !== null && !!this.ltKey;
      case 'ASTER':
        return !!this.asUser && !!this.asSigner && !!this.asKey;
    }
  }

  async submit(): Promise<void> {
    if (!this.canSubmit()) return;

    // Reautenticación antes de conectar una clave de firma. Es la operación más
    // sensible de la plataforma: quien la complete puede operar con dinero
    // real. Se comprueba aquí, y la API la exige de nuevo — no basta con la
    // comprobación del cliente.
    this.busy.set(true);

    try {
      await this.accounts.create({
        venue: this.venue(),
        label: this.label.trim(),
        testnet: this.testnet,
        ...(this.venue() === 'HYPERLIQUID'
          ? {
              hyperliquid: {
                accountAddress: this.hlAccount.trim(),
                agentPrivateKey: this.hlKey.trim(),
              },
            }
          : {}),
        ...(this.venue() === 'LIGHTER'
          ? {
              lighter: {
                accountIndex: Number(this.ltAccountIndex),
                apiKeyIndex: Number(this.ltKeyIndex),
                apiPrivateKey: this.ltKey.trim(),
              },
            }
          : {}),
        ...(this.venue() === 'ASTER'
          ? {
              aster: {
                userAddress: this.asUser.trim(),
                signerAddress: this.asSigner.trim(),
                signerPrivateKey: this.asKey.trim(),
              },
            }
          : {}),
      });

      await this.toast.success('Conexión verificada y guardada.');
      await this.router.navigateByUrl(this.volverA, { replaceUrl: true });
    } catch (e) {
      // Si la reautenticación caducó mientras se rellenaba el formulario, se
      // vuelve a pedir en vez de soltar un error incomprensible.
      if (parseHttpError(e).code === 'STEP_UP_REQUIRED') {
        // Caducó mientras se rellenaba: se vuelve a la portezuela en lugar de
        // soltar un error que el usuario no sabría cómo resolver.
        await this.toast.warn('Vuelve a identificarte con Google para continuar.');
        this.necesitaReauth.set(true);
        return;
      }
      await this.toast.error(errorText(e));
    } finally {
      this.busy.set(false);
    }
  }
}
