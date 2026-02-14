import { loadConfig, saveConfig, type Config } from "./config.ts";
import { createSession, getSession, destroySession, type SessionData } from "./session.ts";

export interface AuthCheckResponse {
  setup_complete: boolean;
}

export interface AuthResponse {
  success: boolean;
  token?: string;
  message?: string;
}

const MIN_PASSWORD_LENGTH = 8;

export async function checkSetup(): Promise<AuthCheckResponse> {
  const config = await loadConfig();
  return {
    setup_complete: !!config.password_hash,
  };
}

export async function setupPassword(password: string): Promise<AuthResponse> {
  const config = await loadConfig();
  
  if (config.password_hash) {
    return {
      success: false,
      message: "Setup already completed",
    };
  }
  
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    return {
      success: false,
      message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    };
  }
  
  const passwordHash = await hashPassword(password);

  config.password_hash = passwordHash;
  await saveConfig(config);
  
  const session = await createSession();
  
  return {
    success: true,
    token: session.session_id,
  };
}

export async function login(
  password: string,
  ip: string,
  userAgent: string
): Promise<AuthResponse> {
  const config = await loadConfig();
  
  if (!config.password_hash) {
    return {
      success: false,
      message: "Setup not completed",
    };
  }
  
  const isValid = await verifyPassword(password, config.password_hash);

  if (!isValid) {
    return {
      success: false,
      message: "Invalid password",
    };
  }
  
  const session = await createSession(ip, userAgent);
  
  return {
    success: true,
    token: session.session_id,
  };
}

export async function logout(sessionId: string): Promise<void> {
  await destroySession(sessionId);
}

export async function validateSession(
  sessionId: string,
  ip: string,
  userAgent: string
): Promise<SessionData | null> {
  return await getSession(sessionId, ip, userAgent);
}

const encoder = new TextEncoder();

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );

  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: 100_000,
      hash: "SHA-256",
    },
    key,
    256,
  );

  const hashArray = new Uint8Array(derived);
  const combined = new Uint8Array(salt.length + hashArray.length);

  combined.set(salt);
  combined.set(hashArray, salt.length);

  return btoa(String.fromCharCode(...combined));
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const combined = Uint8Array.from(atob(stored), c => c.charCodeAt(0));

  const salt = combined.slice(0, 16);
  const hash = combined.slice(16);

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );

  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: 100_000,
      hash: "SHA-256",
    },
    key,
    256,
  );

  //return crypto.timingSafeEqual(new Uint8Array(derived), hash);
  
  const derivedArray = new Uint8Array(derived);

  if (derivedArray.length !== hash.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < derivedArray.length; i++) {
    diff |= derivedArray[i] ^ hash[i];
  }

  return diff === 0;

}