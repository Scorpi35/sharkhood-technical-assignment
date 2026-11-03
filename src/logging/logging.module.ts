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
          // endpoint / requests_url carry a live provider API key (CLAUDE.md > Data findings).
          // Callers must never log them; this is a backstop for common shapes.
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'endpoint',
              'requests_url',
              '*.endpoint',
              '*.requests_url',
              '*.request_log.requests_url',
              '*.*.request_log.requests_url',
            ],
            censor: '[REDACTED]',
          },
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
