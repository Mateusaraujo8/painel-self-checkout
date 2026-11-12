// Usuários do painel, com senha guardada como hash scrypt em data/usuarios.json.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { RAIZ } from './config.js';

const ARQUIVO = path.join(RAIZ, 'data', 'usuarios.json');
// Dois níveis: 'admin' = TI / Administrador (altera tudo); 'supervisor' = Fiscal (só o painel).
// Os valores internos ficam iguais para não quebrar os logins existentes.
export const PERFIS = ['admin', 'supervisor'];
const APELIDOS = { ti: 'admin', administrador: 'admin', fiscal: 'supervisor' };
const perfilDe = (p) => {
  const k = String(p || '').toLowerCase();
  return Object.hasOwn(APELIDOS, k) ? APELIDOS[k] : p;
};

// Logins que confundiriam objetos JavaScript ("__proto__" mudaria o protótipo da lista).
const RESERVADOS = new Set(['__proto__', 'constructor', 'prototype', 'hasownproperty', 'tostring', 'valueof']);

// O arquivo é consultado a cada pedido (para derrubar na hora quem foi desativado). Em vez de
// ler o disco toda vez, guarda o texto em memória e só relê quando o arquivo mudar.
let cache = { chave: '', texto: '' };
function textoDoArquivo() {
  let st;
  try {
    st = fs.statSync(ARQUIVO);
  } catch {
    return null;
  }
  const chave = `${st.mtimeMs}:${st.size}`;
  if (cache.chave !== chave) cache = { chave, texto: fs.readFileSync(ARQUIVO, 'utf8').replace(/^\uFEFF/, '') };
  return cache.texto;
}

/** Lista de usuários num objeto sem protótipo: chave "__proto__" ou "constructor" é só texto. */
function ler() {
  const lista = Object.create(null);
  const texto = textoDoArquivo();
  if (texto == null) return lista;
  const dados = JSON.parse(texto);
  for (const [k, v] of Object.entries(dados)) if (!RESERVADOS.has(k) && v && typeof v === 'object') lista[k] = v;
  return lista;
}

function gravar(lista) {
  fs.mkdirSync(path.dirname(ARQUIVO), { recursive: true });
  const tmp = ARQUIVO + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(lista, null, 2));
  fs.renameSync(tmp, ARQUIVO);
  cache = { chave: '', texto: '' }; // próxima leitura pega a versão nova
}

function hash(senha, sal = crypto.randomBytes(16)) {
  const h = crypto.scryptSync(String(senha), sal, 64);
  return `scrypt$${sal.toString('hex')}$${h.toString('hex')}`;
}

const normalizar = (login) => String(login || '').trim().toLowerCase();
// Nome de exibição: uma linha, sem caracteres de controle, até 60 caracteres.
const nomeLimpo = (nome) =>
  String(nome ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .trim()
    .slice(0, 60);

// Senhas fáceis demais de adivinhar (comparação sem maiúsculas/minúsculas).
const SENHAS_FRACAS = new Set([
  '12345678', '123456789', '1234567890', '87654321', '11111111', '00000000', 'password', 'senha123',
  'senha1234', 'mudar123', 'admin123', 'admin1234', 'qwerty123', 'abc12345', 'abcd1234',
]);

/** Regras para senha nova (as já existentes continuam valendo até serem trocadas). */
export function validarSenhaNova(senha, login = '') {
  if (typeof senha !== 'string') return 'Informe a senha';
  if (senha.length < 8) return 'A senha precisa ter pelo menos 8 caracteres';
  if (senha.length > 200) return 'A senha pode ter no máximo 200 caracteres';
  const minuscula = senha.toLowerCase();
  if (login && minuscula.includes(String(login).toLowerCase())) return 'A senha não pode conter o login';
  if (/^(.)\1+$/.test(senha)) return 'A senha não pode ser um caractere repetido';
  if (SENHAS_FRACAS.has(minuscula)) return 'Essa senha é muito comum. Escolha outra';
  return null;
}

export function listar() {
  return Object.entries(ler()).map(([login, u]) => ({
    login,
    nome: u.nome,
    perfil: u.perfil,
    criadoEm: u.criadoEm,
    ultimoAcesso: u.ultimoAcesso || null,
    ativo: u.ativo !== false,
  }));
}

export function existe(login) {
  return Boolean(ler()[normalizar(login)]);
}

/** Existe e não está desativado (sessões abertas de quem foi desativado caem). */
export function podeEntrar(login) {
  const u = ler()[normalizar(login)];
  return Boolean(u) && u.ativo !== false;
}

/** Muda nome, perfil e/ou ativo. */
export function atualizar(login, { nome, perfil, ativo } = {}) {
  login = normalizar(login);
  const lista = ler();
  const u = lista[login];
  if (!u) throw new Error(`Usuário "${login}" não existe`);
  if (perfil !== undefined) {
    perfil = perfilDe(perfil);
    if (!PERFIS.includes(perfil)) throw new Error(`Perfil deve ser: ${PERFIS.join(' ou ')}`);
    u.perfil = perfil;
  }
  if (nome !== undefined) {
    const n = nomeLimpo(nome);
    if (!n) throw new Error('Informe o nome');
    u.nome = n;
  }
  if (ativo !== undefined) u.ativo = Boolean(ativo);
  gravar(lista);
}

export function marcarAcesso(login) {
  login = normalizar(login);
  const lista = ler();
  if (!lista[login]) return;
  lista[login].ultimoAcesso = new Date().toISOString();
  gravar(lista);
}

export function existeAlgum() {
  return Object.keys(ler()).length > 0;
}

export function criar(login, senha, { nome, perfil = 'supervisor' } = {}) {
  login = normalizar(login);
  perfil = perfilDe(perfil);
  if (!/^[a-z0-9][a-z0-9._-]{1,29}$/.test(login)) {
    throw new Error('Login deve ter de 2 a 30 letras minúsculas, números, ponto, hífen ou _ (começando por letra ou número)');
  }
  if (RESERVADOS.has(login)) throw new Error('Esse login não pode ser usado');
  if (!PERFIS.includes(perfil)) throw new Error(`Perfil deve ser: ${PERFIS.join(' ou ')}`);
  const erroSenha = validarSenhaNova(senha, login);
  if (erroSenha) throw new Error(erroSenha);
  const lista = ler();
  if (lista[login]) throw new Error(`Usuário "${login}" já existe`);
  lista[login] = { nome: nomeLimpo(nome) || login, perfil, senha: hash(senha), criadoEm: new Date().toISOString() };
  gravar(lista);
}

export function trocarSenha(login, senha) {
  login = normalizar(login);
  const erroSenha = validarSenhaNova(senha, login);
  if (erroSenha) throw new Error(erroSenha);
  const lista = ler();
  if (!lista[login]) throw new Error(`Usuário "${login}" não existe`);
  lista[login].senha = hash(senha);
  lista[login].senhaTrocadaEm = new Date().toISOString();
  gravar(lista);
}

export function remover(login) {
  login = normalizar(login);
  const lista = ler();
  if (!lista[login]) throw new Error(`Usuário "${login}" não existe`);
  delete lista[login];
  gravar(lista);
}

// Hash fixo para gastar o mesmo tempo quando o usuário não existe.
const HASH_FALSO = hash(crypto.randomBytes(8).toString('hex'));

/** Retorna { login, nome, perfil } se a senha confere, senão null. */
export function autenticar(login, senha) {
  login = normalizar(login);
  const u = ler()[login];
  const guardado = /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(u?.senha || '') ? u.senha : HASH_FALSO;
  const [, salHex, hHex] = guardado.split('$');
  const calculado = crypto.scryptSync(String(senha || '').slice(0, 200), Buffer.from(salHex, 'hex'), 64);
  const ok = crypto.timingSafeEqual(calculado, Buffer.from(hHex, 'hex'));
  return ok && u && guardado === u.senha && u.ativo !== false ? { login, nome: u.nome, perfil: u.perfil } : null;
}
