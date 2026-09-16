import { Role } from '@crypton/db';
import type { BusMessage } from 'src/libs';
import { SupervisorScheduler } from './supervisor.scheduler';

/**
 * Cuando un EVENTO adelanta una revision (spec 053, H-02).
 *
 * `SupervisorPolicyService` promete hacer cumplir en tres sitios que el Modo IA
 * solo actua sobre bots de un administrador: al activar, al barrer y al aplicar.
 * El barrido lo exigia en su consulta; la revision que dispara un evento no. Asi,
 * a quien le quitaban el rol —o le deshabilitaban la cuenta— el supervisor le
 * seguia revisando el bot, y en AUTO cambiandoselo, cada vez que cerraba un
 * ciclo o saltaba una guarda.
 *
 * La base se simula con un `findFirst` que EVALUA el filtro del dueño, no con
 * uno que devuelve siempre lo mismo: lo que se prueba es que el filtro existe y
 * que deja fuera a quien debe, no la forma de una llamada.
 */

interface Fila {
  bot_id: string;
  mode: string;
  trigger: string;
  paused_until: Date | null;
  bot: { id: string; user_id: string; status: string };
  dueno: { role: string; disabled: boolean };
}

interface FiltroDelDueno {
  bot_id?: string;
  bot?: { user?: { role?: string; disabled?: boolean } };
}

const fila = (extra: Partial<Fila> = {}): Fila => ({
  bot_id: 'bot-1',
  mode: 'AUTO',
  trigger: 'AMBOS',
  paused_until: null,
  bot: { id: 'bot-1', user_id: 'admin-1', status: 'RUNNING' },
  dueno: { role: Role.ADMIN, disabled: false },
  ...extra,
});

/** Lo que la fila devolveria con el `include` del planificador: sin el dueño. */
const sinDueno = ({ dueno: _dueno, ...resto }: Fila) => resto;

function build(filas: Fila[]) {
  const cumple = (f: Fila, where: FiltroDelDueno) => {
    if (where.bot_id !== undefined && f.bot_id !== where.bot_id) return false;
    const u = where.bot?.user;
    if (u?.role !== undefined && f.dueno.role !== u.role) return false;
    if (u?.disabled !== undefined && f.dueno.disabled !== u.disabled) return false;
    return true;
  };
  const botAiSetting = {
    findFirst: jest.fn(({ where }: { where: FiltroDelDueno }) => {
      const f = filas.find((x) => cumple(x, where));
      return Promise.resolve(f ? sinDueno(f) : null);
    }),
    // Sin filtro de ningun tipo: es lo que hacia el planificador antes del
    // arreglo, y por eso el test de la frontera tiene que fallar con el.
    findUnique: jest.fn(({ where }: { where: { bot_id: string } }) => {
      const f = filas.find((x) => x.bot_id === where.bot_id);
      return Promise.resolve(f ? sinDueno(f) : null);
    }),
  };
  const db = { botAiSetting };
  const supervisor = {
    revisarBot: jest.fn().mockResolvedValue(null),
    canjearVale: jest.fn().mockResolvedValue(undefined),
  };
  const scheduler = new SupervisorScheduler(
    db as never,
    {} as never,
    {} as never,
    { get: () => undefined } as never,
    {} as never,
    supervisor as never,
  );
  // `onEvento` es privado: se llama directamente para poder ESPERARLO. Por la
  // suscripcion del bus iria envuelto en un `void`, y el test tendria que
  // adivinar cuantas vueltas del bucle de eventos hacen falta.
  const onEvento = (mensaje: Partial<BusMessage>) =>
    (scheduler as unknown as { onEvento(m: Partial<BusMessage>): Promise<void> }).onEvento(mensaje);
  return { onEvento, botAiSetting, supervisor };
}

const evento = (type: string, severity = 'INFO'): Partial<BusMessage> => ({
  userId: 'admin-1',
  botId: 'bot-1',
  type,
  data: { severity },
  ts: 0,
});

describe('SupervisorScheduler — la frontera del spec 046 tambien por eventos (spec 053, H-02)', () => {
  it('revisa el bot de un administrador cuando cierra un ciclo', async () => {
    const { onEvento, supervisor } = build([fila()]);
    await onEvento(evento('CYCLE_CLOSED'));
    expect(supervisor.revisarBot).toHaveBeenCalledTimes(1);
    expect(supervisor.revisarBot.mock.calls[0][2]).toBe('OPERACION');
  });

  it('NO revisa el bot de quien ya no es administrador', async () => {
    const { onEvento, supervisor } = build([fila({ dueno: { role: Role.USER, disabled: false } })]);
    await onEvento(evento('CYCLE_CLOSED'));
    expect(supervisor.revisarBot).not.toHaveBeenCalled();
  });

  it('NO revisa el bot de una cuenta deshabilitada', async () => {
    const { onEvento, supervisor } = build([fila({ dueno: { role: Role.ADMIN, disabled: true } })]);
    await onEvento(evento('RISK_GUARD_TRIPPED', 'CRITICAL'));
    expect(supervisor.revisarBot).not.toHaveBeenCalled();
  });

  it('la consulta lleva el mismo filtro del dueño que el barrido', async () => {
    const { onEvento, botAiSetting } = build([fila()]);
    await onEvento(evento('LIQUIDATION_NEAR', 'CRITICAL'));
    expect(botAiSetting.findFirst).toHaveBeenCalledTimes(1);
    const where = botAiSetting.findFirst.mock.calls[0][0].where;
    expect(where.bot_id).toBe('bot-1');
    expect(where.bot?.user).toEqual({ role: Role.ADMIN, disabled: false });
  });

  it('un aviso de riesgo revisa con el motivo RIESGO', async () => {
    const { onEvento, supervisor } = build([fila()]);
    await onEvento(evento('INSUFFICIENT_FUNDS', 'ERROR'));
    expect(supervisor.revisarBot.mock.calls[0][2]).toBe('RIESGO');
  });
});

describe('SupervisorScheduler — lo que un evento NO adelanta', () => {
  it('un FILL no dispara nada, ni siquiera una consulta', async () => {
    const { onEvento, botAiSetting, supervisor } = build([fila()]);
    await onEvento(evento('FILL'));
    expect(botAiSetting.findFirst).not.toHaveBeenCalled();
    expect(botAiSetting.findUnique).not.toHaveBeenCalled();
    expect(supervisor.revisarBot).not.toHaveBeenCalled();
  });

  it('un rechazo de orden en INFO tampoco: es la conducta normal de un market maker', async () => {
    const { onEvento, supervisor } = build([fila()]);
    await onEvento(evento('ORDER_REJECTED', 'INFO'));
    expect(supervisor.revisarBot).not.toHaveBeenCalled();
  });

  it('el cambio de modo (AI_MODE) no se revisa a si mismo', async () => {
    const { onEvento, supervisor } = build([fila()]);
    await onEvento(evento('AI_MODE'));
    expect(supervisor.revisarBot).not.toHaveBeenCalled();
  });

  it('quien pidio solo revisiones periodicas no recibe una por evento', async () => {
    const { onEvento, supervisor } = build([fila({ trigger: 'PERIODICO' })]);
    await onEvento(evento('CYCLE_CLOSED'));
    expect(supervisor.revisarBot).not.toHaveBeenCalled();
  });

  it('con el modo apagado no se revisa', async () => {
    const { onEvento, supervisor } = build([fila({ mode: 'OFF' })]);
    await onEvento(evento('CYCLE_CLOSED'));
    expect(supervisor.revisarBot).not.toHaveBeenCalled();
  });

  it('dormido por fallos no se revisa hasta que venza', async () => {
    const manana = new Date(Date.now() + 86_400_000);
    const { onEvento, supervisor } = build([fila({ paused_until: manana })]);
    await onEvento(evento('CYCLE_CLOSED'));
    expect(supervisor.revisarBot).not.toHaveBeenCalled();
  });
});
