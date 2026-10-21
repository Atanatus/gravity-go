
$g1 = "git" + "hub"
Write-Host "Limpiando repo de archivos pesados..."
git rm -r --cached node_modules .wrangler archive_backups_20261016 backup-live-20261014-090904 backup-server-authority-20261014-091134 --ignore-unmatch
if (Test-Path ".gitignore") { Remove-Item ".gitignore" -Force }
Set-Content -Path ".gitignore" -Value @"
# deps
node_modules/
# cloudflare
.wrangler/
.dev.vars
# backups
archive_backups_20261016/
backup-*/
*.backup*
*.bak
# OS
.DS_Store
Thumbs.db
# logs
npm-debug.log*
"@ -Encoding utf8

git add .gitignore
git add -A
git commit -m "Limpieza: ignore node_modules y wrangler"
git push origin main
Write-Host "Listo. Ahora el repo pesa KB, no MB."
