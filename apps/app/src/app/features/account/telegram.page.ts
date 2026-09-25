import { Component, OnInit, computed, inject, signal } from '@angular/core';
import {
  AlertController,
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonNote,
  IonSpinner,
  IonTitle,
  IonToggle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { Clipboard } from '@capacitor/clipboard';
import { Browser } from '@capacitor/browser';
import { addIcons } from 'ionicons';
import { copyOutline, openOutline, paperPlaneOutline } from 'ionicons/icons';
import { AuthService } from '../../core/auth';
import { TelegramService, ToastService, type TelegramPrefs } from '../../core/services';
import { ModoIaService } from '../../core/services/modo-ia.service';
import { errorText, shortDate } from '../../core/utils';

/** Los avisos, en orden de utilidad para quien acaba de vincular. */
const PREF_ROWS: { key: keyof TelegramPrefs; label: string; help: string }[] = [
  {
    key: 'liquidation',
    label: 'Cercanía a liquidación',
    help: 'Cuando el precio se acerca al punto en que el exchange cerraría tu posición.',
  },
  {
    key: 'risk',
    label: 'Guardas de riesgo',
    help: 'Cuando salta un límite y el bot se pausa solo.',
  },
  {
    key: 'errors',
    label: 'Errores',
    help: 'Órdenes rechazadas, falta de margen, credenciales caducadas.',
  },
  {
    key: 'cycles',
    label: 'Ciclos cerrados',
    help: 'Cada vez que un bot cierra un ciclo, con su resultado.',
  },
  {
    key: 'daily',
    label: 'Resumen diario',
    help: 'Un mensaje al día con el resultado de la jornada.',
  },
  {
    key: 'fills',
    label: 'Cada ejecución',
    help: 'Una línea por orden ejecutada. Un market maker genera decenas por hora.',
  },
];

/**
 * Los avisos del Modo IA, solo para quien puede encenderlo: hoy, un
 * administrador sobre un bot suyo. Ofrecérselo a todo el mundo sería un
 * interruptor para avisos que nunca va a recibir. Y un administrador lo
 * necesita: con estos avisos apagados, el supervisor no revisa sus bots en
 * «propone y espera», porque sus sugerencias no llegarían (spec 055, 053/H-03).
 */
const FILA_IA: (typeof PREF_ROWS)[number] = {
  key: 'ai',
  label: 'Modo IA',
  help:
    'Las sugerencias del supervisor, con sus botones para aplicarlas, y los cambios que aplica ' +
    'solo. Si lo apagas, los bots en «propone y espera» dejan de revisarse.',
};

/**
 * Los avisos de los agentes de IA (spec 074), también solo para quien puede
 * crearlos. A diferencia del Modo IA, apagarlos no deja nada sin decidir: las
 * propuestas se pueden aprobar desde la sección IA.
 */
const FILA_AGENTES: (typeof PREF_ROWS)[number] = {
  key: 'agentes',
  label: 'Agentes de IA',
  help:
    'Las propuestas de tus agentes, con sus botones para ejecutarlas, lo que hacen con las ' +
    'operaciones abiertas y cómo acaban. Si lo apagas, las propuestas solo se ven en la app.',
};

@Component({
  selector: 'app-telegram',
  standalone: true,
  imports: [
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonBackButton,
    IonContent,
    IonList,
    IonListHeader,
    IonItem,
    IonLabel,
    IonToggle,
    IonButton,
    IonIcon,
    IonNote,
    IonSpinner,
  ],
  templateUrl: './telegram.page.html',
  styleUrl: './telegram.page.scss',
})
export class TelegramPage implements OnInit {
  readonly telegram = inject(TelegramService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly alerts = inject(AlertController);
  /**
   * El canal de las sugerencias sale de aquí: tras vincular, desvincular o tocar
   * un aviso, las pastillas y los avisos del Modo IA se releen en vez de quedarse
   * con lo de antes (spec 056, A-4). Para quien no es administrador no hace nada.
   */
  private readonly modoIa = inject(ModoIaService);

  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly code = signal<string | null>(null);
  readonly deepLink = signal<string | null>(null);

  private readonly esAdmin = computed(() => this.auth.user()?.role === 'ADMIN');
  readonly rows = computed(() =>
    this.esAdmin() ? [...PREF_ROWS, FILA_IA, FILA_AGENTES] : PREF_ROWS,
  );
  readonly shortDate = shortDate;

  constructor() {
    addIcons({ paperPlaneOutline, copyOutline, openOutline });
  }

  async ngOnInit(): Promise<void> {
    try {
      await this.telegram.refresh();
    } catch (e) {
      await this.toast.error(errorText(e));
    } finally {
      this.loading.set(false);
    }
  }

  async generate(): Promise<void> {
    this.busy.set(true);
    try {
      const result = await this.telegram.link();
      this.code.set(result.code);
      this.deepLink.set(result.deepLink);
      // Un código nuevo invalida la vinculación que hubiera.
      void this.modoIa.refrescar();
    } catch (e) {
      await this.toast.error(errorText(e));
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Abre Telegram con el código ya puesto.
   *
   * Usa el navegador del sistema y no `window.open`: dentro del WebView de
   * Capacitor, un enlace `https://t.me/...` no dispara el intent que abre la app
   * de Telegram, y el usuario acabaría viendo la web en lugar del chat.
   */
  async openTelegram(): Promise<void> {
    const url = this.deepLink() ?? this.telegram.status()?.deepLink;
    if (!url) return;
    await Browser.open({ url });
  }

  async copyCode(): Promise<void> {
    const code = this.code();
    if (!code) return;
    await Clipboard.write({ string: `/start ${code}` });
    await this.toast.success('Comando copiado. Pégalo en el chat con el bot.');
  }

  async toggle(key: keyof TelegramPrefs, value: boolean): Promise<void> {
    try {
      await this.telegram.updatePrefs({ [key]: value });
      if (key === 'ai') void this.modoIa.refrescar();
    } catch (e) {
      await this.toast.error(errorText(e));
      // Se recarga para que el interruptor vuelva a reflejar lo que hay de
      // verdad en el servidor y no se quede mintiendo.
      await this.telegram.refresh();
    }
  }

  async unlink(): Promise<void> {
    // A un administrador, además, lo que pasa con su Modo IA: sin canal, sus bots
    // en «propone y espera» dejan de revisarse (spec 056, A-12).
    const modoIa = this.esAdmin()
      ? ' Y tus bots en «propone y espera» dejarán de revisarse: sus sugerencias no tendrían ' +
        'por dónde llegar.'
      : '';
    const alert = await this.alerts.create({
      header: 'Desvincular Telegram',
      message: `Dejarás de recibir avisos, incluidos los de cercanía a liquidación.${modoIa}`,
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        {
          text: 'Desvincular',
          role: 'destructive',
          handler: () => {
            void (async () => {
              try {
                await this.telegram.unlink();
                void this.modoIa.refrescar();
                this.code.set(null);
                this.deepLink.set(null);
                await this.toast.success('Telegram desvinculado.');
              } catch (e) {
                await this.toast.error(errorText(e));
              }
            })();
          },
        },
      ],
    });
    await alert.present();
  }
}
