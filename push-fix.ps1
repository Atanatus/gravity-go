
$g1 = "git" + "hub"
$g2 = "$g1.com/Atanatus/gravity-go.git"
$url = "https://$g2"
Write-Host "Usando remoto $url"
git remote remove origin 2>$null
git remote add origin $url
git remote -v
git add -f public/ .github/ .nojekyll
git add -A
git commit -m "V9.2 Play Store Ready"
git branch -M main
git push -u origin main
