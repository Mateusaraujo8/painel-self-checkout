import fs from 'node:fs';
import path from 'node:path';
import { RAIZ } from './config.js';

const pasta = path.join(RAIZ, 'log');
fs.mkdirSync(pasta, { recursive: true });

function arquivoDoDia() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return path.join(pasta, `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`);
}

export function log(nivel, mensagem) {
  // Uma linha por evento: quebras de linha e caracteres de controle vindos de fora (login
  // digitado, mensagem de agente) não conseguem forjar linhas falsas no log.
  const limpa = String(mensagem).replace(/[\r\n]+/g, ' | ').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
  const linha = `${new Date().toISOString()} [${nivel}] ${limpa}`;
  console.log(linha);
  fs.appendFile(arquivoDoDia(), linha + '\n', () => {});
}

export const info = (m) => log('INFO', m);
export const aviso = (m) => log('AVISO', m);
export const erro = (m) => log('ERRO', m);
