import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AppConfig } from '../config/app-config';

/**
 * Structured logging. Single-line JSON everywhere except NODE_ENV=development,
 * which pipes through pino-pretty (a dev dependency, never loaded in prod).
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          level: config.logLevel,
          base: { service: 'sharkhood', role: config.role },
          timestamp: () => `,"time":"${new Date().toISOString()}"`,
          formatters: { level: (label: string) => ({ level: label }) },
          redact: ['req.headers.authorization', 'req.headers.cookie'],
          autoLogging: { ignore: (req) => req.url === '/health' },
          transport: config.isDevelopment
            ? { target: 'pino-pretty', options: { singleLine: true, translateTime: 'SYS:HH:MM:ss.l' } }
            : undefined,
        },
      }),
    }),
  ],
})
export class LoggingModule {}
