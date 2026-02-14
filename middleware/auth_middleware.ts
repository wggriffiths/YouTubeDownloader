import type { Context, Next } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { getSessionIdFromContext } from "../session.ts";
import { validateSession } from "../auth.ts";

export async function authMiddleware(ctx: Context, next: Next) {
  const sessionId = getSessionIdFromContext(ctx);
  
  if (!sessionId) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Authentication required" };
    return;
  }
  
  const ip = ctx.request.ip;
  const userAgent = ctx.request.headers.get("User-Agent") || "unknown";
  
  const session = await validateSession(sessionId, ip, userAgent);
  
  if (!session) {
    ctx.response.status = 401;
    ctx.response.body = { error: "Invalid or expired session" };
    return;
  }
  
  // Attach session to state for use in route handlers
  ctx.state.session = session;
  
  await next();
}

export async function csrfMiddleware(ctx: Context, next: Next) {
  if (ctx.request.method === "POST" || ctx.request.method === "PUT" || ctx.request.method === "DELETE") {
    const session = ctx.state.session;
    
    if (!session) {
      ctx.response.status = 401;
      ctx.response.body = { error: "Authentication required" };
      return;
    }
    
    let csrfToken: string | undefined;
    
    try {
      const body = await ctx.request.body({ type: "json" }).value;
      csrfToken = body.csrf_token;
    } catch (_error) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Invalid request body" };
      return;
    }
    
    if (!csrfToken || csrfToken !== session.csrf_token) {
      ctx.response.status = 403;
      ctx.response.body = { error: "CSRF token validation failed" };
      return;
    }
  }
  
  await next();
}
