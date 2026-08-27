import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('health')
@Controller()
export class AppController {
  @Get('health')
  @ApiOperation({
    summary: 'Comprobación de vida para el balanceador y Docker',
  })
  health() {
    return { status: 'ok', ts: Date.now() };
  }
}
