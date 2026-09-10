import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActorKind, AuditOutcome, EventSeverity } from '@crypton/shared';
import {
  AuditService,
  BUS_CHANNELS,
  BusService,
  CacheService,
  CacheUnavailableError,
} from 'src/libs';
import { ttlToSeconds } from './ttl';

const revokedKey = (userId: string) => `auth:revoked:${userId}`;

/**
 * Margen sobre el TTL del access token, en segundos.
 *
 * El token vivo mas antiguo que la marca tiene que cubrir caduca dentro de
 * `accessTtl`. El minuto de mas cubre el desfase de reloj entre la instancia que
 * firma y la que comprueba: `jsonwebtoken` va aqui con tolerancia cero.
 */
const MARGEN_RELOJ_SEG = 60;

/** Cada cuantas lecturas buenas se poda el mapa en memoria. */
const PODA_CADA = 500;

/**
 * Por que se corto la sesion. Cerrado a proposito: una cadena libre acaba
 * siendo un registro ilegible.
 */
export type MotivoRevocacion =
  'cuenta_deshabilitada' | 'sesiones_cerradas' | 'rol_cambiado' | 'claims_obsoletos';

/**
 * Resultado explicito, porque la escritura PUEDE fallar y quien la pide tiene
 * que enterarse: «deshabilitado en la base de datos, pero su sesion en curso
 * caducara sola en menos de quince minutos» es una respuesta muy distinta de
 * «hecho», y un administrador necesita saber cual de las dos le ha tocado.
 */
export interface RevocationResult {
  aplicada: boolean;
  /**
   * Hasta cuando puede seguir valiendo un token del usuario.
   *
   * Se rellena SIEMPRE, y ahi esta la gracia: cuando la revocacion se aplico, es
   * hasta cuando vive la marca; cuando NO se aplico, es hasta cuando puede
   * sobrevivir el ultimo token emitido — que es justo el dato que necesita quien
   * acaba de deshabilitar una cuenta y tiene que saber cuanto rato le queda de
   * acceso al que estaba dentro.
   *
   * Devolvia `null` en el caso fallido, que era el unico en el que hacia falta.
   */
  vigenteHasta: Date;
}

interface Recuerdo {
  /** Marca de revocacion en epoch ms, o `null` si no habia. */
  marca: number | null;
  leidoEn: number;
}

/**
 * Corta el acceso de un usuario ANTES de que caduque su access token.
 *
 * El problema: los claims viajan firmados dentro del token y `JwtStrategy` no
 * consulta la base de datos, asi que deshabilitar a alguien no le impedia nada
 * durante los quince minutos siguientes. Para una plataforma donde una cuenta se
 * deshabilita justo cuando se sospecha que esta comprometida, eso convertia
 * «deshabilitar» en una etiqueta.
 *
 * El mecanismo: una marca por usuario, `auth:revoked:<id>` con el instante de la
 * revocacion, comparada contra el `iat` del token. Una sola clave por usuario
 * revocado, con TTL, que no crece; ninguna escritura al emitir tokens; y ningun
 * cambio en lo que se firma, porque `iat` ya estaba.
 */
@Injectable()
export class SessionRevocationService {
  private readonly logger = new Logger(SessionRevocationService.name);
  private readonly accessTtlSec: number;
  private readonly failOpen: boolean;
  private readonly staleMaxMs: number;

  /** Ultima lectura buena por usuario. Ver `sinRedis`. */
  private readonly memoria = new Map<string, Recuerdo>();
  private lecturas = 0;

  /** Estado de la degradacion, para hacer ruido una vez y no por peticion. */
  private degradadaDesde: number | null = null;
  private degradadas = 0;

  constructor(
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly bus: BusService,
    config: ConfigService,
  ) {
    this.accessTtlSec = ttlToSeconds(config.get<string>('JWT_ACCESS_TTL', '15m'));

    // Comparacion contra 'false', NO contra 'true' como `AUDIT_LOG_ENABLE`, y la
    // polaridad invertida es deliberada: alli un valor mal escrito debe dejar la
    // bitacora apagada; aqui un valor mal escrito no puede tumbar la API entera.
    this.failOpen = config.get('AUTH_REVOCATION_FAIL_OPEN') !== 'false';
    this.staleMaxMs = Number(config.get('AUTH_REVOCATION_STALE_MAX_MS', 60_000));

    if (!this.failOpen) {
      this.logger.warn(
        'AUTH_REVOCATION_FAIL_OPEN=false: con Redis caido se rechazara toda peticion autenticada.',
      );
    }
  }

  /**
   * Invalida TODOS los access token del usuario emitidos hasta ahora.
   *
   * NO toca las familias de refresh, y esa separacion es el punto fino del
   * diseño: sin matarlas, el 401 que provoca esta marca hace que la app renueve
   * —`AuthService.refresh()` relee la fila y reemite claims frescos— y reintente
   * sola. Es decir, degradar un rol se propaga al instante y de forma
   * transparente. Quien quiera el cierre duro llama a `TokenService.revokeAll()`,
   * que hace las dos cosas.
   */
  async revoke(userId: string, motivo: MotivoRevocacion): Promise<RevocationResult> {
    // Al segundo SIGUIENTE, y aqui esta el detalle que decide si esto sirve de
    // algo. `iat` tiene granularidad de SEGUNDO y la marca de milisegundo: un
    // token firmado en T.100 y una revocacion en T.500 comparten el mismo `iat`,
    // que es T. Redondeando hacia arriba, el segundo T entero cuenta como
    // revocado y ese token muere, que es lo que tiene que pasar.
    //
    // El precio es que tambien muere un token emitido en T.800, o sea DESPUES de
    // la revocacion: quien acabase de entrar en ese mismo segundo tendria que
    // volver a entrar. Es un caso que no se da —un inicio de sesion es una vuelta
    // completa por Google— y su remedio es identificarse otra vez.
    //
    // Redondear hacia abajo seria el intercambio contrario: dejaria vivo hasta un
    // segundo entero de tokens anteriores a la revocacion. Eso es justo lo que
    // esta clase existe para impedir.
    const marca = (Math.floor(Date.now() / 1000) + 1) * 1000;
    const ttl = this.accessTtlSec + MARGEN_RELOJ_SEG;

    await this.cache.set(revokedKey(userId), marca, ttl);

    // Releer no es paranoia: `CacheService.set` se traga sus errores y devuelve
    // `void`, asi que sin esto no habria forma de distinguir «revocado» de «no
    // se ha escrito nada». Son dos viajes a Redis en una accion que ocurre
    // cuando un administrador pulsa un boton, no en el camino caliente.
    let aplicada = false;
    try {
      aplicada = (await this.cache.getOrThrow<number>(revokedKey(userId))) === marca;
    } catch {
      aplicada = false;
    }

    if (aplicada) {
      this.recordar(userId, marca);
      this.logger.log(`Sesiones de ${userId} cortadas (${motivo}).`);

      // Y se cierra el directo. Una conexion SSE presenta su token al abrirse y
      // despues vive horas, asi que cortarle la API a alguien le dejaba igualmente
      // los fills en pantalla. Va por el bus porque su conexion puede estar
      // colgando de otra instancia; llega tambien a esta, que es lo que se quiere.
      //
      // Best-effort a proposito: la revocacion ya esta escrita y es lo que manda.
      // Que el aviso no salga deja una pantalla actualizandose sin poder tocar
      // nada, que es molesto, no peligroso.
      await this.bus
        .publish(BUS_CHANNELS.AUTH_REVOKED, { userId, type: motivo, data: {} })
        .catch(() => undefined);
    } else {
      // Se avisa aqui ademas de devolverlo: quien llama puede decidir seguir, y
      // el operador tiene que poder encontrarlo despues en el registro.
      this.logger.error(
        `No se pudo cortar la sesion de ${userId} (${motivo}): Redis no responde. ` +
          `Su token de acceso seguira valiendo hasta ${this.accessTtlSec} s.`,
      );
    }

    // Aplicada o no, el horizonte es el mismo: lo que le queda de vida al token
    // vivo mas antiguo, mas el margen de reloj.
    return { aplicada, vigenteHasta: new Date(Date.now() + ttl * 1000) };
  }

  /**
   * Levanta la marca.
   *
   * Lo llama el administrador al REHABILITAR una cuenta: sin esto, el usuario
   * recien rehabilitado no podria usar ni el token que le acaba de dar el login,
   * porque su `iat` seguiria siendo anterior a una marca que sigue viva.
   */
  async clear(userId: string): Promise<void> {
    await this.cache.del(revokedKey(userId));
    // Tambien la memoria: si solo se borrase Redis, este proceso seguiria
    // rechazando al rehabilitado mientras su recuerdo no caducara.
    this.memoria.delete(userId);
  }

  /**
   * Camino caliente: lo llama `JwtStrategy` en cada peticion autenticada.
   *
   * `iatSec` es el `iat` del token, en SEGUNDOS, tal y como viene. Nunca lanza:
   * la politica de que hacer con Redis caido se decide aqui dentro, porque el
   * llamante no esta en posicion de decidirla en cada peticion.
   */
  async isRevoked(userId: string, iatSec: number): Promise<boolean> {
    try {
      const marca = await this.cache.getOrThrow<number>(revokedKey(userId));
      this.recordar(userId, marca);
      this.recuperada();
      return marca !== null && iatSec * 1000 < marca;
    } catch (e) {
      if (!(e instanceof CacheUnavailableError)) {
        // No deberia ocurrir: `getOrThrow` solo lanza lo otro. Pero este metodo
        // promete no lanzar, y una promesa asi no admite excepciones.
        this.logger.error(`Fallo inesperado comprobando la revocacion: ${(e as Error).message}`);
      }
      return this.sinRedis(userId, iatSec);
    }
  }

  /** Si el usuario tiene marca viva y hasta cuando. Para la consola de administracion. */
  async status(userId: string): Promise<{ revocadoEn: Date } | null> {
    const marca = await this.cache.get<number>(revokedKey(userId));
    return marca ? { revocadoEn: new Date(marca) } : null;
  }

  /**
   * Que hacer cuando Redis no contesta.
   *
   * Fail-open ACOTADO, y la decision esta razonada en el spec 033: cerrar la API
   * por un parpadeo de Redis manda a todo el mundo a la pantalla de acceso
   * —`auth.interceptor.ts` lo hace ante un 401 que el refresco no arregla— y
   * deja a quien tiene bots operando sin poder llegar a su kill-switch ni mandar
   * un PANIC. Perder la revocacion de un usuario durante el corte es un riesgo
   * estrictamente menor que ese. Es la decision CONTRARIA a la del lease del
   * worker (invariante 10) y no es una incoherencia: alli cerrar evita duplicar
   * ordenes; aqui cerrar no evita ninguna, las impide.
   *
   * «Acotado» es la parte que importa: a quien ya sabiamos revocado se le sigue
   * negando el paso mientras el recuerdo este fresco, asi que el caso peligroso
   * —cuenta comprometida, cerrada hace un minuto— queda cubierto igual.
   */
  private sinRedis(userId: string, iatSec: number): boolean {
    const rec = this.memoria.get(userId);
    if (rec && Date.now() - rec.leidoEn <= this.staleMaxMs) {
      return rec.marca !== null && iatSec * 1000 < rec.marca;
    }
    this.degradar();
    return !this.failOpen;
  }

  private recordar(userId: string, marca: number | null): void {
    this.memoria.set(userId, { marca, leidoEn: Date.now() });

    // Poda amortizada. El mapa solo puede contener a los usuarios activos de los
    // ultimos minutos, pero sin esto una instancia de larga vida acumularia una
    // entrada por usuario que haya pasado por aqui alguna vez.
    if (++this.lecturas % PODA_CADA !== 0) return;
    const limite = Date.now() - this.staleMaxMs;
    for (const [id, r] of this.memoria) {
      if (r.leidoEn < limite) this.memoria.delete(id);
    }
  }

  /**
   * Ruido una vez por ventana, no por peticion.
   *
   * A cien peticiones por segundo, un `error` por cada una inunda el registro y
   * esconde justo el problema que se quiere ver.
   */
  private degradar(): void {
    this.degradadas++;
    if (this.degradadaDesde !== null) return;
    this.degradadaDesde = Date.now();
    this.logger.error(
      'Redis no responde: las peticiones autenticadas pasan SIN comprobar la revocacion de sesion.',
    );
  }

  private recuperada(): void {
    if (this.degradadaDesde === null) return;
    const ms = Date.now() - this.degradadaDesde;
    const n = this.degradadas;
    this.degradadaDesde = null;
    this.degradadas = 0;

    this.logger.log(`Redis responde de nuevo: ${n} peticiones pasaron sin comprobar en ${ms} ms.`);
    this.audit.record({
      actor: ActorKind.SYSTEM,
      action: 'auth.revocation_degraded',
      severity: EventSeverity.WARN,
      outcome: AuditOutcome.DENIED,
      message: `Redis no respondio durante ${ms} ms: ${n} peticiones autenticadas sin comprobar.`,
      meta: { peticiones: n, duracionMs: ms },
    });
  }
}
