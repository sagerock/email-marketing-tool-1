param(
  [Parameter(Mandatory=$true)][string]$HtmlPath,
  [Parameter(Mandatory=$true)][string]$OutDir,
  [int]$MaxPages = 8,
  [int]$RenderWaitSec = 6
)

# Renders an HTML email through classic desktop Outlook (Word engine) and
# screenshots it page by page. Captures via PrintWindow, so it works even if
# the compose window is covered by other windows -- no focus stealing, safe
# to run while the desktop is in use.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Win32 {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  public struct RECT { public int Left, Top, Right, Bottom; }
  public static IntPtr FindByTitleSubstring(string sub) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      if (sb.ToString().Contains(sub)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
[void][Win32]::SetProcessDPIAware()

if (!(Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

$html = [System.IO.File]::ReadAllText($HtmlPath)

# The machine's default Outlook profile has no mail account (its setup wizard
# hangs startup), so run Outlook in /PIM mode: a local no-email profile.
# Compose + Word rendering work fully; sending is impossible by construction.
if (-not (Get-Process OUTLOOK -ErrorAction SilentlyContinue)) {
  Start-Process 'C:\Program Files (x86)\Microsoft Office\Root\Office16\OUTLOOK.EXE' -ArgumentList '/PIM','ClaudePreview'
  foreach ($w in 1..30) {
    Start-Sleep -Seconds 2
    $p = Get-Process OUTLOOK -ErrorAction SilentlyContinue
    if ($p -and $p.MainWindowTitle -and $p.MainWindowTitle -notmatch '^Opening') { break }
  }
}

$outlook = New-Object -ComObject Outlook.Application

# Outlook may still be spinning up; CreateItem throws E_ABORT until it settles.
$mail = $null
for ($try = 1; $try -le 10; $try++) {
  try { $mail = $outlook.CreateItem(0); break }  # olMailItem
  catch { Start-Sleep -Seconds 3 }
}
if (-not $mail) { throw 'Outlook never became ready for CreateItem (10 tries)' }

$stamp = 'RenderPreview-' + (Get-Date -Format 'HHmmss')
$mail.Subject = $stamp
# Assigning HTMLBody pushes the HTML through Outlook's Word-based renderer --
# exactly the transformation a recipient on classic Outlook sees.
$mail.HTMLBody = $html

$inspector = $mail.GetInspector
$inspector.Display()
Start-Sleep -Seconds 1
$inspector.WindowState = 2  # olMaximized -- widest canvas
Start-Sleep -Seconds $RenderWaitSec  # let remote images download

$hwnd = [Win32]::FindByTitleSubstring($stamp)
if ($hwnd -eq [IntPtr]::Zero) { throw 'Could not locate the compose window' }

$doc = $inspector.WordEditor          # Word Document behind the compose surface
for ($try = 1; $try -le 5 -and -not $doc; $try++) { Start-Sleep -Seconds 2; $doc = $inspector.WordEditor }
if (-not $doc) { throw 'WordEditor unavailable on the inspector' }
$win = $doc.Windows.Item(1)           # NOT ActiveWindow: that is null when unfocused

function Take-Shot([string]$path) {
  $r = New-Object Win32+RECT
  [void][Win32]::GetWindowRect($hwnd, [ref]$r)
  $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  [void][Win32]::PrintWindow($hwnd, $hdc, 2)  # PW_RENDERFULLCONTENT: works when occluded
  $g.ReleaseHdc($hdc)
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

for ($i = 1; $i -le $MaxPages; $i++) {
  if ($i -gt 1) {
    $prev = $win.VerticalPercentScrolled
    [void]$win.LargeScroll(1)
    Start-Sleep -Milliseconds 900
    if ($win.VerticalPercentScrolled -eq $prev) { break }  # hit the bottom
  }
  $file = Join-Path $OutDir ("outlook-page-{0:d2}.png" -f $i)
  Take-Shot $file
  Write-Output $file
}

$mail.Close(1)  # olDiscard -- never saved, never sent
try { $outlook.Quit() } catch {}
