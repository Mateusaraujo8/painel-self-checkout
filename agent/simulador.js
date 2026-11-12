// Simula vários self-checkouts para testar o painel sem caixas reais.
//   npm run simular -- --lojas 2 --caixas 8
import { ClienteCaixa } from './cliente.js';
import { config } from '../server/config.js';

const arg = (nome, padrao) => {
  const i = process.argv.indexOf(`--${nome}`);
  return i > -1 ? process.argv[i + 1] : padrao;
};
const LOJAS = Number(arg('lojas', 2));
const CAIXAS = Number(arg('caixas', 8));
const SERVIDOR = arg('servidor', `ws://localhost:${config.porta}`);
const TOKEN = arg('token', config.tokenAgente);

const OPERADORES = ['Ana', 'Bruno', 'Carla', 'Diego', 'Elaine', 'Fábio', 'Gabi', 'Hugo'];
const ALERTAS = [
  ['ajuda', 'Cliente chamou o fiscal'],
  ['idade', 'Bebida alcoólica — conferir documento'],
  ['peso', 'Peso na balança diferente do esperado'],
  ['cancelamento', 'Cliente quer cancelar um item'],
  ['pagamento', 'TEF recusou o cartão'],
  ['sem_papel', 'Bobina acabou'],
];
const sorteia = (l) => l[Math.floor(Math.random() * l.length)];

const caixas = [];
for (let loja = 1; loja <= LOJAS; loja++) {
  for (let pdv = 1; pdv <= CAIXAS; pdv++) {
    const c = new ClienteCaixa({ servidor: SERVIDOR, token: TOKEN, loja, pdv, intervaloHeartbeat: 5000 });
    c.on('recusado', (m) => console.error(`L${loja} P${pdv} recusado: ${m}`));
    c.on('comando', (cmd) => console.log(`L${loja} P${pdv} recebeu "${cmd.acao}" de ${cmd.usuario}`));
    c.situacao.operador = sorteia(OPERADORES);
    caixas.push(c.iniciar());
  }
}
console.log(`Simulando ${caixas.length} caixas em ${SERVIDOR}`);

// A cada segundo, alguns caixas mudam de situação.
setInterval(() => {
  for (const c of caixas) {
    if (c.parado || Math.random() > 0.06) continue;
    const r = Math.random();
    if (c.alerta) {
      if (r < 0.25) c.fecharAlerta();
    } else if (r < 0.12) {
      const [tipo, msg] = sorteia(ALERTAS);
      c.abrirAlerta(tipo, msg);
    } else if (r < 0.55) {
      const proximo = { livre: 'em_venda', em_venda: 'pagamento', pagamento: 'livre' }[c.situacao.status] || 'livre';
      const venda = c.situacao.status === 'pagamento' ? 1 : 0;
      c.atualizar({
        status: proximo,
        vendasHoje: c.situacao.vendasHoje + venda,
        totalHoje: Math.round((c.situacao.totalHoje + venda * (20 + Math.random() * 180)) * 100) / 100,
      });
    }
  }
}, 1000);

// Derruba um caixa de vez em quando para testar o "sem conexão".
setInterval(() => {
  const c = sorteia(caixas);
  if (c.parado) return;
  console.log(`Desligando L${c.o.loja} P${c.o.pdv} por 40s`);
  c.parar();
  setTimeout(() => c.iniciar(), 40000);
}, 60000);
