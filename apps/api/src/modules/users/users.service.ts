import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { DbService } from 'src/libs';
import { UpdateProfileDto } from './dtos';

/**
 * Perfil de usuario.
 *
 * Es PRIVADO: no existe ningún endpoint que devuelva el perfil de otra persona,
 * y ninguno de estos campos aparece en el ranking. Se guardan porque son útiles
 * para la propia cuenta —la zona horaria fecha los avisos, el idioma decide la
 * interfaz—, no para enseñárselos a nadie.
 *
 * Todos los campos son opcionales a propósito: pedir datos que no hacen falta
 * es recoger datos que después hay que proteger.
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly db: DbService) {}

  /**
   * Perfil completo, leído de la base de datos.
   *
   * `GET /auth/me` devuelve los claims del token sin consultar nada, que es lo
   * correcto para autorizar en cada petición. Pero eso significa que tras editar
   * el perfil los claims siguen siendo los viejos hasta que caduque el token,
   * así que la pantalla de perfil necesita una lectura de verdad.
   */
  async me(userId: string) {
    const user = await this.db.user.findUniqueOrThrow({
      where: { id: userId },
    });
    return this.toPublic(user);
  }

  async update(userId: string, dto: UpdateProfileDto) {
    const user = await this.db.user.update({
      where: { id: userId },
      // Spread condicional campo a campo: en un PATCH, `undefined` significa
      // «no lo toques» y cadena vacía significa «bórralo». Un `...dto` los
      // confundiría y borraría lo que el usuario no ha tocado.
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.bio !== undefined ? { bio: dto.bio.trim() || null } : {}),
        ...(dto.country !== undefined ? { country: dto.country.toUpperCase() || null } : {}),
        ...(dto.timezone !== undefined ? { timezone: dto.timezone || null } : {}),
        ...(dto.displayCurrency !== undefined
          ? { display_currency: dto.displayCurrency || null }
          : {}),
        ...(dto.language !== undefined ? { language: dto.language } : {}),
      },
    });

    return this.toPublic(user);
  }

  /**
   * Borra la cuenta y todo lo suyo.
   *
   * SE NIEGA mientras queden bots vivos, y no es burocracia: las órdenes de un
   * bot están en el venue, no en nuestra base, y la cascada del borrado se
   * lleva también la credencial — después ya no existe NINGUNA forma de
   * cancelarlas desde aquí. La versión anterior marcaba los bots como STOPPING
   * y borraba al usuario en la línea siguiente: la cascada eliminaba los bots
   * antes de que ningún worker llegara a cerrarlos, y las órdenes quedaban
   * vivas para siempre con dinero comprometido y sin clave para tocarlas.
   *
   * El camino correcto es el kill-switch (que cancela y cierra de verdad, y es
   * un endpoint que ya existe) y borrar cuando todo esté parado.
   */
  async remove(userId: string): Promise<{ deleted: true }> {
    const alive = await this.db.bot.count({
      where: {
        user_id: userId,
        status: { in: ['STARTING', 'RUNNING', 'PAUSED', 'STOPPING'] },
      },
    });
    if (alive > 0) {
      throw new ConflictException(
        `Tienes ${alive} bot(s) con órdenes o posición en el venue. ` +
          'Usa el kill-switch (o páralos uno a uno) y vuelve a intentarlo: ' +
          'borrar la cuenta ahora dejaría esas órdenes vivas sin forma de cancelarlas.',
      );
    }

    // La cascada del esquema se lleva credenciales, bots, límites, vinculación
    // de Telegram, suscripciones y publicaciones.
    await this.db.user.delete({ where: { id: userId } });
    this.logger.log(`Cuenta ${userId} eliminada.`);
    return { deleted: true };
  }

  /**
   * Proyección pública, campo a campo.
   *
   * A mano y no con `class-transformer`, igual que en las credenciales de
   * exchange: el tipo del parámetro enumera lo que sale, así que añadir una
   * columna sensible al modelo no puede filtrarla por descuido. `google_sub`
   * no está en la lista: identifica la cuenta ante Google y ninguna pantalla
   * lo necesita.
   */
  private toPublic(user: {
    id: string;
    email: string;
    name: string;
    bio: string | null;
    country: string | null;
    timezone: string | null;
    display_currency: string | null;
    language: string;
    role: string;
    created_at: Date;
    last_login_at: Date | null;
  }) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      bio: user.bio,
      country: user.country,
      timezone: user.timezone,
      displayCurrency: user.display_currency,
      language: user.language,
      role: user.role,
      createdAt: user.created_at,
      lastLoginAt: user.last_login_at,
    };
  }
}
