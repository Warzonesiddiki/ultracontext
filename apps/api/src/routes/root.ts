import { chainHealth } from '@ultracontext/core';

import type { HttpApp, HttpContext } from '../types/http';

export function registerRootRoutes(app: HttpApp) {
    app.get('/', (c) => {
        return c.json({
            message: 'UltraContext API',
            reasoning: 'Welcome to the beggining of infinity.',
        });
    });

    // -- probes (unauthenticated — load balancers and orchestrators cannot
    //    hold API keys; the auth middleware is only mounted on /contexts*,
    //    /mcp and /v1/keys*) ---------------------------------------------------

    // liveness: the process is up and the HTTP stack is serving.
    //
    // Also carries the chain-health counters (ARCH-002): when a read cannot walk
    // a context's prev_id chain it falls back to (ordinal, created_at,
    // public_id) and records the event, and this is where an operator points a
    // monitor. Two deliberate choices:
    //
    //   * `status` stays 'ok' while counters are non-zero. A broken chain is a
    //     DATA condition — restarting the process neither fixes nor clears it,
    //     and a liveness probe that fails on it would flap a healthy server.
    //     Alert on `chain_health.fallbacks`, not on `status`.
    //   * `last_context_id` is omitted. This probe is unauthenticated (load
    //     balancers cannot hold API keys), so it must not name a tenant's
    //     context. The id is still in the server log line and in the in-process
    //     snapshot returned by core's chainHealth().
    //
    // Counters are per-process and reset on restart — UltraContext has no
    // telemetry and nothing here is ever sent anywhere.
    app.get('/health', (c) => {
        const { last_context_id: _contextId, ...chain } = chainHealth();
        return c.json({ status: 'ok', chain_health: chain });
    });

    // readiness: the storage backend answers. A trivial read (listProjects)
    // touches the DB without writing, on every adapter. 503 (not 500): the
    // process is up, a dependency is down.
    app.get('/health/ready', async (c: HttpContext) => {
        try {
            await c.get('storage').listProjects();
            return c.json({ status: 'ready' });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return c.json({ status: 'not_ready', error: message }, 503);
        }
    });
}
