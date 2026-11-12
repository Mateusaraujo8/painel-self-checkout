// Gerencia os usuários do painel pela linha de comando, no servidor.
//   npm run usuario -- criar joao [ti|fiscal] ["Nome Completo"]   (ti = TI / Administrador)
//   npm run usuario -- senha joao
//   npm run usuario -- remover joao
//   npm run usuario -- listar
// A senha é pedida no terminal (não aparece na tela) para não ficar no histórico.
import readline from 'node:readline';
import * as usuarios from './usuarios.js';

function perguntarSenha(texto) {
  return new Promise((ok) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => {
      if (s.startsWith(texto)) rl.output.write(texto);
    };
    rl.question(texto, (resp) => {
      rl.output.write('\n');
      rl.close();
      ok(resp);
    });
  });
}

async function senhaConfirmada() {
  // Permite automatizar: SENHA_USUARIO=... npm run usuario -- criar x
  if (process.env.SENHA_USUARIO) return process.env.SENHA_USUARIO;
  const a = await perguntarSenha('Senha: ');
  const b = await perguntarSenha('Repita a senha: ');
  if (a !== b) throw new Error('As senhas não conferem');
  return a;
}

const [acao, login, perfil, nome] = process.argv.slice(2);
try {
  if (acao === 'criar' && login) {
    usuarios.criar(login, await senhaConfirmada(), { perfil: perfil || 'supervisor', nome });
    console.log(`Usuário "${login}" criado (${perfil || 'supervisor'}).`);
  } else if (acao === 'senha' && login) {
    usuarios.trocarSenha(login, await senhaConfirmada());
    console.log(`Senha de "${login}" alterada.`);
  } else if (acao === 'remover' && login) {
    usuarios.remover(login);
    console.log(`Usuário "${login}" removido.`);
  } else if (acao === 'listar') {
    const l = usuarios.listar();
    if (!l.length) console.log('Nenhum usuário cadastrado.');
    for (const u of l) console.log(`${u.login.padEnd(20)} ${u.perfil.padEnd(11)} ${u.nome}`);
  } else {
    console.log('uso: npm run usuario -- criar LOGIN [ti|fiscal] ["Nome"] | senha LOGIN | remover LOGIN | listar');
    process.exitCode = 1;
  }
} catch (e) {
  console.error(`Erro: ${e.message}`);
  process.exitCode = 1;
}
