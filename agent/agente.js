// Agente instalado em cada self-checkout.
//
// Ele mantém a conexão com o painel e abre uma API HTTP local (só 127.0.0.1)
// para o software do caixa avisar o que está acontecendo:
//
//   POST http://127.0.0.1:8765/status        {"status":"em_venda","operador":"Maria"}
//   POST http://127.0.0.1:8765/alerta        {"alerta":"ajuda","mensagem":"Cliente chamou"}
//   POST http://127.0.0.1:8765/alerta/fim
//   GET  http://127.0.0.1:8765/comandos      -> comandos recebidos do painel (ex.: liberar)
//
// Configuração por variáveis de ambiente:
//   SERVIDOR=ws://192.0.2.10:8080  TOKEN=...  LOJA=1  PDV=5  PORTA_VNC=5900  PORTA_LOCAL=8765
import http from 'node:http';
import { ClienteCaixa } from './cliente.js';

const env = process.env;
const exigir = (nome) => {
  if (!env[nome]) {
    console.error(`Defina a variável ${nome}`);
    process.exit(1);
  }
  return env[nome];
};

const cliente = new ClienteCaixa({
  servidor: env.SERVIDOR || 'ws://localhost:8080',
  token: exigir('TOKEN'),
  loja: Number(exigir('LOJA')),
  pdv: Number(exigir('PDV')),
  nome: env.NOME,
  portaVnc: Number(env.PORTA_VNC) || undefined,
}).iniciar();

const comandos = [];
cliente.on('conectado', (id) => console.log(`Conectado ao painel como ${id}`));
cliente.on('desconectado', () => console.log('Sem conexão com o painel, tentando de novo...'));
cliente.on('recusado', (m) => console.error(`Painel recusou a conexão: ${m}`));
cliente.on('erro', (e) => console.error(`Erro: ${e.message}`));
cliente.on('comando', (c) => {
  console.log(`Comando do painel: ${c.acao} (${c.usuario})`);
  comandos.push({ ...c, recebidoEm: Date.now() });
  if (comandos.length > 50) comandos.shift();
});

function lerCorpo(req) {
  return new Promise((ok) => {
    let s = '';
    req.on('data', (d) => (s += d));
    req.on('end', () => {
      try {
        ok(s ? JSON.parse(s) : {});
      } catch {
        ok({});
      }
    });
  });
}

http
  .createServer(async (req, res) => {
    const responde = (cod, obj) => {
      res.writeHead(cod, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const corpo = req.method === 'POST' ? await lerCorpo(req) : {};

    if (req.method === 'POST' && req.url === '/status') {
      cliente.atualizar(corpo);
      return responde(200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/alerta') {
      cliente.abrirAlerta(corpo.alerta || 'ajuda', corpo.mensagem);
      return responde(200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/alerta/fim') {
      cliente.fecharAlerta();
      return responde(200, { ok: true });
    }
    if (req.method === 'GET' && req.url === '/comandos') {
      return responde(200, comandos.splice(0));
    }
    responde(404, { erro: 'rota desconhecida' });
  })
  .listen(Number(env.PORTA_LOCAL) || 8765, '127.0.0.1', () =>
    console.log(`API local em http://127.0.0.1:${Number(env.PORTA_LOCAL) || 8765}`),
  );
