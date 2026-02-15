/**
 * Service Control CLI for ytdl
 *
 * Provides install/uninstall/start/stop commands to manage ytdl as a
 * Windows service (via sc.exe + advapi32 FFI) or Linux systemd unit.
 *
 * When started by Windows SCM with --service flag, performs the SCM
 * handshake via advapi32.dll FFI so Windows recognises the process as
 * a legitimate service.
 */

// ---------------------------------------------------------------------------
// Public state
// ---------------------------------------------------------------------------

/** True when the process was launched by Windows SCM (--service flag). */
export let isRunningAsService = false;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SERVICE_NAME = "ytdl";
const DISPLAY_NAME = "YouTube Downloader";

// Windows service status constants
const SERVICE_WIN32_OWN_PROCESS = 0x00000010;
const SERVICE_START_PENDING     = 0x00000002;
const SERVICE_RUNNING           = 0x00000004;
const SERVICE_STOP_PENDING      = 0x00000003;
const SERVICE_STOPPED           = 0x00000001;
const SERVICE_ACCEPT_STOP       = 0x00000001;
const SERVICE_CONTROL_STOP      = 0x00000001;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function exePath(): string {
  return Deno.execPath();
}

async function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const c = new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const out = await c.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

async function isElevated(): Promise<boolean> {
  if (Deno.build.os === "windows") {
    const r = await run("net", ["session"]);
    return r.code === 0;
  }
  // Linux / macOS
  return Deno.uid?.() === 0;
}

// ---------------------------------------------------------------------------
// Windows service control (sc.exe)
// ---------------------------------------------------------------------------

async function windowsInstall(): Promise<void> {
  if (!(await isElevated())) {
    console.error("Error: Administrator privileges required. Run from an elevated terminal.");
    Deno.exit(1);
  }

  const binPath = `"${exePath()}" --service`;
  const r = await run("sc.exe", [
    "create", SERVICE_NAME,
    `binPath=`, binPath,
    `start=`, "auto",
    `DisplayName=`, DISPLAY_NAME,
  ]);

  if (r.code === 0) {
    console.log(`Service '${SERVICE_NAME}' installed successfully.`);
  } else {
    console.error(`Failed to install service: ${r.stderr || r.stdout}`);
    Deno.exit(1);
  }
}

async function windowsUninstall(): Promise<void> {
  if (!(await isElevated())) {
    console.error("Error: Administrator privileges required. Run from an elevated terminal.");
    Deno.exit(1);
  }

  // Stop first (ignore errors – may already be stopped)
  await run("sc.exe", ["stop", SERVICE_NAME]);

  const r = await run("sc.exe", ["delete", SERVICE_NAME]);
  if (r.code === 0) {
    console.log(`Service '${SERVICE_NAME}' uninstalled successfully.`);
  } else {
    console.error(`Failed to uninstall service: ${r.stderr || r.stdout}`);
    Deno.exit(1);
  }
}

async function windowsStart(): Promise<void> {
  if (!(await isElevated())) {
    console.error("Error: Administrator privileges required. Run from an elevated terminal.");
    Deno.exit(1);
  }

  const r = await run("sc.exe", ["start", SERVICE_NAME]);
  if (r.code === 0) {
    console.log(`Service '${SERVICE_NAME}' started.`);
  } else {
    console.error(`Failed to start service: ${r.stderr || r.stdout}`);
    Deno.exit(1);
  }
}

async function windowsStop(): Promise<void> {
  if (!(await isElevated())) {
    console.error("Error: Administrator privileges required. Run from an elevated terminal.");
    Deno.exit(1);
  }

  const r = await run("sc.exe", ["stop", SERVICE_NAME]);
  if (r.code === 0) {
    console.log(`Service '${SERVICE_NAME}' stopped.`);
  } else {
    console.error(`Failed to stop service: ${r.stderr || r.stdout}`);
    Deno.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Windows SCM FFI handshake (--service mode)
// ---------------------------------------------------------------------------

// Shared state used by the FFI callbacks
let serviceStatusHandle: Deno.PointerObject | null = null;
let advapi32: Deno.DynamicLibrary<Record<string, Deno.ForeignFunction>> | null = null;
let stopResolve: (() => void) | null = null;

/**
 * Build a SERVICE_STATUS struct as a Uint8Array (28 bytes).
 *
 * Layout (all DWORD / uint32):
 *   0  dwServiceType
 *   4  dwCurrentState
 *   8  dwControlsAccepted
 *  12  dwWin32ExitCode
 *  16  dwServiceSpecificExitCode
 *  20  dwCheckPoint
 *  24  dwWaitHint
 */
function makeServiceStatus(
  state: number,
  controlsAccepted = 0,
  checkPoint = 0,
  waitHint = 0,
): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(28) as Uint8Array<ArrayBuffer>;
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, SERVICE_WIN32_OWN_PROCESS, true);
  dv.setUint32(4, state, true);
  dv.setUint32(8, controlsAccepted, true);
  dv.setUint32(12, 0, true); // win32 exit code
  dv.setUint32(16, 0, true); // service-specific exit code
  dv.setUint32(20, checkPoint, true);
  dv.setUint32(24, waitHint, true);
  return buf;
}

function setServiceStatus(state: number, controlsAccepted = 0, checkPoint = 0, waitHint = 0): void {
  if (!advapi32 || !serviceStatusHandle) return;
  const status = makeServiceStatus(state, controlsAccepted, checkPoint, waitHint);
  advapi32.symbols.SetServiceStatus(serviceStatusHandle, status);
}

/**
 * Run the Windows SCM handshake. This function blocks until the service
 * is told to stop.  It calls `appMain()` (the normal server startup) once
 * the handshake succeeds.
 */
export async function runAsWindowsService(appMain: () => Promise<void>): Promise<void> {
  isRunningAsService = true;

  advapi32 = Deno.dlopen("advapi32.dll", {
    RegisterServiceCtrlHandlerW: {
      parameters: ["buffer", "function"],
      result: "pointer",
    },
    SetServiceStatus: {
      parameters: ["pointer", "buffer"],
      result: "i32",
    },
    StartServiceCtrlDispatcherW: {
      parameters: ["buffer"],
      result: "i32",
      nonblocking: true, // CRITICAL: run on background thread so Deno event loop stays free
    },
  });

  // Promise that resolves when SCM sends STOP
  const stopPromise = new Promise<void>((resolve) => {
    stopResolve = resolve;
  });

  // Control handler callback – SCM calls this for stop / interrogate / etc.
  const ctrlHandler = new Deno.UnsafeCallback(
    { parameters: ["u32"], result: "void" } as const,
    (control: number) => {
      if (control === SERVICE_CONTROL_STOP) {
        setServiceStatus(SERVICE_STOP_PENDING, 0, 1, 5000);
        stopResolve?.();
      }
    },
  );

  // ServiceMain callback – SCM calls this once dispatch succeeds
  const serviceMain = new Deno.UnsafeCallback(
    { parameters: ["u32", "pointer"], result: "void" } as const,
    (_argc: number, _argv: Deno.PointerValue) => {
      // Register the control handler
      const nameBytes = encodeUtf16(SERVICE_NAME);
      serviceStatusHandle = advapi32!.symbols.RegisterServiceCtrlHandlerW(
        nameBytes,
        ctrlHandler.pointer,
      ) as Deno.PointerObject;

      // Report START_PENDING → RUNNING
      setServiceStatus(SERVICE_START_PENDING, 0, 0, 3000);
      setServiceStatus(SERVICE_RUNNING, SERVICE_ACCEPT_STOP);

      // Start the actual application (fire-and-forget; stopPromise controls lifecycle)
      appMain().catch((e) => console.error("Service main error:", e));
    },
  );

  // Build SERVICE_TABLE_ENTRY array (two entries: one real + one null terminator)
  // Each entry: pointer-sized name + pointer-sized proc  (so 2 * pointer-size bytes each)
  const ptrSize = 8; // 64-bit
  const tableBytes = new Uint8Array(4 * ptrSize) as Uint8Array<ArrayBuffer>; // 2 entries × 2 fields
  const nameBytes = encodeUtf16(SERVICE_NAME);

  // We need to write raw pointers into the table. Use BigInt views.
  const namePtr = Deno.UnsafePointer.of(nameBytes);
  const procPtr = serviceMain.pointer;
  const dv = new DataView(tableBytes.buffer);
  dv.setBigUint64(0, BigInt(Deno.UnsafePointer.value(namePtr)), true);
  dv.setBigUint64(ptrSize, BigInt(Deno.UnsafePointer.value(procPtr)), true);
  // Null terminator entry (already zeroed)

  // StartServiceCtrlDispatcherW blocks its thread until the service stops.
  // Using nonblocking: true so it runs on a worker thread and the Deno event
  // loop stays free for async work (Oak server, etc.).
  const dispatchPromise = advapi32.symbols.StartServiceCtrlDispatcherW(tableBytes) as Promise<number>;

  // Race: either the dispatcher succeeds and we wait for the stop signal,
  // or it fails immediately (e.g. not launched by SCM).
  const dispatchResult = await Promise.race([
    dispatchPromise.then((r) => ({ kind: "dispatch" as const, result: r })),
    // Give dispatcher 2 s to connect to SCM; if it hasn't by then, check result
    new Promise<{ kind: "timeout" }>((res) => setTimeout(() => res({ kind: "timeout" }), 2000)),
  ]);

  if (dispatchResult.kind === "dispatch" && !dispatchResult.result) {
    // Dispatch failed – probably running interactively
    console.error("StartServiceCtrlDispatcherW failed – running interactively instead.");
    ctrlHandler.close();
    serviceMain.close();
    await appMain();
    return;
  }

  // Dispatcher is running on background thread. Wait for SCM stop signal.
  await stopPromise;
  setServiceStatus(SERVICE_STOPPED);

  ctrlHandler.close();
  serviceMain.close();
}

/** Encode a string as null-terminated UTF-16LE bytes. */
function encodeUtf16(str: string): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array((str.length + 1) * 2) as Uint8Array<ArrayBuffer>;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    buf[i * 2] = code & 0xff;
    buf[i * 2 + 1] = (code >> 8) & 0xff;
  }
  // Last two bytes are already 0 (null terminator)
  return buf;
}

// ---------------------------------------------------------------------------
// Linux systemd
// ---------------------------------------------------------------------------

function systemdUnitContent(): string {
  const bin = exePath();
  return `[Unit]
Description=${DISPLAY_NAME}
After=network.target

[Service]
Type=simple
ExecStart=${bin}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

const UNIT_PATH = `/etc/systemd/system/${SERVICE_NAME}.service`;

async function linuxInstall(): Promise<void> {
  if (!(await isElevated())) {
    console.error("Error: Root privileges required. Run with sudo.");
    Deno.exit(1);
  }

  await Deno.writeTextFile(UNIT_PATH, systemdUnitContent());
  await run("systemctl", ["daemon-reload"]);
  const r = await run("systemctl", ["enable", SERVICE_NAME]);
  if (r.code === 0) {
    console.log(`Service '${SERVICE_NAME}' installed and enabled.`);
  } else {
    console.error(`Failed to enable service: ${r.stderr || r.stdout}`);
    Deno.exit(1);
  }
}

async function linuxUninstall(): Promise<void> {
  if (!(await isElevated())) {
    console.error("Error: Root privileges required. Run with sudo.");
    Deno.exit(1);
  }

  await run("systemctl", ["stop", SERVICE_NAME]);
  await run("systemctl", ["disable", SERVICE_NAME]);

  try {
    await Deno.remove(UNIT_PATH);
  } catch { /* may not exist */ }

  await run("systemctl", ["daemon-reload"]);
  console.log(`Service '${SERVICE_NAME}' uninstalled.`);
}

async function linuxStart(): Promise<void> {
  if (!(await isElevated())) {
    console.error("Error: Root privileges required. Run with sudo.");
    Deno.exit(1);
  }

  const r = await run("systemctl", ["start", SERVICE_NAME]);
  if (r.code === 0) {
    console.log(`Service '${SERVICE_NAME}' started.`);
  } else {
    console.error(`Failed to start service: ${r.stderr || r.stdout}`);
    Deno.exit(1);
  }
}

async function linuxStop(): Promise<void> {
  if (!(await isElevated())) {
    console.error("Error: Root privileges required. Run with sudo.");
    Deno.exit(1);
  }

  const r = await run("systemctl", ["stop", SERVICE_NAME]);
  if (r.code === 0) {
    console.log(`Service '${SERVICE_NAME}' stopped.`);
  } else {
    console.error(`Failed to stop service: ${r.stderr || r.stdout}`);
    Deno.exit(1);
  }
}

// ---------------------------------------------------------------------------
// CLI help & version
// ---------------------------------------------------------------------------

const APP_VERSION = "1.0.7";

function printHelp(): void {
  console.log(`
ytdl v${APP_VERSION} - YouTube Downloader API Server

USAGE:
    ytdl [OPTIONS]
    ytdl <COMMAND>

COMMANDS:
    install        Install ytdl as a system service (requires admin/root)
    uninstall      Uninstall the ytdl system service (requires admin/root)
    start          Start the ytdl service (requires admin/root)
    stop           Stop the ytdl service (requires admin/root)

OPTIONS:
    -h, --help     Show this help message and exit
    -v, --version  Show version and exit
    -p, --port <PORT>
                   Set the server port (default: 8000, or PORT env var)

ENVIRONMENT VARIABLES:
    PORT           Server port (overridden by --port flag)
    YT_DLP_PATH    Path to yt-dlp binary
    FFMPEG_PATH    Path to ffmpeg binary

EXAMPLES:
    ytdl                    Start the server on port 8000
    ytdl --port 3000        Start the server on port 3000
    ytdl install            Install as a Windows/systemd service
    ytdl start              Start the installed service
    ytdl stop               Stop the running service
    ytdl uninstall          Remove the installed service
`.trimStart());
}

function printVersion(): void {
  console.log(`ytdl v${APP_VERSION}`);
}

// ---------------------------------------------------------------------------
// Public CLI entry point
// ---------------------------------------------------------------------------

export interface CliOptions {
  /** Port override from --port flag, or undefined to use default. */
  port?: number;
}

/**
 * Parse CLI arguments. Handles --help, --version, service commands, and
 * option flags like --port. Returns `{ handled: true }` if the process
 * should exit (help/version/service command), or `{ handled: false, options }`
 * with parsed options for normal server startup.
 */
export async function handleCli(): Promise<{ handled: true } | { handled: false; options: CliOptions }> {
  const args = [...Deno.args];
  const options: CliOptions = {};

  // Quick scan for help / version (highest priority)
  if (args.includes("-h") || args.includes("--help")) {
    printHelp();
    Deno.exit(0);
  }
  if (args.includes("-v") || args.includes("--version")) {
    printVersion();
    Deno.exit(0);
  }

  // --service is the internal flag used by Windows SCM; not a CLI command
  if (args[0] === "--service") {
    return { handled: false, options };
  }

  // Parse --port / -p
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" || args[i] === "-p") {
      const val = args[i + 1];
      if (!val || isNaN(Number(val))) {
        console.error(`Error: --port requires a numeric value.`);
        Deno.exit(1);
      }
      options.port = Number(val);
      i++; // skip value
      continue;
    }
  }

  // Service commands
  const cmd = args[0];
  const serviceCommands = ["install", "uninstall", "start", "stop"];
  if (cmd && serviceCommands.includes(cmd)) {
    await runServiceCommand(cmd);
    Deno.exit(0); // always exit after service commands
  }

  // Unknown positional argument
  if (cmd && !cmd.startsWith("-")) {
    console.error(`Unknown command: ${cmd}\n`);
    printHelp();
    Deno.exit(1);
  }

  return { handled: false, options };
}

/** Back-compat alias – old code calls handleServiceCommand(). */
export async function handleServiceCommand(): Promise<boolean> {
  const result = await handleCli();
  return result.handled;
}

async function runServiceCommand(cmd: string): Promise<void> {
  const os = Deno.build.os;

  if (os === "darwin") {
    console.log("macOS service management is not supported. Please use launchd manually.");
    return;
  }

  const actions: Record<string, Record<string, () => Promise<void>>> = {
    windows: { install: windowsInstall, uninstall: windowsUninstall, start: windowsStart, stop: windowsStop },
    linux:   { install: linuxInstall,   uninstall: linuxUninstall,   start: linuxStart,   stop: linuxStop },
  };

  const platformActions = actions[os];
  if (!platformActions) {
    console.error(`Unsupported platform: ${os}`);
    Deno.exit(1);
  }

  await platformActions[cmd]();
}
