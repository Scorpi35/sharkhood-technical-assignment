import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AppConfig } from '../config/app-config';
import { buildPinoOptions } from './pino-options';

/** Structured logging for the Nest app. Options are shared with standalone scripts. */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        pinoHttp: {
          ...buildPinoOptions(config),
          autoLogging: { ignore: (req) => req.url === '/health' },
        },
      }),
    }),
  ],
})
export class LoggingModule {}
