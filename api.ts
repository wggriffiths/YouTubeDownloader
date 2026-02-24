#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-run --allow-env

/**
 * YouTube Downloader API - Deno/TypeScript Port
 * Version: 1.0.9
 * 
 * COMPLETE FIX for playlist progress tracking and cross-platform compatibility
 * 
 * Key fixes:
 * 1. Auto-detect playlists from URL (frontend compatibility)
 * 2. Read from stdout with proper flags (--newline, --progress)
 * 3. Comprehensive logging for debugging
 * 4. Handle geo-blocked videos gracefully
 * 5. Smart artist extraction for proper "Artist - Song.mp3" format
 * 6. Cross-platform ZIP creation (Windows/Linux/Mac)
 * 7. Playlist-named ZIP files: EDM.zip, Chill Vibes.zip, etc.
 * 8. NATIVE system commands for instant ZIP (PowerShell/zip) - 100x faster!
 * 
 * v1.0.9 Changes:
 * - FIXED: Added routes for /login.html and /config.html
 * - Now you can access the admin panel and login page
 * 
 * v1.0.6 Changes:
 * - SECURITY: Added session-based authentication system
 * - SECURITY: Argon2id password hashing
 * - SECURITY: CSRF protection for admin routes
 * - SECURITY: Rate limiting (5 attempts/15 min)
 * - SECURITY: 30-minute session timeout
 * - NEW: Admin dashboard at /config.html
 * - NEW: Config management via /config endpoint
 * - NEW: Log viewer at /admin/logs
 * - NEW: yt-dlp updater at /admin/update-ytdlp
 * 
 * v1.0.5 Changes:
 * - FIXED: Video audio format now AAC instead of opus
 * - Added --recode-video mp4 for proper MP4 encoding
 * - Added --postprocessor-args "ffmpeg:-c:a aac -c:v copy" to convert audio
 * - Fixes media player compatibility issues (opus audio in MP4 won't play)
 * - Applies to both single video downloads and video playlists
 * 
 * v1.0.4 Changes:
 * - FIXED: Playlists now respect format_type parameter
 * - Video playlists now download as .mp4 files, not audio
 * - Conditional args based on format_type (same logic as single downloads)
 * - Video playlists use simpler naming: "01 - Title.mp4"
 * - Audio playlists still use artist parsing: "01 - Artist - Title.mp3"
 * 
 * v1.0.3 Changes:
 * - SMART ARTIST PARSING: Detects if title already has "Artist - Song" format
 * - If title has " - ", extracts artist and song separately
 * - If title is just song name, uses channel name as artist
 * - Prevents duplication like "EminemMusic - Eminem - Lose Yourself.mp3"
 * - Result: "Eminem - Lose Yourself.mp3" (clean, correct format)
 * - Applies to both single downloads and playlists
 */

import { loadConfig, saveConfig } from "./config.ts";
import { handleCli, isRunningAsService, runAsWindowsService } from "./service.ts";
import { join, basename } from "https://deno.land/std@0.202.0/path/mod.ts";
import { Application, Router, send } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import type { Context, Next } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { exists } from "https://deno.land/std@0.208.0/fs/mod.ts";

// ============================================================================
// SECURITY IMPORTS
// ============================================================================
import { securityHeadersMiddleware } from "./middleware/security.ts";
import { getSessionIdFromContext } from "./session.ts";
import { validateSession } from "./auth.ts";
import authRouter from "./routes/auth.ts";
import adminRouter from "./routes/admin.ts";

// ============================================================================
// CONFIGURATION
// ============================================================================
import { 
  ROOT_DIR,
  BIN_DIR,
  DOWNLOADS_DIR,
  PUBLIC_DIR,
  LOGS_DIR,
  CONFIG_FILE,
  YT_DLP_PATH,
  DENO_PATH
} from "./paths.ts";

import * as log from "https://deno.land/std@0.208.0/log/mod.ts";

await Deno.mkdir(LOGS_DIR, { recursive: true });
await log.setup({
  handlers: {
    console: new log.handlers.ConsoleHandler("DEBUG"),
    file: new log.handlers.FileHandler("DEBUG", {
      filename: join(LOGS_DIR, "app.log"),
      formatter: (record) =>
        `${new Date().toISOString()} - ${record.levelName} - ${record.msg}`,
    }),
  },

  loggers: {
    default: {
      level: "DEBUG",
      handlers: ["console", "file"],
    },
  },
});

// Port can be set via: --port flag > PORT env var > default 8000
let PORT = parseInt(Deno.env.get("PORT") || "8000");

// ============================================================================
// EMBEDDED PUBLIC ASSETS (deno compile --include public/)
// ============================================================================

const EMBED_PUBLIC_URL = new URL("./public/", import.meta.url);

function isRunningCompiledBinary(): boolean {
  return !Deno.execPath().toLowerCase().includes("deno");
}

function getStaticMimeType(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".html")) return "text/html";
  if (lower.endsWith(".js")) return "application/javascript";
  if (lower.endsWith(".css")) return "text/css";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".ico")) return "image/x-icon";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

async function readEmbeddedPublicFile(relativePath: string): Promise<Uint8Array> {
  const safePath = relativePath.replaceAll("\\", "/");
  const fileUrl = new URL(safePath, EMBED_PUBLIC_URL);
  return await Deno.readFile(fileUrl);
}

async function readPublicTextFile(relativePath: string): Promise<string> {
  const diskPath = join(PUBLIC_DIR, relativePath);
  if (await exists(diskPath)) {
    return await Deno.readTextFile(diskPath);
  }
  const data = await readEmbeddedPublicFile(relativePath);
  return new TextDecoder().decode(data);
}

async function sendPublicFile(ctx: Context, relativePath: string): Promise<void> {
  const diskPath = join(PUBLIC_DIR, relativePath);
  if (await exists(diskPath)) {
    await send(ctx, relativePath, { root: PUBLIC_DIR });
    return;
  }

  const data = await readEmbeddedPublicFile(relativePath);
  ctx.response.type = getStaticMimeType(relativePath);
  ctx.response.body = data;
}

async function copyEmbeddedPublicDir(source: URL, destination: string): Promise<void> {
  for await (const entry of Deno.readDir(source)) {
    const srcUrl = new URL(`${entry.name}${entry.isDirectory ? "/" : ""}`, source);
    const destPath = join(destination, entry.name);

    if (entry.isDirectory) {
      await Deno.mkdir(destPath, { recursive: true });
      await copyEmbeddedPublicDir(srcUrl, destPath);
      continue;
    }

    if (entry.isFile) {
      const data = await Deno.readFile(srcUrl);
      await Deno.writeFile(destPath, data);
    }
  }
}

async function ensurePublicAssetsExtracted(): Promise<void> {
  if (!isRunningCompiledBinary()) return;

  const indexPath = join(PUBLIC_DIR, "index.html");
  if (await exists(indexPath)) return;

  await Deno.mkdir(PUBLIC_DIR, { recursive: true });

  try {
    await copyEmbeddedPublicDir(EMBED_PUBLIC_URL, PUBLIC_DIR);
    logInfo(`✓ Extracted embedded public assets to ${PUBLIC_DIR}`);
  } catch (err) {
    logWarning(`⚠ Failed to extract embedded public assets: ${err}`);
  }
}

//function resolveYtDlpPath(): string {
//  const envPath = Deno.env.get("YT_DLP_PATH");
//  if (envPath && envPath.trim() !== "") {
//    return envPath;
//  }
//
//  const isWindows = Deno.build.os === "windows";
//  const ytBinary = isWindows ? "yt-dlp.exe" : "yt-dlp";
//
//  return join(BIN_DIR, ytBinary);
//}
//
//export const YT_DLP_PATH = resolveYtDlpPath();
//
// ============================================================================
// TYPES
// ============================================================================

type JobStatus = "pending" | "processing" | "completed" | "failed" | "playlist" | "interrupted";

interface Job {
  id: string;
  status: JobStatus;
  url: string;
  format_type: "audio" | "video";
  quality: string;
  playlist: boolean;
  created_at: number;
  message?: string;
  error?: string;
  file_path?: string;
  file_name?: string;

  // Progress tracking
  percent?: number;            // 0-100
  speed?: string;              // e.g. "3.2MiB/s"
  eta?: string;                // e.g. "00:12"
  file_size?: string;          // e.g. "9.8MiB"

  // Playlist-specific fields (match Python API exactly)
  playlist_title?: string;
  total_videos?: number;
  current_video?: number;
  current_title?: string;
  video_titles?: string[];
  skipped_videos?: string[];   // Track geo-blocked/unavailable

  // Process handle for cancellation
  _process?: Deno.ChildProcess;
}

interface DownloadRequest {
  url: string;
  format_type?: "audio" | "video";
  quality?: string;
  playlist?: boolean;
}

interface SearchRequest {
  query: string;
}

interface SearchResult {
  id: string;
  title: string;
  url: string;
  thumbnail: string;
  duration: number;
  channel: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

// ============================================================================
// JOB STORE
// ============================================================================

const jobs = new Map<string, Job>();
const lastStatusWrite = new Map<string, number>();
const apiRateLimits = new Map<string, number[]>();

const META_FILENAME = "metadata.json";
const STATUS_FILENAME = "status.json";

type StoredStatus = "queued" | "downloading" | "complete" | "failed" | "interrupted";

function jobDir(jobId: string): string {
  return join(DOWNLOADS_DIR, jobId);
}

function getClientIp(ctx: Context): string {
  // Do not trust X-Forwarded-For by default; it is user-controlled unless a
  // trusted reverse proxy is explicitly configured.
  return ctx.request.ip;
}

function checkApiRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const hits = (apiRateLimits.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length === 0) {
    apiRateLimits.delete(key);
  }
  if (hits.length >= limit) {
    apiRateLimits.set(key, hits);
    return false;
  }
  hits.push(now);
  apiRateLimits.set(key, hits);
  return true;
}

// Periodically sweep stale rate-limit keys to bound memory growth.
setInterval(() => {
  const now = Date.now();
  const maxWindowMs = 60_000; // current API rate-limits are per-minute windows
  for (const [key, hits] of apiRateLimits.entries()) {
    const recent = hits.filter((t) => now - t < maxWindowMs);
    if (recent.length === 0) {
      apiRateLimits.delete(key);
    } else {
      apiRateLimits.set(key, recent);
    }
  }
}, 5 * 60_000);

function getJobTitle(job: Job): string {
  return (
    job.playlist_title ||
    job.current_title ||
    job.file_name ||
    job.url
  );
}

function toStoredStatus(jobStatus: JobStatus): StoredStatus {
  switch (jobStatus) {
    case "pending":
      return "queued";
    case "processing":
    case "playlist":
      return "downloading";
    case "completed":
      return "complete";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
  }
}

function fromStoredStatus(stored: string): JobStatus {
  switch (stored) {
    case "queued":
      return "pending";
    case "downloading":
      return "interrupted";
    case "complete":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    default:
      return "failed";
  }
}

function getJobProgress(job: Job): number {
  if (typeof job.percent === "number") return Math.max(0, Math.min(100, job.percent));
  if (job.total_videos && job.current_video) {
    return Math.max(0, Math.min(100, Math.round((job.current_video / job.total_videos) * 100)));
  }
  return 0;
}

async function writeJobMetadata(job: Job): Promise<void> {
  const dir = jobDir(job.id);
  await Deno.mkdir(dir, { recursive: true });
  const metadata = {
    id: job.id,
    url: job.url,
    title: getJobTitle(job),
    created_at: job.created_at,
    file_path: job.file_path || "",
    format_type: job.format_type,
    quality: job.quality,
    playlist: job.playlist,
    playlist_title: job.playlist_title || "",
    total_videos: job.total_videos || 0,
    current_video: job.current_video || 0,
    video_titles: job.video_titles || [],
    skipped_videos: job.skipped_videos || [],
  };
  await Deno.writeTextFile(join(dir, META_FILENAME), JSON.stringify(metadata, null, 2));
}

async function writeJobStatus(job: Job, force = false): Promise<void> {
  const now = Date.now();
  const last = lastStatusWrite.get(job.id) || 0;
  if (!force && now - last < 1500) return;
  lastStatusWrite.set(job.id, now);

  const dir = jobDir(job.id);
  await Deno.mkdir(dir, { recursive: true });
  const status = {
    status: toStoredStatus(job.status),
    progress: getJobProgress(job),
  };
  await Deno.writeTextFile(join(dir, STATUS_FILENAME), JSON.stringify(status, null, 2));
}

async function findMediaFileForJob(jobId: string, formatType?: "audio" | "video"): Promise<string | null> {
  const dir = jobDir(jobId);
  const preferredExt = formatType === "video" ? [".mp4", ".mkv", ".webm"] : [".mp3", ".m4a", ".ogg", ".wav", ".flac"];
  const fallbackExt = [".mp3", ".m4a", ".ogg", ".wav", ".flac", ".mp4", ".mkv", ".webm"];
  const allowed = new Set([...preferredExt, ...fallbackExt]);
  const candidates: string[] = [];

  try {
    for await (const entry of Deno.readDir(dir)) {
      if (!entry.isFile) continue;
      const name = entry.name.toLowerCase();
      if (name === META_FILENAME || name === STATUS_FILENAME) continue;
      if (name.includes(".part") || name.includes(".temp.")) continue;
      if (![...allowed].some((ext) => name.endsWith(ext))) continue;
      candidates.push(entry.name);
    }
  } catch {
    return null;
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.localeCompare(b));
  return join(dir, candidates[0]);
}

async function rebuildQueueFromDisk(): Promise<void> {
  const config = await loadConfig();
  if (config.startup_cleanup) {
    logInfo("⏭ Queue rebuild skipped (startup cleanup enabled)");
    return;
  }

  try {
    await Deno.stat(DOWNLOADS_DIR);
  } catch {
    return;
  }

  for await (const entry of Deno.readDir(DOWNLOADS_DIR)) {
    if (!entry.isDirectory) continue;

    const dir = join(DOWNLOADS_DIR, entry.name);
    const metaPath = join(dir, META_FILENAME);
    const statusPath = join(dir, STATUS_FILENAME);

    let meta: Record<string, unknown> | null = null;
    let status: Record<string, unknown> = { status: "failed", progress: 0 };

    try {
      meta = asRecord(JSON.parse(await Deno.readTextFile(metaPath)));
    } catch {
      continue;
    }
    if (!meta) continue;

    try {
      const parsedStatus = asRecord(JSON.parse(await Deno.readTextFile(statusPath)));
      if (parsedStatus) status = parsedStatus;
    } catch {
      // keep default failed status
    }

    const jobId = typeof meta.id === "string" && meta.id.trim() ? meta.id : entry.name;
    const storedStatus = typeof status.status === "string" ? status.status : "failed";
    const metaFilePath = typeof meta.file_path === "string" && meta.file_path ? meta.file_path : undefined;
    const job: Job = {
      id: jobId,
      status: fromStoredStatus(storedStatus),
      url: typeof meta.url === "string" ? meta.url : "",
      format_type: meta.format_type === "video" ? "video" : "audio",
      quality: typeof meta.quality === "string" && meta.quality ? meta.quality : "best",
      playlist: !!meta.playlist,
      created_at: typeof meta.created_at === "number" ? meta.created_at : Date.now(),
      message: undefined,
      error: undefined,
      file_path: metaFilePath,
      file_name: metaFilePath ? basename(metaFilePath) : undefined,
      percent: typeof status.progress === "number" ? status.progress : undefined,
      playlist_title: typeof meta.playlist_title === "string" && meta.playlist_title
        ? meta.playlist_title
        : undefined,
      total_videos: typeof meta.total_videos === "number" ? meta.total_videos : undefined,
      current_video: typeof meta.current_video === "number" ? meta.current_video : undefined,
      video_titles: Array.isArray(meta.video_titles)
        ? meta.video_titles.filter((v): v is string => typeof v === "string")
        : undefined,
      skipped_videos: Array.isArray(meta.skipped_videos)
        ? meta.skipped_videos.filter((v): v is string => typeof v === "string")
        : undefined,
    };

    // Validate completed files
    if (job.status === "completed") {
      if (!job.file_path || !await exists(job.file_path)) {
        const resolvedPath = await findMediaFileForJob(job.id, job.format_type);
        if (resolvedPath) {
          job.file_path = resolvedPath;
          job.file_name = basename(resolvedPath);
        } else {
          job.status = "failed";
          job.error = "Output file missing after restart";
        }
      }
    }

    // If previously downloading, mark interrupted and persist
    if (storedStatus === "downloading") {
      job.status = "interrupted";
    }

    jobs.set(job.id, job);
    await writeJobMetadata(job);
    await writeJobStatus(job, true);
  }

  logInfo(`✓ Queue rebuild complete (${jobs.size} jobs)`);
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function generateJobId(): string {
  return crypto.randomUUID();
}

async function ensureDownloadDir(jobId: string): Promise<string> {
  //const dir = `${DOWNLOAD_DIR}/${jobId}`;
  const dir = join(DOWNLOADS_DIR, jobId);
  await Deno.mkdir(dir, { recursive: true });
  return dir;
}

// ============================================================================
// LOGGING WITH FILE OUTPUT
// ============================================================================

async function writeToLogFile(message: string) {
  try {
    const logPath = join(LOGS_DIR, "app.log");
    const timestamp = new Date().toISOString();
    const logLine = `${timestamp} - ${message}\n`;
    await Deno.writeTextFile(logPath, logLine, { append: true });
  } catch (e) {
    // Silent fail - don't crash if log file can't be written
    console.error(`Failed to write to log file: ${e}`);
  }
}

function logInfo(message: string) {
  const msg = `INFO - ${message}`;
  console.log(`[INFO] ${message}`);
  writeToLogFile(msg); // Write to file
}

function logError(message: string) {
  const msg = `ERROR - ${message}`;
  console.error(`[ERROR] ${message}`);
  writeToLogFile(msg); // Write to file
}

function logDebug(message: string) {
  const msg = `DEBUG - ${message}`;
  console.log(`[DEBUG] ${message}`);
  writeToLogFile(msg); // Write to file
}

function logWarning(message: string) {
  const msg = `WARNING - ${message}`;
  console.warn(`[WARNING] ${message}`);
  writeToLogFile(msg); // Write to file
}

// ============================================================================
// YT-DLP INTEGRATION
// ============================================================================

async function searchYouTube(query: string): Promise<SearchResult[]> {
  logInfo(`Searching YouTube for: ${query}`);

  const config = await loadConfig();

  const command = new Deno.Command(YT_DLP_PATH, {
    args: [
      "--dump-json",
      "--flat-playlist",
      "--skip-download",
      `ytsearch${config.search_results}:${query}`,
    ],
    stdout: "piped",
    stderr: "piped",
  });

  const { stdout, stderr, code } = await command.output();

  if (code !== 0) {
    const error = new TextDecoder().decode(stderr);
    logError(`Search failed: ${error}`);
    return [];
  }

  const output = new TextDecoder().decode(stdout);
  const results: SearchResult[] = [];

  for (const line of output.trim().split("\n")) {
    if (!line.trim()) continue;

    try {
      const data = JSON.parse(line);
      results.push({
        id: data.id || "",
        title: data.title || "Unknown",
        url: data.webpage_url || data.url || `https://youtube.com/watch?v=${data.id}`,
        thumbnail: data.thumbnail || `https://img.youtube.com/vi/${data.id}/hqdefault.jpg`,
        duration: data.duration || 0,
        channel: data.uploader || data.channel || "Unknown",
      });
    } catch (e) {
      logError(`Failed to parse search result: ${e}`);
    }
  }

  logInfo(`Found ${results.length} search results`);
  return results;
}

/**
 * Parse a yt-dlp progress line and update job fields.
 * Lines look like: [download]  67.3% of   9.80MiB at    3.21MiB/s ETA 00:12
 *             or:  [download]  67.3% of ~  9.80MiB at    3.21MiB/s ETA 00:12
 */
function parseProgress(line: string, job: Job): boolean {
  const m = line.match(
    /\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\S+)\s+at\s+([\d.]+\S+)\s+ETA\s+(\S+)/i
  );
  if (m) {
    job.percent = parseFloat(m[1]);
    job.file_size = m[2];
    job.speed = m[3];
    job.eta = m[4];
    return true;
  }
  // Also match 100% line: [download] 100% of 9.80MiB in 00:03
  const m2 = line.match(/\[download\]\s+100%\s+of\s+~?\s*([\d.]+\S+)/i);
  if (m2) {
    job.percent = 100;
    job.file_size = m2[1];
    job.speed = undefined;
    job.eta = undefined;
    return true;
  }
  return false;
}

/**
 * Build cookie-related args for yt-dlp.
 * Uses cookies.txt from BIN_DIR if present and non-empty.
 */
async function getCookieArgs(): Promise<string[]> {
  const cookiesPath = join(BIN_DIR, "cookies.txt");

  try {
    const stat = await Deno.stat(cookiesPath);
    if (stat.isFile && stat.size > 0) {
      logInfo(`Using cookies file: ${cookiesPath}`);
      return ["--cookies", cookiesPath];
    } else {
      logWarning(`Cookies file exists but is empty: ${cookiesPath}`);
    }
  } catch {
    logWarning(`No cookies file found at: ${cookiesPath} — YouTube may block downloads`);
  }

  return [];
}

async function downloadVideo(job: Job, resume = false) {
  const jobId = job.id;
  const downloadDir = await ensureDownloadDir(jobId);

  job.status = "processing";
  await writeJobStatus(job, true);
  logInfo(`Starting download for job ${jobId}: ${job.url}`);

  const cookieArgs = await getCookieArgs();

  // Build PATH so yt-dlp can find deno + ffmpeg inside ./bin
  const sep = Deno.build.os === "windows" ? ";" : ":";
  const env = {
    ...Deno.env.toObject(),
    PATH: `${BIN_DIR}${sep}${Deno.env.get("PATH") ?? ""}`,
  };

  const args: string[] = [
    ...(resume ? ["--continue"] : []),
    "--no-playlist",
    "--ffmpeg-location", BIN_DIR,
    ...cookieArgs,
    "--format",
    job.format_type === "video"
      ? `bestvideo[height<=${job.quality}]+bestaudio[ext=m4a]/best[height<=${job.quality}]`
      : "bestaudio",
  ];

  if (job.format_type === "audio") {
    args.push(
      "--extract-audio",
      "--audio-format", "mp3",
      "--audio-quality", "0",
      "--embed-thumbnail",
      "--add-metadata",
      "--parse-metadata", "%(title)s:%(meta_artist)s - %(meta_title)s",
      "--parse-metadata", "%(uploader)s:%(meta_uploader)s",
      "--output",
      `${downloadDir}/%(meta_artist,meta_uploader,uploader|Unknown Artist)s - %(meta_title,title)s.%(ext)s`,
    );
  } else {
    args.push(
      "--merge-output-format", "mp4",
      "--embed-thumbnail",
      "--add-metadata",
      "--output",
      `${downloadDir}/%(title)s.%(ext)s`,
    );
  }

  args.push(
    "--newline",                  // Force line-by-line progress output
    "--progress",
    job.url,
  );

  const command = new Deno.Command(YT_DLP_PATH, {
    args,
    stdout: "piped",
    stderr: "piped",
    cwd: Deno.cwd(),
    env,
  });

  const process = command.spawn();
  job._process = process;

  const decoder = new TextDecoder();
  const stdoutReader = process.stdout.getReader();
  const stderrReader = process.stderr.getReader();
  let stderrText = "";

  // Read stdout for progress
  const readStdout = async () => {
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          logDebug(`yt-dlp stdout: ${line.trim()}`);
          if (parseProgress(line, job)) {
            await writeJobStatus(job);
          }
          // Capture destination filename (strip media extensions for display)
          const destMatch = line.match(/\[download\]\s+Destination:\s+.*[\/\\]([^\/\\]+?)\.(?:webm|m4a|opus|mp3|mp4|mkv|ogg|wav|flac)$/i);
          if (destMatch) {
            job.current_title = destMatch[1];
            await writeJobMetadata(job);
          }
        }
      }
    } catch (err) {
      logError(`Error reading stdout: ${err}`);
    }
  };

  // Read stderr for errors
  const readStderr = async () => {
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        stderrText += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.trim()) logDebug(`yt-dlp stderr: ${line.trim()}`);
        }
      }
    } catch (err) {
      logError(`Error reading stderr: ${err}`);
    }
  };

  await Promise.all([readStdout(), readStderr()]);
  const { code } = await process.status;
  job._process = undefined;

  if (code !== 0) {
    job.status = "failed";
    // Extract meaningful error from stderr
    const errorLine = stderrText.split("\n").filter(l => l.includes("ERROR")).pop();
    job.error = errorLine
      ? errorLine.replace(/^ERROR:\s*(\[.*?\]\s*\S+:\s*)?/, "").trim()
      : stderrText.trim() || "Download failed";
    await writeJobStatus(job, true);
    logError(`Download failed for job ${jobId}: ${job.error}`);
    return;
  }

  const outputPath = await findMediaFileForJob(jobId, job.format_type);
  if (!outputPath) {
    job.status = "failed";
    job.error = "No files downloaded";
    await writeJobStatus(job, true);
    logError(`No files found for job ${jobId}`);
    return;
  }

  job.status = "completed";
  job.percent = 100;
  job.file_name = basename(outputPath);
  job.file_path = outputPath;
  await writeJobMetadata(job);
  await writeJobStatus(job, true);

  logInfo(`Download completed for job ${jobId}: ${job.file_name}`);
}

async function downloadPlaylist(job: Job, resume = false) {
  const jobId = job.id;
  const downloadDir = await ensureDownloadDir(jobId);

  job.status = "playlist";
  await writeJobStatus(job, true);
  logInfo(`╔${"═".repeat(78)}╗`);
  logInfo(`║ PLAYLIST DOWNLOAD STARTED: ${jobId.substring(0, 50).padEnd(50)} ║`);
  logInfo(`╚${"═".repeat(78)}╝`);
  logInfo(`URL: ${job.url}`);

  const cookieArgs = await getCookieArgs();

  const args: string[] = [
    ...(resume ? ["--continue"] : []),
    "--yes-playlist",
    "--ignore-errors",            // Skip unavailable videos
    "--newline",                  // Force line-by-line output
    "--progress",                 // Force progress display
    "--console-title",            // Additional progress info
    ...cookieArgs,
    "--format",
    job.format_type === "video"
      ? `bestvideo[height<=${job.quality}]+bestaudio/best[height<=${job.quality}]`
      : "bestaudio",
  ];

  if (job.format_type === "audio") {
    args.push(
      "--extract-audio",
      "--audio-format", "mp3",
      "--audio-quality", "0",
      "--embed-thumbnail",
      "--add-metadata",
      // Smart parsing: if title has "Artist - Song", extract both; otherwise use uploader
      "--parse-metadata", "%(title)s:%(meta_artist)s - %(meta_title)s",
      "--parse-metadata", "%(uploader)s:%(meta_uploader)s",
      // Playlist format: "01 - Artist - Title.mp3"
      "--output", `${downloadDir}/%(playlist_index)02d - %(meta_artist,meta_uploader,uploader|Unknown Artist)s - %(meta_title,title)s.%(ext)s`,
    );
  } else {
    args.push(
      "--merge-output-format", "mp4",
      "--recode-video", "mp4",      // Force proper MP4 encoding
      "--postprocessor-args", "ffmpeg:-c:a aac -c:v copy",  // Convert audio to AAC, keep video as-is
      "--embed-thumbnail",
      "--add-metadata",
      // Video format: "01 - Title.mp4" (no artist parsing for video)
      "--output", `${downloadDir}/%(playlist_index)02d - %(title)s.%(ext)s`,
    );
  }

  args.push(job.url);

  logInfo(`Executing: yt-dlp ${args.join(" ")}`);

  // Build PATH so yt-dlp can find deno + ffmpeg inside ./bin
  const sep = Deno.build.os === "windows" ? ";" : ":";

  const env = {
    ...Deno.env.toObject(),
    PATH: `${BIN_DIR}${sep}${Deno.env.get("PATH") ?? ""}`,
  };

  // Force yt-dlp to use our bundled Deno runtime
  args.unshift(
    "--ffmpeg-location", BIN_DIR,
    "--js-runtimes", `deno:${DENO_PATH}`
  );

  logInfo(`DENO_PATH: ${DENO_PATH}`);
  logInfo(`YT_DLP_PATH: ${YT_DLP_PATH}`);
  logDebug(`Executing: ${YT_DLP_PATH} ${args.join(" ")}`);

  const command = new Deno.Command(YT_DLP_PATH, {
    args,
    stdout: "piped",
    stderr: "piped",
    env,
  });

  const process = command.spawn();
  job._process = process;

  const decoder = new TextDecoder();
  const stdoutReader = process.stdout.getReader();
  const stderrReader = process.stderr.getReader();

  // Initialize tracking
  job.total_videos = 0;
  job.current_video = 0;
  job.current_title = "";
  job.video_titles = [];
  job.skipped_videos = [];

  logInfo(`Initialized job tracking: total=0, current=0, titles=[]`);

  // Read stdout (where progress is written)
  const readStdout = async () => {
    try {
      let buffer = "";
      
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;
        
        // Process complete lines
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;
          
          // Log EVERY line from yt-dlp for debugging
          logDebug(`yt-dlp stdout: ${line.trim()}`);

          // Parse download progress (percent, speed, ETA, size)
          if (parseProgress(line, job)) {
            await writeJobStatus(job);
            continue;
          }

          // Pattern 1: [download] Downloading video N of M
          let match = line.match(/\[download\]\s+Downloading\s+(?:video|item)\s+(\d+)\s+of\s+(\d+)/i);
          if (match) {
            const current = parseInt(match[1], 10);
            const total = parseInt(match[2], 10);
            
            job.current_video = current;
            job.total_videos = total;
            job.current_title = "";  // clear stale title until new track's Destination line arrives
            job.percent = 0;         // reset per-track progress
            await writeJobMetadata(job);
            await writeJobStatus(job, true);

            logInfo(`┌─────────────────────────────────────────┐`);
            logInfo(`│ PROGRESS: ${current}/${total} (${Math.round(current/total*100)}%)`.padEnd(42) + `│`);
            logInfo(`└─────────────────────────────────────────┘`);
            continue;
          }

          // Pattern 2: [download] Destination: path/filename.ext
          match = line.match(/\[download\]\s+Destination:\s+.*[\/\\]([^\/\\]+?)\.(?:webm|m4a|opus|mp3|mp4)/i);
          if (match) {
            const title = match[1];
            if (title !== job.current_title) {
              job.current_title = title;
              if (!job.video_titles?.includes(title)) {
                job.video_titles?.push(title);
              }
              logInfo(`⬇️  Downloading: ${title}`);
            }
            await writeJobMetadata(job);
            continue;
          }

          // Pattern 3: [ExtractAudio] Destination: path/filename.mp3
          match = line.match(/\[ExtractAudio\]\s+Destination:\s+.*[\/\\]([^\/\\]+?)\.mp3/i);
          if (match) {
            const title = match[1];
            if (title !== job.current_title) {
              job.current_title = title;
              if (!job.video_titles?.includes(title)) {
                job.video_titles?.push(title);
              }
            }
            logInfo(`🎵 Converted: ${title}`);
            await writeJobMetadata(job);
            continue;
          }

          // Pattern 4: [download] 100% of ... (completion)
          match = line.match(/\[download\]\s+100%/i);
          if (match) {
            logInfo(`✓ Current track complete`);
            continue;
          }

          // Pattern 5: Playlist title - [download] Finished downloading playlist: NAME
          match = line.match(/\[download\]\s+Finished downloading playlist:\s+(.+)/i);
          if (match) {
            const playlistTitle = match[1].trim();
            job.playlist_title = playlistTitle;
            await writeJobMetadata(job);
            logInfo(`📋 Playlist: ${playlistTitle}`);
            continue;
          }

          // Pattern 6: Geo-blocked / unavailable (only match yt-dlp specific error patterns)
          match = line.match(/\[download\].*(?:unavailable|not available|geo[- ]?blocked|private video)/i);
          if (!match) {
            match = line.match(/^ERROR:.*(?:unavailable|not available|blocked|Sign in|private)/i);
          }
          if (match) {
            logInfo(`⚠️  Skipped unavailable video: ${line.trim()}`);
            if (job.current_title && !job.skipped_videos?.includes(job.current_title)) {
              job.skipped_videos?.push(job.current_title);
            }
            await writeJobMetadata(job);
            continue;
          }
        }
      }
      
      // Process any remaining buffer
      if (buffer.trim()) {
        logDebug(`yt-dlp stdout (final): ${buffer.trim()}`);
      }
    } catch (err) {
      logError(`Error reading stdout: ${err}`);
    }
  };

  // Collect stderr errors so we can surface them in failure messages
  const stderrErrors: string[] = [];

  // Read stderr for errors
  const readStderr = async () => {
    try {
      let buffer = "";

      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;

          // Log errors and warnings
          if (line.includes("ERROR") || line.includes("WARNING")) {
            logError(`yt-dlp: ${line.trim()}`);
            stderrErrors.push(line.trim());
          } else {
            logDebug(`yt-dlp stderr: ${line.trim()}`);
          }
        }
      }

      if (buffer.trim()) {
        logDebug(`yt-dlp stderr (final): ${buffer.trim()}`);
      }
    } catch (err) {
      logError(`Error reading stderr: ${err}`);
    }
  };

  logInfo(`Starting concurrent stream reading...`);
  await Promise.all([readStdout(), readStderr()]);
  logInfo(`Stream reading complete`);

  const { code } = await process.status;
  job._process = undefined;
  logInfo(`yt-dlp exited with code: ${code}`);

  const fileExtension = job.format_type === "audio" ? ".mp3" : ".mp4";
  const files: string[] = [];

  for await (const entry of Deno.readDir(downloadDir)) {
    if (!entry.isFile) continue;

    if (!entry.name.endsWith(fileExtension)) continue;

    if (entry.name.includes(".temp.")) continue;
    if (entry.name.includes(".part")) continue;

    const fullPath = `${downloadDir}/${entry.name}`;
    const stat = await Deno.stat(fullPath);

    if (stat.size === 0) continue;

    files.push(entry.name);
  }

  logInfo(`Found ${files.length} ${fileExtension} files in ${downloadDir}`);

  // Override total_videos with actual successful files
  job.total_videos = files.length;
  job.current_video = files.length;
  await writeJobMetadata(job);

  // Cleanup: Delete any leftover .temp.mp4 files
  for await (const entry of Deno.readDir(downloadDir)) {
    if (entry.isFile && entry.name.endsWith(".temp.mp4")) {
      try {
        await Deno.remove(join(downloadDir, entry.name));
        logInfo(`🗑️  Deleted temp file: ${entry.name}`);
      } catch (err) {
        logError(`Failed to delete temp file ${entry.name}: ${err}`);
      }
    }
  }

  // Only fail if we got NO files
  if (files.length === 0) {
    job.status = "failed";
    // Surface the actual yt-dlp error (e.g. "Sign in to confirm you're not a bot")
    const lastError = stderrErrors.filter(e => e.includes("ERROR")).pop();
    if (lastError) {
      // Extract the meaningful part after "ERROR: [youtube] ID:"
      const cleaned = lastError.replace(/^ERROR:\s*(\[.*?\]\s*\S+:\s*)?/, "").trim();
      job.error = cleaned || lastError;
    } else {
      job.error = code !== 0
        ? "All videos in playlist were unavailable or blocked"
        : "No files downloaded from playlist";
    }
    logError(`No ${fileExtension} files found for playlist job ${jobId} (exit code: ${code})`);
    logError(`Last stderr errors: ${stderrErrors.slice(-3).join(" | ")}`);
    await writeJobStatus(job, true);
    return;
  }

  // Success! We got files (even if some were skipped due to geo-blocking)
  if (code !== 0) {
    logInfo(`⚠️  Playlist completed with warnings (exit code ${code}) - ${files.length} files successfully downloaded`);
    if (job.skipped_videos && job.skipped_videos.length > 0) {
      logInfo(`   Skipped ${job.skipped_videos.length} unavailable videos`);
    }
  }

  // Create ZIP archive using native system commands (ultra-fast)
  // Use playlist title for filename (fallback to "playlist" if not detected)
  let zipBaseName = job.playlist_title || "playlist";
  
  // Sanitize filename - remove invalid characters
  zipBaseName = zipBaseName
    .replace(/[<>:"/\\|?*]/g, "_")  // Replace invalid chars with underscore
    .replace(/\s+/g, " ")            // Normalize whitespace
    .trim();
  
  const zipFileName = `${zipBaseName}.zip`;
  const zipPath = `${downloadDir}/${zipFileName}`;

  logInfo(`Creating ZIP archive: ${zipFileName} with ${files.length} files`);

  try {
    // Detect platform and use native ZIP command (10-100x faster than JSZip)
    const isWindows = Deno.build.os === "windows";
    
    if (isWindows) {
      // Windows: Use PowerShell Compress-Archive (native, fast, no dependencies)
      logInfo(`  Using PowerShell Compress-Archive...`);
      
      const filePaths = files.map(f => `"${downloadDir}/${f}"`).join(",");
      const psCommand = `Compress-Archive -Path ${filePaths} -DestinationPath "${zipPath}" -Force`;
      
      const command = new Deno.Command("powershell", {
        args: ["-NoProfile", "-Command", psCommand],
        stdout: "piped",
        stderr: "piped",
      });
      
      const { code, stderr } = await command.output();
      
      if (code !== 0) {
        const error = new TextDecoder().decode(stderr);
        throw new Error(`PowerShell Compress-Archive failed: ${error}`);
      }
    } else {
      // Linux/Mac: Use zip command (fast, standard on all systems)
      logInfo(`  Using system zip command...`);
      
      const command = new Deno.Command("zip", {
        args: [
          "-j",              // Junk paths (don't include directory structure)
          "-0",              // No compression (STORE mode - instant for MP3s)
          zipPath,           // Output file
          ...files.map(f => `${downloadDir}/${f}`)
        ],
        stdout: "piped",
        stderr: "piped",
      });
      
      const { code, stderr } = await command.output();
      
      if (code !== 0) {
        const error = new TextDecoder().decode(stderr);
        throw new Error(`zip command failed: ${error}`);
      }
    }
    
    // Verify ZIP was created
    if (!await exists(zipPath)) {
      throw new Error("ZIP file was not created");
    }
    
    const zipStat = await Deno.stat(zipPath);
    logInfo(`✓ Created ZIP archive: ${zipFileName} (${Math.round(zipStat.size / 1024)} KB)`);
  } catch (zipError) {
    logError(`Failed to create ZIP archive: ${zipError}`);
    job.status = "failed";
    job.error = `Failed to create ZIP archive: ${zipError}`;
    await writeJobStatus(job, true);
    return;
  }

  job.status = "completed";
  job.file_name = zipFileName;
  job.file_path = zipPath;
  job.message = `Downloaded ${files.length} videos`;
  await writeJobMetadata(job);
  await writeJobStatus(job, true);
  
  if (job.skipped_videos && job.skipped_videos.length > 0) {
    job.message += ` (${job.skipped_videos.length} unavailable)`;
  }

  logInfo(`╔${"═".repeat(78)}╗`);
  logInfo(`║ PLAYLIST COMPLETE: ${files.length} files`.padEnd(80) + `║`);
  if (job.skipped_videos && job.skipped_videos.length > 0) {
    logInfo(`║ Skipped: ${job.skipped_videos.length} unavailable`.padEnd(80) + `║`);
  }
  logInfo(`╚${"═".repeat(78)}╝`);
}

// ============================================================================
// CLEANUP TASKS
// ============================================================================

async function cleanupOrphanedFolders() {
  const config = await loadConfig();
  if (!config.startup_cleanup) {
    logInfo("⏭ Startup cleanup disabled in config");
    return;
  }

  logInfo("✓ Running startup cleanup...");

  try {
    // Ensure downloads directory exists before scanning
    try {
      await Deno.stat(DOWNLOADS_DIR);
    } catch {
      logInfo("No downloads directory found — nothing to clean");
      return;
    }

    for await (const entry of Deno.readDir(DOWNLOADS_DIR)) {
      if (entry.isDirectory) {
        const folderPath = join(DOWNLOADS_DIR, entry.name);

        try {
          await Deno.remove(folderPath, { recursive: true });
          logInfo(`Cleaned up orphaned folder: ${entry.name}`);
        } catch (e) {
          logError(`Failed to remove folder ${entry.name}: ${e}`);
        }
      }
    }

    logInfo("✓ Startup cleanup complete");

  } catch (e) {
    logError(`Startup cleanup error: ${e}`);
  }
}

async function periodicCleanup() {
  while (true) {
    const config = await loadConfig();
    const intervalMs = (config.cleanup_interval ?? 5) * 60_000;
    await new Promise(resolve => setTimeout(resolve, intervalMs));

    if (!config.cleanup_enabled) continue;

    try {
      const now = Date.now();
      const maxAgeMs = (config.cleanup_max_age ?? 10) * 60_000;

      for (const [jobId, job] of jobs.entries()) {
        const age = now - job.created_at;

        if (age > maxAgeMs && job.status === "completed") {
          try {
            const folderPath = join(DOWNLOADS_DIR, jobId);

            try {
              await Deno.stat(folderPath);
              await Deno.remove(folderPath, { recursive: true });
              logInfo(`Periodic cleanup: removed ${jobId}`);
            } catch {
              // folder doesn't exist
            }

            jobs.delete(jobId);
          } catch (e) {
            logError(`Periodic cleanup error for ${jobId}: ${e}`);
          }
        }
      }

      // Remove orphaned folders only if startup_cleanup is enabled
      // (On restart the jobs map is empty, so skip this unless explicitly opted-in)
      if (config.startup_cleanup) {
        try {
          await Deno.stat(DOWNLOADS_DIR);

          for await (const entry of Deno.readDir(DOWNLOADS_DIR)) {
            if (entry.isDirectory && !jobs.has(entry.name)) {
              try {
                const folderPath = join(DOWNLOADS_DIR, entry.name);
                await Deno.remove(folderPath, { recursive: true });
                logInfo(`Periodic cleanup: removed orphaned folder ${entry.name}`);
              } catch (e) {
                logError(`Error removing orphaned folder ${entry.name}: ${e}`);
              }
            }
          }
        } catch {
          // downloads directory doesn't exist
        }
      }

    } catch (e) {
      logError(`Error in cleanup task: ${e}`);
    }
  }
}

async function cleanupJobFiles(jobId: string) {
  const config = await loadConfig();
  if (!config.cleanup_enabled) return;

  const delayMs = (config.cleanup_max_age ?? 10) * 60_000;
  await new Promise(resolve => setTimeout(resolve, delayMs));

  try {
    const job = jobs.get(jobId);
    if (job && job.status === "completed") {
      const folderPath = join(DOWNLOADS_DIR, jobId);
      if (await exists(folderPath)) {
        await Deno.remove(folderPath, { recursive: true });
        logInfo(`Cleaned up directory for job ${jobId}`);
      }

      jobs.delete(jobId);
      logInfo(`Removed job ${jobId} from memory`);
    }
  } catch (e) {
    logError(`Cleanup error for job ${jobId}: ${e}`);
  }
}

// ============================================================================
// Bootstrap
// ============================================================================

async function bootstrapEnvironment() {
  await Deno.mkdir(BIN_DIR, { recursive: true });
  await Deno.mkdir(DOWNLOADS_DIR, { recursive: true });
  await Deno.mkdir(PUBLIC_DIR, { recursive: true });
  await Deno.mkdir(LOGS_DIR, { recursive: true });

  await ensureYtDlp();
  await ensureDeno();
  await ensureFfmpeg();
}

async function ensureDeno() {
  const isWindows = Deno.build.os === "windows";
  const isLinux = Deno.build.os === "linux";
  const isMac = Deno.build.os === "darwin";
  const arch = Deno.build.arch;

  const denoBinary = isWindows ? "deno.exe" : "deno";
  const denoPath = join(BIN_DIR, denoBinary);

  try {
    await Deno.stat(denoPath);
    logInfo(`✓ Found ${denoBinary}`);
    return denoPath;
  } catch {
    logInfo("[*] Installing Deno runtime...");
  }

  let url = "";

  if (isWindows) {
    url = arch === "aarch64"
      ? "https://github.com/denoland/deno/releases/latest/download/deno-aarch64-pc-windows-msvc.zip"
      : "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip";
  }
  else if (isLinux) {
    url = arch === "aarch64"
      ? "https://github.com/denoland/deno/releases/latest/download/deno-aarch64-unknown-linux-gnu.zip"
      : "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip";
  }
  else if (isMac) {
    url = arch === "aarch64"
      ? "https://github.com/denoland/deno/releases/latest/download/deno-aarch64-apple-darwin.zip"
      : "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-apple-darwin.zip";
  }

  if (!url) {
    throw new Error(`Unsupported platform: ${Deno.build.os}/${arch}`);
  }

  logInfo(`Downloading Deno for ${Deno.build.os}/${arch}`);
  logInfo(`Source: ${url}`);

  const archivePath = join(ROOT_DIR, "deno.zip");
  const extractDir = join(ROOT_DIR, "deno_extract");

  const res = await fetch(url);
  if (!res.ok) {
    logError(`Deno download failed: ${res.status} ${res.statusText}`);
    throw new Error("Deno download failed");
  }

  await Deno.writeFile(archivePath, new Uint8Array(await res.arrayBuffer()));
  await Deno.mkdir(extractDir, { recursive: true });

  let code = 0;
  let stderr = new Uint8Array();

  if (isWindows) {
    // Use PowerShell on Windows
    const unzip = new Deno.Command("powershell", {
      args: [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath "${archivePath}" -DestinationPath "${extractDir}" -Force`,
      ],
      stdout: "piped",
      stderr: "piped",
    });

    ({ code, stderr } = await unzip.output());
  } else {
    // Use unzip on Linux/macOS
    const unzip = new Deno.Command("unzip", {
      args: ["-o", archivePath, "-d", extractDir],
      stdout: "piped",
      stderr: "piped",
    });

    ({ code, stderr } = await unzip.output());
  }

  if (code !== 0) {
    logError("Deno extraction failed:");
    logError(new TextDecoder().decode(stderr));
    throw new Error("Deno extraction failed");
  }

  const extractedBinary = join(extractDir, denoBinary);

  await Deno.copyFile(extractedBinary, denoPath);

  if (!isWindows) {
    await Deno.chmod(denoPath, 0o755);
  }

  await Deno.remove(archivePath).catch(() => {});
  await Deno.remove(extractDir, { recursive: true }).catch(() => {});

  logInfo(`✓ Deno runtime ready (${Deno.build.os})`);

  return denoPath;
}

async function ensureYtDlp(): Promise<string> {
  const isWindows = Deno.build.os === "windows";
  const arch = Deno.build.arch;

  const ytBinary = isWindows ? "yt-dlp.exe" : "yt-dlp";
  const ytPath = join(BIN_DIR, ytBinary);

  try {
    await Deno.stat(ytPath);
    logInfo(`✓ Found ${ytBinary}`);
    return ytPath;
  } catch {
    logInfo(`[*] Installing ${ytBinary}...`);
  }

  let url = "";

  if (isWindows) {
    url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
  } else if (Deno.build.os === "linux") {
    url = arch === "aarch64"
      ? "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64"
      : "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";
  } else if (Deno.build.os === "darwin") {
    url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
  }

  if (!url) {
    throw new Error(`Unsupported platform: ${Deno.build.os}/${arch}`);
  }

  logInfo(`Downloading yt-dlp for ${Deno.build.os}/${arch}`);
  logInfo(`Source: ${url}`);

  const res = await fetch(url);
  if (!res.ok) {
    logError(`yt-dlp download failed: ${res.status} ${res.statusText}`);
    throw new Error("yt-dlp download failed");
  }

  const data = new Uint8Array(await res.arrayBuffer());

  if (data.length < 1_000_000) {
    throw new Error("Invalid yt-dlp download (file too small)");
  }

  await Deno.writeFile(ytPath, data);

  if (!isWindows) {
    await Deno.chmod(ytPath, 0o755);
  }

  logInfo(`✓ yt-dlp ready (${Deno.build.os})`);

  return ytPath;
}

async function findFileRecursive(
  dir: string,
  matcher: (name: string) => boolean,
): Promise<string | null> {
  for await (const entry of Deno.readDir(dir)) {
    const fullPath = join(dir, entry.name);
    if (entry.isFile && matcher(entry.name)) {
      return fullPath;
    }
    if (entry.isDirectory) {
      const result = await findFileRecursive(fullPath, matcher);
      if (result) return result;
    }
  }
  return null;
}

async function ensureFfmpeg() {
  const isWindows = Deno.build.os === "windows";
  const isLinux = Deno.build.os === "linux";
  const isMac = Deno.build.os === "darwin";

  const ffmpegBinary = isWindows ? "ffmpeg.exe" : "ffmpeg";
  const ffmpegPath = join(BIN_DIR, ffmpegBinary);

  try {
    await Deno.stat(ffmpegPath);
    logInfo(`✓ Found ${ffmpegBinary}`);
    return;
  } catch {
    logInfo("[*] Installing FFmpeg...");
  }

  if (isWindows) {
    // ---------------- WINDOWS ----------------
    const url =
      "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";

    const zipPath = join(ROOT_DIR, "ffmpeg.zip");
    const extractDir = join(ROOT_DIR, "ffmpeg_extract");

    const res = await fetch(url);
    if (!res.ok) throw new Error("FFmpeg download failed");

    await Deno.writeFile(zipPath, new Uint8Array(await res.arrayBuffer()));
    await Deno.mkdir(extractDir, { recursive: true });

    const unzip = new Deno.Command("powershell", {
      args: [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${extractDir}" -Force`,
      ],
      stdout: "null",
      stderr: "null",
    });

    await unzip.output();

    const found = await findFileRecursive(
      extractDir,
      (name) => name.toLowerCase() === "ffmpeg.exe",
    );
    if (!found) throw new Error("ffmpeg.exe not found after extraction");

    await Deno.copyFile(found, ffmpegPath);
    await Deno.remove(zipPath).catch(() => {});
    await Deno.remove(extractDir, { recursive: true }).catch(() => {});
  }

  else if (isLinux) {
    // ---------------- LINUX ----------------
    const arch = Deno.build.arch; // x86_64 / aarch64

    const url =
      arch === "aarch64"
        ? "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linuxarm64-gpl.tar.xz"
        : "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz";

    logInfo(`Downloading FFmpeg for arch=${arch}`);
    logInfo(`Source: ${url}`);

    const tarPath = join(ROOT_DIR, "ffmpeg.tar.xz");
    const extractDir = join(ROOT_DIR, "ffmpeg_extract");

    const res = await fetch(url, {
      headers: {
        "User-Agent": "ytdl-api/1.0.9 (Deno)",
        "Accept": "application/octet-stream",
      },
    });

    if (!res.ok) {
      logError(`FFmpeg download failed: ${res.status} ${res.statusText}`);
      throw new Error("FFmpeg download failed");
    }

    await Deno.writeFile(tarPath, new Uint8Array(await res.arrayBuffer()));
    await Deno.mkdir(extractDir, { recursive: true });

    const extract = new Deno.Command("tar", {
      args: ["-xJf", tarPath, "-C", extractDir],
    });

    const { code, stderr } = await extract.output();
    if (code !== 0) {
      logError("Tar extraction failed:");
      logError(new TextDecoder().decode(stderr));
      throw new Error("FFmpeg extraction failed");
    }

    const found = await findFileRecursive(extractDir, (name) => name === "ffmpeg");
    if (!found) throw new Error("ffmpeg not found after extraction");

    await Deno.copyFile(found, ffmpegPath);
    await Deno.chmod(ffmpegPath, 0o755);

    await Deno.remove(tarPath).catch(() => {});
    await Deno.remove(extractDir, { recursive: true }).catch(() => {});
  }

  else if (isMac) {
    logWarning("macOS auto-install not implemented.");
    logWarning("Please install FFmpeg using: brew install ffmpeg");
    return;
  }

  logInfo(`✓ FFmpeg ready (${Deno.build.os})`);
}
// ============================================================================
// End Bootstrap

// ============================================================================
// ROUTES
// ============================================================================

await ensurePublicAssetsExtracted();

const router = new Router();

router.get("/", async (ctx) => {
  try {
    // Check if homepage requires authentication
    const config = await loadConfig();
    if (config.require_auth_home) {
      const sessionId = getSessionIdFromContext(ctx);
      if (!sessionId) {
        ctx.response.redirect("/login.html");
        return;
      }
      const ip = ctx.request.ip;
      const userAgent = ctx.request.headers.get("User-Agent") || "unknown";
      const session = await validateSession(sessionId, ip, userAgent);
      if (!session) {
        ctx.response.redirect("/login.html");
        return;
      }
    }

    const html = await readPublicTextFile("index.html");
    ctx.response.type = "text/html";
    ctx.response.body = html;
  } catch {
    ctx.response.body = {
      service: "YouTube Downloader API",
      version: "1.0.9",
      status: "online",
      message: `Frontend not found. Deploy index.html to ${PUBLIC_DIR}`,
    };
  }
});

router.get("/favicon.ico", async (ctx) => {
  try {
    await sendPublicFile(ctx, "favicon.ico");
  } catch {
    ctx.response.status = 404;
  }
});

// Serve login page
router.get("/login.html", async (ctx) => {
  try {
    const html = await readPublicTextFile("login.html");
    ctx.response.type = "text/html";
    ctx.response.body = html;
  } catch {
    ctx.response.status = 404;
    ctx.response.body = { error: "Login page not found" };
  }
});

// Serve config/admin page
router.get("/config.html", async (ctx) => {
  try {
    const html = await readPublicTextFile("config.html");
    ctx.response.type = "text/html";
    ctx.response.body = html;
  } catch {
    ctx.response.status = 404;
    ctx.response.body = { error: "Config page not found" };
  }
});

// Serve static JS files from public/
router.get("/js/:file", async (ctx) => {
  try {
    const file = ctx.params.file;
    if (!file) {
      ctx.response.status = 404;
      return;
    }
    await sendPublicFile(ctx, `js/${file}`);
  } catch {
    ctx.response.status = 404;
  }
});

router.get("/health", (ctx) => {
  ctx.response.body = {
    service: "YouTube Downloader API",
    version: "1.0.9",
    status: "online",
  };
});

// Optional auth gate for public API endpoints
async function apiAuthMiddleware(ctx: Context, next: Next) {
  const config = await loadConfig();
  if (!config.require_auth_api) {
    await next();
    return;
  }

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

  ctx.state.session = session;
  await next();
}

async function requireApiCsrf(ctx: Context): Promise<boolean> {
  const config = await loadConfig();
  if (!config.require_auth_api) return true;

  const session = ctx.state.session;
  if (!session) return false;

  let csrfToken = ctx.request.headers.get("x-csrf-token") || "";
  if (!csrfToken && ctx.request.method !== "GET") {
    try {
      const body = await ctx.request.body({ type: "json" }).value;
      csrfToken = body?.csrf_token || "";
    } catch {
      // ignore
    }
  }

  return !!csrfToken && csrfToken === session.csrf_token;
}

function isAllowedDownloadUrl(rawUrl: string, allowedDomains: string[]): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  const host = url.hostname.toLowerCase();
  return allowedDomains.some((domain) => {
    const d = domain.toLowerCase();
    return host === d || host.endsWith(`.${d}`);
  });
}

function getMimeTypeFromPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".flac")) return "audio/flac";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  return "application/octet-stream";
}

function parseRangeHeader(rangeHeader: string, fileSize: number): { start: number; end: number } | null {
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return null;

  const rawStart = match[1];
  const rawEnd = match[2];

  let start = rawStart ? Number(rawStart) : 0;
  let end = rawEnd ? Number(rawEnd) : fileSize - 1;

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0) start = 0;
  if (end >= fileSize) end = fileSize - 1;
  if (start > end || start >= fileSize) return null;

  return { start, end };
}

async function streamFileWithAbortHandling(ctx: Context, filePath: string): Promise<void> {
  const stat = await Deno.stat(filePath);
  const fileSize = stat.size;
  const rangeHeader = ctx.request.headers.get("range");
  const parsedRange = rangeHeader ? parseRangeHeader(rangeHeader, fileSize) : null;
  const start = parsedRange ? parsedRange.start : 0;
  const end = parsedRange ? parsedRange.end : Math.max(fileSize - 1, 0);
  let remaining = parsedRange ? end - start + 1 : fileSize;

  const file = await Deno.open(filePath, { read: true });
  await file.seek(start, Deno.SeekMode.Start);

  let closed = false;
  const safeClose = () => {
    if (closed) return;
    closed = true;
    try {
      file.close();
    } catch {
      // ignore close races
    }
  };

  const requestSignal: AbortSignal | undefined = (ctx.request as unknown as { source?: { signal?: AbortSignal } }).source?.signal;
  if (requestSignal) {
    const onAbort = () => safeClose();
    requestSignal.addEventListener("abort", onAbort, { once: true });
  }

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (remaining <= 0) {
        safeClose();
        controller.close();
        return;
      }

      const chunkSize = Math.min(64 * 1024, remaining);
      const buffer = new Uint8Array(chunkSize);

      try {
        const bytesRead = await file.read(buffer);
        if (bytesRead === null || bytesRead === 0) {
          safeClose();
          controller.close();
          return;
        }
        remaining -= bytesRead;
        controller.enqueue(bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead));
      } catch (err) {
        safeClose();
        // Suppress expected disconnect noise on streaming endpoints.
        if (isClientAbortError(err)) {
          controller.close();
          return;
        }
        controller.error(err);
      }
    },
    cancel() {
      safeClose();
    },
  });

  ctx.response.status = parsedRange ? 206 : 200;
  ctx.response.type = getMimeTypeFromPath(filePath);
  ctx.response.headers.set("Accept-Ranges", "bytes");
  ctx.response.headers.set("Content-Length", String(parsedRange ? end - start + 1 : fileSize));
  if (parsedRange) {
    ctx.response.headers.set("Content-Range", `bytes ${start}-${end}/${fileSize}`);
  }
  ctx.response.body = stream;
}

// Apply auth gate to public API endpoints (when enabled)
router.use(
  ["/queue", "/search", "/download", "/status", "/stream"],
  apiAuthMiddleware,
);

router.get("/queue", (ctx) => {
  const queue = [];
  for (const [id, job] of jobs.entries()) {
    queue.push({
      id,
      status: job.status,
      created_at: job.created_at,
      url: job.url,
      format_type: job.format_type,
      file_name: job.file_name || null,
      percent: job.percent ?? null,
      speed: job.speed || null,
      eta: job.eta || null,
      file_size: job.file_size || null,
      playlist_title: job.playlist_title || null,
      current_video: job.current_video || null,
      total_videos: job.total_videos || null,
      current_title: job.current_title || null,
      video_titles: job.status === "completed" ? (job.video_titles || []) : [],
      error: job.error || null,
    });
  }
  ctx.response.body = { jobs: queue };
});

// Cancel a running download
router.post("/queue/:jobId/cancel", async (ctx) => {
  if (!(await requireApiCsrf(ctx))) {
    ctx.response.status = 403;
    ctx.response.body = { error: "CSRF token validation failed" };
    return;
  }

  const jobId = ctx.params.jobId;
  const job = jobs.get(jobId);

  if (!job) {
    ctx.response.status = 404;
    ctx.response.body = { error: "Job not found" };
    return;
  }

  if (job._process) {
    try {
      job._process.kill("SIGTERM");
    } catch {
      // process may already be dead
    }
  }

  job.status = "failed";
  job.error = "Cancelled by user";
  job._process = undefined;
  await writeJobStatus(job, true);

  // Clean up files
  try {
    const folderPath = join(DOWNLOADS_DIR, jobId);
    await Deno.stat(folderPath);
    await Deno.remove(folderPath, { recursive: true });
  } catch { /* folder may not exist */ }

  ctx.response.body = { success: true };
});

// Resume an interrupted download
router.post("/queue/:jobId/resume", async (ctx) => {
  if (!(await requireApiCsrf(ctx))) {
    ctx.response.status = 403;
    ctx.response.body = { error: "CSRF token validation failed" };
    return;
  }

  const jobId = ctx.params.jobId;
  const job = jobs.get(jobId);

  if (!job) {
    ctx.response.status = 404;
    ctx.response.body = { error: "Job not found" };
    return;
  }

  if (job.status !== "interrupted") {
    ctx.response.status = 400;
    ctx.response.body = { error: "Job is not in an interrupted state" };
    return;
  }

  job.status = "pending";
  job.error = undefined;
  await writeJobStatus(job, true);

  if (job.playlist) {
    downloadPlaylist(job, true).catch(e => {
      logError(`Playlist resume error: ${e}`);
      job.status = "failed";
      job.error = String(e);
      writeJobStatus(job, true);
    });
  } else {
    downloadVideo(job, true).catch(e => {
      logError(`Video resume error: ${e}`);
      job.status = "failed";
      job.error = String(e);
      writeJobStatus(job, true);
    });
  }

  ctx.response.body = { success: true };
});

// Remove a job from the queue (completed/failed only)
router.delete("/queue/:jobId", async (ctx) => {
  if (!(await requireApiCsrf(ctx))) {
    ctx.response.status = 403;
    ctx.response.body = { error: "CSRF token validation failed" };
    return;
  }

  const jobId = ctx.params.jobId;
  const job = jobs.get(jobId);

  if (!job) {
    ctx.response.status = 404;
    ctx.response.body = { error: "Job not found" };
    return;
  }

  // Clean up files
  try {
    const folderPath = join(DOWNLOADS_DIR, jobId);
    await Deno.stat(folderPath);
    await Deno.remove(folderPath, { recursive: true });
  } catch { /* folder may not exist */ }

  jobs.delete(jobId);
  ctx.response.body = { success: true };
});

// Manual cleanup (admin-only)
router.post("/admin/cleanup-now", async (ctx) => {
  // Auth check
  const sessionId = getSessionIdFromContext(ctx);
  if (!sessionId) { ctx.response.status = 401; ctx.response.body = { error: "Auth required" }; return; }
  const session = await validateSession(sessionId, ctx.request.ip, ctx.request.headers.get("User-Agent") || "unknown");
  if (!session) { ctx.response.status = 401; ctx.response.body = { error: "Invalid session" }; return; }

  // CSRF check (header preferred, JSON body fallback)
  let csrfToken = ctx.request.headers.get("x-csrf-token") || "";
  if (!csrfToken) {
    try {
      const body = await ctx.request.body({ type: "json" }).value;
      csrfToken = body?.csrf_token || "";
    } catch {
      // ignore parse errors; we'll fail below if token is missing
    }
  }

  if (!csrfToken || csrfToken !== session.csrf_token) {
    ctx.response.status = 403;
    ctx.response.body = { error: "CSRF token validation failed" };
    return;
  }

  let removed = 0;

  // Remove completed/failed jobs and their files
  for (const [jobId, job] of jobs.entries()) {
    if (job.status === "completed" || job.status === "failed") {
      try {
        const folderPath = join(DOWNLOADS_DIR, jobId);
        await Deno.stat(folderPath);
        await Deno.remove(folderPath, { recursive: true });
      } catch { /* folder may not exist */ }
      jobs.delete(jobId);
      removed++;
    }
  }

  // Remove orphaned folders (not tracked in jobs map)
  try {
    for await (const entry of Deno.readDir(DOWNLOADS_DIR)) {
      if (entry.isDirectory && !jobs.has(entry.name)) {
        try {
          await Deno.remove(join(DOWNLOADS_DIR, entry.name), { recursive: true });
          removed++;
        } catch { /* ignore */ }
      }
    }
  } catch { /* downloads dir may not exist */ }

  logInfo(`Manual cleanup: removed ${removed} items`);
  ctx.response.body = { success: true, removed };
});

router.post("/search", async (ctx) => {
  try {
    const config = await loadConfig();
    const ip = getClientIp(ctx);
    const limit = config.rate_limit_search_per_minute ?? 30;
    if (!checkApiRateLimit(`search:${ip}`, limit, 60_000)) {
      ctx.response.status = 429;
      ctx.response.body = { error: "Rate limit exceeded" };
      return;
    }

    const body = await ctx.request.body({ type: "json" }).value as SearchRequest;
    const results = await searchYouTube(body.query);
    ctx.response.body = results;
  } catch (e) {
    logError(`Search error: ${e}`);
    ctx.response.status = 500;
    ctx.response.body = { error: "Search failed" };
  }
});

router.post("/download", async (ctx) => {
  try {
    const config = await loadConfig();
    const ip = getClientIp(ctx);
    const limit = config.rate_limit_download_per_minute ?? 15;
    if (!checkApiRateLimit(`download:${ip}`, limit, 60_000)) {
      ctx.response.status = 429;
      ctx.response.body = { error: "Rate limit exceeded" };
      return;
    }

    const body = await ctx.request.body({ type: "json" }).value as DownloadRequest;
    const allowedDomains = config.allowed_download_domains || ["youtube.com", "youtu.be"];

    if (!isAllowedDownloadUrl(body.url, allowedDomains)) {
      ctx.response.status = 400;
      ctx.response.body = { error: "URL domain not allowed" };
      return;
    }
    
    // Auto-detect playlists from URL
    // Playlists have 'list=' parameter: 
    //   - https://www.youtube.com/playlist?list=PLxxx
    //   - https://www.youtube.com/watch?v=xxx&list=PLxxx
    // Single videos do NOT:
    //   - https://youtu.be/WAW4KddN31A?si=xxx
    //   - https://www.youtube.com/watch?v=WAW4KddN31A
    const isPlaylist = !!(
      body.playlist || 
      body.url.match(/[?&]list=([^&]+)/)  // Only match if 'list=' parameter exists
    );
    
    const jobId = generateJobId();
    const job: Job = {
      id: jobId,
      status: "pending",
      url: body.url,
      format_type: body.format_type || "audio",
      quality: body.quality || "best",
      playlist: isPlaylist,
      created_at: Date.now(),
    };
    
    jobs.set(jobId, job);
    await ensureDownloadDir(jobId);
    await writeJobMetadata(job);
    await writeJobStatus(job, true);
    
    logInfo(`New download request: ${jobId} - ${isPlaylist ? 'PLAYLIST' : 'SINGLE'} - ${body.url}`);
    
    // Start download in background
    if (isPlaylist) {
      downloadPlaylist(job).catch(e => {
        logError(`Playlist download error: ${e}`);
        job.status = "failed";
        job.error = String(e);
        writeJobStatus(job, true);
      });
    } else {
      downloadVideo(job).catch(e => {
        logError(`Video download error: ${e}`);
        job.status = "failed";
        job.error = String(e);
        writeJobStatus(job, true);
      });
    }
    
    // Return "playlist" status so frontend polls correct endpoint
    ctx.response.body = {
      job_id: jobId,
      status: isPlaylist ? "playlist" : "pending",
      message: isPlaylist ? "Playlist download started" : "Download started",
    };
  } catch (e) {
    logError(`Download endpoint error: ${e}`);
    ctx.response.status = 500;
    ctx.response.body = { error: "Failed to start download" };
  }
});

router.get("/status/:jobId", (ctx) => {
  const jobId = ctx.params.jobId;
  const job = jobs.get(jobId);
  
  if (!job) {
    ctx.response.status = 404;
    ctx.response.body = { error: "Job not found" };
    return;
  }
  
  ctx.response.body = {
    status: job.status,
    message: job.message,
    error: job.error,
    file_name: job.file_name,
  };
});

// Status endpoint for playlists - use current_video (not current_index)
router.get("/status/playlist/:jobId", (ctx) => {
  const jobId = ctx.params.jobId;
  const job = jobs.get(jobId);
  
  if (!job) {
    ctx.response.status = 404;
    ctx.response.body = { error: "Job not found" };
    return;
  }
  
  // fields that match frontend expectations
  ctx.response.body = {
    status: job.status,
    total_videos: job.total_videos || 0,
    current_video: job.current_video || 0,     // Current_video (not current_index)
    current_title: job.current_title || "",
    video_titles: job.video_titles || [],
    skipped_videos: job.skipped_videos || [],
    file_name: job.file_name,
    message: job.message,
    error: job.error,
  };
  
  // Debug logging
  if (job.status === "playlist") {
    logDebug(`Status check: ${job.current_video}/${job.total_videos} - ${job.current_title || "(no title)"}`);
  }
});

// Stream a file for inline playback (no download trigger, no cleanup)
router.get("/stream/:jobId", async (ctx) => {
  const jobId = ctx.params.jobId;
  const job = jobs.get(jobId);

  if (!job || job.status !== "completed") {
    ctx.response.status = 404;
    ctx.response.body = { error: "File not ready" };
    return;
  }

  if (!job.file_path || !await exists(job.file_path)) {
    const resolvedPath = await findMediaFileForJob(jobId, job.format_type);
    if (!resolvedPath) {
      ctx.response.status = 404;
      ctx.response.body = { error: "File not found" };
      return;
    }
    job.file_path = resolvedPath;
    job.file_name = basename(resolvedPath);
    await writeJobMetadata(job);
  }

  const filename = job.file_name || "download.mp3";
  ctx.response.headers.set("Content-Disposition", `inline; filename="${encodeURIComponent(filename)}"`);

  try {
    await streamFileWithAbortHandling(ctx, job.file_path);
  } catch (err) {
    if (isClientAbortError(err)) return;
    throw err;
  }
});

// Stream a specific track from a playlist by index
router.get("/stream/:jobId/:trackIndex", async (ctx) => {
  const jobId = ctx.params.jobId;
  const trackIndex = parseInt(ctx.params.trackIndex);
  const job = jobs.get(jobId);

  if (!job || job.status !== "completed" || !job.total_videos) {
    ctx.response.status = 404;
    ctx.response.body = { error: "Playlist not ready" };
    return;
  }

  if (isNaN(trackIndex) || trackIndex < 0) {
    ctx.response.status = 400;
    ctx.response.body = { error: "Invalid track index" };
    return;
  }

  const downloadDir = join(DOWNLOADS_DIR, jobId);
  const ext = job.format_type === "audio" ? ".mp3" : ".mp4";
  const files: string[] = [];

  try {
    for await (const entry of Deno.readDir(downloadDir)) {
      if (entry.isFile && entry.name.endsWith(ext) && !entry.name.includes(".temp.") && !entry.name.includes(".part")) {
        files.push(entry.name);
      }
    }
  } catch {
    ctx.response.status = 404;
    ctx.response.body = { error: "Download folder not found" };
    return;
  }

  files.sort();

  if (trackIndex >= files.length) {
    ctx.response.status = 404;
    ctx.response.body = { error: "Track not found" };
    return;
  }

  const filename = files[trackIndex];
  const filePath = join(downloadDir, filename);
  ctx.response.headers.set("Content-Disposition", `inline; filename="${encodeURIComponent(filename)}"`);

  try {
    await streamFileWithAbortHandling(ctx, filePath);
  } catch (err) {
    if (isClientAbortError(err)) return;
    throw err;
  }
});

router.get("/download/:jobId", async (ctx) => {
  const jobId = ctx.params.jobId;
  const job = jobs.get(jobId);
  
  if (!job || job.status !== "completed") {
    ctx.response.status = 404;
    ctx.response.body = { error: "File not ready" };
    return;
  }
  
  if (!job.file_path || !await exists(job.file_path)) {
    const resolvedPath = await findMediaFileForJob(jobId, job.format_type);
    if (!resolvedPath) {
      ctx.response.status = 404;
      ctx.response.body = { error: "File not found" };
      return;
    }
    job.file_path = resolvedPath;
    job.file_name = basename(resolvedPath);
    await writeJobMetadata(job);
  }
  
  const filename = job.file_name || "download.mp3";
  ctx.response.headers.set(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(filename)}"`
  );
  
  await send(ctx, job.file_name!, {
    root: join(DOWNLOADS_DIR, jobId),
  });
  
  cleanupJobFiles(jobId);
});

router.get("/download/playlist/:jobId", async (ctx) => {
  const jobId = ctx.params.jobId;
  const job = jobs.get(jobId);
  
  if (!job || job.status !== "completed") {
    ctx.response.status = 404;
    ctx.response.body = { error: "Playlist not ready" };
    return;
  }
  
  if (!job.file_path || !await exists(job.file_path)) {
    ctx.response.status = 404;
    ctx.response.body = { error: "ZIP file not found" };
    return;
  }
  
  const filename = job.file_name || "playlist.zip";
  ctx.response.headers.set(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(filename)}"`
  );
  
  await send(ctx, job.file_name!, {
    root: join(DOWNLOADS_DIR, jobId),
  });
  
  cleanupJobFiles(jobId);
});

// ============================================================================
// APPLICATION
// ============================================================================

const app = new Application({ logErrors: false });

// 1. Security headers (MUST BE FIRST)
app.use(securityHeadersMiddleware);

// 2. CORS (allowlist from config)
app.use(async (ctx, next) => {
  const origin = ctx.request.headers.get("Origin");
  if (!origin) {
    await next();
    return;
  }

  const config = await loadConfig();
  const allowed = config.cors_allowed_origins || [];
  const isAllowed = allowed.includes(origin);

  if (isAllowed) {
    ctx.response.headers.set("Access-Control-Allow-Origin", origin);
    ctx.response.headers.set("Vary", "Origin");
    ctx.response.headers.set("Access-Control-Allow-Credentials", "true");
    ctx.response.headers.set(
      "Access-Control-Allow-Headers",
      "Content-Type, X-CSRF-Token",
    );
    ctx.response.headers.set(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,DELETE,OPTIONS",
    );
  }

  if (ctx.request.method === "OPTIONS") {
    ctx.response.status = isAllowed ? 204 : 403;
    return;
  }

  await next();
});

function isClientAbortError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)) || "";
  const lower = msg.toLowerCase();
  return (
    lower.includes("connection closed before message completed") ||
    lower.includes("error writing a body to connection") ||
    lower.includes("bad resource id") ||
    lower.includes("http: connection error") ||
    lower.includes("error shutting down connection") ||
    lower.includes("os error 10053") ||
    lower.includes("os error 10054")
  );
}

// 3. Error handler
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    if (isClientAbortError(err)) return;
    logError(`Unhandled error: ${err}`);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

// 4. Auth routes (no authentication required)
app.use(authRouter.routes());
app.use(authRouter.allowedMethods());

// 5. Admin routes (authentication required)
app.use(adminRouter.routes());
app.use(adminRouter.allowedMethods());

// 6. Public API routes
app.use(router.routes());
app.use(router.allowedMethods());

// Suppress noisy client-abort errors (common during streaming)
app.addEventListener("error", (evt) => {
  const err = evt.error as Error | undefined;
  if (isClientAbortError(err)) {
    evt.preventDefault();
    return;
  }
  logError(`Application error: ${err?.stack || err?.message || err}`);
});


// ============================================================================
// STARTUP
// ============================================================================

async function main() {
  logInfo("═".repeat(80));
  logInfo("YouTube Downloader API v1.0.9");
  logInfo("═".repeat(80));

  await bootstrapEnvironment();

  // Initialize config.json if missing
  try {
    await Deno.stat(CONFIG_FILE);
    logInfo(`✓ Config file: ${CONFIG_FILE}`);
  } catch {
    const defaults = await loadConfig();
  await saveConfig(defaults);

  logInfo("✓ Config file created");
  }

  await rebuildQueueFromDisk();
  await cleanupOrphanedFolders();

  periodicCleanup().catch(e =>
    logError(`Periodic cleanup error: ${e}`)
  );

  logInfo(`✓ Root directory: ${ROOT_DIR}`);
  logInfo(`✓ Download directory: ${DOWNLOADS_DIR}`);
  logInfo(`✓ yt-dlp path: ${join(BIN_DIR, "yt-dlp.exe")}`);
  logInfo(`✓ Admin panel: http://localhost:${PORT}/login.html`);
  logInfo(`✓ Server listening on http://localhost:${PORT}`);
  logInfo("═".repeat(80));

  // Open browser automatically when server is ready (skip when running as a service)
  app.addEventListener("listen", () => {
    if (isRunningAsService) return;

    const url = `http://localhost:${PORT}`;
    logInfo(`Opening browser: ${url}`);

    try {
      const os = Deno.build.os;
      if (os === "windows") {
        new Deno.Command("cmd", { args: ["/c", "start", url], stdout: "null", stderr: "null" }).spawn();
      } else if (os === "darwin") {
        new Deno.Command("open", { args: [url], stdout: "null", stderr: "null" }).spawn();
      } else {
        new Deno.Command("xdg-open", { args: [url], stdout: "null", stderr: "null" }).spawn();
      }
    } catch (e) {
      logWarning(`Could not open browser automatically: ${e}`);
    }
  });

  await app.listen({ port: PORT });
}

if (import.meta.main) {
  const result = await handleCli();
  if (!result.handled) {
    // Apply CLI options
    if (result.options.port) {
      PORT = result.options.port;
    }

    // --service flag: launched by Windows SCM, perform SCM handshake
    if (Deno.args[0] === "--service" && Deno.build.os === "windows") {
      await runAsWindowsService(main);
    } else {
      main();
    }
  }
}
