// Tara automática da balança de conferência: modo por loja, com exceção por caixa.
// Guardado em data/tara-auto.json. O agente recebe o modo na resposta de /api/agente.
//   desligado: nunca aperta (padrão)
//   precisa:   só quando a tara do fim da venda ficou com peso na balança (ou não foi registrada)
//   sempre:    depois de toda venda
import fs from 'node:fs';
import path from 'node:path';
import { RAIZ } from './config.js';

const ARQUIVO = path.join(RAIZ, 'data', 'tara-auto.json');
export const MODOS_TARA = ['desligado', 'precisa', 'sempre'];

let dados = { lojas: {}, caixas: {} };
function carregar() {
  try {
    const d = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
    dados = { lojas: d.lojas || {}, caixas: d.caixas || {} };
  } catch {
    dados = { lojas: {}, caixas: {} };
  }
}
carregar();

export const configTara = () => ({ modos: MODOS_TARA, lojas: { ...dados.lojas }, caixas: { ...dados.caixas } });

/** Modo de um caixa ("16-13"): exceção do caixa, senão o da loja, senão desligado. */
export function modoTara(id) {
  const loja = String(id).split('-')[0];
  return dados.caixas[id] || dados.lojas[loja] || 'desligado';
}

/** Valida e grava. Só aceita lojas/caixas do cadastro e modos conhecidos. */
export function salvarTara(novo, { lojasValidas, caixasValidos }) {
  const limpo = { lojas: {}, caixas: {} };
  const problemas = [];
  for (const [l, m] of Object.entries(novo?.lojas || {})) {
    if (!lojasValidas.has(String(l))) problemas.push(`Loja ${l} não está cadastrada`);
    else if (!MODOS_TARA.includes(m)) problemas.push(`Modo inválido na loja ${l}`);
    else if (m !== 'desligado') limpo.lojas[String(l)] = m;
  }
  for (const [id, m] of Object.entries(novo?.caixas || {})) {
    if (!caixasValidos.has(String(id))) problemas.push(`Caixa ${id} não está cadastrado`);
    else if (!MODOS_TARA.includes(m)) problemas.push(`Modo inválido no caixa ${id}`);
    else limpo.caixas[String(id)] = m; // exceção pode ser "desligado" (desliga um caixa de uma loja ligada)
  }
  if (problemas.length) {
    const e = new Error(problemas.slice(0, 6).join('\n'));
    e.validacao = true;
    throw e;
  }
  fs.mkdirSync(path.dirname(ARQUIVO), { recursive: true });
  fs.writeFileSync(ARQUIVO + '.tmp', JSON.stringify(limpo, null, 2) + '\n');
  fs.renameSync(ARQUIVO + '.tmp', ARQUIVO);
  dados = limpo;
  return configTara();
}
