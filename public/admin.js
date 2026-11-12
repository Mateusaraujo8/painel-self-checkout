// Administração do Painel Self-Checkout: saúde dos agentes, cadastro (estacoes.json),
// usuários e registro de ações. Só para perfil admin (o servidor confere em cada chamada).
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pad3 = (n) => String(n).padStart(3, '0');
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

let eu = null;
let resumo = null;

// ------------------------------------------------------------------ utilidades
async function api(url, opcoes = {}) {
  const r = await fetch(url, {
    ...opcoes,
    headers: { 'Content-Type': 'application/json', ...(opcoes.headers || {}) },
    body: opcoes.body && typeof opcoes.body !== 'string' ? JSON.stringify(opcoes.body) : opcoes.body,
  });
  if (r.status === 401) {
    mostrarLogin('Sua sessão terminou. Entre de novo.');
    throw new Error('Sessão encerrada');
  }
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(dados.erro || `Erro ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return dados;
}

function quando(t) {
  if (!t) return '—';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return `há ${Math.max(s, 0)}s`;
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  return `há ${Math.floor(s / 86400)} dias`;
}
const dataHora = (t) =>
  new Date(t).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });

let timerAviso;
function avisar(texto, tipo = 'ok') {
  const el = $('#aviso');
  el.textContent = texto;
  el.className = `aviso-flutuante ${tipo}`;
  el.hidden = false;
  clearTimeout(timerAviso);
  timerAviso = setTimeout(() => (el.hidden = true), tipo === 'erro' ? 8000 : 4000);
}

// O navegador só libera navigator.clipboard em HTTPS ou localhost. O painel roda em
// http://IP:porta, então o normal aqui é cair no método antigo (textarea + execCommand).
function copiarAntigo(texto) {
  const area = document.createElement('textarea');
  area.value = texto;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
  // Dentro de um <dialog> aberto, o textarea precisa estar no diálogo para receber a seleção.
  ($('#dlg').open ? $('#dlg') : document.body).appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {}
  area.remove();
  return ok;
}

async function copiar(texto, botao) {
  let ok = false;
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(texto);
      ok = true;
    } catch {}
  }
  if (!ok) ok = copiarAntigo(texto);
  if (ok) {
    const antes = botao.textContent;
    botao.textContent = 'Copiado';
    setTimeout(() => (botao.textContent = antes), 1500);
    return;
  }
  // Último recurso: deixa o comando selecionado para o Ctrl+C.
  const code = botao.parentElement?.querySelector('code');
  if (code) getSelection().selectAllChildren(code);
  avisar('Não foi possível copiar sozinho. O comando ficou selecionado: use Ctrl+C.', 'erro');
}

/**
 * Diálogo genérico. `montar(corpo)` preenche os campos; `confirmar(form)` valida e salva:
 * devolve uma mensagem de erro (string) para manter aberto, ou nada para fechar.
 */
function dialogo({ titulo, botao = 'Salvar', perigo = false, semCancelar = false, html, montar, confirmar }) {
  const dlg = $('#dlg');
  $('#dlgTitulo').textContent = titulo;
  $('#dlgCorpo').innerHTML = html;
  $('#dlgErro').textContent = '';
  $('#dlgCancelar').hidden = semCancelar;
  const ok = $('#dlgOk');
  ok.textContent = botao;
  ok.className = perigo ? 'perigo' : 'primario';
  return new Promise((fim) => {
    const aoClicar = async (e) => {
      e.preventDefault();
      ok.disabled = true;
      try {
        const erroMsg = await confirmar?.($('#dlgForm'));
        if (erroMsg) {
          $('#dlgErro').textContent = erroMsg;
          return;
        }
        fechar(true);
      } catch (err) {
        $('#dlgErro').textContent = err.message;
      } finally {
        ok.disabled = false;
      }
    };
    const aoCancelar = (e) => {
      e.preventDefault();
      fechar(false);
    };
    const fechar = (resultado) => {
      ok.removeEventListener('click', aoClicar);
      $('#dlgCancelar').removeEventListener('click', aoCancelar);
      dlg.removeEventListener('cancel', aoCancelar);
      dlg.close();
      fim(resultado);
    };
    ok.addEventListener('click', aoClicar);
    $('#dlgCancelar').addEventListener('click', aoCancelar);
    dlg.addEventListener('cancel', aoCancelar);
    // montar recebe uma função para fechar por outro botão (ex.: "Remover loja").
    montar?.($('#dlgCorpo'), () => fechar(true));
    dlg.showModal();
    ($('#dlgCorpo input:not([type=checkbox]):not([readonly]), #dlgCorpo select:not([disabled]), #dlgCorpo textarea') || ok).focus();
  });
}

// Enter num campo do diálogo aciona o botão de confirmar (o único botão submit do formulário);
// o clique dele já cancela o envio, então aqui só garantimos que o form nunca fecha sozinho.
$('#dlgForm').addEventListener('submit', (e) => e.preventDefault());

// ------------------------------------------------------------------ login e abas
function mostrarLogin(msg = '') {
  $('#app').hidden = true;
  $('#telaRestrita').hidden = true;
  $('#telaLogin').hidden = false;
  $('#erroLogin').textContent = msg;
  $('#formLogin [name=usuario]').focus();
}

$('#formLogin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const r = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: f.get('usuario'), senha: f.get('senha') }),
  });
  if (!r.ok) {
    $('#erroLogin').textContent = (await r.json().catch(() => ({}))).erro || 'Não foi possível entrar';
    return;
  }
  e.target.reset();
  iniciar();
});

async function sair() {
  const fim = async () => {
    await fetch('/api/logout', { method: 'POST' });
    location.reload();
  };
  if (!cadastro.temMudancas()) return fim();
  // Mesmo diálogo do resto da página (sem a janela do navegador).
  return dialogo({
    titulo: 'Sair sem salvar o cadastro?',
    botao: 'Sair e descartar',
    perigo: true,
    html: '<p>Há alterações em "Lojas e caixas" que ainda não foram salvas. Se sair agora, elas se perdem.</p>',
    confirmar: fim,
  });
}
$('#btnSair').addEventListener('click', sair);
$('#btnSairRestrito').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.reload();
});

// Menu lateral recolhível: só ícones. A escolha fica guardada neste navegador.
const CHAVE_MENU = 'painelSelf.menuRecolhido';
function recolherMenu(recolhido, animar = true) {
  const app = $('#app');
  if (!animar) app.classList.add('sem-animacao');
  app.classList.toggle('menu-recolhido', recolhido);
  const btn = $('#btnRecolher');
  const texto = recolhido ? 'Expandir menu' : 'Recolher menu';
  btn.setAttribute('aria-expanded', String(!recolhido));
  btn.setAttribute('aria-label', texto);
  btn.title = texto;
  // Recolhido, o nome da seção aparece ao parar o mouse sobre o ícone.
  for (const a of $$('.adm-abas a')) {
    if (recolhido) a.title = a.textContent.trim();
    else a.removeAttribute('title');
  }
  if (!animar) {
    // Aplica o estado já sem transição (forçando o cálculo do layout) e libera a animação.
    // Não usa requestAnimationFrame: em aba de fundo ele não roda e a classe ficaria presa.
    void $('.adm-lateral').offsetWidth;
    app.classList.remove('sem-animacao');
  }
}
let menuRecolhido = false;
try {
  menuRecolhido = localStorage.getItem(CHAVE_MENU) === '1';
} catch {}
recolherMenu(menuRecolhido, false);
$('#btnRecolher').addEventListener('click', () => {
  menuRecolhido = !menuRecolhido;
  recolherMenu(menuRecolhido);
  try {
    localStorage.setItem(CHAVE_MENU, menuRecolhido ? '1' : '0');
  } catch {}
});

const ABAS = ['saude', 'indicadores', 'cadastro', 'usuarios', 'registro'];
let abaAtual = null;
function irPara(aba) {
  if (!ABAS.includes(aba)) aba = 'saude';
  abaAtual = aba;
  for (const a of ABAS) $(`#aba-${a}`).hidden = a !== aba;
  for (const l of $$('.adm-abas a')) {
    if (l.dataset.aba === aba) {
      l.setAttribute('aria-current', 'page');
      // Tela estreita (abas roláveis de lado): a aba atual nunca fica escondida na borda.
      l.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } else l.removeAttribute('aria-current');
  }
  ({ saude: saude.abrir, indicadores: indicadoresAba.abrir, cadastro: cadastro.abrir, usuarios: usuariosAba.abrir, registro: registro.abrir })[aba]();
}
addEventListener('hashchange', () => irPara(location.hash.slice(1)));
addEventListener('beforeunload', (e) => {
  if (cadastro.temMudancas()) e.preventDefault();
});

async function iniciar() {
  // A administração roda numa porta própria: "Abrir o painel" aponta para a porta do painel.
  try {
    const cfg = await (await fetch('/api/config')).json();
    if (cfg.portaPainel) {
      const url = `${location.protocol}//${location.hostname}:${cfg.portaPainel}/`;
      for (const a of $$('a[data-painel]')) a.href = url;
    }
  } catch {}
  const r = await fetch('/api/eu');
  if (r.status === 401) return mostrarLogin();
  eu = await r.json();
  if (eu.perfil !== 'admin') {
    $('#telaLogin').hidden = true;
    $('#restritoQuem').textContent = eu.login;
    $('#telaRestrita').hidden = false;
    return;
  }
  resumo = await api('/api/admin/resumo');
  $('#telaLogin').hidden = true;
  $('#telaRestrita').hidden = true;
  $('#app').hidden = false;
  $('#servidor').textContent = resumo.servidor;
  $('#usuarioLogado').textContent = eu.nome || eu.login;
  $('#btnSair').setAttribute('aria-label', `Sair (${eu.login})`);
  $('#btnSair').title = `Sair (${eu.login})`;
  irPara(location.hash.slice(1));
}

// ================================================================== SAÚDE
const ORDEM_SITUACAO = { sem_contato: 0, desatualizado: 1, nunca: 2, ok: 3, pdv: 4 };

const saude = {
  dados: null,
  filtro: 'problemas',
  loja: '',
  timer: null,
  montado: false,
  abertas: new Set(), // lojas fora do ar com a lista de caixas aberta

  async abrir() {
    if (!saude.montado) saude.montar();
    await saude.carregar();
    clearInterval(saude.timer);
    saude.timer = setInterval(() => abaAtual === 'saude' && !document.hidden && saude.carregar(), 10000);
  },

  montar() {
    saude.montado = true;
    $('#aba-saude').innerHTML = `
      <div class="aba-cab">
        <h2 id="t-saude">Saúde dos agentes</h2>
        <p class="apoio">Atualiza sozinho a cada 10 segundos. <span id="saudeHora"></span></p>
      </div>
      <div class="barra-filtros">
        <div class="segmentos" id="saudeFiltros" role="group" aria-label="Mostrar"></div>
        <select id="saudeMais" class="filtro-mais" aria-label="Mais filtros"></select>
        <label class="campo-inline">Loja <select id="saudeLoja"><option value="">Todas</option></select></label>
      </div>
      <div class="dica-acao" id="saudeDica" hidden></div>
      <div class="tabela-wrap">
        <table class="tabela">
          <thead><tr>
            <th scope="col">Caixa</th><th scope="col">IP</th><th scope="col">Situação</th>
            <th scope="col">Agente</th><th scope="col">Último contato</th><th scope="col">Estação</th><th scope="col">Tela</th>
            <th scope="col"><span class="so-leitor">Ações</span></th>
          </tr></thead>
          <tbody id="saudeLinhas"></tbody>
        </table>
      </div>`;
    $('#saudeFiltros').addEventListener('click', (e) => {
      const b = e.target.closest('[data-filtro]');
      if (!b) return;
      saude.filtro = b.dataset.filtro;
      saude.desenhar();
    });
    $('#saudeLinhas').addEventListener('click', (e) => {
      const g = e.target.closest('[data-grupo]');
      if (g) {
        const l = g.dataset.grupo;
        if (saude.abertas.has(l)) saude.abertas.delete(l);
        else saude.abertas.add(l);
        return saude.desenhar();
      }
      const b = e.target.closest('[data-remover-lista]');
      if (b) saude.remover(b.dataset.removerLista);
    });
    $('#saudeLoja').addEventListener('change', (e) => {
      saude.loja = e.target.value;
      saude.desenhar();
    });
    $('#saudeMais').addEventListener('change', (e) => {
      saude.filtro = e.target.value || 'problemas';
      saude.desenhar();
    });
  },

  async carregar() {
    try {
      saude.dados = await api('/api/admin/saude');
      saude.desenhar();
    } catch (e) {
      if (e.message !== 'Sessão encerrada') $('#saudeHora').textContent = `Não foi possível atualizar: ${e.message}`;
    }
  },

  desenhar() {
    const { caixas } = saude.dados;
    const daLoja = caixas.filter((c) => !saude.loja || String(c.loja) === saude.loja);
    const conta = (f) => daLoja.filter(f).length;
    const comTela = (c) => Boolean(c.telaErro);
    const comFiscal = (c) => Boolean(c.fiscal);
    const filtros = [
      ['problemas', 'Precisam de atenção', conta((c) => (c.situacao !== 'ok' && c.situacao !== 'pdv') || comTela(c) || comFiscal(c))],
      ['fiscal', 'Notas sem autorização', conta(comFiscal)],
      ['sem_contato', 'Sem contato', conta((c) => c.situacao === 'sem_contato')],
      ['desatualizado', 'Desatualizados', conta((c) => c.situacao === 'desatualizado')],
      ['nunca', 'Nunca conectaram', conta((c) => c.situacao === 'nunca')],
      ['tela', 'Tela com erro', conta(comTela)],
      ['todos', 'Todos', daLoja.length],
    ];
    // Poucos botões à vista (os filtros do dia a dia); os raros vão para "Mais filtros".
    // "Notas sem autorização" vira botão (o primeiro depois de "Precisam de atenção") só quando há alguma.
    const n = Object.fromEntries(filtros.map(([v, , qtd]) => [v, qtd]));
    const principais = ['problemas', ...(n.fiscal ? ['fiscal'] : []), 'sem_contato', 'desatualizado', 'todos'];
    const extras = ['nunca', 'tela', ...(n.fiscal ? [] : ['fiscal'])];
    const rotulo = Object.fromEntries(filtros.map(([v, t]) => [v, t]));
    // Botões criados só quando o conjunto muda; a cada leitura só mudam os números (o foco fica).
    const caixaFiltros = $('#saudeFiltros');
    const chave = principais.join(',');
    if (caixaFiltros.dataset.chave !== chave) {
      caixaFiltros.dataset.chave = chave;
      caixaFiltros.innerHTML = principais.map((v) => `<button data-filtro="${v}" aria-pressed="false">${rotulo[v]} <b></b></button>`).join('');
    }
    for (const v of principais) {
      const b = caixaFiltros.querySelector(`[data-filtro="${v}"]`);
      if (b.lastChild.textContent !== String(n[v])) b.lastChild.textContent = n[v];
      b.setAttribute('aria-pressed', String(v === saude.filtro));
    }
    const mais = $('#saudeMais');
    const opcoesMais = `<option value="">Mais filtros</option>${extras.map((v) => `<option value="${v}">${rotulo[v]} (${n[v]})</option>`).join('')}`;
    if (mais.dataset.html !== opcoesMais) {
      mais.dataset.html = opcoesMais;
      mais.innerHTML = opcoesMais;
    }
    mais.value = extras.includes(saude.filtro) ? saude.filtro : '';
    mais.classList.toggle('ativo', extras.includes(saude.filtro));

    const lojas = [...new Map(caixas.map((c) => [c.loja, c.nomeLoja])).entries()].sort((a, b) => a[0] - b[0]);
    const sel = $('#saudeLoja');
    const opcoes = `<option value="">Todas</option>${lojas.map(([l, n]) => `<option value="${l}">${pad3(l)}${n ? ` · ${esc(n)}` : ''}</option>`).join('')}`;
    if (sel.dataset.html !== opcoes) {
      sel.innerHTML = opcoes;
      sel.dataset.html = opcoes;
    }
    sel.value = saude.loja;

    const passa = {
      problemas: (c) => (c.situacao !== 'ok' && c.situacao !== 'pdv') || comTela(c) || comFiscal(c),
      fiscal: comFiscal,
      sem_contato: (c) => c.situacao === 'sem_contato',
      desatualizado: (c) => c.situacao === 'desatualizado',
      nunca: (c) => c.situacao === 'nunca',
      tela: comTela,
      todos: () => true,
    }[saude.filtro];
    // Nota fiscal sem autorização vem primeiro: é venda acontecendo sem documento fiscal válido.
    const lista = daLoja
      .filter(passa)
      .sort(
        (a, b) =>
          comFiscal(b) - comFiscal(a) || ORDEM_SITUACAO[a.situacao] - ORDEM_SITUACAO[b.situacao] || a.loja - b.loja || a.pdv - b.pdv,
      );

    $('#saudeHora').textContent = `Última leitura: ${new Date(saude.dados.agora).toLocaleTimeString('pt-BR')}.`;

    // Comando pronto para atualizar os desatualizados que estão na tela.
    const dica = $('#saudeDica');
    const desat = lista.filter((c) => c.situacao === 'desatualizado');
    if (desat.length && (saude.filtro === 'desatualizado' || saude.filtro === 'problemas')) {
      const cmd = `powershell -ExecutionPolicy Bypass -File agent\\linux\\instalar-todos.ps1 -Ips ${desat.map((c) => c.ip).join(',')}`;
      dica.innerHTML = `<p>Para atualizar ${desat.length === 1 ? 'este agente' : `estes ${desat.length} agentes`}, rode na pasta do projeto (o caixa continua vendendo):</p>
        <div class="comando"><code>${esc(cmd)}</code><button data-copiar>Copiar</button></div>`;
      $('[data-copiar]', dica).onclick = (e) => copiar(cmd, e.target);
      dica.hidden = false;
    } else dica.hidden = true;

    const vazio = {
      problemas: 'Nenhum caixa precisando de atenção. Todos os agentes estão funcionando e atualizados.',
      todos: 'Nenhum caixa cadastrado ainda. Cadastre em "Lojas e caixas".',
    }[saude.filtro] || 'Nenhum caixa nesta situação.';

    // Loja inteira sem contato (3+ caixas, todos sem contato): vira uma linha de resumo no alto,
    // com o diagnóstico provável, em vez de dezenas de linhas iguais. Abre para ver os caixas.
    const grupos = [];
    const agrupar = saude.filtro === 'problemas' || saude.filtro === 'sem_contato' || saude.filtro === 'todos';
    if (agrupar) {
      // Só os selfs: PDV normal sem agente não diz nada sobre a rede da loja.
      for (const [l, daquela] of Map.groupBy(daLoja.filter((c) => c.cadastrado && c.tipo !== 'pdv'), (c) => c.loja)) {
        // Todos sem contato (os que nunca conectaram também contam: a loja está toda fora).
        if (daquela.length >= 3 && daquela.some((c) => c.situacao === 'sem_contato') && daquela.every((c) => c.situacao === 'sem_contato' || c.situacao === 'nunca')) {
          grupos.push({ loja: l, caixas: daquela });
        }
      }
    }
    const agrupados = new Set(grupos.flatMap((g) => g.caixas.map((c) => c.id)));
    const linhas = [
      ...grupos.flatMap((g) => [saude.linhaGrupo(g), ...(saude.abertas.has(String(g.loja)) ? g.caixas.map(saude.linha) : [])]),
      ...lista.filter((c) => !agrupados.has(c.id)).map(saude.linha),
    ];
    const html = linhas.length ? linhas.join('') : `<tr><td colspan="8" class="vazio-tabela">${vazio}</td></tr>`;
    // Só redesenha a tabela quando algo mudou (a cada 10 s quase sempre é igual).
    const corpo = $('#saudeLinhas');
    if (corpo.dataset.html !== html) {
      const ativo = document.activeElement;
      const voltar = corpo.contains(ativo) ? (ativo.dataset.grupo && `[data-grupo="${ativo.dataset.grupo}"]`) || (ativo.dataset.removerLista && `[data-remover-lista="${ativo.dataset.removerLista}"]`) : null;
      corpo.dataset.html = html;
      corpo.innerHTML = html;
      if (voltar) corpo.querySelector(voltar)?.focus();
    }
  },

  // Uma situação principal por linha: o pior problema do caixa, com os outros embaixo.
  // Assim a TI lê o porquê numa coluna só (não monta a resposta com 3 colunas de cores).
  situacaoPrincipal(c) {
    const problemas = [];
    if (c.fiscal) {
      const hora = new Date(c.fiscal.desde).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      problemas.push(
        c.fiscal.travado
          ? [
              'sit-critico',
              'Envio de NFC-e travado',
              `desde ${hora} · ${c.fiscal.pendentes} ${c.fiscal.pendentes === 1 ? 'venda' : 'vendas'} sem nota · ${c.fiscal.erros} ${c.fiscal.erros === 1 ? 'erro' : 'erros'} de envio à SEFAZ. Provável corte na conexão (rota/link da loja); o AcruxPDV só volta a enviar sozinho depois de um tempo.`,
            ]
          : ['sit-critico', 'Notas sem autorização', `${c.fiscal.pendentes} ${c.fiscal.pendentes === 1 ? 'nota' : 'notas'} desde ${hora}`],
      );
    }
    if (c.situacao === 'sem_contato') problemas.push(['sit-critico', 'Sem contato', '']);
    if (c.telaErro) problemas.push(['sit-critico', 'Tela com erro', c.telaErro]);
    if (c.situacao === 'desatualizado') problemas.push(['sit-alerta', 'Agente desatualizado', '']);
    if (c.taraModo !== 'desligado' && c.versao && !c.taraSuportada) {
      problemas.push(['sit-alerta', 'Tara automática sem efeito', 'ligada, mas o agente deste caixa é anterior à 1.10: atualize']);
    }
    if (c.taraAuto?.ok === false && saude.dados.agora - c.taraAuto.em < 2 * 3600e3) {
      problemas.push(['sit-alerta', 'Tara automática não feita', `${c.taraAuto.motivo} (${quando(c.taraAuto.em)})`]);
    }
    if (!c.estacoes.length && c.tipo !== 'pdv') problemas.push(['sit-alerta', 'Fora de estação', 'nenhum fiscal vê este caixa']);
    if (c.situacao === 'nunca') problemas.push(['sit-neutro', 'Nunca conectou', '']);
    if (!problemas.length) problemas.push(c.situacao === 'pdv' ? ['sit-neutro', 'PDV normal', 'sem agente (só a tela)'] : ['sit-ok', 'Funcionando', '']);
    const [[classe, rotulo, det], ...outros] = problemas;
    return `<span class="sit ${classe}">${rotulo}</span>${det ? `<span class="apoio bloco">${esc(det)}</span>` : ''}${
      outros.length ? `<span class="apoio bloco">Também: ${outros.map((o) => o[1].toLowerCase()).join(', ')}</span>` : ''
    }${c.alerta ? `<span class="apoio bloco">Alerta: ${esc(c.alerta)}</span>` : ''}`;
  },

  linhaGrupo(g) {
    const n = g.caixas.length;
    const semContato = g.caixas.filter((c) => c.situacao === 'sem_contato').length;
    const ultimo = Math.max(...g.caixas.map((c) => c.ultimoContato || 0));
    const aberta = saude.abertas.has(String(g.loja));
    const nome = g.caixas[0].nomeLoja;
    return `<tr class="linha-grupo">
      <th scope="row"><span class="caixa-id">Loja ${pad3(g.loja)}</span>${nome ? `<span class="apoio bloco">${esc(nome)}</span>` : ''}</th>
      <td colspan="6"><span class="sit sit-critico">Loja inteira sem contato</span>
        <span class="apoio bloco" title="${ultimo ? `Último contato: ${dataHora(ultimo)}` : ''}">${semContato} de ${n} caixas sem contato${n > semContato ? ` (${n - semContato} nunca conectaram)` : ''}${ultimo ? `, o último ${quando(ultimo)}` : ''}. Provável queda de rede, energia ou do link da loja (não é problema de cada caixa).</span></td>
      <td class="acoes-linha"><button class="texto" data-grupo="${g.loja}" aria-expanded="${aberta}">${aberta ? 'Esconder caixas' : `Ver os ${n} caixas`}</button></td>
    </tr>`;
  },

  linha(c) {
    let agente = !c.versao
      ? '<span class="apoio">sem agente</span>'
      : c.situacao === 'desatualizado'
        ? `${esc(c.versao)} <span class="apoio">→ ${esc(c.versaoAtual)}</span>`
        : esc(c.versao);
    // Tara automática ligada: o modo e a última tentativa, embaixo da versão.
    if (c.taraModo && c.taraModo !== 'desligado') {
      const t = c.taraAuto;
      const ultima = !t ? 'ainda não tarou' : t.ok === null ? 'tarando agora' : `${t.ok ? 'última feita' : 'última não feita'} ${quando(t.em)}`;
      agente += `<span class="apoio bloco">tara automática: ${c.taraModo === 'sempre' ? 'toda venda' : 'quando precisar'} · ${ultima}</span>`;
    }
    return `<tr>
      <th scope="row"><span class="caixa-id">Loja ${pad3(c.loja)} · PDV ${pad3(c.pdv)}</span>${c.nomeLoja ? `<span class="apoio bloco">${esc(c.nomeLoja)}</span>` : ''}</th>
      <td class="mono">${esc(c.ip)}</td>
      <td>${saude.situacaoPrincipal(c)}</td>
      <td>${agente}</td>
      <td title="${c.ultimoContato ? dataHora(c.ultimoContato) : ''}">${c.situacao === 'nunca' ? '—' : c.online ? 'agora' : quando(c.ultimoContato)}</td>
      <td>${c.estacoes.length ? esc(c.estacoes.join(', ')) : '<span class="apoio">nenhuma</span>'}</td>
      <td>${c.telaErro ? '<span class="apoio">com erro</span>' : '<span class="apoio">ok</span>'}</td>
      <td class="acoes-linha">${!c.cadastrado && !c.online ? `<button class="texto perigo-texto" data-remover-lista="${c.id}">Remover da lista</button>` : ''}</td>
    </tr>`;
  },

  // Caixa que não está no cadastro e está sem contato (ex.: agente desinstalado): some do painel.
  remover(id) {
    const c = saude.dados.caixas.find((x) => x.id === id);
    return dialogo({
      titulo: `Remover Loja ${pad3(c.loja)} · PDV ${pad3(c.pdv)} da lista?`,
      botao: 'Remover da lista',
      perigo: true,
      html: `<p>Este caixa (${esc(c.ip)}) não está no cadastro e está sem contato. Ele sai do painel e desta lista.</p>
        <p class="apoio">Se o agente dele voltar a mandar dados, ele reaparece sozinho.</p>`,
      async confirmar() {
        await api(`/api/caixas/${encodeURIComponent(id)}`, { method: 'DELETE' });
        avisar('Caixa removido da lista.');
        await saude.carregar();
      },
    });
  },
};

// ================================================================== INDICADORES
// Gráficos simples em HTML/CSS (sem biblioteca): barras de uma cor só por gráfico, com o valor
// na ponta, dica no foco/hover e os números também em tabela. Âmbar = alertas, azul = vendas
// (o mesmo significado do painel, um tom abaixo para o fundo escuro; validados para daltonismo).
const moeda = (v) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const inteiro = (v) => (Number(v) || 0).toLocaleString('pt-BR');
function tempo(s) {
  if (s == null) return '—';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}min${s % 60 ? ` ${String(s % 60).padStart(2, '0')}s` : ''}`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}
const diaCurto = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

// Lista (não objeto): chaves numéricas num objeto iriam para a frente de "Hoje".
const PERIODOS = [
  ['hoje', 'Hoje'],
  ['ontem', 'Ontem'],
  ['7', 'Últimos 7 dias'],
  ['30', 'Últimos 30 dias'],
];
function intervalo(chave) {
  const inicioDoDia = (offset) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - offset);
    return d.getTime();
  };
  if (chave === 'hoje') return { de: inicioDoDia(0), ate: Date.now() };
  if (chave === 'ontem') return { de: inicioDoDia(1), ate: inicioDoDia(0) - 1 };
  return { de: inicioDoDia(Number(chave) - 1), ate: Date.now() };
}

const indicadoresAba = {
  montado: false,
  periodo: 'hoje',
  loja: '',
  dados: null,
  timer: null,
  todasCaixas: false,

  async abrir() {
    if (!indicadoresAba.montado) indicadoresAba.montar();
    await indicadoresAba.carregar();
    clearInterval(indicadoresAba.timer);
    // "Hoje" muda ao longo do dia: atualiza sozinho a cada minuto enquanto a aba está aberta.
    indicadoresAba.timer = setInterval(() => {
      if (abaAtual === 'indicadores' && !document.hidden && indicadoresAba.periodo === 'hoje') indicadoresAba.carregar();
    }, 60_000);
  },

  montar() {
    indicadoresAba.montado = true;
    $('#aba-indicadores').innerHTML = `
      <div class="aba-cab">
        <h2 id="t-indicadores">Indicadores</h2>
        <p class="apoio" id="indDesde"></p>
      </div>
      <div class="barra-filtros">
        <div class="segmentos" id="indPeriodo" role="group" aria-label="Período">
          ${PERIODOS.map(([k, t]) => `<button data-periodo="${k}" aria-pressed="${k === 'hoje'}">${t}</button>`).join('')}
        </div>
        <div class="segmentos" id="indTipo" role="group" aria-label="Tipo de caixa" hidden>
          <button data-ind-tipo="self" aria-pressed="true">Self-checkout</button>
          <button data-ind-tipo="pdv" aria-pressed="false">PDV normal</button>
          <button data-ind-tipo="todos" aria-pressed="false">Todos</button>
        </div>
        <label class="campo-inline">Loja <select id="indLoja"><option value="">Todas</option></select></label>
      </div>
      <div id="indConteudo" class="ind-conteudo"></div>`;
    $('#indTipo').addEventListener('click', (e) => {
      const b = e.target.closest('[data-ind-tipo]');
      if (!b) return;
      indicadoresAba.tipo = b.dataset.indTipo;
      for (const x of $$('[data-ind-tipo]')) x.setAttribute('aria-pressed', String(x === b));
      indicadoresAba.loja = '';
      $('#indLoja').dataset.html = '';
      indicadoresAba.carregar();
    });
    $('#indPeriodo').addEventListener('click', (e) => {
      const b = e.target.closest('[data-periodo]');
      if (!b) return;
      indicadoresAba.periodo = b.dataset.periodo;
      for (const x of $$('[data-periodo]')) x.setAttribute('aria-pressed', String(x === b));
      indicadoresAba.carregar();
    });
    $('#indLoja').addEventListener('change', (e) => {
      indicadoresAba.loja = e.target.value;
      indicadoresAba.carregar();
    });
    $('#indConteudo').addEventListener('click', (e) => {
      if (e.target.closest('[data-recarregar-ind]')) return indicadoresAba.carregar();
      if (e.target.closest('[data-todas-caixas]')) {
        indicadoresAba.todasCaixas = !indicadoresAba.todasCaixas;
        indicadoresAba.desenhar();
      }
    });
    // Dica dos gráficos: no hover e no foco do teclado (o mesmo valor também está na tabela).
    const dica = $('#dicaGrafico');
    const mostrar = (alvo) => {
      const r = alvo.getBoundingClientRect();
      dica.replaceChildren();
      const forte = document.createElement('strong');
      forte.textContent = alvo.dataset.valor;
      const nome = document.createElement('span');
      nome.textContent = alvo.dataset.rotulo;
      dica.append(forte, nome);
      dica.hidden = false;
      const d = dica.getBoundingClientRect();
      dica.style.left = `${Math.min(Math.max(8, r.left + r.width / 2 - d.width / 2), innerWidth - d.width - 8)}px`;
      dica.style.top = `${Math.max(8, r.top - d.height - 8)}px`;
    };
    const esconder = () => (dica.hidden = true);
    $('#indConteudo').addEventListener('pointerover', (e) => {
      const alvo = e.target.closest('[data-valor]');
      if (alvo) mostrar(alvo);
    });
    $('#indConteudo').addEventListener('pointerout', (e) => {
      if (e.target.closest('[data-valor]')) esconder();
    });
    $('#indConteudo').addEventListener('focusin', (e) => {
      const alvo = e.target.closest('[data-valor]');
      if (alvo) mostrar(alvo);
    });
    $('#indConteudo').addEventListener('focusout', esconder);
    // Gráfico por hora: uma parada só no Tab; as setas andam entre as horas.
    $('#indConteudo').addEventListener('keydown', (e) => {
      const atual = e.target.closest('.coluna');
      if (!atual || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      const todas = [...atual.parentElement.querySelectorAll('.coluna')];
      const i = todas.indexOf(atual);
      const alvo = { ArrowLeft: todas[i - 1], ArrowRight: todas[i + 1], Home: todas[0], End: todas.at(-1) }[e.key];
      if (!alvo) return;
      e.preventDefault();
      atual.tabIndex = -1;
      alvo.tabIndex = 0;
      alvo.focus();
    });
    // Ao rolar: se a dica é do item com foco (teclado), acompanha; se era do mouse, some.
    addEventListener(
      'scroll',
      () => {
        if (abaAtual !== 'indicadores' || dica.hidden) return; // nada a fazer nas outras abas
        const focado = document.activeElement?.closest?.('#indConteudo [data-valor]');
        if (focado) mostrar(focado);
        else esconder();
      },
      { passive: true },
    );
  },

  async carregar() {
    const { de, ate } = intervalo(indicadoresAba.periodo);
    const qs = new URLSearchParams({ de, ate, tipo: indicadoresAba.tipo || 'self', ...(indicadoresAba.loja ? { loja: indicadoresAba.loja } : {}) });
    const conteudo = $('#indConteudo');
    conteudo.classList.add('carregando'); // mantém o desenho anterior esmaecido, sem pular
    try {
      const novos = await api(`/api/admin/indicadores?${qs}`);
      // Atualização automática sem mudança nos números: não redesenha (foco e dica ficam).
      $('#indTipo').hidden = !novos.temPdvNormal;
      const assinatura = JSON.stringify({ ...novos, periodo: indicadoresAba.periodo, loja: indicadoresAba.loja });
      const mudou = assinatura !== indicadoresAba.assinatura || !$('#indConteudo').children.length;
      indicadoresAba.dados = novos;
      indicadoresAba.assinatura = assinatura;
      if (mudou) indicadoresAba.desenhar();
    } catch (e) {
      if (e.message !== 'Sessão encerrada') {
        indicadoresAba.assinatura = null;
        conteudo.innerHTML = `<div class="vazio-tabela"><p>Não foi possível calcular os indicadores: ${esc(e.message)}</p><button data-recarregar-ind>Tentar de novo</button></div>`;
      }
    } finally {
      conteudo.classList.remove('carregando');
    }
  },

  desenhar() {
    const d = indicadoresAba.dados;
    const a = d.alertas;
    const umDia = indicadoresAba.periodo === 'hoje' || indicadoresAba.periodo === 'ontem';

    // Lojas no filtro (do cadastro, via resultado "Todas").
    const sel = $('#indLoja');
    if (!indicadoresAba.loja) {
      const ops = `<option value="">Todas</option>${d.porLoja.map((l) => `<option value="${l.loja}">${pad3(l.loja)}${l.nome ? ` · ${esc(l.nome)}` : ''}</option>`).join('')}`;
      if (sel.dataset.html !== ops) {
        sel.innerHTML = ops;
        sel.dataset.html = ops;
      }
    }
    sel.value = indicadoresAba.loja;

    const desde = [];
    if (d.desde.alertas) desde.push(`alertas registrados desde ${dataHora(d.desde.alertas).slice(0, 17)}`);
    if (d.desde.vendas) desde.push(`vendas guardadas desde ${diaCurto(d.desde.vendas)}`);
    $('#indDesde').textContent = desde.length
      ? `Os números cobrem só o que o painel registrou: ${desde.join(' e ')}. Caixas de teste ficam de fora.`
      : 'Ainda não há registros.';

    // ---- números principais
    const blocos = [
      { rotulo: 'Alertas', valor: inteiro(a.total), sub: a.total ? `${a.percentRapidos ?? 0}% sumiram em menos de 15s` : 'nenhum no período' },
      { rotulo: 'Espera do cliente (mediana)', valor: tempo(a.espera.mediana), sub: 'metade dos alertas resolvida até aqui' },
      { rotulo: '9 em cada 10 resolvidos em até', valor: tempo(a.espera.p90), sub: a.espera.maxima != null ? `maior espera: ${tempo(a.espera.maxima)}` : '' },
      {
        rotulo: 'Atendidos pelo painel',
        valor: a.total ? `${a.percentPeloPainel}%` : '—',
        sub:
          a.ateAtenderMediana != null
            ? `clicaram Atender em ${tempo(a.ateAtenderMediana)} (mediana)`
            : a.total
              ? 'ninguém usou Atender ou Liberar no painel; os alertas foram resolvidos no próprio caixa'
              : 'Atender ou Liberar no painel',
      },
      { rotulo: 'Vendas', valor: inteiro(d.vendas.total), sub: moeda(d.vendas.valor) },
      { rotulo: 'Ticket médio', valor: d.vendas.ticketMedio != null ? moeda(d.vendas.ticketMedio) : '—', sub: 'caixas que informam o valor' },
    ];
    const ct = d.contingencia;
    const porcento = (p) => (p == null ? '—' : `${p.toLocaleString('pt-BR')}%`);
    // Acima deste % das vendas em contingência, o caixa (ou a loja) merece verificação na hora.
    const LIMITE_CONTINGENCIA = 20;
    const acimaDoLimite = ct ? d.porCaixa.filter((c) => (c.percentContingencia || 0) >= LIMITE_CONTINGENCIA) : [];
    if (ct) {
      blocos.push({
        rotulo: 'Notas em contingência',
        valor: inteiro(ct.total),
        sub: !ct.total
          ? 'todas autorizadas no caixa'
          : `${porcento(ct.percent)} das vendas · ${moeda(ct.valor)}${acimaDoLimite.length ? ` · <span class="sit sit-critico">${acimaDoLimite.length} ${acimaDoLimite.length === 1 ? 'caixa' : 'caixas'} acima de ${LIMITE_CONTINGENCIA}%</span>` : ''}`,
      });
    }
    const htmlNumeros = `<div class="ind-numeros">${blocos
      .map((b) => `<div class="ind-numero"><span class="ind-rotulo">${b.rotulo}</span><span class="ind-valor">${b.valor}</span><span class="ind-sub">${b.sub}</span></div>`)
      .join('')}</div>`;

    // ---- alertas por hora (colunas)
    const horas = a.porHora;
    const comDado = horas.filter((h) => h.n > 0).map((h) => h.hora);
    const hIni = comDado.length ? Math.min(6, ...comDado) : 6;
    const hFim = comDado.length ? Math.max(22, ...comDado) : 22;
    const faixa = horas.filter((h) => h.hora >= hIni && h.hora <= hFim);
    const maxHora = Math.max(1, ...faixa.map((h) => h.n));
    const topoEixo = escalaBonita(Math.max(2, maxHora)); // mínimo 2: o meio do eixo é inteiro
    const pico = faixa.reduce((m, h) => (h.n > m.n ? h : m), { n: -1 });
    const htmlHoras = `
      <section class="ind-cartao ind-largo">
        <h3>Alertas por hora do dia</h3>
        <p class="ind-legenda">${a.total ? `Pico às ${String(pico.hora).padStart(2, '0')}h, com ${pico.n} ${pico.n === 1 ? 'alerta' : 'alertas'}${umDia ? '' : ' somando os dias do período'}.` : 'Sem alertas no período.'}</p>
        <div class="colunas" style="--max:${topoEixo}">
          <div class="colunas-eixo" aria-hidden="true">${[topoEixo, topoEixo / 2, 0].map((v) => `<span>${inteiro(v)}</span>`).join('')}</div>
          <div class="colunas-area" role="group" aria-label="Alertas por hora; use as setas para andar entre as horas">
            ${faixa
              .map(
                (h, i) => `<div class="coluna" tabindex="${i === 0 ? 0 : -1}" data-valor="${h.n} ${h.n === 1 ? 'alerta' : 'alertas'}" data-rotulo="${String(h.hora).padStart(2, '0')}h às ${String(h.hora).padStart(2, '0')}h59"
                  aria-label="${String(h.hora).padStart(2, '0')} horas: ${h.n} alertas">
                  <div class="coluna-barra ambar" style="height:${(h.n / topoEixo) * 100}%"></div>
                  ${h.hora === pico.hora && h.n ? `<span class="coluna-pico" style="bottom:${(h.n / topoEixo) * 100}%">${h.n}</span>` : ''}
                  <span class="coluna-rotulo">${String(h.hora).padStart(2, '0')}</span>
                </div>`,
              )
              .join('')}
          </div>
        </div>
      </section>`;

    // ---- alertas por tipo (tabela com barras)
    const maxTipo = Math.max(1, ...a.porTipo.map((t) => t.n));
    const htmlTipos = `
      <section class="ind-cartao">
        <h3>Alertas por motivo</h3>
        <p class="ind-legenda">Quantos e quanto o cliente esperou até resolver. "Self chamou o fiscal" só aparece quando o aviso do Acrux ao monitor do fiscal falha; onde o monitor do Acrux recebe normalmente, esse número fica abaixo do real. Compare lojas por esse motivo com cuidado.</p>
        ${
          a.porTipo.length
            ? `<table class="tab-barras"><thead><tr><th scope="col">Motivo</th><th scope="col"><span class="so-leitor">Proporção</span></th><th scope="col" class="num">Alertas</th><th scope="col" class="num">Espera (mediana)</th><th scope="col" class="num">9 em 10 até</th></tr></thead><tbody>
              ${a.porTipo
                .map(
                  (t) => `<tr><th scope="row">${esc(t.rotulo)}</th>
                  <td class="barra-celula"><div class="barra ambar" style="width:${(t.n / maxTipo) * 100}%"></div></td>
                  <td class="num">${inteiro(t.n)}</td><td class="num">${tempo(t.mediana)}</td><td class="num">${tempo(t.p90)}</td></tr>`,
                )
                .join('')}</tbody></table>`
            : '<p class="vazio-tabela">Sem alertas no período.</p>'
        }
      </section>`;

    // ---- por loja
    const htmlLojas = `
      <section class="ind-cartao">
        <h3>Por loja</h3>
        <p class="ind-legenda">Alertas para cada 100 vendas ajuda a comparar lojas de movimento diferente.</p>
        ${
          d.porLoja.length
            ? `<table class="tab-barras"><thead><tr><th scope="col">Loja</th><th scope="col" class="num">Alertas</th><th scope="col" class="num">Espera</th><th scope="col" class="num">Vendas</th><th scope="col" class="num">Faturamento</th><th scope="col" class="num">Alertas / 100 vendas</th></tr></thead><tbody>
              ${d.porLoja
                .map(
                  (l) => `<tr><th scope="row">${pad3(l.loja)}${l.nome ? ` · ${esc(l.nome)}` : ''}</th>
                  <td class="num">${inteiro(l.alertas)}</td><td class="num">${tempo(l.esperaMediana)}</td>
                  <td class="num">${inteiro(l.vendas)}</td><td class="num">${l.total ? moeda(l.total) : '—'}</td>
                  <td class="num">${l.vendas ? (Math.round((l.alertas / l.vendas) * 1000) / 10).toLocaleString('pt-BR') : '—'}</td></tr>`,
                )
                .join('')}</tbody></table>`
            : '<p class="vazio-tabela">Sem dados no período.</p>'
        }
      </section>`;

    // ---- vendas e alertas por caixa
    const caixas = [...d.porCaixa].sort((x, y) => y.vendas - x.vendas || y.alertas - x.alertas);
    const mostrar = indicadoresAba.todasCaixas ? caixas : caixas.slice(0, 12);
    const maxVendas = Math.max(1, ...caixas.map((c) => c.vendas));
    const htmlCaixas = `
      <section class="ind-cartao ind-largo">
        <h3>Vendas e alertas por caixa</h3>
        <p class="ind-legenda">Ordenado por vendas. Caixa com muitos alertas para poucas vendas merece uma olhada (balança, leitor, impressora).</p>
        ${
          caixas.length
            ? `<table class="tab-barras"><thead><tr><th scope="col">Caixa</th><th scope="col"><span class="so-leitor">Proporção de vendas</span></th><th scope="col" class="num">Vendas</th><th scope="col" class="num">Faturamento</th><th scope="col" class="num">Alertas</th><th scope="col" class="num">Espera</th><th scope="col" class="num">Alertas / 100 vendas</th></tr></thead><tbody>
              ${mostrar
                .map(
                  (c) => `<tr><th scope="row"><span class="caixa-id">Loja ${pad3(c.loja)} · PDV ${pad3(c.pdv)}</span></th>
                  <td class="barra-celula"><div class="barra azul" style="width:${(c.vendas / maxVendas) * 100}%"></div></td>
                  <td class="num">${inteiro(c.vendas)}</td><td class="num">${c.semValor ? '<span class="apoio" title="Este caixa não informa o valor das vendas">sem valor</span>' : c.total ? moeda(c.total) : '—'}</td>
                  <td class="num">${inteiro(c.alertas)}</td><td class="num">${tempo(c.esperaMediana)}</td>
                  <td class="num">${c.alertasPor100Vendas != null ? c.alertasPor100Vendas.toLocaleString('pt-BR') : '—'}</td></tr>`,
                )
                .join('')}</tbody></table>
              ${caixas.length > 12 ? `<div class="mais-registro"><button data-todas-caixas>${indicadoresAba.todasCaixas ? 'Mostrar só os 12 primeiros' : `Mostrar todos os ${caixas.length} caixas`}</button></div>` : ''}`
            : '<p class="vazio-tabela">Sem dados no período.</p>'
        }
      </section>`;

    // ---- por dia (períodos de vários dias)
    const colCont = Boolean(ct);
    const htmlDias =
      !umDia && d.porDia.length
        ? `<section class="ind-cartao">
            <h3>Dia a dia</h3>
            <p class="ind-legenda">Dias sem registro (painel desligado) não aparecem.${colCont ? ' Contingência: notas não autorizadas no caixa, fora das vendas.' : ''}</p>
            <table class="tab-barras"><thead><tr><th scope="col">Dia</th><th scope="col" class="num">Alertas</th><th scope="col" class="num">Vendas</th><th scope="col" class="num">Faturamento</th>${colCont ? '<th scope="col" class="num">Contingência</th>' : ''}</tr></thead><tbody>
            ${d.porDia
              .map(
                (x) => `<tr><th scope="row">${diaCurto(x.dia)}</th><td class="num">${inteiro(x.alertas)}</td><td class="num">${inteiro(x.vendas)}</td><td class="num">${x.total ? moeda(x.total) : '—'}</td>${
                  colCont ? `<td class="num">${x.contingencia == null ? '—' : `${inteiro(x.contingencia)}${x.contingencia ? ` <span class="apoio">(${porcento(x.percentContingencia)})</span>` : ''}`}</td>` : ''
                }</tr>`,
              )
              .join('')}
            </tbody></table>
          </section>`
        : '';

    // ---- notas em contingência (não autorizadas no caixa)
    let htmlCont = '';
    if (ct) {
      const lojasC = d.porLoja.filter((l) => l.contingencia > 0).sort((x, y) => y.percentContingencia - x.percentContingencia);
      const caixasC = d.porCaixa.filter((c) => c.contingencia > 0).sort((x, y) => y.percentContingencia - x.percentContingencia || y.contingencia - x.contingencia);
      const maxPct = Math.max(1, ...caixasC.map((c) => c.percentContingencia || 0), ...lojasC.map((l) => l.percentContingencia || 0));
      // Barra neutra; vermelha só acima do limite (aí o texto também diz "verificar").
      const linhaPct = (rotulo, x) => {
        const alto = (x.percentContingencia || 0) >= LIMITE_CONTINGENCIA;
        return `<tr${alto ? ' class="linha-alta"' : ''}><th scope="row">${rotulo}</th>
          <td class="barra-celula"><div class="barra ${alto ? 'critica' : 'neutra'}" style="width:${((x.percentContingencia || 0) / maxPct) * 100}%"></div></td>
          <td class="num">${porcento(x.percentContingencia)}${alto ? ' <span class="sit sit-critico">verificar</span>' : ''}</td><td class="num">${inteiro(x.contingencia)}</td><td class="num">${moeda(x.valorContingencia)}</td></tr>`;
      };
      const cab = (primeira) => `<thead><tr><th scope="col">${primeira}</th><th scope="col"><span class="so-leitor">Proporção</span></th><th scope="col" class="num">% das vendas</th><th scope="col" class="num">Notas</th><th scope="col" class="num">Valor</th></tr></thead>`;
      const parcial = ct.caixasInformando < d.porCaixa.filter((c) => c.vendas > 0).length;
      const piores = acimaDoLimite.sort((x, y) => y.percentContingencia - x.percentContingencia).slice(0, 3);
      htmlCont = `
        <section class="ind-cartao ind-largo">
          <h3>Notas em contingência</h3>
          <p class="ind-legenda">Vendas concluídas cuja NFC-e não foi autorizada no caixa. Ficam fora de "Vendas" e do faturamento.</p>
          <details class="saiba-mais">
            <summary>Saiba mais</summary>
            <p>São notas sem número e sem retorno da SEFAZ. O % compara com as vendas autorizadas dos mesmos caixas e dias. É diferente do aviso "notas sem autorização" do painel e da Saúde, que mostra só as notas paradas agora, com erro de envio.${
              parcial ? ' Alguns caixas ainda usam o agente antigo e não informam contingência.' : ''
            }${ct.desde ? ` Dados desde ${diaCurto(ct.desde)}.` : ''}</p>
          </details>
          ${
            piores.length
              ? `<p class="cont-atencao"><span class="sit sit-critico">Acima de ${LIMITE_CONTINGENCIA}% das vendas:</span> ${piores
                  .map((c) => `Loja ${pad3(c.loja)} · PDV ${pad3(c.pdv)} (${porcento(c.percentContingencia)})`)
                  .join(', ')}${acimaDoLimite.length > piores.length ? ` e mais ${acimaDoLimite.length - piores.length}` : ''}. Confira no caixa o certificado digital, a conexão com a SEFAZ e o log <code>nfe</code> do AcruxPDV.</p>`
              : ''
          }
          <div class="cont-resumo">
            <div><strong>${inteiro(ct.total)}</strong><span>notas em contingência</span></div>
            <div><strong>${moeda(ct.valor)}</strong><span>valor dessas notas</span></div>
            <div><strong>${porcento(ct.percent)}</strong><span>${parcial ? 'das vendas dos caixas que informam' : 'das vendas do período'}</span></div>
            <div><strong>${inteiro(ct.caixas)}</strong><span>${ct.caixas === 1 ? 'caixa afetado' : 'caixas afetados'} de ${inteiro(ct.caixasInformando)}</span></div>
          </div>
          ${
            caixasC.length
              ? `<div class="cont-tabelas">
                  ${indicadoresAba.loja ? '' : `<div><h4>Por loja</h4><table class="tab-barras">${cab('Loja')}<tbody>${lojasC.map((l) => linhaPct(`${pad3(l.loja)}${l.nome ? ` · ${esc(l.nome)}` : ''}`, l)).join('')}</tbody></table></div>`}
                  <div${indicadoresAba.loja ? ' style="grid-column:1/-1"' : ''}><h4>Por caixa</h4><table class="tab-barras">${cab('Caixa')}<tbody>${caixasC
                    .map((c) => linhaPct(`<span class="caixa-id">Loja ${pad3(c.loja)} · PDV ${pad3(c.pdv)}</span>`, c))
                    .join('')}</tbody></table></div>
                </div>`
              : '<p class="vazio-tabela">Nenhuma nota em contingência no período: tudo autorizado no caixa.</p>'
          }
        </section>`;
    }

    // Contingência logo depois dos números: é o risco fiscal, tem prioridade sobre os gráficos.
    $('#indConteudo').innerHTML = `${htmlNumeros}<div class="ind-grade">${htmlCont}${htmlHoras}${htmlTipos}${htmlLojas}${htmlDias}${htmlCaixas}</div>`;
  },
};

/** Topo "redondo" para o eixo (1, 2, 5, 10, 20, 25, 50...). */
function escalaBonita(max) {
  const passos = [1, 2, 4, 5, 10];
  const ordem = 10 ** Math.floor(Math.log10(Math.max(1, max)));
  for (const p of passos) if (p * ordem >= max) return p * ordem;
  return 10 * ordem;
}

// ================================================================== TARA AUTOMÁTICA
// Bloco em "Lojas e caixas". Grava na hora (não entra no rascunho do cadastro).
const MODOS_TARA = [
  ['desligado', 'Desligada'],
  ['precisa', 'Só quando a tara final ficar com peso'],
  ['sempre', 'Depois de toda venda'],
];
const nomeModoTara = (m) => (MODOS_TARA.find((x) => x[0] === m) || MODOS_TARA[0])[1];
const opcoesTara = (atual, extra = '') =>
  `${extra}${MODOS_TARA.map(([v, t]) => `<option value="${v}"${v === atual ? ' selected' : ''}>${t}</option>`).join('')}`;

const taraAba = {
  original: null,
  rascunho: null,

  montar() {
    $('#blocoTara').innerHTML = `
      <div class="bloco-cab">
        <h3>Tara automática da balança de conferência</h3>
        <button id="btnSalvarTara" class="primario" disabled>Salvar tara automática</button>
      </div>
      <p class="apoio">O agente aperta "b" (a mesma tecla do fiscal) depois da venda: com o caixa parado há 20 s, sem alerta e com a tela principal do AcruxPDV na frente. Confere no log se a tara aconteceu e registra tudo no Registro.</p>
      <details class="saiba-mais">
        <summary>Saiba mais</summary>
        <p>"Só quando a tara final ficar com peso": o AcruxPDV já tara sozinho no fim da venda; se nessa hora ainda havia peso na balança (sacola em cima), a próxima venda começa com o zero errado. Neste modo o agente tara de novo depois que o cliente sai. "Depois de toda venda": tara de novo sempre. Precisa do agente 1.10 ou mais novo; para testar, ligue em um ou dois caixas primeiro (exceção por caixa).</p>
      </details>
      <div class="tara-grade">
        <div>
          <h4>Por loja</h4>
          <table class="tabela"><thead><tr><th scope="col">Loja</th><th scope="col">Tara automática</th></tr></thead><tbody id="taraLojas"></tbody></table>
        </div>
        <div>
          <h4>Exceções por caixa</h4>
          <table class="tabela"><thead><tr><th scope="col">Caixa</th><th scope="col">Tara automática</th><th scope="col"><span class="so-leitor">Ações</span></th></tr></thead><tbody id="taraCaixas"></tbody></table>
          <div class="linha-botoes tara-nova">
            <select id="taraNovoCaixa" aria-label="Caixa para a exceção"></select>
            <select id="taraNovoModo" aria-label="Tara automática do caixa">${opcoesTara('precisa')}</select>
            <button id="btnTaraExcecao">Adicionar exceção</button>
          </div>
        </div>
      </div>`;
    $('#taraLojas').addEventListener('change', (e) => {
      const s = e.target.closest('[data-tara-loja]');
      if (!s) return;
      if (s.value === 'desligado') delete taraAba.rascunho.lojas[s.dataset.taraLoja];
      else taraAba.rascunho.lojas[s.dataset.taraLoja] = s.value;
      taraAba.desenhar();
    });
    $('#taraCaixas').addEventListener('change', (e) => {
      const s = e.target.closest('[data-tara-caixa]');
      if (s) taraAba.rascunho.caixas[s.dataset.taraCaixa] = s.value;
      taraAba.desenhar();
    });
    $('#taraCaixas').addEventListener('click', (e) => {
      const b = e.target.closest('[data-tara-tirar]');
      if (!b) return;
      delete taraAba.rascunho.caixas[b.dataset.taraTirar];
      taraAba.desenhar();
    });
    $('#btnTaraExcecao').onclick = () => {
      const id = $('#taraNovoCaixa').value;
      if (!id) return;
      taraAba.rascunho.caixas[id] = $('#taraNovoModo').value;
      taraAba.desenhar();
    };
    $('#btnSalvarTara').onclick = () => taraAba.salvar();
  },

  async carregar() {
    try {
      const d = await api('/api/admin/tara');
      taraAba.original = { lojas: d.lojas, caixas: d.caixas };
      taraAba.rascunho = copia(taraAba.original);
      taraAba.desenhar();
    } catch (e) {
      if (e.message !== 'Sessão encerrada') $('#taraLojas').innerHTML = `<tr><td colspan="2" class="vazio-tabela">Não foi possível ler a configuração: ${esc(e.message)}</td></tr>`;
    }
  },

  mudou() {
    return JSON.stringify(taraAba.original) !== JSON.stringify(taraAba.rascunho);
  },

  desenhar() {
    if (!taraAba.rascunho || !cadastro.original) return;
    const r = taraAba.rascunho;
    const cad = cadastro.original;
    $('#taraLojas').innerHTML = cad.lojas
      .map(
        (l) => `<tr><th scope="row">${pad3(l.codigo)}${l.nome ? ` · ${esc(l.nome)}` : ''}</th>
          <td><select data-tara-loja="${l.codigo}" aria-label="Tara automática da loja ${pad3(l.codigo)}">${opcoesTara(r.lojas[l.codigo] || 'desligado')}</select></td></tr>`,
      )
      .join('');
    const ids = Object.keys(r.caixas).sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true }));
    $('#taraCaixas').innerHTML = ids.length
      ? ids
          .map((id) => {
            const [l, p] = id.split('-').map(Number);
            const daLoja = nomeModoTara(r.lojas[l] || 'desligado').toLowerCase();
            return `<tr><th scope="row"><span class="caixa-id">Loja ${pad3(l)} · PDV ${pad3(p)}</span><span class="apoio bloco">a loja está: ${esc(daLoja)}</span></th>
              <td><select data-tara-caixa="${id}" aria-label="Tara automática do caixa ${id}">${opcoesTara(r.caixas[id])}</select></td>
              <td class="acoes-linha"><button class="texto" data-tara-tirar="${id}" aria-label="Tirar exceção: Loja ${pad3(l)} · PDV ${pad3(p)}">Seguir a loja</button></td></tr>`;
          })
          .join('')
      : '<tr><td colspan="3" class="vazio-tabela">Nenhuma exceção: cada caixa segue a loja.</td></tr>';
    const livres = cad.caixas.filter((c) => !(`${c.loja}-${c.pdv}` in r.caixas));
    $('#taraNovoCaixa').innerHTML = `<option value="">Escolha o caixa</option>${livres
      .map((c) => `<option value="${c.loja}-${c.pdv}">Loja ${pad3(c.loja)} · PDV ${pad3(c.pdv)}</option>`)
      .join('')}`;
    $('#btnSalvarTara').disabled = !taraAba.mudou();
  },

  salvar() {
    const antes = taraAba.original;
    const r = taraAba.rascunho;
    const linhas = [];
    for (const l of new Set([...Object.keys(antes.lojas), ...Object.keys(r.lojas)])) {
      if ((antes.lojas[l] || 'desligado') !== (r.lojas[l] || 'desligado')) linhas.push(`Loja ${pad3(l)}: ${nomeModoTara(r.lojas[l] || 'desligado')}`);
    }
    for (const id of new Set([...Object.keys(antes.caixas), ...Object.keys(r.caixas)])) {
      if (antes.caixas[id] !== r.caixas[id]) linhas.push(`Caixa ${id}: ${r.caixas[id] ? nomeModoTara(r.caixas[id]) : 'volta a seguir a loja'}`);
    }
    const liga = Object.values(r.lojas).some((m) => m !== 'desligado') || Object.values(r.caixas).some((m) => m !== 'desligado');
    return dialogo({
      titulo: 'Salvar a tara automática?',
      botao: 'Salvar',
      html: `<ul class="lista-mudancas">${linhas.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
        ${liga ? '<p class="apoio">Os caixas recebem a mudança em poucos segundos. A partir daí o agente aperta "b" sozinho nos caixas ligados, depois da venda, quando as condições de segurança forem atendidas.</p>' : ''}`,
      async confirmar() {
        const d = await api('/api/admin/tara', { method: 'PUT', body: r });
        taraAba.original = { lojas: d.lojas, caixas: d.caixas };
        taraAba.rascunho = copia(taraAba.original);
        taraAba.desenhar();
        avisar('Tara automática salva.');
      },
    });
  },
};

// Tipo do caixa: self-checkout (padrão) ou PDV normal (com operador, sem agente).
const TIPOS_CAIXA = [
  ['self', 'Self-checkout'],
  ['pdv', 'PDV normal'],
];
const opcoesTipoCaixa = (atual) => TIPOS_CAIXA.map(([v, t]) => `<option value="${v}"${v === atual ? ' selected' : ''}>${t}</option>`).join('');

// ================================================================== CADASTRO
const copia = (x) => JSON.parse(JSON.stringify(x));
const chaveCaixa = (c) => `${c.loja}-${c.pdv}`;

const cadastro = {
  original: null,
  rascunho: null,
  lojaSel: null, // código da loja selecionada (null = todas)
  montado: false,

  temMudancas() {
    return Boolean(cadastro.original) && JSON.stringify(cadastro.normal(cadastro.original)) !== JSON.stringify(cadastro.normal(cadastro.rascunho));
  },
  normal(d) {
    return {
      semEstacao: d.semEstacao,
      lojas: [...d.lojas].sort((a, b) => a.codigo - b.codigo),
      caixas: [...d.caixas].map((c) => ({ ...c, portaVnc: c.portaVnc || null })).sort((a, b) => a.loja - b.loja || a.pdv - b.pdv),
      estacoes: d.estacoes.map((e) => ({ ...e, computadores: [...e.computadores], caixas: [...e.caixas].sort() })),
    };
  },

  async abrir() {
    if (!cadastro.montado) cadastro.montar();
    if (!cadastro.original || !cadastro.temMudancas()) await cadastro.carregar();
    cadastro.desenhar();
    taraAba.carregar();
  },

  async carregar() {
    const d = await api('/api/admin/cadastro');
    cadastro.original = d;
    cadastro.rascunho = copia(d);
    if (cadastro.lojaSel != null && !d.lojas.some((l) => l.codigo === cadastro.lojaSel)) cadastro.lojaSel = null;
  },

  montar() {
    cadastro.montado = true;
    $('#aba-cadastro').innerHTML = `
      <div class="aba-cab">
        <h2 id="t-cadastro">Lojas e caixas</h2>
        <p class="apoio">As mudanças ficam pendentes até você clicar em "Revisar e salvar". Cada gravação guarda uma cópia da versão anterior em <code>data\\estacoes-anteriores</code>.</p>
      </div>
      <div class="cadastro">
        <aside class="lojas" aria-label="Lojas">
          <div class="bloco-cab"><h3>Lojas</h3><button id="btnNovaLoja">Nova loja</button></div>
          <ul id="listaLojas" class="lista-lojas"></ul>
        </aside>
        <div class="cadastro-detalhe">
          <div class="bloco">
            <div class="bloco-cab">
              <h3 id="tituloCaixas">Caixas</h3>
              <div class="linha-botoes">
                <input type="search" id="buscaCaixas" class="busca" placeholder="Buscar PDV, IP, estação ou tipo" aria-label="Buscar caixa por PDV, IP, estação ou tipo (self, pdv normal)">
                <button id="btnVariosCaixas">Adicionar vários</button><button id="btnNovoCaixa">Novo caixa</button>
              </div>
            </div>
            <div class="tabela-wrap"><table class="tabela">
              <thead><tr><th scope="col">Caixa</th><th scope="col">Tipo</th><th scope="col">IP</th><th scope="col">Porta VNC</th><th scope="col">Estação</th><th scope="col"><span class="so-leitor">Ações</span></th></tr></thead>
              <tbody id="linhasCaixas"></tbody>
            </table></div>
          </div>
          <div class="bloco">
            <div class="bloco-cab">
              <h3>Estações <span class="apoio">(computadores dos fiscais e os caixas que cada um vê)</span></h3>
              <button id="btnNovaEstacao">Nova estação</button>
            </div>
            <div id="listaEstacoes" class="lista-estacoes"></div>
          </div>
          <div class="bloco" id="blocoTara"></div>
        </div>
      </div>`;
    taraAba.montar();
    $('#btnNovaLoja').onclick = () => cadastro.editarLoja(null);
    $('#btnNovoCaixa').onclick = () => cadastro.editarCaixa(null);
    $('#btnVariosCaixas').onclick = () => cadastro.variosCaixas();
    $('#btnNovaEstacao').onclick = () => cadastro.editarEstacao(null);
    $('#listaLojas').addEventListener('click', (e) => {
      const b = e.target.closest('[data-loja]');
      if (b) {
        cadastro.lojaSel = b.dataset.loja === '' ? null : Number(b.dataset.loja);
        cadastro.desenhar();
        return;
      }
      const ed = e.target.closest('[data-editar-loja]');
      if (ed) cadastro.editarLoja(Number(ed.dataset.editarLoja));
    });
    $('#linhasCaixas').addEventListener('click', (e) => {
      const ed = e.target.closest('[data-editar-caixa]');
      if (ed) cadastro.editarCaixa(ed.dataset.editarCaixa);
      const rm = e.target.closest('[data-remover-caixa]');
      if (rm) cadastro.removerCaixa(rm.dataset.removerCaixa);
    });
    $('#listaEstacoes').addEventListener('click', (e) => {
      const ed = e.target.closest('[data-editar-estacao]');
      if (ed) cadastro.editarEstacao(Number(ed.dataset.editarEstacao));
      const rm = e.target.closest('[data-remover-estacao]');
      if (rm) cadastro.removerEstacao(Number(rm.dataset.removerEstacao));
    });
    $('#btnDescartar').onclick = () =>
      dialogo({
        titulo: 'Descartar as alterações?',
        botao: 'Descartar',
        perigo: true,
        html: '<p>Todas as alterações de "Lojas e caixas" que ainda não foram salvas serão desfeitas.</p>',
        async confirmar() {
          cadastro.rascunho = copia(cadastro.original);
          cadastro.desenhar();
        },
      });
    $('#buscaCaixas').addEventListener('input', (e) => {
      cadastro.busca = e.target.value.trim().toLowerCase();
      cadastro.desenhar();
    });
    $('#btnRevisar').onclick = () => cadastro.revisar();
  },

  nomeLoja(codigo) {
    return cadastro.rascunho.lojas.find((l) => l.codigo === codigo)?.nome || '';
  },
  estacoesDoCaixa(ip) {
    return cadastro.rascunho.estacoes.filter((e) => e.caixas.includes(ip)).map((e) => e.nome);
  },

  desenhar() {
    const r = cadastro.rascunho;
    // Lojas
    const totalPorLoja = (codigo) => r.caixas.filter((c) => c.loja === codigo).length;
    $('#listaLojas').innerHTML =
      `<li><button class="item-loja" data-loja="" aria-pressed="${cadastro.lojaSel == null}"><span>Todas as lojas</span><span class="apoio">${r.caixas.length} caixas</span></button></li>` +
      r.lojas
        .slice()
        .sort((a, b) => a.codigo - b.codigo)
        .map(
          (l) => `<li class="linha-loja">
            <button class="item-loja" data-loja="${l.codigo}" aria-pressed="${cadastro.lojaSel === l.codigo}">
              <span><b>${pad3(l.codigo)}</b> ${esc(l.nome) || '<span class="sit sit-alerta">sem nome</span>'}</span>
              <span class="apoio">${totalPorLoja(l.codigo)} ${totalPorLoja(l.codigo) === 1 ? 'caixa' : 'caixas'}</span>
            </button>
            <button class="texto" data-editar-loja="${l.codigo}" aria-label="Editar: loja ${pad3(l.codigo)}">Editar</button>
          </li>`,
        )
        .join('');

    // Caixas
    // Busca: "50", "pdv 050", "1-50", parte do IP ou nome da estação.
    const busca = cadastro.busca || '';
    const casa = (c) => {
      if (!busca) return true;
      const texto = [`pdv ${pad3(c.pdv)}`, `pdv ${c.pdv}`, `${c.loja}-${c.pdv}`, `${pad3(c.loja)}-${pad3(c.pdv)}`, c.ip, c.tipo === 'pdv' ? 'pdv normal' : 'self', ...cadastro.estacoesDoCaixa(c.ip)].join(' ').toLowerCase();
      return texto.includes(busca) || String(c.pdv) === busca || pad3(c.pdv) === busca;
    };
    const caixas = r.caixas
      .filter((c) => (cadastro.lojaSel == null || c.loja === cadastro.lojaSel) && casa(c))
      .sort((a, b) => a.loja - b.loja || a.pdv - b.pdv);
    $('#tituloCaixas').textContent = cadastro.lojaSel == null ? 'Caixas' : `Caixas da loja ${pad3(cadastro.lojaSel)} · ${cadastro.nomeLoja(cadastro.lojaSel)}`;
    $('#linhasCaixas').innerHTML = caixas.length
      ? caixas
          .map((c) => {
            const est = cadastro.estacoesDoCaixa(c.ip);
            return `<tr>
              <th scope="row"><span class="caixa-id">Loja ${pad3(c.loja)} · PDV ${pad3(c.pdv)}</span></th>
              <td>${c.tipo === 'pdv' ? 'PDV normal' : '<span class="apoio">Self</span>'}</td>
              <td class="mono">${esc(c.ip)}</td>
              <td>${c.portaVnc && c.portaVnc !== 5900 ? c.portaVnc : '<span class="apoio">5900</span>'}</td>
              <td>${est.length ? esc(est.join(', ')) : c.tipo === 'pdv' ? '<span class="apoio">—</span>' : '<span class="sit sit-alerta">Nenhum fiscal vê este caixa</span>'}</td>
              <td class="acoes-linha">
                <button class="texto" data-editar-caixa="${chaveCaixa(c)}" aria-label="Editar: Loja ${pad3(c.loja)} · PDV ${pad3(c.pdv)}">Editar</button>
                <button class="texto perigo-texto" data-remover-caixa="${chaveCaixa(c)}" aria-label="Remover: Loja ${pad3(c.loja)} · PDV ${pad3(c.pdv)}">Remover</button>
              </td>
            </tr>`;
          })
          .join('')
      : `<tr><td colspan="6" class="vazio-tabela">${
          busca ? `Nenhum caixa encontrado para "${esc(busca)}".` : r.lojas.length ? 'Nenhum caixa nesta loja. Use "Novo caixa" ou "Adicionar vários".' : 'Cadastre uma loja primeiro.'
        }</td></tr>`;

    // Estações (as que têm algum caixa da loja selecionada, ou todas)
    const estacoes = r.estacoes
      .map((e, i) => ({ ...e, i }))
      .filter((e) => cadastro.lojaSel == null || e.caixas.some((ip) => r.caixas.find((c) => c.ip === ip)?.loja === cadastro.lojaSel) || !e.caixas.length);
    $('#listaEstacoes').innerHTML = estacoes.length
      ? estacoes
          .map((e) => {
            const cx = e.caixas
              .map((ip) => r.caixas.find((c) => c.ip === ip))
              .filter(Boolean)
              .sort((a, b) => a.loja - b.loja || a.pdv - b.pdv);
            const lojasDela = [...new Set(cx.map((c) => c.loja))];
            const resumoCx = lojasDela
              .map((l) => `Loja ${pad3(l)}: PDV ${cx.filter((c) => c.loja === l).map((c) => c.pdv).join(', ')}`)
              .join(' · ');
            return `<article class="estacao">
              <div class="estacao-cab">
                <h4>${esc(e.nome)}</h4>
                <div class="linha-botoes">
                  <button class="texto" data-editar-estacao="${e.i}" aria-label="Editar: estação ${esc(e.nome)}">Editar</button>
                  <button class="texto perigo-texto" data-remover-estacao="${e.i}" aria-label="Remover: estação ${esc(e.nome)}">Remover</button>
                </div>
              </div>
              <dl class="estacao-dados">
                <dt>Computadores</dt><dd class="mono">${e.computadores.length ? esc(e.computadores.join(', ')) : '<span class="sit sit-alerta">Nenhum: ninguém usa esta estação</span>'}</dd>
                <dt>Caixas</dt><dd>${cx.length ? esc(resumoCx) : '<span class="sit sit-alerta">Nenhum caixa</span>'}</dd>
              </dl>
            </article>`;
          })
          .join('')
      : '<p class="vazio-tabela">Nenhuma estação com caixas desta loja. Use "Nova estação" para dizer qual computador de fiscal vê estes caixas.</p>';

    // Barra de pendências
    const n = cadastro.mudancas().length;
    $('#pendente').hidden = !n;
    $('#pendenteTexto').textContent = n === 1 ? '1 alteração não salva' : `${n} alterações não salvas`;
  },

  // Lista legível do que mudou entre o original e o rascunho.
  mudancas() {
    if (!cadastro.original) return [];
    const o = cadastro.original;
    const r = cadastro.rascunho;
    const lista = [];
    const lojaO = new Map(o.lojas.map((l) => [l.codigo, l]));
    const lojaR = new Map(r.lojas.map((l) => [l.codigo, l]));
    for (const [k, l] of lojaR) {
      if (!lojaO.has(k)) lista.push(`Nova loja ${pad3(k)} · ${l.nome}`);
      else if (lojaO.get(k).nome !== l.nome) lista.push(`Loja ${pad3(k)} renomeada: "${lojaO.get(k).nome}" → "${l.nome}"`);
    }
    for (const k of lojaO.keys()) if (!lojaR.has(k)) lista.push(`Loja ${pad3(k)} removida`);

    const cxO = new Map(o.caixas.map((c) => [chaveCaixa(c), c]));
    const cxR = new Map(r.caixas.map((c) => [chaveCaixa(c), c]));
    const nomeCx = (c) => `Loja ${pad3(c.loja)} · PDV ${pad3(c.pdv)}`;
    for (const [k, c] of cxR) {
      const a = cxO.get(k);
      if (!a) lista.push(`Novo caixa ${nomeCx(c)} (${c.ip})`);
      else {
        if (a.ip !== c.ip) lista.push(`${nomeCx(c)}: IP ${a.ip} → ${c.ip}`);
        if ((a.portaVnc || 5900) !== (c.portaVnc || 5900)) lista.push(`${nomeCx(c)}: porta VNC ${a.portaVnc || 5900} → ${c.portaVnc || 5900}`);
        if ((a.tipo || 'self') !== (c.tipo || 'self')) lista.push(`${nomeCx(c)}: agora é ${c.tipo === 'pdv' ? 'PDV normal' : 'self-checkout'}`);
      }
    }
    for (const [k, c] of cxO) if (!cxR.has(k)) lista.push(`Caixa ${nomeCx(c)} (${c.ip}) removido`);

    const estO = new Map(o.estacoes.map((e) => [e.nome, e]));
    const estR = new Map(r.estacoes.map((e) => [e.nome, e]));
    for (const [nome, e] of estR) {
      const a = estO.get(nome);
      if (!a) lista.push(`Nova estação "${nome}": ${e.computadores.length} computador(es), ${e.caixas.length} caixa(s)`);
      else {
        if (a.computadores.join() !== e.computadores.join()) lista.push(`Estação "${nome}": computadores ${a.computadores.join(', ') || 'nenhum'} → ${e.computadores.join(', ') || 'nenhum'}`);
        if ([...a.caixas].sort().join() !== [...e.caixas].sort().join()) lista.push(`Estação "${nome}" passa a ver ${e.caixas.length} caixa(s) (antes ${a.caixas.length})`);
      }
    }
    for (const nome of estO.keys()) if (!estR.has(nome)) lista.push(`Estação "${nome}" removida`);
    return lista;
  },

  editarLoja(codigo) {
    const r = cadastro.rascunho;
    const atual = codigo == null ? null : r.lojas.find((l) => l.codigo === codigo);
    const qtd = atual ? r.caixas.filter((c) => c.loja === codigo).length : 0;
    return dialogo({
      titulo: atual ? `Loja ${pad3(codigo)}` : 'Nova loja',
      botao: atual ? 'Aplicar' : 'Adicionar loja',
      html: `
        <div class="campos">
          <label>Código da loja <input name="codigo" inputmode="numeric" value="${atual ? atual.codigo : ''}" ${atual ? 'readonly' : ''} required>
            <small>O número da loja no AcruxPDV (NroEmpresa).${atual ? ' Não muda depois de criado.' : ''}</small></label>
          <label>Nome <input name="nome" value="${esc(atual?.nome || '')}" maxlength="60" required></label>
        </div>
        ${atual ? `<div class="zona-perigo"><p>${qtd ? `Para remover esta loja, remova antes os ${qtd} caixas dela.` : 'Esta loja não tem caixas.'}</p><button type="button" id="btnRemoverLoja" class="perigo" ${qtd ? 'disabled' : ''}>Remover loja</button></div>` : ''}`,
      montar(corpo, fechar) {
        $('#btnRemoverLoja', corpo)?.addEventListener('click', () => {
          r.lojas = r.lojas.filter((l) => l.codigo !== codigo);
          for (const e of r.estacoes) e.caixas = e.caixas.filter((ip) => r.caixas.some((c) => c.ip === ip));
          if (cadastro.lojaSel === codigo) cadastro.lojaSel = null;
          fechar();
          cadastro.desenhar();
        });
      },
      confirmar(form) {
        const cod = Number(form.codigo.value);
        const nome = form.nome.value.trim();
        if (!Number.isInteger(cod) || cod < 1 || cod > 9999) return 'Informe o código da loja (um número de 1 a 9999).';
        if (!nome) return 'Informe o nome da loja.';
        if (!atual && r.lojas.some((l) => l.codigo === cod)) return `A loja ${cod} já existe.`;
        if (atual) atual.nome = nome;
        else {
          r.lojas.push({ codigo: cod, nome });
          cadastro.lojaSel = cod;
        }
        cadastro.desenhar();
      },
    });
  },

  opcoesLoja(sel) {
    return cadastro.rascunho.lojas
      .slice()
      .sort((a, b) => a.codigo - b.codigo)
      .map((l) => `<option value="${l.codigo}" ${l.codigo === sel ? 'selected' : ''}>${pad3(l.codigo)} · ${esc(l.nome)}</option>`)
      .join('');
  },

  editarCaixa(chave) {
    const r = cadastro.rascunho;
    if (!r.lojas.length) return avisar('Cadastre uma loja primeiro.', 'erro');
    const atual = chave ? r.caixas.find((c) => chaveCaixa(c) === chave) : null;
    const lojaPadrao = atual?.loja ?? cadastro.lojaSel ?? r.lojas[0].codigo;
    return dialogo({
      titulo: atual ? `Loja ${pad3(atual.loja)} · PDV ${pad3(atual.pdv)}` : 'Novo caixa',
      botao: atual ? 'Aplicar' : 'Adicionar caixa',
      html: `<div class="campos">
        <label>Loja <select name="loja" ${atual ? 'disabled' : ''}>${cadastro.opcoesLoja(lojaPadrao)}</select></label>
        <label>PDV <input name="pdv" inputmode="numeric" value="${atual?.pdv ?? ''}" ${atual ? 'readonly' : ''} required>
          <small>O número do caixa no AcruxPDV (NroCheckout).</small></label>
        <label>IP do caixa <input name="ip" value="${esc(atual?.ip || '')}" class="mono" required></label>
        <label>Porta VNC <input name="porta" inputmode="numeric" value="${atual?.portaVnc && atual.portaVnc !== 5900 ? atual.portaVnc : ''}" placeholder="5900">
          <small>Deixe vazio para a padrão (5900).</small></label>
        <label>Tipo <select name="tipo">${opcoesTipoCaixa(atual?.tipo || 'self')}</select>
          <small>No painel, a TI escolhe ver os selfs ou os PDVs normais.</small></label>
        ${atual ? '' : `<label class="marcar"><input type="checkbox" name="pdvDoIp" checked> PDV igual ao último número do IP</label>`}
      </div>`,
      montar() {
        const f = $('#dlgForm');
        const sinc = () => {
          if (f.pdvDoIp?.checked) {
            const m = f.ip.value.trim().match(/\.(\d+)$/);
            f.pdv.value = m ? m[1] : '';
          }
        };
        f.ip.addEventListener('input', sinc);
        f.pdvDoIp?.addEventListener('change', sinc);
      },
      confirmar(form) {
        const loja = atual ? atual.loja : Number(form.loja.value);
        const pdv = Number(form.pdv.value);
        const ip = form.ip.value.trim();
        const porta = form.porta.value.trim() ? Number(form.porta.value) : null;
        if (!Number.isInteger(pdv) || pdv < 1 || pdv > 999) return 'Informe o PDV (um número de 1 a 999).';
        if (!IPV4.test(ip)) return 'IP inválido. Exemplo: 192.0.2.13';
        if (porta !== null && !(Number.isInteger(porta) && porta > 0 && porta < 65536)) return 'Porta VNC inválida.';
        if (!atual && r.caixas.some((c) => c.loja === loja && c.pdv === pdv)) return `A loja ${loja} já tem o PDV ${pdv}.`;
        const dono = r.caixas.find((c) => c.ip === ip && c !== atual);
        if (dono) return `O IP ${ip} já é do caixa Loja ${pad3(dono.loja)} · PDV ${pad3(dono.pdv)}.`;
        if (atual) {
          // IP mudou: as estações que viam o caixa continuam vendo.
          for (const e of r.estacoes) e.caixas = e.caixas.map((x) => (x === atual.ip ? ip : x));
          atual.ip = ip;
          atual.portaVnc = porta;
          atual.tipo = form.tipo.value;
        } else r.caixas.push({ loja, pdv, ip, portaVnc: porta, tipo: form.tipo.value });
        cadastro.desenhar();
      },
    });
  },

  variosCaixas() {
    const r = cadastro.rascunho;
    if (!r.lojas.length) return avisar('Cadastre uma loja primeiro.', 'erro');
    const lojaPadrao = cadastro.lojaSel ?? r.lojas[0].codigo;
    let plano = [];
    return dialogo({
      titulo: 'Adicionar vários caixas',
      botao: 'Adicionar',
      html: `<div class="campos">
        <label>Loja <select name="loja">${cadastro.opcoesLoja(lojaPadrao)}</select></label>
        <div class="campos-lado">
          <label>Primeiro IP <input name="ip1" class="mono" placeholder="192.0.2.9" required></label>
          <label>Último IP <input name="ip2" class="mono" placeholder="192.0.2.14" required></label>
        </div>
        <p class="apoio">O PDV de cada caixa é o último número do IP (ex.: 192.0.2.13 vira PDV 13).</p>
        <label>Tipo <select name="tipo">${opcoesTipoCaixa('self')}</select></label>
        <label>Ver também na estação <select name="estacao"><option value="">Nenhuma (escolho depois)</option>${r.estacoes
          .map((e, i) => `<option value="${i}">${esc(e.nome)}</option>`)
          .join('')}</select></label>
        <div class="previa" id="previaVarios" aria-live="polite"></div>
      </div>`,
      montar() {
        const f = $('#dlgForm');
        const calcular = () => {
          plano = [];
          const a = f.ip1.value.trim();
          const b = f.ip2.value.trim();
          const loja = Number(f.loja.value);
          const prev = $('#previaVarios');
          if (!IPV4.test(a) || !IPV4.test(b)) {
            prev.textContent = '';
            return;
          }
          const base = a.split('.').slice(0, 3).join('.');
          if (b.split('.').slice(0, 3).join('.') !== base) {
            prev.textContent = 'Os dois IPs precisam ter os três primeiros números iguais.';
            return;
          }
          const ini = Number(a.split('.')[3]);
          const fim = Number(b.split('.')[3]);
          if (fim < ini || fim - ini > 60) {
            prev.textContent = 'O último IP precisa ser maior que o primeiro (até 60 caixas de uma vez).';
            return;
          }
          const pulados = [];
          for (let n = ini; n <= fim; n++) {
            const ip = `${base}.${n}`;
            if (r.caixas.some((c) => c.ip === ip) || r.caixas.some((c) => c.loja === loja && c.pdv === n)) pulados.push(n);
            else plano.push({ loja, pdv: n, ip, portaVnc: null });
          }
          prev.innerHTML = plano.length
            ? `Vai adicionar ${plano.length} ${plano.length === 1 ? 'caixa' : 'caixas'}: PDV ${plano.map((c) => c.pdv).join(', ')}.${pulados.length ? ` Pula ${pulados.join(', ')} (já cadastrado).` : ''}`
            : 'Todos esses caixas já estão cadastrados.';
        };
        for (const campo of [f.ip1, f.ip2, f.loja]) campo.addEventListener('input', calcular);
      },
      confirmar(form) {
        if (!plano.length) return 'Informe um intervalo de IPs com caixas novos.';
        for (const c of plano) c.tipo = form.tipo.value;
        r.caixas.push(...plano);
        if (form.estacao.value !== '') {
          const e = r.estacoes[Number(form.estacao.value)];
          e.caixas = [...new Set([...e.caixas, ...plano.map((c) => c.ip)])];
        }
        cadastro.lojaSel = Number(form.loja.value);
        cadastro.desenhar();
      },
    });
  },

  removerCaixa(chave) {
    const r = cadastro.rascunho;
    const c = r.caixas.find((x) => chaveCaixa(x) === chave);
    if (!c) return;
    return dialogo({
      titulo: `Remover Loja ${pad3(c.loja)} · PDV ${pad3(c.pdv)}?`,
      botao: 'Remover caixa',
      perigo: true,
      html: `<p>O caixa ${esc(c.ip)} sai do cadastro e de todas as estações. Ao salvar, ele some do painel se o agente dele estiver desligado.</p>
        <p class="apoio">Se o agente continuar instalado no caixa, ele volta a aparecer sozinho para TI / Administrador. Depois de salvar, esta tela mostra o comando para desinstalar.</p>`,
      confirmar() {
        r.caixas = r.caixas.filter((x) => x !== c);
        for (const e of r.estacoes) e.caixas = e.caixas.filter((ip) => ip !== c.ip);
        cadastro.desenhar();
      },
    });
  },

  editarEstacao(indice) {
    const r = cadastro.rascunho;
    const atual = indice == null ? null : r.estacoes[indice];
    const marcados = new Set(atual?.caixas || []);
    const lojas = r.lojas.slice().sort((a, b) => a.codigo - b.codigo);
    const grupos = lojas
      .map((l) => {
        const cx = r.caixas.filter((c) => c.loja === l.codigo).sort((a, b) => a.pdv - b.pdv);
        if (!cx.length) return '';
        return `<fieldset class="grupo-caixas">
          <legend><label class="marcar"><input type="checkbox" data-toda-loja="${l.codigo}"> Loja ${pad3(l.codigo)} · ${esc(l.nome)}</label></legend>
          <div class="grade-caixas">${cx
            .map(
              (c) => `<label class="marcar"><input type="checkbox" name="caixa" value="${esc(c.ip)}" data-loja="${c.loja}" ${marcados.has(c.ip) ? 'checked' : ''}> PDV ${pad3(c.pdv)} <span class="apoio mono">${esc(c.ip)}</span></label>`,
            )
            .join('')}</div>
        </fieldset>`;
      })
      .join('');
    return dialogo({
      titulo: atual ? `Estação "${atual.nome}"` : 'Nova estação',
      botao: atual ? 'Aplicar' : 'Adicionar estação',
      html: `<div class="campos">
        <label>Nome <input name="nome" value="${esc(atual?.nome || '')}" maxlength="60" placeholder="Ex.: Loja Centro" required></label>
        <label>Computadores dos fiscais <textarea name="computadores" rows="2" class="mono" placeholder="192.0.2.50">${esc((atual?.computadores || []).join('\n'))}</textarea>
          <small>Um IP por linha. Para uma faixa inteira, termine com * (ex.: 192.0.2.*).</small></label>
        <div class="caixas-estacao"><p class="rotulo">Caixas que esta estação vê</p>${grupos || '<p class="apoio">Nenhum caixa cadastrado ainda.</p>'}</div>
      </div>`,
      montar(corpo) {
        const atualizarLoja = (l) => {
          const todos = $$(`input[name=caixa][data-loja="${l}"]`, corpo);
          const toda = $(`[data-toda-loja="${l}"]`, corpo);
          const n = todos.filter((x) => x.checked).length;
          toda.checked = n === todos.length;
          toda.indeterminate = n > 0 && n < todos.length;
        };
        for (const t of $$('[data-toda-loja]', corpo)) {
          atualizarLoja(t.dataset.todaLoja);
          t.addEventListener('change', () => {
            for (const x of $$(`input[name=caixa][data-loja="${t.dataset.todaLoja}"]`, corpo)) x.checked = t.checked;
          });
        }
        corpo.addEventListener('change', (e) => {
          if (e.target.name === 'caixa') atualizarLoja(e.target.dataset.loja);
        });
      },
      confirmar(form) {
        const nome = form.nome.value.trim();
        const computadores = [...new Set(form.computadores.value.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))];
        const caixas = $$('input[name=caixa]:checked', form).map((x) => x.value);
        if (!nome) return 'Informe o nome da estação.';
        if (r.estacoes.some((e, i) => e.nome === nome && i !== indice)) return `Já existe uma estação chamada "${nome}".`;
        const ruim = computadores.find((pc) => !IPV4.test(pc) && !/^((25[0-5]|2[0-4]\d|1?\d?\d)\.){1,3}\*$/.test(pc));
        if (ruim) return `Computador inválido: "${ruim}". Use um IP (192.0.2.50) ou uma faixa (192.0.2.*).`;
        for (const pc of computadores) {
          const outra = r.estacoes.find((e, i) => i !== indice && e.computadores.includes(pc));
          if (outra) return `O computador ${pc} já está na estação "${outra.nome}". Um computador só pode estar em uma estação.`;
        }
        if (atual) Object.assign(atual, { nome, computadores, caixas });
        else r.estacoes.push({ nome, computadores, caixas });
        cadastro.desenhar();
      },
    });
  },

  removerEstacao(indice) {
    const r = cadastro.rascunho;
    const e = r.estacoes[indice];
    return dialogo({
      titulo: `Remover a estação "${e.nome}"?`,
      botao: 'Remover estação',
      perigo: true,
      html: `<p>${e.computadores.length ? `O${e.computadores.length > 1 ? 's computadores' : ' computador'} ${esc(e.computadores.join(', '))} deixa${e.computadores.length > 1 ? 'm' : ''} de ver os caixas no painel.` : 'Nenhum computador usa esta estação.'} Os caixas continuam cadastrados.</p>`,
      confirmar() {
        r.estacoes.splice(indice, 1);
        cadastro.desenhar();
      },
    });
  },

  revisar() {
    const lista = cadastro.mudancas();
    if (!lista.length) return;
    return dialogo({
      titulo: 'Salvar estas alterações?',
      botao: 'Salvar no servidor',
      html: `<p class="apoio">Servidor ${esc(resumo.servidor)}. Os painéis abertos recebem a mudança em poucos segundos.</p>
        <ul class="lista-mudancas">${lista.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>`,
      async confirmar() {
        let resp;
        try {
          resp = await api('/api/admin/cadastro', {
            method: 'PUT',
            body: { ...cadastro.rascunho, versao: cadastro.original.versao, resumo: lista.join('; ') },
          });
        } catch (e) {
          if (e.status === 409) return `${e.message} Suas alterações continuam aqui; anote-as antes de recarregar.`;
          return e.message;
        }
        cadastro.original = resp.cadastro;
        cadastro.rascunho = copia(resp.cadastro);
        cadastro.desenhar();
        if (resp.comAgente.length) setTimeout(() => cadastro.avisoComAgente(resp.comAgente), 0);
        else avisar('Cadastro salvo.');
      },
    });
  },

  avisoComAgente(lista) {
    const cmds = lista.map(
      (c) =>
        `ssh -i "$env:USERPROFILE\\.ssh\\painel_self_rsa" -o PubkeyAcceptedKeyTypes=+ssh-rsa root@${c.ip} "systemctl disable --now painel-self-agente 2>/dev/null; pkill -f '[r]odar.sh'; pkill -f '[a]gente.pl'; sed -i '/Agente do Painel Self-Checkout/d; /painel-self.iniciar.sh/d' /etc/rc.d/rc.local 2>/dev/null; rm -rf /opt/painel-self /etc/painel-self /etc/systemd/system/painel-self-agente.service /var/log/painel-self-agente.log; echo removido"`,
    );
    return dialogo({
      titulo: 'Cadastro salvo. Falta desinstalar o agente',
      botao: 'Entendi',
      semCancelar: true,
      html: `<p>${lista.length === 1 ? 'Este caixa ainda tem' : 'Estes caixas ainda têm'} o agente ligado, então ${lista.length === 1 ? 'continua' : 'continuam'} aparecendo para TI / Administrador: ${esc(lista.map((c) => c.id).join(', '))}.</p>
        <p class="apoio">Rode no PowerShell, na pasta do projeto. Depois, apague o caixa de novo aqui ou espere ele ficar sem contato.</p>
        ${cmds.map((c) => `<div class="comando"><code>${esc(c)}</code><button type="button" data-cmd="${esc(c)}">Copiar</button></div>`).join('')}`,
      montar(corpo) {
        for (const b of $$('[data-cmd]', corpo)) b.onclick = () => copiar(b.dataset.cmd, b);
      },
    });
  },
};

// ================================================================== USUÁRIOS
const usuariosAba = {
  lista: [],
  montado: false,

  async abrir() {
    if (!usuariosAba.montado) usuariosAba.montar();
    await usuariosAba.carregar();
  },

  montar() {
    usuariosAba.montado = true;
    $('#aba-usuarios').innerHTML = `
      <div class="aba-cab com-acao">
        <div>
          <h2 id="t-usuarios">Usuários</h2>
          <p class="apoio">Dois níveis. <b>Fiscal</b>: usa o painel e vê os caixas da estação do computador em que entrou. <b>TI / Administrador</b>: vê todos os caixas e altera tudo nesta área (lojas, caixas, estações e usuários).</p>
        </div>
        <button id="btnNovoUsuario" class="primario">Novo usuário</button>
      </div>
      <div class="tabela-wrap"><table class="tabela">
        <thead><tr><th scope="col">Login</th><th scope="col">Nome</th><th scope="col">Perfil</th><th scope="col">Último acesso</th><th scope="col">Situação</th><th scope="col"><span class="so-leitor">Ações</span></th></tr></thead>
        <tbody id="linhasUsuarios"></tbody>
      </table></div>`;
    $('#btnNovoUsuario').onclick = () => usuariosAba.novo();
    $('#linhasUsuarios').addEventListener('click', (e) => {
      const b = e.target.closest('[data-acao]');
      if (!b) return;
      const u = usuariosAba.lista.find((x) => x.login === b.dataset.login);
      ({ editar: usuariosAba.editar, senha: usuariosAba.senha, ativar: usuariosAba.ativar, remover: usuariosAba.remover })[b.dataset.acao](u);
    });
  },

  async carregar() {
    usuariosAba.lista = await api('/api/admin/usuarios');
    const ativosAdmin = usuariosAba.lista.filter((u) => u.perfil === 'admin' && u.ativo).length;
    $('#linhasUsuarios').innerHTML = usuariosAba.lista
      .map((u) => {
        const souEu = u.login === eu.login;
        const unicoAdmin = u.perfil === 'admin' && u.ativo && ativosAdmin <= 1;
        return `<tr class="${u.ativo ? '' : 'inativo'}">
          <th scope="row" class="mono">${esc(u.login)}${souEu ? ' <span class="apoio">(você)</span>' : ''}</th>
          <td>${esc(u.nome)}</td>
          <td>${u.perfil === 'admin' ? 'TI / Administrador' : 'Fiscal'}</td>
          <td title="${u.ultimoAcesso ? dataHora(Date.parse(u.ultimoAcesso)) : ''}">${u.ultimoAcesso ? quando(Date.parse(u.ultimoAcesso)) : '<span class="apoio" title="O último acesso passou a ser registrado a partir desta versão do painel">sem registro</span>'}</td>
          <td>${u.ativo ? '<span class="sit sit-ok">Ativo</span>' : '<span class="sit sit-neutro">Desativado</span>'}</td>
          <td class="acoes-linha">
            <button class="texto" data-acao="editar" data-login="${esc(u.login)}" aria-label="Editar: ${esc(u.login)}">Editar</button>
            <button class="texto" data-acao="senha" data-login="${esc(u.login)}" aria-label="Trocar senha: ${esc(u.login)}">Trocar senha</button>
            ${souEu || unicoAdmin ? '' : `<button class="texto" data-acao="ativar" data-login="${esc(u.login)}" aria-label="${u.ativo ? 'Desativar' : 'Reativar'}: ${esc(u.login)}">${u.ativo ? 'Desativar' : 'Reativar'}</button>`}
            ${souEu || unicoAdmin ? '' : `<button class="texto perigo-texto" data-acao="remover" data-login="${esc(u.login)}" aria-label="Remover: ${esc(u.login)}">Remover</button>`}
          </td>
        </tr>`;
      })
      .join('');
  },

  camposSenha: `
    <label>Senha <input name="senha" type="password" autocomplete="new-password" minlength="8" maxlength="200" required>
      <small>Pelo menos 8 caracteres, sem conter o login e sem ser uma senha comum (ex.: 12345678). A senha não aparece de novo depois de salva.</small></label>
    <label>Repita a senha <input name="senha2" type="password" autocomplete="new-password" required></label>`,

  conferirSenha(form) {
    if (form.senha.value.length < 8) return 'A senha precisa ter pelo menos 8 caracteres.';
    if (form.senha.value !== form.senha2.value) return 'As duas senhas não são iguais.';
    return null;
  },

  novo() {
    return dialogo({
      titulo: 'Novo usuário',
      botao: 'Criar usuário',
      html: `<div class="campos">
        <label>Login <input name="login" autocomplete="off" maxlength="30" required><small>Letras minúsculas, números, ponto, hífen ou _. Ex.: loja16, ana.souza</small></label>
        <label>Nome <input name="nome" maxlength="60" placeholder="Ex.: Fiscais Loja Centro"></label>
        <label>Perfil <select name="perfil"><option value="supervisor">Fiscal (só o painel)</option><option value="admin">TI / Administrador (altera tudo)</option></select></label>
        ${usuariosAba.camposSenha}
      </div>`,
      async confirmar(form) {
        const erroSenha = usuariosAba.conferirSenha(form);
        if (erroSenha) return erroSenha;
        await api('/api/admin/usuarios', {
          method: 'POST',
          body: { login: form.login.value.trim(), nome: form.nome.value.trim(), perfil: form.perfil.value, senha: form.senha.value },
        });
        avisar(`Usuário "${form.login.value.trim().toLowerCase()}" criado.`);
        await usuariosAba.carregar();
      },
    });
  },

  editar(u) {
    const souEu = u.login === eu.login;
    return dialogo({
      titulo: `Editar ${u.login}`,
      botao: 'Salvar',
      html: `<div class="campos">
        <label>Nome <input name="nome" value="${esc(u.nome)}" maxlength="60" required></label>
        <label>Perfil <select name="perfil" ${souEu ? 'disabled' : ''}>
          <option value="supervisor" ${u.perfil === 'supervisor' ? 'selected' : ''}>Fiscal (só o painel)</option>
          <option value="admin" ${u.perfil === 'admin' ? 'selected' : ''}>TI / Administrador (altera tudo)</option>
        </select>${souEu ? '<small>Você não pode mudar o seu próprio perfil.</small>' : '<small>Mudar o perfil encerra as sessões abertas deste usuário.</small>'}</label>
      </div>`,
      async confirmar(form) {
        await api(`/api/admin/usuarios/${encodeURIComponent(u.login)}`, {
          method: 'PATCH',
          body: { nome: form.nome.value.trim(), ...(souEu ? {} : { perfil: form.perfil.value }) },
        });
        avisar('Usuário atualizado.');
        await usuariosAba.carregar();
      },
    });
  },

  senha(u) {
    return dialogo({
      titulo: `Trocar a senha de ${u.login}`,
      botao: 'Trocar senha',
      html: `<div class="campos">${usuariosAba.camposSenha}
        <p class="apoio">${u.login === eu.login ? 'Suas outras sessões abertas (em outros computadores) vão sair.' : 'Quem estiver logado com este usuário vai precisar entrar de novo.'}</p></div>`,
      async confirmar(form) {
        const erroSenha = usuariosAba.conferirSenha(form);
        if (erroSenha) return erroSenha;
        await api(`/api/admin/usuarios/${encodeURIComponent(u.login)}/senha`, { method: 'POST', body: { senha: form.senha.value } });
        avisar('Senha trocada.');
        await usuariosAba.carregar();
      },
    });
  },

  ativar(u) {
    const desativando = u.ativo;
    return dialogo({
      titulo: desativando ? `Desativar ${u.login}?` : `Reativar ${u.login}?`,
      botao: desativando ? 'Desativar' : 'Reativar',
      perigo: desativando,
      html: desativando
        ? '<p>O usuário não consegue mais entrar, e quem estiver usando este login agora sai na hora. Dá para reativar depois, com a mesma senha.</p>'
        : '<p>O usuário volta a entrar com a senha que já tinha.</p>',
      async confirmar() {
        await api(`/api/admin/usuarios/${encodeURIComponent(u.login)}`, { method: 'PATCH', body: { ativo: !desativando } });
        avisar(desativando ? 'Usuário desativado.' : 'Usuário reativado.');
        await usuariosAba.carregar();
      },
    });
  },

  remover(u) {
    return dialogo({
      titulo: `Remover ${u.login}?`,
      botao: 'Remover usuário',
      perigo: true,
      html: `<p>O login "${esc(u.login)}" deixa de existir e quem estiver usando sai na hora. As ações dele continuam no registro.</p>
        <p class="apoio">Se for só por um tempo, prefira "Desativar".</p>`,
      async confirmar() {
        await api(`/api/admin/usuarios/${encodeURIComponent(u.login)}`, { method: 'DELETE' });
        avisar('Usuário removido.');
        await usuariosAba.carregar();
      },
    });
  },
};

// ================================================================== REGISTRO
const registro = {
  tipos: {},
  eventos: [],
  montado: false,
  acabou: false,

  async abrir() {
    if (!registro.montado) await registro.montar();
    await registro.buscar();
  },

  async montar() {
    registro.montado = true;
    const hoje = new Date().toISOString().slice(0, 10);
    $('#aba-registro').innerHTML = `
      <div class="aba-cab">
        <h2 id="t-registro">Registro de ações</h2>
        <p class="apoio">Entradas no painel, alertas, quem atendeu e liberou, quem abriu a tela de um caixa e mudanças nesta área. Guardado por 12 meses.</p>
      </div>
      <form class="barra-filtros filtros-registro" id="formRegistro">
        <label class="campo-inline">Período <select name="periodo">
          <option value="1">Hoje</option><option value="7" selected>Últimos 7 dias</option><option value="30">Últimos 30 dias</option><option value="90">Últimos 90 dias</option><option value="x">Escolher datas</option>
        </select></label>
        <label class="campo-inline datas" hidden>De <input type="date" name="de" value="${hoje}"></label>
        <label class="campo-inline datas" hidden>Até <input type="date" name="ate" value="${hoje}"></label>
        <label class="campo-inline">Tipo <select name="tipo"><option value="">Todos</option></select></label>
        <label class="campo-inline">Usuário <select name="usuario"><option value="">Todos</option></select></label>
        <label class="campo-inline">Loja <select name="loja"><option value="">Todas</option></select></label>
        <label class="campo-inline">Caixa <input name="caixa" placeholder="16-13" size="7" class="mono"></label>
      </form>
      <div class="tabela-wrap"><table class="tabela">
        <thead><tr><th scope="col">Quando</th><th scope="col">O que</th><th scope="col">Quem</th><th scope="col">Caixa</th><th scope="col">Detalhe</th><th scope="col">IP</th></tr></thead>
        <tbody id="linhasRegistro"></tbody>
      </table></div>
      <div class="mais-registro"><button id="btnMaisRegistro" hidden>Carregar mais antigos</button></div>`;
    const f = $('#formRegistro');
    const [usuarios, cadastrados, cad] = await Promise.all([api('/api/admin/eventos/usuarios'), api('/api/admin/usuarios'), api('/api/admin/cadastro')]);
    // Usuários cadastrados primeiro; nomes que só aparecem no registro (tentativas de entrada
    // recusadas, contas já removidas) ficam num grupo à parte, para não misturar.
    const logins = new Set(cadastrados.map((u) => u.login));
    const outros = usuarios.filter((u) => !logins.has(u));
    f.usuario.innerHTML +=
      `<optgroup label="Usuários cadastrados">${[...logins].sort().map((u) => `<option>${esc(u)}</option>`).join('')}</optgroup>` +
      (outros.length ? `<optgroup label="Removidos ou entradas recusadas">${outros.map((u) => `<option>${esc(u)}</option>`).join('')}</optgroup>` : '');
    f.loja.innerHTML += cad.lojas.map((l) => `<option value="${l.codigo}">${pad3(l.codigo)} · ${esc(l.nome)}</option>`).join('');
    let timer;
    f.addEventListener('input', (e) => {
      if (e.target.name === 'periodo') for (const d of $$('.datas', f)) d.hidden = f.periodo.value !== 'x';
      clearTimeout(timer);
      timer = setTimeout(() => registro.buscar(), e.target.name === 'caixa' ? 400 : 0);
    });
    f.addEventListener('submit', (e) => e.preventDefault());
    $('#btnMaisRegistro').onclick = () => registro.buscar(true);
  },

  filtros() {
    const f = $('#formRegistro');
    let de;
    let ate = Date.now();
    if (f.periodo.value === 'x') {
      de = new Date(`${f.de.value}T00:00:00`).getTime();
      ate = new Date(`${f.ate.value}T23:59:59.999`).getTime();
    } else if (f.periodo.value === '1') {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      de = d.getTime();
    } else de = Date.now() - Number(f.periodo.value) * 864e5;
    return { de, ate, tipo: f.tipo.value, usuario: f.usuario.value, loja: f.loja.value, caixa: f.caixa.value.trim() };
  },

  async buscar(mais = false) {
    const p = registro.filtros();
    if (mais && registro.eventos.length) p.ate = registro.eventos[registro.eventos.length - 1].t - 1;
    const qs = new URLSearchParams(Object.entries({ ...p, limite: 200 }).filter(([, v]) => v !== '' && v != null));
    let r;
    try {
      r = await api(`/api/admin/eventos?${qs}`);
    } catch (e) {
      $('#linhasRegistro').innerHTML = `<tr><td colspan="6" class="vazio-tabela">Não foi possível carregar: ${esc(e.message)}</td></tr>`;
      return;
    }
    const f = $('#formRegistro');
    if (!Object.keys(registro.tipos).length) {
      registro.tipos = r.tipos;
      f.tipo.innerHTML += Object.entries(r.tipos)
        .map(([k, v]) => `<option value="${k}">${esc(v)}</option>`)
        .join('');
    }
    registro.eventos = mais ? [...registro.eventos, ...r.eventos] : r.eventos;
    $('#btnMaisRegistro').hidden = r.eventos.length < 200;
    $('#linhasRegistro').innerHTML = registro.eventos.length
      ? registro.eventos.map(registro.linha).join('')
      : '<tr><td colspan="6" class="vazio-tabela">Nada registrado com esses filtros. O registro começou a ser gravado nesta versão do painel; o histórico anterior está nos arquivos da pasta log.</td></tr>';
  },

  linha(ev) {
    const caixa = ev.caixa ? (() => {
      const [l, p] = ev.caixa.split('-');
      return `Loja ${pad3(l)} · PDV ${pad3(p)}`;
    })() : '';
    const classe = { login_recusado: 'sit sit-alerta', alerta: 'sit sit-alerta', tela: 'sit sit-venda' }[ev.tipo] || '';
    return `<tr>
      <td class="nowrap">${dataHora(ev.t)}</td>
      <td>${classe ? `<span class="${classe}">${esc(registro.tipos[ev.tipo] || ev.tipo)}</span>` : esc(registro.tipos[ev.tipo] || ev.tipo)}</td>
      <td class="mono">${esc(ev.usuario || '')}</td>
      <td class="nowrap">${caixa}</td>
      <td>${esc(ev.detalhe || '')}</td>
      <td class="mono apoio">${esc(ev.ip || '')}</td>
    </tr>`;
  },
};

iniciar();
