# ============================================================================
# SCRIPT KHỞI CHẠY NHANH CỔNG KẾT NỐI INTERNET TRÊN WINDOWS POWERSHELL
# Cách chạy: .\scripts\start-tunnel.ps1
# ============================================================================

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$EnvFile = Join-Path $ProjectRoot ".env"

if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#") -and $line.Contains("=")) {
            $parts = $line.Split("=", 2)
            $key = $parts[0].Trim()
            $val = $parts[1].Trim().Trim('"').Trim("'")
            [System.Environment]::SetEnvironmentVariable($key, $val, "Process")
        }
    }
}

$Port = if ($env:PORT) { $env:PORT } else { "3000" }
$Provider = if ($env:PUBLIC_TUNNEL_PROVIDER) { $env:PUBLIC_TUNNEL_PROVIDER } else { "NGROK" }
$RawDomain = if ($env:NGROK_DOMAIN) { $env:NGROK_DOMAIN } else { "" }
$CleanDomain = $RawDomain -replace "^https?://", "" -replace "/.*$", ""

Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host " PANCAKE SELLER OS — PUBLIC TUNNEL GATEWAY ($Provider)" -ForegroundColor Cyan
Write-Host " Target Backend Local Port : http://localhost:$Port"
Write-Host " Webhook Endpoint Pattern  : /api/webhooks/omnichannel/{channel}"
Write-Host "==================================================================" -ForegroundColor Cyan

if ($Provider -eq "CLOUDFLARE_TUNNEL") {
    Write-Host "[INFO] Starting Cloudflare Tunnel -> http://localhost:$Port ..." -ForegroundColor Green
    cloudflared tunnel --url "http://localhost:$Port"
    exit 0
}

if ($env:NGROK_AUTHTOKEN) {
    ngrok config add-authtoken $env:NGROK_AUTHTOKEN | Out-Null
}

if ($CleanDomain) {
    Write-Host "[INFO] Starting Ngrok with static domain: https://$CleanDomain -> http://localhost:$Port" -ForegroundColor Green
    ngrok http $Port --url="https://$CleanDomain"
} else {
    Write-Host "[INFO] Starting Ngrok with dynamic domain (Backend will auto-detect via 127.0.0.1:4040)..." -ForegroundColor Yellow
    ngrok http $Port
}
