import { expireLibraryReservations, handleLibrary } from "./library";

interface Env {
  DB: D1Database;
  ADMIN_PASSWORD?: string;
  LIBRARY_SESSION_SECRET?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return Response.redirect(new URL("/library", url), 302);
    }
    try {
      return await handleLibrary(request, env) || new Response("Not found", { status: 404 });
    } catch (error) {
      console.error("Unhandled library Worker error", error);
      return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Library temporarily unavailable</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;background:#f7f3e9;color:#1d2924;font-family:system-ui,sans-serif}.card{width:min(600px,100%);padding:38px;border:1px solid #d8d4c9;border-radius:20px;background:#fffdf8}h1{font:700 2.5rem Georgia,serif}p{color:#66736d}.button{display:inline-block;padding:12px 18px;border-radius:10px;background:#315b4a;color:white;text-decoration:none;font-weight:800}</style></head><body><main class="card"><h1>Please try that again.</h1><p>The community library encountered a temporary problem. Your information has not been changed.</p><a class="button" href="/library">Return to library</a></main></body></html>`, {
        status: 503,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "retry-after": "5" }
      });
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(expireLibraryReservations(env).then(released => {
      if (released) console.log(`Released ${released} expired library reservation(s).`);
    }));
  }
};
