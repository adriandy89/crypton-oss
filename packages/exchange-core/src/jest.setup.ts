import { VenueCooldown } from './cooldown';

/**
 * El enfriamiento del venue es de PROCESO desde el spec 031 —el cortafuegos
 * corta por IP, así que compartirlo es lo que evita encadenar cortes con varias
 * cuentas—, y eso significa que un caso que inicia un corte se lo pasaría al
 * siguiente. Se olvida antes de cada uno, aquí y no en cada fichero, para que
 * un test nuevo no herede la trampa sin saberlo.
 */
beforeEach(() => VenueCooldown.reset());
