import { Router, type Context } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { 
  checkSetup, 
  setupPassword, 
  login, 
  logout,
  validateSession
} from "../auth.ts";
import { 
  setSessionCookie, 
  clearSessionCookie, 
  getSessionIdFromContext,
  checkRateLimit,
  recordFailedAttempt,
  clearFailedAttempts
} from "../session.ts";
import { loadConfig } from "../config.ts";

const authRouter = new Router();
let setupToken = crypto.randomUUID();
let setupTokenAnnounced = false;

function normalizeIp(ip: string): string {
  if (!ip) return "unknown";
  if (ip === "::1") return "127.0.0.1";
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  return ip;
}

function isLocalRequestIp(ip: string): boolean {
  const n = normalizeIp(ip);
  if (n === "127.0.0.1" || n === "localhost") return true;
  if (n.startsWith("10.")) return true;
  if (n.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(n)) return true;
  if (n.startsWith("169.254.")) return true;
  return false;
}

function isLocalRequest(ctx: Context): boolean {
  if (isLocalRequestIp(ctx.request.ip)) return true;
  const host = (ctx.request.url.hostname || "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

async function announceSetupTokenIfNeeded(): Promise<void> {
  if (setupTokenAnnounced) return;
  try {
    const config = await loadConfig();
    if (!config.password_hash) {
      setupTokenAnnounced = true;
      console.log(`[SECURITY] Setup token required for /auth/setup: ${setupToken}`);
    }
  } catch {
    // ignore
  }
}

// GET /auth/check - Check if setup is complete
authRouter.get("/auth/check", async (ctx) => {
  await announceSetupTokenIfNeeded();
  const response = await checkSetup();
  if (!response.setup_complete) {
    (response as { setup_token?: string }).setup_token = setupToken;
  }
  ctx.response.body = response;
});

// GET /auth/setup-token - Local-only convenience endpoint for first-time setup
authRouter.get("/auth/setup-token", async (ctx) => {
  await announceSetupTokenIfNeeded();
  const setup = await checkSetup();
  if (setup.setup_complete) {
    ctx.response.status = 404;
    ctx.response.body = { error: "Setup already completed" };
    return;
  }

  if (!isLocalRequest(ctx)) {
    ctx.response.status = 403;
    ctx.response.body = { error: "Forbidden" };
    return;
  }

  ctx.response.body = { setup_token: setupToken };
});

// POST /auth/setup - Initial setup (create password)
authRouter.post("/auth/setup", async (ctx) => {
  try {
    await announceSetupTokenIfNeeded();
    const body = await ctx.request.body({ type: "json" }).value;
    const password = body.password;
    const setupTokenProvided = body.setup_token;
    
    if (!password) {
      ctx.response.status = 400;
      ctx.response.body = {
        success: false,
        message: "Password is required",
      };
      return;
    }

    if (!setupTokenProvided || setupTokenProvided !== setupToken) {
      ctx.response.status = 403;
      ctx.response.body = {
        success: false,
        message: "Invalid setup token",
      };
      return;
    }
    
    const ip = ctx.request.ip;
    const userAgent = ctx.request.headers.get("User-Agent") || "unknown";
    const response = await setupPassword(password, ip, userAgent);
    
    if (response.success && response.token) {
      // Set secure session cookie
      const isSecure = ctx.request.secure || ctx.request.headers.get("x-forwarded-proto") === "https";
      setSessionCookie(ctx, response.token, isSecure);
      // Rotate token after successful setup.
      setupToken = crypto.randomUUID();
      setupTokenAnnounced = false;
    }
    
    ctx.response.body = response;
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = {
      success: false,
      message: String(error),
    };
  }
});

// POST /auth/login - Login with password
authRouter.post("/auth/login", async (ctx) => {
  try {
    const body = await ctx.request.body({ type: "json" }).value;
    const password = body.password;
    
    if (!password) {
      ctx.response.status = 400;
      ctx.response.body = {
        success: false,
        message: "Password is required",
      };
      return;
    }
    
    const ip = ctx.request.ip;
    const userAgent = ctx.request.headers.get("User-Agent") || "unknown";
    
    // Check rate limit
    if (!checkRateLimit(ip)) {
      ctx.response.status = 429;
      ctx.response.body = {
        success: false,
        message: "Too many failed attempts. Please try again in 15 minutes.",
      };
      return;
    }
    
    const response = await login(password, ip, userAgent);
    
    if (response.success && response.token) {
      // Clear failed attempts on successful login
      clearFailedAttempts(ip);
      
      // Set secure session cookie
      const isSecure = ctx.request.secure || ctx.request.headers.get("x-forwarded-proto") === "https";
      setSessionCookie(ctx, response.token, isSecure);
    } else {
      // Record failed attempt
      recordFailedAttempt(ip);
    }
    
    ctx.response.body = response;
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = {
      success: false,
      message: String(error),
    };
  }
});

// POST /auth/logout - Logout and destroy session
authRouter.post("/auth/logout", async (ctx) => {
  try {
    const sessionId = getSessionIdFromContext(ctx);
    
    if (sessionId) {
      await logout(sessionId);
    }
    
    clearSessionCookie(ctx);
    
    ctx.response.body = {
      success: true,
      message: "Logged out successfully",
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = {
      success: false,
      message: String(error),
    };
  }
});

// GET /auth/session - Get current session info (for CSRF token)
authRouter.get("/auth/session", async (ctx) => {
  try {
    const sessionId = getSessionIdFromContext(ctx);
    
    if (!sessionId) {
      ctx.response.status = 401;
      ctx.response.body = {
        authenticated: false,
      };
      return;
    }
    
    const ip = ctx.request.ip;
    const userAgent = ctx.request.headers.get("User-Agent") || "unknown";
    const session = await validateSession(sessionId, ip, userAgent);
    
    if (!session) {
      ctx.response.status = 401;
      ctx.response.body = {
        authenticated: false,
      };
      return;
    }
    
    ctx.response.body = {
      authenticated: true,
      csrf_token: session.csrf_token,
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = {
      error: String(error),
    };
  }
});

export default authRouter;
