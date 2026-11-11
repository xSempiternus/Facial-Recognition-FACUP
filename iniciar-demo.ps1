# Levanta todo para mostrar el sistema desde el celular (lo lanza iniciar-demo.bat).
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

function Puerto-Ocupado($p) {
    $null -ne (Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue)
}

$py = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path $py)) { Write-Host 'No se encontro .venv. Revisa el README.' -ForegroundColor Red; exit 1 }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Write-Host 'No se encontro Node.js (npm). Instala Node.js LTS.' -ForegroundColor Red; exit 1 }
$cf = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cf) { Write-Host 'No se encontro cloudflared en el PATH.' -ForegroundColor Red; exit 1 }

foreach ($p in 3000, 8000) {
    if (Puerto-Ocupado $p) {
        Write-Host "Ya hay algo escuchando en el puerto $p. Cierra eso primero (o usa la sesion ya abierta); no se duplica nada." -ForegroundColor Yellow
        exit 1
    }
}

# Evita que el PC se suspenda mientras este script corre (sin tocar la configuracion global de energia).
Add-Type -Namespace Win -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
[void][Win.Power]::SetThreadExecutionState([uint32]2147483649)   # ES_CONTINUOUS | ES_SYSTEM_REQUIRED

$hijos = @()
$log = Join-Path $env:TEMP 'cloudflared-demo.log'
Remove-Item $log -ErrorAction SilentlyContinue
try {
    Write-Host 'Iniciando API...'
    $hijos += Start-Process cmd -PassThru -ArgumentList '/k', "title API - Demo && `"$py`" -m uvicorn api.main:app --host 127.0.0.1 --port 8000"

    Write-Host 'Compilando y arrancando la app web (la primera vez tarda)...'
    $hijos += Start-Process cmd -PassThru -ArgumentList '/k', 'title Web - Demo && cd /d web && (if not exist node_modules call npm install) && call npm run build && call npm start -- -H 0.0.0.0 -p 3000'

    Write-Host 'Esperando la app web en el puerto 3000...'
    $ok = $false
    for ($i = 0; $i -lt 300 -and -not $ok; $i++) {
        try { $ok = (Invoke-WebRequest -UseBasicParsing http://localhost:3000 -TimeoutSec 3).StatusCode -eq 200 } catch { Start-Sleep -Seconds 2 }
    }
    if (-not $ok) { throw 'La app web no respondio a tiempo.' }

    Write-Host 'Abriendo tunel de Cloudflare...'
    $hijos += Start-Process $cf.Source -PassThru -WindowStyle Minimized -RedirectStandardError $log `
        -ArgumentList 'tunnel', '--url', 'http://localhost:3000', '--no-autoupdate', '--protocol', 'http2'

    $url = $null
    for ($i = 0; $i -lt 60 -and -not $url; $i++) {
        Start-Sleep -Seconds 1
        if (Test-Path $log) {
            $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($m) { $url = $m.Matches[0].Value }
        }
    }
    if (-not $url) { throw "No aparecio la URL del tunel. Revisa $log" }

    # La API usa esta direccion para los enlaces/QR de apoderados (data\url_publica.txt).
    [System.IO.File]::WriteAllText((Join-Path $PSScriptRoot 'data\url_publica.txt'), $url, (New-Object System.Text.UTF8Encoding($false)))
    Set-Clipboard -Value $url
    Write-Host ''
    Write-Host '  ============================================================' -ForegroundColor Green
    Write-Host '   ABRE ESTO EN EL CELULAR (ya esta copiado al portapapeles):' -ForegroundColor Green
    Write-Host ''
    Write-Host "     $url" -ForegroundColor Yellow
    Write-Host ''
    Write-Host '  ============================================================' -ForegroundColor Green
    Write-Host ''
    Write-Host 'Deja esta ventana abierta. Pulsa Enter para apagar todo (API, web y tunel).'
    [void][Console]::ReadLine()
}
finally {
    Remove-Item (Join-Path $PSScriptRoot 'data\url_publica.txt') -ErrorAction SilentlyContinue
    foreach ($h in $hijos) { if ($h -and -not $h.HasExited) { & taskkill /PID $h.Id /T /F *> $null } }
    [void][Win.Power]::SetThreadExecutionState([uint32]2147483648)
}
