$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '请先安装 Node.js 22 或更高版本。' }
if (-not (Test-Path -LiteralPath './node_modules/mongodb')) { & npm.cmd ci --no-audit --no-fund; if ($LASTEXITCODE -ne 0) { throw '依赖安装失败' } }
if (-not (Test-Path -LiteralPath './.env')) { Copy-Item -LiteralPath './.env.example' -Destination './.env' }
$taskMongoStarted = $null
# .env配置了外部数据库时请自行启动数据库，并直接使用npm start。
$taskMongoPort = 27019
$taskMongoListening = Get-NetTCPConnection -LocalPort $taskMongoPort -State Listen -ErrorAction SilentlyContinue
if (-not $taskMongoListening) {
  $taskMongoCommand = Get-Command mongod -ErrorAction SilentlyContinue
  if (-not $taskMongoCommand) { throw '找不到mongod。请安装MongoDB并加入PATH，或在.env配置数据库后运行npm start。' }
  $taskDataPath = Join-Path $PSScriptRoot 'data'
  New-Item -ItemType Directory -Path $taskDataPath -Force | Out-Null
  $taskLogPath = Join-Path $taskDataPath 'mongodb.log'
  $taskMongoStarted = Start-Process -FilePath $taskMongoCommand.Source -ArgumentList @('--dbpath', ('"' + $taskDataPath + '"'), '--bind_ip', '127.0.0.1', '--port', "$taskMongoPort", '--logpath', ('"' + $taskLogPath + '"')) -WindowStyle Hidden -PassThru
  for ($taskAttempt = 0; $taskAttempt -lt 30; $taskAttempt++) {
    Start-Sleep -Milliseconds 300
    if ($taskMongoStarted.HasExited) { throw ('MongoDB启动失败，请检查：' + $taskLogPath) }
    if (Get-NetTCPConnection -LocalPort $taskMongoPort -State Listen -ErrorAction SilentlyContinue) { break }
  }
}
Write-Host '浏览器打开 http://127.0.0.1:3000；Ctrl+C停止应用。运行npm run seed可导入可选演示数据。'
try { & npm.cmd start }
finally { if ($taskMongoStarted -and -not $taskMongoStarted.HasExited) { Stop-Process -Id $taskMongoStarted.Id } }
