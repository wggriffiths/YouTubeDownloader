import { setCookie, getCookies, deleteCookie } from "https://deno.land/std@0.202.0/http/cookie.ts";
import type { Context } from "https://deno.land/x/oak@v12.6.1/mod.ts";

export interface SessionData {
  session_id: string;
  created_at: number;
  last_activity: number;
  user_ip: string;
  user_agent: string;
  csrf_token: string;
}

export interface RateLimitData {
  attempts: number[];
}

import { loadConfig } from "./config.ts";

let SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes default

/** Reload timeout from config. Called periodically and on init. */
async function refreshTimeout(): Promise<void> {
  try {
    const config = await loadConfig();
    SESSION_TIMEOUT = (config.session_timeout || 30) * 60 * 1000;
  } catch { /* keep current value */ }
}
refreshTimeout();
setInterval(refreshTimeout, 60000);
const MAX_LOGIN_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes
const COOKIE_NAME = "yt_session";

// In-memory storage (production should use Redis or similar)
const sessions = new Map<string, SessionData>();
const rateLimits = new Map<string, RateLimitData>();

function normalizeIp(ip: string): string {
  if (!ip) return "unknown";
  if (ip === "::1") return "127.0.0.1";
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  return ip;
}

function generateSessionId(): string {
  return crypto.randomUUID();
}

function generateCsrfToken(): string {
  const buffer = new Uint8Array(32);
  crypto.getRandomValues(buffer);
  return Array.from(buffer)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

export function createSession(ip = "unknown", userAgent = "unknown"): SessionData {
  const normalizedIp = normalizeIp(ip);
  const sessionId = generateSessionId();
  const csrfToken = generateCsrfToken();
  
  const session: SessionData = {
    session_id: sessionId,
    created_at: Date.now(),
    last_activity: Date.now(),
    user_ip: normalizedIp,
    user_agent: userAgent,
    csrf_token: csrfToken,
  };
  
  sessions.set(sessionId, session);
  
  return session;
}

export function getSession(
  sessionId: string,
  ip: string,
  userAgent: string
): SessionData | null {
  const normalizedIp = normalizeIp(ip);
  const session = sessions.get(sessionId);
  
  if (!session) {
    return null;
  }
  
  // Check timeout
  if (Date.now() - session.last_activity > SESSION_TIMEOUT) {
    sessions.delete(sessionId);
    return null;
  }
  
  // Verify IP
  if (normalizeIp(session.user_ip) !== normalizedIp) {
    sessions.delete(sessionId);
    return null;
  }
  
  // Verify User-Agent
  if (session.user_agent !== userAgent) {
    sessions.delete(sessionId);
    return null;
  }
  
  // Update activity
  session.last_activity = Date.now();
  sessions.set(sessionId, session);
  
  return session;
}

export function destroySession(sessionId: string): void {
  sessions.delete(sessionId);
}

export function setSessionCookie(ctx: Context, sessionId: string, secure = true): void {
  setCookie(ctx.response.headers, {
    name: COOKIE_NAME,
    value: sessionId,
    httpOnly: true,
    secure: secure,
    sameSite: "Strict",
    path: "/",
    maxAge: Math.floor(SESSION_TIMEOUT / 1000),
  });
}

export function clearSessionCookie(ctx: Context): void {
  deleteCookie(ctx.response.headers, COOKIE_NAME, {
    path: "/",
  });
}

export function getSessionIdFromContext(ctx: Context): string | null {
  const cookies = getCookies(ctx.request.headers);
  return cookies[COOKIE_NAME] || null;
}

export function checkRateLimit(identifier: string): boolean {
  const now = Date.now();
  let limitData = rateLimits.get(identifier);
  
  if (!limitData) {
    limitData = { attempts: [] };
  }
  
  // Clean old attempts
  limitData.attempts = limitData.attempts.filter(
    timestamp => now - timestamp < RATE_LIMIT_WINDOW
  );
  
  if (limitData.attempts.length >= MAX_LOGIN_ATTEMPTS) {
    rateLimits.set(identifier, limitData);
    return false;
  }
  
  return true;
}

export function recordFailedAttempt(identifier: string): void {
  const now = Date.now();
  let limitData = rateLimits.get(identifier);
  
  if (!limitData) {
    limitData = { attempts: [] };
  }
  
  limitData.attempts.push(now);
  rateLimits.set(identifier, limitData);
}

export function clearFailedAttempts(identifier: string): void {
  rateLimits.delete(identifier);
}

export function validateCsrfToken(sessionCsrf: string, providedCsrf: string): boolean {
  return sessionCsrf === providedCsrf;
}

// Cleanup expired sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.last_activity > SESSION_TIMEOUT) {
      sessions.delete(id);
    }
  }
}, 60000); // Every minute
