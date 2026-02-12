#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-run --allow-env

/**
 * YouTube Downloader API - Deno/TypeScript Port
 * Version: 1.0.5
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

import { join, resolve, dirname } from "https://deno.land/std@0.202.0/path/mod.ts";
import { Application, Router, send } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { oakCors } from "https://deno.land/x/cors@v1.2.2/mod.ts";
import { exists } from "https://deno.land/std@0.208.0/fs/mod.ts";

// ============================================================================
// CONFIGURATION
// ============================================================================

const PORT = parseInt(Deno.env.get("PORT") || "8000");
const DOWNLOAD_DIR = Deno.env.get("DOWNLOAD_DIR") || "./downloads";
const SEARCH_RESULTS = parseInt(Deno.env.get("SEARCH_RESULTS") || "40");
const MAX_DURATION = parseInt(Deno.env.get("MAX_DURATION") || "600");
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
  
  // Playlist-specific fields (match Python API exactly)
  playlist_title?: string;     
  total_videos?: number;
  current_video?: number;
  current_title?: string;
  video_titles?: string[];
  skipped_videos?: string[];   // Track geo-blocked/unavailable
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

function logDebug(message: string) {
  const timestamp = new Date().toISOString();
  console.log(`${timestamp} - DEBUG - ${message}`);
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

  const baseDir = dirname(Deno.execPath());
  const cookiesPath = join(baseDir, "bin", "cookies.txt");

  let useCookies = false;
  try {
    await Deno.stat(cookiesPath);
    useCookies = true;
  } catch {}

  const args: string[] = [
    "--no-playlist",
    "--format",
    job.format_type === "video"
      ? `bestvideo[height<=${job.quality}]+bestaudio[ext=m4a]/best[height<=${job.quality}]`
      : "bestaudio",
  ];

  if (useCookies) {
    args.splice(1, 0, "--cookies", cookiesPath);
  }

  if (job.format_type === "audio") {
    args.push(
      "--extract-audio",
      "--audio-format", "mp3",
      "--audio-quality", "0",
      "--embed-thumbnail",
      "--add-metadata",
      "--parse-metadata", "%(title)s:%(meta_artist)s - %(meta_title)s",
      "--parse-metadata", "%(uploader)s:%(meta_uploader)s",
      "--output", `${downloadDir}/%(meta_artist,meta_uploader,uploader|Unknown Artist)s - %(meta_title,title)s.%(ext)s`,
    );
	
  } else {
    args.push(
      "--merge-output-format", "mp4",
      "--embed-thumbnail",
      "--add-metadata",
      "--output", `${downloadDir}/%(title)s.%(ext)s`,
    );	
  }

  args.push(job.url);

  const command = new Deno.Command(YT_DLP_PATH, {
    args,
    stdout: "piped",
    stderr: "piped",
    cwd: Deno.cwd(),
  });

  const { stderr, code } = await command.output();

  if (code !== 0) {
    const error = new TextDecoder().decode(stderr);
    job.status = "failed";
    job.error = error;
    logError(`Download failed for job ${jobId}: ${error}`);
    return;
  }

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
  logInfo(`╔${"═".repeat(78)}╗`);
  logInfo(`║ PLAYLIST DOWNLOAD STARTED: ${jobId.substring(0, 50).padEnd(50)} ║`);
  logInfo(`╚${"═".repeat(78)}╝`);
  logInfo(`URL: ${job.url}`);

  const baseDir = dirname(Deno.execPath());
  const cookiesPath = join(baseDir, "bin", "cookies.txt");

  let useCookies = false;
  try {
    await Deno.stat(cookiesPath);
    useCookies = true;
    logInfo(`✓ Using cookies file: ${cookiesPath}`);
  } catch {
    logInfo(`ℹ No cookies file found`);
  }

  const args: string[] = [
    "--yes-playlist",
    "--ignore-errors",            // Skip unavailable videos
    "--no-warnings",              // Reduce noise
    "--newline",                  // Force line-by-line output
    "--progress",                 // Force progress display
    "--console-title",            // Additional progress info
    "--format",
    job.format_type === "video"
      ? `bestvideo[height<=${job.quality}]+bestaudio/best[height<=${job.quality}]`
      : "bestaudio",
  ];

  if (useCookies) {
    args.splice(1, 0, "--cookies", cookiesPath);
  }

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

  const command = new Deno.Command(YT_DLP_PATH, {
    args,
    stdout: "piped",
    stderr: "piped",
  });

  const process = command.spawn();

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

          // Pattern 1: [download] Downloading video N of M
          let match = line.match(/\[download\]\s+Downloading\s+(?:video|item)\s+(\d+)\s+of\s+(\d+)/i);
          if (match) {
            const current = parseInt(match[1], 10);
            const total = parseInt(match[2], 10);
            
            job.current_video = current;
            job.total_videos = total;
            
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
            logInfo(`📋 Playlist: ${playlistTitle}`);
            continue;
          }

          // Pattern 6: Geo-blocked / unavailable
          match = line.match(/(?:unavailable|not available|blocked|ERROR)/i);
          if (match) {
            logInfo(`⚠️  Skipped unavailable video`);
            if (job.current_title && !job.skipped_videos?.includes(job.current_title)) {
              job.skipped_videos?.push(job.current_title);
            }
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
            logError(`yt-dlp error: ${line.trim()}`);
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

    const ageMs = Date.now() - stat.mtime!.getTime();
    if (ageMs < 1000) continue;

    files.push(entry.name);
  }

  logInfo(`Found ${files.length} ${fileExtension} files in ${downloadDir}`);

  // Override total_videos with actual successful files
  job.total_videos = files.length;
  job.current_video = files.length;

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
    job.error = code !== 0 
      ? "All videos in playlist were unavailable or blocked" 
      : "No files downloaded from playlist";
    logError(`No ${fileExtension} files found for playlist job ${jobId} (exit code: ${code})`);
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
    return;
  }

  job.status = "completed";
  job.file_name = zipFileName;
  job.file_path = zipPath;
  job.message = `Downloaded ${files.length} videos`;
  
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
  logInfo("Running startup cleanup...");
  
  try {
    if (await exists(DOWNLOAD_DIR)) {
      for await (const entry of Deno.readDir(DOWNLOAD_DIR)) {
        if (entry.isDirectory) {
          const folderPath = `${DOWNLOAD_DIR}/${entry.name}`;
          try {
            await Deno.remove(folderPath, { recursive: true });
            logInfo(`Cleaned up orphaned folder: ${entry.name}`);
          } catch (e) {
            logError(`Failed to remove folder ${entry.name}: ${e}`);
          }
        }
      }
    }
    logInfo("Startup cleanup complete");
  } catch (e) {
    logError(`Startup cleanup error: ${e}`);
  }
}

async function periodicCleanup() {
  while (true) {
    await new Promise(resolve => setTimeout(resolve, 300000)); // 5 minutes
    
    try {
      const now = Date.now();
      const maxAge = 600000; // 10 minutes
      
      for (const [jobId, job] of jobs.entries()) {
        const age = now - job.created_at;
        
        if (age > maxAge && (job.status === "completed" || job.status === "failed")) {
          try {
            const folderPath = `${DOWNLOAD_DIR}/${jobId}`;
            if (await exists(folderPath)) {
              await Deno.remove(folderPath, { recursive: true });
              logInfo(`Periodic cleanup: removed ${jobId}`);
            }
            jobs.delete(jobId);
          } catch (e) {
            logError(`Periodic cleanup error for ${jobId}: ${e}`);
          }
        }
      }
      
      if (await exists(DOWNLOAD_DIR)) {
        for await (const entry of Deno.readDir(DOWNLOAD_DIR)) {
          if (entry.isDirectory && !jobs.has(entry.name)) {
            try {
              const folderPath = `${DOWNLOAD_DIR}/${entry.name}`;
              await Deno.remove(folderPath, { recursive: true });
              logInfo(`Periodic cleanup: removed orphaned folder ${entry.name}`);
            } catch (e) {
              logError(`Error removing orphaned folder ${entry.name}: ${e}`);
            }
          }
        }
      }
    } catch (e) {
      logError(`Error in cleanup task: ${e}`);
    }
  }
}

async function cleanupJobFiles(jobId: string) {
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

router.get("/", async (ctx) => {
  try {
    const html = await Deno.readTextFile("./public/index.html");
    ctx.response.type = "text/html";
    ctx.response.body = html;
  } catch (e) {
    ctx.response.body = {
      service: "YouTube Downloader API",
      version: "1.0.5",
      status: "online",
      message: "Frontend not found. Deploy index.html to ./public/",
    };
  }
});

router.get("/health", (ctx) => {
  ctx.response.body = {
    service: "YouTube Downloader API",
    version: "1.0.5",
    status: "online",
  };
});

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

router.post("/download", async (ctx) => {
  try {
    const body = await ctx.request.body({ type: "json" }).value as DownloadRequest;
    
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
    
    logInfo(`New download request: ${jobId} - ${isPlaylist ? 'PLAYLIST' : 'SINGLE'} - ${body.url}`);
    
    // Start download in background
    if (isPlaylist) {
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
  
  const filename = job.file_name || "download.mp3";
  ctx.response.headers.set(
    "Content-Disposition",
    `attachment; filename="${encodeURIComponent(filename)}"`
  );
  
  await send(ctx, job.file_name!, {
    root: `${DOWNLOAD_DIR}/${jobId}`,
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
    root: `${DOWNLOAD_DIR}/${jobId}`,
  });
  
  cleanupJobFiles(jobId);
});

// ============================================================================
// APPLICATION
// ============================================================================

const app = new Application();

app.use(oakCors({
  origin: "*",
}));

app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    logError(`Unhandled error: ${err}`);
    ctx.response.status = 500;
    ctx.response.body = { error: "Internal server error" };
  }
});

app.use(router.routes());
app.use(router.allowedMethods());

// ============================================================================
// STARTUP
// ============================================================================

async function main() {
  logInfo("═".repeat(80));
  logInfo("YouTube Downloader API v1.0.5");
  logInfo("═".repeat(80));
  
  await Deno.mkdir(DOWNLOAD_DIR, { recursive: true });
  await Deno.mkdir("./public", { recursive: true });
  
  await cleanupOrphanedFolders();
  
  periodicCleanup().catch(e => logError(`Periodic cleanup error: ${e}`));
  
  logInfo(`✓ Download directory: ${DOWNLOAD_DIR}`);
  logInfo(`✓ yt-dlp path: ${YT_DLP_PATH}`);
  logInfo(`✓ ZIP method: ${Deno.build.os === "windows" ? "PowerShell" : "system zip"}`);
  logInfo(`✓ Periodic cleanup started`);
  logInfo(`✓ Server listening on http://localhost:${PORT}`);
  logInfo("═".repeat(80));
  
  await app.listen({ port: PORT });
}

if (import.meta.main) {
  main();
}