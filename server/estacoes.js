// Quais caixas cada computador de supervisão enxerga, pelo IP do computador.
// Lido de estacoes.json (na raiz do projeto) e recarregado ao salvar o arquivo.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { RAIZ } from './config.js';
import { info, erro } from './log.js';

const ARQUIVO = path.join(RAIZ, 'estacoes.json');

class Estacoes extends EventEmitter {
  constructor() {
    super();
    this.dados = { semEstacao: 'nenhum', estacoes: [] };
    this.carregar();
    fs.watchFile(ARQUIVO, { interval: 2000 }, () => {
      if (this.carregar()) this.emit('mudou');
    });
  }

  carregar() {
    if (!fs.existsSync(ARQUIVO)) {
      this.dados = { semEstacao: 'nenhum', estacoes: [] };
      return true;
    }
    try {
      const d = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8').replace(/^\uFEFF/, ''));
      d.estacoes = (d.estacoes || []).map((e) => ({
        nome: e.nome || 'Sem nome',
        computadores: (e.computadores || []).map(String),
        caixas: (e.caixas || []).map((c) => (typeof c === 'string' ? { ip: c } : c)),
      }));
      this.dados = d;
      info(`estacoes.json: ${d.estacoes.length} estação(ões) carregada(s)`);
      return true;
    } catch (e) {
      erro(`estacoes.json inválido, mantendo a versão anterior: ${e.message}`);
      return false;
    }
  }

  /** Caixas com loja/pdv definidos no arquivo (para cadastrar mesmo sem agente). */
  caixasCadastrados() {
    const porIp = new Map();
    for (const c of [...(this.dados.caixas || []), ...this.dados.estacoes.flatMap((e) => e.caixas)]) {
      if (Number.isInteger(c.loja) && Number.isInteger(c.pdv) && c.ip && !porIp.has(c.ip)) porIp.set(c.ip, c);
    }
    return [...porIp.values()];
  }

  /** Versão do arquivo (para detectar edição à mão enquanto a administração está aberta). */
  versao() {
    try {
      return String(Math.floor(fs.statSync(ARQUIVO).mtimeMs));
    } catch {
      return '0';
    }
  }

  /** Cadastro no formato da tela de administração. */
  cadastro() {
    const d = this.dados;
    const lojas = Object.entries(d.lojas || {}).map(([codigo, nome]) => ({ codigo: Number(codigo), nome }));
    const caixas = this.caixasCadastrados().map((c) => ({
      loja: c.loja,
      pdv: c.pdv,
      ip: c.ip,
      portaVnc: Number(c.portaVnc) || null,
      tipo: tipoCaixa(c),
    }));
    // Loja que aparece só nos caixas (sem nome cadastrado) entra na lista também.
    for (const c of caixas) if (!lojas.some((l) => l.codigo === c.loja)) lojas.push({ codigo: c.loja, nome: '' });
    lojas.sort((a, b) => a.codigo - b.codigo);
    caixas.sort((a, b) => a.loja - b.loja || a.pdv - b.pdv);
    return {
      versao: this.versao(),
      semEstacao: d.semEstacao || 'nenhum',
      lojas,
      caixas,
      estacoes: d.estacoes.map((e) => ({ nome: e.nome, computadores: e.computadores, caixas: e.caixas.map((c) => c.ip) })),
    };
  }

  /**
   * Valida e grava o cadastro vindo da administração. Guarda a versão anterior em
   * data/estacoes-anteriores/. Lança Error com mensagem para a TI quando algo está errado.
   */
  salvar(novo, versaoEsperada) {
    if (versaoEsperada && versaoEsperada !== this.versao()) {
      const e = new Error('O estacoes.json foi alterado por outra pessoa (ou à mão) depois que você abriu esta tela. Recarregue para ver a versão atual.');
      e.conflito = true;
      throw e;
    }
    const arquivo = validarCadastro(novo);
    const texto = JSON.stringify(arquivo, null, 2) + '\n';
    if (fs.existsSync(ARQUIVO)) {
      const pasta = path.join(RAIZ, 'data', 'estacoes-anteriores');
      fs.mkdirSync(pasta, { recursive: true });
      const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(ARQUIVO, path.join(pasta, `estacoes-${carimbo}.json`));
      // Mantém as 50 últimas.
      const antigas = fs.readdirSync(pasta).filter((f) => f.endsWith('.json')).sort();
      for (const f of antigas.slice(0, -50)) fs.unlinkSync(path.join(pasta, f));
    }
    const tmp = ARQUIVO + '.tmp';
    fs.writeFileSync(tmp, texto);
    fs.renameSync(tmp, ARQUIVO);
    this.carregar();
    this.emit('mudou');
    return this.cadastro();
  }

  estacaoDe(ipComputador) {
    const casa = (padrao) =>
      padrao.endsWith('*') ? ipComputador.startsWith(padrao.slice(0, -1)) : padrao === ipComputador;
    return this.dados.estacoes.find((e) => e.computadores.some(casa)) || null;
  }

  /**
   * Descreve o que uma sessão pode ver.
   * @returns {{ todos: boolean, estacao: string|null, ips: Set<string> }}
   */
  acessoDe(ipComputador, perfil) {
    if (perfil === 'admin') return { todos: true, estacao: 'TI / Administrador', ips: new Set() };
    const e = this.estacaoDe(ipComputador);
    if (!e) return { todos: this.dados.semEstacao === 'todos', estacao: null, ips: new Set() };
    return { todos: false, estacao: e.nome, ips: new Set(e.caixas.map((c) => c.ip)) };
  }
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
// Computador de fiscal: IP exato ou prefixo com * no fim (ex.: 192.0.2.*).
const IP_OU_FAIXA = /^((25[0-5]|2[0-4]\d|1?\d?\d)\.){1,3}\*$/;

// Nomes de loja/estação: texto de uma linha, sem caracteres de controle.
const semControle = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');

function validarCadastro(novo) {
  const problemas = [];
  const ehLista = (v) => v === undefined || Array.isArray(v);
  if (!novo || typeof novo !== 'object' || !ehLista(novo.lojas) || !ehLista(novo.caixas) || !ehLista(novo.estacoes)) {
    const e = new Error('Cadastro em formato inválido');
    e.validacao = true;
    throw e;
  }
  if ((novo.lojas?.length || 0) > 500 || (novo.caixas?.length || 0) > 5000 || (novo.estacoes?.length || 0) > 1000) {
    const e = new Error('Cadastro grande demais');
    e.validacao = true;
    throw e;
  }
  for (const e of novo.estacoes || []) {
    if (!e || typeof e !== 'object' || !ehLista(e.computadores) || !ehLista(e.caixas)) {
      const err = new Error('Estação em formato inválido');
      err.validacao = true;
      throw err;
    }
  }
  const lojas = new Map();
  for (const l of novo.lojas || []) {
    const codigo = Number(l.codigo);
    const nome = semControle(l?.nome).trim();
    if (!Number.isInteger(codigo) || codigo < 1 || codigo > 9999) problemas.push(`Código de loja inválido: "${l.codigo}"`);
    else if (lojas.has(codigo)) problemas.push(`Loja ${codigo} repetida`);
    else if (!nome) problemas.push(`A loja ${codigo} está sem nome`);
    else lojas.set(codigo, nome.slice(0, 60));
  }

  const caixas = new Map(); // ip -> caixa
  const ids = new Set();
  for (const c of novo.caixas || []) {
    const loja = Number(c.loja);
    const pdv = Number(c.pdv);
    const ip = String(c.ip || '').trim();
    const portaVnc = c.portaVnc ? Number(c.portaVnc) : null;
    const nomeCaixa = `loja ${loja} PDV ${pdv}`;
    if (!lojas.has(loja)) problemas.push(`O caixa ${nomeCaixa} é de uma loja que não está cadastrada`);
    else if (!Number.isInteger(pdv) || pdv < 1 || pdv > 999) problemas.push(`PDV inválido na loja ${loja}: "${c.pdv}"`);
    else if (!IPV4.test(ip)) problemas.push(`IP inválido no ${nomeCaixa}: "${ip}"`);
    else if (caixas.has(ip)) problemas.push(`O IP ${ip} está em dois caixas`);
    else if (ids.has(`${loja}-${pdv}`)) problemas.push(`O ${nomeCaixa} está cadastrado duas vezes`);
    else if (portaVnc !== null && !(Number.isInteger(portaVnc) && portaVnc > 0 && portaVnc < 65536)) problemas.push(`Porta VNC inválida no ${nomeCaixa}`);
    else {
      ids.add(`${loja}-${pdv}`);
      // tipo: só grava quando é PDV normal (self é o padrão, como nos cadastros antigos).
      caixas.set(ip, { ip, loja, pdv, ...(portaVnc && portaVnc !== 5900 ? { portaVnc } : {}), ...(c.tipo === 'pdv' ? { tipo: 'pdv' } : {}) });
    }
  }

  const nomes = new Set();
  const donoDoComputador = new Map();
  const estacoesOk = [];
  for (const e of novo.estacoes || []) {
    const nome = semControle(e.nome).trim().slice(0, 60);
    if (!nome) {
      problemas.push('Há uma estação sem nome');
      continue;
    }
    if (nomes.has(nome)) problemas.push(`Duas estações com o nome "${nome}"`);
    nomes.add(nome);
    const computadores = [...new Set((e.computadores || []).map((x) => String(x).trim()).filter(Boolean))];
    for (const pc of computadores) {
      if (!IPV4.test(pc) && !IP_OU_FAIXA.test(pc)) problemas.push(`Computador inválido na estação "${nome}": "${pc}"`);
      else if (donoDoComputador.has(pc)) problemas.push(`O computador ${pc} está em duas estações ("${donoDoComputador.get(pc)}" e "${nome}")`);
      else donoDoComputador.set(pc, nome);
    }
    const ipsCaixas = [...new Set((e.caixas || []).map(String))];
    for (const ip of ipsCaixas) if (!caixas.has(ip)) problemas.push(`A estação "${nome}" aponta para um caixa que não existe (${ip})`);
    estacoesOk.push({
      nome,
      computadores,
      caixas: ipsCaixas.filter((ip) => caixas.has(ip)).map((ip) => caixas.get(ip)).sort((a, b) => a.loja - b.loja || a.pdv - b.pdv),
    });
  }

  if (problemas.length) {
    const e = new Error(problemas.slice(0, 8).join('\n') + (problemas.length > 8 ? `\n…e mais ${problemas.length - 8}` : ''));
    e.validacao = true;
    throw e;
  }
  return {
    semEstacao: novo.semEstacao === 'todos' ? 'todos' : 'nenhum',
    lojas: Object.fromEntries([...lojas].sort((a, b) => a[0] - b[0]).map(([k, v]) => [String(k), v])),
    // Lista completa de caixas (inclui os que ainda não estão em nenhuma estação).
    caixas: [...caixas.values()].sort((a, b) => a.loja - b.loja || a.pdv - b.pdv),
    estacoes: estacoesOk,
  };
}

/** Tipo do caixa no cadastro: 'self' (self-checkout, padrão) ou 'pdv' (PDV normal, com operador). */
export const tipoCaixa = (c) => (c?.tipo === 'pdv' ? 'pdv' : 'self');

export const estacoes = new Estacoes();

export function podeVer(acesso, caixa) {
  return acesso.todos || acesso.ips.has(caixa.ip);
}
