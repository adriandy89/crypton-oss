import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AiMode } from '@crypton/db';
import { ActorKind, AuditOutcome, EventSeverity } from '@crypton/shared';
import { AuditService, IdParamDto } from 'src/libs';
import { GetUserInfo, JwtAuthGuard, Roles, RolesGuard, type SessionUser } from '../auth';
import { SupervisorPolicyService } from '../supervisor/supervisor.policy.service';
import { SupervisorService } from '../supervisor/supervisor.service';
import { SetAiModeDto } from '../supervisor/dtos';

/**
 * El Modo IA de un bot. SOLO ADMIN, y solo sobre bots PROPIOS.
 *
 * Vive en `admin/` y no en `bots/` porque encender un agente que reescribe la
 * configuracion de un bot con dinero dentro es una accion de administracion, y
 * se audita como tal. Pero OJO con lo que no es: esto **no amplia lo que un
 * administrador puede hacer sobre bots ajenos**. `SupervisorPolicyService`
 * rechaza cualquier bot que no sea suyo, de modo que la frase del spec 033
 * —mirar y contener, nunca disponer del dinero de nadie— sigue siendo cierta
 * palabra por palabra.
 *
 * Los guards y el `@Roles` van a nivel de CLASE a proposito, como en el resto de
 * la consola: `RolesGuard` deja pasar cuando NO hay metadata, asi que un metodo
 * nuevo sin decorar naceria abierto a cualquier usuario autenticado.
 *
 * OJO AL PREFIJO. Es `admin` y no `admin/bots` (spec 053): el resumen de la app
 * no puede colgar de `admin/bots/ai`, porque `AdminBotsController` registra
 * antes `GET admin/bots/:id`, que se lo quedaria y responderia 400 por no ser
 * un UUID. Las dos rutas de un bot conservan su URL de siempre; lo comprueba
 * `admin-ai.routes.spec.ts`.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminAiController {
  constructor(
    private readonly policy: SupervisorPolicyService,
    private readonly supervisor: SupervisorService,
    private readonly audit: AuditService,
  ) {}

  /**
   * El Modo IA de los bots del administrador que llama, en una sola respuesta.
   *
   * Lo que pinta la pastilla de la lista de bots y lo que el asistente necesita
   * para ofrecer el modo al crear. Con los interruptores del servidor, para que
   * la app no enseñe un modo que hoy no hace nada, y con las estrategias que
   * cubre, para que no tenga una copia propia que se desincronice.
   */
  @Get('ai')
  @ApiOperation({ summary: 'Modo IA de los bots propios, interruptores y alcance (solo ADMIN)' })
  async resumen(@GetUserInfo() admin: SessionUser) {
    return {
      interruptores: await this.interruptoresPara(admin.id),
      estrategias: this.policy.estrategias(),
      bots: await this.policy.encendidosDe(admin.id),
    };
  }

  @Get('bots/:id/ai')
  @ApiOperation({ summary: 'Modo IA de un bot propio (solo ADMIN)' })
  async get(@GetUserInfo() admin: SessionUser, @Param() { id }: IdParamDto) {
    // Con los interruptores: el panel del bot no puede depender de que el
    // resumen de la lista haya llegado para decir la verdad.
    const ajuste = await this.policy.get(admin.id, id);
    return { ...ajuste, interruptores: await this.interruptoresPara(admin.id) };
  }

  /**
   * Los interruptores del servidor, más si a ESTE administrador le llegarían las
   * sugerencias (spec 055, 053/H-03).
   *
   * Sin canal, el supervisor no revisa un bot en «propone y espera», y la
   * pastilla tiene que poder decirlo. Va aquí y no en cada bot porque es del
   * dueño, y los bots del Modo IA son siempre del administrador que pregunta.
   */
  private async interruptoresPara(adminId: string) {
    return {
      ...this.supervisor.interruptores(),
      sinCanal: await this.policy.sinCanalDe(adminId),
    };
  }

  @Put('bots/:id/ai')
  @ApiOperation({
    summary: 'Enciende, apaga o reconfigura el Modo IA de un bot propio (solo ADMIN)',
    description:
      'Solo sobre bots del propio administrador. Sobre un bot ajeno responde 403: ' +
      'la consola de administración mira y contiene, no opera por nadie (spec 033).',
  })
  async set(
    @GetUserInfo() admin: SessionUser,
    @Param() { id }: IdParamDto,
    @Body() dto: SetAiModeDto,
  ) {
    const fila = await this.policy.set(admin.id, id, dto);

    // `recordNow` y no `@Audit`, como en `admin-bots.service.ts`: el motivo
    // entra en `meta` y la lista blanca del decorador no lo deja pasar. Severidad
    // WARN, la misma que la contencion: encender un agente autonomo sobre un bot
    // con dinero dentro es de las cosas que uno quiere encontrar en la bitacora.
    await this.audit.recordNow({
      actor: ActorKind.ADMIN,
      actorId: admin.id,
      botId: id,
      action: dto.mode === AiMode.OFF ? 'admin.bot.ai_disable' : 'admin.bot.ai_enable',
      severity: EventSeverity.WARN,
      outcome: AuditOutcome.OK,
      message: `Modo IA ${dto.mode}: ${dto.reason}`,
      // Con las opciones: desde el spec 053 la app las cambia, y una fila que
      // solo dice «AUTO» no explica por que el bot dejo de recolocar órdenes.
      meta: {
        mode: dto.mode,
        trigger: dto.trigger,
        reviewEveryMinutes: dto.reviewEveryMinutes,
        allowWarm: dto.allowWarm,
        reason: dto.reason,
      },
    });

    return fila;
  }
}
