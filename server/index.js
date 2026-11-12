import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';
import { RAIZ, config } from './config.js';
import { estado, idCaixa, TIPOS_ALERTA } from './estado.js';
import { info, aviso, erro } from './log.js';
import { ligarVnc } from './vnc-proxy.js';
import * as usuarios from './usuarios.js';
import { estacoes, podeVer, tipoCaixa } from './estacoes.js';
import * as eventos from './eventos.js';
import { ligarAdmin } from './admin.js';
import * as indicadores from './indicadores.js';
import { modoTara } from './tara.js';
import { cabecalhos, exigirMesmaOrigem, origemOk, Limitador, segredoIgual, textoLimpo, agenteLimpo } from './seguranca.js';

// ---------------------------------------------------------------- sessões do painel
const DURACAO_SESSAO = 12 * 60 * 60 * 1000;
// Sessões gravadas em disco: reiniciar o servidor não derruba o login das lojas.
const ARQ_SESSOES = path.join(RAIZ, 'data', 'sessoes.json');
const sessoes = new Map(); // token -> { login, nome, perfil, usuario, expira }
try {
  for (const [token, s] of Object.entries(JSON.parse(fs.readFileSync(ARQ_SESSOES, 'utf8')))) {
    if (s.expira > Date.now()) sessoes.set(token, s);
  }
} catch {}
function gravarSessoes() {
  const vivas = Object.fromEntries([...sessoes].filter(([, s]) => s.expira > Date.now()));
  fs.mkdirSync(path.dirname(ARQ_SESSOES), { recursive: true });
  fs.writeFile(ARQ_SESSOES, JSON.stringify(vivas), { mode: 0o600 }, () => {});
}

function lerCookie(req, nome) {
  const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${nome}=([^;]{1,200})`));
  if (!m) return null;
  // Cookie malformado (ex.: "%E0") não pode derrubar o servidor: vira "sem sessão".
  try {
    const valor = decodeURIComponent(m[1]);
    return /^[a-f0-9]{48}$/.test(valor) ? valor : null;
  } catch {
    return null;
  }
}

function sessaoDe(req) {
  const token = lerCookie(req, 'sessao');
  const s = token && sessoes.get(token);
  if (!s || s.expira < Date.now()) return null;
  // Usuário removido ou desativado perde o acesso na hora, mesmo com sessão aberta.
  if (!usuarios.podeEntrar(s.login)) {
    sessoes.delete(token);
    gravarSessoes();
    return null;
  }
  return s;
}

/** Derruba as sessões de um usuário (senha trocada, desativado, removido). */
function encerrarSessoesDe(login, excetoToken = null) {
  let mudou = false;
  for (const [token, s] of sessoes) {
    if (s.login === login && token !== excetoToken) {
      sessoes.delete(token);
      mudou = true;
    }
  }
  if (mudou) gravarSessoes();
  // Painéis e telas abertos com essas sessões também fecham na hora.
  for (const wss of [wssPainel, wssVnc]) {
    for (const ws of wss.clients) {
      if (ws.sessao?.login === login && (!excetoToken || ws.token !== excetoToken)) ws.close(4003, 'Sessão encerrada');
    }
  }
}

function exigirSessao(req, res, next) {
  const s = sessaoDe(req);
  if (!s) return res.status(401).json({ erro: 'Não autenticado' });
  req.sessao = s;
  req.tokenSessao = lerCookie(req, 'sessao');
  req.acesso = estacoes.acessoDe(ipDe(req), s.perfil);
  next();
}

function exigirAdmin(req, res, next) {
  if (req.sessao.perfil !== 'admin') return res.status(403).json({ erro: 'Somente o nível TI / Administrador' });
  next();
}

// Bloqueio por tentativas erradas:
//  - por computador: 5 erros em 15 min = 5 min bloqueado;
//  - por login: 10 erros em 15 min (de qualquer computador) = 15 min bloqueado, contra quem
//    tenta adivinhar a senha de uma conta trocando de máquina.
const tentativasIp = new Limitador({ maximo: 5, janelaMs: 15 * 60e3, bloqueioMs: 5 * 60e3 });
const tentativasLogin = new Limitador({ maximo: 10, janelaMs: 15 * 60e3, bloqueioMs: 15 * 60e3 });
// Agente com token errado: 20 erros em 5 min = IP ignorado por 10 min.
const tentativasAgente = new Limitador({ maximo: 20, janelaMs: 5 * 60e3, bloqueioMs: 10 * 60e3 });

// ---------------------------------------------------------------- HTTP
const app = express();
app.disable('x-powered-by');
app.set('etag', false);
app.use(cabecalhos);
// CSRF: pedidos que mudam algo (POST/PUT/PATCH/DELETE) só da própria página do painel.
app.use('/api', exigirMesmaOrigem);
// Pedidos pequenos no painel; a administração grava o cadastro inteiro de uma vez (maior).
const jsonPequeno = express.json({ limit: '32kb' });
const jsonAdmin = express.json({ limit: '512kb' });
app.use((req, res, next) =>
  (req.path.startsWith('/api/admin') || req.path === '/api/agente/historico' ? jsonAdmin : jsonPequeno)(req, res, next),
);

// As páginas saem com "?v=<data do arquivo>" em cada CSS/JS. Assim, quando um arquivo muda,
// os navegadores das lojas baixam a versão nova sozinhos, sem precisar de Ctrl+F5.
const PUBLICO = path.join(RAIZ, 'public');
function versaoDe(arquivo) {
  try {
    return Math.floor(fs.statSync(path.join(PUBLICO, arquivo)).mtimeMs).toString(36);
  } catch {
    return '0';
  }
}
function servirPagina(arquivo) {
  return (req, res) => {
    const html = fs
      .readFileSync(path.join(PUBLICO, arquivo), 'utf8')
      .replace(/(href|src)="((?:vendor\/)?[\w.-]+\.(?:css|js))"/g, (_, attr, url) => `${attr}="${url}?v=${versaoDe(url)}"`);
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html);
  };
}
const estaticos = express.static(PUBLICO, { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') });
app.get(['/', '/index.html'], servirPagina('index.html'));
// Administração na mesma porta do painel, em /admin (só perfil TI / Administrador).
app.get('/admin', servirPagina('admin.html'));
app.get('/admin/', (req, res) => res.redirect(301, '/admin'));
app.use(estaticos);

// Login, saída e "quem sou eu" (usados pelo painel e pela administração).
const comum = express.Router();
app.use(comum);

comum.get('/api/config', (req, res) => {
  res.json({ tiposAlerta: TIPOS_ALERTA, temUsuarios: usuarios.existeAlgum(), portaPainel: config.porta });
});

comum.post('/api/login', (req, res) => {
  const ip = ipDe(req);
  // Só texto simples: objeto/array no lugar de usuário ou senha é recusado.
  if (typeof req.body?.usuario !== 'string' || typeof req.body?.senha !== 'string') {
    return res.status(400).json({ erro: 'Informe usuário e senha' });
  }
  const login = textoLimpo(req.body.usuario, 40).toLowerCase();
  const senha = req.body.senha;
  if (!login || !senha || senha.length > 200) return res.status(400).json({ erro: 'Informe usuário e senha' });

  const ate = Math.max(tentativasIp.bloqueadoAte(ip), tentativasLogin.bloqueadoAte(login));
  if (ate) {
    const min = Math.ceil((ate - Date.now()) / 60000);
    return res.status(429).json({ erro: `Muitas tentativas erradas. Tente de novo em ${min} min.` });
  }

  const u = usuarios.autenticar(login, senha);
  if (!u) {
    if (tentativasIp.erro(ip)) aviso(`IP ${ip} bloqueado por 5 min após tentativas de login erradas`);
    if (tentativasLogin.erro(login)) aviso(`Login "${login}" bloqueado por 15 min após tentativas erradas`);
    aviso(`Login recusado para "${login}" (${ip})`);
    eventos.registrar('login_recusado', { usuario: login, ip });
    return res.status(401).json({ erro: 'Usuário ou senha inválido' });
  }
  tentativasIp.acerto(ip);
  tentativasLogin.acerto(login);

  const token = crypto.randomBytes(24).toString('hex');
  sessoes.set(token, { ...u, usuario: u.nome, expira: Date.now() + DURACAO_SESSAO });
  gravarSessoes();
  info(`Login no painel: ${u.login} (${ip})`);
  usuarios.marcarAcesso(u.login);
  eventos.registrar('login', { usuario: u.login, ip, detalhe: estacoes.acessoDe(ip, u.perfil).estacao || 'sem estação' });
  res.setHeader(
    'Set-Cookie',
    `sessao=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${DURACAO_SESSAO / 1000}${req.secure ? '; Secure' : ''}`,
  );
  res.json({ usuario: u.nome });
});

comum.post('/api/logout', (req, res) => {
  const token = lerCookie(req, 'sessao');
  const s = token && sessoes.get(token);
  if (s) eventos.registrar('saiu', { usuario: s.login, ip: ipDe(req) });
  if (token && sessoes.delete(token)) gravarSessoes();
  res.setHeader('Set-Cookie', 'sessao=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});

comum.get('/api/eu', exigirSessao, (req, res) =>
  res.json({
    usuario: req.sessao.usuario,
    login: req.sessao.login,
    perfil: req.sessao.perfil,
    ip: ipDe(req),
    estacao: req.acesso.estacao,
    veTodos: req.acesso.todos,
  }),
);
app.get('/api/caixas', exigirSessao, (req, res) => res.json(estado.lista().filter((c) => podeVer(req.acesso, c))));

// Cadastro manual (sem agente): útil para acessar a tela de um caixa antes de instalar o agente.
app.post('/api/caixas', exigirSessao, exigirAdmin, (req, res) => {
  const { loja, pdv, ip, portaVnc, nome } = req.body || {};
  if (!Number.isInteger(loja) || !Number.isInteger(pdv) || !net.isIPv4(String(ip))) {
    return res.status(400).json({ erro: 'Informe loja, pdv (números) e ip (IPv4)' });
  }
  const id = idCaixa(loja, pdv);
  if (estado.obter(id)?.online) return res.status(409).json({ erro: 'Caixa já conectado pelo agente' });
  estado.registrar({ loja, pdv, ip, portaVnc, nome, versao: 'manual' });
  estado.atualizar(id, { online: false, conectado: false, ultimoContato: Date.now() });
  info(`Caixa ${id} (${ip}) cadastrado manualmente por ${req.sessao.login}`);
  res.json(estado.obter(id));
});

app.delete('/api/caixas/:id', exigirSessao, exigirAdmin, (req, res) => {
  const caixa = estado.obter(req.params.id);
  if (!caixa) return res.status(404).json({ erro: 'Caixa não encontrado' });
  if (caixa.online) return res.status(409).json({ erro: 'Caixa ainda conectado' });
  estado.remover(req.params.id);
  info(`Caixa ${req.params.id} removido por ${req.sessao.login}`);
  res.json({ ok: true });
});

const servidor = http.createServer(app);

// ---------------------------------------------------------------- WebSockets
const wssAgente = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const wssPainel = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
const wssVnc = new WebSocketServer({ noServer: true });

servidor.on('upgrade', (req, socket, head) => {
  const { pathname, searchParams } = new URL(req.url, 'http://x');
  const recusar = (codigo, texto) => {
    socket.write(`HTTP/1.1 ${codigo} ${texto}\r\n\r\n`);
    socket.destroy();
  };

  if (pathname === '/ws/agente') {
    return wssAgente.handleUpgrade(req, socket, head, (ws) => wssAgente.emit('connection', ws, req));
  }
  // WebSocket do painel e da tela: só a partir da própria página do painel (bloqueia
  // "Cross-Site WebSocket Hijacking", um site de fora usando o login do fiscal).
  if (!origemOk(req)) {
    aviso(`WebSocket recusado: origem ${String(req.headers.origin).slice(0, 80)} (${ipDe(req)})`);
    return recusar(403, 'Forbidden');
  }
  const sessao = sessaoDe(req);
  if (!sessao) return recusar(401, 'Unauthorized');

  if (pathname === '/ws/painel') {
    return wssPainel.handleUpgrade(req, socket, head, (ws) => wssPainel.emit('connection', ws, req, sessao));
  }
  const m = pathname.match(/^\/vnc\/(\d+-\d+)$/);
  if (m) {
    const caixa = estado.obter(m[1]);
    if (!caixa) return recusar(404, 'Not Found');
    if (!podeVer(estacoes.acessoDe(ipDe(req), sessao.perfil), caixa)) {
      aviso(`${sessao.login} (${ipDe(req)}) tentou abrir a tela do caixa ${caixa.id} sem permissão`);
      return recusar(403, 'Forbidden');
    }
    const miniatura = searchParams.get('modo') === 'miniatura';
    return wssVnc.handleUpgrade(req, socket, head, (ws) => wssVnc.emit('connection', ws, req, sessao, caixa, miniatura));
  }
  recusar(404, 'Not Found');
});

function ipDe(req) {
  const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return ip === '::1' ? '127.0.0.1' : ip;
}

function compararVersao(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// ---- Agentes (um por caixa)
const agentes = new Map(); // idCaixa -> ws
// Tara automática: o agente repete a última tara em todo envio; o registro entra uma vez,
// quando o resultado fica conhecido (ok true/false).
const taraRegistrada = new Map(); // idCaixa -> "em:ok"
function registrarTaraAuto(id, t, ip) {
  if (!t || t.ok == null) return;
  const chave = `${t.em}:${t.ok}`;
  if (taraRegistrada.get(id) === chave) return;
  const primeira = !taraRegistrada.has(id);
  taraRegistrada.set(id, chave);
  // Depois de reiniciar o servidor, a tara antiga que o agente ainda repete não entra de novo.
  if (primeira && Date.now() - t.em > 120_000) return;
  const peso = t.peso == null ? '' : ` · balança em ${String(t.peso.toFixed(3)).replace('.', ',')} kg depois`;
  eventos.registrar('tara_auto', { caixa: id, ip, detalhe: `${t.ok ? 'Feita' : 'Não feita'}: ${t.motivo}${t.ok ? peso : ''}` });
  if (!t.ok) aviso(`Tara automática não feita no caixa ${id}: ${t.motivo}`);
}

const filaComandos = new Map(); // idCaixa -> comandos para agentes HTTP (Linux/Python)

function enviarAoAgente(id, obj) {
  const ws = agentes.get(id);
  if (ws && ws.readyState === ws.OPEN) return ws.send(JSON.stringify(obj));
  const fila = filaComandos.get(id) || [];
  fila.push(obj);
  filaComandos.set(id, fila.slice(-20));
}

/**
 * Confere um agente. `msg` já passou por agenteLimpo (tipos e tamanhos garantidos).
 * Um caixa cadastrado no estacoes.json só é aceito vindo do IP cadastrado: um caixa invadido
 * não consegue se passar por outro (e desviar a tela/alertas dele).
 */
function validarAgente(msg, token, ip) {
  if (!segredoIgual(token, config.tokenAgente)) return 'token inválido';
  if (msg.loja == null || msg.pdv == null) return 'loja/pdv inválidos';
  if (compararVersao(msg.versao, config.versaoMinimaAgente) < 0) {
    return `versão ${msg.versao}, mínima exigida é ${config.versaoMinimaAgente}`;
  }
  const cadastrado = estacoes.caixasCadastrados().find((c) => c.loja === msg.loja && c.pdv === msg.pdv);
  if (cadastrado && cadastrado.ip !== ip) return `loja ${msg.loja} PDV ${msg.pdv} está cadastrado com o IP ${cadastrado.ip}`;
  return null;
}

// Agente por HTTP (polling): cada POST traz o estado completo do caixa e
// a resposta devolve os comandos pendentes. Usado pelo agente Python dos PDVs Linux.
app.post('/api/agente', (req, res) => {
  const ip = ipDe(req);
  if (tentativasAgente.bloqueadoAte(ip)) return res.status(429).json({ erro: 'muitas tentativas com token inválido' });
  const msg = agenteLimpo(req.body, TIPOS_ALERTA);
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const motivo = validarAgente(msg, token, ip);
  if (motivo) {
    if (motivo === 'token inválido' && tentativasAgente.erro(ip)) aviso(`IP ${ip} bloqueado por 10 min: token de agente inválido`);
    aviso(`Conexão negada para IP ${ip}: ${motivo}`);
    return res.status(403).json({ erro: motivo });
  }
  const id = idCaixa(msg.loja, msg.pdv);
  const atual = estado.obter(id);
  if (!atual || !atual.online || atual.ip !== ip || atual.versao !== msg.versao) {
    estado.registrar({ ...msg, ip });
    if (!atual?.online) info(`Caixa ${id} conectado via HTTP (IP ${ip}, agente ${msg.versao})`);
  }
  estado.heartbeat(id, msg);

  // O agente sempre manda o alerta atual (ou null); o servidor sincroniza.
  // Se há um "liberar" ainda não entregue, o alerta que veio é antigo: ignora.
  const caixa = estado.obter(id);
  const pdvNormal = caixa?.tipo === 'pdv';
  const liberacaoPendente = (filaComandos.get(id) || []).some((c) => c.acao === 'liberar');
  // PDV normal (com operador): só o pedido de senha do fiscal vira alerta. Qualquer outro tipo
  // (peso, mensagem, chamado) é situação de self e é descartado aqui.
  const alertaRecebido = pdvNormal && msg.alerta?.alerta !== 'fiscal' ? null : msg.alerta;
  if (liberacaoPendente) {
    // nada: o agente vai limpar o alerta ao receber o comando
  } else if (alertaRecebido?.alerta) {
    if (!caixa.alerta || caixa.alerta.tipo !== alertaRecebido.alerta) {
      estado.abrirAlerta(id, { tipo: alertaRecebido.alerta, mensagem: alertaRecebido.mensagem });
    }
  } else if (caixa.alerta) {
    estado.fecharAlerta(id, 'resolvido no caixa');
  }

  registrarTaraAuto(id, msg.taraAuto, ip);

  const comandos = filaComandos.get(id) || [];
  filaComandos.delete(id);
  // config: o que o painel definiu para este caixa (hoje, a tara automática).
  res.json({
    id,
    comandos,
    intervalo: 5,
    config: { tipo: pdvNormal ? 'pdv' : 'self', taraAuto: pdvNormal ? 'desligado' : modoTara(id) },
  });
});

// Histórico do caixa (recuperação depois de queda do painel): vendas de cada dia pelas notas
// NFC-e e os "Self chamou o fiscal" do log diário do AcruxPDV, com o horário original.
app.post('/api/agente/historico', (req, res) => {
  const ip = ipDe(req);
  if (tentativasAgente.bloqueadoAte(ip)) return res.status(429).json({ erro: 'muitas tentativas com token inválido' });
  const corpo = req.body || {};
  const msg = agenteLimpo(corpo, TIPOS_ALERTA);
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const motivo = validarAgente(msg, token, ip);
  if (motivo) {
    if (motivo === 'token inválido') tentativasAgente.erro(ip);
    return res.status(403).json({ erro: motivo });
  }
  // Formato estrito: até 400 dias, números dentro da faixa, horários dentro do próprio dia.
  if (!Array.isArray(corpo.dias) || corpo.dias.length > 400) return res.status(400).json({ erro: 'dias inválidos' });
  const dias = [];
  for (const d of corpo.dias) {
    if (!d || typeof d !== 'object' || !/^\d{4}-\d{2}-\d{2}$/.test(String(d.dia))) continue;
    const inicio = new Date(`${d.dia}T00:00:00`).getTime();
    if (!Number.isFinite(inicio) || inicio > Date.now() || inicio < Date.now() - 400 * 864e5) continue;
    const vendas = Number.isInteger(d.vendas) && d.vendas >= 0 && d.vendas <= 100_000 ? d.vendas : null;
    const total = typeof d.total === 'number' && d.total >= 0 && d.total <= 1e9 ? Math.round(d.total * 100) / 100 : null;
    const chamados = (Array.isArray(d.chamados) ? d.chamados.slice(0, 500) : [])
      .filter((c) => Array.isArray(c) && Number.isFinite(c[0]) && c[0] >= inicio - 3600e3 && c[0] < inicio + 25 * 3600e3)
      .map(([ini, fim]) => [Math.round(ini), Number.isFinite(fim) && fim >= ini && fim - ini < 24 * 3600e3 ? Math.round(fim) : null]);
    // Contingência (agente 1.9+): notas do dia que ficaram sem autorização no caixa.
    const contingencia = Number.isInteger(d.contingencia) && d.contingencia >= 0 && d.contingencia <= 100_000 ? d.contingencia : null;
    const valorCont = typeof d.valorContingencia === 'number' && d.valorContingencia >= 0 && d.valorContingencia <= 1e9 ? Math.round(d.valorContingencia * 100) / 100 : null;
    dias.push({
      dia: d.dia,
      vendas,
      total: vendas == null ? null : total,
      contingencia,
      valorContingencia: contingencia == null ? null : valorCont,
      chamados,
    });
  }
  const id = idCaixa(msg.loja, msg.pdv);
  let r;
  try {
    r = indicadores.receberHistorico(id, dias);
  } catch (e) {
    erro(`Histórico do caixa ${id}: ${e.message}`);
    return res.status(500).json({ erro: 'falha ao gravar o histórico' });
  }
  if (r.diasVendas || r.chamados) {
    info(`Histórico do caixa ${id}: ${r.diasVendas} dia(s) de vendas atualizados, ${r.chamados} chamado(s) recuperado(s)`);
    eventos.registrar('historico', { caixa: id, ip, detalhe: `${dias.length} dias lidos: ${r.diasVendas} de vendas atualizados, ${r.chamados} chamados recuperados` });
  }
  res.json({ ok: true, ...r });
});

wssAgente.on('connection', (ws, req) => {
  const ip = ipDe(req);
  let id = null;
  const envia = (obj) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj));
  const fecha = (motivo) => {
    aviso(`Conexão negada para IP ${ip}: ${motivo}`);
    envia({ tipo: 'recusado', motivo });
    ws.close(4001, motivo.slice(0, 100));
  };
  const timerOla = setTimeout(() => !id && fecha('não se identificou a tempo'), 5000);

  ws.on('message', (bruto) => {
    let msg;
    try {
      msg = JSON.parse(bruto);
    } catch {
      return;
    }

    if (!msg || typeof msg !== 'object') return;
    if (!id) {
      if (msg.tipo !== 'ola') return fecha('primeira mensagem deve ser "ola"');
      if (tentativasAgente.bloqueadoAte(ip)) return fecha('muitas tentativas com token inválido');
      const limpo = agenteLimpo(msg, TIPOS_ALERTA);
      const motivo = validarAgente(limpo, msg.token, ip);
      if (motivo) {
        if (motivo === 'token inválido') tentativasAgente.erro(ip);
        return fecha(motivo);
      }
      clearTimeout(timerOla);
      id = idCaixa(limpo.loja, limpo.pdv);
      agentes.get(id)?.close(4002, 'Substituído por nova conexão');
      agentes.set(id, ws);
      estado.registrar({ ...limpo, ip });
      info(`Caixa ${id} conectado (IP ${ip}, agente ${limpo.versao})`);
      return envia({ tipo: 'bemvindo', id });
    }

    switch (msg.tipo) {
      case 'heartbeat':
        estado.heartbeat(id, agenteLimpo(msg, TIPOS_ALERTA));
        break;
      case 'alerta': {
        const a = agenteLimpo({ alerta: { alerta: msg.alerta, mensagem: msg.mensagem } }, TIPOS_ALERTA).alerta;
        if (a) estado.abrirAlerta(id, { tipo: a.alerta, mensagem: a.mensagem });
        break;
      }
      case 'alerta_fim':
        estado.fecharAlerta(id, 'resolvido no caixa');
        break;
    }
  });

  ws.on('close', () => {
    clearTimeout(timerOla);
    if (id && agentes.get(id) === ws) {
      agentes.delete(id);
      estado.desconectou(id);
      info(`Caixa ${id} desconectou`);
    }
  });
  ws.on('error', () => {});
});

// ---- Painéis (navegadores dos supervisores)
// Cada painel só recebe os caixas que o computador dele pode ver.
function enviarInicial(ws) {
  ws.acesso = estacoes.acessoDe(ws.ip, ws.sessao.perfil);
  const caixas = estado.lista().filter((c) => podeVer(ws.acesso, c));
  ws.send(
    JSON.stringify({ tipo: 'inicial', caixas, agora: Date.now(), estacao: ws.acesso.estacao, lojas: estacoes.dados.lojas || {} }),
  );
}

estado.on('mudou', (caixa) => {
  for (const ws of wssPainel.clients) {
    if (ws.readyState !== ws.OPEN) continue;
    ws.send(JSON.stringify(podeVer(ws.acesso, caixa) ? { tipo: 'caixa', caixa } : { tipo: 'removido', id: caixa.id }));
  }
});
estado.on('removido', (id) => {
  for (const ws of wssPainel.clients) if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ tipo: 'removido', id }));
});

// Caixas listados no estacoes.json aparecem mesmo antes de o agente ser instalado.
function cadastrarCaixasDasEstacoes() {
  for (const c of estacoes.caixasCadastrados()) {
    const id = idCaixa(c.loja, c.pdv);
    const tipo = tipoCaixa(c);
    let atual = estado.obter(id);
    if (!atual?.online && !(atual && atual.ip === c.ip && atual.nome === (c.nome || atual.nome) && (atual.portaVnc === (c.portaVnc || atual.portaVnc)))) {
      estado.registrar({ loja: c.loja, pdv: c.pdv, ip: c.ip, nome: c.nome, portaVnc: c.portaVnc, versao: atual?.versao || 'manual' });
      atual = estado.atualizar(id, { online: false, conectado: false, ultimoContato: atual?.ultimoContato || Date.now() });
    }
    // Self ou PDV normal (o painel separa os dois para a TI).
    if (atual && atual.tipo !== tipo) estado.atualizar(id, { tipo });
  }
}
cadastrarCaixasDasEstacoes();
estacoes.on('mudou', () => {
  cadastrarCaixasDasEstacoes();
  for (const ws of wssPainel.clients) if (ws.readyState === ws.OPEN) enviarInicial(ws);
});

wssPainel.on('connection', (ws, req, sessao) => {
  ws.sessao = sessao;
  ws.token = lerCookie(req, 'sessao');
  ws.ip = ipDe(req);
  enviarInicial(ws);

  ws.on('message', (bruto) => {
    let msg;
    try {
      msg = JSON.parse(bruto);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.id !== 'string') return;
    // A sessão pode ter acabado (expirou, usuário desativado) com a conexão ainda aberta.
    if (!sessoes.has(ws.token) || sessao.expira < Date.now() || !usuarios.podeEntrar(sessao.login)) {
      return ws.close(4003, 'Sessão encerrada');
    }
    const caixa = estado.obter(msg.id);
    if (!caixa || !podeVer(ws.acesso, caixa)) return;
    if (msg.tipo === 'atender') {
      if (caixa.alerta) eventos.registrar('atender', { usuario: sessao.login, ip: ws.ip, caixa: msg.id, alerta: caixa.alerta.tipo, detalhe: caixa.alerta.rotulo });
      estado.atenderAlerta(msg.id, sessao.usuario);
      enviarAoAgente(msg.id, { tipo: 'comando', acao: 'atendimento_a_caminho', usuario: sessao.usuario });
    } else if (msg.tipo === 'resolver') {
      if (caixa.alerta) {
        const s = Math.round((Date.now() - caixa.alerta.desde) / 1000);
        eventos.registrar('liberar', { usuario: sessao.login, ip: ws.ip, caixa: msg.id, alerta: caixa.alerta.tipo, segundos: s, detalhe: `${caixa.alerta.rotulo} · aberto por ${s}s` });
      }
      estado.fecharAlerta(msg.id, `resolvido por ${sessao.usuario}`);
      enviarAoAgente(msg.id, { tipo: 'comando', acao: 'liberar', usuario: sessao.usuario });
    }
  });
  ws.on('error', () => {});
});

// Mantém conexões vivas e derruba as mortas.
setInterval(() => {
  for (const wss of [wssAgente, wssPainel]) {
    for (const ws of wss.clients) {
      if (ws.vivo === false) {
        ws.terminate();
        continue;
      }
      ws.vivo = false;
      ws.ping();
    }
  }
}, 15000).unref();
for (const wss of [wssAgente, wssPainel]) {
  wss.on('connection', (ws) => {
    ws.vivo = true;
    ws.on('pong', () => (ws.vivo = true));
  });
}

// ---- Proxy VNC: WebSocket (noVNC no navegador) <-> TCP (servidor VNC do caixa)
// Miniaturas do painel: só imagem, sem teclado/mouse. Erros de miniatura são registrados
// no máximo uma vez por minuto por caixa, porque cada painel aberto reconecta sozinho.
const ultimoErroMiniatura = new Map();
const motivoTela = new Map(); // idCaixa -> { em, texto } (texto pensado para o fiscal)

function motivoParaFiscal(m) {
  if (/pede senha VNC/.test(m)) return 'A tela deste caixa pede senha e o servidor não tem a senha VNC. Avise a TI.';
  if (/Senha VNC recusada/.test(m)) return 'O caixa recusou a senha VNC do servidor. Avise a TI.';
  if (/ECONNREFUSED/.test(m)) return 'O caixa recusou a conexão de tela (VNC desligado?). Avise a TI.';
  if (/tempo esgotado|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH/.test(m)) return 'O caixa não respondeu. Ele pode estar desligado ou fora da rede.';
  return 'Não foi possível abrir a tela deste caixa.';
}

app.get('/api/telas/:id/motivo', exigirSessao, (req, res) => {
  const caixa = estado.obter(req.params.id);
  if (!caixa || !podeVer(req.acesso, caixa)) return res.status(404).json({});
  const m = motivoTela.get(req.params.id);
  res.json(m && Date.now() - m.em < 5 * 60000 ? { texto: m.texto } : {});
});

wssVnc.on('connection', (ws, req, sessao, caixa, miniatura) => {
  ws.sessao = sessao;
  ws.token = lerCookie(req, 'sessao');
  const destino = `${caixa.ip}:${caixa.portaVnc}`;
  const opcoes = { host: caixa.ip, porta: caixa.portaVnc, senha: config.senhaVnc, somenteVer: miniatura };
  if (miniatura) {
    ws.on('message', () => motivoTela.delete(caixa.id));
    ligarVnc(ws, opcoes, (m) => {
      motivoTela.set(caixa.id, { em: Date.now(), texto: motivoParaFiscal(m) });
      if (Date.now() - (ultimoErroMiniatura.get(caixa.id) || 0) < 60000) return;
      ultimoErroMiniatura.set(caixa.id, Date.now());
      aviso(`Miniatura VNC ${caixa.id} (${destino}): ${m}`);
    });
    return;
  }
  info(`Acesso remoto ao caixa ${caixa.id} (${destino}) por ${sessao.login} (${ipDe(req)})`);
  // "Abriu a tela" só entra no registro quando a tela do caixa começa a chegar ao navegador
  // (primeiro dado enviado). Se a conexão falhar antes, fica "Tentou abrir a tela (sem conexão)".
  let inicio = null;
  let motivoFalha = '';
  const enviarOriginal = ws.send.bind(ws);
  ws.send = (...args) => {
    if (inicio == null) {
      inicio = Date.now();
      eventos.registrar('tela', { usuario: sessao.login, ip: ipDe(req), caixa: caixa.id });
    }
    return enviarOriginal(...args);
  };
  ligarVnc(ws, opcoes, (m) => {
    motivoFalha = m;
    erro(`VNC ${destino}: ${m}`);
  });
  ws.on('close', () => {
    info(`Fim do acesso remoto ao caixa ${caixa.id} por ${sessao.login}`);
    if (inicio != null) {
      eventos.registrar('tela_fim', { usuario: sessao.login, ip: ipDe(req), caixa: caixa.id, detalhe: `${Math.round((Date.now() - inicio) / 1000)}s com a tela aberta` });
    } else {
      eventos.registrar('tela_falha', { usuario: sessao.login, ip: ipDe(req), caixa: caixa.id, detalhe: motivoFalha ? motivoParaFiscal(motivoFalha) : 'a conexão foi fechada antes de a tela abrir' });
    }
  });
});

ligarAdmin(app, { exigirSessao, exigirAdmin, encerrarSessoesDe, motivoTela, ipDe });

// Rota desconhecida da API: resposta curta, sem detalhes.
app.use('/api', (req, res) => res.status(404).json({ erro: 'Não encontrado' }));
// Qualquer erro (JSON malformado, corpo grande demais, falha interna): resposta genérica.
// Os detalhes vão só para o log do servidor, nunca para o navegador.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.too.large') return res.status(413).json({ erro: 'Pedido grande demais' });
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) return res.status(400).json({ erro: 'Pedido inválido' });
  erro(`Erro em ${req.method} ${textoLimpo(req.path, 100)}: ${textoLimpo(err.stack || err.message, 500)}`);
  res.status(500).json({ erro: 'Erro interno. Tente de novo.' });
});

// Conexões lentas de propósito (slowloris) não seguram o servidor.
servidor.headersTimeout = 20_000;
servidor.requestTimeout = 30_000;
servidor.keepAliveTimeout = 5_000;

// Último recurso: um erro inesperado vai para o log em vez de derrubar o painel inteiro.
process.on('uncaughtException', (e) => erro(`Erro não tratado: ${textoLimpo(e.stack || e.message, 800)}`));
process.on('unhandledRejection', (e) => erro(`Promessa rejeitada: ${textoLimpo(e?.stack || e, 800)}`));

// Porta ocupada (ex.: outra instância ainda saindo): tenta de novo a cada 5 s em vez de ficar
// parado sem atender. Assim o serviço assume a porta assim que ela ficar livre.
servidor.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') return erro(`Servidor HTTP: ${e.message}`);
  aviso(`Porta ${config.porta} ocupada; tentando de novo em 5 s`);
  setTimeout(() => servidor.listen(config.porta), 5000);
});

servidor.listen(config.porta, () => {
  info(`Painel em http://localhost:${config.porta}`);
  if (config.tokenAgente === 'troque-este-token') aviso('Usando token de agente padrão. Defina "tokenAgente" no config.json.');
  if (!usuarios.existeAlgum()) aviso('Nenhum usuário cadastrado. Crie um com: npm run usuario -- criar LOGIN admin');
});
