import type { Context, Next } from "https://deno.land/x/oak@v12.6.1/mod.ts";

export async function securityHeadersMiddleware(ctx: Context, next: Next) {
  // Security headers
  ctx.response.headers.set("X-Frame-Options", "DENY");
  ctx.response.headers.set("X-Content-Type-Options", "nosniff");
  ctx.response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  ctx.response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  ctx.response.headers.set("Pragma", "no-cache");
  
  // Optional: Content Security Policy
  // Uncomment if needed, adjust based on your frontend requirements
  // ctx.response.headers.set(
  //   "Content-Security-Policy",
  //   "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'"
  // );
  
  await next();
}
