import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonSelect,
  IonSelectOption,
  IonSpinner,
  IonTextarea,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { shieldCheckmarkOutline } from 'ionicons/icons';
import { RouterLink } from '@angular/router';
import { ProfileService, ToastService, type ProfilePatch } from '../../core/services';
import { errorText } from '../../core/utils';

/** Zonas horarias más habituales; el resto se puede escribir a mano. */
const ZONAS = [
  'Europe/Madrid',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Mexico_City',
  'America/Bogota',
  'America/Argentina/Buenos_Aires',
  'America/Santiago',
  'Asia/Tokyo',
  'Asia/Singapore',
  'UTC',
];

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [
    FormsModule,
    RouterLink,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonBackButton,
    IonContent,
    IonList,
    IonItem,
    IonLabel,
    IonInput,
    IonTextarea,
    IonSelect,
    IonSelectOption,
    IonButton,
    IonNote,
    IonSpinner,
    IonIcon,
  ],
  template: `
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start"><ion-back-button defaultHref="/tabs/account" /></ion-buttons>
        <ion-title>Perfil</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content>
      @if (!profile.profile()) {
        <div class="center"><ion-spinner name="crescent" /></div>
      } @else {
        <!-- Avatar por iniciales: no hay subida de ficheros y montar
             almacenamiento de imágenes por una foto no se sostiene. El color
             sale del id, así que es estable y distinto para cada cuenta. -->
        <div class="hero">
          <div class="avatar" [style.background]="avatarColor()">{{ iniciales() }}</div>
          <h2>{{ profile.profile()!.name }}</h2>
          <p class="email">{{ profile.profile()!.email }}</p>
        </div>

        <ion-list inset="true">
          <ion-item>
            <ion-input
              label="Nombre"
              labelPlacement="stacked"
              [ngModel]="borrador().name"
              (ngModelChange)="editar('name', $event)"
              maxlength="128"
            />
          </ion-item>
          <ion-item>
            <ion-textarea
              label="Sobre ti"
              labelPlacement="stacked"
              placeholder="Opcional"
              [ngModel]="borrador().bio"
              (ngModelChange)="editar('bio', $event)"
              [autoGrow]="true"
              maxlength="280"
            />
          </ion-item>
          <ion-item>
            <ion-input
              label="País"
              labelPlacement="stacked"
              placeholder="ES"
              [ngModel]="borrador().country"
              (ngModelChange)="editar('country', $event)"
              maxlength="2"
            />
          </ion-item>
        </ion-list>

        <ion-list inset="true">
          <ion-item>
            <ion-select
              label="Zona horaria"
              labelPlacement="stacked"
              interface="popover"
              [ngModel]="borrador().timezone"
              (ngModelChange)="editar('timezone', $event)"
            >
              @for (z of zonas; track z) {
                <ion-select-option [value]="z">{{ z }}</ion-select-option>
              }
            </ion-select>
          </ion-item>
          <ion-item>
            <ion-select
              label="Moneda de visualización"
              labelPlacement="stacked"
              interface="popover"
              [ngModel]="borrador().displayCurrency"
              (ngModelChange)="editar('displayCurrency', $event)"
            >
              <ion-select-option value="USD">USD</ion-select-option>
              <ion-select-option value="EUR">EUR</ion-select-option>
              <ion-select-option value="GBP">GBP</ion-select-option>
            </ion-select>
          </ion-item>
          <ion-item>
            <ion-select
              label="Idioma"
              labelPlacement="stacked"
              interface="popover"
              [ngModel]="borrador().language"
              (ngModelChange)="editar('language', $event)"
            >
              <ion-select-option value="es">Español</ion-select-option>
              <ion-select-option value="en">English</ion-select-option>
            </ion-select>
          </ion-item>
          <ion-note class="aviso">
            La moneda cambia cómo se muestran los importes, no con qué opera el bot: eso lo decide
            el mercado que elijas.
          </ion-note>
        </ion-list>

        <!-- La seguridad va en su propia pantalla: mezclar «cambiar tu nombre»
             con «borrar la cuenta» en una sola lista invita a tocar por error
             lo que no toca. -->
        <ion-list inset="true">
          <ion-item button routerLink="/security" detail="true">
            <ion-icon slot="start" name="shield-checkmark-outline" />
            <ion-label>
              <h3>Seguridad</h3>
              <p>Acceso, sesiones y borrado de cuenta</p>
            </ion-label>
            <ion-note slot="end" color="success">Google</ion-note>
          </ion-item>
        </ion-list>

        <div class="acciones">
          <ion-button expand="block" [disabled]="!puedeGuardar()" (click)="guardar()">
            @if (guardando()) {
              <ion-spinner name="crescent" />
            } @else {
              Guardar cambios
            }
          </ion-button>
          @if (cambiado() && !nombreValido()) {
            <ion-note class="error">El nombre no puede quedarse vacío.</ion-note>
          }
          @if (cambiado()) {
            <ion-button expand="block" fill="clear" (click)="descartar()">Descartar</ion-button>
          }
        </div>
      }
    </ion-content>
  `,
  styleUrl: './profile.page.scss',
})
export class ProfilePage implements OnInit {
  readonly profile = inject(ProfileService);
  private readonly toast = inject(ToastService);

  readonly zonas = ZONAS;
  readonly guardando = signal(false);

  /**
   * Copia editable. No se toca el perfil cargado hasta que se guarda.
   *
   * Es una SEÑAL, no un objeto suelto: `cambiado()` es un `computed` y solo se
   * recalcula cuando cambia una señal de la que depende. Mutando un objeto
   * plano desde `[(ngModel)]` no se invalidaba nada, así que `cambiado()`
   * devolvía el `false` de la primera lectura para siempre y el botón de
   * guardar se quedaba desactivado hicieras lo que hicieras.
   */
  readonly borrador = signal<ProfilePatch>({});

  /** Escribe un campo del borrador reemplazando el objeto: así la señal notifica. */
  editar<K extends keyof ProfilePatch>(campo: K, valor: ProfilePatch[K]): void {
    this.borrador.update((b) => ({ ...b, [campo]: valor ?? '' }));
  }

  readonly cambiado = computed(() => this.camposCambiados().length > 0);

  /** Nombre obligatorio: el servidor rechaza el vacío con un 400. */
  readonly nombreValido = computed(() => (this.borrador().name ?? '').trim().length > 0);

  readonly puedeGuardar = computed(
    () => this.cambiado() && this.nombreValido() && !this.guardando(),
  );

  /** Qué campos difieren del perfil cargado. Es lo único que se envía. */
  private readonly camposCambiados = computed<(keyof ProfilePatch)[]>(() => {
    const actual = this.profile.profile();
    if (!actual) return [];
    const b = this.borrador();
    const campos: (keyof ProfilePatch)[] = [
      'name',
      'bio',
      'country',
      'timezone',
      'displayCurrency',
      'language',
    ];
    return campos.filter((c) => (b[c] ?? '') !== (actual[c] ?? ''));
  });

  readonly iniciales = computed(() => {
    const nombre = this.profile.profile()?.name?.trim() ?? '';
    const partes = nombre.split(/\s+/).filter(Boolean);
    if (partes.length === 0) return '?';
    if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
    return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
  });

  /**
   * Color derivado del id: estable entre sesiones y distinto por cuenta.
   *
   * El tono se limita al arco cian-violeta (190-300). Con la rueda entera,
   * a una de cada tres cuentas le tocaba un avatar verde o rojo, que en esta
   * app significan beneficio y perdida: identidad y señal financiera no
   * pueden compartir paleta.
   */
  readonly avatarColor = computed(() => {
    const id = this.profile.profile()?.id ?? '';
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
    const hue = 190 + (hash % 110);
    return `linear-gradient(140deg, oklch(0.66 0.15 ${hue}), oklch(0.6 0.16 ${hue + 35}))`;
  });

  constructor() {
    addIcons({ shieldCheckmarkOutline });
  }

  async ngOnInit(): Promise<void> {
    try {
      await this.profile.refresh();
      this.descartar();
    } catch (e) {
      await this.toast.error(errorText(e));
    }
  }

  descartar(): void {
    const actual = this.profile.profile();
    if (!actual) return;
    this.borrador.set({
      name: actual.name,
      bio: actual.bio ?? '',
      country: actual.country ?? '',
      timezone: actual.timezone ?? '',
      displayCurrency: actual.displayCurrency ?? '',
      language: actual.language,
    });
  }

  async guardar(): Promise<void> {
    // Solo los campos tocados: en un PATCH, `undefined` es «no lo toques» y la
    // cadena vacía es «bórralo». Mandar el borrador entero pedía borrar cada
    // campo que el usuario ni había mirado.
    const b = this.borrador();
    const patch: ProfilePatch = {};
    for (const campo of this.camposCambiados()) patch[campo] = b[campo];
    if (Object.keys(patch).length === 0) return;

    this.guardando.set(true);
    try {
      await this.profile.update(patch);
      this.descartar();
      await this.toast.success('Perfil actualizado.');
    } catch (e) {
      await this.toast.error(errorText(e));
    } finally {
      this.guardando.set(false);
    }
  }
}
