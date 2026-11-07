# Run Slotbook WITHOUT Docker (Windows). Needs: Node.js LTS + PostgreSQL for Windows.
# Usage (PowerShell, inside the slotbook folder):
#   powershell -ExecutionPolicy Bypass -File .\scripts\run-local.ps1 -PgPassword YOUR_POSTGRES_PASSWORD
param([Parameter(Mandatory=$true)][string]$PgPassword, [string]$PgBin = "C:\Program Files\PostgreSQL\16\bin")
$ErrorActionPreference = "Stop"
$psql = Join-Path $PgBin "psql.exe"
if (-not (Test-Path $psql)) { throw "psql not found at $psql. Pass -PgBin with your PostgreSQL bin folder (version number may differ)." }
$env:PGPASSWORD = $PgPassword
$exists = & $psql -U postgres -h localhost -tAc "SELECT 1 FROM pg_database WHERE datname='slotbook'"
if (-not $exists) {
  Write-Host "Creating database and loading tables + demo data..."
  & $psql -U postgres -h localhost -c "CREATE DATABASE slotbook"
  foreach ($f in Get-ChildItem .\migrations\*.sql | Sort-Object Name) { & $psql -U postgres -h localhost -d slotbook -f $f.FullName }
} else { Write-Host "Database already exists, reusing it." }
if (-not (Test-Path .\node_modules)) { npm install }
$env:DATABASE_URL = "postgres://postgres:$PgPassword@localhost:5432/slotbook"
npm start
