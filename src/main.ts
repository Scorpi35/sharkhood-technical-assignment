// Must stay the first import: loads .env before AppModule's import-time config validation.
import './config/env-file';
import 'reflect-metadata';
import { Logger as NestLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { loadConfigOrExit } from './config/load-config';

async function bootstrap(): Promise<void> {
  // Validate first: exits(1) on bad config before any module or connection exists.
  const config = loadConfigOrExit();
  const module = AppModule.forRole(config);

  if (config.runsHttp) {
    const app = await NestFactory.create(module, { bufferLogs: true });
    app.useLogger(app.get(Logger));
    app.enableShutdownHooks();
    await app.listen(config.http.port, '0.0.0.0');
    new NestLogger('Bootstrap').log({ port: config.http.port }, 'HTTP server listening');
  } else {
    const app = await NestFactory.createApplicationContext(module, { bufferLogs: true });
    app.useLogger(app.get(Logger));
    app.enableShutdownHooks();
    await app.init();
  }
}

bootstrap().catch((err: unknown) => {
  const e = err instanceof Error ? err : new Error(String(err));
  process.stderr.write(
    JSON.stringify({ level: 'fatal', time: new Date().toISOString(), msg: 'Bootstrap failed', err: { message: e.message, stack: e.stack } }) + '\n',
  );
  process.exit(1);
});
