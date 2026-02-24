import { exists } from "https://deno.land/std@0.208.0/fs/mod.ts";
import { join, dirname } from "https://deno.land/std@0.202.0/path/mod.ts";

// ============================================================================
// ROOT RESOLUTION (SELF-CONTAINED — NO CIRCULAR IMPORTS)
// ============================================================================

function resolveRootDir(): string {
  const execPath = Deno.execPath();

  if (execPath.toLowerCase().includes("deno")) {
    return Deno.cwd();
  }

  return dirname(execPath);
}

const ROOT_DIR = resolveRootDir();
const CONFIG_FILE = join(ROOT_DIR, "config.json");

// ============================================================================
// CONFIG INTERFACE
// ============================================================================

export interface Config {
  search_results: number;
  max_duration: number;
  max_file_size: number;
  id3_comment: string;
  cleanup_enabled: boolean;
  cleanup_interval: number;
  cleanup_max_age: number;
  startup_cleanup: boolean;
  session_timeout: number;
  require_auth_home: boolean;
  require_auth_api: boolean;
  cors_allowed_origins: string[];
  allowed_download_domains: string[];
  rate_limit_search_per_minute: number;
  rate_limit_download_per_minute: number;
  password_hash?: string;
}

// ============================================================================
// DEFAULTS
// ============================================================================

const DEFAULT_CONFIG: Config = {
  search_results: 40,
  max_duration: 600,
  max_file_size: 500,
  id3_comment: "Downloaded via YouTube API",
  cleanup_enabled: true,
  cleanup_interval: 5,
  cleanup_max_age: 10,
  startup_cleanup: true,
  session_timeout: 30,
  require_auth_home: false,
  require_auth_api: false,
  cors_allowed_origins: [],
  allowed_download_domains: ["youtube.com", "youtu.be"],
  rate_limit_search_per_minute: 30,
  rate_limit_download_per_minute: 15,
};

// ============================================================================
// LOAD / SAVE
// ============================================================================

export async function loadConfig(): Promise<Config> {
  try {
    if (await exists(CONFIG_FILE)) {
      const text = await Deno.readTextFile(CONFIG_FILE);
      const savedConfig = JSON.parse(text);
      return { ...DEFAULT_CONFIG, ...savedConfig };
    }
  } catch (error) {
    console.error(`Failed to load config: ${error}`);
  }

  return { ...DEFAULT_CONFIG };
}

export async function saveConfig(config: Config): Promise<void> {
  const json = JSON.stringify(config, null, 2);
  await Deno.writeTextFile(CONFIG_FILE, json);
}

// ============================================================================
// VALIDATION
// ============================================================================

export function validateConfig(update: Partial<Config>) {
  const errors: string[] = [];

  if (update.search_results !== undefined) {
    if (
      typeof update.search_results !== "number" ||
      update.search_results < 1 ||
      update.search_results > 100
    ) {
      errors.push("search_results must be between 1 and 100");
    }
  }

  if (update.max_duration !== undefined) {
    if (
      typeof update.max_duration !== "number" ||
      update.max_duration < 1 ||
      update.max_duration > 7200
    ) {
      errors.push("max_duration must be between 1 and 7200 seconds");
    }
  }

  if (update.max_file_size !== undefined) {
    if (
      typeof update.max_file_size !== "number" ||
      update.max_file_size < 1 ||
      update.max_file_size > 5000
    ) {
      errors.push("max_file_size must be between 1 and 5000 MB");
    }
  }

  if (update.id3_comment !== undefined) {
    if (typeof update.id3_comment !== "string") {
      errors.push("id3_comment must be a string");
    }
  }

  if (update.cleanup_enabled !== undefined) {
    if (typeof update.cleanup_enabled !== "boolean") {
      errors.push("cleanup_enabled must be a boolean");
    }
  }

  if (update.cleanup_interval !== undefined) {
    if (
      typeof update.cleanup_interval !== "number" ||
      update.cleanup_interval < 1 ||
      update.cleanup_interval > 120
    ) {
      errors.push("cleanup_interval must be between 1 and 120 minutes");
    }
  }

  if (update.cleanup_max_age !== undefined) {
    if (
      typeof update.cleanup_max_age !== "number" ||
      update.cleanup_max_age < 1 ||
      update.cleanup_max_age > 1440
    ) {
      errors.push("cleanup_max_age must be between 1 and 1440 minutes");
    }
  }

  if (update.startup_cleanup !== undefined) {
    if (typeof update.startup_cleanup !== "boolean") {
      errors.push("startup_cleanup must be a boolean");
    }
  }

  if (update.session_timeout !== undefined) {
    if (
      typeof update.session_timeout !== "number" ||
      update.session_timeout < 5 ||
      update.session_timeout > 1440
    ) {
      errors.push("session_timeout must be between 5 and 1440 minutes");
    }
  }

  if (update.require_auth_home !== undefined) {
    if (typeof update.require_auth_home !== "boolean") {
      errors.push("require_auth_home must be a boolean");
    }
  }

  if (update.require_auth_api !== undefined) {
    if (typeof update.require_auth_api !== "boolean") {
      errors.push("require_auth_api must be a boolean");
    }
  }

  if (update.cors_allowed_origins !== undefined) {
    if (
      !Array.isArray(update.cors_allowed_origins) ||
      !update.cors_allowed_origins.every((v) => typeof v === "string")
    ) {
      errors.push("cors_allowed_origins must be an array of strings");
    }
  }

  if (update.allowed_download_domains !== undefined) {
    if (
      !Array.isArray(update.allowed_download_domains) ||
      !update.allowed_download_domains.every((v) => typeof v === "string")
    ) {
      errors.push("allowed_download_domains must be an array of strings");
    }
  }

  if (update.rate_limit_search_per_minute !== undefined) {
    if (
      typeof update.rate_limit_search_per_minute !== "number" ||
      update.rate_limit_search_per_minute < 1 ||
      update.rate_limit_search_per_minute > 600
    ) {
      errors.push("rate_limit_search_per_minute must be between 1 and 600");
    }
  }

  if (update.rate_limit_download_per_minute !== undefined) {
    if (
      typeof update.rate_limit_download_per_minute !== "number" ||
      update.rate_limit_download_per_minute < 1 ||
      update.rate_limit_download_per_minute > 300
    ) {
      errors.push("rate_limit_download_per_minute must be between 1 and 300");
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ============================================================================
// HELPERS
// ============================================================================

export function sanitizeString(input: string): string {
  let cleaned = "";
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    const isControl = (code >= 0x00 && code <= 0x1f) || code === 0x7f;
    if (!isControl) cleaned += ch;
  }
  return cleaned.trim();
}

export function validateDownloadDir(path: string): boolean {
  if (typeof path !== "string" || path.trim() === "") return false;
  if (path.includes("..")) return false;
  if (path.includes("\0")) return false;
  if (/[<>"|?*]/.test(path)) return false;
  return true;
}

export function validateFilePath(path: string): boolean {
  if (path.includes("..")) return false;
  if (path.includes("\0")) return false;
  if (/[<>"|?*]/.test(path)) return false;
  return true;
}
