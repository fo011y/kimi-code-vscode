Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinMsg {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
}
"@
$procs = Get-Process Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -match 'Edge FCIM Kimi' }
if (-not $procs) { Write-Output 'NO WINDOW'; exit 0 }
foreach ($p in $procs) {
  Write-Output ("closing: " + $p.MainWindowTitle)
  [WinMsg]::PostMessage($p.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
}
Start-Sleep -Seconds 10
& "C:\Users\PC\AppData\Local\Programs\Microsoft VS Code\bin\code" "D:\Jobe\Projects\Edge FCIM Kimi"
Write-Output 'REOPENED'
