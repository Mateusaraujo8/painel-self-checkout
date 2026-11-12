// Cliente que roda em cada self-checkout e mantém a conexão com o painel.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export const VERSAO_AGENTE = '1.0.0';

export class ClienteCaixa extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.servidor  ex.: ws://192.0.2.10:8080
   * @param {string} o.token
   * @param {number} o.loja
   * @param {number} o.pdv
   * @param {string} [o.nome]
   * @param {number} [o.portaVnc]
   * @param {number} [o.intervaloHeartbeat] ms
   */
  constructor(o) {
    super();
    this.o = { intervaloHeartbeat: 5000, ...o };
    this.situacao = { status: 'livre', operador: null, vendasHoje: 0, totalHoje: 0 };
    this.alerta = null;
    this.espera = 1000;
  }

  iniciar() {
    this.parado = false;
    this.conectar();
    return this;
  }

  parar() {
    this.parado = true;
    clearInterval(this.timerHb);
    this.ws?.close();
  }

  conectar() {
    const url = this.o.servidor.replace(/\/$/, '') + '/ws/agente';
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.enviar({
        tipo: 'ola',
        token: this.o.token,
        loja: this.o.loja,
        pdv: this.o.pdv,
        nome: this.o.nome,
        versao: VERSAO_AGENTE,
        portaVnc: this.o.portaVnc,
      });
    });

    ws.on('message', (bruto) => {
      const msg = JSON.parse(bruto);
      if (msg.tipo === 'bemvindo') {
        this.espera = 1000;
        this.emit('conectado', msg.id);
        this.enviarHeartbeat();
        // Reenvia um alerta que estava aberto quando a conexão caiu.
        if (this.alerta) this.enviar({ tipo: 'alerta', ...this.alerta });
        clearInterval(this.timerHb);
        this.timerHb = setInterval(() => this.enviarHeartbeat(), this.o.intervaloHeartbeat);
      } else if (msg.tipo === 'recusado') {
        this.emit('recusado', msg.motivo);
      } else if (msg.tipo === 'comando') {
        if (msg.acao === 'liberar') this.alerta = null;
        this.emit('comando', msg);
      }
    });

    ws.on('close', () => {
      clearInterval(this.timerHb);
      this.emit('desconectado');
      if (this.parado) return;
      setTimeout(() => this.conectar(), this.espera);
      this.espera = Math.min(this.espera * 2, 30000);
    });
    ws.on('error', (e) => this.emit('erro', e));
  }

  enviar(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  enviarHeartbeat() {
    this.enviar({ tipo: 'heartbeat', ...this.situacao });
  }

  /** Atualiza status/operador/vendas e envia na hora. */
  atualizar(dados) {
    Object.assign(this.situacao, dados);
    this.enviarHeartbeat();
  }

  abrirAlerta(alerta, mensagem = '') {
    this.alerta = { alerta, mensagem };
    this.enviar({ tipo: 'alerta', ...this.alerta });
  }

  fecharAlerta() {
    this.alerta = null;
    this.enviar({ tipo: 'alerta_fim' });
  }
}
