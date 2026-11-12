// Indicadores da aba "Indicadores" (Configurações): alertas, tempo de espera e vendas.
//
// - Alertas e espera vêm do registro de ações (data/eventos): cada alerta vai de "alerta aberto"
//   até "resolvido no caixa" ou "liberado pelo painel". A espera do cliente é esse intervalo.
// - Vendas: os agentes só mandam o acumulado do dia. Este módulo guarda, por dia, a última
//   contagem e o último valor de cada caixa em data/vendas/AAAA-MM.json (1x por minuto).
import fs from 'node:fs';
import path from 'node:path';
import { RAIZ } from './config.js';
import { aviso } from './log.js';
import * as eventos from './eventos.js';
import { estado, TIPOS_ALERTA } from './estado.js';
import { estacoes } from './estacoes.js';

const PASTA_VENDAS = path.join(RAIZ, 'data', 'vendas');

// Data local (fuso do servidor) no formato AAAA-MM-DD.
const diaLocal = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ---------------------------------------------------------------- vendas por dia
function lerMes(mes) {
  try {
    return JSON.parse(fs.readFileSync(path.join(PASTA_VENDAS, `${mes}.json`), 'utf8'));
  } catch {
    return {};
  }
}

// O acumulado que o caixa mandou vale para o dia do último contato dele. Um caixa desligado
// desde ontem continua com o total de ontem no estado: entra em ontem, não em hoje.
const diaDoCaixa = (c) => diaLocal(c.ultimoContato || Date.now());

// Foto ao vivo de um caixa: vendas autorizadas (v, t) e, do agente 1.9 em diante, as notas
// em contingência (c = quantas, vc = valor), que não entram em v/t.
const contingenciaAoVivo = (c) => (c.fiscal?.contingencia != null ? c.fiscal.contingencia : null);
const temMovimento = (c) => c.versao !== 'manual' && (c.vendasHoje > 0 || contingenciaAoVivo(c) > 0);
function fotoAoVivo(c) {
  const foto = { v: c.vendasHoje || 0, t: c.totalHoje ?? null };
  if (contingenciaAoVivo(c) != null) {
    foto.c = c.fiscal.contingencia;
    foto.vc = c.fiscal.valorContingencia ?? null;
  }
  return foto;
}
// Nunca diminui: se o caixa reiniciar a contagem no meio do dia, fica o maior valor visto.
// O número vindo das notas (histórico do caixa) é exato: a foto ao vivo não o substitui.
function juntarFoto(antes, foto) {
  if (antes?.origem === 'nfce') return antes;
  if (!antes) return foto;
  return {
    v: foto.v >= antes.v ? foto.v : antes.v,
    t: foto.v >= antes.v ? foto.t : antes.t,
    ...(foto.c != null || antes.c != null
      ? (foto.c ?? -1) >= (antes.c ?? -1)
        ? { c: foto.c, vc: foto.vc }
        : { c: antes.c, vc: antes.vc }
      : {}),
  };
}

const ultimoGravado = new Map(); // mes -> texto
function guardarVendasDoDia() {
  const porMes = new Map();
  for (const c of estado.lista()) {
    if (!temMovimento(c)) continue;
    const dia = diaDoCaixa(c);
    const mes = dia.slice(0, 7);
    if (!porMes.has(mes)) porMes.set(mes, lerMes(mes));
    const dados = porMes.get(mes);
    const doDia = (dados[dia] ||= {});
    doDia[c.id] = juntarFoto(doDia[c.id], fotoAoVivo(c));
  }
  for (const [mes, dados] of porMes) {
    const texto = JSON.stringify(dados);
    if (texto === ultimoGravado.get(mes)) continue;
    try {
      fs.mkdirSync(PASTA_VENDAS, { recursive: true });
      const arq = path.join(PASTA_VENDAS, `${mes}.json`);
      fs.writeFileSync(arq + '.tmp', texto);
      fs.renameSync(arq + '.tmp', arq);
      ultimoGravado.set(mes, texto);
    } catch (e) {
      aviso(`Não foi possível gravar as vendas do dia: ${e.message}`);
    }
  }
}
setInterval(guardarVendasDoDia, 60_000).unref();
setTimeout(guardarVendasDoDia, 15_000).unref();

/** Vendas por caixa e por dia no intervalo [deDia, ateDia] (AAAA-MM-DD). Hoje vem ao vivo. */
function vendasNoPeriodo(deDia, ateDia) {
  const porDia = {}; // dia -> { caixa -> {v, t} }
  const meses = new Set();
  for (let d = new Date(`${deDia}T12:00:00`); diaLocal(d.getTime()) <= ateDia; d.setDate(d.getDate() + 1)) meses.add(diaLocal(d.getTime()).slice(0, 7));
  for (const mes of meses) {
    for (const [dia, caixas] of Object.entries(lerMes(mes))) if (dia >= deDia && dia <= ateDia) porDia[dia] = { ...caixas };
  }
  // Valores ao vivo (mais novos que a última gravação), cada um no dia do último contato.
  for (const c of estado.lista()) {
    if (!temMovimento(c)) continue;
    const dia = diaDoCaixa(c);
    if (dia < deDia || dia > ateDia) continue;
    porDia[dia] ||= {};
    porDia[dia][c.id] = juntarFoto(porDia[dia][c.id], fotoAoVivo(c));
  }
  return porDia;
}

// ---------------------------------------------------------------- histórico vindo dos caixas
/**
 * O agente relê as notas (NFC-e) e o log diário dos últimos dias e manda para cá. Serve para
 * recuperar o que o painel perdeu enquanto esteve desligado.
 *  - vendas: o número das notas é exato e substitui a foto tirada ao vivo (dias passados);
 *  - "Self chamou o fiscal": entra no registro com o horário original, só se o painel não
 *    tiver registrado esse chamado ao vivo (início a menos de 2 min de um que já existe).
 * Devolve quantos dias de venda e quantos chamados foram aproveitados.
 */
export function receberHistorico(id, dias) {
  const hoje = diaLocal();
  const porMes = new Map();
  let diasVendas = 0;
  for (const d of dias) {
    if (d.dia >= hoje || d.vendas == null) continue; // hoje vem ao vivo
    const mes = d.dia.slice(0, 7);
    if (!porMes.has(mes)) porMes.set(mes, lerMes(mes));
    const dados = porMes.get(mes);
    const doDia = (dados[d.dia] ||= {});
    const novo = { v: d.vendas, t: d.total };
    if (d.contingencia != null) {
      novo.c = d.contingencia;
      novo.vc = d.valorContingencia;
    } else if (doDia[id]?.c != null) {
      // Agente antigo (sem contingência) não apaga o que um agente novo já mandou.
      novo.c = doDia[id].c;
      novo.vc = doDia[id].vc;
    }
    novo.origem = 'nfce';
    if (JSON.stringify(doDia[id]) !== JSON.stringify(novo)) {
      if (d.vendas > 0 || novo.c > 0 || doDia[id]) doDia[id] = novo;
      diasVendas++;
    }
  }
  for (const [mes, dados] of porMes) {
    fs.mkdirSync(PASTA_VENDAS, { recursive: true });
    const arq = path.join(PASTA_VENDAS, `${mes}.json`);
    fs.writeFileSync(arq + '.tmp', JSON.stringify(dados));
    fs.renameSync(arq + '.tmp', arq);
    ultimoGravado.set(mes, JSON.stringify(dados));
  }

  // Chamados: compara com os alertas que já estão no registro desse caixa. Chamado de hoje
  // ainda sem fim fica para o envio ao vivo; de dias passados sem fim entra "sem duração".
  const agora = Date.now();
  const todos = dias
    .flatMap((d) => d.chamados || [])
    .filter(([ini, fim]) => fim != null || agora - ini > 3600e3);
  if (!todos.length) return { diasVendas, chamados: 0 };
  const de = Math.min(...todos.map((c) => c[0])) - 3600e3;
  const ate = Math.max(...todos.map((c) => c[1] ?? c[0])) + 3600e3;
  // Qualquer alerta (de qualquer tipo) já registrado: o EnviarAlerta do Acrux é o aviso ao
  // monitor do fiscal e acompanha também cancelamento, peso etc. que o painel viu ao vivo.
  const existentes = eventos
    .consultar({ de, ate, caixa: id, semLimite: true })
    .filter((e) => e.tipo === 'alerta')
    .map((e) => e.t);
  const novos = [];
  for (const [ini, fim] of todos) {
    if (existentes.some((t) => Math.abs(t - ini) < 120_000)) continue;
    const rotulo = TIPOS_ALERTA.chamado.rotulo;
    novos.push({ t: ini, tipo: 'alerta', caixa: id, alerta: 'chamado', origem: 'recuperado', detalhe: `${rotulo} (recuperado do log do caixa)` });
    if (fim != null) {
      const segundos = Math.round((fim - ini) / 1000);
      novos.push({ t: fim, tipo: 'alerta_fim', caixa: id, alerta: 'chamado', segundos, origem: 'recuperado', detalhe: `${rotulo} · aberto por ${segundos}s (recuperado)` });
    } else {
      // O caixa não registrou o fim: fecha logo depois, marcado "sem duração" (fica fora da espera).
      novos.push({ t: ini + 1, tipo: 'alerta_fim', caixa: id, alerta: 'chamado', semDuracao: true, origem: 'recuperado', detalhe: `${rotulo} · fim não registrado pelo caixa (recuperado)` });
    }
    existentes.push(ini);
  }
  if (novos.length) eventos.registrarComHorario(novos);
  return { diasVendas, chamados: novos.filter((e) => e.tipo === 'alerta').length };
}

// ---------------------------------------------------------------- alertas
const ROTULO_PARA_TIPO = Object.fromEntries(Object.entries(TIPOS_ALERTA).map(([k, v]) => [v.rotulo, k]));
function tipoDoEvento(ev) {
  return ev.alerta || ROTULO_PARA_TIPO[String(ev.detalhe || '').split(' · ')[0]] || 'erro';
}

/** Episódios de alerta (abre -> fecha) dos caixas cadastrados, no intervalo. */
function episodios(de, ate) {
  // Busca um pouco antes do início para pegar alertas que já estavam abertos.
  const evs = eventos
    .consultar({ de: de - 3 * 3600e3, ate, semLimite: true })
    .filter((e) => ['alerta', 'alerta_fim', 'liberar', 'atender'].includes(e.tipo) && e.caixa)
    .sort((a, b) => a.t - b.t);
  const abertos = new Map();
  const lista = [];
  for (const ev of evs) {
    const a = abertos.get(ev.caixa);
    if (ev.tipo === 'alerta') {
      if (!a) abertos.set(ev.caixa, { caixa: ev.caixa, tipo: tipoDoEvento(ev), ini: ev.t });
    } else if (ev.tipo === 'atender') {
      if (a && !a.atendido) a.atendido = ev.t;
    } else if (a) {
      a.fim = ev.t;
      a.semDuracao = Boolean(ev.semDuracao); // recuperado sem o fim registrado no caixa
      a.peloPainel = ev.tipo === 'liberar';
      lista.push(a);
      abertos.delete(ev.caixa);
    }
  }
  for (const a of abertos.values()) lista.push(a); // ainda abertos (sem fim)
  return lista.filter((e) => e.ini >= de && e.ini <= ate);
}

const mediana = (v) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const percentil = (v, p) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)];
};
const resumoEspera = (eps) => {
  const durs = eps.filter((e) => e.fim && !e.semDuracao).map((e) => Math.round((e.fim - e.ini) / 1000));
  return { n: eps.length, mediana: mediana(durs), p90: percentil(durs, 0.9), maxima: durs.length ? Math.max(...durs) : null };
};

/**
 * Indicadores do período. `de`/`ate` em ms; `loja` opcional.
 * Só entram caixas do cadastro (estacoes.json): testes e simuladores ficam de fora.
 */
export function calcular({ de, ate, loja, tipo = 'self' }) {
  const cad = estacoes.cadastro();
  const nomesLojas = Object.fromEntries(cad.lojas.map((l) => [l.codigo, l.nome]));
  // Só os caixas do tipo pedido: selfs (padrão) ou PDVs normais. Os números não se misturam.
  const cadastrados = new Set(
    cad.caixas.filter((c) => tipo === 'todos' || (c.tipo === 'pdv') === (tipo === 'pdv')).map((c) => `${c.loja}-${c.pdv}`),
  );
  const daLoja = (id) => cadastrados.has(id) && (!loja || id.split('-')[0] === String(loja));

  // ---- alertas
  const eps = episodios(de, ate).filter((e) => daLoja(e.caixa));
  const fechados = eps.filter((e) => e.fim && !e.semDuracao);
  const espera = resumoEspera(eps);
  const rapidos = fechados.filter((e) => e.fim - e.ini < 15_000).length;
  const atendidos = eps.filter((e) => e.atendido || e.peloPainel).length;
  const ateAtender = eps.filter((e) => e.atendido).map((e) => Math.round((e.atendido - e.ini) / 1000));

  const porTipo = [...Map.groupBy(eps, (e) => e.tipo)]
    .map(([tipo, lista]) => ({ tipo, rotulo: TIPOS_ALERTA[tipo]?.rotulo || tipo, ...resumoEspera(lista) }))
    .sort((a, b) => b.n - a.n);

  const porHora = Array.from({ length: 24 }, (_, h) => ({ hora: h, n: 0 }));
  for (const e of eps) porHora[new Date(e.ini).getHours()].n++;

  // ---- vendas
  const porDiaVendas = vendasNoPeriodo(diaLocal(de), diaLocal(ate));
  const vendasCaixa = {}; // id -> {v, t, semValor, c, vc, vComC, diasC}
  const porDia = {};
  let desdeContingencia = null;
  const pct = (c, v) => (c + v ? Math.round((c / (c + v)) * 1000) / 10 : null);
  for (const [dia, caixas] of Object.entries(porDiaVendas)) {
    for (const [id, x] of Object.entries(caixas)) {
      if (!daLoja(id)) continue;
      const vc = (vendasCaixa[id] ||= { v: 0, t: 0, semValor: 0, c: 0, vc: 0, vComC: 0, diasC: 0 });
      vc.v += x.v || 0;
      if (x.t == null) vc.semValor += x.v || 0;
      else vc.t += x.t;
      const pd = (porDia[dia] ||= { dia, vendas: 0, total: 0 });
      pd.vendas += x.v || 0;
      pd.total += x.t || 0;
      // Contingência só conta onde o agente informou (1.9+); o % usa as vendas desses mesmos dias.
      if (x.c != null) {
        vc.c += x.c;
        vc.vc += x.vc || 0;
        vc.vComC += x.v || 0;
        vc.diasC++;
        pd.contingencia = (pd.contingencia || 0) + x.c;
        pd.valorContingencia = (pd.valorContingencia || 0) + (x.vc || 0);
        pd.vendasComC = (pd.vendasComC || 0) + (x.v || 0);
        if (!desdeContingencia || dia < desdeContingencia) desdeContingencia = dia;
      }
    }
  }
  for (const e of eps) {
    const d = diaLocal(e.ini);
    (porDia[d] ||= { dia: d, vendas: 0, total: 0 }).alertas = (porDia[d].alertas || 0) + 1;
  }

  // ---- por caixa e por loja
  const ids = new Set([...eps.map((e) => e.caixa), ...Object.keys(vendasCaixa)]);
  const porCaixa = [...ids].map((id) => {
    const [l, p] = id.split('-').map(Number);
    const meus = eps.filter((e) => e.caixa === id);
    const vc = vendasCaixa[id] || { v: 0, t: 0, semValor: 0, c: 0, vc: 0, vComC: 0, diasC: 0 };
    return {
      contingencia: vc.diasC ? vc.c : null,
      valorContingencia: vc.diasC ? Math.round(vc.vc * 100) / 100 : null,
      percentContingencia: vc.diasC ? pct(vc.c, vc.vComC) : null,
      _vComC: vc.vComC,
      id,
      loja: l,
      pdv: p,
      nomeLoja: nomesLojas[l] || '',
      alertas: meus.length,
      esperaMediana: resumoEspera(meus).mediana,
      vendas: vc.v,
      total: Math.round(vc.t * 100) / 100,
      semValor: vc.semValor > 0 && vc.t === 0,
      alertasPor100Vendas: vc.v ? Math.round((meus.length / vc.v) * 1000) / 10 : null,
    };
  });
  const porLoja = Object.values(
    porCaixa.reduce((acc, c) => {
      const x = (acc[c.loja] ||= { loja: c.loja, nome: c.nomeLoja, alertas: 0, vendas: 0, total: 0, caixas: 0, _eps: [], _c: null, _vc: 0, _vComC: 0, _cxCont: 0 });
      x.alertas += c.alertas;
      x.vendas += c.vendas;
      x.total += c.total;
      x.caixas += 1;
      x._eps.push(...eps.filter((e) => e.caixa === c.id));
      if (c.contingencia != null) {
        x._c = (x._c || 0) + c.contingencia;
        x._vc += c.valorContingencia || 0;
        x._vComC += c._vComC;
        if (c.contingencia > 0) x._cxCont++;
      }
      return acc;
    }, {}),
  ).map(({ _eps, _c, _vc, _vComC, _cxCont, ...x }) => ({
    ...x,
    total: Math.round(x.total * 100) / 100,
    esperaMediana: resumoEspera(_eps).mediana,
    contingencia: _c,
    valorContingencia: _c == null ? null : Math.round(_vc * 100) / 100,
    percentContingencia: _c == null ? null : pct(_c, _vComC),
    caixasComContingencia: _cxCont,
  }));
  const comC = porCaixa.filter((c) => c.contingencia != null);
  const totalCont = comC.reduce((s, c) => s + c.contingencia, 0);
  const valorCont = comC.reduce((s, c) => s + c.valorContingencia, 0);
  const vendasComC = comC.reduce((s, c) => s + c._vComC, 0);
  for (const c of porCaixa) delete c._vComC;

  const totalVendas = porCaixa.reduce((s, c) => s + c.vendas, 0);
  const totalValor = porCaixa.reduce((s, c) => s + c.total, 0);
  const vendasComValor = porCaixa.filter((c) => c.total > 0).reduce((s, c) => s + c.vendas, 0);

  const primeiroEvento = eventos.primeiroRegistro();
  const primeiraVenda = fs.existsSync(PASTA_VENDAS)
    ? fs.readdirSync(PASTA_VENDAS).filter((f) => /^\d{4}-\d{2}\.json$/.test(f)).sort().map((f) => Object.keys(lerMes(f.slice(0, 7))).sort()[0]).find(Boolean) || null
    : null;

  return {
    periodo: { de, ate },
    tipo,
    temPdvNormal: cad.caixas.some((c) => c.tipo === 'pdv'),
    desde: { alertas: primeiroEvento, vendas: primeiraVenda },
    alertas: {
      total: eps.length,
      abertosAgora: estado.lista().filter((c) => c.alerta && daLoja(c.id)).length,
      espera,
      rapidos,
      percentRapidos: fechados.length ? Math.round((rapidos / fechados.length) * 100) : null,
      percentPeloPainel: eps.length ? Math.round((atendidos / eps.length) * 100) : null,
      ateAtenderMediana: mediana(ateAtender),
      porTipo,
      porHora,
    },
    vendas: {
      total: totalVendas,
      valor: Math.round(totalValor * 100) / 100,
      ticketMedio: vendasComValor ? Math.round((totalValor / vendasComValor) * 100) / 100 : null,
    },
    // Notas em contingência: vendas concluídas cuja NFC-e não foi autorizada no caixa.
    // Ficam fora de "vendas" (que só conta notas autorizadas). null = nenhum agente 1.9 no período.
    contingencia: comC.length
      ? {
          total: totalCont,
          valor: Math.round(valorCont * 100) / 100,
          percent: pct(totalCont, vendasComC),
          caixas: comC.filter((c) => c.contingencia > 0).length,
          caixasInformando: comC.length,
          desde: desdeContingencia,
        }
      : null,
    porDia: Object.values(porDia)
      .map(({ vendasComC: vComC, ...d }) => ({
        ...d,
        total: Math.round(d.total * 100) / 100,
        alertas: d.alertas || 0,
        contingencia: d.contingencia ?? null,
        valorContingencia: d.contingencia == null ? null : Math.round(d.valorContingencia * 100) / 100,
        percentContingencia: d.contingencia == null ? null : pct(d.contingencia, vComC),
      }))
      .sort((a, b) => a.dia.localeCompare(b.dia)),
    porCaixa: porCaixa.sort((a, b) => a.loja - b.loja || a.pdv - b.pdv),
    porLoja: porLoja.sort((a, b) => a.loja - b.loja),
  };
}
