// Unit tests for the SDK client's resilience layer (SDK-002):
// default timeout, per-attempt timeout, AbortSignal passthrough, and retries
// with exponential backoff on 429/5xx/network errors (Retry-After honoured).
//
// Runs against src directly (type stripping), no rebuild needed.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    UltraContext,
    UltraContextHttpError,
    backoffDelayMs,
    retryAfterMs,
    DEFAULT_TIMEOUT_MS,
    DEFAULT_MAX_RETRIES,
} from '../src/index.ts';

// ── fake fetch harness ───────────────────────────────────────────

type Call = { method: string; url: string };

// A scripted response; special shapes let the test control timing:
//   - Response / Error returned immediately
//   - { afterMs, response } — wait, then return
//   - { hangUntilAbort } — resolve/reject only when the fetch signal fires
type ScriptItem = Response | Error | { afterMs: number; response: Response } | { hangUntilAbort: true };

function makeFetch(script: ScriptItem[]) {
    const calls: Call[] = [];
    let i = 0;
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ method: init?.method ?? 'GET', url: String(url) });
        const item: ScriptItem = i < script.length ? script[i++] : new Response('{}', { status: 200 });
        if (item instanceof Error) throw item;
        if (typeof item === 'object' && 'afterMs' in item) {
            await new Promise((r) => setTimeout(r, item.afterMs));
            return item.response;
        }
        if (typeof item === 'object' && 'hangUntilAbort' in item) {
            const signal = init?.signal as AbortSignal;
            if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
            return new Promise<Response>((_resolve, reject) => {
                signal?.addEventListener(
                    'abort',
                    () => reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')),
                    { once: true },
                );
            });
        }
        return item;
    }) as typeof fetch;
    return { fetch: fetchFn, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const ok = () => json(200, { ok: true });
const BASE = { apiKey: 'uc_live_test', baseUrl: 'http://127.0.0.1:8787' };

// ── defaults + pure helpers ──────────────────────────────────────

describe('defaults', () => {
    it('default timeout is ~30s and default retries are 3', () => {
        assert.equal(DEFAULT_TIMEOUT_MS, 30_000);
        assert.equal(DEFAULT_MAX_RETRIES, 3);
    });

    it('retryAfterMs parses seconds and HTTP-date, rejects garbage', () => {
        assert.equal(retryAfterMs('2'), 2000);
        assert.equal(retryAfterMs('0'), 0);
        const date = new Date(Date.now() + 5000).toUTCString();
        const fromDate = retryAfterMs(date);
        assert.ok(fromDate !== undefined && fromDate >= 4000 && fromDate <= 6000, `got ${fromDate}`);
        assert.equal(retryAfterMs('not-a-date'), undefined);
        assert.equal(retryAfterMs(null), undefined);
        assert.equal(retryAfterMs(undefined), undefined);
    });

    it('backoffDelayMs grows exponentially with jitter, capped', () => {
        for (const [attempt, lo, hi] of [
            [0, 250, 500],
            [1, 500, 1_000],
            [2, 1_000, 2_000],
        ] as const) {
            const d = backoffDelayMs(attempt);
            assert.ok(d >= lo && d <= hi, `attempt ${attempt}: ${d} not in [${lo}, ${hi}]`);
        }
        assert.ok(backoffDelayMs(20) <= 8_000); // cap
    });
});

// ── timeout ──────────────────────────────────────────────────────

describe('timeout', () => {
    it('a timed-out GET is a transport failure → retried (idempotent), then raises', async () => {
        const { fetch: f, calls } = makeFetch([{ hangUntilAbort: true }, { hangUntilAbort: true }]);
        const c = new UltraContext({ ...BASE, fetch: f, timeoutMs: 30, maxRetries: 1 });
        await assert.rejects(c.get('abc'), (err: Error) => err.name === 'TimeoutError' || err.name === 'AbortError');
        assert.equal(calls.length, 2);
    });

    it('timeoutMs: 0 disables the timeout', async () => {
        const { fetch: f } = makeFetch([{ afterMs: 60, response: ok() }]);
        const c = new UltraContext({ ...BASE, fetch: f, timeoutMs: 0 });
        assert.deepEqual(await c.get('abc'), { ok: true });
    });
});

// ── AbortSignal passthrough ──────────────────────────────────────

describe('AbortSignal passthrough', () => {
    it('aborts the in-flight request and does NOT retry (even for GET)', async () => {
        const { fetch: f, calls } = makeFetch([{ hangUntilAbort: true }, ok()]);
        const c = new UltraContext({ ...BASE, fetch: f });
        const ac = new AbortController();
        const p = c.get('abc', { signal: ac.signal });
        setTimeout(() => ac.abort(), 20);
        await assert.rejects(p, (err: Error) => err.name === 'AbortError');
        assert.equal(calls.length, 1); // caller said stop → no retry
    });

    it('aborts a pending retry backoff', async () => {
        const { fetch: f, calls } = makeFetch([json(429, { error: 'rate limited', code: 'rate_limited' }, { 'Retry-After': '2' }), ok()]);
        const c = new UltraContext({ ...BASE, fetch: f });
        const ac = new AbortController();
        const p = c.append('abc', { role: 'user', content: 'x' }, { signal: ac.signal });
        setTimeout(() => ac.abort(), 40);
        const start = Date.now();
        await assert.rejects(p, (err: Error) => err.name === 'AbortError');
        assert.ok(Date.now() - start < 1_500, 'backoff should be cut short by the abort');
        assert.equal(calls.length, 1); // never got to the second attempt
    });

    it('an already-aborted signal rejects before any request', async () => {
        const { fetch: f, calls } = makeFetch([ok()]);
        const c = new UltraContext({ ...BASE, fetch: f });
        const ac = new AbortController();
        ac.abort();
        await assert.rejects(c.get('abc', { signal: ac.signal }));
        assert.equal(calls.length, 0);
    });
});

// ── retry policy ─────────────────────────────────────────────────

describe('retries', () => {
    it('retries 429 on POST and honours the Retry-After header', async () => {
        const { fetch: f, calls } = makeFetch([
            json(429, { error: 'rate limited', code: 'rate_limited' }, { 'Retry-After': '1' }),
            ok(),
        ]);
        const c = new UltraContext({ ...BASE, fetch: f });
        const start = Date.now();
        assert.deepEqual(await c.append('abc', { role: 'user', content: 'hi' }), { ok: true });
        assert.equal(calls.length, 2);
        assert.ok(Date.now() - start >= 900, 'Retry-After: 1 should be honoured');
    });

    it('retries 429 using the body retry_after_sec when no header', async () => {
        const { fetch: f, calls } = makeFetch([
            json(429, { error: 'slow down', code: 'rate_limited', retry_after_sec: 1 }),
            ok(),
        ]);
        const c = new UltraContext({ ...BASE, fetch: f });
        const start = Date.now();
        assert.deepEqual(await c.get('abc'), { ok: true });
        assert.equal(calls.length, 2);
        assert.ok(Date.now() - start >= 900, 'retry_after_sec should be honoured');
    });

    it('retries 5xx on GET with backoff, then succeeds', async () => {
        const { fetch: f, calls } = makeFetch([json(500, { error: 'boom', code: 'internal' }), ok()]);
        const c = new UltraContext({ ...BASE, fetch: f });
        assert.deepEqual(await c.get('abc'), { ok: true });
        assert.equal(calls.length, 2);
    });

    it('does NOT retry 5xx on POST (double-append risk)', async () => {
        const { fetch: f, calls } = makeFetch([json(500, { error: 'boom', code: 'internal' })]);
        const c = new UltraContext({ ...BASE, fetch: f });
        await assert.rejects(c.append('abc', { role: 'user', content: 'x' }), UltraContextHttpError);
        assert.equal(calls.length, 1);
    });

    it('does NOT retry 409 conflicts (caller-handled)', async () => {
        const { fetch: f, calls } = makeFetch([json(409, { error: 'Concurrent write conflict', code: 'conflict' })]);
        const c = new UltraContext({ ...BASE, fetch: f });
        await assert.rejects(c.append('abc', { role: 'user', content: 'x' }), (err: UltraContextHttpError) => err.status === 409);
        assert.equal(calls.length, 1);
    });

    it('never retries statuses the caller accepts (deleteMany 207/409/500)', async () => {
        for (const status of [207, 409, 500]) {
            const body = { results: [{ id: 'a', deleted: false, error: 'boom' }], deleted_count: 0 };
            const { fetch: f, calls } = makeFetch([json(status, body)]);
            const c = new UltraContext({ ...BASE, fetch: f });
            assert.deepEqual(await c.deleteMany(['a']), body);
            assert.equal(calls.length, 1);
        }
    });

    it('retries network errors on GET, then succeeds', async () => {
        const { fetch: f, calls } = makeFetch([new TypeError('fetch failed'), ok()]);
        const c = new UltraContext({ ...BASE, fetch: f });
        assert.deepEqual(await c.get('abc'), { ok: true });
        assert.equal(calls.length, 2);
    });

    it('does NOT retry network errors on POST', async () => {
        const { fetch: f, calls } = makeFetch([new TypeError('fetch failed')]);
        const c = new UltraContext({ ...BASE, fetch: f });
        await assert.rejects(c.append('abc', { role: 'user', content: 'x' }), TypeError);
        assert.equal(calls.length, 1);
    });

    it('gives up after maxRetries (3 attempts total) and raises', async () => {
        const { fetch: f, calls } = makeFetch([json(500, {}), json(500, {}), json(500, {})]);
        const c = new UltraContext({ ...BASE, fetch: f, maxRetries: 2 });
        await assert.rejects(c.get('abc'), (err: UltraContextHttpError) => err.status === 500);
        assert.equal(calls.length, 3); // initial + 2 retries
    });

    it('maxRetries: 0 makes a single attempt', async () => {
        const { fetch: f, calls } = makeFetch([json(500, {})]);
        const c = new UltraContext({ ...BASE, fetch: f, maxRetries: 0 });
        await assert.rejects(c.get('abc'), (err: UltraContextHttpError) => err.status === 500);
        assert.equal(calls.length, 1);
    });
});
