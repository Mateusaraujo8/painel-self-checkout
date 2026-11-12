# Instala o Painel Self-Checkout como serviço num servidor Windows.
#
# Uso (PowerShell como Administrador, na pasta extraída do pacote, de qualquer lugar):
#   powershell -ExecutionPolicy Bypass -File deploy\windows\instalar-servidor.ps1
#   powershell -ExecutionPolicy Bypass -File deploy\windows\instalar-servidor.ps1 -Remover
#
# O que faz:
#   - copia o painel para C:\Sistemas\PainelSelf (outra pasta: -Destino). Ao atualizar, mantém
#     os dados de lá (usuários, caixas, logs) e o config.json; o resto vem do pacote novo
#   - confere o Node.js (18 ou mais novo)
#   - cria a tarefa agendada "PainelSelf": inicia junto com o Windows (conta SYSTEM, sem
#     precisar de ninguém logado) e reinicia o painel sozinho se ele cair
#   - libera a porta do painel no Firewall do Windows (só entrada TCP nessa porta)
#   - inicia e testa se o painel respondeu
#   -Porta N  usa outra porta (grava no config.json). Se a 8080 já for do IIS, use 8081.
#   A administração fica na mesma porta, em /admin (só o nível TI / Administrador entra).
#   -Teste  servidor de teste/desenvolvimento (ex.: o PC de desenvolvimento): roda na própria pasta do
#           projeto, na porta 8080, reinicia sozinho quando o código do servidor muda e mantém
#           o acesso do seu usuário do Windows a config.json e data\.
param([switch]$Remover, [switch]$Teste, [int]$Porta = 8081, [string]$Destino = 'C:\Sistemas\PainelSelf')

$ErrorActionPreference = 'Stop'
$NOME = 'PainelSelf'
$origem = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if ($Teste) {
  if (-not $PSBoundParameters.ContainsKey('Destino')) { $Destino = $origem }
  if (-not $PSBoundParameters.ContainsKey('Porta')) { $Porta = 8080 }
}
$raiz = [IO.Path]::GetFullPath($Destino).TrimEnd('\')
$euMesmo = [Security.Principal.WindowsIdentity]::GetCurrent().Name

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw 'Abra o PowerShell como Administrador e rode de novo.' }

function Parar-Painel {
  # O node é iniciado com caminho relativo (server\index.js) pelo rodar-painel.cmd: para achar
  # o processo certo, pega o cmd desta pasta e os filhos dele.
  $todos = Get-CimInstance Win32_Process
  # Qualquer pasta: também para uma instalação anterior em outro lugar (ex.: C:\PainelSelf).
  $cmds = $todos | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -match 'rodar-painel\.cmd' }
  Stop-ScheduledTask -TaskName $NOME -ErrorAction SilentlyContinue
  foreach ($c in $cmds) {
    $todos | Where-Object { $_.ParentProcessId -eq $c.ProcessId } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Stop-Process -Id $c.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep 1
}

if ($Remover) {
  Parar-Painel
  Unregister-ScheduledTask -TaskName $NOME -Confirm:$false -ErrorAction SilentlyContinue
  Remove-NetFirewallRule -DisplayName 'Painel Self-Checkout' -ErrorAction SilentlyContinue
  Remove-NetFirewallRule -DisplayName 'Painel Self-Checkout (administração)' -ErrorAction SilentlyContinue
  Write-Host 'Painel removido do início automático e do firewall. Os arquivos da pasta continuam lá.'
  return
}

# ---------------------------------------------------------------- Node.js
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw 'Node.js não encontrado. Instale a versão LTS (nodejs.org, instalador .msi) e rode este script de novo.'
}
$versao = (& $node.Source -v).TrimStart('v')
if ([int]($versao.Split('.')[0]) -lt 18) { throw "Node.js $versao é antigo. Instale a versão LTS (18 ou mais nova)." }
Write-Host "Node.js $versao em $($node.Source)"

# ---------------------------------------------------------------- copiar para o destino
if ($origem.TrimEnd('\') -ne $raiz) {
  Parar-Painel   # solta os arquivos antes de copiar por cima
  $atualizando = Test-Path (Join-Path $raiz 'server\index.js')
  New-Item -ItemType Directory -Force $raiz | Out-Null
  # /E: subpastas. Não traz data\ nem log\ e não sobrescreve o config.json se já existir.
  $excluir = @('/XD', (Join-Path $origem 'data'), (Join-Path $origem 'log'))
  if (Test-Path (Join-Path $raiz 'config.json')) { $excluir += @('/XF', 'config.json') }
  robocopy $origem $raiz /E /NFL /NDL /NJH /NJS /NP @excluir | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Falha ao copiar os arquivos para $raiz (robocopy $LASTEXITCODE)." }
  # Dados (usuários, caixas): só na primeira instalação; ao atualizar, ficam os do servidor.
  if (-not (Test-Path (Join-Path $raiz 'data\usuarios.json')) -and (Test-Path (Join-Path $origem 'data'))) {
    robocopy (Join-Path $origem 'data') (Join-Path $raiz 'data') /E /NFL /NDL /NJH /NJS /NP | Out-Null
  }
  Write-Host ($(if ($atualizando) { "Atualizado em $raiz (usuários e dados mantidos)." } else { "Copiado para $raiz." }))
}

# ---------------------------------------------------------------- arquivos
Parar-Painel   # versão anterior (se houver) solta a porta antes de conferir e iniciar
foreach ($f in 'config.json', 'estacoes.json', 'server\index.js', 'public\vendor\novnc.js', 'node_modules\express') {
  if (-not (Test-Path (Join-Path $raiz $f))) { throw "Falta $f em $raiz. Extraia o pacote inteiro." }
}
New-Item -ItemType Directory -Force (Join-Path $raiz 'log'), (Join-Path $raiz 'data') | Out-Null
# Grava a porta no config.json (sem BOM: o servidor lê JSON puro).
$arqConfig = Join-Path $raiz 'config.json'
$config = Get-Content $arqConfig -Raw -Encoding UTF8 | ConvertFrom-Json
$config.porta = $Porta
# Versões anteriores usavam uma porta separada para a administração: não existe mais.
$config.PSObject.Properties.Remove('portaAdmin')
[IO.File]::WriteAllText($arqConfig, ($config | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
$porta = $Porta
$ocupada = Get-NetTCPConnection -State Listen -LocalPort $porta -ErrorAction SilentlyContinue |
  Where-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName -ne 'node' }
if ($ocupada) {
  $quem = (Get-Process -Id $ocupada[0].OwningProcess -ErrorAction SilentlyContinue).ProcessName
  throw "A porta $porta já está em uso por '$quem'. Rode de novo com -Porta e outro número (ex.: -Porta 8082)."
}
Write-Host "Porta do painel e da administração (/admin): $porta"

# Script que mantém o painel no ar: se o node sair, espera 5 s e sobe de novo.
# No modo -Teste, o node reinicia sozinho quando um arquivo de server\ muda (código novo no ar
# sem reinstalar); as páginas (public\) já são servidas sempre na versão mais nova.
$observar = if ($Teste) { '--watch-path=server --watch-preserve-output ' } else { '' }
$cmd = Join-Path $raiz 'deploy\windows\rodar-painel.cmd'
@"
@echo off
cd /d "$raiz"
:loop
"$($node.Source)" $observar server\index.js >> log\console.log 2>&1
timeout /t 5 /nobreak >nul
goto loop
"@ | Set-Content $cmd -Encoding ascii

# ---------------------------------------------------------------- permissões dos segredos
# config.json (token dos agentes, senha VNC) e data\ (usuários com senha criptografada, sessões)
# só podem ser lidos pelo sistema (o painel roda como SYSTEM) e por Administradores.
# Usuários comuns do servidor deixam de enxergar esses arquivos.
& icacls (Join-Path $raiz 'config.json') /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' /C /Q | Out-Null
& icacls (Join-Path $raiz 'data') /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /C /Q | Out-Null
& icacls (Join-Path $raiz 'data\*') /reset /T /C /Q | Out-Null
if ($Teste) {
  # Máquina de teste: quem desenvolve (o seu usuário) continua lendo e editando esses arquivos.
  & icacls (Join-Path $raiz 'config.json') /grant "${euMesmo}:F" /C /Q | Out-Null
  & icacls (Join-Path $raiz 'data') /grant "${euMesmo}:(OI)(CI)F" /C /Q | Out-Null
  & icacls (Join-Path $raiz 'data\*') /reset /T /C /Q | Out-Null
  Write-Host "Permissões: config.json e data\ só para SYSTEM, Administradores e $euMesmo."
} else {
  Write-Host 'Permissões: config.json e data\ só para SYSTEM e Administradores.'
}

# ---------------------------------------------------------------- tarefa agendada
Unregister-ScheduledTask -TaskName $NOME -Confirm:$false -ErrorAction SilentlyContinue
$acao = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$cmd`"" -WorkingDirectory $raiz
$gatilho = New-ScheduledTaskTrigger -AtStartup
$conta = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$ajustes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
Register-ScheduledTask -TaskName $NOME -Action $acao -Trigger $gatilho -Principal $conta -Settings $ajustes `
  -Description 'Painel Self-Checkout (Node.js). Inicia com o Windows.' | Out-Null
Write-Host "Tarefa agendada '$NOME' criada (inicia com o Windows)."

# ---------------------------------------------------------------- firewall
Remove-NetFirewallRule -DisplayName 'Painel Self-Checkout' -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName 'Painel Self-Checkout' -Direction Inbound -Protocol TCP -LocalPort $porta -Action Allow | Out-Null
Write-Host "Firewall: entrada TCP $porta liberada."
# Regra da porta separada de versões anteriores (se existir), que não é mais usada.
Remove-NetFirewallRule -DisplayName 'Painel Self-Checkout (administração)' -ErrorAction SilentlyContinue

# ---------------------------------------------------------------- iniciar e testar
Start-ScheduledTask -TaskName $NOME
$ok = $false
for ($i = 0; $i -lt 15 -and -not $ok; $i++) {
  Start-Sleep 1
  try { Invoke-WebRequest "http://127.0.0.1:$porta/" -UseBasicParsing -TimeoutSec 2 | Out-Null; $ok = $true } catch {}
}
if ($ok) {
  $ips = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' }).IPAddress
  Write-Host ''
  Write-Host 'Painel no ar:' -ForegroundColor Green
  foreach ($ip in $ips) { Write-Host "  Painel:         http://${ip}:$porta" }
  foreach ($ip in $ips) { Write-Host "  Administração:  http://${ip}:$porta/admin" }
} else {
  Write-Host "O painel não respondeu na porta $porta. Veja $raiz\log\console.log" -ForegroundColor Yellow
}
