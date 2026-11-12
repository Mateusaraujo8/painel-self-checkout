# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Fiscal da ilha de self-checkout** (usuário principal). Fica de pé perto dos caixas, atendendo clientes, e olha um monitor fixo com o painel entre um atendimento e outro. O trabalho dele: perceber na hora qual caixa precisa de ajuda, ir até lá (ou resolver pela tela remota) e liberar o caixa.

Administradores (TI) cadastram usuários, ligam computadores a caixas no `estacoes.json` e têm visão de todos os caixas.

## Product Purpose

Painel web em tempo real para supervisionar self-checkouts: mostra o estado de cada caixa (livre, em venda, pagamento, sem conexão), uma fila de alertas por prioridade e antiguidade (ajuda, restrição de idade, divergência de peso, cancelamento, falha de pagamento, erro, sem papel) e abre a tela do caixa pelo navegador (VNC).

Sucesso: nenhum cliente fica parado esperando sem o fiscal saber, e o fiscal sabe qual caixa atender primeiro sem precisar procurar.

## Positioning

Alternativa interna ao monitor de self-checkout do fornecedor do PDV: roda no navegador, sem instalação nem privilégio de administrador no computador do fiscal, com acesso remoto integrado e controle de acesso por usuário e por computador.

## Operating Context

- Rede de várias lojas, até cerca de 10 self-checkouts por loja.
- Cada computador de fiscal enxerga só os caixas da sua estação, definida pelo IP do computador em `estacoes.json`.
- Caixas rodam Linux (Ubuntu 16.04) com VNC na porta 5900; um agente Python reporta status e alertas ao servidor.
- O fiscal está em movimento e com atenção dividida: o painel é lido de relance, a alguns passos de distância, num ambiente de loja com ruído.
- Ações do fiscal: Atender (avisa o caixa que alguém está a caminho), Liberar caixa (encerra o alerta, com 15 segundos para desfazer), telas sempre visíveis no mosaico (só imagem); clicar num caixa amplia a tela dele já com mouse e teclado ligados. Clicar num alerta da fila leva ao caixa, marca Atender e abre a tela ampliada com controle (decisão da operação).

## Capabilities and Constraints

- Login obrigatório por usuário e senha; perfis `admin` e `supervisor`.
- Todo acesso remoto e toda mudança de alerta ficam registrados em log com usuário e horário.
- A senha VNC fica só no servidor e nunca chega ao navegador.
- Terminologia usada na operação: loja, PDV, caixa, self-checkout, fiscal, alerta, liberar.
- Decisão em aberto: se o painel substitui o AcruxMonitor ou roda em paralelo durante uma transição.

## Evidence on Hand

Não há marca, logo, depoimentos ou métricas de uso. Não inventar números de desempenho, nomes de lojas ou clientes.

## Product Principles

1. **O alerta mais urgente se encontra num relance.** Prioridade e tempo de espera vêm antes de qualquer outra informação.
2. **Feito para quem está de pé e em movimento.** Legível à distância, alvos grandes, poucas decisões por ação.
3. **Olhar é seguro; agir é deliberado.** As miniaturas nunca interferem na venda (são só imagem, garantido no servidor). Controlar exige um gesto claro: ampliar o caixa, e aí o controle já vem ligado.
4. **Cada um vê só o que é seu.** A estação define os caixas visíveis, e toda ação fica rastreável a uma pessoa.

## Accessibility & Inclusion

Leitura à distância e de relance num monitor fixo: estados não podem depender só de cor (texto e forma junto), contraste alto e respeito a `prefers-reduced-motion` nos alertas que piscam. O alerta sonoro é opcional e precisa de alternativa visual.
