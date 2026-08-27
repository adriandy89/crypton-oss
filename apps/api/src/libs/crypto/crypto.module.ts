import { Global, Module } from '@nestjs/common';
import { EnvelopeService } from './envelope.service';

// Global: la API y el worker acceden a él desde muchos sitios y no tiene
// sentido volver a importarlo en cada módulo.
@Global()
@Module({
  providers: [EnvelopeService],
  exports: [EnvelopeService],
})
export class CryptoModule {}
