import { SetMetadata } from '@nestjs/common';
import { AUDIT_METADATA, type AuditOptions } from './audit.types';

/**
 * Declara que un endpoint se registra en la bitácora, y QUÉ se registra de él.
 *
 * ```ts
 * @Audit('exchange_account.create', { fields: ['venue', 'label'], critical: true })
 * ```
 *
 * Sin este decorador el endpoint sigue registrándose —ruta, método, estado,
 * duración, usuario e IP—, pero **no se guarda ni un campo del cuerpo**. Ese es
 * el valor por defecto y es deliberado: en `POST /exchange-accounts` el cuerpo
 * lleva la clave privada que firma las órdenes, y el README dice que esa clave
 * no puede acabar «ni en un log».
 *
 * Por eso `fields` es una lista BLANCA. Con una lista negra, añadir mañana un
 * campo sensible a un DTO lo filtraría en silencio hasta que alguien mirara la
 * tabla; con lista blanca, el campo nuevo simplemente no aparece.
 */
export const Audit = (action: string, options: AuditOptions = {}) =>
  SetMetadata(AUDIT_METADATA, { action, ...options });
