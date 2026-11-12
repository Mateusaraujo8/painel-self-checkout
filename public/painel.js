const $ = (s) => document.querySelector(s);
const caixas = new Map();
const cards = new Map(); // id -> elemento
let offsetRelogio = 0; // diferença entre o relógio do servidor e o do navegador
let filtroLoja = lerPref('filtroLoja', 'todas');
let somLigado = lerPref('som', 'nao') === 'sim';
let ws;
let desconectadoEm = null; // enquanto sem servidor, o tempo "para" nos cartões

// Ações locais com prazo, para evitar cliques acidentais.
const SEGUNDOS_DESFAZER = 15; // tempo para quem se afastou do monitor voltar e desfazer
const liberando = new Map(); // id -> { ate, timer }
const liberados = new Map(); // id -> momento em que foi liberado por este usuário
const guarda = new Map(); // id -> até quando o botão principal fica bloqueado após Atender

const STATUS = {
  livre: 'Livre',
  em_venda: 'Em venda',
  pagamento: 'Pagamento',
  fechado: 'Caixa fechado',
};

function lerPref(chave, padrao) {
  try { return localStorage.getItem(chave) ?? padrao; } catch { return padrao; }
}
function gravarPref(chave, valor) {
  try { localStorage.setItem(chave, valor); } catch {}
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const agora = () => Date.now() + offsetRelogio;
// Sem servidor, os cronômetros congelam no momento da queda: não mostram "ao vivo" sobre dado velho.
const relogio = () => (desconectadoEm ? desconectadoEm + offsetRelogio : agora());
const pad3 = (n) => String(n).padStart(3, '0');
// Sempre número: um valor de texto vindo de fora nunca chega à página como HTML.
const dinheiro = (v) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const nomeCaixa = (c) => `Loja ${pad3(c.loja)} · PDV ${pad3(c.pdv)}`;
// Vendas cuja NFC-e não foi autorizada (o caixa não consegue enviar à SEFAZ). Mesma regra da
// Saúde dos agentes: há mais de 5 min e com erro de envio (ou 3+ notas). Venda em andamento não conta.
// Mesma regra de server/admin.js (problemaFiscal): com erro de envio, avisa em 2 min ("NFC-e
// travada"); sem erro registrado, só com 3+ notas paradas há 5 min.
function notasPendentes(c) {
  const f = c.online ? c.fiscal : null;
  if (!f || !f.pendentes || !f.pendenteDesde) return '';
  const idade = relogio() - f.pendenteDesde;
  const travado = f.errosEnvio > 0 && idade >= 2 * 60000;
  if (!travado && !(f.pendentes >= 3 && idade >= 5 * 60000)) return '';
  const n = Math.trunc(Number(f.pendentes)) || 0;
  if (travado) {
    const hora = new Date(Number(f.pendenteDesde)).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return `<span class="notas-pendentes" title="O caixa não consegue enviar a NFC-e à SEFAZ (erro de envio). As vendas estão saindo sem nota autorizada. Avise a TI.">NFC-e travada desde ${hora} · ${n} ${n === 1 ? 'venda' : 'vendas'} sem nota</span>`;
  }
  return `<span class="notas-pendentes">${n} ${n === 1 ? 'nota sem autorização' : 'notas sem autorização'}</span>`;
}
let nomesLojas = {};
const nomeLoja = (l) => (nomesLojas[l] ? `Loja ${pad3(l)} · ${nomesLojas[l]}` : `Loja ${pad3(l)}`);
const falado = (c) => `loja ${c.loja}, PDV ${c.pdv}`;

function duracao(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}:${String(s % 60).padStart(2, '0')}`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h${String(m % 60).padStart(2, '0')}` : `${Math.floor(h / 24)} dias`;
}

// ------------------------------------------------------------------ login
let eu = null;

async function iniciar() {
  const r = await fetch('/api/eu');
  if (r.ok) return abrirPainel(await r.json());
  const cfg = await fetch('/api/config').then((x) => x.json());
  if (!cfg.temUsuarios) {
    $('#erroLogin').textContent = 'Ainda não há usuários cadastrados. Peça à TI para criar o seu acesso.';
  }
  $('#telaLogin').hidden = false;
  $('#formLogin input[name=usuario]').focus();
}

$('#formLogin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const dados = Object.fromEntries(new FormData(e.target));
  const r = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dados),
  });
  const corpo = await r.json();
  if (!r.ok) {
    e.target.senha.value = '';
    e.target.senha.focus();
    return ($('#erroLogin').textContent = corpo.erro);
  }
  $('#telaLogin').hidden = true;
  abrirPainel(await fetch('/api/eu').then((x) => x.json()));
});

$('#formLogin input[name=senha]').addEventListener('keyup', (e) => {
  $('#avisoCaps').hidden = !e.getModifierState?.('CapsLock');
});

$('#btnSair').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.reload();
});

function abrirPainel(dados) {
  eu = dados;
  // Quem está logado fica ao lado, como texto; o botão só diz a ação.
  $('#usuario').textContent = dados.usuario;
  $('#usuario').title = `${dados.usuario} · ${dados.estacao || 'Sem estação'} · IP ${dados.ip}`;
  $('#btnSair').setAttribute('aria-label', `Sair (${dados.usuario})`);
  // Só o nível TI / Administrador vê "Configurações" (o servidor também bloqueia o resto).
  $('#linkConfig').hidden = dados.perfil !== 'admin';
  $('#app').hidden = false;
  atualizarBotaoSom();
  medirCabecalho();
  conectar();
  setInterval(atualizarTempos, 1000);
}

// A rolagem até um cartão desconta a altura do cabeçalho fixo.
function medirCabecalho() {
  const ro = new ResizeObserver(() => {
    document.documentElement.style.setProperty('--alt-cabecalho', `${$('#cabecalho').offsetHeight}px`);
    agendarAjuste();
  });
  ro.observe($('#cabecalho'));
}

// ------------------------------------------------------------------ tempo real
function conectar() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/painel`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.tipo === 'inicial') {
      offsetRelogio = msg.agora - Date.now();
      nomesLojas = msg.lojas || {};
      marcarConexao(true);
      caixas.clear();
      for (const c of msg.caixas) caixas.set(c.id, c);
      renderizarTudo();
    } else if (msg.tipo === 'caixa') {
      const antes = caixas.get(msg.caixa.id);
      caixas.set(msg.caixa.id, msg.caixa);
      if (msg.caixa.alerta && !antes?.alerta) avisarNovoAlerta(msg.caixa);
      // Um alerta novo depois de "liberado por você" volta a aparecer na hora.
      if (msg.caixa.alerta && liberados.has(msg.caixa.id) && msg.caixa.alerta.desde > liberados.get(msg.caixa.id) + offsetRelogio) {
        liberados.delete(msg.caixa.id);
      }
      agendarRender();
    } else if (msg.tipo === 'removido') {
      caixas.delete(msg.id);
      agendarRender();
    }
  };
  ws.onclose = (ev) => {
    marcarConexao(false);
    if (ev.code === 1006 || ev.code === 1008) {
      // Pode ser sessão expirada: confere antes de insistir.
      fetch('/api/eu')
        .then((r) => (r.ok ? setTimeout(conectar, 2000) : location.reload()))
        .catch(() => setTimeout(conectar, 2000));
    } else setTimeout(conectar, 2000);
  };
}

function marcarConexao(ok) {
  if (ok) desconectadoEm = null;
  else desconectadoEm ??= Date.now();
  $('#conexao').classList.toggle('caiu', !ok);
  $('#conexaoTexto').textContent = ok ? 'Ao vivo' : 'Sem conexão';
  $('#conexao').title = ok ? 'Ao vivo: conectado ao servidor' : 'Sem conexão com o servidor';
  $('#faixaConexao').hidden = ok;
  $('#principal').classList.toggle('desatualizado', !ok);
  $('#fila').classList.toggle('desatualizado', !ok);
  atualizarTempos();
  // Sem servidor, os botões de ação ficam travados (com o motivo), em vez de não fazer nada.
  if (caixas.size) renderizarGrade();
}

function enviar(obj) {
  if (ws?.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(obj));
  return true;
}

function avisarNovoAlerta(c) {
  tocarAlerta(c.alerta.prioridade);
  const critico = c.alerta.prioridade >= 3 ? 'crítico ' : '';
  $('#anuncio').textContent = `Novo alerta ${critico}na ${falado(c)}: ${c.alerta.rotulo}.`;
}

// ------------------------------------------------------------------ render
const ordenar = (l) => l.sort((a, b) => a.loja - b.loja || a.pdv - b.pdv);
// TI escolhe ver os selfs ou os PDVs normais (lembrado por computador). Fiscal vê o que a
// estação dele libera, sem essa escolha.
let tipoVer = lerPref('tipoCaixas', 'self');
const ehTI = () => eu?.perfil === 'admin';
const temPdvNormal = () => [...caixas.values()].some((c) => c.tipo === 'pdv');
const doTipo = (c) =>
  !ehTI() || !temPdvNormal() || tipoVer === 'todos' || (tipoVer === 'pdv' ? c.tipo === 'pdv' : c.tipo !== 'pdv');
const todos = () => ordenar([...caixas.values()].filter(doTipo));
// O filtro de loja só recorta a grade; fila e contadores sempre mostram tudo desta estação.
const daGrade = () => todos().filter((c) => filtroLoja === 'todas' || String(c.loja) === filtroLoja);

function renderizarTudo() {
  clearTimeout(renderTimer);
  renderTimer = null;
  renderizarFiltros();
  renderizarContadores();
  renderizarFila();
  renderizarGrade();
}
// Várias mensagens de caixa num instante (ex.: 50 caixas mandando o estado) viram um desenho só.
let renderTimer = null;
function agendarRender() {
  renderTimer ??= setTimeout(renderizarTudo, 100);
}

// Uma loja: sem filtro. Até 3: botões. Mais que isso: uma lista compacta, para o cabeçalho
// caber numa linha e sobrar altura para as telas.
function renderizarFiltros() {
  const lojas = [...new Set(todos().map((c) => c.loja))].sort((a, b) => a - b);
  if (filtroLoja !== 'todas' && !lojas.map(String).includes(filtroLoja)) filtroLoja = 'todas';
  const opcoes = [['todas', 'Todas as lojas'], ...lojas.map((l) => [String(l), nomesLojas[l] || `Loja ${pad3(l)}`])];
  // Self-checkout | PDV normal: só para a TI e só quando há PDV normal cadastrado.
  const tipos =
    ehTI() && temPdvNormal()
      ? `<div class="tipos" role="group" aria-label="Tipo de caixa">${[
          ['self', 'Self-checkout'],
          ['pdv', 'PDV normal'],
          ['todos', 'Todos'],
        ]
          .map(([v, t]) => `<button data-tipo="${v}" aria-pressed="${v === (['pdv', 'todos'].includes(tipoVer) ? tipoVer : 'self')}">${t}</button>`)
          .join('')}</div>`
      : '';
  let html = tipos;
  if (lojas.length > 3) {
    html += `<select id="selLoja" aria-label="Filtrar caixas por loja">${opcoes
      .map(([v, t]) => `<option value="${v}">${esc(t)}</option>`)
      .join('')}</select>`;
  } else if (lojas.length > 1) {
    html += opcoes
      .map(([v, t]) => `<button data-loja="${v}" aria-pressed="${v === filtroLoja}">${v === 'todas' ? 'Todas' : esc(t)}</button>`)
      .join('');
  }
  // Só redesenha quando muda de verdade: redesenhar a cada atualização fechava a lista
  // aberta enquanto o fiscal escolhia a loja.
  const el = $('#filtros');
  if (el.dataset.html !== html) {
    el.dataset.html = html;
    el.innerHTML = html;
  }
  const sel = el.querySelector('#selLoja');
  if (sel && sel.value !== filtroLoja) sel.value = filtroLoja;
}

function trocarFiltro(valor) {
  filtroLoja = valor;
  gravarPref('filtroLoja', filtroLoja);
  renderizarTudo();
}
$('#filtros').addEventListener('click', (e) => {
  const t = e.target.closest('button[data-tipo]');
  if (t) {
    tipoVer = t.dataset.tipo;
    gravarPref('tipoCaixas', tipoVer);
    return renderizarTudo();
  }
  const b = e.target.closest('button[data-loja]');
  if (b) trocarFiltro(b.dataset.loja);
});
$('#filtros').addEventListener('change', (e) => {
  if (e.target.id === 'selLoja') trocarFiltro(e.target.value);
});

// Situação de cada caixa. Com agente, vale o que o agente informa. Sem agente (ou com o
// agente fora), a tela ao vivo serve de sinal de vida: se a imagem abre, o caixa está operando.
const estadoTela = new Map(); // id -> 'ok' | 'falha'
// Alerta de um caixa cujo agente parou de responder: pode já ter acabado. Não é tratado
// como urgente nem conta como "em alerta"; aparece como "não confirmado".
const alertaSemSinal = (c) => Boolean(c.alerta) && !c.online && c.versao !== 'manual';
function situacao(c) {
  if (c.alerta && !alertaSemSinal(c)) return 'alerta';
  if (c.online) return 'operando';
  const t = estadoTela.get(c.id);
  if (t === 'ok') return 'operando';
  if (t === 'falha') return 'offline';
  return c.versao === 'manual' ? 'verificando' : 'offline';
}

function renderizarContadores() {
  const l = todos().map(situacao);
  const conta = (s) => l.filter((x) => x === s).length;
  // "Em alerta" conta todos os caixas (igual à fila); operando/sem conexão seguem o tipo na grade.
  // Caixa em "Liberando" (contagem para desfazer) ou recém-liberado já saiu do alerta no cartão.
  const emAlerta = [...caixas.values()].filter((c) => situacao(c) === 'alerta' && !liberando.has(c.id) && !liberados.has(c.id)).length;
  $('#nAlerta').textContent = emAlerta;
  $('#cAlerta').classList.toggle('ativo', emAlerta > 0);
  $('#nOperando').textContent = conta('operando');
  $('#nOffline').textContent = conta('offline');
}

let renderPendente = false;
function mudouTela(id, estado) {
  if (estadoTela.get(id) === estado) return;
  estadoTela.set(id, estado);
  if (renderPendente) return;
  renderPendente = true;
  setTimeout(() => {
    renderPendente = false;
    renderizarContadores();
    renderizarGrade();
  }, 100);
}

// Ordem da fila: alertas ao vivo antes dos "não confirmados" (caixa sem sinal); depois quem
// ainda não tem ninguém indo; depois prioridade; depois o mais antigo.
function alertasEmOrdem() {
  // Todos os tipos: mesmo olhando os PDVs normais, a TI não perde um chamado de self.
  return ordenar([...caixas.values()])
    .filter((c) => c.alerta)
    .sort(
      (a, b) =>
        alertaSemSinal(a) - alertaSemSinal(b) ||
        (Boolean(a.alerta.atendidoPor) || liberando.has(a.id)) - (Boolean(b.alerta.atendidoPor) || liberando.has(b.id)) ||
        b.alerta.prioridade - a.alerta.prioridade ||
        a.alerta.desde - b.alerta.desde,
    );
}

function itemFila(c, proximo) {
  const a = c.alerta;
  const semSinal = alertaSemSinal(c);
  const critico = a.prioridade >= 3 && !semSinal;
  const lib = liberando.has(c.id);
  const classes = ['fila-item', `p${Number(a.prioridade) || 1}`, (a.atendidoPor || lib) && 'atendido', semSinal && 'sem-sinal', proximo && 'proximo'];
  // Atendido diz só "a caminho": o monitor pode ser de mais de um fiscal, então nada de "você".
  const quem = semSinal ? 'Não confirmado: o caixa parou de responder' : lib ? 'Liberando…' : a.atendidoPor ? 'a caminho' : '';
  const dica = semSinal
    ? 'Clicar: ir até o caixa (o alerta não foi confirmado)'
    : a.atendidoPor || lib
      ? 'Clicar: abrir a tela do caixa'
      : 'Clicar: atender (avisa o cliente) e abrir a tela do caixa';
  // Linha 1: onde + tempo (nunca cortados). Linha 2: motivo e quem está indo, com reticências.
  // Sem aria-label: o leitor de tela lê o próprio texto do botão (o tempo muda sem refazer o botão).
  return `<button data-ir="${esc(c.id)}" class="${classes.filter(Boolean).join(' ')}" title="${esc(`${a.rotulo}. ${dica}`)}">
      <span class="fl1"><span class="onde">${nomeCaixa(c)}</span>${critico ? '<span class="selo">Crítico</span>' : ''}<span class="tempo"${semSinal ? '' : ` data-desde="${Number(a.desde) || 0}"`}>${semSinal ? '—' : duracao(relogio() - a.desde)}</span></span>
      <span class="fl2"><span class="motivo">${esc(a.rotulo)}</span>${quem ? `<span class="quem"> · ${esc(quem)}</span>` : ''}</span>
    </button>`;
}

function renderizarFila() {
  const fila = $('#fila');
  const alertas = alertasEmOrdem();
  let html;
  if (!alertas.length) {
    html = '<span class="vazia"><strong>Tudo em ordem</strong> nenhum alerta aberto</span>';
  } else {
    // "Próximo": o mais urgente ao vivo, ainda sem ninguém indo.
    const proximo = alertas.find((c) => !alertaSemSinal(c) && !c.alerta.atendidoPor && !liberando.has(c.id));
    html = alertas.map((c) => itemFila(c, c === proximo)).join('') + '<button class="mais" data-expandir aria-expanded="false" aria-controls="filaMais" hidden></button>';
  }
  // Só refaz os botões quando algo muda de verdade (os tempos andam sozinhos, em atualizarTempos).
  if (fila.dataset.html !== html) {
    const focado = fila.contains(document.activeElement) ? document.activeElement.dataset.ir || 'mais' : null;
    fila.dataset.html = html;
    fila.innerHTML = html;
    encaixarFila();
    if (focado) (focado === 'mais' ? fila.querySelector('.mais') : fila.querySelector(`[data-ir="${CSS.escape(focado)}"]`))?.focus();
  }
  if (!alertas.length) fecharFilaMais();
}

// A fila ocupa sempre uma linha só (o topo não muda de altura e as telas não pulam).
// O que não cabe vai para "Mais N alertas", que abre uma lista por cima das telas.
function encaixarFila() {
  const fila = $('#fila');
  const itens = [...fila.querySelectorAll('.fila-item')];
  const mais = fila.querySelector('.mais');
  if (!mais) return;
  for (const it of itens) it.hidden = false;
  mais.hidden = true;
  if (fila.scrollWidth <= fila.clientWidth + 1) return atualizarFilaMais([]);
  mais.hidden = false;
  const escondidos = [];
  for (let i = itens.length - 1; i > 0 && fila.scrollWidth > fila.clientWidth + 1; i--) {
    itens[i].hidden = true;
    escondidos.unshift(itens[i]);
    mais.textContent = `Mais ${escondidos.length} ${escondidos.length === 1 ? 'alerta' : 'alertas'}`;
  }
  atualizarFilaMais(escondidos);
}

let filaMaisAberta = false;
function atualizarFilaMais(escondidos) {
  const lista = $('#filaMais');
  const html = escondidos.map((it) => it.outerHTML.replace(/\shidden(="")?/, '')).join('');
  if (lista.dataset.html !== html) {
    // Refaz só se mudou, devolvendo o foco ao mesmo alerta (ou ao primeiro) se ele estava na lista.
    const focado = lista.contains(document.activeElement) ? document.activeElement.dataset.ir : null;
    lista.dataset.html = html;
    lista.innerHTML = html;
    if (focado) (lista.querySelector(`[data-ir="${CSS.escape(focado)}"]`) || lista.querySelector('button'))?.focus();
  }
  if (!escondidos.length) fecharFilaMais();
  else lista.hidden = !filaMaisAberta;
}
function abrirFilaMais() {
  filaMaisAberta = true;
  $('#filaMais').hidden = false;
  $('#fila .mais')?.setAttribute('aria-expanded', 'true');
  $('#filaMais button')?.focus();
}
function fecharFilaMais() {
  filaMaisAberta = false;
  $('#filaMais').hidden = true;
  $('#fila .mais')?.setAttribute('aria-expanded', 'false');
}
new ResizeObserver(() => encaixarFila()).observe($('#fila'));
document.addEventListener('click', (e) => {
  if (filaMaisAberta && !e.target.closest('#filaMais, #fila .mais')) fecharFilaMais();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && filaMaisAberta) {
    fecharFilaMais();
    $('#fila .mais')?.focus();
  }
});

// Clicar num alerta (na fila ou na lista "Mais"): leva até o caixa, marca "Atender" (o
// cliente sabe que alguém vem, o som e o pulso param) e abre a tela ampliada com controle.
function irParaAlerta(id) {
  const c = caixas.get(id);
  // Alerta de um tipo que não está na grade (ex.: self enquanto a TI vê PDVs normais): troca.
  if (c && !doTipo(c)) {
    tipoVer = c.tipo === 'pdv' ? 'pdv' : 'self';
    gravarPref('tipoCaixas', tipoVer);
    renderizarTudo();
  }
  // Se o caixa está fora do filtro atual, mostra todas as lojas para não perder o alerta.
  if (c && filtroLoja !== 'todas' && String(c.loja) !== filtroLoja) {
    filtroLoja = 'todas';
    gravarPref('filtroLoja', filtroLoja);
    renderizarTudo();
  }
  const card = cards.get(id);
  if (!card) return;
  card.scrollIntoView({ behavior: 'auto', block: 'nearest' });
  if (c?.alerta && !c.alerta.atendidoPor && !alertaSemSinal(c) && !liberando.has(id) && enviar({ tipo: 'atender', id })) {
    guarda.set(id, Date.now() + 1500);
    setTimeout(() => {
      guarda.delete(id);
      renderizarGrade();
    }, 1600);
  }
  if (c?.ip && !alertaSemSinal(c)) abrirZoom(id);
  else (card.querySelector('.acao-principal') || card.querySelector('[data-slot="tela"]'))?.focus({ preventScroll: true });
}
$('#fila').addEventListener('click', (e) => {
  if (e.target.closest('[data-expandir]')) return filaMaisAberta ? fecharFilaMais() : abrirFilaMais();
  const b = e.target.closest('[data-ir]');
  if (b) irParaAlerta(b.dataset.ir);
});
$('#filaMais').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ir]');
  if (!b) return;
  fecharFilaMais();
  irParaAlerta(b.dataset.ir);
});

// ---- Atalhos de teclado (fora da tela ampliada, onde o teclado vai para o caixa)
// Número do PDV (1, 5, 12…): amplia esse caixa. Setas ← →: andam pela fila. A dica fica no
// rodapé da lateral. Não há tecla para atender: "Atender" avisa o cliente, e uma tecla só
// podia pegar um alerta que acabou de chegar.
let digitos = '';
let digitosTimer = null;
function abrirPdv(n) {
  const c = daGrade().find((x) => Number(x.pdv) === n);
  const card = c && cards.get(c.id);
  if (!card) return anunciar(`Não há PDV ${n} na tela.`);
  card.scrollIntoView({ behavior: 'auto', block: 'nearest' });
  if (c.ip) abrirZoom(c.id);
  else card.querySelector('[data-slot="tela"]')?.focus({ preventScroll: true });
}
document.addEventListener('keydown', (e) => {
  if (zoom.id || e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented) return;
  if (e.target.closest?.('input, select, textarea, [contenteditable]')) return;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const lista = e.target.closest?.('#fila, #filaMais');
    if (!lista) return;
    const botoes = [...lista.querySelectorAll('button:not([hidden])')];
    const i = botoes.indexOf(document.activeElement);
    const proximo = botoes[i + (e.key === 'ArrowRight' ? 1 : -1)];
    if (proximo) {
      e.preventDefault();
      proximo.focus();
    }
    return;
  }
  if (/^[0-9]$/.test(e.key)) {
    e.preventDefault();
    digitos = (digitos + e.key).slice(-3);
    clearTimeout(digitosTimer);
    // Espera um instante pelo próximo dígito: "1" e "2" seguidos abrem o PDV 12.
    digitosTimer = setTimeout(() => {
      const n = Number(digitos);
      digitos = '';
      if (n) abrirPdv(n);
    }, 700);
  }
});

function renderizarGrade() {
  const principal = $('#principal');
  const lista = daGrade();
  if (!lista.length) {
    for (const [id, card] of cards) {
      desligarTela(id);
      esquecerCartao(id, card);
    }
    cards.clear();
    principal.innerHTML =
      eu && !eu.estacao && !eu.veTodos
        ? `<div class="vazio">
            <p>Este computador ainda não foi liberado para ver caixas.</p>
            <p>Peça à TI para liberar o IP <code>${esc(eu.ip)}</code>.</p>
          </div>`
        : eu?.perfil === 'admin'
          ? `<div class="vazio">
              <p>Nenhum caixa cadastrado ainda.</p>
              <p>Cadastre os caixas no <code>estacoes.json</code> ou instale o agente neles.</p>
            </div>`
          : `<div class="vazio"><p>Nenhum caixa liberado para esta estação. Fale com a TI.</p></div>`;
    return;
  }
  principal.querySelector('.vazio')?.remove();

  const porLoja = Map.groupBy(lista, (c) => c.loja);
  const secoesVistas = new Set();
  for (const [loja, itens] of porLoja) {
    let secao = principal.querySelector(`section[data-loja="${loja}"]`);
    if (!secao) {
      secao = document.createElement('section');
      secao.className = 'loja';
      secao.dataset.loja = loja;
      secao.innerHTML = '<h2></h2><div class="grade"></div>';
      const depois = [...principal.querySelectorAll('section.loja')].find((s) => Number(s.dataset.loja) > loja);
      principal.insertBefore(secao, depois || null);
    }
    const titulo = nomeLoja(loja);
    if (secao.querySelector('h2').textContent !== titulo) {
      secao.querySelector('h2').textContent = titulo;
      secao.setAttribute('aria-label', titulo);
    }
    secoesVistas.add(String(loja));
    const grade = secao.querySelector('.grade');
    itens.forEach((c, i) => {
      const card = cardDe(c);
      if (grade.children[i] !== card) grade.insertBefore(card, grade.children[i] || null);
    });
  }
  const idsVisiveis = new Set(lista.map((c) => c.id));
  for (const [id, card] of cards) {
    if (!idsVisiveis.has(id)) {
      desligarTela(id);
      esquecerCartao(id, card);
      card.remove();
      cards.delete(id);
    }
  }
  for (const s of principal.querySelectorAll('section.loja')) if (!secoesVistas.has(s.dataset.loja)) s.remove();
  if (zoom.id) atualizarZoomAlerta();
  conferirVista();
  const assinatura = lista.map((c) => c.id).join(',');
  if (assinatura !== ultimaAssinatura) {
    ultimaAssinatura = assinatura;
    agendarAjuste();
  }
}
let ultimaAssinatura = '';

// ------------------------------------------------------------------ telas ao vivo (miniaturas VNC)
const telas = new Map(); // id -> { rfb, ip, espera, timer, obs }
const ASPECTO_PADRAO = 4 / 3;

function lerAspecto(id) {
  const v = Number(lerPref(`aspecto:${id}`, ''));
  return v > 0.2 && v < 5 ? v : ASPECTO_PADRAO;
}

function aplicarAspecto(card, aspecto) {
  const valor = aspecto.toFixed(4);
  if (card.style.getPropertyValue('--aspecto') === valor) return;
  card.style.setProperty('--aspecto', valor);
  card.classList.toggle('retrato', aspecto < 1);
  agendarAjuste();
}

// Mensagem curta sobre a miniatura (lida de longe, sem repetir frases longas em todo cartão);
// o motivo completo fica na dica e na Saúde dos agentes.
function mensagemTela(card, texto, detalhe = '') {
  const msg = card.querySelector('.tela-msg');
  msg.textContent = texto || '';
  msg.hidden = !texto;
  // A camada de clique fica por cima da mensagem: a dica vai nela.
  card.querySelector('.tela-toque').title = detalhe || '';
}

// Descobre o formato do self (deitado ou em pé) pelo tamanho real da tela remota.
function observarFormato(id, card) {
  const t = telas.get(id);
  const canvas = card.querySelector('.tela canvas');
  if (!t || !canvas) return;
  const medir = () => {
    if (!canvas.width || !canvas.height) return;
    const aspecto = canvas.width / canvas.height;
    gravarPref(`aspecto:${id}`, aspecto.toFixed(4));
    aplicarAspecto(card, aspecto);
  };
  t.obs?.disconnect();
  t.obs = new MutationObserver(medir);
  t.obs.observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] });
  medir();
}

function ligarTela(c, card) {
  const atual = telas.get(c.id);
  if (atual && atual.ip === c.ip) return;
  desligarTela(c.id);
  if (!c.ip) return mensagemTela(card, 'Sem IP cadastrado');

  const t = { ip: c.ip, espera: atual?.espera || 3000 };
  telas.set(c.id, t);
  const conectarTela = () => {
    if (!cards.has(c.id) || telas.get(c.id) !== t) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const alvo = card.querySelector('.tela');
    alvo.replaceChildren();
    mensagemTela(card, 'Conectando…');
    const rfb = new NoVNC.default(alvo, `${proto}://${location.host}/vnc/${encodeURIComponent(c.id)}?modo=miniatura`, { shared: true });
    rfb.viewOnly = true;
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.focusOnClick = false;
    rfb.qualityLevel = 4;
    rfb.compressionLevel = 6;
    t.rfb = rfb;
    rfb.addEventListener('connect', () => {
      t.espera = 3000;
      mensagemTela(card, '');
      card.classList.remove('sem-imagem');
      observarFormato(c.id, card);
      mudouTela(c.id, 'ok');
    });
    rfb.addEventListener('disconnect', () => {
      t.rfb = null;
      if (telas.get(c.id) !== t || !cards.has(c.id)) return;
      mudouTela(c.id, 'falha');
      card.classList.add('sem-imagem');
      mensagemTela(card, 'Sem imagem da tela. Tentando de novo…', 'Sem imagem da tela. Tentando de novo…');
      // Pergunta ao servidor o motivo real (senha, VNC desligado, caixa fora da rede): vai na dica.
      fetch(`/api/telas/${encodeURIComponent(c.id)}/motivo`)
        .then((r) => (r.ok ? r.json() : {}))
        .then((m) => {
          if (m.texto && telas.get(c.id) === t && !t.rfb) mensagemTela(card, 'Sem imagem da tela. Tentando de novo…', `${m.texto} Tentando de novo…`);
        })
        .catch(() => {});
      t.timer = setTimeout(conectarTela, t.espera);
      t.espera = Math.min(t.espera * 2, 60000);
    });
  };
  conectarTela();
}

function desligarTela(id) {
  const t = telas.get(id);
  if (!t) return;
  telas.delete(id);
  clearTimeout(t.timer);
  t.obs?.disconnect();
  try {
    t.rfb?.disconnect();
  } catch {}
}

// ---- Telas fora da vista não transmitem
// Caixa fora da área visível (rolagem) por 10 s, ou a aba escondida por 30 s: a miniatura pausa
// e fica a última imagem congelada. Voltou para a vista: retoma sozinha. Com o Auto, que põe
// tudo no monitor, nada pausa; economiza rede e processador quando há rolagem (ex.: TI vendo
// todas as lojas) ou quando o navegador fica minimizado.
const naVista = new Set();
let abaOculta = document.hidden;

// Conferência direta de quem está na tela (ou a até 200px dela), no máximo 1x por segundo:
// ao desenhar os cartões, ao rolar e ao mudar o tamanho da janela. Não depende só do
// IntersectionObserver, que alguns navegadores atrasam ou suspendem.
let conferenciaPendente = false;
function conferirVista() {
  if (conferenciaPendente) return;
  conferenciaPendente = true;
  setTimeout(() => {
    conferenciaPendente = false;
    // Uma medição por cartão serve para as duas coisas: pausar o que saiu da vista e
    // avisar os caixas que ficaram abaixo do monitor.
    const fora = [];
    for (const [id, card] of cards) {
      if (!card.isConnected) continue;
      const r = card.getBoundingClientRect();
      marcarVista(id, r.bottom > -200 && r.top < innerHeight + 200);
      if (r.top > innerHeight - 40) fora.push(card);
    }
    // Durante a animação da lateral as telas ainda não se reajustaram: não dá falso aviso.
    if (Date.now() < menuAnimandoAte) return;
    mostrarForaTela(fora);
  }, 300);
}
function marcarVista(id, visivel) {
  if (visivel && !naVista.has(id)) {
    naVista.add(id);
    retomarTela(id);
  } else if (!visivel && naVista.has(id)) {
    naVista.delete(id);
    agendarPausa(id, 10_000);
  } else if (visivel) {
    retomarTela(id); // já estava na vista: só garante que não há pausa agendada
  }
}
addEventListener('scroll', conferirVista, { passive: true });
addEventListener('resize', conferirVista);
const pausas = new Map(); // id -> timer
const deveTransmitir = (id) => naVista.has(id) && !abaOculta;

const observadorVista = new IntersectionObserver(
  (entradas) => {
    for (const e of entradas) marcarVista(e.target.dataset.id, e.isIntersecting);
  },
  { rootMargin: '200px 0px' },
);

function retomarTela(id) {
  // Com a aba escondida, não cancela a pausa agendada (senão a tela nunca pausaria).
  if (!deveTransmitir(id)) return;
  clearTimeout(pausas.get(id));
  pausas.delete(id);
  const c = caixas.get(id);
  const card = cards.get(id);
  if (c && card) ligarTela(c, card);
}

function agendarPausa(id, ms) {
  clearTimeout(pausas.get(id));
  pausas.set(
    id,
    setTimeout(() => {
      pausas.delete(id);
      if (!deveTransmitir(id)) pausarTela(id);
    }, ms),
  );
}

function pausarTela(id) {
  const card = cards.get(id);
  const aoVivo = card?.querySelector('.tela canvas');
  let congelada = null;
  if (aoVivo?.width && aoVivo?.height) {
    congelada = document.createElement('canvas');
    congelada.width = aoVivo.width;
    congelada.height = aoVivo.height;
    congelada.className = 'tela-congelada';
    try {
      congelada.getContext('2d').drawImage(aoVivo, 0, 0);
    } catch {
      congelada = null;
    }
  }
  desligarTela(id);
  if (card && congelada) card.querySelector('.tela').replaceChildren(congelada);
}

function esquecerCartao(id, card) {
  observadorVista.unobserve(card);
  naVista.delete(id);
  clearTimeout(pausas.get(id));
  pausas.delete(id);
}

document.addEventListener('visibilitychange', () => {
  abaOculta = document.hidden;
  if (abaOculta) for (const id of telas.keys()) agendarPausa(id, 30_000);
  else for (const id of naVista) retomarTela(id);
});

// Tamanho das telas no mosaico: Auto (ocupa o monitor) ou P/M/G fixos, lembrado por computador.
let tamanhoTelas = lerPref('tamanhoTelas', 'auto');
function aplicarTamanho() {
  document.documentElement.dataset.telas = tamanhoTelas;
  for (const b of document.querySelectorAll('#tamanhos [data-tamanho]')) {
    b.setAttribute('aria-pressed', String(b.dataset.tamanho === tamanhoTelas));
  }
  agendarAjuste();
}

let ajustePendente = false;
function agendarAjuste() {
  if (ajustePendente) return;
  ajustePendente = true;
  // setTimeout em vez de requestAnimationFrame: funciona mesmo com a aba em segundo plano.
  setTimeout(() => {
    ajustePendente = false;
    ajustarTelas();
  }, 50);
}
addEventListener('resize', agendarAjuste);

// Maior altura de tela em que todos os caixas visíveis cabem no monitor, sem rolar.
// Considera o formato de cada self (deitado ou em pé) e a quebra de linha do mosaico.
// Usa a parte fixa do cartão (número + tela); um aviso de alerta pode crescer o cartão
// sem refazer o mosaico, para as telas não ficarem pulando a cada alerta.
function ajustarTelas() {
  const raiz = document.documentElement;
  if (tamanhoTelas !== 'auto') {
    raiz.style.removeProperty('--altura-tela');
    marcarTelaBaixa();
    return;
  }
  const main = $('#principal');
  const secoes = [...main.querySelectorAll('section.loja')];
  if (!secoes.length) return;

  const csMain = getComputedStyle(main);
  const largura = main.clientWidth - parseFloat(csMain.paddingLeft) - parseFloat(csMain.paddingRight);
  const cabecalhoFixo = getComputedStyle($('#cabecalho')).position === 'sticky';
  const disponivel =
    innerHeight - (cabecalhoFixo ? $('#cabecalho').offsetHeight : 0) - parseFloat(csMain.paddingTop) - parseFloat(csMain.paddingBottom) - 8;

  const secoesDados = secoes.map((s, i) => {
    const grade = s.querySelector('.grade');
    const h2 = s.querySelector('h2');
    const csH2 = getComputedStyle(h2);
    const gap = parseFloat(getComputedStyle(grade).columnGap) || 12;
    const ultima = i === secoes.length - 1;
    const extra = h2.offsetHeight + parseFloat(csH2.marginBottom) + (ultima ? 0 : parseFloat(getComputedStyle(s).marginBottom));
    const itens = [...grade.children].map((card) => {
      const cs = getComputedStyle(card);
      // Tudo que não é a tela: número, linha de status, margens. O alerta fica sobre a tela,
      // então essa parte não muda quando um alerta abre. Folga para a borda mais grossa do alerta.
      const fixo = card.offsetHeight - card.querySelector('.tela-wrap').offsetHeight + 4;
      const lateral = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 6;
      return { aspecto: parseFloat(card.style.getPropertyValue('--aspecto')) || ASPECTO_PADRAO, fixo, lateral, minimo: parseFloat(cs.minWidth) || 0 };
    });
    return { gap, extra, itens };
  });

  const alturaTotal = (h) => {
    let total = 0;
    for (const d of secoesDados) {
      let x = 0, linha = 0, grade = 0, inicio = true;
      for (const it of d.itens) {
        const w = Math.min(largura, Math.max(it.minimo, h * it.aspecto + it.lateral));
        if (!inicio && x + d.gap + w > largura) {
          grade += linha + d.gap;
          x = 0;
          linha = 0;
          inicio = true;
        }
        x += (inicio ? 0 : d.gap) + w;
        inicio = false;
        // Se o cartão deitado bateu na largura máxima, a tela encolhe junto.
        const hReal = Math.min(h, (w - it.lateral) / it.aspecto);
        linha = Math.max(linha, hReal + it.fixo);
      }
      total += grade + linha + d.extra;
    }
    return total;
  };

  // Abaixo de 140px a tela do self fica ilegível: aí é melhor rolar (o botão "fora da tela" avisa).
  let lo = 140, hi = 1600;
  if (alturaTotal(lo) > disponivel) hi = lo;
  while (hi - lo > 2) {
    const meio = Math.floor((lo + hi) / 2);
    if (alturaTotal(meio) <= disponivel) lo = meio;
    else hi = meio;
  }
  const atual = parseFloat(raiz.style.getPropertyValue('--altura-tela')) || 0;
  if (Math.abs(atual - lo) > 2) raiz.style.setProperty('--altura-tela', `${lo}px`);
  marcarTelaBaixa();
  conferirVista();
}
// Tela baixa: a faixa do alerta fica mais enxuta (CSS usa data-tela-baixa na raiz).
function marcarTelaBaixa() {
  const h = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--altura-tela')) || 300;
  document.documentElement.toggleAttribute('data-tela-baixa', h < 240);
}

// Se mesmo assim algum caixa ficar fora da tela, avisa com um botão fixo embaixo.
function mostrarForaTela(fora) {
  const botao = $('#foraTela');
  botao.hidden = !fora.length;
  if (!fora.length) return;
  const comAlerta = fora.some((c) => c.classList.contains('em-alerta'));
  botao.classList.toggle('com-alerta', comAlerta);
  const texto = `${fora.length} ${fora.length === 1 ? 'caixa fora da tela' : 'caixas fora da tela'}${comAlerta ? ', com alerta' : ''}: ver`;
  if (botao.textContent !== texto) botao.textContent = texto;
}
// Segurança: alguns navegadores atrasam eventos em segundo plano; confere de vez em quando.
setInterval(conferirVista, 5000);
$('#foraTela').addEventListener('click', () => {
  const primeiro = [...cards.values()].find((c) => c.isConnected && c.getBoundingClientRect().top > innerHeight - 40);
  primeiro?.scrollIntoView({ behavior: 'auto', block: 'end' });
});
$('#tamanhos').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tamanho]');
  if (!b) return;
  tamanhoTelas = b.dataset.tamanho;
  gravarPref('tamanhoTelas', tamanhoTelas);
  aplicarTamanho();
});
aplicarTamanho();

function cardDe(c) {
  let card = cards.get(c.id);
  if (!card) {
    card = document.createElement('article');
    card.dataset.id = c.id;
    // A tela fica fora da parte que é redesenhada, para a imagem ao vivo não piscar.
    card.innerHTML = `
      <div class="cab"></div>
      <div class="tela-area">
        <div class="tela-wrap" data-acao="tela">
          <div class="tela"></div>
          <div class="tela-msg" hidden></div>
          <div class="tela-toque" aria-hidden="true"></div>
        </div>
        <div class="tela-alerta" hidden></div>
      </div>
      <div class="info"></div>`;
    aplicarAspecto(card, lerAspecto(c.id));
    cards.set(c.id, card);
    observadorVista.observe(card);
  }
  // Só transmite se estiver na vista (o observador liga quando o cartão aparece na tela).
  if (deveTransmitir(c.id)) ligarTela(c, card);
  const lib = liberando.get(c.id);
  const liberadoEm = liberados.get(c.id);
  const bloqueado = (guarda.get(c.id) || 0) > Date.now();
  const semServidor = Boolean(desconectadoEm);
  const chave = JSON.stringify([
    c.online, c.status, c.operador, c.alerta, c.vendasHoje, c.totalHoje, c.ip, c.nome, c.versao, c.fiscal,
    notasPendentes(c) !== '',
    Boolean(lib), Boolean(liberadoEm), bloqueado, estadoTela.get(c.id), semServidor, c.tipo, tipoVer,
  ]);
  if (card.dataset.chave === chave) return card;
  card.dataset.chave = chave;

  // Guarda qual botão tinha o foco para devolvê-lo depois de redesenhar.
  const focado = card.contains(document.activeElement) ? document.activeElement.dataset.slot : null;

  const a = c.alerta;
  const semAgente = !c.online && c.versao === 'manual';
  const forDoAr = situacao(c) === 'offline';
  const semSinal = alertaSemSinal(c);
  // Enquanto libera (ou logo depois), o cartão sai do modo alerta: cores neutras.
  const alertaVivo = a && !lib && !liberadoEm && !semSinal;
  card.className = [
    'caixa',
    forDoAr && 'offline',
    semAgente && 'sem-agente',
    alertaVivo && 'em-alerta',
    alertaVivo && `p${Number(a.prioridade) || 1}`,
    alertaVivo && a.atendidoPor && 'atendido',
    (lib || liberadoEm) && 'liberando',
    semSinal && !lib && !liberadoEm && 'alerta-sem-sinal',
  ]
    .filter(Boolean)
    .join(' ');
  // A cor do estado da venda só vale com o agente respondendo (senão é um dado velho).
  if (c.online) card.dataset.status = c.status;
  else delete card.dataset.status;
  card.setAttribute('aria-label', `Loja ${c.loja}, PDV ${c.pdv}`);

  const estadoVenda = STATUS[c.status] || esc(c.status);
  // Sem agente, só avisamos quando o caixa sai do ar; operando, a própria tela já diz tudo.
  // Atendido diz isso no próprio estado: de longe, "A caminho" não se confunde com um alerta sem ninguém.
  const status = alertaVivo
    ? a.atendidoPor ? 'A caminho' : a.prioridade >= 3 ? 'Crítico' : 'Alerta'
    : forDoAr ? 'Sem conexão' : semAgente ? '' : c.online ? estadoVenda : '';
  const travado = semServidor ? ' aria-disabled="true" title="Sem conexão com o servidor: a ação não chegaria ao caixa"' : '';
  // Dica só no número do caixa, para não cobrir a imagem da tela.
  const dica = `${nomeCaixa(c)} · IP ${c.ip || '—'}${semAgente ? ' · sem agente instalado' : ''}`;

  // Detalhes (discretos) depois do status: vendas e valor, ou há quanto tempo está sem sinal.
  const meta = semAgente
    ? []
    : !c.online
      ? [`sem sinal há <span data-desde="${Number(c.ultimoContato) || 0}">${duracao(relogio() - c.ultimoContato)}</span>`]
      : [
          // Primeiro: se a linha for cortada (cartão estreito), o aviso fiscal não some.
          notasPendentes(c),
          // Em alerta, o estado da venda não aparece: "Alerta" + "Pagamento" liam como dois estados.
          c.operador && esc(c.operador),
          `${Math.trunc(Number(c.vendasHoje)) || 0} ${Number(c.vendasHoje) === 1 ? 'venda' : 'vendas'}`,
          // Caixas sem o log "trace" não informam o valor: mostra só a quantidade de vendas.
          c.totalHoje != null && dinheiro(c.totalHoje),
        ];

  let bloco = '';
  if (lib) {
    // O alerta continua aberto até o fim da contagem: o motivo fica à vista.
    bloco = `<div class="aviso">
        <div class="aviso-topo"><strong title="${esc(a ? a.rotulo : '')}">${esc(a ? a.rotulo : 'Alerta')}</strong></div>
        <span class="liberando">Liberando em <span data-ate="${lib.ate}">${Math.ceil((lib.ate - Date.now()) / 1000)}</span>s</span>
      </div>`;
  } else if (semSinal && !liberadoEm) {
    // O caixa parou de responder com um alerta aberto: pode já ter sido resolvido lá.
    bloco = `<div class="aviso">
        <div class="aviso-topo"><strong>${esc(a.rotulo)}</strong></div>
        <div class="linha2">Não confirmado: o caixa parou de responder. Confira no caixa.</div>
      </div>`;
  } else if (a && !liberadoEm) {
    bloco = `<div class="aviso">
        <div class="aviso-topo"><strong title="${esc(a.mensagem ? `${a.rotulo}: ${a.mensagem}` : a.rotulo)}">${esc(a.rotulo)}</strong><span class="tempo" data-desde="${Number(a.desde) || 0}">${duracao(relogio() - a.desde)}</span></div>
        ${a.mensagem ? `<div class="linha2">${esc(a.mensagem)}</div>` : ''}
      </div>`;
  } else if (liberadoEm) {
    bloco = '<div class="liberado" role="status">Caixa liberado por você</div>';
  }

  let principal = '';
  if (lib) {
    principal = `<button class="acao-principal" data-acao="desfazer" data-slot="principal" aria-label="Desfazer: liberação da ${falado(c)}">Desfazer</button>`;
  } else if (liberadoEm) {
    principal = '';
  } else if (a && !a.atendidoPor && !semSinal) {
    principal = `<button class="acao-principal" data-acao="atender" data-slot="principal"${travado} aria-label="Atender: ${falado(c)} (avisa o cliente que alguém está indo)">Atender</button>`;
  } else if (a) {
    // Atendido, ou sem sinal: liberar encerra o alerta (ex.: o fiscal conferiu no caixa).
    principal = `<button class="acao-principal" data-acao="resolver" data-slot="principal"${travado || (bloqueado ? ' aria-disabled="true"' : '')} aria-label="Liberar caixa: ${falado(c)}">Liberar<span class="longo"> caixa</span></button>`;
  }

  // Crítico ganha o selo ao lado do número: forma e texto, além da cor (lido de longe).
  card.querySelector('.cab').innerHTML = `
      <span class="num" title="${esc(dica)}">PDV ${pad3(c.pdv)}</span>${alertaVivo && a.prioridade >= 3 ? '<span class="selo">Crítico</span>' : ''}${
        // Vendo "Todos": o PDV normal ganha uma etiqueta (no meio dos selfs da mesma loja).
        tipoVer === 'todos' && c.tipo === 'pdv'
          ? '<span class="tag-tipo" title="PDV normal (com operador)"><span class="tag-longa">PDV normal</span><span class="tag-curta">Normal</span></span>'
          : ''
      }`;
  // Sem botão "Ampliar": clicar na tela amplia. Pelo teclado, a tela recebe o foco e Enter abre.
  const wrap = card.querySelector('.tela-wrap');
  wrap.dataset.slot = 'tela';
  wrap.setAttribute('role', 'button');
  wrap.tabIndex = c.ip ? 0 : -1;
  // O nome da tela traz o estado: quem navega pelo teclado sabe qual caixa precisa de ajuda.
  const estadoFalado = alertaVivo ? `${a.prioridade >= 3 ? 'alerta crítico' : 'alerta'}: ${a.rotulo}` : semSinal ? 'alerta não confirmado' : status || 'sem estado';
  wrap.setAttribute('aria-label', `${falado(c)}, ${estadoFalado}. Ampliar a tela com controle de mouse e teclado`);
  wrap.setAttribute('aria-keyshortcuts', String(Number(c.pdv) || ''));

  // Alerta, liberação e confirmação ficam SOBRE a parte de baixo da tela: o cartão não cresce
  // e o botão nunca cai para fora do monitor.
  const sobre = card.querySelector('.tela-alerta');
  sobre.innerHTML = bloco || principal ? `${bloco}${principal ? `<div class="acoes">${principal}</div>` : ''}` : '';
  sobre.hidden = !bloco && !principal;

  // Linha de baixo: o estado em destaque (lido de longe) e os detalhes discretos.
  const detalhes = meta.filter(Boolean).join(' · ');
  const temLinha = status || detalhes;
  card.querySelector('.info').innerHTML = temLinha
    ? `<div class="meta">${status ? `<span class="status">${status}</span>` : ''}${detalhes ? `<span class="extra">${detalhes}</span>` : ''}</div>`
    : '';
  card.querySelector('.info').hidden = !temLinha;

  if (focado) (card.querySelector(`[data-slot="${focado}"]`) || card.querySelector('[data-slot="tela"]'))?.focus();
  return card;
}

// A tela do caixa funciona como botão pelo teclado (Enter ou espaço amplia).
$('#principal').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('tela-wrap')) {
    e.preventDefault();
    abrirZoom(e.target.closest('[data-id]').dataset.id);
  }
});
$('#principal').addEventListener('click', (e) => {
  const b = e.target.closest('[data-acao]');
  if (!b) return;
  const id = b.closest('[data-id]').dataset.id;
  if (b.getAttribute('aria-disabled') === 'true') return avisarTravado(id);
  if (b.dataset.acao === 'tela') return abrirZoom(id);
  acaoCaixa(id, b.dataset.acao);
});

// Anúncio discreto (não interrompe o leitor de tela) para o resultado das ações.
const anunciar = (texto) => ($('#anuncioCalmo').textContent = texto);
function avisarTravado(id) {
  anunciar(desconectadoEm ? 'Sem conexão com o servidor: a ação não chegaria ao caixa.' : `Aguarde um instante: Atender acabou de ser enviado para a ${falado(caixas.get(id))}.`);
}

// Atender / Liberar / Desfazer: usado pelo botão do cartão e pelo da tela ampliada.
function acaoCaixa(id, acao) {
  const c = caixas.get(id) || { loja: '', pdv: '' };
  if (acao === 'atender') {
    if (!enviar({ tipo: 'atender', id })) return avisarTravado(id);
    anunciar(`Atender enviado: o cliente da ${falado(c)} sabe que você está indo.`);
    // Bloqueia o botão por um instante: um clique duplo em "Atender" não libera o caixa.
    guarda.set(id, Date.now() + 1500);
    setTimeout(() => {
      guarda.delete(id);
      renderizarGrade();
      atualizarZoomAlerta();
    }, 1600);
  } else if (acao === 'resolver') {
    const ate = Date.now() + SEGUNDOS_DESFAZER * 1000;
    const timer = setTimeout(() => {
      liberando.delete(id);
      if (enviar({ tipo: 'resolver', id })) {
        liberados.set(id, Date.now());
        anunciar(`Caixa liberado: ${falado(c)}.`);
        setTimeout(() => {
          liberados.delete(id);
          renderizarGrade();
        }, 10000);
      } else {
        // A conexão caiu durante a contagem: o alerta continua aberto, e o fiscal fica sabendo.
        $('#anuncio').textContent = `Não foi possível liberar a ${falado(c)}: sem conexão com o servidor.`;
      }
      renderizarFila();
      renderizarGrade();
      atualizarZoomAlerta();
    }, SEGUNDOS_DESFAZER * 1000);
    liberando.set(id, { ate, timer });
    anunciar(`Liberando a ${falado(c)} em ${SEGUNDOS_DESFAZER} segundos. Use Desfazer para cancelar.`);
  } else if (acao === 'desfazer') {
    clearTimeout(liberando.get(id)?.timer);
    liberando.delete(id);
    anunciar(`Liberação desfeita: o alerta da ${falado(c)} continua aberto.`);
  }
  renderizarFila();
  renderizarGrade();
  atualizarZoomAlerta();
}

// ------------------------------------------------------------------ caixa ampliado
// A tela cresce a partir da miniatura (animação FLIP) e abre uma conexão própria com
// mouse e teclado ligados. As miniaturas continuam só imagem.
const zoom = { id: null, rfb: null, animando: false, comAlerta: false, comDetalhe: false, compacto: false };
const movimentoReduzido = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const DURACAO_ZOOM = 320;
const ALTURA_BARRA = 52;
const ALTURA_ALERTA = 52;
const ALTURA_ALERTA_DETALHE = 72; // motivo + detalhe em duas linhas

// Compacto: a miniatura já mostrava que a tela não abre; a janela não ocupa o monitor todo
// só para dar a mesma notícia (se conectar, ela cresce).
function geometriaZoom(aspecto) {
  const barra = ALTURA_BARRA + (zoom.comAlerta ? (zoom.comDetalhe ? ALTURA_ALERTA_DETALHE : ALTURA_ALERTA) : 0);
  const maxW = zoom.compacto ? Math.min(680, innerWidth * 0.94) : innerWidth * 0.94;
  const maxH = (zoom.compacto ? Math.min(380, innerHeight * 0.6) : innerHeight * 0.94) - barra;
  let th = Math.min(maxH, maxW / aspecto);
  let tw = th * aspecto;
  // A barra precisa de espaço para título e botões, mesmo com self em pé (tela estreita).
  const largura = Math.max(tw, Math.min(zoom.compacto ? 820 : 720, innerWidth * 0.94));
  return {
    left: (innerWidth - largura) / 2,
    top: (innerHeight - (th + barra)) / 2,
    largura,
    telaW: tw,
    telaH: th,
    barra,
  };
}

function posicionarZoom() {
  if (!zoom.id || zoom.animando) return;
  const card = cards.get(zoom.id);
  const g = geometriaZoom(parseFloat(card?.style.getPropertyValue('--aspecto')) || ASPECTO_PADRAO);
  Object.assign($('#zoomJanela').style, { left: `${g.left}px`, top: `${g.top}px`, width: `${g.largura}px`, height: `${g.telaH + g.barra}px` });
  $('#zoomJanela').style.setProperty('--tela-w', `${g.telaW}px`);
}

// Linha do alerta na tela ampliada: motivo, tempo, quem vai e a mesma ação do cartão.
function atualizarZoomAlerta() {
  const caixa = $('#zoomAlerta');
  if (!zoom.id) return;
  const c = caixas.get(zoom.id);
  const a = c?.alerta;
  const lib = liberando.get(zoom.id);
  const semSinal = c && alertaSemSinal(c);
  const travado = desconectadoEm || (guarda.get(zoom.id) || 0) > Date.now();
  let html = '';
  if (a && !liberados.has(zoom.id)) {
    const texto = lib
      ? `<span class="za-texto"><strong>${esc(a.rotulo)}</strong> <span class="za-apoio">Liberando em <span data-ate="${lib.ate}">${Math.ceil((lib.ate - Date.now()) / 1000)}</span>s</span></span>`
      : `<span class="za-texto"><strong>${esc(a.rotulo)}</strong>${a.prioridade >= 3 && !semSinal ? ' <span class="selo">Crítico</span>' : ''} <span class="tempo" data-desde="${Number(a.desde) || 0}">${duracao(relogio() - a.desde)}</span>${
          a.atendidoPor ? ' <span class="za-apoio">· a caminho</span>' : semSinal ? ' <span class="za-apoio">· não confirmado</span>' : ''
        }</span>`;
    const [acao, rotulo] = lib ? ['desfazer', 'Desfazer'] : a.atendidoPor || semSinal ? ['resolver', 'Liberar caixa'] : ['atender', 'Atender'];
    // O detalhe (ex.: "Bebida alcoólica — conferir documento") é o que o fiscal vai conferir.
    // Na tela pequena ele não cabe no cartão; aqui ele sempre aparece, numa segunda linha.
    const detalhe = a.mensagem ? `<span class="za-detalhe">${esc(a.mensagem)}</span>` : '';
    html = `<span class="za-bloco">${texto}${detalhe}</span><button class="za-acao" data-acao="${acao}"${travado && acao !== 'desfazer' ? ' aria-disabled="true"' : ''}>${rotulo}</button>`;
    caixa.className = `zoom-alerta${a.prioridade >= 3 && !semSinal ? ' p3' : ''}${a.atendidoPor || lib || semSinal ? ' neutro' : ''}`;
  }
  if (caixa.dataset.html !== html) {
    const tinhaFoco = caixa.contains(document.activeElement);
    caixa.dataset.html = html;
    caixa.innerHTML = html;
    if (tinhaFoco) caixa.querySelector('button')?.focus();
  }
  caixa.hidden = !html;
  const comDetalhe = Boolean(html && a.mensagem);
  caixa.classList.toggle('com-detalhe', comDetalhe);
  // Alerta (ou o detalhe) apareceu ou sumiu com a tela aberta: a janela ajusta a altura.
  if (Boolean(html) !== zoom.comAlerta || comDetalhe !== zoom.comDetalhe) {
    zoom.comAlerta = Boolean(html);
    zoom.comDetalhe = comDetalhe;
    posicionarZoom();
  }
}
$('#zoomAlerta').addEventListener('click', (e) => {
  const b = e.target.closest('[data-acao]');
  if (!b || !zoom.id) return;
  if (b.getAttribute('aria-disabled') === 'true') return avisarTravado(zoom.id);
  acaoCaixa(zoom.id, b.dataset.acao);
});

// Transform que faz a área da tela ampliada coincidir com a miniatura no mosaico.
// Com origem no canto superior esquerdo da janela, um ponto (px, py) da janela vai para
// (left + dx + s·px, top + dy + s·py). Queremos o canto da área da tela, (ox, barra),
// sobre o canto da miniatura, com s = largura da miniatura / largura da tela ampliada.
function transformDaMiniatura(card, g) {
  const de = card.querySelector('.tela-wrap').getBoundingClientRect();
  const s = de.width / g.telaW;
  const ox = (g.largura - g.telaW) / 2;
  const dx = de.left - g.left - s * ox;
  const dy = de.top - g.top - s * g.barra;
  return `translate(${dx}px, ${dy}px) scale(${s})`;
}

function fundoDoZoom(inerte) {
  for (const el of [$('#lateral'), $('#cabecalho'), $('#principal'), $('#foraTela'), $('#pular')]) if (el) el.inert = inerte;
}

function abrirZoom(id) {
  const card = cards.get(id);
  const c = caixas.get(id);
  if (!card || !c?.ip || zoom.animando) return;
  if (zoom.id) fecharZoom({ imediato: true });

  zoom.id = id;
  zoom.comAlerta = false;
  zoom.comDetalhe = false;
  zoom.compacto = estadoTela.get(id) === 'falha';
  atualizarZoomAlerta(); // define se a janela tem a linha do alerta (antes de calcular o tamanho)
  const aspecto = parseFloat(card.style.getPropertyValue('--aspecto')) || ASPECTO_PADRAO;
  const g = geometriaZoom(aspecto);
  const janela = $('#zoomJanela');
  Object.assign(janela.style, {
    left: `${g.left}px`,
    top: `${g.top}px`,
    width: `${g.largura}px`,
    height: `${g.telaH + g.barra}px`,
  });
  janela.style.setProperty('--tela-w', `${g.telaW}px`);
  $('#zoomTitulo').textContent = nomeCaixa(c) + (nomesLojas[c.loja] ? ` · ${nomesLojas[c.loja]}` : '');

  // Prévia: a última imagem da miniatura, para a animação já mostrar o caixa.
  // (a miniatura pode ainda não ter imagem, ex.: cartão recém-criado ao trocar o filtro)
  const origem = card.querySelector('.tela canvas');
  const previa = $('#zoomPrevia');
  const temImagem = Boolean(origem && origem.width && origem.height);
  previa.hidden = !temImagem;
  if (temImagem) {
    previa.width = origem.width;
    previa.height = origem.height;
    try {
      previa.getContext('2d').drawImage(origem, 0, 0);
    } catch {
      previa.hidden = true;
    }
  }

  zoom.id = id;
  zoom.origemFoco = document.activeElement;
  // Enquanto o zoom está aberto, o painel por trás fica inerte: Tab não sai da janela.
  fundoDoZoom(true);
  $('#zoom').hidden = false;
  card.classList.add('ampliado');

  if (movimentoReduzido()) {
    janela.style.transform = 'none';
    $('#zoom').classList.add('aberto');
  } else {
    zoom.animando = true;
    janela.style.transition = 'none';
    janela.style.transform = transformDaMiniatura(card, g);
    janela.getBoundingClientRect(); // aplica a posição inicial antes de animar
    janela.style.transition = `transform ${DURACAO_ZOOM}ms cubic-bezier(.16, 1, .3, 1)`;
    janela.style.transform = 'none';
    $('#zoom').classList.add('aberto');
    setTimeout(() => (zoom.animando = false), DURACAO_ZOOM);
  }
  // Com alerta, o foco começa na ação do alerta (o que se veio fazer); sem alerta, no Fechar.
  ($('#zoomAlerta:not([hidden]) .za-acao') || $('#zoomFechar')).focus({ preventScroll: true });
  conectarZoom(id);
}

// Mensagem grande sobre a tela ampliada (falha), com "Tentar de novo" na barra.
function falhaZoom(texto, podeTentar = true) {
  $('#zoomEstado').textContent = 'Sem controle do caixa';
  $('#zoomMsg').textContent = texto;
  $('#zoomMsg').hidden = false;
  $('#zoomTentar').hidden = !podeTentar;
}

// Ctrl+Alt+Del travado continua no Tab (aria-disabled, como as outras travas): ao clicar, diz o motivo.
const ligarCad = (ligado) => $('#zoomCad').setAttribute('aria-disabled', String(!ligado));

function conectarZoom(id) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const alvo = $('#zoomVnc');
  const c = caixas.get(id);
  const onde = c ? `PDV ${pad3(c.pdv)}` : 'caixa';
  alvo.replaceChildren();
  $('#zoomMsg').hidden = true;
  $('#zoomTentar').hidden = true;
  ligarCad(false);
  $('#zoomEstado').textContent = 'Conectando com controle…';
  const rfb = new NoVNC.default(alvo, `${proto}://${location.host}/vnc/${encodeURIComponent(id)}`, { shared: true });
  rfb.viewOnly = false;
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.focusOnClick = true;
  zoom.rfb = rfb;
  let pediuSenha = false;
  rfb.addEventListener('connect', () => {
    if (zoom.rfb !== rfb) return;
    $('#zoomPrevia').hidden = true;
    $('#zoomEstado').textContent = 'Controlando o caixa: mouse e teclado vão para ele';
    $('#zoom').classList.add('controlando');
    ligarCad(true);
    // Abriu em modo compacto (a miniatura estava falhando) mas conectou: cresce para o normal.
    if (zoom.compacto) {
      zoom.compacto = false;
      posicionarZoom();
    }
    rfb.focus();
  });
  rfb.addEventListener('disconnect', (e) => {
    if (zoom.rfb !== rfb) return;
    zoom.rfb = null;
    $('#zoom').classList.remove('controlando');
    ligarCad(false);
    $('#zoomPrevia').hidden = false;
    if (pediuSenha) return;
    // A mensagem diz o próximo passo: tentar de novo daqui ou ir até o caixa.
    if (e.detail.clean) falhaZoom(`A conexão com o ${onde} foi encerrada. Tente de novo ou vá até o caixa.`);
    else falhaZoom(`Não foi possível controlar o ${onde} agora. Ele pode estar desligado ou fora da rede: vá até o caixa ou tente de novo.`);
  });
  rfb.addEventListener('credentialsrequired', () => {
    pediuSenha = true;
    falhaZoom('O caixa pede a senha VNC e o servidor não tem essa senha. Avise a TI.', false);
    rfb.disconnect();
  });
}
$('#zoomTentar').addEventListener('click', () => {
  if (zoom.id) conectarZoom(zoom.id);
});
// F10 fecha a tela ampliada mesmo com o teclado controlando o caixa (captura antes do noVNC,
// que repassaria a tecla). Esc fecha quando o foco não está na tela do caixa.
addEventListener(
  'keydown',
  (e) => {
    if (!zoom.id) return;
    const naTela = e.target.closest?.('#zoomVnc');
    if (e.key === 'F10' || (e.key === 'Escape' && !naTela)) {
      e.preventDefault();
      e.stopPropagation();
      fecharZoom();
    }
  },
  true,
);

function fecharZoom({ imediato = false } = {}) {
  if (!zoom.id) return;
  const id = zoom.id;
  const card = cards.get(id);
  const rfb = zoom.rfb;
  zoom.rfb = null;
  zoom.id = null;
  try {
    rfb?.disconnect();
  } catch {}
  const janela = $('#zoomJanela');
  const terminar = () => {
    $('#zoom').hidden = true;
    $('#zoomVnc').replaceChildren();
    $('#zoomMsg').hidden = true;
    $('#zoomTentar').hidden = true;
    $('#zoomAlerta').hidden = true;
    $('#zoomAlerta').dataset.html = '';
    restaurarCad();
    zoom.comAlerta = false;
    zoom.comDetalhe = false;
    janela.style.transition = 'none';
    janela.style.transform = 'none';
    card?.classList.remove('ampliado');
    zoom.animando = false;
    fundoDoZoom(false);
    const voltar = card?.querySelector('[data-slot="tela"]') || zoom.origemFoco;
    voltar?.focus?.({ preventScroll: true });
  };
  $('#zoom').classList.remove('aberto', 'controlando');
  if (imediato || movimentoReduzido() || !card) return terminar();

  // Volta encolhendo para o lugar do caixa no mosaico.
  $('#zoomPrevia').hidden = false;
  zoom.animando = true;
  const aspecto = parseFloat(card.style.getPropertyValue('--aspecto')) || ASPECTO_PADRAO;
  janela.style.transition = `transform ${DURACAO_ZOOM - 60}ms cubic-bezier(.4, 0, .2, 1)`;
  janela.style.transform = transformDaMiniatura(card, geometriaZoom(aspecto));
  setTimeout(terminar, DURACAO_ZOOM - 40);
}

$('#zoomFechar').addEventListener('click', () => fecharZoom());
$('#zoomFundo').addEventListener('click', () => fecharZoom());
// Ctrl+Alt+Del pode reiniciar/bloquear o caixa de um cliente: pede confirmação.
// Confirmação no próprio botão (sem a janela do navegador): o 1º clique pede confirmação por
// 5 s, o 2º envia.
let cadTimer = null;
function restaurarCad() {
  clearTimeout(cadTimer);
  cadTimer = null;
  $('#zoomCad').textContent = 'Ctrl+Alt+Del';
  $('#zoomCad').classList.remove('confirmar');
}
$('#zoomCad').addEventListener('click', () => {
  if (!zoom.rfb || $('#zoomCad').getAttribute('aria-disabled') === 'true') {
    return anunciar('Ctrl+Alt+Del só funciona com o controle do caixa ligado.');
  }
  if (!cadTimer) {
    $('#zoomCad').textContent = 'Confirmar Ctrl+Alt+Del?';
    $('#zoomCad').classList.add('confirmar');
    anunciar(`Clique de novo para enviar Ctrl+Alt+Del para o ${$('#zoomTitulo').textContent}.`);
    cadTimer = setTimeout(restaurarCad, 5000);
    return;
  }
  restaurarCad();
  zoom.rfb.sendCtrlAltDel();
  anunciar('Ctrl+Alt+Del enviado.');
});
addEventListener('resize', posicionarZoom);

function atualizarTempos() {
  const t = relogio();
  for (const el of document.querySelectorAll('[data-desde]')) {
    el.textContent = duracao(t - Number(el.dataset.desde));
  }
  for (const el of document.querySelectorAll('[data-ate]')) {
    el.textContent = Math.max(0, Math.ceil((Number(el.dataset.ate) - Date.now()) / 1000));
  }
  if (desconectadoEm) $('#tempoQueda').textContent = duracao(Date.now() - desconectadoEm);
}

// ------------------------------------------------------------------ som
let audio;
// Enquanto houver alerta sem ninguém atendendo, o som se repete a cada 1 minuto.
const REPETIR_SOM_MS = 60 * 1000;
let ultimoSom = 0;
setInterval(() => {
  if (!somLigado || desconectadoEm || Date.now() - ultimoSom < REPETIR_SOM_MS) return;
  const pendentes = [...caixas.values()].filter((c) => c.alerta && !c.alerta.atendidoPor && !liberando.has(c.id));
  if (!pendentes.length) return;
  tocarAlerta(Math.max(...pendentes.map((c) => c.alerta.prioridade || 2)));
}, 5000);

function tocarAlerta(prioridade = 2) {
  if (!somLigado) return;
  ultimoSom = Date.now();
  audio ??= new AudioContext();
  const notas = prioridade >= 3 ? [880, 660, 880] : [740, 990];
  notas.forEach((f, i) => {
    const o = audio.createOscillator();
    const g = audio.createGain();
    const t = audio.currentTime + i * 0.18;
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + 0.17);
  });
}

function atualizarBotaoSom() {
  // O rótulo já diz o estado; sem aria-pressed (o leitor diria "Som desligado, não pressionado").
  const texto = somLigado ? 'Som ligado' : 'Som desligado';
  $('#btnSom .rot').textContent = texto;
  $('#btnSom').title = texto;
  $('#btnSom use').setAttribute('href', somLigado ? '#i-som' : '#i-mudo');
  $('#btnSom').classList.toggle('ligado', somLigado);
}

// Menu lateral recolhível: fica só uma coluna estreita com os números e os ícones, e as telas
// ganham a largura. Lembrado por computador. Ao terminar a animação, as telas se reajustam.
let menuAnimandoAte = 0;
function recolherMenu(recolhido, animar = true) {
  const app = $('#app');
  if (animar) {
    menuAnimandoAte = Date.now() + 450;
    setTimeout(conferirVista, 500);
  }
  if (!animar) app.classList.add('sem-animacao');
  app.classList.toggle('menu-recolhido', recolhido);
  const texto = recolhido ? 'Expandir menu' : 'Recolher menu';
  $('#btnMenu').setAttribute('aria-expanded', String(!recolhido));
  $('#btnMenu').setAttribute('aria-label', texto);
  $('#btnMenu').title = texto;
  if (!animar) {
    void $('#lateral').offsetWidth;
    app.classList.remove('sem-animacao');
  }
  agendarAjuste();
  setTimeout(agendarAjuste, 320);
}
// Sem preferência gravada: em monitor menor que 1600px (ex.: 1366x768) começa recolhida, para as
// telas ganharem a largura; em monitor grande começa aberta.
recolherMenu(lerPref('menuRecolhido', innerWidth < 1600 ? 'sim' : 'nao') === 'sim', false);
$('#btnMenu').addEventListener('click', () => {
  const recolhido = !$('#app').classList.contains('menu-recolhido');
  gravarPref('menuRecolhido', recolhido ? 'sim' : 'nao');
  recolherMenu(recolhido);
});

$('#btnSom').addEventListener('click', () => {
  somLigado = !somLigado;
  gravarPref('som', somLigado ? 'sim' : 'nao');
  atualizarBotaoSom();
  if (somLigado) tocarAlerta(2);
});

iniciar();
