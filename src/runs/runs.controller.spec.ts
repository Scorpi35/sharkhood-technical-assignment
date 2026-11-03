import type { RunResumer } from '../queue/run-resumer.service';
import { RunsController } from './runs.controller';
import type { RunsService } from './runs.service';

/**
 * "Controllers contain no logic beyond calling a service method": every endpoint
 * must pass its (already validated) input to exactly one service method and
 * return that method's result untouched; errors must pass through unchanged
 * (the global filter maps them).
 */
describe('RunsController is a thin wrapper', () => {
  const result = Symbol('result');
  const error = new Error('from the service');
  const fakes = () => {
    const calls: string[] = [];
    const spy = (name: string) => jest.fn(async () => (calls.push(name), result));
    const runs = { startRun: spy('startRun'), getRunOrThrow: spy('getRunOrThrow'), listErrors: spy('listErrors') };
    const resumer = { resume: spy('resume') };
    return { calls, runs, resumer, controller: new RunsController(runs as unknown as RunsService, resumer as unknown as RunResumer) };
  };

  it.each([
    ['start', 'startRun', (c: RunsController) => c.start({ collections: ['menus'] }), [{ collections: ['menus'] }]],
    ['get', 'getRunOrThrow', (c: RunsController) => c.get('r1'), ['r1']],
    ['errors', 'listErrors', (c: RunsController) => c.errors('r1', { limit: 50 }), ['r1', { limit: 50 }]],
    ['resume', 'resume', (c: RunsController) => c.resume('r1'), ['r1']],
  ] as const)('%s -> exactly one call to %s, result returned as-is', async (_name, method, call, args) => {
    const { calls, runs, resumer, controller } = fakes();
    await expect(call(controller)).resolves.toBe(result);
    expect(calls).toEqual([method]);
    const fn = (method in runs ? runs[method as keyof typeof runs] : resumer.resume) as jest.Mock;
    expect(fn).toHaveBeenCalledWith(...args);
  });

  it('service errors propagate unchanged', async () => {
    const { runs, controller } = fakes();
    runs.getRunOrThrow.mockRejectedValueOnce(error);
    await expect(controller.get('r1')).rejects.toBe(error);
  });
});
