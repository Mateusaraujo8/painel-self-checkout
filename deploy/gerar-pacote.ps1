# Gera o pacote do Painel Self-Checkout para copiar a outro servidor Windows.
# Uso (nesta máquina, na pasta do projeto):
#   powershell -ExecutionPolicy Bypass -File deploy\gerar-pacote.ps1
# Resultado: dist\PainelSelf-AAAA-MM-DD.zip (com node_modules: o servidor não precisa de internet).
#
# Vai junto: código, config.json (token dos agentes e senha VNC), estacoes.json, usuários
# (só hashes de senha) e a lista de caixas. NÃO vai: sessões abertas, logs, o arquivo de
# senhas iniciais das lojas e as pastas do editor.
$ErrorActionPreference = 'Stop'
$raiz = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dist = Join-Path $raiz 'dist'
$destino = Join-Path $dist 'PainelSelf'
if (Test-Path $destino) { Remove-Item $destino -Recurse -Force }
New-Item -ItemType Directory -Force $destino | Out-Null

$fora = @('.claude', '.cursor', '.impeccable', 'dist', 'log', '.git')
Get-ChildItem $raiz -Force | Where-Object { $fora -notcontains $_.Name } | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $destino $_.Name) -Recurse -Force
}
# Dados que não devem ir para outro servidor.
foreach ($f in 'data\sessoes.json', 'data\senhas-iniciais-lojas.txt', 'data\eventos', 'data\estacoes-anteriores', 'data\vendas') {
  Remove-Item (Join-Path $destino $f) -Recurse -Force -ErrorAction SilentlyContinue
}
Get-ChildItem $destino -Recurse -Directory -Filter '__pycache__' | Remove-Item -Recurse -Force
New-Item -ItemType Directory -Force (Join-Path $destino 'log') | Out-Null

$zip = Join-Path $dist ("PainelSelf-{0:yyyy-MM-dd}.zip" -f (Get-Date))
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $destino -DestinationPath $zip
Remove-Item $destino -Recurse -Force
'{0} ({1:N1} MB)' -f $zip, ((Get-Item $zip).Length / 1MB)
