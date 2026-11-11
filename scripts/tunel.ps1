# Abre un tunel Cloudflare (quick) hacia la app web y guarda su URL en data\url_publica.txt, que la API usa como
# "direccion publica" para los enlaces de apoderados. Lo llama iniciar.bat. Nunca falla el lanzador: sale con 0.
param([int]$Puerto = 3000, [int]$EsperaSeg = 60)
$ErrorActionPreference = 'Continue'
$raiz = Split-Path -Parent $PSScriptRoot
$archivo = Join-Path $raiz 'data\url_publica.txt'
$log = Join-Path $env:TEMP 'cf_tunel.log'

$cf = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cf) {
    Write-Host 'AVISO: sin tunel, los enlaces para apoderados no funcionaran fuera de este equipo; instala cloudflared (winget install Cloudflare.cloudflared).' -ForegroundColor Yellow
    exit 0
}

# La URL anterior ya no existe: se borra para no usar una direccion muerta.
Remove-Item $archivo, $log -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Split-Path $archivo) | Out-Null

# Espera a que la web responda (el tunel sin origen devuelve 502).
for ($i = 0; $i -lt 150; $i++) {
    try { if ((Invoke-WebRequest -UseBasicParsing "http://localhost:$Puerto" -TimeoutSec 3).StatusCode -eq 200) { break } } catch { Start-Sleep -Seconds 2 }
}

Start-Process $cf.Source -WindowStyle Minimized `
    -ArgumentList 'tunnel', '--url', "http://localhost:$Puerto", '--no-autoupdate', '--protocol', 'http2', '--logfile', $log | Out-Null

$url = $null
for ($i = 0; $i -lt $EsperaSeg -and -not $url; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Path $log) {
        $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($m) { $url = $m.Matches[0].Value }
    }
}
if (-not $url) {
    Write-Host "AVISO: no aparecio la URL del tunel (revisa $log). Los enlaces para apoderados solo funcionaran en este equipo." -ForegroundColor Yellow
    exit 0
}
[System.IO.File]::WriteAllText($archivo, $url, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Enlace publico: $url" -ForegroundColor Green
exit 0
