---
name: Painel Self-Checkout
description: Painel em tempo real para fiscais de self-checkout
colors:
  pista-noturna: "#0e1116"
  console: "#171b22"
  console-elevado: "#1d222b"
  divisoria: "#2a313c"
  texto: "#e8ebf0"
  texto-apoio: "#a5adba"
  texto-discreto: "#8a93a0"
  estado-livre: "#8b93a0"
  estado-venda: "#60a5fa"
  estado-pagamento: "#a78bfa"
  sinal-ambar: "#f59e0b"
  sinal-ambar-fundo: "#2a2112"
  sinal-vermelho: "#f87171"
  sinal-vermelho-fundo: "#2c1719"
  sinal-verde: "#4ade80"
  estado-offline: "#5f6773"
  sinal-verde-fundo: "#0d2416"
  tinta-sobre-ambar: "#1d1405"
  tinta-sobre-vermelho: "#1f0a0b"
  tinta-selo: "#1a0b0c"
  fundo-tela: "#05070a"
typography:
  dado-tecnico:
    fontFamily: "ui-monospace, 'Cascadia Mono', Consolas, monospace"
    fontSize: "0.92em"
    fontWeight: 400
  titulo-configuracoes:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "20px"
    fontWeight: 700
  titulo-dialogo:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "18px"
    fontWeight: 700
  numero-caixa:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "30px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.02em"
    fontFeature: "'tnum'"
  numero-caixa-grande:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "36px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  contador:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "40px"
    fontWeight: 700
  contador-grande:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "48px"
    fontWeight: 700
  fila:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "24px"
    fontWeight: 700
  fila-grande:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "28px"
    fontWeight: 700
  alerta:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "20px"
    fontWeight: 700
  alerta-grande:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "22px"
    fontWeight: 700
  body:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: "'tnum'"
  body-grande:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.45
  apoio:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 400
  apoio-grande:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "15px"
    fontWeight: 400
  selo:
    fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 800
    letterSpacing: "0.06em"
rounded:
  selo: "4px"
  tela: "6px"
  controle: "8px"
  bloco: "10px"
  cartao: "12px"
  painel: "14px"
  pilula: "999px"
spacing:
  e1: "4px"
  e2: "8px"
  e3: "12px"
  e4: "16px"
  e5: "20px"
  e6: "24px"
  e8: "32px"
components:
  botao:
    backgroundColor: "{colors.console}"
    textColor: "{colors.texto}"
    rounded: "{rounded.controle}"
    padding: "6px 12px"
    height: "34px"
  botao-primario:
    backgroundColor: "{colors.texto}"
    textColor: "{colors.console}"
    rounded: "{rounded.controle}"
    padding: "6px 12px"
    height: "34px"
  filtro-loja:
    backgroundColor: "{colors.console}"
    textColor: "{colors.texto}"
    rounded: "{rounded.pilula}"
    padding: "3px 10px"
    height: "30px"
  filtro-loja-ativo:
    backgroundColor: "{colors.texto}"
    textColor: "{colors.console}"
    rounded: "{rounded.pilula}"
  cartao-caixa:
    backgroundColor: "{colors.console}"
    textColor: "{colors.texto}"
    rounded: "{rounded.cartao}"
    padding: "12px"
  aviso-alerta:
    backgroundColor: "{colors.sinal-ambar-fundo}"
    textColor: "{colors.texto}"
    rounded: "{rounded.controle}"
    padding: "8px 10px"
  aviso-critico:
    backgroundColor: "{colors.sinal-vermelho-fundo}"
    textColor: "{colors.texto}"
    rounded: "{rounded.controle}"
    padding: "8px 10px"
  campo:
    backgroundColor: "{colors.console}"
    textColor: "{colors.texto}"
    rounded: "{rounded.controle}"
    padding: "8px 10px"
---

# Design System: Painel Self-Checkout

## Overview

**Creative North Star: "Torre de controle"**

Calmo quando está tudo bem, impossível de ignorar quando algo precisa de atenção. O painel é uma sala escura de monitoramento: superfícies grafite quase sem contraste entre si, texto claro e nenhuma cor decorativa. A cor só aparece para dizer o estado de um caixa, e o alerta é o único elemento autorizado a se mexer.

A densidade é confortável, não compacta: o fiscal lê de pé, a alguns passos, de relance. Por isso o número do PDV é o maior texto da tela, e tudo o que não ajuda a decidir "qual caixa atender agora" fica em tom de apoio. O tema é sempre escuro, independente do sistema operacional do computador da loja.

**Key Characteristics:**
- Fundo grafite em camadas tonais, sem sombras no tema escuro.
- Cor reservada a estado: âmbar e vermelho para alertas, azul e violeta para venda e pagamento, cinza para livre e sem conexão.
- O número do caixa manda na hierarquia de cada cartão.
- Movimento só no alerta não atendido; atendido para de piscar.
- Fonte do sistema com algarismos tabulares, para tempos e valores não "dançarem".

## Colors

Grafite neutro carregando a tela inteira, com sinais de cor que só acendem por estado.

### Primary
- **Âmbar de Sinal** (sinal-ambar): borda, pulso e marcador de todo alerta aberto de prioridade normal. É a cor que puxa o fiscal.
- **Vermelho de Sinal** (sinal-vermelho): alerta crítico (falha de pagamento, erro no caixa). Substitui o âmbar; nunca aparecem juntos no mesmo cartão.

### Secondary
- **Azul Em Venda** (estado-venda): caixa vendendo.
- **Violeta Pagamento** (estado-pagamento): caixa na etapa de pagamento.
- Livre (verde), em venda (azul), pagamento (roxo) e caixa fechado (ciano `#22d3ee`, PDV normal fora de turno) aparecem só no ponto, no rótulo de estado e numa borda fina (1px, cor a 65%). O ciano foi escolhido por distância medida: 13 ou mais contra cada cor de estado em visão normal e 11 ou mais para daltonismo, e longe do cinza de sem conexão. O fundo do cartão fica neutro. Alerta (borda de 3px, fundo com 7% do sinal) e sem conexão (cinza tracejado) prevalecem: o alerta é a única coisa forte na tela.
- **Verde Ao Vivo** (sinal-verde): indicador de conexão do painel e **caixa livre** (ponto, rótulo e borda fina), para o fiscal ver de longe quais caixas estão disponíveis.

### Neutral
- **Pista Noturna** (pista-noturna): fundo da página.
- **Console** (console): cartões, barra superior, botões.
- **Console Elevado** (console-elevado): faixa da fila de alertas, cartão sem conexão, hover.
- **Divisória** (divisoria): bordas de 1px de cartões, botões e campos.
- **Texto** (texto), **Texto de Apoio** (texto-apoio), **Texto Discreto** (texto-discreto): três níveis de texto; o discreto só para informação que pode ser ignorada.
- **Sem Conexão** (estado-offline): cinza de estado. (estado-livre fica para caixas sem informação de estado; o livre informado pelo agente usa o verde.)
- **Fundos de sinal** (sinal-ambar-fundo, sinal-vermelho-fundo): o bloco do aviso dentro do cartão em alerta.

### Named Rules
**The Cor É Estado Rule.** Nenhuma cor saturada aparece sem significar um estado de caixa ou de conexão. Botões, títulos e fundos ficam nos neutros.

**The Nunca Só Cor Rule.** Todo estado com cor também tem texto ("Em venda", "Sem conexão") e, no alerta, borda e bloco próprios. Cor sozinha nunca carrega a informação.

## Typography

**Body Font:** fonte do sistema (system-ui, com -apple-system, Segoe UI e Roboto de reserva)

**Character:** uma única família, a do sistema, com algarismos tabulares ligados na página toda. A hierarquia vem de tamanho e peso, não de troca de fonte.

### Hierarchy
Escala fixa com um degrau a mais em monitores a partir de 1600px de largura (valores "grande" no frontmatter). Pensada para leitura de pé, a 2–3 m: o que diz "o que fazer agora" (fila, contadores, motivo) é o maior texto depois do número do PDV.
- **Número do caixa** (700, 30px / 36px, -0.02em): "PDV 005" no topo de cada cartão. O maior texto da tela.
- **Contador** (700, 40px / 48px): números da barra lateral.
- **Fila** (700, 24px / 28px): "Loja 001 · PDV 007" e o tempo em cada item da fila; o próximo ganha +6px, o atendido cai para o tamanho de Alerta.
- **Alerta** (700, 20px / 22px): motivo e tempo de espera do alerta no cartão, sempre no mesmo tamanho e peso.
- **Body** (400, 15px / 16px, 1.45): botões, campos, fila.
- **Apoio** (14px / 15px): metadados do cartão (vendas, R$), status, rótulo "LOJA 001" (650, 0.06em, maiúsculas).
- **Selo** (800, 13px, 0.06em, maiúsculas): "CRÍTICO" em vermelho de sinal com letra escura. Ao lado do número do PDV, no cartão, ele usa o tamanho de Body (15px / 16px), para ser lido de longe.

### Named Rules
**The Número Primeiro Rule.** Em cada cartão, o número do PDV é o primeiro texto lido; nada no cartão pode ser maior ou mais pesado que ele.

**The Tempo Junto do Motivo Rule.** O tempo de espera de um alerta tem o mesmo tamanho e peso do motivo. Ele é a urgência; nunca vira metadado cinza.

## Layout

Barra lateral fixa à esquerda (232px): título, contadores um embaixo do outro (número grande e rótulo), Self-checkout / PDV normal / Todos (só TI), loja, tamanho das telas, e no rodapé conexão, som, Configurações (só TI), usuário e sair. Recolhível (botão com seta que gira, 220ms; lembrado por computador; sem preferência gravada começa recolhida abaixo de 1600px de largura e aberta acima): vira uma coluna de 88px com os números e os ícones; cada número mantém o nome embaixo ("em alerta", "operando", "sem conexão", 13px, quebrando em duas linhas), porque só a cor não diz qual é qual. As telas ganham a largura. A animação de recolher não dispara o aviso "fora da tela" (ele espera as telas se reajustarem). No rodapé da lateral aberta, uma dica discreta dos atalhos de teclado: <kbd>nº</kbd> abre o PDV, <kbd>F10</kbd> fecha a tela. No topo, sticky, fica só o que é urgente: a faixa de queda de conexão (quando cai) e a fila de alertas (90px fixos). Todos os botões da lateral têm 44px de altura. Abaixo de 900px a lateral vira uma faixa no alto; abaixo de 640px o topo deixa de ser fixo e rola com a página.

- Espaçamento em base 4 (4, 8, 12, 16, 20, 24, 32).
- **Mosaico de telas:** cada cartão mostra a tela do self ao vivo. Todas as telas têm a mesma altura e a largura segue o formato real do self (deitado 4:3 ou em pé), detectado pela própria imagem e lembrado por caixa. Os cartões fluem em linhas (flex-wrap) com espaço de 12px (16px no monitor grande), como um muro de monitores.
- Altura das telas: **Auto** (padrão) calcula a maior altura em que todos os caixas da estação cabem no monitor sem rolar, considerando o formato de cada self e a quebra de linha; recalcula ao mudar a janela, a lista de caixas ou um formato, mas não quando um alerta aparece (as telas não pulam: a faixa de alertas tem altura fixa de 90px e as linhas do cartão têm altura fixa, com o texto acompanhando a largura). A tela nunca fica menor que 140px de altura; se mesmo assim não couber tudo, a página rola e o botão "fora da tela" avisa. P/M/G fixos: 210/300/420px, ou 250/360/500px a partir de 1600px.
- Cartão enxuto: sem alerta, é só a linha do número e a tela. Não há botão "Ampliar": clicar na tela amplia (pelo teclado, a tela recebe foco e Enter abre). Aviso, metadados e ação principal aparecem só quando existem. Caixa sem agente não mostra status; IP e situação ficam na dica do cartão.
- Margem lateral de 20px; 16px abaixo de 640px de largura.
- Cada loja é uma seção com 32px de espaço abaixo.
- Cartão com largura mínima de 170px; número e estado acompanham a largura do cartão (linhas de altura fixa, para o Auto não entrar em vaivém). A linha de baixo mostra o estado grande (até 20px, 700) e os detalhes pequenos ao lado (vendas, valor).
- Quando o Auto não consegue pôr todos na tela (monitor pequeno, muitos caixas), um botão fixo no rodapé avisa "N caixas fora da tela" (âmbar se algum deles está em alerta) e rola até eles.
- Filtro de loja: botões com até 3 lojas; com mais, uma lista de seleção ("Todas as lojas").
- O antigo "Recolher topo" saiu: com os controles na lateral, o topo já é só a fila de alertas.
- O filtro de loja recorta só a grade; fila e contadores sempre mostram todos os caixas da estação.
- Os cartões mantêm a posição fixa (ordem por loja e PDV): o fiscal memoriza onde fica cada caixa. Alertas são destacados na fila, não reordenando a grade.

## Elevation & Depth

Profundidade por camadas tonais, sem sombras no tema escuro: página (pista-noturna), console e console elevado. O único efeito de "luz" é o halo pulsante do alerta não atendido (anel de 4px na cor do sinal a 40–50%, 8px por fora do cartão, que só varia a opacidade).

### Named Rules
**The Só o Alerta Brilha Rule.** Nenhum elemento além do cartão em alerta ganha halo, brilho ou sombra.

## Shapes

Cantos suavemente arredondados e consistentes: 8px em botões, campos e avisos; 12px nos cartões de caixa; 14px no cartão de login; pílula completa nos filtros de loja. Bordas de 1px na cor divisória. O cartão sem conexão troca a borda sólida por tracejada.

## Components

### Buttons
- **Shape:** cantos de 8px, altura mínima de 36px (44px nas ações do cartão).
- **Padrão:** fundo console, borda divisória, texto claro; hover passa para console elevado.
- **Primário:** invertido (fundo texto claro, letra console), usado só em "Entrar" e "Conectar". Na tela ampliada, "Fechar F10" é neutro: o destaque da janela é a ação do alerta.
- **Ação do alerta:** no cartão em alerta, o botão principal ganha o fundo e a borda do sinal (âmbar ou vermelho).
- **Foco:** contorno de 2px em branco (cor do texto), afastado 2px; 3px na tela do caixa. Nunca azul: seria lido como "Em venda".
- **Desabilitado:** 45% de opacidade. Travas temporárias usam `aria-disabled` para não perder o foco.

### Chips
- **Filtro de loja:** pílula de 32px; o ativo fica invertido como o botão primário.

### Cards / Containers
- **Cartão de caixa:** fundo console, borda divisória de 1px, cantos de 12px, padding de 12px. Ordem: número, tela (com a faixa do alerta por cima da parte de baixo, quando houver) e a linha de estado.
- **Em alerta:** borda de 3px na cor do sinal, status vira "Alerta" ou "Crítico", faixa sobre a tela com motivo e tempo lado a lado e o botão de ação, anel pulsante por fora do cartão (só muda de opacidade, barato de animar) até alguém clicar em Atender. O crítico troca o âmbar pelo vermelho, ganha o selo "CRÍTICO" ao lado do número do PDV e pulsa mais rápido (0,7s contra 1,2s): a diferença não depende só da cor. Com movimento reduzido, o anel fica fixo na cor do sinal.
- **Liberando e liberado:** durante a contagem para desfazer (15 s) o cartão sai do modo alerta: sem borda nem pulso de sinal, sem a cor da venda (nada de "Livre" verde antes da hora), faixa e botão neutros, com o motivo ainda à vista e "Liberando em 12s". Depois, "Caixa liberado por você" (verde, 10 s). Um alerta novo nesse caixa cancela a confirmação e aparece na hora.
- **Alerta não confirmado:** se o agente do caixa para de responder com um alerta aberto, o alerta pode já ter acabado. O cartão perde a cor de estado e o pulso; a faixa fica neutra com linha tracejada: "Não confirmado: o caixa parou de responder. Confira no caixa." O botão é "Liberar caixa" (neutro). Não conta em "em alerta".
- **Sem conexão:** fundo console elevado, borda tracejada, número e status em texto discreto, "Sem sinal há…" e IP.
- **Sem agente:** borda sólida normal, status "Sem agente", "Só acesso à tela". É estado permanente, não avaria.

### Tela ao vivo (signature)
Imagem da tela do self dentro do cartão, entre o número e o aviso, sobre fundo quase preto com canto de 6px. Só imagem: a conexão é "só ver" no servidor (teclado e mouse são descartados). Em alerta, a moldura da tela ganha a cor do sinal. Sem imagem, a tela esmaece e mostra "Sem imagem da tela. Tentando de novo…". Uma camada transparente sobre a miniatura recebe o clique; o cursor continua a seta normal. A faixa do alerta fica por cima da parte de baixo da tela, mas como elemento irmão (a tela é um botão, e botão não contém botão). Caixa fora da vista por 10 s, ou a aba escondida por 30 s, pausa a miniatura e mantém a última imagem congelada; voltou para a vista, retoma sozinha.

### Caixa ampliado
Clicar na tela (ou Enter com ela em foco) faz a tela crescer a partir da própria miniatura até ocupar ~94% do monitor (animação de 320ms, curva de saída suave, origem no canto da janela calculada para coincidir com a miniatura). O fundo escurece a 80%. A janela tem uma barra de 52px com "Loja · PDV · nome da loja", o estado da conexão, "Ctrl+Alt+Del" e "Fechar"; a barra aparece com um leve atraso. Durante a conexão mostra a última imagem da miniatura. O controle de mouse e teclado já vem ligado e o foco vai para a tela do caixa. Fechar (botão "Fechar F10", F10 a qualquer momento ou clique no fundo) faz a tela encolher de volta para o lugar e devolve o foco ao botão do caixa. F10 é capturado antes do noVNC, então fecha mesmo com o teclado controlando o caixa; Esc fecha só quando o foco está fora da tela do caixa (lá dentro ele vai para o caixa). "Ctrl+Alt+Del" só fica ativo com o controle conectado (travado com `aria-disabled`, continua no Tab e diz o motivo ao clicar) e pede confirmação no próprio botão ("Confirmar Ctrl+Alt+Del?" por 5 s, sem janela do navegador). Se a conexão falha, uma mensagem grande sobre a imagem diz o motivo e o próximo passo ("Não foi possível controlar o PDV 005 agora. Ele pode estar desligado ou fora da rede: vá até o caixa ou tente de novo.") e a barra ganha "Tentar de novo". Com alerta aberto, uma linha de 52px abaixo da barra (nunca sobre a tela, que tem os botões do self) mostra motivo, tempo, "a caminho" quando atendido e a mesma ação do cartão (Atender / Liberar caixa / Desfazer); o foco começa nessa ação (sem alerta, no Fechar). Quando o alerta tem detalhe (ex.: "Bebida alcoólica — conferir documento"), a linha cresce para 72px e ele aparece embaixo do motivo, em texto claro: é o único lugar em que o detalhe sempre aparece (no cartão ele sai em tela baixa e no cartão largo). Se a miniatura já estava sem imagem, a janela abre compacta (até 680×380) e cresce se a conexão funcionar. Enquanto o zoom está aberto, o painel por trás fica inerte (o Tab não sai da janela). Conectado, a janela ganha borda branca (foco) de 2px e a barra diz em destaque "Controlando o caixa: mouse e teclado vão para ele". "Ctrl+Alt+Del" é discreto, afastado do "Fechar" e pede confirmação. Com movimento reduzido, abre e fecha sem animação. O cartão de origem ganha contorno branco (foco) enquanto está ampliado.

### Som
Com "Som ligado", um alerta novo toca na hora (duas notas; crítico, três). Enquanto houver alerta sem ninguém atendendo, o som se repete a cada 1 minuto. Para quando alguém clica em Atender ou o alerta fecha.

### Ações do cartão
O aviso e o botão principal ficam numa faixa sobre a parte de baixo da tela do caixa (fundo do sinal a 94%, linha de 2px no topo), então o cartão não cresce quando um alerta abre e a altura Auto continua valendo. A faixa ocupa no máximo ~55% da tela (com piso de 104px para caber o botão), então a tela do cliente continua visível em cima. Cartão estreito (menos de 360px): motivo e tempo numa linha (motivo com reticências; o texto inteiro fica na dica), o detalhe embaixo e o botão largo. Cartão largo (360px ou mais, ex.: 1920): texto à esquerda e botão à direita; o motivo quebra em até 2 linhas, com o tempo embaixo, e o detalhe fica só na tela ampliada; a faixa cobre ~28% da tela (36% com motivo longo), em vez de quase metade. Com a tela abaixo de 240px a faixa fica compacta (~80px): uma linha de texto (17px) e o botão; o detalhe sai. Atendido: o cartão sai do primeiro plano (borda tracejada de 2px, fundo neutro, sem pulso, estado "A caminho" na linha de baixo); motivo e tempo continuam na faixa, em cinza, em qualquer tamanho de tela. Não há frase "Você está a caminho" nem nome de quem vai: o monitor pode ser de mais de um fiscal. Em alerta, a linha de baixo não mostra o estado da venda ("Alerta" e "Pagamento" liam como dois estados). O botão de 44px nunca é cortado. Em alerta, a linha de baixo do cartão não repete "Livre" ao lado de "Crítico". O botão principal é largo, cheio na cor do sinal. Sem conexão com o servidor, ele fica travado com o motivo na dica, em vez de não fazer nada. Ele muda de papel sem mudar de lugar: "Atender" → "Liberar caixa" (fundo neutro) → "Desfazer" durante 15s → confirmação "Caixa liberado por você" (faixa verde, 10s). Depois de "Atender", o principal fica travado por 1,5s para um clique duplo não liberar o caixa.

### Faixa de conexão
Faixa em largura total no fundo vermelho de sinal, dentro do cabeçalho fixo: "Sem conexão com o servidor há 0:12". Enquanto ela aparece, fila e grade ficam esmaecidas e os cronômetros congelam.

### Inputs / Fields
- **Style:** fundo console, borda divisória, cantos de 8px, padding de 8px 10px.
- **Focus:** contorno de 2px em azul em venda.

### Fila de alertas (signature)
Uma linha só, de altura fixa (78px), dentro do cabeçalho fixo: o topo nunca muda de altura e as telas não pulam. Um botão por alerta com a largura de "onde + tempo" (mínimo 240px; nunca encolhe nem corta o tempo; o motivo corta com reticências): na linha de cima "Loja 002 · PDV 007" (o maior texto do botão), selo "CRÍTICO" quando for o caso e o cronômetro à direita; embaixo o motivo e quem está indo, com reticências. A dica diz o que o clique faz ("Clicar: atender (avisa o cliente) e abrir a tela do caixa"). Ordem: alertas ao vivo antes dos não confirmados (caixa sem sinal, tracejados e sem cronômetro); depois quem ainda não tem ninguém indo; depois prioridade; depois tempo de espera. O primeiro ao vivo sem ninguém indo é maior (+6px) e tem borda de 3px. Fila vazia: ponto verde e "Tudo em ordem · nenhum alerta aberto". O que não cabe na linha vira "Mais N alertas", que abre uma lista por cima das telas (Esc ou clique fora fecha). Atendido ou liberando vai para o fim com fundo neutro ("· a caminho", "Liberando…"). Pelo teclado: as setas ← → andam pela fila, e digitar o número do PDV (1, 5, 12…) amplia esse caixa. Não há tecla para atender: "Atender" avisa o cliente, e uma tecla só podia pegar um alerta que acabou de chegar. Os atalhos não valem com a tela ampliada aberta (lá o teclado vai para o caixa) nem dentro de campos. O botão não tem aria-label: o leitor de tela lê o próprio texto, e só o cronômetro muda (sem refazer o botão). Clicar leva até o cartão, marca "Atender" (o cliente sabe que alguém vem; som e pulso param) e abre a tela ampliada com controle; alerta não confirmado só leva até o cartão.

### Configurações (/admin)
No painel, o nível TI / Administrador vê o botão "Configurações" no topo (entre "Som" e "Sair"); o Fiscal não vê. A página tem "Voltar ao painel".
Mesmo mundo (escuro, cor só para estado), mas para a TI sentada, lendo de perto: tipo um degrau menor (corpo 14px), tabelas densas, filtros e diálogos. Só o nível TI / Administrador (o nível Fiscal vê "Acesso restrito"); mesma porta do painel, em /admin.
- **Barra lateral fixa (236px):** "Configurações" e "Painel Self-Checkout" no alto, com o botão de recolher (ícone de painel com seta que gira 180°); as 5 seções com ícone de traço (Saúde dos agentes, Indicadores, Lojas e caixas, Usuários, Registro); no rodapé "Voltar ao painel", o usuário, o servidor que está sendo alterado (principal e teste não compartilham cadastro) e o botão de sair (ícone). Seção atual: fundo claramente mais claro que o hover e ícone branco (sem azul, que é "em venda"). Recolhida, vira uma coluna de 68px só com ícones (o nome aparece na dica), animando a largura em 220ms (140ms com movimento reduzido no sistema); a escolha fica guardada no navegador. Abaixo de 900px vira uma faixa no alto com as seções roláveis de lado, sem o botão de recolher.
- **Saúde dos agentes** (abre aqui): até 5 filtros em pílula com contagem ("Precisam de atenção" é o padrão; "Notas sem autorização" só aparece quando há alguma) e "Mais filtros" para os raros (nunca conectaram, tela com erro). Tabela com os problemas primeiro. A coluna Situação mostra uma situação principal, a pior do caixa (notas sem autorização > sem contato > tela com erro > desatualizado > fora de estação > nunca conectou > funcionando), com o detalhe e "Também: …" embaixo; as colunas Estação e Tela ficam neutras, só com o dado. Situação sempre ponto + texto. Loja inteira sem contato (3+ caixas, contando os que nunca conectaram) vira uma linha de resumo no alto ("12 de 12 caixas sem contato desde… Provável queda de rede, energia ou do link da loja") com "Ver os N caixas". Desatualizados ganham uma caixa com o comando pronto para copiar. Caixa fora do cadastro e sem contato tem "Remover da lista". Atualiza a cada 10s mudando só os números: o foco do teclado não se perde.
- **Indicadores:** períodos em pílula (Hoje, Ontem, 7 e 30 dias) e loja numa linha acima de tudo; uma faixa de 6 números (7 com contingência; linhas finas desenhadas por bloco, sem sobra cinza na última linha) com rótulo, valor 28px e frase de apoio; logo abaixo, a seção de notas em contingência; depois cartões com título e uma frase do que o gráfico responde. Gráficos em HTML/CSS, uma cor por gráfico: âmbar `#c77c05` para alertas e azul `#3b82f6` para vendas (um tom abaixo do sinal do painel, validados contra o fundo escuro). Contingência usa barra cinza neutra e só passa a vermelho (com o texto "verificar") acima de 20% das vendas, com uma frase do que conferir no caixa. Colunas de até 24px com ponta arredondada de 4px, grade em linha fina, só o pico com número; o gráfico por hora é uma parada só no Tab, com as setas andando entre as horas. Tabelas com barra de proporção e os números em colunas próprias; o cabeçalho das tabelas gruda no alto ao rolar. Dica no hover e no foco; a atualização automática só redesenha se os números mudaram.
- **Lojas e caixas:** lista de lojas à esquerda (filtra o resto), tabela de caixas e cartões de estação à direita. Tudo vira rascunho; uma barra flutuante "N alterações não salvas" leva a "Revisar e salvar", que lista as mudanças em português antes de gravar. Loja com caixas não pode ser removida. Conflito com edição à mão é detectado e explicado.
- **Usuários:** tabela com ações em texto (Editar, Trocar senha, Desativar, Remover). O próprio usuário e o último admin ativo não podem ser removidos, desativados nem rebaixados.
- **Registro:** linha do tempo com filtros (período, tipo, usuário, loja, caixa) e "Carregar mais antigos".
- **Diálogos:** `<dialog>` modal, 560px, Enter confirma, Esc cancela; ação destrutiva com botão vermelho e texto que diz o efeito.

## Do's and Don'ts

### Do:
- **Do** manter o tema escuro como padrão, independente do sistema operacional.
- **Do** usar âmbar (sinal-ambar) para alerta normal e vermelho (sinal-vermelho) só para crítico.
- **Do** acompanhar toda cor de estado com texto e forma (borda, bloco, ponto).
- **Do** parar o pulso quando o alerta é atendido e respeitar `prefers-reduced-motion` com um anel fixo.
- **Do** manter os cartões em posição fixa por loja e PDV.

### Don't:
- **Don't** usar cor saturada em botões, títulos ou fundos decorativos.
- **Don't** reordenar a grade quando um alerta abre; a fila de alertas é quem ordena.
- **Don't** animar nada além do alerta não atendido.
- **Don't** deixar qualquer texto do cartão maior que o número do PDV.
- **Don't** usar barra lateral colorida grossa em avisos; o bloco tonal com contorno de 1px já marca o alerta.
