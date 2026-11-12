Add-Type @"
using System;
using System.Runtime.InteropServices;
public class CredMan {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool CredRead(string target, uint type, uint flags, out IntPtr cred);
  [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr cred);
  public static string GetPassword(string target) {
    IntPtr ptr;
    if (!CredRead(target, 1, 0, out ptr)) return null;
    var c = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
    string pwd = Marshal.PtrToStringUni(c.CredentialBlob, (int)c.CredentialBlobSize / 2);
    CredFree(ptr);
    return pwd;
  }
}
"@
$token = [CredMan]::GetPassword('git:https://github.com')
if (-not $token) { Write-Output 'NO TOKEN'; exit 1 }
$headers = @{
  Authorization = "Bearer $token"
  Accept = 'application/vnd.github+json'
  'User-Agent' = 'kimi-code-release'
}
$repo = 'fo011y/kimi-code-vscode'
$notes = @"
## Новое

- **Английский интерфейс** — расширение теперь двуязычное: язык выбирается автоматически по языку интерфейса VS Code (русский → русский, любой другой → английский). Переведены чат-панель, меню, диалоги, статус-бар и системные подсказки агента.

## English

- **English UI** — the extension is now bilingual: the language follows the VS Code display language (Russian → Russian, anything else → English). Chat panel, menus, dialogs, status bar and agent prompts are translated.
"@
$body = @{
  tag_name = 'v0.9.7'
  name = 'v0.9.7 — английский интерфейс'
  body = $notes
} | ConvertTo-Json
$rel = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$repo/releases" -Headers $headers -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -ContentType 'application/json; charset=utf-8'
Write-Output ("release id: " + $rel.id)
$vsix = 'D:\Jobe\Soft\kimi-code\kimi-code-0.9.7.vsix'
$up = Invoke-RestMethod -Method Post -Uri ("https://uploads.github.com/repos/$repo/releases/" + $rel.id + "/assets?name=kimi-code-0.9.7.vsix") -Headers $headers -InFile $vsix -ContentType 'application/octet-stream'
Write-Output ("asset: " + $up.browser_download_url)
# Постоянное имя ассета — ссылка releases/latest/download/kimi-code.vsix в README никогда не устаревает
$up2 = Invoke-RestMethod -Method Post -Uri ("https://uploads.github.com/repos/$repo/releases/" + $rel.id + "/assets?name=kimi-code.vsix") -Headers $headers -InFile $vsix -ContentType 'application/octet-stream'
Write-Output ("asset (stable name): " + $up2.browser_download_url)
