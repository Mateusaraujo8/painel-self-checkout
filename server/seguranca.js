// Proteções de segurança do servidor: cabeçalhos, origem dos pedidos, limite de tentativas,
// comparação de token em tempo constante e limpeza de tudo que chega dos agentes.
//
// Não há banco de dados SQL neste projeto (tudo é guardado em arquivos JSON e nenhuma consulta é
// montada com texto do usuário), então "SQL injection" não se aplica. As injeções possíveis aqui
// são outras: HTML/script na página (XSS), quebra de linha no log e chaves especiais de objeto
// (__proto__). Cada uma é tratada abaixo e nos pontos de entrada.
import crypto from 'node:crypto';

// ---------------------------------------------------------------- cabeçalhos HTTP
/**
 * Content-Security-Policy e companhia. Scripts só do próprio servidor (sem inline, sem eval);
 * a página não pode ser embutida em outro site (clickjacking).
 */
export function cabecalhos(req, res, next) {
  const host = String(req.headers.host || '').replace(/[^\w.:[\]-]/g, '');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      // Estilos: arquivos próprios + atributos style aplicados pelo JavaScript (telas e zoom).
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      `connect-src 'self' ws://${host} wss://${host}`,
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  next();
}

// ---------------------------------------------------------------- origem (CSRF)
/**
 * O pedido veio de uma página deste mesmo servidor? Bloqueia site de fora mandando o navegador
 * de um fiscal logado fazer algo (CSRF) e abrir WebSocket com o login dele.
 * Sem cabeçalho Origin (ex.: PowerShell, agente) passa: não há navegador de vítima envolvido.
 */
export function origemOk(req) {
  const origem = req.headers.origin;
  if (!origem) return true;
  try {
    return new URL(origem).host === req.headers.host;
  } catch {
    return false;
  }
}

export function exigirMesmaOrigem(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || origemOk(req)) return next();
  res.status(403).json({ erro: 'Pedido recusado: origem diferente do painel' });
}

// ---------------------------------------------------------------- limite de tentativas
/** Conta erros por chave (IP, login...) numa janela; passou do limite, bloqueia por um tempo. */
export class Limitador {
  constructor({ maximo, janelaMs, bloqueioMs }) {
    Object.assign(this, { maximo, janelaMs, bloqueioMs });
    this.mapa = new Map(); // chave -> { erros, inicio, ate }
    setInterval(() => this.limpar(), 60_000).unref();
  }
  bloqueadoAte(chave) {
    const t = this.mapa.get(chave);
    return t && t.ate > Date.now() ? t.ate : 0;
  }
  /** Registra um erro; devolve true se a chave acabou de ser bloqueada. */
  erro(chave) {
    const agora = Date.now();
    let t = this.mapa.get(chave);
    if (!t || agora - t.inicio > this.janelaMs) t = { erros: 0, inicio: agora, ate: 0 };
    t.erros += 1;
    let bloqueou = false;
    if (t.erros >= this.maximo) {
      t.ate = agora + this.bloqueioMs;
      t.erros = 0;
      t.inicio = agora;
      bloqueou = true;
    }
    this.mapa.set(chave, t);
    return bloqueou;
  }
  acerto(chave) {
    this.mapa.delete(chave);
  }
  limpar() {
    const agora = Date.now();
    for (const [k, t] of this.mapa) if (t.ate < agora && agora - t.inicio > this.janelaMs) this.mapa.delete(k);
    // Teto de memória: alguém varrendo IPs/logins não enche o servidor.
    if (this.mapa.size > 10_000) this.mapa.clear();
  }
}

// ---------------------------------------------------------------- comparação em tempo constante
/** Compara segredos sem vazar, pelo tempo de resposta, quantos caracteres batem. */
export function segredoIgual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------------------------------------------------------------- limpeza de texto
/** Texto de uma linha: sem caracteres de controle (quebra de linha, ESC...), com tamanho máximo. */
export function textoLimpo(valor, max = 200) {
  if (valor == null) return '';
  return String(valor)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .trim()
    .slice(0, max);
}

const numero = (v, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : null;
};

const STATUS_CAIXA = new Set(['livre', 'em_venda', 'pagamento', 'fechado', 'bloqueado', 'manutencao']);

/**
 * Tudo que um agente manda passa por aqui antes de entrar no estado (e na tela dos fiscais).
 * O token do agente fica nos caixas; se um caixa for invadido, o pior que ele manda é texto
 * curto e número dentro da faixa — nunca HTML, script ou tipo inesperado.
 */
export function agenteLimpo(msg, tiposAlerta) {
  const m = msg && typeof msg === 'object' ? msg : {};
  const loja = Number(m.loja);
  const pdv = Number(m.pdv);
  const limpo = {
    loja: Number.isInteger(loja) && loja >= 1 && loja <= 9999 ? loja : null,
    pdv: Number.isInteger(pdv) && pdv >= 1 && pdv <= 999 ? pdv : null,
    versao: /^[\w.+-]{1,30}$/.test(String(m.versao || '')) ? String(m.versao) : '0',
  };
  if ('nome' in m) limpo.nome = textoLimpo(m.nome, 40) || undefined;
  if ('portaVnc' in m) {
    const p = Number(m.portaVnc);
    limpo.portaVnc = Number.isInteger(p) && p >= 1 && p <= 65535 ? p : undefined;
  }
  if ('status' in m) limpo.status = STATUS_CAIXA.has(m.status) ? m.status : 'livre';
  if ('operador' in m) limpo.operador = m.operador == null ? null : textoLimpo(m.operador, 60) || null;
  if ('vendasHoje' in m) limpo.vendasHoje = Math.round(numero(m.vendasHoje, 0, 100_000) ?? 0);
  if ('totalHoje' in m) limpo.totalHoje = m.totalHoje == null ? null : Math.round((numero(m.totalHoje, 0, 1e9) ?? 0) * 100) / 100;
  if ('fiscal' in m) {
    // Notas fiscais do dia: autorizadas, sem autorização (desde quando) e erros de envio.
    const f = m.fiscal;
    const inteiro = (v) => Math.round(numero(v, 0, 100_000) ?? 0);
    const horario = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > Date.now() - 2 * 864e5 && n < Date.now() + 864e5 ? Math.round(n) : null;
    };
    limpo.fiscal =
      f && typeof f === 'object'
        ? {
            autorizadas: inteiro(f.autorizadas),
            // Contingência: vendas do dia cuja nota não foi autorizada no caixa (agente 1.9+).
            contingencia: 'contingencia' in f ? inteiro(f.contingencia) : null,
            valorContingencia: 'valorContingencia' in f ? Math.round((numero(f.valorContingencia, 0, 1e9) ?? 0) * 100) / 100 : null,
            pendentes: inteiro(f.pendentes),
            pendenteDesde: horario(f.pendenteDesde),
            errosEnvio: inteiro(f.errosEnvio),
            ultimoErro: horario(f.ultimoErro),
          }
        : null;
  }
  if ('taraAuto' in m) {
    // Última tara automática feita pelo agente: {em, ok (true/false/null = aguardando), peso, motivo}
    const t = m.taraAuto;
    const em = Number(t?.em);
    limpo.taraAuto =
      t && typeof t === 'object' && Number.isFinite(em) && em > Date.now() - 2 * 864e5 && em < Date.now() + 864e5
        ? {
            em: Math.round(em),
            ok: t.ok === true ? true : t.ok === false ? false : null,
            peso: t.peso == null ? null : Math.round((numero(t.peso, -100, 100) ?? 0) * 1000) / 1000,
            motivo: textoLimpo(t.motivo, 120),
          }
        : null;
  }
  if ('alerta' in m) {
    const a = m.alerta;
    if (a && typeof a === 'object' && a.alerta) {
      const tipo = String(a.alerta);
      limpo.alerta = { alerta: Object.hasOwn(tiposAlerta, tipo) ? tipo : 'erro', mensagem: textoLimpo(a.mensagem, 200) };
    } else limpo.alerta = null;
  }
  return limpo;
}
