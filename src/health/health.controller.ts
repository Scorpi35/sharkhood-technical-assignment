import { Controller, Get } from '@nestjs/common';
import { AppConfig } from '../config/app-config';

/** Liveness probe used by the compose healthcheck. Dependency readiness comes later. */
@Controller('health')
export class HealthController {
  constructor(private readonly config: AppConfig) {}

  @Get()
  check(): { status: 'ok'; role: string; uptimeSec: number } {
    return { status: 'ok', role: this.config.role, uptimeSec: Math.round(process.uptime()) };
  }
}
