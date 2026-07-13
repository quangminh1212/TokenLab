/**
 * System tray icon while serve is running.
 * Windows: PowerShell NotifyIcon (no native npm deps).
 * Other platforms: no-op (returns null).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, writeFile, unlink } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser } from "./util.js";

export interface TrayHandle {
  stop: () => void;
}

export interface TrayOptions {
  url: string;
  title?: string;
  tooltip?: string;
  onQuit: () => void;
}

// Simple file logger to %LOCALAPPDATA%\xlab-token\tray.txt
const logDir = path.join(process.env.LOCALAPPDATA || process.env.APPDATA || process.cwd(), "xlab-token");
const logFile = path.join(logDir, "tray.txt");

function log(...args: unknown[]): void {
  const message = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ")}`;
  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    fs.appendFileSync(logFile, message + "\r\n");
  } catch {
    // ignore logging errors
  }
}

function logError(...args: unknown[]): void {
  log("[ERROR]", ...args);
}

function assetsDir(): string {
  // dist/tray.js → dist/server/assets ; src/tray.ts (tsx) → src/server/assets
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "server", "assets");
}

async function resolveIconPath(): Promise<string | null> {
  const base = assetsDir();
  const candidates = [
    path.join(base, "favicon.ico"),
    path.join(base, "logo.png"),
    path.join(base, "favicon-32x32.png"),
  ];
  for (const p of candidates) {
    try {
      await access(p);
      return p;
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Build a compact PowerShell script that hosts a NotifyIcon with context menu.
 * Communicates via stdout lines: open | quit
 */
function buildPsScript(opts: {
  url: string;
  title: string;
  tooltip: string;
  iconPath: string | null;
}): string {
  const esc = (s: string) => s.replace(/'/g, "''");
  const url = esc(opts.url);
  const title = esc(opts.title);
  const tooltip = esc(opts.tooltip);
  const icon = opts.iconPath ? esc(opts.iconPath) : "";

  return `
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$icon = New-Object System.Windows.Forms.NotifyIcon
$tip = '${tooltip}'
if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 63) }
$icon.Text = $tip
$icon.Visible = $true

$iconPath = '${icon}'.Trim()
$loadedIcon = $false
if ($iconPath -ne '' -and (Test-Path -LiteralPath $iconPath)) {
  try {
    if ($iconPath.ToLower().EndsWith('.ico')) {
      $icon.Icon = New-Object System.Drawing.Icon($iconPath)
    } else {
      $bmp = [System.Drawing.Image]::FromFile($iconPath)
      $h = (New-Object System.Drawing.Bitmap $bmp).GetHicon()
      $icon.Icon = [System.Drawing.Icon]::FromHandle($h)
    }
    $loadedIcon = $true
    [Console]::Out.WriteLine("icon-loaded:$iconPath")
  } catch {
    [Console]::Out.WriteLine("icon-error:" + $_.Exception.Message)
  }
} else {
  [Console]::Out.WriteLine("icon-missing:$iconPath")
}
if (-not $loadedIcon) {
  $icon.Icon = [System.Drawing.SystemIcons]::Application
}
$icon.Visible = $true
[Console]::Out.WriteLine("tray-visible")

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = New-Object System.Windows.Forms.ToolStripMenuItem('Open Dashboard')
$sep = New-Object System.Windows.Forms.ToolStripSeparator
$quitItem = New-Object System.Windows.Forms.ToolStripMenuItem('Quit')
[void]$menu.Items.Add($openItem)
[void]$menu.Items.Add($sep)
[void]$menu.Items.Add($quitItem)
$icon.ContextMenuStrip = $menu

function Emit-Open {
  [Console]::Out.WriteLine('open')
  [Console]::Out.Flush()
}
function Emit-Quit {
  try { $icon.Visible = $false; $icon.Dispose() } catch {}
  [Console]::Out.WriteLine('quit')
  [Console]::Out.Flush()
  [System.Windows.Forms.Application]::Exit()
}

$openItem.add_Click({ Emit-Open })
$icon.add_DoubleClick({ Emit-Open })
$icon.add_Click({
  param($sender, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Emit-Open }
})
$quitItem.add_Click({ Emit-Quit })

# Hidden form hosts the WinForms message loop (required for NotifyIcon)
$form = New-Object System.Windows.Forms.Form
$form.Text = '${title}'
$form.WindowState = 'Minimized'
$form.ShowInTaskbar = $false
$form.Opacity = 0
$form.ShowIcon = $false
$form.FormBorderStyle = 'FixedToolWindow'
$form.Size = New-Object System.Drawing.Size(1, 1)
$form.add_Load({
  $icon.Visible = $true
  try {
    $icon.ShowBalloonTip(5000, '${title}', 'XLab Token is running. Click the tray icon to open the dashboard.', [System.Windows.Forms.ToolTipIcon]::Info)
  } catch {}
  [Console]::Out.WriteLine('form-loaded')
  [Console]::Out.Flush()
})
$form.add_FormClosing({
  try { $icon.Visible = $false; $icon.Dispose() } catch {}
})
$form.add_Shown({ $form.Hide() })

[System.Windows.Forms.Application]::Run($form)
`.trim();
}

export async function startTray(opts: TrayOptions): Promise<TrayHandle | null> {
  log("startTray called");
  if (process.platform !== "win32") {
    log("Tray disabled: not Windows");
    return null;
  }
  if (process.env.XLAB_TOKEN_NO_TRAY === "1") {
    log("Tray disabled: XLAB_TOKEN_NO_TRAY=1");
    return null;
  }

  const title = opts.title || "XLab Token";
  const tooltip = opts.tooltip || "XLab Token — click to open dashboard";
  const iconPath = await resolveIconPath();
  log("Resolved icon path:", iconPath);
  const script = buildPsScript({
    url: opts.url,
    title,
    tooltip,
    iconPath,
  });

  // Write script to a temp .ps1 — more reliable than -Command with long scripts
  let scriptPath = "";
  try {
    const dir = path.join(os.tmpdir(), "xlab-token");
    await mkdir(dir, { recursive: true });
    scriptPath = path.join(dir, `tray-${process.pid}.ps1`);
    await writeFile(scriptPath, script, "utf8");
    log("Tray script written:", scriptPath, "bytes:", script.length);
  } catch (err) {
    logError("Failed to write tray script:", err instanceof Error ? err.message : err);
    return null;
  }

  let child: ChildProcess | null = null;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (child && !child.killed) {
      try {
        child.kill();
      } catch {
        // ignore
      }
    }
    child = null;
    if (scriptPath) {
      void unlink(scriptPath).catch(() => {});
    }
  };

  try {
    // -STA is required for WinForms NotifyIcon message pump
    child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-File",
        scriptPath,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    log("PowerShell child spawned, pid:", child.pid);
  } catch (err) {
    logError("Failed to spawn PowerShell tray:", err instanceof Error ? err.message : err);
    void unlink(scriptPath).catch(() => {});
    return null;
  }

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    const lines = String(chunk)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    log("Tray stdout:", lines.join(" | "));
    for (const line of lines) {
      if (line === "open") {
        openBrowser(opts.url);
      } else if (line === "quit") {
        stop();
        opts.onQuit();
      }
    }
  });

  child.stderr?.on("data", (data) => {
    logError("Tray stderr:", data.toString().trim());
  });

  child.on("error", (err) => {
    logError("Tray child error:", err instanceof Error ? err.message : err);
    stop();
  });

  child.on("exit", (code) => {
    log("Tray child exited with code:", code);
    child = null;
    if (scriptPath) {
      void unlink(scriptPath).catch(() => {});
    }
  });

  return { stop };
}
