// Registro de ações estruturado (para a tela de administração).
// Um arquivo JSON Lines por mês em data/eventos/AAAA-MM.jsonl; guarda 12 meses.
// Complementa o log de texto (log/AAAA-MM-DD.log), que continua igual.
import fs from 'node:fs';
import path from 'node:path';
import { RAIZ } from './config.js';
import { aviso } from './log.js';

const PASTA = path.join(RAIZ, 'data', 'eventos');
const MESES_GUARDADOS = 12;

export const TIPOS_EVENTO = {
  login: 'Entrou',
  login_recusado: 'Entrada recusada',
  saiu: 'Saiu',
  alerta: 'Alerta aberto',
  atender: 'Atendeu',
  liberar: 'Liberou o caixa',
  alerta_fim: 'Alerta resolvido no caixa',
  historico: 'Histórico recuperado de um caixa',
  tela: 'Abriu a tela com controle',
  tela_fim: 'Fechou a tela',
  tela_falha: 'Tentou abrir a tela (sem conexão)',
  tara_auto: 'Tara automática da balança',
  tara_config: 'Mudou a tara automática',
  cadastro: 'Mudou o cadastro',
  usuario: 'Mudou um usuário',
};

const doMes = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

/**
 * Grava um evento. Campos comuns: usuario, ip, caixa ("16-13"), loja, detalhe.
 * Nunca recebe senhas.
 */
export function registrar(tipo, dados = {}) {
  const ev = { t: Date.now(), tipo, ...dados };
  if (ev.caixa && ev.loja == null) ev.loja = Number(String(ev.caixa).split('-')[0]);
  try {
    fs.mkdirSync(PASTA, { recursive: true });
    fs.appendFile(path.join(PASTA, `${doMes(ev.t)}.jsonl`), JSON.stringify(ev) + '\n', () => {});
  } catch (e) {
    aviso(`Não foi possível gravar o registro de ações: ${e.message}`);
  }
}

/**
 * Grava eventos com o horário em que aconteceram (recuperados dos logs dos caixas depois de
 * uma queda do painel). Ficam no arquivo do mês certo; a consulta ordena pelo horário.
 */
export function registrarComHorario(lista) {
  const porMes = new Map();
  for (const { t, tipo, ...dados } of lista) {
    const ev = { t, tipo, ...dados };
    if (ev.caixa && ev.loja == null) ev.loja = Number(String(ev.caixa).split('-')[0]);
    const mes = doMes(t);
    porMes.set(mes, (porMes.get(mes) || '') + JSON.stringify(ev) + '\n');
  }
  fs.mkdirSync(PASTA, { recursive: true });
  for (const [mes, texto] of porMes) fs.appendFileSync(path.join(PASTA, `${mes}.jsonl`), texto);
}

function mesesEntre(de, ate) {
  const meses = [];
  const d = new Date(de);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  while (d.getTime() <= ate) {
    meses.push(doMes(d.getTime()));
    d.setMonth(d.getMonth() + 1);
  }
  return meses;
}

/**
 * Eventos do mais novo para o mais antigo.
 * Filtros: de/ate (ms), tipo, usuario, loja, caixa, limite (até 1000).
 */
export function consultar({ de, ate, tipo, usuario, loja, caixa, limite = 200, semLimite = false } = {}) {
  ate = Number(ate) || Date.now();
  de = Number(de) || ate - 7 * 864e5;
  // A tela do Registro pede no máximo 1000 por vez; os Indicadores (uso interno) leem tudo.
  limite = semLimite ? Infinity : Math.min(Math.max(Number(limite) || 200, 1), 1000);
  const resultado = [];
  for (const mes of mesesEntre(de, ate).reverse()) {
    let linhas;
    try {
      linhas = fs.readFileSync(path.join(PASTA, `${mes}.jsonl`), 'utf8').split('\n');
    } catch {
      continue;
    }
    // O arquivo pode ter eventos fora de ordem (recuperados depois): junta e ordena pelo horário.
    const doMesFiltrado = [];
    for (const linha of linhas) {
      if (!linha) continue;
      let ev;
      try {
        ev = JSON.parse(linha);
      } catch {
        continue;
      }
      if (ev.t > ate || ev.t < de) continue;
      if (tipo && ev.tipo !== tipo) continue;
      if (usuario && ev.usuario !== usuario) continue;
      if (loja && ev.loja !== Number(loja)) continue;
      if (caixa && ev.caixa !== caixa) continue;
      doMesFiltrado.push(ev);
    }
    doMesFiltrado.sort((a, b) => b.t - a.t);
    for (const ev of doMesFiltrado) {
      resultado.push(ev);
      if (resultado.length >= limite) return resultado;
    }
  }
  return resultado;
}

/** Horário do evento mais antigo guardado (para dizer "dados desde ..."). */
export function primeiroRegistro() {
  try {
    const mes = fs.readdirSync(PASTA).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort()[0];
    if (!mes) return null;
    // Menor horário do mês mais antigo (eventos recuperados podem estar no fim do arquivo).
    let menor = Infinity;
    for (const linha of fs.readFileSync(path.join(PASTA, mes), 'utf8').split('\n')) {
      const m = linha.match(/^\{"t":(\d+)/);
      if (m && Number(m[1]) < menor) menor = Number(m[1]);
    }
    return Number.isFinite(menor) ? menor : null;
  } catch {
    return null;
  }
}

/** Usuários que aparecem no registro (para o filtro). */
export function usuariosNoRegistro() {
  const nomes = new Set();
  for (const ev of consultar({ de: Date.now() - 90 * 864e5, limite: 1000 })) if (ev.usuario) nomes.add(ev.usuario);
  return [...nomes].sort();
}

function limpar() {
  try {
    const limite = new Date();
    limite.setMonth(limite.getMonth() - MESES_GUARDADOS);
    const corte = doMes(limite.getTime());
    for (const f of fs.readdirSync(PASTA)) {
      const m = f.match(/^(\d{4}-\d{2})\.jsonl$/);
      if (m && m[1] < corte) fs.unlinkSync(path.join(PASTA, f));
    }
  } catch {}
}
limpar();
setInterval(limpar, 864e5).unref();
