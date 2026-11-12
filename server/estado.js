// Estado de todos os caixas — o equivalente à tabela tbCheckout do Acrux.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { RAIZ, config } from './config.js';
import { info, aviso } from './log.js';
import * as eventos from './eventos.js';

const ARQUIVO = path.join(RAIZ, 'data', 'checkouts.json');

export const TIPOS_ALERTA = {
  ajuda: { rotulo: 'Cliente pediu ajuda', prioridade: 2 },
  chamado: { rotulo: 'Self chamou o fiscal', prioridade: 2 },
  fiscal: { rotulo: 'Pede senha do fiscal', prioridade: 2 },
  mensagem: { rotulo: 'Mensagem parada na tela', prioridade: 2 },
  idade: { rotulo: 'Produto com restrição de idade', prioridade: 2 },
  peso: { rotulo: 'Divergência de peso', prioridade: 2 },
  cancelamento: { rotulo: 'Cancelamento de item (precisa do fiscal)', prioridade: 2 },
  pagamento: { rotulo: 'Falha no pagamento', prioridade: 3 },
  erro: { rotulo: 'Erro no caixa', prioridade: 3 },
  sem_papel: { rotulo: 'Impressora sem papel', prioridade: 1 },
};

class Estado extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, object>} */
    this.caixas = new Map();
    this.carregar();
    setInterval(() => this.varrerOffline(), 2000).unref();
  }

  static id(loja, pdv) {
    return `${Number(loja)}-${Number(pdv)}`;
  }

  carregar() {
    if (!fs.existsSync(ARQUIVO)) return;
    try {
      for (const c of JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'))) {
        // Ao reiniciar o servidor, ninguém está conectado ainda.
        this.caixas.set(c.id, { ...c, online: false, conectado: false });
      }
      info(`${this.caixas.size} caixas carregados de data/checkouts.json`);
    } catch (e) {
      aviso(`Não foi possível ler ${ARQUIVO}: ${e.message}`);
    }
  }

  // Grava no máximo 1 s depois da primeira mudança. (Antes o timer era reiniciado a cada
  // mudança: com dezenas de agentes enviando a cada 5 s, ele nunca disparava e o arquivo
  // ficava parado no tempo.)
  salvar() {
    if (this._timerSalvar) return;
    this._timerSalvar = setTimeout(() => {
      this._timerSalvar = null;
      try {
        fs.mkdirSync(path.dirname(ARQUIVO), { recursive: true });
        // Grava num temporário e troca: um desligamento no meio não corrompe a lista.
        const tmp = ARQUIVO + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify([...this.caixas.values()], null, 2));
        fs.renameSync(tmp, ARQUIVO);
      } catch (e) {
        aviso(`Não foi possível gravar ${ARQUIVO}: ${e.message}`);
      }
    }, 1000);
  }

  lista() {
    return [...this.caixas.values()].sort((a, b) => a.loja - b.loja || a.pdv - b.pdv);
  }

  obter(id) {
    return this.caixas.get(id);
  }

  atualizar(id, mudancas) {
    const atual = this.caixas.get(id);
    if (!atual) return;
    const novo = { ...atual, ...mudancas };
    this.caixas.set(id, novo);
    this.emit('mudou', novo);
    this.salvar();
    return novo;
  }

  registrar({ loja, pdv, nome, versao, ip, portaVnc }) {
    const id = Estado.id(loja, pdv);
    const anterior = this.caixas.get(id);
    const caixa = {
      status: 'livre',
      operador: null,
      alerta: null,
      vendasHoje: 0,
      totalHoje: 0,
      ...anterior,
      id,
      loja: Number(loja),
      pdv: Number(pdv),
      nome: nome || `PDV ${String(pdv).padStart(3, '0')}`,
      versao,
      ip,
      portaVnc: Number(portaVnc) || config.portaVncPadrao,
      online: true,
      conectado: true,
      ultimoContato: Date.now(),
    };
    this.caixas.set(id, caixa);
    this.emit('mudou', caixa);
    this.salvar();
    return caixa;
  }

  heartbeat(id, dados = {}) {
    const permitidos = ['status', 'operador', 'vendasHoje', 'totalHoje', 'fiscal', 'taraAuto'];
    const mudancas = { ultimoContato: Date.now(), online: true };
    for (const k of permitidos) if (k in dados) mudancas[k] = dados[k];
    return this.atualizar(id, mudancas);
  }

  abrirAlerta(id, { tipo, mensagem }) {
    const caixa = this.caixas.get(id);
    if (!caixa) return;
    const def = TIPOS_ALERTA[tipo] || TIPOS_ALERTA.erro;
    // Se já existe alerta aberto, mantém o horário original (fila por antiguidade).
    const desde = caixa.alerta?.desde ?? Date.now();
    info(`Alerta ${tipo} no caixa ${id}: ${mensagem || def.rotulo}`);
    if (caixa.alerta?.tipo !== tipo) eventos.registrar('alerta', { caixa: id, alerta: tipo, detalhe: def.rotulo });
    return this.atualizar(id, {
      alerta: { tipo, rotulo: def.rotulo, prioridade: def.prioridade, mensagem: mensagem || '', desde, atendidoPor: null },
    });
  }

  atenderAlerta(id, usuario) {
    const caixa = this.caixas.get(id);
    if (!caixa?.alerta) return;
    info(`Alerta do caixa ${id} em atendimento por ${usuario}`);
    return this.atualizar(id, { alerta: { ...caixa.alerta, atendidoPor: usuario, atendidoEm: Date.now() } });
  }

  fecharAlerta(id, motivo) {
    const caixa = this.caixas.get(id);
    if (!caixa?.alerta) return;
    const duracao = Math.round((Date.now() - caixa.alerta.desde) / 1000);
    info(`Alerta do caixa ${id} encerrado (${motivo}) após ${duracao}s`);
    // Liberar pelo painel é registrado por quem liberou (index.js), com o usuário.
    if (motivo === 'resolvido no caixa') {
      eventos.registrar('alerta_fim', { caixa: id, alerta: caixa.alerta.tipo, segundos: duracao, detalhe: `${caixa.alerta.rotulo} · aberto por ${duracao}s` });
    }
    return this.atualizar(id, { alerta: null });
  }

  desconectou(id) {
    this.atualizar(id, { conectado: false });
  }

  remover(id) {
    if (this.caixas.delete(id)) {
      this.emit('removido', id);
      this.salvar();
    }
  }

  varrerOffline() {
    const limite = Date.now() - config.segundosOffline * 1000;
    for (const c of this.caixas.values()) {
      if (c.online && c.ultimoContato < limite) {
        aviso(`Sem conexão loja ${c.loja} PDV ${c.pdv} IP ${c.ip}`);
        this.atualizar(c.id, { online: false });
      }
    }
  }
}

export const estado = new Estado();
export const idCaixa = Estado.id;
