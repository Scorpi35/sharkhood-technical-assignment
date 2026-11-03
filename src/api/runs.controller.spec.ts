import { ConflictException, NotFoundException } from '@nestjs/common';
import { ResumeReport, RunResumer, UnknownRunError } from '../queue/run-resumer.service';
import { RunsController } from './runs.controller';

const report = (over: Partial<ResumeReport> = {}): ResumeReport => ({
  runId: 'r1',
  status: 'running',
  terminal: false,
  alreadyTerminal: false,
  dispatchRequeued: [],
  batchesRequeued: 3,
  ...over,
});
const controller = (resume: RunResumer['resume']) => new RunsController({ resume } as RunResumer);

describe('POST /runs/:id/resume', () => {
  it('returns the resume report', async () => {
    await expect(controller(async () => report()).resume('r1')).resolves.toEqual(report());
  });

  it('a resume that finalises the run is still a success', async () => {
    const r = report({ status: 'completed', terminal: true, batchesRequeued: 0 });
    await expect(controller(async () => r).resume('r1')).resolves.toEqual(r);
  });

  it('404 for an unknown run', async () => {
    await expect(
      controller(async () => {
        throw new UnknownRunError('unknown run r9');
      }).resume('r9'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('409 for a run that had already finished', async () => {
    await expect(
      controller(async () => report({ status: 'completed_with_errors', terminal: true, alreadyTerminal: true })).resume('r1'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('other errors propagate (500)', async () => {
    await expect(
      controller(async () => {
        throw new Error('redis down');
      }).resume('r1'),
    ).rejects.toThrow('redis down');
  });
});
