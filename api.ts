#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-run --allow-env

/**
 * YouTube Downloader API - Deno/TypeScript Port
 * Compiled microservice for production deployment
 */

import { Application, Router, send } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { oakCors } from "https://deno.land/x/cors@v1.2.2/mod.ts";
import { exists } from "https://deno.land/std@0.208.0/fs/mod.ts";

// ============================================================================
// CONFIGURATION
// ============================================================================

const PORT = parseInt(Deno.env.get("PORT") || "8000");
const DOWNLOAD_DIR = Deno.env.get("DOWNLOAD_DIR") || "./downloads";
const SEARCH_RESULTS = parseInt(Deno.env.get("SEARCH_RESULTS") || "40");
const MAX_DURATION = parseInt(Deno.env.get("MAX_DURATION") || "600"); // 10 minutes
const YT_DLP_PATH = Deno.env.get("YT_DLP_PATH") || "yt-dlp";
const ID3_COMMENT = Deno.env.get("ID3_COMMENT") || "Downloaded via YouTube API";

// ============================================================================
// TYPES
// ============================================================================

type JobStatus = "pending" | "processing" | "completed" | "failed" | "playlist";

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
  
  // Playlist-specific fields
  total_videos?: number;
  current_video?: number;
  current_title?: string;
  video_titles?: string[];
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

// ============================================================================
// JOB STORE
// ============================================================================

const jobs = new Map<string, Job>();

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function generateJobId(): string {
  return crypto.randomUUID();
}

async function ensureDownloadDir(jobId: string): Promise<string> {
  const dir = `${DOWNLOAD_DIR}/${jobId}`;
  await Deno.mkdir(dir, { recursive: true });
  return dir;
}

function logInfo(message: string) {
  const timestamp = new Date().toISOString();
  console.log(`${timestamp} - INFO - ${message}`);
}

function logError(message: string) {
  const timestamp = new Date().toISOString();
  console.error(`${timestamp} - ERROR - ${message}`);
}

// ============================================================================
// YT-DLP INTEGRATION
// ============================================================================

async function searchYouTube(query: string): Promise<SearchResult[]> {
  logInfo(`Searching YouTube for: ${query}`);
  
  const command = new Deno.Command(YT_DLP_PATH, {
    args: [
      "--dump-json",
      "--flat-playlist",
      "--skip-download",
      `ytsearch${SEARCH_RESULTS}:${query}`,
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
  
  // Parse JSON lines
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

async function downloadVideo(job: Job) {
  const jobId = job.id;
  const downloadDir = await ensureDownloadDir(jobId);
  
  job.status = "processing";
  logInfo(`Starting download for job ${jobId}: ${job.url}`);
  
  const args: string[] = [
    "--no-playlist",
    "--format", job.format_type === "video" ? `bestvideo[height<=${job.quality}]+bestaudio/best[height<=${job.quality}]` : "bestaudio",
    "--output", `${downloadDir}/%(title)s.%(ext)s`,
  ];
  
  // Audio-specific options
  if (job.format_type === "audio") {
    args.push(
      "--extract-audio",
      "--audio-format", "mp3",
      "--audio-quality", "0",
      "--embed-thumbnail",
      "--add-metadata",
      "--metadata-from-title", "%(artist)s - %(title)s",
    );
  } else {
    // ✅ Video-specific options - force MP4 output
    args.push(
      "--merge-output-format", "mp4",  // Force MP4 container
      "--embed-thumbnail",              // Embed thumbnail in video
      "--add-metadata",                 // Add metadata
    );
  }
  
  args.push(job.url);
  
  const command = new Deno.Command(YT_DLP_PATH, {
    args,
    stdout: "piped",
    stderr: "piped",
    cwd: Deno.cwd(),
  });
  
  const { stdout, stderr, code } = await command.output();
  
  if (code !== 0) {
    const error = new TextDecoder().decode(stderr);
    job.status = "failed";
    job.error = error;
    logError(`Download failed for job ${jobId}: ${error}`);
    return;
  }
  
  // Find downloaded file
  const files: string[] = [];
  for await (const entry of Deno.readDir(downloadDir)) {
    if (entry.isFile) {
      files.push(entry.name);
    }
  }
  
  if (files.length === 0) {
    job.status = "failed";
    job.error = "No files downloaded";
    logError(`No files found for job ${jobId}`);
    return;
  }
  
  job.status = "completed";
  job.file_name = files[0];
  job.file_path = `${downloadDir}/${files[0]}`;
  logInfo(`Download completed for job ${jobId}: ${job.file_name}`);
}

async function downloadPlaylist(job: Job) {
  const jobId = job.id;
  const downloadDir = await ensureDownloadDir(jobId);
  
  job.status = "playlist";
  logInfo(`Starting playlist download for job ${jobId}: ${job.url}`);
  
  const args: string[] = [
    "--yes-playlist",
    "--ignore-errors", // ✅ Skip unavailable videos
    "--format", "bestaudio",
    "--extract-audio",
    "--audio-format", "mp3",
    "--audio-quality", "0",
    "--embed-thumbnail",
    "--add-metadata",
    "--output", `${downloadDir}/%(title)s.%(ext)s`,
  ];
  
  args.push(job.url);
  
  const command = new Deno.Command(YT_DLP_PATH, {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  
  const process = command.spawn();
  
  // Stream output to track progress
  const decoder = new TextDecoder();
  const reader = process.stderr.getReader();
  
  job.total_videos = 0;
  job.current_video = 0;
  job.video_titles = [];
  
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const text = decoder.decode(value);
      
      // Parse yt-dlp output for progress
      const downloadMatch = text.match(/\[download\] Downloading item (\d+) of (\d+)/);
      if (downloadMatch) {
        job.current_video = parseInt(downloadMatch[1]);
        job.total_videos = parseInt(downloadMatch[2]);
      }
      
      const titleMatch = text.match(/\[download\] Destination: .*\/(.+)\.mp3/);
      if (titleMatch && titleMatch[1]) {
        job.current_title = titleMatch[1];
        if (!job.video_titles?.includes(titleMatch[1])) {
          job.video_titles?.push(titleMatch[1]);
        }
      }
    }
  } catch (e) {
    logError(`Error reading playlist progress: ${e}`);
  }
  
  const { code } = await process.status;
  
  if (code !== 0) {
    job.status = "failed";
    job.error = "Playlist download failed";
    logError(`Playlist download failed for job ${jobId}`);
    return;
  }
  
  // Create ZIP of all downloaded MP3s
  const files: string[] = [];
  for await (const entry of Deno.readDir(downloadDir)) {
    if (entry.isFile && entry.name.endsWith(".mp3")) {
      files.push(entry.name);
    }
  }
  
  if (files.length === 0) {
    job.status = "failed";
    job.error = "No files downloaded from playlist";
    logError(`No MP3 files found for playlist job ${jobId}`);
    return;
  }
  
  // Create ZIP using system zip command
  const zipFileName = "playlist.zip";
  const zipPath = `${downloadDir}/${zipFileName}`;
  
  const zipCommand = new Deno.Command("zip", {
    args: ["-j", zipPath, ...files.map(f => `${downloadDir}/${f}`)],
    stdout: "piped",
    stderr: "piped",
  });
  
  const { code: zipCode } = await zipCommand.output();
  
  if (zipCode !== 0) {
    logError(`Failed to create ZIP for playlist job ${jobId}`);
    // Fall back to individual files
  }
  
  job.status = "completed";
  job.file_name = zipFileName;
  job.file_path = zipPath;
  job.message = `Downloaded ${files.length} videos`;
  logInfo(`Playlist download completed for job ${jobId}: ${files.length} files`);
}

// ============================================================================
// CLEANUP TASKS
// ============================================================================

async function cleanupOrphanedFolders() {
  /**
   * Clean up ALL download folders on startup.
   * Since container restart clears job state, all folders are orphaned.
   */
  logInfo("Running startup cleanup...");
  
  try {
    if (!await exists(DOWNLOAD_DIR)) {
      logInfo("Download directory doesn't exist yet");
      return;
    }
    
    let cleanedCount = 0;
    
    for await (const entry of Deno.readDir(DOWNLOAD_DIR)) {
      if (!entry.isDirectory) continue;
      
      const folderPath = `${DOWNLOAD_DIR}/${entry.name}`;
      
      try {
        await Deno.remove(folderPath, { recursive: true });
        cleanedCount++;
        logInfo(`Startup cleanup: removed orphaned folder ${entry.name}`);
      } catch (e) {
        logError(`Failed to remove folder ${entry.name}: ${e}`);
      }
    }
    
    if (cleanedCount > 0) {
      logInfo(`Startup cleanup: removed ${cleanedCount} orphaned folders`);
    } else {
      logInfo("Startup cleanup: no orphaned folders to clean");
    }
  } catch (e) {
    logError(`Error during startup cleanup: ${e}`);
  }
}

async function periodicCleanup() {
  /**
   * Remove jobs older than 1 hour (both in-memory and orphaned on disk).
   * Runs every 5 minutes.
   */
  while (true) {
    try {
      await new Promise(resolve => setTimeout(resolve, 300000)); // 5 minutes
      
      const now = Date.now();
      
      // PHASE 1: Clean up in-memory jobs
      const jobsToRemove: string[] = [];
      
      for (const [jobId, job] of jobs.entries()) {
        const jobAge = now - job.created_at;
        
        if (jobAge > 3600000) { // 1 hour
          jobsToRemove.push(jobId);
        }
      }
      
      for (const jobId of jobsToRemove) {
        try {
          const folderPath = `${DOWNLOAD_DIR}/${jobId}`;
          if (await exists(folderPath)) {
            await Deno.remove(folderPath, { recursive: true });
          }
          jobs.delete(jobId);
          logInfo(`Cleaned up old job ${jobId}`);
        } catch (e) {
          logError(`Error cleaning up job ${jobId}: ${e}`);
        }
      }
      
      // PHASE 2: Clean up orphaned folders on disk
      try {
        if (await exists(DOWNLOAD_DIR)) {
          for await (const entry of Deno.readDir(DOWNLOAD_DIR)) {
            if (!entry.isDirectory) continue;
            
            // Skip if still in jobs dict
            if (jobs.has(entry.name)) continue;
            
            const folderPath = `${DOWNLOAD_DIR}/${entry.name}`;
            
            try {
              const info = await Deno.stat(folderPath);
              const folderAge = now - (info.mtime?.getTime() || 0);
              
              if (folderAge > 3600000) { // 1 hour
                await Deno.remove(folderPath, { recursive: true });
                logInfo(`Cleaned up orphaned folder ${entry.name}`);
              }
            } catch (e) {
              logError(`Error checking folder ${entry.name}: ${e}`);
            }
          }
        }
      } catch (e) {
        logError(`Error cleaning up orphaned folders: ${e}`);
      }
    } catch (e) {
      logError(`Error in cleanup task: ${e}`);
    }
  }
}

async function cleanupJobFiles(jobId: string) {
  /**
   * Background task to clean up job files after download.
   * Waits 10 minutes to give users time to download.
   */
  await new Promise(resolve => setTimeout(resolve, 600000)); // 10 minutes
  
  try {
    if (jobs.has(jobId)) {
      const folderPath = `${DOWNLOAD_DIR}/${jobId}`;
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
// ROUTES
// ============================================================================

const router = new Router();

// Serve static frontend (HTML page)
router.get("/", async (ctx) => {
  try {
    const html = await Deno.readTextFile("./public/index.html");
    ctx.response.type = "text/html";
    ctx.response.body = html;
  } catch (e) {
    // Fallback to API info if no static file
    ctx.response.body = {
      service: "YouTube Downloader API",
      version: "2.0.0-deno",
      status: "online",
      message: "Frontend not found. Deploy index.html to ./public/",
    };
  }
});

// Health check endpoint
router.get("/health", (ctx) => {
  ctx.response.body = {
    service: "YouTube Downloader API",
    version: "2.0.0-deno",
    status: "online",
  };
});

// Search
router.post("/search", async (ctx) => {
  try {
    const body = await ctx.request.body({ type: "json" }).value as SearchRequest;
    const results = await searchYouTube(body.query);
    ctx.response.body = results;
  } catch (e) {
    logError(`Search error: ${e}`);
    ctx.response.status = 500;
    ctx.response.body = { error: "Search failed" };
  }
});

// Download
router.post("/download", async (ctx) => {
  try {
    const body = await ctx.request.body({ type: "json" }).value as DownloadRequest;
    
    const jobId = generateJobId();
    const job: Job = {
      id: jobId,
      status: "pending",
      url: body.url,
      format_type: body.format_type || "audio",
      quality: body.quality || "best",
      playlist: body.playlist || false,
      created_at: Date.now(),
    };
    
    jobs.set(jobId, job);
    
    // Start download in background
    if (job.playlist) {
      downloadPlaylist(job).catch(e => {
        logError(`Playlist download error: ${e}`);
        job.status = "failed";
        job.error = String(e);
      });
    } else {
      downloadVideo(job).catch(e => {
        logError(`Video download error: ${e}`);
        job.status = "failed";
        job.error = String(e);
      });
    }
    
    ctx.response.body = {
      job_id: jobId,
      status: job.playlist ? "playlist" : "pending",
      message: job.playlist ? "Playlist download started" : "Download started",
    };
  } catch (e) {
    logError(`Download endpoint error: ${e}`);
    ctx.response.status = 500;
    ctx.response.body = { error: "Failed to start download" };
  }
});

// Status (single video)
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

// Status (playlist)
router.get("/status/playlist/:jobId", (ctx) => {
  const jobId = ctx.params.jobId;
  const job = jobs.get(jobId);
  
  if (!job) {
    ctx.response.status = 404;
    ctx.response.body = { error: "Job not found" };
    return;
  }
  
  ctx.response.body = {
    status: job.status,
    total_videos: job.total_videos || 0,
    current_video: job.current_video || 0,
    current_title: job.current_title || "",
    video_titles: job.video_titles || [],
    file_name: job.file_name,
    message: job.message,
    error: job.error,
  };
});

// Download file (single video)
router.get("/download/:jobId", async (ctx) => {
  const jobId = ctx.params.jobId;
  const job = jobs.get(jobId);
  
  if (!job || job.status !== "completed") {
    ctx.response.status = 404;
    ctx.response.body = { error: "File not ready" };
    return;
  }
  
  if (!job.file_path || !await exists(job.file_path)) {
    ctx.response.status = 404;
    ctx.response.body = { error: "File not found" };
    return;
  }
  
  // ✅ Set proper filename in Content-Disposition header
  const filename = job.file_name || "download.mp3";
  ctx.response.headers.set(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(filename)}"`
  );
  
  // Send file
  await send(ctx, job.file_name!, {
    root: `${DOWNLOAD_DIR}/${jobId}`,
  });
  
  // Schedule cleanup (don't await)
  cleanupJobFiles(jobId);
});

// Download playlist ZIP
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
  
  // ✅ Set proper filename in Content-Disposition header
  const filename = job.file_name || "playlist.zip";
  ctx.response.headers.set(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(filename)}"`
  );
  
  // Send ZIP file
  await send(ctx, job.file_name!, {
    root: `${DOWNLOAD_DIR}/${jobId}`,
  });
  
  // Schedule cleanup (don't await)
  cleanupJobFiles(jobId);
});

// ============================================================================
// APPLICATION
// ============================================================================

const app = new Application();

// CORS
app.use(oakCors({
  origin: "*",
}));

// Error handling
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    logError(`Unhandled error: ${err}`);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

// Routes
app.use(router.routes());
app.use(router.allowedMethods());

// ============================================================================
// STARTUP
// ============================================================================

async function main() {
  logInfo("YouTube Downloader API starting...");
  
  // Create necessary directories
  await Deno.mkdir(DOWNLOAD_DIR, { recursive: true });
  await Deno.mkdir("./public", { recursive: true });
  
  // Run startup cleanup
  await cleanupOrphanedFolders();
  
  // Start periodic cleanup task
  periodicCleanup().catch(e => logError(`Periodic cleanup error: ${e}`));
  
  logInfo(`Started periodic cleanup task`);
  logInfo(`Server listening on http://localhost:${PORT}`);
  
  await app.listen({ port: PORT });
}

// Run
if (import.meta.main) {
  main();
}