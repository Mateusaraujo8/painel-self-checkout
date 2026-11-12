// Ponte WebSocket (noVNC no navegador) <-> TCP (servidor VNC do caixa).
//
// Com `senha` configurada, o próprio servidor faz a autenticação VNC no caixa e
// apresenta ao navegador uma conexão "sem senha". Assim a senha VNC fica só no
// config.json do servidor e nunca chega aos navegadores.
import net from 'node:net';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DESECBCipher } = require('@novnc/novnc/lib/crypto/des.js');

function respostaVncAuth(senha, desafio) {
  const chave = new Uint8Array(8);
  chave.set(Buffer.from(senha, 'latin1').subarray(0, 8));
  const cifra = DESECBCipher.importKey(chave, { name: 'DES-ECB' }, false, ['encrypt']);
  return Buffer.from(cifra.encrypt({ name: 'DES-ECB' }, new Uint8Array(desafio)));
}

/** Lê bytes de uma fonte que chega aos pedaços. */
class Leitor {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.espera = null;
    this.fim = null;
  }
  empurrar(dados) {
    this.buf = Buffer.concat([this.buf, dados]);
    this.verificar();
  }
  encerrar(erro) {
    this.fim = erro || new Error('conexão fechada');
    this.verificar();
  }
  verificar() {
    if (!this.espera) return;
    const { n, ok, falha } = this.espera;
    if (this.buf.length >= n) {
      this.espera = null;
      const parte = this.buf.subarray(0, n);
      this.buf = this.buf.subarray(n);
      ok(parte);
    } else if (this.fim) {
      this.espera = null;
      falha(this.fim);
    }
  }
  ler(n) {
    return new Promise((ok, falha) => {
      this.espera = { n, ok, falha };
      this.verificar();
    });
  }
  resto() {
    const r = this.buf;
    this.buf = Buffer.alloc(0);
    return r;
  }
}

class ErroVnc extends Error {}

/**
 * Filtra o que o navegador manda ao caixa numa conexão "só ver" (as miniaturas do painel):
 * deixa passar pedidos de imagem e descarta teclado, mouse, área de transferência e
 * comandos de energia. Assim a miniatura não consegue mexer no caixa, mesmo que alguém
 * altere o JavaScript do navegador.
 */
class FiltroSoVer {
  constructor(enviar, abortar) {
    this.enviar = enviar;
    this.abortar = abortar;
    this.buf = Buffer.alloc(0);
    this.iniciou = false; // o primeiro byte é o ClientInit
  }

  empurrar(dados) {
    this.buf = Buffer.concat([this.buf, dados]);
    if (!this.iniciou) {
      if (!this.buf.length) return;
      this.enviar(this.buf.subarray(0, 1));
      this.buf = this.buf.subarray(1);
      this.iniciou = true;
    }
    for (;;) {
      const tam = this.tamanho();
      if (tam === null) return; // mensagem incompleta: espera mais bytes
      if (tam < 0) {
        this.buf = Buffer.alloc(0);
        return this.abortar('Mensagem VNC não permitida no modo só ver');
      }
      const msg = this.buf.subarray(0, tam);
      this.buf = this.buf.subarray(tam);
      if (this.permitida(msg[0])) this.enviar(msg);
    }
  }

  permitida(tipo) {
    // 0 SetPixelFormat, 2 SetEncodings, 3 FramebufferUpdateRequest, 150 EnableContinuousUpdates, 248 ClientFence
    return tipo === 0 || tipo === 2 || tipo === 3 || tipo === 150 || tipo === 248;
  }

  /** Tamanho da próxima mensagem; null = incompleta; -1 = tipo desconhecido. */
  tamanho() {
    const b = this.buf;
    if (!b.length) return null;
    const precisa = (n) => (b.length >= n ? n : null);
    switch (b[0]) {
      case 0: return precisa(20);
      case 2: return b.length < 4 ? null : precisa(4 + 4 * b.readUInt16BE(2));
      case 3: return precisa(10);
      case 4: return precisa(8); // teclado (descartado)
      case 5: return precisa(6); // mouse (descartado)
      case 6: return b.length < 8 ? null : precisa(8 + b.readUInt32BE(4)); // área de transferência (descartada)
      case 150: return precisa(10);
      case 248: return b.length < 9 ? null : precisa(9 + b[8]);
      case 250: return precisa(4); // xvp: desligar/reiniciar (descartado)
      case 251: return b.length < 8 ? null : precisa(8 + 16 * b[6]); // SetDesktopSize (descartado)
      case 255: return b.length < 2 ? null : b[1] === 0 ? precisa(12) : -1; // QEMU: tecla estendida (descartada)
      default: return -1;
    }
  }
}

async function autenticar(tcp, doCaixa, ws, doNavegador, senha) {
  const u32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  const lerMotivo = async () => {
    const tam = (await doCaixa.ler(4)).readUInt32BE(0);
    return (await doCaixa.ler(Math.min(tam, 1024))).toString('latin1');
  };

  // 1) Versões: o navegador sempre fala 3.8 com o proxy.
  const versaoCaixa = (await doCaixa.ler(12)).toString('latin1');
  // Alguns servidores Linux anunciam "3.6" mas falam 3.8 normalmente.
  const menor = Number(versaoCaixa.slice(8, 11)) >= 6 ? 8 : 3;
  ws.send(Buffer.from('RFB 003.008\n'));
  await doNavegador.ler(12);

  // 2) Segurança com o caixa.
  let tipo;
  if (menor >= 7) {
    tcp.write('RFB 003.008\n');
    const qtd = (await doCaixa.ler(1))[0];
    if (qtd === 0) throw new ErroVnc(`VNC recusou: ${await lerMotivo()}`);
    const tipos = [...(await doCaixa.ler(qtd))];
    tipo = tipos.includes(1) && !senha ? 1 : tipos.includes(2) ? 2 : tipos.includes(1) ? 1 : null;
    if (!tipo) throw new ErroVnc(`VNC do caixa só oferece segurança ${tipos.join(',')}`);
    tcp.write(Buffer.from([tipo]));
  } else {
    tcp.write('RFB 003.003\n');
    tipo = (await doCaixa.ler(4)).readUInt32BE(0);
    if (tipo === 0) throw new ErroVnc(`VNC recusou: ${await lerMotivo()}`);
    if (tipo !== 1 && tipo !== 2) throw new ErroVnc(`Segurança VNC ${tipo} não suportada`);
  }

  if (tipo === 2) {
    if (!senha) throw new ErroVnc('O caixa pede senha VNC: defina "senhaVnc" no config.json do servidor');
    const desafio = await doCaixa.ler(16);
    tcp.write(respostaVncAuth(senha, desafio));
  }
  if (tipo === 2 || menor >= 8) {
    const resultado = (await doCaixa.ler(4)).readUInt32BE(0);
    if (resultado !== 0) {
      const motivo = menor >= 8 ? await lerMotivo().catch(() => '') : '';
      throw new ErroVnc(`Senha VNC recusada pelo caixa${motivo ? `: ${motivo}` : ''}`);
    }
  }

  // 3) Para o navegador: "sem senha" e sucesso.
  ws.send(Buffer.from([1, 1]));
  await doNavegador.ler(1);
  ws.send(u32(0));
}

/**
 * @param {import('ws').WebSocket} ws
 * @param {{host:string, porta:number, senha?:string}} destino
 * @param {(msg:string)=>void} aoErro
 */
export function ligarVnc(ws, { host, porta, senha, somenteVer = false }, aoErro) {
  const tcp = net.connect({ host, port: porta });
  tcp.setTimeout(10000, () => tcp.destroy(new Error('tempo esgotado')));
  tcp.on('connect', () => tcp.setTimeout(0));

  const doCaixa = new Leitor();
  const doNavegador = new Leitor();
  // "Só ver" exige que o proxy faça o aperto de mão, para saber onde começa o fluxo de comandos.
  const intermediar = Boolean(senha) || somenteVer;
  let direto = !intermediar;
  const filtro = somenteVer ? new FiltroSoVer((dados) => tcp.writable && tcp.write(dados), (m) => fechar(4012, m)) : null;

  tcp.on('data', (d) => {
    if (direto) {
      if (ws.readyState === ws.OPEN) ws.send(d);
    } else doCaixa.empurrar(d);
  });
  ws.on('message', (d) => {
    if (direto) {
      if (filtro) filtro.empurrar(Buffer.from(d));
      else if (tcp.writable) tcp.write(d);
    } else doNavegador.empurrar(Buffer.from(d));
  });

  const fechar = (codigo, motivo) => {
    tcp.destroy();
    if (ws.readyState === ws.OPEN) ws.close(codigo, Buffer.from(motivo).subarray(0, 120).toString());
  };
  tcp.on('error', (e) => {
    aoErro(e.message);
    fechar(4010, `Sem acesso ao VNC do caixa (${e.code || e.message})`);
  });
  tcp.on('close', () => {
    doCaixa.encerrar();
    fechar(1000, 'VNC encerrado');
  });
  ws.on('close', () => {
    doNavegador.encerrar();
    tcp.destroy();
  });
  ws.on('error', () => tcp.destroy());

  if (intermediar) {
    autenticar(tcp, doCaixa, ws, doNavegador, senha)
      .then(() => {
        direto = true;
        const pendCaixa = doCaixa.resto();
        const pendNav = doNavegador.resto();
        if (pendCaixa.length && ws.readyState === ws.OPEN) ws.send(pendCaixa);
        if (pendNav.length) {
          if (filtro) filtro.empurrar(pendNav);
          else if (tcp.writable) tcp.write(pendNav);
        }
      })
      .catch((e) => {
        const msg = e instanceof ErroVnc ? e.message : `Falha no VNC: ${e.message}`;
        aoErro(msg);
        fechar(4011, msg);
      });
  }
}
