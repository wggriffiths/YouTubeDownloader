import { Router } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { join } from "https://deno.land/std@0.202.0/path/mod.ts";
import { loadConfig, saveConfig, validateConfig } from "../config.ts";
import { updateYtdlp, getYtdlpVersion } from "../runtime/ytdlp.ts";
import { authMiddleware } from "../middleware/auth_middleware.ts";
import type { Config } from "../config.ts";
import { ROOT_DIR, BIN_DIR, DOWNLOADS_DIR, LOGS_DIR } from "../paths.ts";

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

  ctx.response.body = {
    // ===== USER CONFIG =====
    search_results: safeConfig.search_results,
    max_duration: safeConfig.max_duration,
    max_file_size: safeConfig.max_file_size,
    id3_comment: safeConfig.id3_comment,
 
    // ===== RUNTIME (READ-ONLY) =====
	download_dir: DOWNLOADS_DIR,
    cookie_file: join(BIN_DIR, "cookies.txt"),
    ytdlp_path: YT_DLP_PATH,
    deno_path: Deno.execPath(),
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

    const { csrf_token, ...updates } = body;

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
    ];

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        (config as any)[field] = updates[field];
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

export default adminRouter;
