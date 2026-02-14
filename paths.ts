import { join, dirname } from "https://deno.land/std@0.202.0/path/mod.ts";

// ============================================================================
// ROOT RESOLUTION
// ============================================================================

function resolveRootDir(): string {
  const execPath = Deno.execPath();

  // If running via `deno run`
  if (execPath.toLowerCase().includes("deno")) {
    return Deno.cwd();
  }

  // If running compiled binary
  return dirname(execPath);
}

// ============================================================================
// BASE PATHS
// ============================================================================

export const ROOT_DIR = resolveRootDir();
export const BIN_DIR = join(ROOT_DIR, "bin");
export const DOWNLOADS_DIR = join(ROOT_DIR, "downloads");
export const PUBLIC_DIR = join(ROOT_DIR, "public");
export const LOGS_DIR = join(ROOT_DIR, "logs");
export const CONFIG_FILE = join(ROOT_DIR, "config.json");

// ============================================================================
// RUNTIME BINARIES
// ============================================================================

function resolveYtDlpPath(): string {
  const envPath = Deno.env.get("YT_DLP_PATH");

  if (envPath && envPath.trim() !== "") {
    return envPath;
  }

  const isWindows = Deno.build.os === "windows";
  const binary = isWindows ? "yt-dlp.exe" : "yt-dlp";

  return join(BIN_DIR, binary);
}

function resolveFfmpegPath(): string {
  const isWindows = Deno.build.os === "windows";
  const binary = isWindows ? "ffmpeg.exe" : "ffmpeg";

  return join(BIN_DIR, binary);
}

function resolveDenoPath(): string {
  const isWindows = Deno.build.os === "windows";
  const binary = isWindows ? "deno.exe" : "deno";
  return join(BIN_DIR, binary);
}

export const YT_DLP_PATH = resolveYtDlpPath();
export const FFMPEG_PATH = resolveFfmpegPath();
export const DENO_PATH = resolveDenoPath();