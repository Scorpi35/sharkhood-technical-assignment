import { Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { rm, writeFile } from 'node:fs/promises';
import { AppConfig } from '../config/app-config';

export const HEARTBEAT_FILE = '/tmp/worker-heartbeat';
const INTERVAL_MS = 10_000;

/**
 * The worker has no HTTP port, so it proves liveness by touching a file that the
 * compose healthcheck checks for freshness. Also keeps the application-context
 * process alive until queue processors are added in a later ticket.
 */
@Injectable()
export class WorkerHeartbeatService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerHeartbeatService.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly config: AppConfig) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.beat();
    this.timer = setInterval(() => void this.beat(), INTERVAL_MS);
    this.logger.log({ concurrency: this.config.jobs.concurrency }, 'Worker ready');
  }

  async onApplicationShutdown(signal?: string): Promise<void> {
    clearInterval(this.timer);
    await rm(HEARTBEAT_FILE, { force: true });
    this.logger.log({ signal }, 'Worker stopped');
  }

  private async beat(): Promise<void> {
    try {
      await writeFile(HEARTBEAT_FILE, new Date().toISOString());
    } catch (err) {
      this.logger.warn({ err }, 'Failed to write heartbeat');
    }
  }
}
