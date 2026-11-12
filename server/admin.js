// API da tela de administração (/admin). Tudo aqui exige perfil admin.
import fs from 'node:fs';
import path from 'node:path';
import { RAIZ, config } from './config.js';
import { info } from './log.js';
import * as usuarios from './usuarios.js';
import * as eventos from './eventos.js';
import * as indicadores from './indicadores.js';
import { estado, idCaixa } from './estado.js';
import { estacoes } from './estacoes.js';
import { configTara, salvarTara, modoTara } from './tara.js';

// Versão mais nova de cada agente, lida dos arquivos que vão no pacote.
function versaoDoArquivo(arquivo, padrao) {
  try {
    const m = fs.readFileSync(path.join(RAIZ, 'agent', 'linux', arquivo), 'utf8').match(/VERSAO\s*=\s*'([^']+)'/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
const VERSOES_ATUAIS = {
  python: versaoDoArquivo('agente.py'),
  perl: versaoDoArquivo('agente.pl'),
};

function comparar(a, b) {
  const pa = String(a).replace(/-.*$/, '').split('.').map(Number);
  const pb = String(b).replace(/-.*$/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

/**
 * Caixa vendendo sem conseguir autorizar a NFC-e.
 *  - "travado": houve erro de envio à SEFAZ depois da última nota autorizada e já há venda
 *    sem nota há 2 min. Acontece em algumas lojas: depois de um "Connection reset" o AcruxPDV para
 *    de transmitir e as vendas seguintes saem sem número. Aviso rápido, para agir logo.
 *  - sem erro registrado: 3+ notas paradas há 5 min (rascunho isolado é venda abandonada).
 * A mesma regra roda no painel (painel.js, notasPendentes).
 */
export function problemaFiscal(c, agora = Date.now()) {
  const f = c.online ? c.fiscal : null;
  if (!f || !f.pendentes || !f.pendenteDesde) return null;
  const travado = f.errosEnvio > 0 && agora - f.pendenteDesde >= 2 * 60000;
  const parado = f.pendentes >= 3 && agora - f.pendenteDesde >= 5 * 60000;
  if (!travado && !parado) return null;
  return { pendentes: f.pendentes, desde: f.pendenteDesde, erros: f.errosEnvio || 0, ultimoErro: f.ultimoErro || null, travado };
}

function atualDoTipo(versao) {
  return /-perl$/.test(versao) ? VERSOES_ATUAIS.perl : VERSOES_ATUAIS.python;
}

/**
 * @param {import('express').Express} app
 * @param {{ exigirSessao: Function, exigirAdmin: Function, encerrarSessoesDe: Function, motivoTela: Map, ipDe: Function }} d
 */
export function ligarAdmin(app, { exigirSessao, exigirAdmin, encerrarSessoesDe, motivoTela, ipDe }) {
  const so = [exigirSessao, exigirAdmin];
  // Login na URL só no formato de login (nada de "../", espaços ou "__proto__").
  app.param('login', (req, res, next, valor) =>
    /^[a-z0-9][a-z0-9._-]{0,39}$/i.test(valor) && !/^(__proto__|constructor|prototype)$/i.test(valor)
      ? next()
      : res.status(400).json({ erro: 'Login inválido' }),
  );
  const quem = (req) => ({ usuario: req.sessao.login, ip: ipDe(req) });

  app.get('/api/admin/resumo', so, (req, res) => {
    res.json({
      servidor: req.headers.host,
      porta: config.porta,
      versoesAgente: VERSOES_ATUAIS,
      eu: { login: req.sessao.login, nome: req.sessao.usuario },
    });
  });

  // ------------------------------------------------------------ saúde dos agentes
  app.get('/api/admin/saude', so, (req, res) => {
    const cad = estacoes.cadastro();
    const nomesLojas = Object.fromEntries(cad.lojas.map((l) => [l.codigo, l.nome]));
    const estacoesDoIp = new Map();
    for (const e of cad.estacoes) for (const ip of e.caixas) estacoesDoIp.set(ip, [...(estacoesDoIp.get(ip) || []), e.nome]);
    const cadastrados = new Set(cad.caixas.map((c) => c.ip));
    const agora = Date.now();
    const caixas = estado.lista().map((c) => {
      const manual = c.versao === 'manual';
      const atual = manual ? null : atualDoTipo(c.versao);
      const tela = motivoTela.get(c.id);
      let situacao;
      // PDV normal (com operador) não tem agente: não é problema, é o esperado.
      if (manual && c.tipo === 'pdv') situacao = 'pdv';
      else if (manual) situacao = 'nunca';
      else if (!c.online) situacao = 'sem_contato';
      else if (atual && comparar(c.versao, atual) < 0) situacao = 'desatualizado';
      else situacao = 'ok';
      return {
        id: c.id,
        loja: c.loja,
        pdv: c.pdv,
        nomeLoja: nomesLojas[c.loja] || '',
        ip: c.ip,
        versao: manual ? null : c.versao,
        versaoAtual: atual,
        online: Boolean(c.online),
        ultimoContato: manual ? null : c.ultimoContato,
        situacao,
        telaErro: tela && agora - tela.em < 5 * 60000 ? tela.texto : null,
        fiscal: problemaFiscal(c, agora),
        cadastrado: cadastrados.has(c.ip),
        tipo: c.tipo === 'pdv' ? 'pdv' : 'self',
        estacoes: estacoesDoIp.get(c.ip) || [],
        alerta: c.alerta ? c.alerta.rotulo : null,
        // Tara automática: modo definido e a última tentativa que o agente informou.
        taraModo: modoTara(c.id),
        taraAuto: c.taraAuto || null,
        // Agente que ainda não sabe tarar (anterior à 1.10): a configuração não tem efeito nele.
        taraSuportada: !manual && Boolean(c.versao) && comparar(c.versao, '1.10.0') >= 0,
      };
    });
    res.json({ agora, caixas });
  });

  // ------------------------------------------------------------ lojas, caixas e estações
  app.get('/api/admin/cadastro', so, (req, res) => res.json(estacoes.cadastro()));

  app.put('/api/admin/cadastro', so, (req, res) => {
    const antes = estacoes.cadastro();
    let depois;
    try {
      depois = estacoes.salvar(req.body || {}, String(req.body?.versao || ''));
    } catch (e) {
      return res.status(e.conflito ? 409 : 400).json({ erro: e.message });
    }
    // Caixas que saíram do cadastro: some do painel se o agente estiver desligado;
    // com agente ligado ele continua aparecendo (e o aviso explica como desinstalar).
    const ficaram = new Set(depois.caixas.map((c) => c.ip));
    const comAgente = [];
    for (const c of antes.caixas) {
      if (ficaram.has(c.ip)) continue;
      const id = idCaixa(c.loja, c.pdv);
      const vivo = estado.obter(id);
      if (vivo?.online) comAgente.push({ id, ip: c.ip });
      else if (vivo) estado.remover(id);
    }
    const resumo = String(req.body?.resumo || '').slice(0, 500) || 'cadastro salvo';
    info(`Cadastro (estacoes.json) alterado por ${req.sessao.login}: ${resumo}`);
    eventos.registrar('cadastro', { ...quem(req), detalhe: resumo });
    res.json({ cadastro: depois, comAgente });
  });

  // ------------------------------------------------------------ tara automática
  app.get('/api/admin/tara', so, (req, res) => res.json(configTara()));

  app.put('/api/admin/tara', so, (req, res) => {
    const cad = estacoes.cadastro();
    const antes = configTara();
    let depois;
    try {
      depois = salvarTara(req.body || {}, {
        lojasValidas: new Set(cad.lojas.map((l) => String(l.codigo))),
        caixasValidos: new Set(cad.caixas.map((c) => idCaixa(c.loja, c.pdv))),
      });
    } catch (e) {
      return res.status(e.validacao ? 400 : 500).json({ erro: e.validacao ? e.message : 'Não foi possível gravar' });
    }
    // Registro: o que mudou, em português.
    const nomeModo = { desligado: 'desligada', precisa: 'só quando a tara final ficar com peso', sempre: 'depois de toda venda' };
    const mudancas = [];
    for (const l of new Set([...Object.keys(antes.lojas), ...Object.keys(depois.lojas)])) {
      const a = antes.lojas[l] || 'desligado';
      const d = depois.lojas[l] || 'desligado';
      if (a !== d) mudancas.push(`loja ${l}: ${nomeModo[d]}`);
    }
    for (const id of new Set([...Object.keys(antes.caixas), ...Object.keys(depois.caixas)])) {
      if (antes.caixas[id] !== depois.caixas[id]) mudancas.push(`caixa ${id}: ${depois.caixas[id] ? nomeModo[depois.caixas[id]] : 'segue a loja'}`);
    }
    if (mudancas.length) {
      eventos.registrar('tara_config', { ...quem(req), detalhe: mudancas.join('; ').slice(0, 300) });
      info(`Tara automática alterada por ${req.sessao.login}: ${mudancas.join('; ')}`);
    }
    res.json(depois);
  });

  // ------------------------------------------------------------ usuários
  const admins = () => usuarios.listar().filter((u) => u.perfil === 'admin' && u.ativo);
  const falha = (res, e, codigo = 400) => res.status(codigo).json({ erro: e.message || String(e) });

  app.get('/api/admin/usuarios', so, (req, res) => res.json(usuarios.listar().sort((a, b) => a.login.localeCompare(b.login))));

  app.post('/api/admin/usuarios', so, (req, res) => {
    const { login, nome, perfil, senha } = req.body || {};
    if ([login, perfil, senha].some((v) => typeof v !== 'string') || (nome != null && typeof nome !== 'string')) {
      return falha(res, new Error('Informe login, perfil e senha'));
    }
    try {
      usuarios.criar(login, senha, { nome: String(nome || '').trim() || undefined, perfil });
    } catch (e) {
      return falha(res, e);
    }
    eventos.registrar('usuario', { ...quem(req), detalhe: `criou "${String(login).toLowerCase()}" (${perfil})` });
    res.json({ ok: true });
  });

  app.patch('/api/admin/usuarios/:login', so, (req, res) => {
    const alvo = req.params.login.toLowerCase();
    const atual = usuarios.listar().find((u) => u.login === alvo);
    if (!atual) return falha(res, new Error('Usuário não existe'), 404);
    const { nome, perfil, ativo } = req.body || {};
    // Tipos exatos: "false" (texto) não pode virar "ativo".
    if ((nome !== undefined && typeof nome !== 'string') || (perfil !== undefined && typeof perfil !== 'string') || (ativo !== undefined && typeof ativo !== 'boolean')) {
      return falha(res, new Error('Dados inválidos'));
    }
    const perdeAdmin = atual.perfil === 'admin' && atual.ativo && ((perfil && perfil !== 'admin') || ativo === false);
    if (perdeAdmin && admins().length <= 1) return falha(res, new Error('Este é o único usuário TI / Administrador ativo. Crie outro antes.'));
    if (alvo === req.sessao.login && (ativo === false || (perfil && perfil !== 'admin'))) {
      return falha(res, new Error('Você não pode desativar nem rebaixar a sua própria conta.'));
    }
    try {
      usuarios.atualizar(alvo, { nome, perfil, ativo });
    } catch (e) {
      return falha(res, e);
    }
    const mudancas = [
      nome !== undefined && nome !== atual.nome && `nome "${nome}"`,
      perfil && perfil !== atual.perfil && `perfil ${perfil}`,
      ativo !== undefined && ativo !== atual.ativo && (ativo ? 'reativou' : 'desativou'),
    ].filter(Boolean);
    // Desativado ou com perfil mudado: as sessões abertas caem (entra de novo com o perfil certo).
    if (ativo === false || (perfil && perfil !== atual.perfil)) encerrarSessoesDe(alvo);
    if (mudancas.length) eventos.registrar('usuario', { ...quem(req), detalhe: `${alvo}: ${mudancas.join(', ')}` });
    res.json({ ok: true });
  });

  app.post('/api/admin/usuarios/:login/senha', so, (req, res) => {
    const alvo = req.params.login.toLowerCase();
    if (typeof req.body?.senha !== 'string') return falha(res, new Error('Informe a senha'));
    try {
      usuarios.trocarSenha(alvo, req.body.senha);
    } catch (e) {
      return falha(res, e);
    }
    // Senha trocada: quem estava logado com a senha antiga sai (menos a própria sessão de quem trocou).
    encerrarSessoesDe(alvo, alvo === req.sessao.login ? req.tokenSessao : null);
    eventos.registrar('usuario', { ...quem(req), detalhe: `trocou a senha de "${alvo}"` });
    res.json({ ok: true });
  });

  app.delete('/api/admin/usuarios/:login', so, (req, res) => {
    const alvo = req.params.login.toLowerCase();
    const atual = usuarios.listar().find((u) => u.login === alvo);
    if (!atual) return falha(res, new Error('Usuário não existe'), 404);
    if (alvo === req.sessao.login) return falha(res, new Error('Você não pode remover a sua própria conta.'));
    if (atual.perfil === 'admin' && atual.ativo && admins().length <= 1) {
      return falha(res, new Error('Este é o único usuário TI / Administrador ativo. Crie outro antes.'));
    }
    try {
      usuarios.remover(alvo);
    } catch (e) {
      return falha(res, e);
    }
    encerrarSessoesDe(alvo);
    eventos.registrar('usuario', { ...quem(req), detalhe: `removeu "${alvo}"` });
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ registro de ações
  app.get('/api/admin/eventos', so, (req, res) => {
    // Filtros só no formato esperado; qualquer outra coisa é ignorada (não vira busca).
    const q = req.query;
    const s = (v) => (typeof v === 'string' ? v : '');
    const tipo = Object.hasOwn(eventos.TIPOS_EVENTO, s(q.tipo)) ? s(q.tipo) : undefined;
    const usuario = /^[a-z0-9._-]{1,40}$/.test(s(q.usuario)) ? s(q.usuario) : undefined;
    const loja = /^\d{1,4}$/.test(s(q.loja)) ? s(q.loja) : undefined;
    const caixa = /^\d{1,4}-\d{1,3}$/.test(s(q.caixa)) ? s(q.caixa) : undefined;
    const numeroOu = (v) => (/^\d{1,15}$/.test(s(v)) ? Number(v) : undefined);
    res.json({
      tipos: eventos.TIPOS_EVENTO,
      eventos: eventos.consultar({ de: numeroOu(q.de), ate: numeroOu(q.ate), tipo, usuario, loja, caixa, limite: numeroOu(q.limite) }),
    });
  });
  // ------------------------------------------------------------ indicadores (dashboard)
  app.get('/api/admin/indicadores', so, (req, res) => {
    const s = (v) => (typeof v === 'string' ? v : '');
    const num = (v) => (/^\d{1,15}$/.test(s(v)) ? Number(v) : undefined);
    const ate = num(req.query.ate) ?? Date.now();
    const de = num(req.query.de) ?? ate - 864e5;
    if (de > ate || ate - de > 400 * 864e5) return res.status(400).json({ erro: 'Período inválido (máximo de 400 dias)' });
    const loja = /^\d{1,4}$/.test(s(req.query.loja)) ? Number(req.query.loja) : undefined;
    const tipo = ['pdv', 'todos'].includes(s(req.query.tipo)) ? s(req.query.tipo) : 'self';
    res.json(indicadores.calcular({ de, ate, loja, tipo }));
  });

  app.get('/api/admin/eventos/usuarios', so, (req, res) => {
    const nomes = new Set([...usuarios.listar().map((u) => u.login), ...eventos.usuariosNoRegistro()]);
    res.json([...nomes].sort());
  });
}
