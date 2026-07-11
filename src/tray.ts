/**
 * System tray icon while serve is running.
 * Windows: PowerShell NotifyIcon (no native npm deps).
 * Other platforms: no-op (returns null).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
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

function assetsDir(): string {
  // dist/tray.js → dist/server/assets ; src/tray.ts (tsx) → src/server/assets
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "server", "assets");
}

async function resolveIconPath(): Promise<string | null> {
  const base = assetsDir();
  const candidates = [
    path.join(base, "favicon.ico"),
    path.join(base, "favicon-32x32.png"),
    path.join(base, "logo.png"),
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
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Text = '${tooltip}'.Substring(0, [Math]::Min(63, '${tooltip}'.Length))
$icon.Visible = $true

try {
  if ('${icon}' -ne '' -and (Test-Path -LiteralPath '${icon}')) {
    if ('${icon}'.ToLower().EndsWith('.ico')) {
      $icon.Icon = New-Object System.Drawing.Icon('${icon}')
    } else {
      $bmp = [System.Drawing.Image]::FromFile('${icon}')
      $icon.Icon = [System.Drawing.Icon]::FromHandle((New-Object System.Drawing.Bitmap $bmp).GetHicon())
    }
  } else {
    $icon.Icon = [System.Drawing.SystemIcons]::Application
  }
} catch {
  $icon.Icon = [System.Drawing.SystemIcons]::Application
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = New-Object System.Windows.Forms.ToolStripMenuItem('${title} — Open')
$dashItem = New-Object System.Windows.Forms.ToolStripMenuItem('Open Dashboard')
$sep = New-Object System.Windows.Forms.ToolStripSeparator
$quitItem = New-Object System.Windows.Forms.ToolStripMenuItem('Quit')
[void]$menu.Items.Add($openItem)
[void]$menu.Items.Add($dashItem)
[void]$menu.Items.Add($sep)
[void]$menu.Items.Add($quitItem)
$icon.ContextMenuStrip = $menu

function Emit-Open {
  [Console]::Out.WriteLine('open')
  [Console]::Out.Flush()
}
function Emit-Quit {
  $icon.Visible = $false
  $icon.Dispose()
  [Console]::Out.WriteLine('quit')
  [Console]::Out.Flush()
  [System.Windows.Forms.Application]::Exit()
}

$handlerOpen = { Emit-Open }
$openItem.add_Click($handlerOpen)
$dashItem.add_Click($handlerOpen)
$icon.add_DoubleClick($handlerOpen)
$quitItem.add_Click({ Emit-Quit })

# Keep process alive for tray message loop
[System.Windows.Forms.Application]::Run()
`.trim();
}

export async function startTray(opts: TrayOptions): Promise<TrayHandle | null> {
  if (process.platform !== "win32") {
    return null;
  }
  if (process.env.XLAB_TOKEN_NO_TRAY === "1") {
    return null;
  }

  const title = opts.title || "XLab Token";
  const tooltip = opts.tooltip || "XLab Token — click to open dashboard";
  const iconPath = await resolveIconPath();
  const script = buildPsScript({
    url: opts.url,
    title,
    tooltip,
    iconPath,
  });

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
  };

  try {
    child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-Command",
        script,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
  } catch {
    return null;
  }

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    const lines = String(chunk)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    for (const line of lines) {
      if (line === "open") {
        openBrowser(opts.url);
      } else if (line === "quit") {
        stop();
        opts.onQuit();
      }
    }
  });

  child.stderr?.on("data", () => {
    // ignore PS noise
  });

  child.on("error", () => {
    stop();
  });

  child.on("exit", () => {
    child = null;
  });

  return { stop };
}
