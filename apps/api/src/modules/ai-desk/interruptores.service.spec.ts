import { ConfigService } from '@nestjs/config';
import { CacheUnavailableError } from 'src/libs';
import { AiDeskConfig } from './ai-desk.config';
import {
  AiDeskInterruptoresService,
  claveCupoGlobalAgentes,
  diaDelCupoAgentes,
} from './interruptores.service';

/**
 * Los interruptores de los agentes (spec 074, R-27). El global de entradas se
 * cierra ante la duda: con Redis caído, «DESCONOCIDO», y la ronda lo trata
 * como cerrado.
 */

const configCon = (valores: Record<string, string>): ConfigService =>
  ({ get: (k: string, def?: string) => valores[k] ?? def }) as unknown as ConfigService;

function montar(valores: Record<string, string> = {}) {
  const guardado = new Map<string, string>();
  let caido = false;
  const cache = {
    getTextoOrThrow: jest.fn(async (k: string) => {
      if (caido) throw new CacheUnavailableError('GET');
      return guardado.get(k) ?? null;
    }),
    get: jest.fn(async (k: string) => {
      const v = guardado.get(k);
      return v === undefined ? null : (JSON.parse(v) as unknown);
    }),
    set: jest.fn(async (k: string, v: unknown) => {
      guardado.set(k, JSON.stringify(v));
    }),
    del: jest.fn(async (ks: string | string[]) => {
      for (const k of Array.isArray(ks) ? ks : [ks]) guardado.delete(k);
    }),
  };
  const modelo = { agentesDisponible: true, agentesModelo: 'x/y' };
  const svc = new AiDeskInterruptoresService(
    cache as never,
    new AiDeskConfig(configCon(valores)),
    modelo as never,
  );
  return { svc, guardado, caer: () => (caido = true) };
}

describe('AiDeskInterruptoresService', () => {
  it('de fábrica: apagado, entradas abiertas y sin frenos', async () => {
    const { svc } = montar();
    await expect(svc.interruptores()).resolves.toEqual({
      encendido: false,
      modeloDisponible: true,
      modelo: 'x/y',
      entradas: 'ABIERTAS',
      motivoEntradas: null,
      frenos: { forzarManual: false, soloSimulacion: false, soloSombra: false },
      limiteAgente: 200,
      limiteGlobal: 600,
      llamadasGlobalesHoy: 0,
    });
  });

  it('lee el entorno: el interruptor, los frenos y los cupos', async () => {
    const { svc } = montar({
      AI_DESK_ENABLE: 'true',
      AI_DESK_FORCE_MANUAL: 'true',
      AI_DESK_SHADOW_ONLY: 'true',
      AI_DESK_DAILY_LIMIT: '50',
      AI_DESK_GLOBAL_DAILY_LIMIT: 'muchas',
    });
    const i = await svc.interruptores();
    expect(i.encendido).toBe(true);
    expect(i.frenos).toEqual({ forzarManual: true, soloSimulacion: false, soloSombra: true });
    expect(i.limiteAgente).toBe(50);
    // Lo que no se entiende deja el de fábrica, nunca cero.
    expect(i.limiteGlobal).toBe(600);
  });

  it('cortar guarda el motivo y lo enseña; abrir borra los dos', async () => {
    const { svc, guardado } = montar();
    const cortadas = await svc.fijarEntradas(false, 'mercado raro');
    expect(cortadas.entradas).toBe('CERRADAS');
    expect(cortadas.motivoEntradas).toBe('mercado raro');
    expect(await svc.entradasAbiertas()).toBe(false);

    const abiertas = await svc.fijarEntradas(true, 'todo en orden');
    expect(abiertas.entradas).toBe('ABIERTAS');
    expect(abiertas.motivoEntradas).toBeNull();
    expect(guardado.size).toBe(0);
  });

  it('con Redis caído: desconocido, y cambiar el interruptor responde 503', async () => {
    const { svc, caer } = montar();
    caer();
    expect(await svc.entradasAbiertas()).toBeNull();
    const i = await svc.interruptores();
    expect(i.entradas).toBe('DESCONOCIDO');
    expect(i.llamadasGlobalesHoy).toBeNull();
    await expect(svc.fijarEntradas(false, 'mercado raro')).rejects.toThrow(/Redis no responde/);
  });

  it('las llamadas globales de hoy salen de su clave del día', async () => {
    const { svc, guardado } = montar();
    guardado.set(claveCupoGlobalAgentes(diaDelCupoAgentes(Date.now())), '17');
    expect((await svc.interruptores()).llamadasGlobalesHoy).toBe(17);
  });

  it('un interruptor cortado a mano, en texto, también corta', async () => {
    const { svc, guardado } = montar();
    guardado.set('crypton:ai-desk:entries', 'OFF');
    expect(await svc.entradasAbiertas()).toBe(false);
    // Sin motivo: nadie lo escribió por la consola.
    expect((await svc.interruptores()).motivoEntradas).toBeNull();
  });
});
