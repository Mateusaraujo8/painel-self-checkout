# Painel Self-Checkout

Painel web, em tempo real, para supervisionar os self-checkouts e PDVs de uma rede de supermercados. Mostra uma fila de alertas e permite ver e controlar a tela de cada caixa pelo navegador (noVNC), sem instalar nada no computador do fiscal.

> **Projeto de portfólio.** Este repositório tem só o esqueleto do sistema. Endereços IP, tokens, senhas, nomes de lojas, logs e dados de produção foram retirados. Os IPs que aparecem nos exemplos são endereços de documentação (`192.0.2.x` e `198.51.100.x`, RFC 5737).

---

## O problema

Num self-checkout, o cliente fica parado esperando sempre que o caixa precisa de alguém: conferência de peso, produto com restrição de idade, cancelamento, pagamento recusado ou falta de papel. O fiscal cuida de vários caixas ao mesmo tempo, quase sempre em pé e longe do monitor. O sistema do fornecedor do PDV exigia instalação e privilégio de administrador em cada computador, e não tinha controle de acesso por usuário.

**Objetivo:** o fiscal precisa saber, de relance e a alguns passos de distância, **qual caixa precisa dele, por quê e há quanto tempo**, e resolver dali mesmo quando der.

## O que o sistema faz

- **Fila de alertas por urgência:** mostra o motivo e há quanto tempo o alerta está aberto. Avisa com som e tem botões para "Atender" (avisa o cliente que alguém está a caminho) e "Liberar".
- **Grade com a tela ao vivo de cada caixa:** o tamanho se ajusta para todos os caixas caberem no monitor. Clicar num caixa abre a tela ampliada, com controle de mouse e teclado.
- **Leitura de relance:** cor, texto e ícone juntos, sem depender só da cor. O contraste é pensado para o ambiente da loja, e há atalhos de teclado (número do PDV para abrir, F10 para fechar).
- **Controle de acesso:** usuários com perfil (fiscal ou TI). Cada computador de fiscal só vê os caixas da sua estação.
- **Administração (`/admin`):**
  - saúde dos agentes;
  - indicadores (tempo de espera do cliente, alertas por motivo e por hora, vendas e ticket médio);
  - cadastro de lojas e caixas com revisão antes de salvar;
  - usuários;
  - registro de auditoria.
- **Monitoramento fiscal:** detecta NFC-e sem autorização, notas em contingência e caixa "travado" sem transmitir para a SEFAZ.
- **Automação no caixa:** tara automática da balança de conferência depois da venda. Vem desligada e pode ser ligada por loja ou por caixa.

## Arquitetura

Os **caixas se conectam ao painel**, e não o contrário. Por isso o servidor não precisa varrer a rede, e um caixa novo aparece sozinho.

```
 Caixa (agente) ──HTTP/WebSocket──►┐
 Caixa (agente) ───────────────────► Servidor Node.js ──WebSocket──► Navegadores dos fiscais
 Caixa (agente) ──────────────────►┘        │
                                            └─ /vnc/:id  WebSocket ⇄ TCP :5900 do caixa (proxy noVNC)
```

| Camada | Tecnologia |
|---|---|
| Servidor | Node.js 18+, Express, `ws`. Sem banco SQL: estado e configuração em arquivos JSON, eventos em JSONL |
| Painel | HTML, CSS e JavaScript puros (ES modules, sem framework), noVNC empacotado com esbuild |
| Agente dos caixas Linux | Python 3 **ou** Perl, só com a biblioteca padrão (os caixas não podem receber pacotes) |
| Agente Windows / simulador | Node.js |
| Implantação | PowerShell: pacote zip, tarefa agendada, firewall e permissões |

### Estrutura de pastas

```
.
├── server/                 # Servidor Node
│   ├── index.js            # HTTP, login, WebSockets do painel e dos agentes
│   ├── vnc-proxy.js        # Proxy WebSocket ⇄ VNC (autentica no caixa; a senha não vai ao navegador)
│   ├── estado.js           # Estado vivo de cada caixa e tipos de alerta
│   ├── estacoes.js         # Quais caixas cada computador de fiscal pode ver
│   ├── usuarios.js         # Usuários, perfis e hash scrypt
│   ├── seguranca.js        # CSP, origem, limites de tentativa, limpeza de entrada
│   ├── indicadores.js      # Métricas de espera, alertas e vendas
│   ├── eventos.js          # Registro de auditoria (JSONL mensal)
│   ├── admin.js            # API da área /admin
│   ├── tara.js             # Regras da tara automática por loja/caixa
│   ├── config.js / log.js
│   └── cli-usuario.js      # Criar e gerenciar usuários pelo terminal
├── public/                 # Interface
│   ├── index.html · painel.js · estilo.css   # Painel do fiscal
│   └── admin.html · admin.js · admin.css     # Administração
├── agent/
│   ├── agente.js           # Agente Node (Windows), com API local em 127.0.0.1
│   ├── cliente.js          # Conexão com reconexão automática
│   ├── simulador.js        # Caixas falsos para desenvolvimento
│   └── linux/              # Agente dos caixas Linux (Python e Perl), instaladores e serviço systemd
├── deploy/                 # Geração do pacote e instalação no servidor Windows
├── config.example.json     # Modelo de configuração
├── estacoes.example.json   # Modelo de lojas, caixas e estações (dados fictícios)
├── DESIGN.md               # Sistema visual e decisões de interface
└── PRODUCT.md              # Usuários, objetivos e princípios do produto
```

## Como rodar localmente

Pré-requisito: Node.js 18 ou mais novo.

```bash
npm install
```

```bash
cp config.example.json config.json
```

Edite o `config.json` e troque o `tokenAgente` por um valor longo e aleatório. Depois crie um usuário (a senha é pedida no terminal):

```bash
npm run usuario -- criar admin ti "Administrador"
```

```bash
npm start
```

Abra `http://localhost:8080`. Para ver o painel funcionando sem caixas reais, rode o simulador em outro terminal:

```bash
npm run simular -- --lojas 2 --caixas 8
```

Opcional: copie `estacoes.example.json` para `estacoes.json` para testar a regra de quais caixas cada computador vê. Ao salvar o arquivo, o painel recarrega sozinho.

### Configuração

| Chave (`config.json`) | Para que serve |
|---|---|
| `porta` | porta HTTP do painel |
| `tokenAgente` | segredo que todo caixa envia ao conectar |
| `senhaVnc` | senha VNC dos caixas (fica só no servidor) |
| `segundosOffline` | tempo sem notícia até marcar o caixa como "sem conexão" |
| `versaoMinimaAgente` | recusa agentes desatualizados |
| `portaVncPadrao` | porta VNC quando o agente não informa outra |

As variáveis de ambiente `PORTA`, `TOKEN_AGENTE`, `SENHA_VNC` e similares têm prioridade sobre o arquivo.

## Como funciona, passo a passo

1. **O agente roda em cada caixa** (serviço systemd no Linux). A cada poucos segundos ele lê os logs e arquivos do software do PDV (estado da venda, operador, alertas, NFC-e) e envia tudo ao painel com o token.
2. **O servidor valida e normaliza** o que chega:
   - o token é comparado em tempo constante;
   - um caixa cadastrado só é aceito vindo do IP cadastrado dele;
   - os textos são limpos e os valores passam por uma lista do que é permitido.

   Depois atualiza o estado e grava o evento.
3. **O painel recebe as mudanças por WebSocket** e reordena a fila de alertas por urgência e tempo de espera.
4. **O fiscal atende:**
   - "Atender" manda o comando de volta ao caixa, que avisa o cliente;
   - abrir a tela liga o proxy VNC, e o servidor autentica no caixa;
   - todo controle remoto fica no registro, com usuário e horário.
5. **A TI acompanha em `/admin`:** agentes sem contato ou desatualizados, indicadores de espera, histórico e cadastro.

### API local do agente (para o software do caixa)

| Chamada | Efeito |
|---|---|
| `POST /status` | atualiza estado, operador e vendas do dia |
| `POST /alerta` | abre um alerta (`ajuda`, `idade`, `peso`, `cancelamento`, `pagamento`, `erro`, `sem_papel`) |
| `POST /alerta/fim` | fecha o alerta |
| `GET /comandos` | comandos vindos do painel (`atendimento_a_caminho`, `liberar`) |

A API escuta só em `127.0.0.1`.

## Segurança

- **XSS:** tudo que vem dos agentes é limpo no servidor e escapado de novo no navegador. A Content-Security-Policy só aceita scripts do próprio servidor.
- **CSRF e WebSocket de outro site:** cookie `SameSite=Strict` e conferência da origem em toda alteração e em toda conexão.
- **Força bruta:** bloqueio por computador, por login e por token de agente errado.
- **Senhas:** scrypt com sal, tamanho mínimo e bloqueio de senhas comuns. Trocar a senha ou desativar o usuário derruba as sessões abertas na hora.
- **Tela dos caixas:** a senha VNC fica só no servidor. As miniaturas são "só ver" (o servidor descarta teclado e mouse).
- **Cabeçalhos:** CSP, `frame-ancestors 'none'`, `nosniff`, `no-referrer`.
- **Arquivos:** só a pasta `public/` é servida. Configuração e dados ficam fora do repositório.

## Design

A interface segue o conceito **"Torre de controle"**: o que precisa de ação aparece primeiro e é lido de longe, e o resto fica em segundo plano. As decisões de cor, tipografia, estados e acessibilidade estão em [`DESIGN.md`](DESIGN.md). O contexto de produto e os usuários estão em [`PRODUCT.md`](PRODUCT.md).

## Implantação (resumo)

1. `deploy/gerar-pacote.ps1` gera um `.zip` com o painel.
2. No servidor Windows, `deploy/windows/instalar-servidor.ps1`:
   - copia os arquivos;
   - cria uma tarefa agendada, que sobe com o Windows e reinicia se cair;
   - libera a porta no firewall;
   - restringe o acesso a `config.json` e `data/`.
3. Nos caixas Linux, `agent/linux/instalar.sh` instala o agente como serviço. Para vários caixas de uma vez, `agent/linux/instalar-todos.ps1` faz isso via SSH.
