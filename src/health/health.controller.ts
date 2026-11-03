import { Controller, Get } from '@nestjs/common';
import { HealthReport, HealthService } from './health.service';

/** GET /health: 200 with the report when every dependency is up, 503 with the same shape otherwise. */
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  check(): Promise<HealthReport> {
    return this.health.check();
  }
}
