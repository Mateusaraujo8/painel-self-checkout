<#
Instala (ou atualiza) o agente do Painel Self-Checkout em vários caixas de uma vez.

Os caixas vêm do estacoes.json (cadastro completo). Por padrão só os selfs; os PDVs normais
com -Tipo pdv (ou todos com -Tipo todos). Para cada um, abre UMA conexão SSH como root,
envia os arquivos do agente e roda o instalar.sh. Se a chave
%USERPROFILE%\.ssh\painel_self_ed25519 já estiver autorizada no caixa, não pede senha;
senão, o ssh pede a senha do root daquele caixa (uma vez por caixa).

Exemplos (na pasta do projeto):
  powershell -ExecutionPolicy Bypass -File agent\linux\instalar-todos.ps1 -Listar
  powershell -ExecutionPolicy Bypass -File agent\linux\instalar-todos.ps1
  powershell -ExecutionPolicy Bypass -File agent\linux\instalar-todos.ps1 -Loja 16
  powershell -ExecutionPolicy Bypass -File agent\linux\instalar-todos.ps1 -Ips 192.0.2.51,192.0.2.52
  powershell -ExecutionPolicy Bypass -File agent\linux\instalar-todos.ps1 -AutorizarChave
  powershell -ExecutionPolicy Bypass -File agent\linux\instalar-todos.ps1 -Tipo pdv -AutorizarChave

-Listar          só mostra os caixas que seriam instalados, não conecta em nada
-Tipo T          self (padrão), pdv (PDVs normais) ou todos
-Loja N          só os caixas da loja N
-Ips a,b,c       só esses IPs (de qualquer tipo)
-AutorizarChave  também autoriza a chave painel_self_ed25519 no caixa (próximas vezes sem senha)
#>
param(
  [switch]$Listar,
  [ValidateSet('self', 'pdv', 'todos')][string]$Tipo = 'self',
  [int]$Loja = 0,
  [string[]]$Ips = @(),
  [switch]$AutorizarChave
)

$ErrorActionPreference = 'Stop'
$pasta = Split-Path -Parent $MyInvocation.MyCommand.Path
$raiz = Resolve-Path (Join-Path $pasta '..\..')
$chave = Join-Path $env:USERPROFILE '.ssh\painel_self_ed25519'
$chaveRsa = Join-Path $env:USERPROFILE '.ssh\painel_self_rsa'

# ---- lista de caixas a partir do estacoes.json
$estacoes = Get-Content -Raw -Encoding UTF8 (Join-Path $raiz 'estacoes.json') | ConvertFrom-Json
# Lista completa do cadastro (inclui os PDVs normais, que não ficam em estação de fiscal) e,
# para cadastros antigos, os caixas das estações. Um caixa por IP.
$estacaoDoIp = @{}
foreach ($e in $estacoes.estacoes) { foreach ($c in $e.caixas) { if ($c.ip -and -not $estacaoDoIp[$c.ip]) { $estacaoDoIp[$c.ip] = $e.nome } } }
$porIp = [ordered]@{}
foreach ($c in @($estacoes.caixas) + @($estacoes.estacoes | ForEach-Object { $_.caixas })) {
  if (-not $c -or -not $c.ip -or $porIp.Contains($c.ip)) { continue }
  $tipoCx = if ($c.tipo -eq 'pdv') { 'pdv' } else { 'self' }
  $porIp[$c.ip] = [pscustomobject]@{ Loja = [int]$c.loja; Pdv = [int]$c.pdv; Ip = $c.ip; Tipo = $tipoCx; Estacao = $estacaoDoIp[$c.ip] }
}
$caixas = @($porIp.Values | Sort-Object Loja, Pdv)
$Ips = @($Ips | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
# Com -Ips, vale o IP de qualquer tipo; sem -Ips, filtra pelo tipo (padrão: só selfs).
if ($Ips.Count) { $caixas = @($caixas | Where-Object { $Ips -contains $_.Ip }) }
elseif ($Tipo -ne 'todos') { $caixas = @($caixas | Where-Object { $_.Tipo -eq $Tipo }) }
if ($Loja) { $caixas = @($caixas | Where-Object { $_.Loja -eq $Loja }) }
if (-not $caixas.Count) { Write-Host 'Nenhum caixa encontrado com esses filtros.'; exit 1 }

if ($Listar) {
  $caixas | Format-Table Loja, Pdv, Ip, Tipo, Estacao -AutoSize
  Write-Host ("{0} caixa(s)." -f $caixas.Count)
  exit 0
}

# ---- pacote: um script bash com os arquivos embutidos em base64
function Embutir($nome) {
  $bytes = [IO.File]::ReadAllBytes((Join-Path $pasta $nome))
  # Remove CR (arquivos editados no Windows) antes de enviar
  $texto = [Text.Encoding]::UTF8.GetString($bytes).Replace("`r", '')
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($texto))
  "echo '$b64' | base64 -d > /tmp/painel-self/$nome"
}
$linhas = @(
  'set -e',
  'rm -rf /tmp/painel-self && mkdir -p /tmp/painel-self',
  (Embutir 'agente.py'),
  (Embutir 'agente.pl'),
  (Embutir 'agente.conf'),
  (Embutir 'instalar.sh'),
  (Embutir 'painel-self-agente.service')
)
if ($AutorizarChave) {
  # ed25519 para os caixas novos e RSA para os antigos (o SSH do Slackware 14 não aceita ed25519).
  foreach ($arq in @("$chave.pub", "$chaveRsa.pub")) {
    if (-not (Test-Path $arq)) { continue }
    $pub = (Get-Content $arq -Raw).Trim()
    $linhas += "mkdir -p /root/.ssh && chmod 700 /root/.ssh && touch /root/.ssh/authorized_keys && (grep -qF '$pub' /root/.ssh/authorized_keys || echo '$pub' >> /root/.ssh/authorized_keys); chmod 600 /root/.ssh/authorized_keys"
  }
}
$linhas += 'cd /tmp/painel-self && sh instalar.sh'
$pacote = ($linhas -join "`n") + "`n"

# ---- instalação, um caixa por vez
$pastaLog = Join-Path $raiz 'log\instalacao-agente'
New-Item -ItemType Directory -Force $pastaLog | Out-Null
$resumo = @()
# PubkeyAcceptedKeyTypes=+ssh-rsa: o SSH do Slackware 14 só entende a assinatura RSA antiga,
# que o OpenSSH novo do Windows (9.x) desliga por padrão.
$opcoes = @('-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'PubkeyAcceptedKeyTypes=+ssh-rsa')
if (Test-Path $chave) { $opcoes += @('-i', $chave) }
if (Test-Path $chaveRsa) { $opcoes += @('-i', $chaveRsa) }

foreach ($c in $caixas) {
  $nome = 'Loja {0:000} PDV {1:000} ({2})' -f $c.Loja, $c.Pdv, $c.Ip
  Write-Host ''
  Write-Host "===== $nome =====" -ForegroundColor Cyan

  $tcp = New-Object Net.Sockets.TcpClient
  $alcanca = $tcp.ConnectAsync($c.Ip, 22).Wait(3000) -and $tcp.Connected
  $tcp.Dispose()
  if (-not $alcanca) {
    Write-Host 'SSH (porta 22) não responde, pulando.' -ForegroundColor Yellow
    $resumo += [pscustomobject]@{ Caixa = $nome; Resultado = 'sem SSH' }
    continue
  }

  $arquivoLog = Join-Path $pastaLog ('{0}.log' -f $c.Ip)
  # No PowerShell 5.1, qualquer linha na saída de erro de um programa externo vira "erro"
  # (ex.: "Created symlink..." do systemctl). Por isso: o caixa junta erro e saída (2>&1 lá),
  # e aqui o erro não interrompe o script.
  $antes = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $saida = $pacote | & ssh @opcoes "root@$($c.Ip)" "tr -d '\r' | bash -s 2>&1" 2>&1 | ForEach-Object { "$_" }
  $codigo = $LASTEXITCODE
  $ErrorActionPreference = $antes
  $saida | Out-File -Encoding utf8 $arquivoLog
  $saida | Select-Object -Last 14 | ForEach-Object { Write-Host "  $_" }

  $ativo = ($saida -join "`n") -match 'Active: active \(running\)'
  if ($codigo -eq 0 -and $ativo) {
    $resumo += [pscustomobject]@{ Caixa = $nome; Resultado = 'OK' }
  } else {
    $resumo += [pscustomobject]@{ Caixa = $nome; Resultado = "FALHOU (veja $arquivoLog)" }
  }
}

Write-Host ''
Write-Host '===== Resumo =====' -ForegroundColor Cyan
$resumo | Format-Table -AutoSize
