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

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ============================================================================
// HELPERS
// ============================================================================

export function sanitizeString(input: string): string {
  let cleaned = input.replace(/\0/g, "");
  cleaned = cleaned.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, "");
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
