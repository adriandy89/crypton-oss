import { Component, OnInit, computed, effect, inject, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  AlertController,
  IonButton,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonRefresher,
  IonRefresherContent,
  IonTitle,
  IonToggle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  addOutline,
  alertCircleOutline,
  checkmarkCircleOutline,
  chevronForwardOutline,
  flaskOutline,
  logOutOutline,
  paperPlaneOutline,
  pulseOutline,
  shieldOutline,
  trophyOutline,
} from 'ionicons/icons';
import { AuthService } from '../../core/auth';
import {
  ExchangeAccountsService,
  NetworkService,
  TelegramService,
  ToastService,
  WalletService,
} from '../../core/services';
import type { ExchangeAccount } from '../../core/models';
import { dayDate, errorText, money, shortDate, venueLabel } from '../../core/utils';
import {
  UiBadgeComponent,
  UiCardComponent,
  UiNoticeComponent,
  UiSectionComponent,
  UiSettingRowComponent,
} from '../../shared/ui';

/**
 * Dias de antelacion con los que se avisa de que la firma delegada caduca.
 *
 * Dos semanas: bastante para que quepa un fin de semana, un viaje y el rato de
 * entrar en el exchange a autorizar otra API wallet, y poco para que el aviso
 * no se vuelva parte del mobiliario y se deje de leer.
 */
const AVISO_CADUCIDAD_DIAS = 14;

@Component({
  selector: 'app-account',
  standalone: true,
  imports: [
    RouterLink,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonContent,
    IonButton,
    IonIcon,
    UiBadgeComponent,
    UiCardComponent,
    UiSectionComponent,
    UiSettingRowComponent,
    UiNoticeComponent,
    IonItem,
    IonToggle,
    IonRefresher,
    IonRefresherContent,
  ],
  template: `
    <ion-header>
      <ion-toolbar><ion-title>Cuenta</ion-title></ion-toolbar>
    </ion-header>

    <ion-content>
      <!-- Era la unica pestaña sin tirar-para-refrescar. En una pantalla que
           enseña saldos reales, el gesto que todo el mundo prueba primero no
           puede no hacer nada. -->
      <ion-refresher slot="fixed" (ionRefresh)="reload($event)">
        <ion-refresher-content />
      </ion-refresher>

      <div class="pad">
        <!-- Clicable: era la cabecera obvia para llegar al perfil y no llevaba
             a ninguna parte. -->
        <ui-card flush class="who" routerLink="/profile">
          <div class="av">{{ initials() }}</div>
          <div class="id">
            <h2>{{ auth.user()?.name }}</h2>
            <p>{{ auth.user()?.email }}</p>
          </div>
          <ui-badge size="sm" tone="neutral">Google</ui-badge>
          <ion-icon class="chev" name="chevron-forward-outline" />
        </ui-card>

        <ui-section title="Conexiones de exchange" />

        <ui-card flush>
          @if (reales().length === 0) {
            <div class="intro">
              <ui-notice tone="info">
                Todavía no has conectado ningún exchange. Se conecta con una API wallet
                <b>sin permiso de retirada</b>: tus fondos no se mueven de tu cuenta.
                <br />
                Para probar no hace falta: tienes una simulación aquí abajo.
              </ui-notice>
            </div>
          }

          @for (a of reales(); track a.id) {
            <div class="conn">
              <ion-icon
                class="ico"
                [class.bad]="!ok(a)"
                [name]="ok(a) ? 'checkmark-circle-outline' : 'alert-circle-outline'"
              />
              <div class="id">
                <h4>{{ venueLabel(a.venue) }} · {{ a.label }}</h4>
                <p class="num">{{ shorten(a.publicRef) }}</p>
                <!-- El saldo real. Hasta ahora esta pantalla listaba conexiones
                     sin decir cuanto dinero habia detras de cada una. -->
                @if (balanceOf(a); as saldo) {
                  <p class="bal num">{{ saldo }}</p>
                }
                <!-- Un cero con explicacion. El venue tiene dos bolsillos y solo
                     uno respalda posiciones: sin esto, «0,00 USDC disponibles»
                     con el dinero dentro del exchange no se puede entender. -->
                @if (spotAviso(a); as aviso) {
                  <p class="avisa">{{ aviso }}</p>
                }
                @if (a.lastError) {
                  <p class="err">{{ a.lastError }}</p>
                } @else if (a.lastVerifiedAt) {
                  <p>Verificada {{ shortDate(a.lastVerifiedAt) }}</p>
                }
                <!-- La firma delegada caduca, y hasta ahora eso no se decia en
                     ninguna parte: el usuario se enteraba cuando su bot ya no
                     colocaba nada. -->
                @if (firma(a); as f) {
                  <p [class.err]="f.grave" [class.avisa]="f.avisa">{{ f.texto }}</p>
                }
              </div>
              @if (a.testnet) {
                <ui-badge size="sm" tone="warn" variant="outline" caps>testnet</ui-badge>
              } @else if (ok(a)) {
                <ui-badge size="sm" tone="up">activa</ui-badge>
              }
            </div>
            <div class="acts">
              <ion-button size="small" fill="clear" (click)="verify(a)">Reverificar</ion-button>
              <ion-button size="small" fill="clear" color="danger" (click)="remove(a)">
                Eliminar
              </ion-button>
            </div>
          }

          <div class="add" routerLink="/accounts/new">
            <ion-icon name="add-outline" />
            <span>Conectar un exchange</span>
          </div>
        </ui-card>

        <!--
          La SIMULACION, en su propio bloque y no mezclada con las conexiones de
          arriba. Son cosas distintas: aquella lista es de credenciales que
          pueden mover dinero, y esto no tiene ninguna. Verlas juntas invitaba a
          confundir un resultado de mentira con uno de verdad, que es
          exactamente lo que no puede pasar en una pantalla de cuentas.
        -->
        @if (simuladas().length) {
          <h3 class="sec">Simulación</h3>
          <ui-card flush>
            <div class="intro">
              <ui-notice tone="info">
                Opera con precios reales de mainnet y dinero de mentira. No necesita claves y no
                puede mandar una orden aunque quisiera. Cada bot tiene su propio saldo, así que
                puedes probar varias estrategias sobre el mismo par a la vez.
              </ui-notice>
            </div>

            @for (a of simuladas(); track a.id) {
              <div class="conn">
                <ion-icon class="ico" name="flask-outline" />
                <div class="id">
                  <h4>{{ venueLabel(a.venue) }} · Simulación</h4>
                  <p>Cada bot empieza con {{ a.paperBalance ?? '10000' }} USDC</p>
                </div>
                <ui-badge size="sm" tone="warn" caps>simulación</ui-badge>
              </div>
              <div class="acts">
                <ion-button size="small" fill="clear" (click)="changePaperBalance(a)">
                  Capital
                </ion-button>
                <ion-button size="small" fill="clear" color="danger" (click)="resetPaper(a)">
                  Reiniciar
                </ion-button>
              </div>
            }
          </ui-card>
        }

        <!--
          La lente de red. Va PEGADA a las conexiones y no en el grupo de
          ajustes de abajo porque es lo que decide que bots, mercados y precios
          se ven, y separarla dejaria un interruptor cuyo efecto no se ve desde
          donde se toca.

          No toca la simulacion: es de mainnet por construccion y sigue estando
          ahi con la lente puesta en testnet. Es lo correcto —lo que se prueba
          es el libro de verdad— y por eso el texto no promete filtrarla.
        -->
        <ui-card flush>
          <ion-item lines="none">
            <ion-toggle
              [checked]="network.testnet()"
              (ionChange)="network.set($any($event.detail).checked)"
            >
              <h4 class="net-t">Ver testnet</h4>
              <p class="net-s">
                Enseña las cuentas, los mercados y los precios de las redes de prueba. No cambia
                dónde opera ningún bot: eso lo decide su cuenta.
              </p>
            </ion-toggle>
          </ion-item>
        </ui-card>

        <ui-card flush>
          <!-- Ranking, que antes era una pestana. Va el PRIMERO del grupo: de
               los cuatro, es el unico que lleva a operar. -->
          <ui-setting-row
            routerLink="/leaderboard"
            icon="trophy-outline"
            title="Ranking"
            subtitle="Bots publicados por la comunidad y copiarlos"
          />
          <ui-setting-row
            routerLink="/risk"
            icon="shield-outline"
            title="Límites de riesgo"
            subtitle="Topes de exposición, apalancamiento y pérdida diaria"
          />
          <ui-setting-row
            routerLink="/telegram"
            icon="paper-plane-outline"
            title="Telegram"
            subtitle="Avisos de riesgo, liquidación y errores"
          >
            @if (telegram.status()?.linked) {
              <ui-badge size="sm" tone="up">activo</ui-badge>
            }
          </ui-setting-row>
        </ui-card>

        <!--
          Administracion. Solo se pinta con rol ADMIN, y es comodidad: la
          autoridad es el guard del servidor, que responde 403 igualmente.
        -->
        <!-- El backtest es de todos (spec 004): reproduce la configuracion de un
             bot simulado sobre velas historicas. -->
        <ui-card flush>
          <ui-setting-row
            routerLink="/backtest"
            icon="flask-outline"
            title="Backtest"
            subtitle="Como habria ido un bot simulado sobre velas historicas"
          />
        </ui-card>

        @if (auth.user()?.role === 'ADMIN') {
          <ui-card flush>
            <!-- La bitacora de actividad (spec 007): que ha pasado y que ha fallado. -->
            <ui-setting-row
              routerLink="/admin/activity"
              icon="pulse-outline"
              title="Actividad"
              subtitle="Que ha pasado en la plataforma y que ha fallado"
            >
              <ui-badge size="sm" tone="neutral">admin</ui-badge>
            </ui-setting-row>
          </ui-card>
        }

        <button class="out" type="button" (click)="signOut()">
          <ion-icon name="log-out-outline" />
          <span>Cerrar sesión</span>
        </button>

        <p class="legal">
          Operar con derivados apalancados puede hacerte perder todo tu capital. CRYPTON es una
          herramienta de automatización, no un asesor financiero.
        </p>
      </div>
    </ion-content>
  `,
  styleUrl: './account.page.scss',
})
export class AccountPage implements OnInit {
  readonly auth = inject(AuthService);
  readonly accounts = inject(ExchangeAccountsService);
  readonly telegram = inject(TelegramService);
  readonly network = inject(NetworkService);
  readonly wallet = inject(WalletService);
  private readonly toast = inject(ToastService);
  private readonly alerts = inject(AlertController);

  readonly shortDate = shortDate;
  readonly dayDate = dayDate;
  readonly venueLabel = venueLabel;

  /** Iniciales para el avatar: dos letras como mucho, siempre algo que pintar. */
  /**
   * Conexiones de verdad: las que pueden mover dinero.
   *
   * Se separan de las de simulacion para que la pantalla no invite a confundir
   * un resultado de mentira con uno de verdad. No se filtran por la lente de
   * red a proposito: la lista dice en que red esta cada una con su distintivo,
   * y esconder las de mainnet bajo la franja de testnet seria peor.
   */
  readonly reales = computed(() => this.accounts.accounts().filter((a) => !a.paper));

  /** Las de simulacion, que no tienen claves y solo pueden simular. */
  readonly simuladas = computed(() => this.accounts.accounts().filter((a) => a.paper));

  readonly initials = computed(() => {
    const name = this.auth.user()?.name?.trim() ?? '';
    if (!name) return '·';
    const parts = name.split(/[\s._-]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  });

  constructor() {
    addIcons({
      addOutline,
      checkmarkCircleOutline,
      alertCircleOutline,
      flaskOutline,
      logOutOutline,
      shieldOutline,
      paperPlaneOutline,
      pulseOutline,
      trophyOutline,
      chevronForwardOutline,
    });

    // ── Por que esta pantalla necesita efectos y no le basta `ngOnInit` ──
    //
    // Cuenta es una PESTAÑA: Ionic la mantiene viva en memoria, asi que
    // `ngOnInit` corre UNA vez en toda la vida de la app. Y `ionViewWillEnter`
    // tampoco sirve de red: al volver de una ruta raiz —«Conectar exchange», sin
    // ir mas lejos— Ionic encuentra `leavingView === enteringView` en el outlet
    // de las pestañas y no emite ningun evento de ciclo de vida. Esta
    // documentado en `markets-list.page.ts`, que ya se choco con lo mismo.
    //
    // La via que si funciona es reaccionar a los DATOS, que es lo que hacen
    // estos dos efectos.

    // 1. Cambio de lente. `WalletService` vacia los saldos al conmutar —un saldo
    //    de mainnet bajo la franja de testnet es justo la confusion que la
    //    franja existe para impedir— pero nadie los volvia a pedir: la pantalla
    //    se quedaba SIN CIFRAS hasta reiniciar la app, y el interruptor que lo
    //    provoca esta en esta misma pantalla.
    //
    //    Va con `force` a proposito. `clear()` vacia tambien el memo, asi que en
    //    el orden bueno no haria falta; pero los dos efectos —el del servicio y
    //    este— escuchan la MISMA señal, y que este corra despues depende de que
    //    `WalletService` se haya instanciado antes, que es cierto hoy por el
    //    orden de los `inject` y no algo que la pantalla pueda garantizar. Si se
    //    invirtiera, el memo seguiria caliente aqui y el vaciado llegaria
    //    despues: saldos en blanco otra vez, y por un motivo invisible.
    let redAnterior: boolean | null = null;
    effect(() => {
      const testnet = this.network.testnet();
      // La primera pasada solo toma nota: `ngOnInit` ya pide los saldos, y
      // `NetworkService` lee su preferencia del disco de forma asincrona, asi
      // que emite una vez al arrancar. Mismo patron que `bots.service.ts`.
      if (redAnterior === null) {
        redAnterior = testnet;
        return;
      }
      if (redAnterior === testnet) return;
      redAnterior = testnet;
      untracked(() => this.loadBalances({ force: true }));
    });

    // 2. Cambio en la lista de conexiones. Al volver de conectar un exchange la
    //    ficha nueva aparecia —el servicio refresca su señal al crearla— pero
    //    SIN saldo, y ya no habia forma de que apareciera. Igual tras eliminar
    //    o reverificar una.
    let firmaAnterior: string | null = null;
    effect(() => {
      // Por ids y no por longitud: eliminar una y añadir otra deja la lista del
      // mismo tamaño con contenido distinto.
      const firma = this.accounts
        .accounts()
        .map((a) => a.id)
        .join('|');
      if (firmaAnterior === null) {
        firmaAnterior = firma;
        return;
      }
      if (firmaAnterior === firma) return;
      firmaAnterior = firma;
      untracked(() => this.loadBalances());
    });
  }

  ngOnInit(): void {
    void this.cargar();
  }

  /**
   * Tirar para refrescar.
   *
   * Fuerza los saldos: el refresco manual es justo lo que se hace cuando la
   * cifra que hay en pantalla parece vieja, y respetar el memo del servicio ahi
   * seria devolver la misma cifra sin haber preguntado.
   */
  async reload(event: CustomEvent): Promise<void> {
    await this.cargar({ force: true });
    void (event.target as HTMLIonRefresherElement).complete();
  }

  /**
   * En paralelo y tolerante a fallos: un error al leer Telegram no debe dejar la
   * pantalla de cuenta en blanco cuando lo que el usuario venia a hacer era
   * revisar sus conexiones.
   */
  private async cargar(opts: { force?: boolean } = {}): Promise<void> {
    await Promise.allSettled([
      this.accounts.refresh().then(() => this.loadBalances(opts)),
      this.telegram.refresh(),
    ]);
  }

  /**
   * El saldo de cada conexion, una peticion por cuenta.
   *
   * Se pide DESPUES de tener la lista y solo para las operativas: cada llamada
   * descifra una clave de firma en el servidor, asi que preguntarlo por una
   * credencial revocada seria gastar esa operacion para nada. Los fallos no se
   * propagan —`load()` no lanza—: una cuenta cuyo venue no responde se sigue
   * listando, solo que sin cifras.
   */
  private loadBalances(opts: { force?: boolean } = {}): void {
    for (const a of this.accounts.accounts()) {
      // Las de simulacion tambien: su saldo es el del simulador y sale de la
      // base, sin descifrar nada ni salir a la red.
      if (this.ok(a)) void this.wallet.load(a.id, undefined, opts);
    }
  }

  /** Saldo disponible de una conexion, ya formateado. '' = no hay nada que decir. */
  balanceOf(a: ExchangeAccount): string {
    const snapshot = this.wallet.of(a.id);
    if (!snapshot || snapshot.unavailable || snapshot.available === null) return '';
    return `${money(snapshot.available)} ${snapshot.asset} disponibles`;
  }

  /**
   * El dinero que hay en el otro bolsillo del venue, si explica un cero.
   *
   * Solo sale cuando el saldo operable es cero y el venue ha dicho que hay algo
   * en spot: es la respuesta a «he depositado y la app me dice que no tengo
   * nada» (spec 028).
   */
  spotAviso(a: ExchangeAccount): string {
    const snapshot = this.wallet.of(a.id);
    if (!snapshot?.spot || snapshot.spot === '0') return '';
    return (
      `Tienes ${money(snapshot.spot)} ${snapshot.asset} en la cuenta de spot, que no respalda ` +
      'posiciones: transfierelos a perpetuos en el exchange para que los bots puedan operar.'
    );
  }

  ok(a: ExchangeAccount): boolean {
    return a.status === 'VERIFIED' || a.status === 'ACTIVE';
  }

  /**
   * Que decir de la firma delegada de esta conexion.
   *
   * `null` cuando no caduca —Aster y Lighter, y la simulacion— para no dejar un
   * hueco vacio en su ficha. Cuando caduca se dice siempre la fecha, y cuando
   * queda poco se explica QUE pasa: es la pregunta que hizo el usuario que
   * motivo el spec 028 («la api expira en 180 dias, que pasa luego, pierdo el
   * dinero?»). No se pierde: lo que se pierde es la capacidad de operar.
   */
  firma(a: ExchangeAccount): { texto: string; avisa: boolean; grave: boolean } | null {
    if (!a.agentValidUntil) return null;
    const vence = new Date(a.agentValidUntil).getTime();
    if (!Number.isFinite(vence)) return null;

    const dias = Math.floor((vence - Date.now()) / 86_400_000);
    if (dias < 0) {
      return {
        texto:
          `La API wallet caduco el ${dayDate(a.agentValidUntil)}: el exchange ya no acepta su ` +
          'firma, asi que los bots no pueden colocar ni cancelar. Tus fondos siguen en tu cuenta. ' +
          'Autoriza una API wallet nueva en el exchange y actualiza la credencial.',
        avisa: false,
        grave: true,
      };
    }
    if (dias <= AVISO_CADUCIDAD_DIAS) {
      return {
        texto:
          `La API wallet caduca el ${dayDate(a.agentValidUntil)} (en ${dias} d). Cuando venza, los ` +
          'bots dejaran de poder colocar y cancelar y las posiciones abiertas se quedaran sin ' +
          'vigilancia; el dinero no se mueve. Autoriza una nueva en el exchange y actualiza la ' +
          'credencial.',
        avisa: true,
        grave: false,
      };
    }
    return {
      texto: `API wallet valida hasta el ${dayDate(a.agentValidUntil)}`,
      avisa: false,
      grave: false,
    };
  }

  /** La referencia pública es larga: se muestra recortada por el centro. */
  shorten(ref: string): string {
    return ref.length > 16 ? `${ref.slice(0, 8)}…${ref.slice(-6)}` : ref;
  }

  async verify(a: ExchangeAccount): Promise<void> {
    try {
      const updated = await this.accounts.verify(a.id);
      await (this.ok(updated)
        ? this.toast.success('Credencial verificada.')
        : this.toast.error(updated.lastError ?? 'No se pudo verificar.'));
    } catch (e) {
      await this.toast.error(errorText(e));
    }
  }

  /** Cambia el capital de partida. Reinicia la simulacion, y se avisa de ello. */
  async changePaperBalance(a: ExchangeAccount): Promise<void> {
    const alert = await this.alerts.create({
      header: 'Capital por bot',
      message:
        'Con cuánto dinero de mentira arranca CADA bot simulado de esta conexión. ' +
        'Cambiarlo los reinicia todos: saldo, posiciones y órdenes vuelven a cero.',
      inputs: [
        {
          name: 'balance',
          type: 'number',
          value: a.paperBalance ?? '10000',
          min: 1,
          placeholder: '10000',
        },
      ],
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        {
          text: 'Guardar',
          handler: (data: { balance?: string }) => {
            const valor = String(data.balance ?? '').trim();
            if (!valor || Number(valor) <= 0) return false;
            void (async () => {
              try {
                await this.accounts.setPaperBalance(a.id, valor);
                // Forzado: el saldo memorizado es el de antes del reinicio, y
                // sin esto la tarjeta seguiria enseñandolo diez segundos.
                this.wallet.clear();
                this.loadBalances({ force: true });
                await this.toast.success('Simulación reiniciada con el capital nuevo.');
              } catch (e) {
                await this.toast.error(errorText(e));
              }
            })();
            return true;
          },
        },
      ],
    });
    await alert.present();
  }

  async resetPaper(a: ExchangeAccount): Promise<void> {
    const alert = await this.alerts.create({
      header: 'Reiniciar simulación',
      message:
        'Cada bot simulado de esta conexión vuelve a su capital de partida y se le borran las ' +
        'posiciones y las órdenes. El histórico de tus bots no se toca. Si tienes bots usándola, ' +
        'para primero.',
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        {
          text: 'Reiniciar',
          role: 'destructive',
          handler: () => {
            void (async () => {
              try {
                await this.accounts.resetPaper(a.id);
                this.wallet.clear();
                this.loadBalances({ force: true });
                await this.toast.success('Simulación reiniciada.');
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

  async remove(a: ExchangeAccount): Promise<void> {
    const alert = await this.alerts.create({
      header: 'Eliminar conexión',
      message:
        'Se borra la credencial cifrada. Tus fondos y tus posiciones en el exchange no se tocan. Si tienes bots usandola, para primero.',
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        {
          text: 'Eliminar',
          role: 'destructive',
          handler: () => {
            void (async () => {
              try {
                await this.accounts.remove(a.id);
                await this.toast.success('Conexión eliminada.');
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

  async signOut(): Promise<void> {
    await this.auth.signOut();
  }
}
