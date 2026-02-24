import { Router } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { join } from "https://deno.land/std@0.202.0/path/mod.ts";
import { ensureDir } from "https://deno.land/std@0.208.0/fs/mod.ts";
import { loadConfig, saveConfig, validateConfig } from "../config.ts";
import { changePassword } from "../auth.ts";
import { updateYtdlp } from "../runtime/ytdlp.ts";
import { authMiddleware } from "../middleware/auth_middleware.ts";
import type { Config } from "../config.ts";
import { BIN_DIR, DOWNLOADS_DIR, LOGS_DIR, DENO_PATH } from "../paths.ts";

// 🔥 Runtime path comes from api.ts — NOT config
//import { YT_DLP_PATH } from "../api.ts";
import { YT_DLP_PATH } from "../paths.ts";

const adminRouter = new Router();

// All admin routes require authentication
adminRouter.use(authMiddleware);

//
// ============================================================================
// GET /config
// ============================================================================
adminRouter.get("/config", async (ctx) => {
  const config = await loadConfig();

  // Remove password hash
  const safeConfig = { ...config };
  delete safeConfig.password_hash;

  // Detect yt-dlp version
  let ytdlp_version = "unknown";

  try {
    const cmd = new Deno.Command(YT_DLP_PATH, {
      args: ["--version"],
      stdout: "piped",
      stderr: "piped",
    });

    const { stdout, code } = await cmd.output();

    if (code === 0) {
      ytdlp_version = new TextDecoder().decode(stdout).trim();
    }
  } catch {
    ytdlp_version = "not found";
  }

  // Check if cookies.txt exists and get its size
  let cookie_exists = false;
  let cookie_size = 0;
  try {
    const cookieStat = await Deno.stat(join(BIN_DIR, "cookies.txt"));
    cookie_exists = cookieStat.isFile && cookieStat.size > 0;
    cookie_size = cookieStat.size;
  } catch { /* not found */ }

  ctx.response.body = {
    // ===== USER CONFIG =====
    search_results: safeConfig.search_results,
    max_duration: safeConfig.max_duration,
    max_file_size: safeConfig.max_file_size,
    id3_comment: safeConfig.id3_comment,
    cleanup_enabled: safeConfig.cleanup_enabled,
    cleanup_interval: safeConfig.cleanup_interval,
    cleanup_max_age: safeConfig.cleanup_max_age,
    startup_cleanup: safeConfig.startup_cleanup,
    session_timeout: safeConfig.session_timeout,
    require_auth_home: safeConfig.require_auth_home,
    require_auth_api: safeConfig.require_auth_api,
    cors_allowed_origins: safeConfig.cors_allowed_origins,
    allowed_download_domains: safeConfig.allowed_download_domains,
    rate_limit_search_per_minute: safeConfig.rate_limit_search_per_minute,
    rate_limit_download_per_minute: safeConfig.rate_limit_download_per_minute,

    // ===== RUNTIME (READ-ONLY) =====
	download_dir: DOWNLOADS_DIR,
    cookie_file: join(BIN_DIR, "cookies.txt"),
    cookie_exists,
    cookie_size,
    ytdlp_path: YT_DLP_PATH,
    //deno_path: Deno.execPath(),
	deno_path: DENO_PATH,
    ytdlp_version,
  };
});

// ============================================================================
// POST /config
// ============================================================================
adminRouter.post("/config", async (ctx) => {
  try {
    const body = await ctx.request.body({ type: "json" }).value;

    const session = ctx.state.session;
    if (!body.csrf_token || body.csrf_token !== session.csrf_token) {
      ctx.response.status = 403;
      ctx.response.body = { error: "CSRF token validation failed" };
      return;
    }

    const { csrf_token: _csrf_token, ...updates } = body;

    const validation = validateConfig(updates);
    if (!validation.valid) {
      ctx.response.status = 400;
      ctx.response.body = {
        error: "Validation failed",
        errors: validation.errors,
      };
      return;
    }

    const config = await loadConfig();

    // Only allow true user-editable fields
    const allowedFields: (keyof Config)[] = [
      "search_results",
      "max_duration",
      "max_file_size",
      "id3_comment",
      "cleanup_enabled",
      "cleanup_interval",
      "cleanup_max_age",
      "startup_cleanup",
      "session_timeout",
      "require_auth_home",
      "require_auth_api",
      "cors_allowed_origins",
      "allowed_download_domains",
      "rate_limit_search_per_minute",
      "rate_limit_download_per_minute",
    ];

    const setConfigField = <K extends keyof Config>(field: K, value: Config[K]) => {
      config[field] = value;
    };

    for (const field of allowedFields) {
      const value = updates[field];
      if (value !== undefined) {
        setConfigField(field, value as Config[typeof field]);
      }
    }

    await saveConfig(config);

    ctx.response.body = {
      success: true,
      message: "Configuration updated successfully",
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = {
      error: "Failed to update configuration",
      message: String(error),
    };
  }
});

// ============================================================================
// GET /admin/logs
// ============================================================================
adminRouter.get("/admin/logs", async (ctx) => {
  try {
    const params = ctx.request.url.searchParams;
    const lines = parseInt(params.get("lines") || "100");
    const filter = params.get("filter") || "all";

    if (isNaN(lines) || lines < 1 || lines > 10000) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Invalid lines parameter (1-10000)" };
      return;
    }

    const validFilters = ["all", "error", "warning", "info", "debug"];
    if (!validFilters.includes(filter)) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Invalid filter parameter" };
      return;
    }

    const logPath = join(LOGS_DIR, "app.log");
    const logs: string[] = [];

    //console.error(`LOGS_DIR = ${LOGS_DIR}`);

    try {
      const content = await Deno.readTextFile(logPath);
      const allLines = content.split("\n").filter(l => l.trim());

      let filtered = allLines;

      if (filter !== "all") {
        filtered = allLines.filter(line =>
          line.toLowerCase().includes(`- ${filter} -`)
        );
      }

      logs.push(...filtered.slice(-lines));
    } catch {
      logs.push("Log file not found.");
    }

    ctx.response.body = { logs };

  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = {
      error: "Failed to read logs",
      message: String(error),
    };
  }
});

// ============================================================================
// POST /admin/update-ytdlp
// ============================================================================
adminRouter.post("/admin/update-ytdlp", async (ctx) => {
  try {
    const body = await ctx.request.body({ type: "json" }).value;
    const session = ctx.state.session;

    if (!body.csrf_token || body.csrf_token !== session.csrf_token) {
      ctx.response.status = 403;
      ctx.response.body = { error: "CSRF token validation failed" };
      return;
    }

    const result = await updateYtdlp();

    // 🚫 DO NOT write version into config anymore
    ctx.response.body = result;

  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = {
      success: false,
      version: "unknown",
      message: String(error),
    };
  }
});

// ============================================================================
// POST /admin/upload-cookies
// ============================================================================
adminRouter.post("/admin/upload-cookies", async (ctx) => {
  try {
    const contentType = ctx.request.headers.get("content-type") || "";

    if (!contentType.includes("multipart/form-data")) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Expected multipart/form-data" };
      return;
    }

    const body = ctx.request.body({ type: "form-data" });
    const formData = await body.value.read({ maxSize: 2 * 1024 * 1024 }); // 2 MB max

    // CSRF check from form field
    const session = ctx.state.session;
    const csrfToken = formData.fields?.csrf_token;
    if (!csrfToken || csrfToken !== session.csrf_token) {
      ctx.response.status = 403;
      ctx.response.body = { error: "CSRF token validation failed" };
      return;
    }

    const file = formData.files?.find((f) => f.name === "cookies_file");
    if (!file) {
      ctx.response.status = 400;
      ctx.response.body = { error: "No file uploaded" };
      return;
    }

    // Validate: must be a .txt file
    const origName = file.originalName || file.filename || "";
    if (!origName.toLowerCase().endsWith(".txt")) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Only .txt files are accepted" };
      return;
    }

    // Read content from temp file or memory
    let content: Uint8Array;
    if (file.content) {
      content = file.content;
    } else if (file.filename) {
      content = await Deno.readFile(file.filename);
    } else {
      ctx.response.status = 400;
      ctx.response.body = { error: "Could not read uploaded file" };
      return;
    }

    // Basic validation: should look like a Netscape cookie file
    const text = new TextDecoder().decode(content);
    if (text.trim().length === 0) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Uploaded file is empty" };
      return;
    }

    // Write to bin/cookies.txt
    await ensureDir(BIN_DIR);
    const cookiePath = join(BIN_DIR, "cookies.txt");
    await Deno.writeFile(cookiePath, content);

    const lineCount = text.split("\n").filter((l) => l.trim() && !l.startsWith("#")).length;

    ctx.response.body = {
      success: true,
      message: `cookies.txt uploaded (${lineCount} entries)`,
      path: cookiePath,
    };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = {
      error: "Failed to upload cookies file",
      message: String(error),
    };
  }
});

// ============================================================================
// DELETE /admin/cookies
// ============================================================================
adminRouter.delete("/admin/cookies", async (ctx) => {
  try {
    const session = ctx.state.session;
    const csrfToken = ctx.request.headers.get("x-csrf-token") || "";

    if (!csrfToken || csrfToken !== session.csrf_token) {
      ctx.response.status = 403;
      ctx.response.body = { error: "CSRF token validation failed" };
      return;
    }

    const cookiePath = join(BIN_DIR, "cookies.txt");
    await Deno.remove(cookiePath);
    ctx.response.body = { success: true, message: "cookies.txt deleted" };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      ctx.response.body = { success: true, message: "No cookies file to delete" };
    } else {
      ctx.response.status = 500;
      ctx.response.body = { error: "Failed to delete cookies", message: String(error) };
    }
  }
});

// ============================================================================
// POST /admin/change-password
// ============================================================================
adminRouter.post("/admin/change-password", async (ctx) => {
  try {
    const body = await ctx.request.body({ type: "json" }).value;

    const session = ctx.state.session;
    if (!body.csrf_token || body.csrf_token !== session.csrf_token) {
      ctx.response.status = 403;
      ctx.response.body = { error: "CSRF token validation failed" };
      return;
    }

    const { current_password, new_password } = body;

    if (!current_password || !new_password) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Current password and new password are required" };
      return;
    }

    const result = await changePassword(current_password, new_password);

    if (!result.success) {
      ctx.response.status = 400;
      ctx.response.body = { error: result.message };
      return;
    }

    ctx.response.body = { success: true, message: result.message };
  } catch (error) {
    ctx.response.status = 500;
    ctx.response.body = {
      error: "Failed to change password",
      message: String(error),
    };
  }
});

export default adminRouter;
