import { Injectable, inject } from '@angular/core';
import { ToastController } from '@ionic/angular/standalone';

@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly toasts = inject(ToastController);

  async show(message: string, color: 'success' | 'danger' | 'warning' | 'medium' = 'medium') {
    const toast = await this.toasts.create({
      message,
      color,
      // Los errores duran más: suelen traer el motivo del rechazo del venue y
      // hay que poder leerlos enteros.
      duration: color === 'danger' ? 6000 : 3000,
      position: 'top',
      buttons: [{ text: 'OK', role: 'cancel' }],
    });
    await toast.present();
  }

  error(message: string) {
    return this.show(message, 'danger');
  }
  success(message: string) {
    return this.show(message, 'success');
  }
  warn(message: string) {
    return this.show(message, 'warning');
  }
}
