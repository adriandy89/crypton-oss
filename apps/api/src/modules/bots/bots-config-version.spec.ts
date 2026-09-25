import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { BotsController } from './bots.controller';
import { UpdateBotConfigDto } from './dtos';

/**
 * La version sobre la que se edito, tambien por REST (spec 055, 053/H-05).
 *
 * Guardar Ajustes manda la configuracion ENTERA. Sin decir sobre que version se
 * edito, un borrador guardado tarde deshacia en silencio lo que el supervisor
 * de IA aplico entretanto. `updateConfig` ya sabia rechazarlo (spec 052, F-06),
 * pero solo el supervisor podia pedirlo: la ruta no aceptaba el campo.
 *
 * Mismas opciones que el `ValidationPipe` global de `main.ts`.
 */
const errores = (payload: Record<string, unknown>): string[] =>
  validateSync(plainToInstance(UpdateBotConfigDto, payload), {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).map((e) => e.property);

const valido = { config: { buyDistanceBps: 12 } };

describe('UpdateBotConfigDto — la version esperada', () => {
  it('es opcional: sin ella todo sigue como siempre', () => {
    expect(errores(valido)).toEqual([]);
    expect(errores({ ...valido, acceptRelayout: true })).toEqual([]);
  });

  it('si viene, es un entero positivo', () => {
    expect(errores({ ...valido, expectedVersion: 3 })).toEqual([]);
    expect(errores({ ...valido, expectedVersion: 1 })).toEqual([]);
    for (const malo of [0, -1, 2.5, '3', true, {}]) {
      expect(
        `${JSON.stringify(malo)}: ${errores({ ...valido, expectedVersion: malo }).join()}`,
      ).toBe(`${JSON.stringify(malo)}: expectedVersion`);
    }
  });

  it('un null es un error, no «sin version»', () => {
    // `@IsOptional` dejaria pasar el null, y el servicio lo compararia con la
    // version del bot: un 409 que nadie sabria explicar (misma trampa que el
    // 053, H-04).
    expect(errores({ ...valido, expectedVersion: null })).toEqual(['expectedVersion']);
  });
});

describe('BotsController — la operación de un agente no se crea por aquí (spec 074, R-6)', () => {
  it('responde 400 y no llega al servicio', () => {
    const bots = { create: jest.fn() };
    const controller = new BotsController(bots as never, {} as never, {} as never);
    const dto = { strategy: 'AGENT_TRADE', exchangeAccountId: 'a', symbol: 'BTC', config: {} };
    expect(() => controller.create({ id: 'u-1' } as never, dto as never)).toThrow(
      BadRequestException,
    );
    expect(bots.create).not.toHaveBeenCalled();
  });

  it('cualquier otra estrategia pasa al servicio', () => {
    const bots = { create: jest.fn().mockResolvedValue({ id: 'b-1' }) };
    const controller = new BotsController(bots as never, {} as never, {} as never);
    const dto = { strategy: 'GRID_CLASSIC', exchangeAccountId: 'a', symbol: 'BTC', config: {} };
    void controller.create({ id: 'u-1' } as never, dto as never);
    expect(bots.create).toHaveBeenCalledWith('u-1', dto);
  });
});

describe('BotsController — la version llega al servicio', () => {
  const usuario = { id: 'u-1' } as never;
  const ID = { id: '9f2c4f7e-7a3b-4c1d-8e2f-0a1b2c3d4e5f' };

  function build() {
    const bots = { updateConfig: jest.fn().mockResolvedValue({ applied: true, version: 4 }) };
    const controller = new BotsController(bots as never, {} as never, {} as never);
    return { bots, controller };
  }

  it('con version, se pide que el bot siga en ella', async () => {
    const { bots, controller } = build();
    const dto = Object.assign(new UpdateBotConfigDto(), { ...valido, expectedVersion: 3 });
    await controller.updateConfig(usuario, ID, dto);
    expect(bots.updateConfig).toHaveBeenCalledWith('u-1', ID.id, dto, { expectedVersion: 3 });
  });

  it('sin version, no se pide nada', async () => {
    const { bots, controller } = build();
    const dto = Object.assign(new UpdateBotConfigDto(), valido);
    await controller.updateConfig(usuario, ID, dto);
    expect(bots.updateConfig).toHaveBeenCalledWith('u-1', ID.id, dto, {
      expectedVersion: undefined,
    });
  });
});
