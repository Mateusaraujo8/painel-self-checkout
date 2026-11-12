import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const padrao = {
  porta: 8080,
  // Token que cada agente de caixa precisa enviar para conectar.
  tokenAgente: 'troque-este-token',
  // Sem heartbeat por este tempo, o caixa é marcado como offline.
  segundosOffline: 20,
  // Versão mínima do agente aceita (igual ao "versão mínima exigida" do Acrux).
  versaoMinimaAgente: '1.0.0',
  // Porta VNC padrão dos caixas, caso o agente não informe outra.
  portaVncPadrao: 5900,
  // Senha VNC comum dos caixas. Preenchida = o servidor autentica sozinho e a
  // senha nunca vai para o navegador. Vazia = o supervisor digita no navegador.
  senhaVnc: '',
};

function lerArquivo() {
  const arquivo = path.join(RAIZ, 'config.json');
  if (!fs.existsSync(arquivo)) return {};
  // Remove o BOM que o Bloco de Notas/PowerShell costumam gravar.
  return JSON.parse(fs.readFileSync(arquivo, 'utf8').replace(/^\uFEFF/, ''));
}

const env = process.env;
const doEnv = {
  ...(env.PORTA && { porta: Number(env.PORTA) }),
  ...(env.TOKEN_AGENTE && { tokenAgente: env.TOKEN_AGENTE }),
  ...(env.SEGUNDOS_OFFLINE && { segundosOffline: Number(env.SEGUNDOS_OFFLINE) }),
  ...(env.VERSAO_MINIMA_AGENTE && { versaoMinimaAgente: env.VERSAO_MINIMA_AGENTE }),
  ...(env.SENHA_VNC !== undefined && { senhaVnc: env.SENHA_VNC }),
};

export const config = { ...padrao, ...lerArquivo(), ...doEnv };
