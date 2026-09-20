import { Logger } from '@nestjs/common';
import { Venue } from '@crypton/shared';
import { anotarCola, anotarConcesion, claveCaudal, reiniciarCaudal } from '@crypton/exchange-core';
import { CaudalMonitorService } from './caudal-monitor.service';

const HL_READ = claveCaudal(Venue.HYPERLIQUID, false, 'read');

describe('CaudalMonitorService (spec 065)', () => {
  let avisos: string[];
  let depuracion: string[];

  beforeEach(() => {
    reiniciarCaudal();
    avisos = [];
    depuracion = [];
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((m) => avisos.push(String(m)));
    jest.spyOn(Logger.prototype, 'debug').mockImplementation((m) => depuracion.push(String(m)));
  });
  afterEach(() => jest.restoreAllMocks());

  it('con todo fluido no dice nada en alto', () => {
    anotarConcesion(HL_READ, 0);
    anotarConcesion(HL_READ, 120);
    new CaudalMonitorService().revisar();

    expect(avisos).toHaveLength(0);
    expect(depuracion[0]).toMatch(/2 peticiones, 1 esperaron/);
  });

  it('avisa cuando la espera se va por encima del umbral', () => {
    anotarConcesion(HL_READ, 4_000);
    new CaudalMonitorService().revisar();

    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatch(/peor 4000 ms/);
    expect(avisos[0]).toMatch(/se cuenta por IP/);
  });

  it('y también cuando lo que se dispara es la cola', () => {
    anotarConcesion(HL_READ, 50);
    anotarCola(HL_READ, 9);
    new CaudalMonitorService().revisar();

    expect(avisos[0]).toMatch(/cola máxima 9/);
  });

  it('no repite el aviso antes del enfriamiento, pero sigue midiendo', () => {
    const monitor = new CaudalMonitorService();
    anotarConcesion(HL_READ, 4_000);
    monitor.revisar();
    anotarConcesion(HL_READ, 9_000);
    monitor.revisar();

    expect(avisos).toHaveLength(1);
    expect(depuracion.at(-1)).toMatch(/peor 9000 ms/);
  });

  it('cada ventana empieza de cero: no arrastra lo de la anterior', () => {
    const monitor = new CaudalMonitorService();
    anotarConcesion(HL_READ, 100);
    monitor.revisar();
    anotarConcesion(HL_READ, 0);
    monitor.revisar();

    expect(depuracion.at(-1)).toMatch(/1 peticiones, 0 esperaron/);
  });

  it('un venue sin actividad no genera ruido', () => {
    new CaudalMonitorService().revisar();
    expect(avisos).toHaveLength(0);
    expect(depuracion).toHaveLength(0);
  });
});
