import type { z } from 'zod';
import { fail, Issue, ok, StageOutcome } from '../../core';
import { KNOWN_PLATFORMS } from './mappings';

/*
 * Shared envelope handling for every xbyte collection:
 *   1. detect provider error payloads (statusCode is always 200, so the body is the only signal);
 *   2. validate strictly with Zod;
 *   3. map `domain` to a known platform.
 * Everything placed in an Issue goes through sanitize(), so the API key in
 * `endpoint` / `requests_url` can never leak into quarantine.
 */

const SECRET_KEYS = new Set(['endpoint', 'requests_url', 'request_log']);
const API_KEY_IN_TEXT = /api_key=[^&\s"']+/gi;

/** Deep copy without secret-bearing keys; any `api_key=` left inside a string is redacted. */
export function sanitize(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(API_KEY_IN_TEXT, 'api_key=[REDACTED]');
  if (Array.isArray(value)) return value.map(sanitize);
  if (value instanceof Date) return value;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([k]) => !SECRET_KEYS.has(k))
        .map(([k, v]) => [k, sanitize(v)]),
    );
  }
  return value;
}

/** Build an Issue with sanitized message and details. */
export function issueOf(issue: Issue): Issue {
  return {
    ...issue,
    message: sanitize(issue.message) as string,
    ...(issue.details === undefined ? {} : { details: sanitize(issue.details) }),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Provider error payloads, checked before strict validation (in this order):
 * `Message` (menus "not a restaurant page"), `Page Error Message` (listing page
 * limit), `error` with no results, then missing/empty results.
 */
export function detectProviderError(body: unknown): Issue | null {
  if (!isObject(body) || !isObject(body.payload)) return null; // let the schema report it
  const p = body.payload;
  const results = p.results;
  const noResults = results === undefined || (Array.isArray(results) && results.length === 0);

  if ('Message' in p) {
    return issueOf({ reason: 'PROVIDER_ERROR', message: 'provider returned an error page', path: 'payload.Message', details: { message: p.Message } });
  }
  if ('Page Error Message' in p) {
    return issueOf({
      reason: 'PROVIDER_ERROR',
      message: 'provider returned a page error',
      path: 'payload.Page Error Message',
      details: { message: p['Page Error Message'], totalPage: p['Total Page'] },
    });
  }
  if ('error' in p && noResults) {
    return issueOf({ reason: 'PROVIDER_ERROR', message: 'provider returned an error payload', path: 'payload.error', details: { error: p.error } });
  }
  if (noResults) return issueOf({ reason: 'EMPTY_PAYLOAD', message: 'payload has no results', path: 'payload.results' });
  return null;
}

/** Re-root a record-level issue under `prefix` (e.g. "payload.results[3]"), sanitized. */
export function atPath(issue: Issue, prefix: string): Issue {
  return issueOf({ ...issue, path: issue.path ? `${prefix}.${issue.path}` : prefix });
}

/** "payload.results.3.restaurant_url" style Zod path -> "payload.results[3].restaurant_url". */
export function formatPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((acc, part) => (typeof part === 'number' ? `${acc}[${part}]` : acc ? `${acc}.${String(part)}` : String(part)), '');
}

/** Error detection, then strict validation, then platform check. */
export function validateEnvelope<S extends z.ZodType<{ domain: string }>>(
  schema: S,
  body: unknown,
): StageOutcome<z.infer<S> & { platform: string }> {
  const providerError = detectProviderError(body);
  if (providerError) return fail(providerError);

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 10).map((i) => ({ path: formatPath(i.path), code: i.code, message: i.message }));
    return fail(
      issueOf({
        reason: 'SCHEMA_INVALID',
        message: `${issues[0].path || '(root)'}: ${issues[0].message}`,
        path: issues[0].path,
        details: { issues, total: parsed.error.issues.length },
      }),
    );
  }

  const platform = parsed.data.domain.trim().toLowerCase();
  if (!(KNOWN_PLATFORMS as readonly string[]).includes(platform)) {
    return fail(issueOf({ reason: 'SCHEMA_INVALID', message: `unknown platform "${parsed.data.domain}"`, path: 'domain' }));
  }
  return ok({ ...parsed.data, platform });
}
