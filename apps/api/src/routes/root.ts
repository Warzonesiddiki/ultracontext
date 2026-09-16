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

    // liveness: the process is up and the HTTP stack is serving
    app.get('/health', (c) => c.json({ status: 'ok' }));

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
