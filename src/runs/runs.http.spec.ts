import { BadRequestException } from '@nestjs/common';
import { ProviderRegistry } from '../core';
import { createXbyteAdapter } from '../providers/xbyte/xbyte.adapter';
import { ErrorsQueryPipe, StartRunBodyPipe } from './runs.http';

const pipe = new StartRunBodyPipe(new ProviderRegistry([createXbyteAdapter()]));
const issuesOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return ((e as BadRequestException).getResponse() as { issues: { path: string }[] }).issues.map((i) => i.path);
  }
  throw new Error('expected a 400');
};

describe('POST /runs body', () => {
  it('accepts the registered aliases and the optional numbers', () => {
    expect(pipe.transform({ collections: ['menus', 'locations'], limit: 100, batchSize: 50 })).toEqual({
      collections: ['menus', 'locations'],
      limit: 100,
      batchSize: 50,
    });
    expect(pipe.transform({})).toEqual({});
    expect(pipe.transform(undefined)).toEqual({});
  });

  it('rejects invalid input with a Zod issue path per problem', () => {
    expect(issuesOf(() => pipe.transform({ collections: ['menus', 'pizza'], limit: 0, batchSize: 1.5 }))).toEqual(['collections.1', 'limit', 'batchSize']);
    expect(issuesOf(() => pipe.transform({ collections: [] }))).toEqual(['collections']);
    expect(issuesOf(() => pipe.transform({ limit: '10' }))).toEqual(['limit']); // JSON numbers only
    expect(issuesOf(() => pipe.transform({ batchSize: 100_000 }))).toEqual(['batchSize']);
    expect(issuesOf(() => pipe.transform({ colections: ['menus'] }))).toEqual(['']); // unknown key (typo): strict object
  });
});

describe('GET /runs/:id/errors query', () => {
  const q = new ErrorsQueryPipe();
  it('defaults limit to 50, coerces query strings, and caps limit at 200', () => {
    expect(q.transform({})).toEqual({ limit: 50 });
    expect(q.transform({ limit: '10', reason: 'PROVIDER_ERROR', cursor: 'abc' })).toEqual({ limit: 10, reason: 'PROVIDER_ERROR', cursor: 'abc' });
    expect(q.transform({ limit: '5000' })).toEqual({ limit: 200 });
  });
  it('rejects unknown reasons and non-positive limits', () => {
    expect(issuesOf(() => q.transform({ reason: 'NOPE', limit: '0' }))).toEqual(['reason', 'limit']);
  });
});
