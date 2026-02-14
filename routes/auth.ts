import { Router } from "https://deno.land/x/oak@v12.6.1/mod.ts";
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

const authRouter = new Router();

// GET /auth/check - Check if setup is complete
authRouter.get("/auth/check", async (ctx) => {
  const response = await checkSetup();
  ctx.response.body = response;
});

// POST /auth/setup - Initial setup (create password)
authRouter.post("/auth/setup", async (ctx) => {
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
    
    const response = await setupPassword(password);
    
    if (response.success && response.token) {
      // Set secure session cookie
      const isSecure = ctx.request.secure || ctx.request.headers.get("x-forwarded-proto") === "https";
      setSessionCookie(ctx, response.token, isSecure);
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
