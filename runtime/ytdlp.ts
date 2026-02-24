//import { YT_DLP_PATH } from "../api.ts";
import { YT_DLP_PATH } from "../paths.ts";

export async function getYtdlpVersion(): Promise<string> {
  try {
    const cmd = new Deno.Command(YT_DLP_PATH, {
      args: ["--version"],
      stdout: "piped",
      stderr: "piped",
    });

    const { stdout, code } = await cmd.output();
    if (code !== 0) return "unknown";

    return new TextDecoder().decode(stdout).trim();
  } catch {
    return "unknown";
  }
}

export async function updateYtdlp(): Promise<{
  success: boolean;
  version: string;
  message: string;
}> {
  try {
    const cmd = new Deno.Command(YT_DLP_PATH, {
      args: ["-U"],
      stdout: "piped",
      stderr: "piped",
    });

    const { stdout, stderr, code } = await cmd.output();

    const out = new TextDecoder().decode(stdout);
    const err = new TextDecoder().decode(stderr);

    const version = await getYtdlpVersion();

    return {
      success: code === 0,
      version,
      message: out || err || "Update completed",
    };
  } catch (e) {
    return {
      success: false,
      version: "unknown",
      message: String(e),
    };
  }
}
