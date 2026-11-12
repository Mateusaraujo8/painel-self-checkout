#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Agente do Painel Self-Checkout para PDVs Linux (AcruxPDV).

Só usa a biblioteca padrão do Python 3 (compatível com Python 3.5 / Ubuntu 16.04 32 bits).

O que ele faz:
  * Lê os logs do AcruxPDV (só leitura) e deduz a situação do caixa:
      - trace_DDMMAA.log  -> estado (livre / em venda / pagamento / fechado),
                             vendas e total do dia, pedido de senha do fiscal,
                             mensagem parada na tela
      - selfcheckout.log  -> divergência de peso na balança
  * A cada N segundos envia o estado ao painel (POST /api/agente) e recebe comandos.
  * Abre uma API local (só 127.0.0.1) para outros programas avisarem eventos:
        POST /status       {"status":"em_venda","operador":"Maria"}
        POST /alerta       {"alerta":"ajuda","mensagem":"Cliente chamou"}
        POST /alerta/fim
        GET  /comandos     -> comandos recebidos do painel
        GET  /estado       -> o que o agente está enviando

Linha de comando:
    python3 agente.py                     # roda o agente (serviço)
    python3 agente.py diagnostico [seg]   # só lê os logs e mostra o que deduziu (não envia nada)
    python3 agente.py alerta ajuda "Cliente chamou" | fim | status em_venda | estado

Configuração: /etc/painel-self/agente.conf (ou o arquivo em PAINEL_CONF).
LOJA e PDV, se vazios, são lidos de /c5client/AcruxPDV/AcruxPDV.terminal.
"""
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import zlib
from http.server import BaseHTTPRequestHandler, HTTPServer

VERSAO = '1.13.0'
# Histórico mandado ao painel depois de conectar (recupera o que ele perdeu se esteve desligado).
HISTORICO_DIAS = 30
HISTORICO_A_CADA = 6 * 3600
CONF_PADRAO = '/etc/painel-self/agente.conf'
PASTA_ACRUX = '/c5client/AcruxPDV'

# Prioridade de cada tipo de alerta (maior primeiro). Igual à do servidor.
PRIORIDADE = {
    'pagamento': 3, 'erro': 3,
    'chamado': 2, 'fiscal': 2, 'peso': 2, 'idade': 2, 'ajuda': 2, 'mensagem': 2, 'cancelamento': 2,
    'sem_papel': 1,
}

# Significado das ações (mt:[...]) do AcruxPDV que pedem senha do fiscal.
ACOES_FISCAL = {
    'mtDescontoItem': 'Desconto de item',
    'mtCancelarItem': 'Cancelamento de item',
    'mtCancelarCupom': 'Cancelamento da compra',
    'mtConsultaPreco': 'Consulta de preço',
    'mtTransacaoGerencialTEF': 'Operação de TEF',
}


def ler_conf():
    conf = {
        'SERVIDOR': 'http://127.0.0.1:8080',
        'TOKEN': '',
        'LOJA': '',
        'PDV': '',
        'NOME': '',
        'PORTA_VNC': '5900',
        'PORTA_LOCAL': '8765',
        'INTERVALO': '5',
        # Leitura dos logs do AcruxPDV
        'LER_LOGS_ACRUX': '1',
        'PASTA_LOGS_ACRUX': PASTA_ACRUX + '/log/aplicacao',
        # Tolerâncias antes de virar alerta (segundos)
        'SEGUNDOS_PESO': '15',
        'SEGUNDOS_MENSAGEM': '45',
        'SEGUNDOS_VENDA_PARADA': '300',
    }
    caminho = os.environ.get('PAINEL_CONF', CONF_PADRAO)
    if os.path.exists(caminho):
        with open(caminho, encoding='utf-8') as f:
            for linha in f:
                linha = linha.strip()
                if not linha or linha.startswith('#') or '=' not in linha:
                    continue
                chave, valor = linha.split('=', 1)
                conf[chave.strip()] = valor.strip().strip('"').strip("'")
    for chave in list(conf):
        if os.environ.get(chave):
            conf[chave] = os.environ[chave]
    completar_loja_pdv(conf)
    return conf


def completar_loja_pdv(conf):
    """Lê NroEmpresa / NroCheckout do AcruxPDV.terminal quando não configurados."""
    if conf['LOJA'] and conf['PDV']:
        return
    texto = ''
    for nome in ('AcruxPDV.info', 'AcruxPDV.terminal'):
        try:
            with open(os.path.join(PASTA_ACRUX, nome), encoding='latin-1') as f:
                texto += f.read() + '\n'
        except OSError:
            pass
    m_loja = re.search(r'NroEmpresa\s*=\s*(\d+)', texto)
    m_pdv = re.search(r'NroCheckout\s*=\s*(\d+)', texto)
    if not conf['LOJA'] and m_loja:
        conf['LOJA'] = str(int(m_loja.group(1)))
    if not conf['PDV'] and m_pdv:
        conf['PDV'] = str(int(m_pdv.group(1)))


def log(msg):
    # Nunca deixar o log derrubar o agente: no systemd a saída pode ser latin-1/ASCII e uma
    # página de erro (ex.: 502 de um proxy) traz caracteres que não cabem nela.
    linha = '%s %s\n' % (time.strftime('%Y-%m-%d %H:%M:%S'), msg)
    try:
        sys.stdout.write(linha)
    except UnicodeEncodeError:
        cod = getattr(sys.stdout, 'encoding', None) or 'ascii'
        sys.stdout.write(linha.encode(cod, 'replace').decode(cod))
    try:
        sys.stdout.flush()
    except Exception:
        pass


def numero_br(texto):
    """'12,45' -> 12.45"""
    try:
        return float(texto.replace(',', '.'))
    except ValueError:
        return 0.0


def hora_do_log(linha):
    """'11:27:48.071 ...' -> horário de hoje em segundos (epoch); se não der, agora."""
    try:
        h, m, s = int(linha[0:2]), int(linha[3:5]), int(linha[6:8])
        t = time.localtime()
        return time.mktime((t.tm_year, t.tm_mon, t.tm_mday, h, m, s, 0, 0, -1))
    except (ValueError, OverflowError):
        return time.time()


# ---------------------------------------------------------------- tela do caixa (tara automática)
# Janela principal do AcruxPDV. Com qualquer outra ativa (mensagem "Informação", senha etc.),
# o agente NÃO aperta tecla nenhuma.
JANELA_ACRUX = 'AcruxPDV'


def ambiente_x():
    """DISPLAY e XAUTHORITY da sessão gráfica (lidos do processo do X; o agente roda como root)."""
    disp, auth = ':0', None
    for pid in os.listdir('/proc'):
        if not pid.isdigit():
            continue
        try:
            with open('/proc/%s/cmdline' % pid, 'rb') as f:
                args = [a.decode('utf-8', 'replace') for a in f.read().split(b'\0') if a]
        except OSError:
            continue
        if not args or os.path.basename(args[0]) not in ('Xorg', 'X'):
            continue
        for i, a in enumerate(args):
            if a == '-auth' and i + 1 < len(args):
                auth = args[i + 1]
            elif re.match(r'^:\d+$', a):
                disp = a
        break
    if not auth and os.path.exists('/root/.Xauthority'):
        auth = '/root/.Xauthority'
    env = dict(os.environ, DISPLAY=disp)
    if auth:
        env['XAUTHORITY'] = auth
    return env


def xdotool(*args):
    """Roda o xdotool na sessão do caixa. Devolve (código, saída)."""
    try:
        r = subprocess.run(['xdotool'] + list(args), env=ambiente_x(), stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, timeout=5)
        # Nome de janela pode vir em latin-1 (ex.: "Informação" do AcruxPDV).
        try:
            texto = r.stdout.decode('utf-8')
        except UnicodeDecodeError:
            texto = r.stdout.decode('latin-1')
        return r.returncode, texto.strip()
    except (OSError, subprocess.TimeoutExpired) as e:
        return -1, str(e)


def janela_ativa():
    codigo, nome = xdotool('getactivewindow', 'getwindowname')
    return nome if codigo == 0 else None


# PDV normal: a tela em que o caixa pede a senha do fiscal (formulário TfrmAutenticarUsuario do
# AcruxPDV). Reconhecida pelo nome da janela ativa.
JANELA_SENHA_FISCAL = re.compile(r'autentica|senha|supervis|fiscal|autoriza', re.I)


def condicoes_pdv(nome_janela):
    """Alertas de um PDV normal: só o pedido de senha do fiscal (some quando a janela fecha)."""
    if nome_janela and JANELA_SENHA_FISCAL.search(nome_janela):
        return {'fiscal': 'O caixa está pedindo a senha do fiscal'}
    return {}


def apertar_tara():
    """Aperta "b" (tara da balança de conferência, a mesma tecla do fiscal)."""
    codigo, saida = xdotool('key', '--clearmodifiers', 'b')
    return codigo == 0, saida


class Arquivo:
    """Acompanha um arquivo de log que cresce (como tail -f), lidando com troca e truncamento."""

    def __init__(self, caminho):
        self.caminho = caminho
        self.pos = 0
        self.resto = ''

    def ir_para_fim(self):
        try:
            self.pos = os.path.getsize(self.caminho)
        except OSError:
            self.pos = 0

    def linhas_novas(self):
        try:
            tamanho = os.path.getsize(self.caminho)
        except OSError:
            return []
        if tamanho < self.pos:  # arquivo recriado/truncado
            self.pos = 0
            self.resto = ''
        if tamanho == self.pos:
            return []
        with open(self.caminho, 'rb') as f:
            f.seek(self.pos)
            dados = f.read(tamanho - self.pos)
        self.pos = tamanho
        texto = self.resto + dados.decode('latin-1')
        partes = texto.split('\n')
        self.resto = partes.pop()  # última linha pode estar incompleta
        return [p.rstrip('\r') for p in partes]


class LeitorAcrux:
    """
    Deduz a situação do self a partir dos logs do AcruxPDV.

    trace_DDMMAA.log (um por dia), formato:
        000001402 07:05:37.346 Venda.Perf | Itens=3 | ...
        <tab>op:[opPagamento opImprimindoPagamento]
        <tab>mt:[mtDescontoItem]
    selfcheckout.log, formato:
        10:43:21.766 VenderItemApos 15: CodAcesso ... PesoBalanca ...
    """

    ENTRADA = re.compile(r'^\d{9} (\d\d:\d\d:\d\d)\.\d{3} (.*)$')
    SUBTOTAL = re.compile(r'SubTotal=(\d+(?:,\d+)?)')  # ex.: SubTotal=12,45, TotalExpedir=...
    SELF = re.compile(r'^\d\d:\d\d:\d\d\.\d{3} (\w+) (\d+):')

    XML_NNF = re.compile(r'<nNF>(\d+)</nNF>')
    XML_VNF = re.compile(r'<vNF>([\d.]+)</vNF>')
    # Cabeçalho de cada bloco do log fiscal nfe_AAMMDD.log: "11-11-26 07:19:54 Mt=..."
    NFE_CAB = re.compile(r'^(\d\d)-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) ')

    def __init__(self, conf):
        self.pasta = conf['PASTA_LOGS_ACRUX']
        self.limite_peso = float(conf['SEGUNDOS_PESO'])
        self.limite_msg = float(conf['SEGUNDOS_MENSAGEM'])
        self.limite_venda_parada = float(conf['SEGUNDOS_VENDA_PARADA'])
        self.dia = None
        self.trace = None
        self.selfck = Arquivo(os.path.join(self.pasta, 'selfcheckout.log'))
        self.primeira_leitura_selfck = True
        self.app = None
        self.zerar_dia()

    def zerar_dia(self):
        self.ops = set()
        self.mt = ''
        self.vendas = 0
        self.total = 0.0
        self.dialogo_desde = None
        self.peso_desde = None
        # Conferência de peso no pagamento: [fase, desde, kg] (fase 'antes' ou 'apos') ou None
        self.peso_pagto = None
        # Tara automática (ver Agente.talvez_tarar): fim da venda e a tara que o AcruxPDV fez
        self.em_pagamento = False
        self.fim_venda_em = None
        self.tara_final = None      # kg na balança na tara do fim da venda (None = não registrada)
        self.precisa_tara = False
        self.tara_enviada_em = None  # quando o agente apertou "b" (aguardando a confirmação no log)
        self.resultado_tara = None   # última tara automática: {em, ok, peso, motivo}
        # PDV normal (sem trace e sem selfcheckout.log): estado pela fila de saída do AcruxPDV
        self.fila_vistos = set()
        self.fila_estado = None      # 'livre' | 'em_venda' | 'fechado'
        self.fila_operador = None
        self.proxima_fila = 0
        self.atividade = None
        # Para caixas sem trace (o AcruxPDV de alguns selfs não grava esse log):
        self.status_selfck = 'livre'
        self.notas = {}           # nNF -> valor das NFC-e autorizadas hoje
        self.cache_nfce = {}      # arquivo -> (mtime, autorizada, nNF, valor)
        self.proxima_varredura_nfce = 0
        self.notas_iniciais = None  # primeira varredura do dia só conta, não muda o estado
        # Situação fiscal: erros de envio e autorizações no log nfe_AAMMDD.log de hoje
        self.erros_nfe = []
        self.proxima_leitura_log_nfe = 0
        # Chamado do fiscal (EnviarAlerta no log da aplicação) e cancelamento de item
        self.chamado_desde = None
        self.cancelamento_desde = None
        self.ultimo_mov_venda = time.time()

    def tem_trace(self):
        return os.path.exists(os.path.join(self.pasta, 'trace_%s.log' % self.dia))

    def atualizar(self):
        """Lê o que há de novo nos logs. Retorna True se algo mudou."""
        mudou = False
        hoje = time.strftime('%d%m%y')
        if hoje != self.dia:
            self.dia = hoje
            self.zerar_dia()
            self.trace = Arquivo(os.path.join(self.pasta, 'trace_%s.log' % hoje))
            self.app = Arquivo(os.path.join(self.pasta, 'app_%s.log' % hoje))
            self.app.ir_para_fim()  # chamados: só os que acontecem daqui em diante
            historico = True  # no início do dia/arquivo, lê tudo só para contar vendas e saber o estado
        else:
            historico = False
        for linha in self.trace.linhas_novas():
            self.linha_trace(linha, historico)
            mudou = True
        if historico:
            # Uma mensagem aberta que já estava no histórico começa a contar agora.
            if self.dialogo_desde is not None:
                self.dialogo_desde = time.time()
        for linha in self.app.linhas_novas():
            self.linha_app(linha)
            mudou = True
        # As notas são lidas em todos os caixas (notas sem autorização); as vendas só saem delas
        # nos caixas sem trace (ver vendas_dia).
        if time.time() >= self.proxima_varredura_nfce:
            self.proxima_varredura_nfce = time.time() + 15
            mudou = self.varrer_nfce() or mudou
        if time.time() >= self.proxima_leitura_log_nfe:
            self.proxima_leitura_log_nfe = time.time() + 30
            self.ler_log_nfe()
        if time.time() >= self.proxima_fila:
            self.proxima_fila = time.time() + 3
            mudou = self.ler_fila() or mudou
        # selfcheckout.log: na primeira leitura só o estado (o peso conta daqui em diante)
        hist_selfck = self.primeira_leitura_selfck
        self.primeira_leitura_selfck = False
        for linha in self.selfck.linhas_novas():
            self.linha_selfck(linha, hist_selfck)
            mudou = True
        return mudou

    def linha_app(self, linha):
        """
        O AcruxPDV avisa o monitor do fiscal (protocolo do AcruxMonitor) e registra no
        log da aplicação quando o envio falha, ex.:
          10/11/2026 08:17:13<TAB>Exception<TAB>AcruxPDV<TAB>...<TAB>pdServerTCP<TAB>{...}<TAB>EnviarAlerta<TAB>192.0.2.20: ...
        EnviarAlerta = o self chamou o fiscal; RemoverAlerta = o chamado acabou.
        """
        campos = linha.split('\t')
        if 'EnviarAlerta' in campos:
            if self.chamado_desde is None:
                self.chamado_desde = time.time()
        elif 'RemoverAlerta' in campos:
            self.chamado_desde = None

    # ---- PDV normal: abertura/fechamento do caixa, operadora e venda pela fila de saída
    # O AcruxPDV grava cada movimento em cache/output/AAAA-MM-DD/<sequência> (compactado com
    # zlib), com linhas "60|seq|mtOperacao|operador|DDMMAAAAhhmmss|...". Ex.: mtAbrirCaixa,
    # mtCupomFiscal (venda começou), mtFinalizadoraDinheiro (pagou), mtFecharCaixa.
    FILA_OP = re.compile(r'^60\|(\d+)\|(mt\w+)\|(\d*)\|(\d{14})')

    @staticmethod
    def ler_registro_fila(caminho):
        try:
            if os.path.getsize(caminho) > 20000:
                return []  # arquivos grandes são lotes de documentos repetidos, sem operações novas
            with open(caminho, 'rb') as f:
                dados = f.read()
        except OSError:
            return []
        for marca in (b'\x78\x9c', b'\x78\xda', b'\x78\x01'):
            i = dados.find(marca)
            if i >= 0:
                try:
                    texto = zlib.decompressobj().decompress(dados[i:]).decode('latin-1', 'replace')
                    break
                except zlib.error:
                    continue
        else:
            return []
        ops = []
        for linha in texto.splitlines():
            m = LeitorAcrux.FILA_OP.match(linha.strip())
            if m:
                h = m.group(4)  # DDMMAAAAhhmmss -> AAAAMMDDhhmmss (ordena pelo horário e pela sequência)
                ops.append((h[4:8] + h[2:4] + h[0:2] + h[8:], int(m.group(1)), m.group(2), m.group(3)))
        return ops

    def aplicar_op_fila(self, op, operador):
        if op == 'mtAbrirCaixa':
            self.fila_estado, self.fila_operador = 'livre', operador or None
        elif op in ('mtFecharCaixa', 'mtEncerrarTurno'):
            self.fila_estado, self.fila_operador = 'fechado', None
        elif op == 'mtCupomFiscal':
            self.fila_estado = 'em_venda'
            if operador:
                self.fila_operador = operador
        elif op.startswith('mtFinalizadora') or op == 'mtCancelarCupom':
            if self.fila_estado != 'fechado':
                self.fila_estado = 'livre'

    def ler_fila(self):
        """Lê os registros novos da fila de saída de hoje. Retorna True se o estado mudou."""
        base = os.path.join(PASTA_ACRUX, 'cache', 'output')
        hoje = time.strftime('%Y-%m-%d')
        if not os.path.isdir(base):
            return False
        antes = (self.fila_estado, self.fila_operador)
        if self.fila_estado is None:
            # Início: o último estado de um dia anterior (caixa que ficou aberto de um dia para o outro).
            try:
                dias = sorted(d for d in os.listdir(base) if re.match(r'^\d{4}-\d{2}-\d{2}$', d) and d < hoje)
            except OSError:
                dias = []
            if dias:
                pasta = os.path.join(base, dias[-1])
                ops = []
                for nome in sorted(os.listdir(pasta))[-60:]:
                    ops += self.ler_registro_fila(os.path.join(pasta, nome))
                for _, _, op, operador in sorted(ops):
                    self.aplicar_op_fila(op, operador)
            if self.fila_estado is None:
                self.fila_estado = 'fechado'
        pasta = os.path.join(base, hoje)
        try:
            nomes = sorted(n for n in os.listdir(pasta) if n not in self.fila_vistos)
        except OSError:
            nomes = []
        ops = []
        for nome in nomes:
            self.fila_vistos.add(nome)
            ops += self.ler_registro_fila(os.path.join(pasta, nome))
        for _, _, op, operador in sorted(ops):
            self.aplicar_op_fila(op, operador)
        return (self.fila_estado, self.fila_operador) != antes

    def usa_fila(self):
        """PDV normal: sem trace e sem selfcheckout.log, o estado vem da fila de saída."""
        return (not self.tem_trace() and self.fila_estado is not None
                and not os.path.exists(os.path.join(self.pasta, 'selfcheckout.log')))

    def ler_log_nfe(self):
        """Erros de envio da NFC-e hoje (horário de cada um), do log fiscal do AcruxPDV."""
        arq = os.path.join(self.pasta, 'nfe_%s.log' % time.strftime('%y%m%d'))
        erros = []
        t = None
        try:
            with open(arq, encoding='latin-1', errors='replace') as f:
                for linha in f:
                    m = self.NFE_CAB.match(linha)
                    if m:
                        d, mes, a, h, mi, s = (int(x) for x in m.groups())
                        t = time.mktime((2000 + a, mes, d, h, mi, s, 0, 0, -1))
                    elif t is not None and ('Erro na thread de envio' in linha or 'Erro HTTP' in linha):
                        erros.append(t)
        except OSError:
            pass
        self.erros_nfe = erros

    def fiscal(self):
        """
        Notas sem autorização: rascunhos criados DEPOIS da última nota autorizada (os anteriores
        são vendas abandonadas). Junto vão os erros de envio desde então: com pendentes e erros
        ao mesmo tempo, o caixa está vendendo sem conseguir autorizar a NFC-e.
        """
        autorizadas = [c[0] for c in self.cache_nfce.values() if c[1]]
        ultima = max(autorizadas) if autorizadas else 0
        pendentes = [c[0] for c in self.cache_nfce.values() if not c[1] and c[0] > ultima]
        erros = [t for t in self.erros_nfe if t > ultima]
        # Contingência: notas do dia que não foram autorizadas no caixa (nNF=0, sem cStat 100).
        # Cada uma é uma venda concluída (conferido com o contador do AcruxPDV).
        nao_aut = [c for c in self.cache_nfce.values() if not c[1]]
        return {
            'autorizadas': len(autorizadas),
            'contingencia': len(nao_aut),
            'valorContingencia': round(sum(c[3] for c in nao_aut), 2),
            'pendentes': len(pendentes),
            'pendenteDesde': int(min(pendentes) * 1000) if pendentes else None,
            'errosEnvio': len(erros),
            'ultimoErro': int(max(erros) * 1000) if erros else None,
        }

    def varrer_nfce(self):
        """
        Vendas e valor do dia pelas NFC-e autorizadas (para caixas sem trace).
        Cada nota fica em documento/nf-e/gerada/AAAAMMDD/NFCe/<chave>-nfe.xml; a autorizada
        tem <cStat>100</cStat> e o valor total em <vNF>. Rascunhos (nNF=0) não contam.
        """
        pasta = os.path.join(PASTA_ACRUX, 'documento', 'nf-e', 'gerada', time.strftime('%Y%m%d'), 'NFCe')
        try:
            nomes = os.listdir(pasta)
        except OSError:
            return False
        mudou = False
        for nome in nomes:
            if not nome.endswith('-nfe.xml'):
                continue
            caminho = os.path.join(pasta, nome)
            try:
                mtime = os.path.getmtime(caminho)
            except OSError:
                continue
            if self.cache_nfce.get(nome, (None,))[0] == mtime:
                continue
            try:
                with open(caminho, 'rb') as f:
                    xml = f.read().decode('utf-8', 'replace')
            except OSError:
                continue
            autorizada = '<cStat>100</cStat>' in xml
            n = self.XML_NNF.search(xml)
            v = self.XML_VNF.search(xml)
            numero = n.group(1) if n else '0'
            valor = float(v.group(1)) if v else 0.0
            self.cache_nfce[nome] = (mtime, autorizada and numero != '0', numero, valor)
            mudou = True
        if mudou:
            notas = {}
            for _, ok, numero, valor in self.cache_nfce.values():
                if ok:
                    notas[numero] = valor  # mesma nota em dois arquivos conta uma vez
            if self.notas_iniciais is not None and len(notas) > len(self.notas):
                self.status_selfck = 'livre'  # nota nova autorizada: a venda terminou
            self.notas = notas
            self.notas_iniciais = True
        return mudou

    def linha_trace(self, linha, historico):
        m = self.ENTRADA.match(linha)
        if m:
            texto = m.group(2)
            self.atividade = time.time()
            if texto.startswith('CreateForm frmMessageDlg'):
                self.dialogo_desde = time.time()
            elif texto.startswith('CloseForm frmMessageDlg'):
                self.dialogo_desde = None
            elif texto.startswith('Venda.Perf'):
                self.vendas += 1
            elif texto.startswith('RegistrarTroco.ValoresCupomCorrente'):
                s = self.SUBTOTAL.search(texto)
                if s:
                    self.total += numero_br(s.group(1))
            return
        limpa = linha.strip()
        if limpa.startswith('op:['):
            self.ops = set(limpa[4:].rstrip(']').split())
            if 'opAutenticacao' not in self.ops:
                self.mt = ''
        elif limpa.startswith('mt:['):
            self.mt = limpa[4:].rstrip(']').strip()

    def linha_selfck(self, linha, historico=False):
        m = self.SELF.match(linha)
        if not m:
            return
        evento, passo = m.group(1), int(m.group(2))
        # Estado da venda (usado quando o caixa não grava o trace)
        if evento.startswith(('VenderItem', 'Pagamento', 'VendaCancelar', 'TaraBalanca')):
            self.ultimo_mov_venda = hora_do_log(linha)
        if evento == 'VenderItemApos':
            self.status_selfck = 'em_venda'
        elif evento == 'PagamentoAntes' or (evento == 'PagamentoApos' and passo == 1):
            self.status_selfck = 'pagamento'
        elif evento == 'TaraBalancaConferencia' or (evento == 'PagamentoApos' and passo >= 2):
            self.status_selfck = 'livre'
        if historico:
            return
        agora = time.time()
        # Cancelamento de item: no self exige o fiscal. Passo 4 encerra; a venda seguir também.
        if evento == 'VendaCancelarItemAntes':
            if passo >= 4:
                self.cancelamento_desde = None
            elif self.cancelamento_desde is None:
                self.cancelamento_desde = agora
        elif evento in ('VenderItemApos', 'PagamentoAntes', 'TaraBalancaConferencia'):
            self.cancelamento_desde = None
        # Chamado do fiscal: se o cliente voltou a usar o caixa, o atendimento terminou.
        if (self.chamado_desde is not None and agora - self.chamado_desde > 5 and
                ((evento == 'VenderItemApos' and passo == 0) or evento in ('PagamentoAntes', 'TaraBalancaConferencia'))):
            self.chamado_desde = None
        # Dedução pelos logs: nos passos 15/16 o self espera o peso da balança bater
        # (leitor suspenso, peso fora da tolerância); o passo 17 encerra a espera.
        if evento == 'VenderItemApos' and passo in (15, 16):
            if self.peso_desde is None:
                self.peso_desde = time.time()
        elif (evento == 'VenderItemApos' and passo in (0, 17)) or evento.startswith('Pagamento'):
            self.peso_desde = None
        self.conferir_peso_pagamento(evento, passo, linha, agora)
        self.acompanhar_tara(evento, linha, agora)

    def acompanhar_tara(self, evento, linha, agora):
        """
        Fim da venda = TaraBalancaConferencia logo depois do pagamento (o AcruxPDV tara sozinho).
        Guarda o peso que estava na balança nessa tara: se não era ~0 (sacola ainda em cima),
        a próxima venda começa com o zero errado. Uma TaraBalancaConferencia fora do pagamento é
        tara manual (fiscal, tecla "b") ou a do próprio agente (confirmação).
        """
        if evento in ('PagamentoAntes', 'PagamentoApos'):
            self.em_pagamento = True
        elif evento.startswith('VenderItem'):
            # Começou outra venda: a tara pendente já não vale (o AcruxPDV tara no fim dela).
            self.em_pagamento = False
            self.precisa_tara = False
        elif evento == 'TaraBalancaConferencia':
            v = dict((k, numero_br(x)) for k, x in self.VALOR_LOG.findall(linha.split(':', 3)[-1]))
            peso = v.get('PesoBalanca')
            if peso is not None and peso <= -999:
                peso = None
            if self.tara_enviada_em is not None and agora - self.tara_enviada_em <= 15:
                self.resultado_tara.update({'ok': True, 'peso': peso})
                self.tara_enviada_em = None
                self.precisa_tara = False
            elif self.em_pagamento:
                self.em_pagamento = False
                self.fim_venda_em = agora
                self.tara_final = peso
                self.precisa_tara = True
            else:
                self.precisa_tara = False  # alguém tarou na mão

    VALOR_LOG = re.compile(r'(\w+) (-?\d+(?:,\d+)?)')

    def conferir_peso_pagamento(self, evento, passo, linha, agora):
        """
        Balança de conferência no pagamento (selfcheckout.log):
          PagamentoAntes 4: PesoBalanca 2,85 UltimoPesoTotal 5 Tolerancia 0,05
            -> antes de pagar, peso diferente do que foi registrado: o AcruxPDV trava com
               "Aguarde pela operadora, -2,150 Kg" (alguém tirou ou pôs coisa na balança).
          PagamentoApos 1: PesoBalanca 0,025 PesoTara -0,01 PesoLiquido 0,035 PesoTolerancia 0,02
            -> depois de pagar, espera a balança ficar vazia (repete a cada 2s). PagamentoApos 2
               com CodAcesso = o operador liberou; TaraBalancaConferencia = terminou.
        PesoBalanca -1000 = leitura instável (balança mexendo), não muda nada.
        """
        v = dict((k, numero_br(x)) for k, x in self.VALOR_LOG.findall(linha.split(':', 3)[-1]))
        if evento == 'PagamentoAntes' and passo >= 4 and 'UltimoPesoTotal' in v:
            dif = v.get('PesoBalanca', 0) - v['UltimoPesoTotal']
            if v.get('PesoBalanca', 0) > -999 and abs(dif) > v.get('Tolerancia', 0.05) + 1e-9:
                if not self.peso_pagto or self.peso_pagto[0] != 'antes':
                    self.peso_pagto = ['antes', agora, dif]
                self.peso_pagto[2] = dif
            else:
                self.peso_pagto = None
        elif evento == 'PagamentoApos' and passo == 1 and 'PesoLiquido' in v:
            if v.get('PesoBalanca', 0) <= -999:
                return
            liq = v['PesoLiquido']
            if abs(liq) > v.get('PesoTolerancia', 0.02) + 1e-9:
                if not self.peso_pagto or self.peso_pagto[0] != 'apos':
                    self.peso_pagto = ['apos', agora, liq]
                self.peso_pagto[2] = liq
            else:
                self.peso_pagto = None
        elif (evento == 'PagamentoApos' and passo >= 2) or evento in ('TaraBalancaConferencia', 'VenderItemApos') \
                or evento.startswith('VendaCancelar'):
            self.peso_pagto = None

    # ---- resultado
    def vendas_dia(self):
        return self.vendas if self.tem_trace() else len(self.notas)

    def total_dia(self):
        """Total em R$ do dia: pelo trace ou, sem ele, pela soma das NFC-e autorizadas."""
        return round(self.total if self.tem_trace() else sum(self.notas.values()), 2)

    def status(self):
        if self.usa_fila():
            return self.fila_estado
        if not self.tem_trace():
            # Venda abandonada/cancelada nem sempre deixa marca no log: parada há muito tempo = livre.
            if self.status_selfck != 'livre' and time.time() - self.ultimo_mov_venda > self.limite_venda_parada:
                self.status_selfck = 'livre'
            return self.status_selfck
        o = self.ops
        if 'opPagamento' in o or 'opImprimindoPagamento' in o:
            return 'pagamento'
        if 'opVendaAberta' in o:
            return 'em_venda'
        if 'opCaixaFechado' in o:
            return 'fechado'
        return 'livre'

    def condicoes(self):
        """Alertas ativos agora: {tipo: mensagem}."""
        agora = time.time()
        c = {}
        if self.chamado_desde is not None:
            if agora - self.chamado_desde > 600:  # sem sinal de fim em 10 min: encerra
                self.chamado_desde = None
            else:
                c['chamado'] = 'O self pediu atendimento do fiscal'
        if self.cancelamento_desde is not None:
            c['cancelamento'] = 'Cliente cancelando um item (precisa do fiscal)'
        if 'opAutenticacao' in self.ops:
            c['fiscal'] = ACOES_FISCAL.get(self.mt, 'O caixa está pedindo a senha do fiscal')
        if self.peso_desde is not None and agora - self.peso_desde >= self.limite_peso:
            c['peso'] = 'Peso na balança diferente do esperado há %ds' % (agora - self.peso_desde)
        if self.peso_pagto and agora - self.peso_pagto[1] > 900:
            self.peso_pagto = None  # 15 min sem sinal de fim: não segura o alerta para sempre
        if self.peso_pagto:
            fase, desde, kg = self.peso_pagto
            kg_txt = ('%.3f' % kg).replace('.', ',')
            if fase == 'antes':
                # O AcruxPDV já travou e pede o operador: avisa na hora.
                c['peso'] = 'Peso diferente no pagamento (%s kg): aguarda o fiscal' % kg_txt
            elif agora - desde >= max(30, 2 * self.limite_peso):
                c['peso'] = 'Balança não esvaziou após o pagamento (%s kg) há %ds' % (kg_txt, agora - desde)
        if self.dialogo_desde is not None and agora - self.dialogo_desde >= self.limite_msg:
            c['mensagem'] = 'Mensagem aberta na tela há %ds sem resposta' % (agora - self.dialogo_desde)
        return c


class Agente:
    def __init__(self, conf):
        self.conf = conf
        self.trava = threading.Lock()
        self.situacao = {'status': 'livre', 'operador': None, 'vendasHoje': 0, 'totalHoje': 0}
        self.alerta_manual = None      # vindo da API local
        self.condicoes = {}            # vindas dos logs
        self.reconhecidos = set()      # condições já liberadas no painel (até sumirem)
        self.comandos = []
        self.conectado = False
        self.acordar = threading.Event()
        self.leitor = None
        if conf['LER_LOGS_ACRUX'] == '1':
            if os.path.isdir(conf['PASTA_LOGS_ACRUX']):
                self.leitor = LeitorAcrux(conf)
            else:
                log('Pasta de logs do AcruxPDV não encontrada: %s (seguindo sem ler logs)' % conf['PASTA_LOGS_ACRUX'])

    def alerta_atual(self):
        candidatos = []
        if self.alerta_manual:
            candidatos.append((self.alerta_manual['alerta'], self.alerta_manual.get('mensagem', '')))
        for tipo, msg in self.condicoes.items():
            if tipo not in self.reconhecidos:
                candidatos.append((tipo, msg))
        if not candidatos:
            return None
        tipo, msg = max(candidatos, key=lambda c: PRIORIDADE.get(c[0], 1))
        return {'alerta': tipo, 'mensagem': msg}

    def payload(self):
        with self.trava:
            corpo = dict(self.situacao)
            corpo.update({
                'loja': int(self.conf['LOJA']),
                'pdv': int(self.conf['PDV']),
                'nome': self.conf['NOME'] or None,
                'versao': VERSAO,
                'portaVnc': int(self.conf['PORTA_VNC']),
                'alerta': self.alerta_atual(),
            })
            return corpo

    def servidores(self):
        # SERVIDOR pode ter vários endereços separados por espaço ou vírgula:
        # o primeiro é o principal; os outros (ex.: teste) recebem uma cópia.
        return [s.rstrip('/') for s in self.conf['SERVIDOR'].replace(',', ' ').split() if s]

    def enviar(self):
        dados = json.dumps(self.payload()).encode('utf-8')
        if not hasattr(self, 'conectados'):
            self.conectados = {}
        for i, base in enumerate(self.servidores()):
            # Secundário com espera curta: se estiver desligado, não atrasa o principal.
            try:
                ok = self.enviar_para(base, dados, 8 if i == 0 else 3)
            except Exception as e:  # um painel com problema não pode parar o envio aos outros
                log('Erro enviando ao painel %s: %r' % (base, e))
                ok = False
            if i == 0:
                self.conectado = ok
        # Configuração vinda do painel (tara automática): vale a do principal; se ele não
        # respondeu, a do primeiro que respondeu. Sem resposta de nenhum, fica como estava.
        config_de = getattr(self, 'config_de', {})
        for base in self.servidores():
            if self.conectados.get(base) and base in config_de:
                # Tipo do caixa no cadastro do painel: 'self' ou 'pdv' (PDV normal, com operador).
                tipo = 'pdv' if (config_de[base] or {}).get('tipo') == 'pdv' else 'self'
                if tipo != getattr(self, 'tipo_caixa', 'self'):
                    log('Tipo do caixa no painel: %s' % ('PDV normal (sem alertas de self)' if tipo == 'pdv' else 'self-checkout'))
                self.tipo_caixa = tipo
                modo = (config_de[base] or {}).get('taraAuto', 'desligado')
                if modo not in ('desligado', 'precisa', 'sempre'):
                    modo = 'desligado'
                if modo != getattr(self, 'modo_tara', 'desligado'):
                    log('Tara automática: %s (definido no painel %s)' % (modo, base))
                self.modo_tara = modo
                break

    def enviar_para(self, base, dados, espera):
        req = urllib.request.Request(base + '/api/agente', data=dados, method='POST', headers={
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + self.conf['TOKEN'],
        })
        antes = self.conectados.get(base, False)
        try:
            with urllib.request.urlopen(req, timeout=espera) as resp:
                resposta = json.loads(resp.read().decode('utf-8'))
            if not antes:
                log('Conectado ao painel %s como %s' % (base, resposta.get('id')))
            self.conectados[base] = True
            if not hasattr(self, 'config_de'):
                self.config_de = {}
            self.config_de[base] = resposta.get('config') or {}
            for cmd in resposta.get('comandos', []):
                self.tratar_comando(cmd)
            self.talvez_enviar_historico(base)
            return True
        except urllib.error.HTTPError as e:
            corpo = e.read().decode('utf-8', 'replace')[:200].replace('\n', ' ')
            if antes or base not in self.conectados:
                log('Painel %s recusou (%s): %s' % (base, e.code, corpo))
        except Exception as e:  # rede fora, servidor desligado etc.
            if antes or base not in self.conectados:
                log('Sem conexão com o painel %s: %s' % (base, e))
        self.conectados[base] = False
        return False

    def talvez_enviar_historico(self, base):
        """
        Depois de conectar, manda o histórico dos últimos 30 dias (uma vez por início do agente)
        e, a cada 6 horas, o dos últimos 2 dias. O painel junta sem duplicar.
        Roda numa thread separada para não atrasar o envio do estado.
        """
        if not hasattr(self, 'historico_em'):
            self.historico_em = {}        # base -> quando enviou (ou tentou) pela última vez
            self.historico_pendente = {}  # base -> dias a reenviar depois de uma falha
        ultimo = self.historico_em.get(base)
        if ultimo is not None and time.time() - ultimo < HISTORICO_A_CADA:
            return
        dias = self.historico_pendente.pop(base, HISTORICO_DIAS if ultimo is None else 2)
        self.historico_em[base] = time.time()
        threading.Thread(target=self.enviar_historico, args=(base, dias), daemon=True).start()

    def enviar_historico(self, base, dias):
        try:
            corpo = {
                'loja': int(self.conf['LOJA']), 'pdv': int(self.conf['PDV']), 'versao': VERSAO,
                'dias': ler_historico(self.conf, dias),
            }
            req = urllib.request.Request(base + '/api/agente/historico', data=json.dumps(corpo).encode('utf-8'),
                                         method='POST', headers={'Content-Type': 'application/json',
                                                                 'Authorization': 'Bearer ' + self.conf['TOKEN']})
            with urllib.request.urlopen(req, timeout=30) as resp:
                r = json.loads(resp.read().decode('utf-8'))
            log('Histórico (%d dias) enviado a %s: %s dia(s) de vendas atualizados, %s chamado(s) recuperado(s)' % (
                dias, base, r.get('diasVendas'), r.get('chamados')))
        except Exception as e:
            log('Não foi possível enviar o histórico a %s: %s (tenta de novo em 10 min)' % (base, e))
            # Daqui a ~10 minutos, tenta de novo com o mesmo número de dias.
            self.historico_pendente[base] = dias
            self.historico_em[base] = time.time() - HISTORICO_A_CADA + 600

    def tratar_comando(self, cmd):
        log('Comando do painel: %s (%s)' % (cmd.get('acao'), cmd.get('usuario')))
        with self.trava:
            if cmd.get('acao') == 'liberar':
                # O fiscal liberou: não reabrir o mesmo alerta enquanto a condição continuar.
                self.alerta_manual = None
                self.reconhecidos |= set(self.condicoes)
            cmd['recebidoEm'] = int(time.time() * 1000)
            self.comandos.append(cmd)
            self.comandos = self.comandos[-50:]

    def ler_logs(self):
        if not self.leitor:
            return
        try:
            self.leitor.atualizar()
        except Exception as e:
            log('Erro lendo logs do AcruxPDV: %s' % e)
            return
        pdv_normal = getattr(self, 'tipo_caixa', 'self') == 'pdv'
        # PDV normal: a tela de senha do fiscal só aparece como janela (não há log dela).
        # Lida fora da trava (o xdotool pode levar um instante), no máximo a cada 2 s.
        if pdv_normal and time.time() - getattr(self, 'janela_lida_em', 0) >= 2:
            self.janela_lida_em = time.time()
            self.janela_pdv = janela_ativa()
        with self.trava:
            antes = (self.situacao.get('status'), self.alerta_atual())
            self.situacao['status'] = self.leitor.status()
            if self.leitor.usa_fila():
                # PDV normal: a operadora do turno (código do AcruxPDV), vazia com o caixa fechado.
                op = self.leitor.fila_operador
                self.situacao['operador'] = ('Op. %s' % op) if op and self.leitor.fila_estado != 'fechado' else None
            self.situacao['vendasHoje'] = self.leitor.vendas_dia()
            self.situacao['totalHoje'] = self.leitor.total_dia()
            self.situacao['fiscal'] = self.leitor.fiscal()
            if self.leitor.resultado_tara:
                self.situacao['taraAuto'] = dict(self.leitor.resultado_tara)
            # PDV normal: só a senha do fiscal vira alerta. Peso, mensagem aberta e chamado são
            # situações de self; num PDV com operador virariam alertas falsos.
            self.condicoes = condicoes_pdv(getattr(self, 'janela_pdv', None)) if pdv_normal else self.leitor.condicoes()
            self.reconhecidos &= set(self.condicoes)  # condição sumiu: pode alertar de novo
            depois = (self.situacao['status'], self.alerta_atual())
        if (antes[0], (antes[1] or {}).get('alerta')) != (depois[0], (depois[1] or {}).get('alerta')):
            self.acordar.set()  # mudou algo importante: envia já

    def laco_logs(self):
        while True:
            self.ler_logs()
            try:
                self.talvez_tarar()
            except Exception as e:  # a tara automática nunca pode parar a leitura dos logs
                log('Erro na tara automática: %s' % e)
            time.sleep(1)

    # ---- tara automática da balança de conferência
    # Ligada pelo painel (Configurações), por loja ou por caixa: 'desligado' (padrão),
    # 'precisa' (só quando a tara do fim da venda ficou com peso na balança) ou 'sempre'.
    ESPERA_TARA = 20      # segundos parado depois da venda antes de tarar
    DESISTE_TARA = 300    # se a tela principal não ficar livre em 5 min, desiste desta venda

    def talvez_tarar(self):
        l = self.leitor
        if not l:
            return
        agora = time.time()
        if l.tara_enviada_em is not None and agora - l.tara_enviada_em > 15:
            l.resultado_tara.update({'ok': False, 'motivo': 'o AcruxPDV não registrou a tara depois da tecla'})
            l.tara_enviada_em = None
            log('Tara automática: sem confirmação no log do AcruxPDV')
        # Venda que terminou sem a tara final registrada (ex.: tara do AcruxPDV falhou).
        if l.em_pagamento and l.status() == 'livre' and agora - l.ultimo_mov_venda >= 30:
            l.em_pagamento = False
            l.fim_venda_em = agora
            l.tara_final = None
            l.precisa_tara = True
        modo = getattr(self, 'modo_tara', 'desligado')
        if getattr(self, 'tipo_caixa', 'self') == 'pdv':
            modo = 'desligado'  # PDV normal não tem balança de conferência de self
        if modo not in ('precisa', 'sempre') or not l.precisa_tara:
            return
        if modo == 'precisa' and l.tara_final is not None and abs(l.tara_final) < 0.02:
            l.precisa_tara = False  # a tara do fim da venda ficou certa
            return
        parado = agora - max(l.fim_venda_em or 0, l.ultimo_mov_venda)
        if parado < self.ESPERA_TARA:
            return
        def desistir(motivo):
            l.precisa_tara = False
            l.resultado_tara = {'em': int(agora * 1000), 'ok': False, 'peso': None, 'motivo': motivo}
            log('Tara automática não feita: %s' % motivo)
        with self.trava:
            ocupado = l.status() != 'livre' or self.alerta_atual() is not None
        nome = None if ocupado else janela_ativa()
        if ocupado or nome != JANELA_ACRUX:
            if parado > self.DESISTE_TARA:
                desistir('caixa ocupado' if ocupado else 'janela "%s" aberta na tela' % (nome or '?'))
            return
        ok, saida = apertar_tara()
        l.precisa_tara = False
        final = 'não registrada' if l.tara_final is None else ('%.3f kg' % l.tara_final).replace('.', ',')
        if not ok:
            desistir('não foi possível apertar a tecla (%s)' % saida[:60])
            return
        l.tara_enviada_em = agora
        l.resultado_tara = {'em': int(agora * 1000), 'ok': None, 'peso': None,
                            'motivo': 'depois da venda (tara final: %s)' % final}
        log('Tara automática: tecla "b" enviada (tara final da venda: %s)' % final)

    def laco(self):
        intervalo = float(self.conf['INTERVALO'])
        while True:
            self.enviar()
            self.acordar.wait(intervalo)
            self.acordar.clear()

    # chamados pela API local: mudam o estado e enviam na hora
    def atualizar(self, dados):
        with self.trava:
            for k in ('status', 'operador', 'vendasHoje', 'totalHoje'):
                if k in dados:
                    self.situacao[k] = dados[k]
        self.acordar.set()

    def abrir_alerta(self, tipo, mensagem=''):
        with self.trava:
            self.alerta_manual = {'alerta': tipo or 'ajuda', 'mensagem': mensagem or ''}
        log('Alerta aberto: %s %s' % (tipo, mensagem or ''))
        self.acordar.set()

    def fechar_alerta(self):
        with self.trava:
            self.alerta_manual = None
        log('Alerta fechado')
        self.acordar.set()


def criar_handler(agente):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def responder(self, codigo, obj):
            corpo = json.dumps(obj, ensure_ascii=False).encode('utf-8')
            self.send_response(codigo)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(corpo)))
            self.end_headers()
            self.wfile.write(corpo)

        def corpo(self):
            n = int(self.headers.get('Content-Length') or 0)
            if not n:
                return {}
            try:
                return json.loads(self.rfile.read(n).decode('utf-8'))
            except ValueError:
                return {}

        def do_POST(self):
            dados = self.corpo()
            if self.path == '/status':
                agente.atualizar(dados)
            elif self.path == '/alerta':
                agente.abrir_alerta(dados.get('alerta'), dados.get('mensagem'))
            elif self.path == '/alerta/fim':
                agente.fechar_alerta()
            else:
                return self.responder(404, {'erro': 'rota desconhecida'})
            self.responder(200, {'ok': True})

        def do_GET(self):
            if self.path == '/comandos':
                with agente.trava:
                    lista, agente.comandos = agente.comandos, []
                return self.responder(200, lista)
            if self.path == '/estado':
                return self.responder(200, dict(agente.payload(), conectado=agente.conectado,
                                                 condicoes=agente.condicoes))
            self.responder(404, {'erro': 'rota desconhecida'})

    return Handler


def diagnostico(conf, segundos):
    """Só lê os logs e mostra o que o agente deduziria. Não envia nada, não abre porta."""
    print('Loja %s, PDV %s | logs em %s' % (conf['LOJA'] or '?', conf['PDV'] or '?', conf['PASTA_LOGS_ACRUX']))
    leitor = LeitorAcrux(conf)
    leitor.atualizar()
    anterior = None
    fim = time.time() + segundos
    while True:
        atual = (leitor.status(), leitor.vendas_dia(), leitor.total_dia(), tuple(sorted(leitor.condicoes().items())),
                 ' '.join(sorted(leitor.ops)), leitor.mt, 'trace' if leitor.tem_trace() else 'sem trace: selfcheckout + XML das NFC-e')
        if atual != anterior:
            print('%s [%s] status=%s vendas=%d total=%s alertas=%s | op=[%s] mt=[%s]' % (
                time.strftime('%H:%M:%S'), atual[6], atual[0], atual[1],
                '%.2f' % atual[2] if atual[2] is not None else '?', dict(atual[3]) or '-', atual[4], atual[5]))
            sys.stdout.flush()
            anterior = atual
        if time.time() >= fim:
            break
        time.sleep(1)
        leitor.atualizar()


def ler_historico(conf, dias):
    """
    Relê o que o AcruxPDV guardou dos últimos `dias` dias (e de hoje), para o painel recuperar
    o que perdeu enquanto esteve desligado:
      - vendas e valor de cada dia pelas NFC-e autorizadas (documento/nf-e/gerada/AAAAMMDD/NFCe);
      - "Self chamou o fiscal": pares EnviarAlerta -> RemoverAlerta do log app_DDMMAA.log.
    Só lê; não muda nada no caixa.
    """
    import datetime
    resultado = []
    hoje = datetime.date.today()
    for i in range(int(dias), -1, -1):
        d = hoje - datetime.timedelta(days=i)
        item = {'dia': d.strftime('%Y-%m-%d'), 'vendas': None, 'total': None, 'chamados': [],
                'contingencia': None, 'valorContingencia': None}
        pasta = os.path.join(PASTA_ACRUX, 'documento', 'nf-e', 'gerada', d.strftime('%Y%m%d'), 'NFCe')
        if os.path.isdir(pasta):
            notas = {}
            contingencia = []  # notas não autorizadas no caixa (valor de cada uma)
            for nome in os.listdir(pasta):
                if not nome.endswith('-nfe.xml'):
                    continue
                try:
                    with open(os.path.join(pasta, nome), 'rb') as f:
                        xml = f.read().decode('utf-8', 'replace')
                except OSError:
                    continue
                n = LeitorAcrux.XML_NNF.search(xml)
                v = LeitorAcrux.XML_VNF.search(xml)
                valor = float(v.group(1)) if v else 0.0
                if '<cStat>100</cStat>' in xml and n and n.group(1) != '0':
                    notas[n.group(1)] = valor
                else:
                    contingencia.append(valor)
            item['vendas'] = len(notas)
            item['total'] = round(sum(notas.values()), 2)
            item['contingencia'] = len(contingencia)
            item['valorContingencia'] = round(sum(contingencia), 2)
        arq = os.path.join(conf['PASTA_LOGS_ACRUX'], 'app_%s.log' % d.strftime('%d%m%y'))
        if os.path.exists(arq):
            # Nem todo caixa registra o RemoverAlerta (fim do chamado): sem ele, o chamado vai
            # sem fim (conta no total, mas fica fora do tempo de espera). EnviarAlerta repetido
            # em menos de 1 minuto é o mesmo chamado.
            aberto = None
            ultimo_envio = None
            with open(arq, encoding='latin-1', errors='replace') as f:
                for linha in f:
                    if 'Alerta' not in linha:
                        continue
                    campos = linha.rstrip('\r\n').split('\t')
                    try:
                        t = int(time.mktime(time.strptime(campos[0].strip(), '%d/%m/%Y %H:%M:%S')) * 1000)
                    except (ValueError, IndexError):
                        continue
                    if 'EnviarAlerta' in campos:
                        if aberto is not None and t - ultimo_envio >= 60000:
                            item['chamados'].append([aberto, None])
                            aberto = None
                        if aberto is None:
                            aberto = t
                        ultimo_envio = t
                    elif 'RemoverAlerta' in campos and aberto is not None:
                        item['chamados'].append([aberto, t])
                        aberto = None
            if aberto is not None:
                item['chamados'].append([aberto, None])
        if item['vendas'] is not None or item['chamados']:
            resultado.append(item)
    return resultado


def linha_de_comando(conf, args):
    """Atalho para scripts do PDV: fala com o agente que já está rodando."""
    base = 'http://127.0.0.1:%s' % conf['PORTA_LOCAL']
    acao = args[0]
    if acao == 'diagnostico':
        return diagnostico(conf, float(args[1]) if len(args) > 1 else 0)
    if acao == 'fiscal':
        # Só mostra a situação fiscal de hoje (notas sem autorização e erros de envio).
        leitor = LeitorAcrux(conf)
        leitor.atualizar()
        f = leitor.fiscal()
        hora = lambda ms: time.strftime('%H:%M:%S', time.localtime(ms / 1000)) if ms else '-'
        print('autorizadas=%d  pendentes=%d (desde %s)  erros de envio=%d (último %s)' % (
            f['autorizadas'], f['pendentes'], hora(f['pendenteDesde']), f['errosEnvio'], hora(f['ultimoErro'])))
        return
    if acao == 'estado':
        # Só mostra o estado que o agente enviaria (não envia nada).
        leitor = LeitorAcrux(conf)
        leitor.atualizar()
        janela = janela_ativa()
        print('estado=%s  fonte=%s  operador=%s  vendas=%s' % (
            leitor.status(),
            'fila de saída (PDV normal)' if leitor.usa_fila() else ('trace' if leitor.tem_trace() else 'selfcheckout.log'),
            leitor.fila_operador or '-', leitor.vendas_dia()))
        print('janela ativa: %s  pede senha do fiscal: %s' % (
            janela if janela is not None else '(xdotool não respondeu)', 'SIM' if condicoes_pdv(janela) else 'não'))
        return
    if acao == 'tara':
        # Piloto da tara automática. "tara": só mostra a sessão gráfica e a janela ativa.
        # "tara enviar": aperta "b" UMA vez, só se a tela principal do AcruxPDV estiver na frente.
        env = ambiente_x()
        nome = janela_ativa()
        print('DISPLAY=%s XAUTHORITY=%s' % (env.get('DISPLAY'), env.get('XAUTHORITY', '-')))
        print('janela ativa: %s' % (nome if nome is not None else '(xdotool não respondeu)'))
        if len(args) > 1 and args[1] == 'enviar':
            if nome != JANELA_ACRUX:
                print('NÃO enviado: a janela ativa não é a tela principal "%s".' % JANELA_ACRUX)
                return
            ok, saida = apertar_tara()
            print('tecla "b" enviada' if ok else 'falhou: %s' % saida)
            print('Confira na balança/tela e no log: grep TaraBalanca %s/selfcheckout.log | tail -2' % conf['PASTA_LOGS_ACRUX'])
        return
    if acao == 'historico':
        # Só mostra o que seria enviado ao painel (não envia nada).
        for d in ler_historico(conf, int(args[1]) if len(args) > 1 else HISTORICO_DIAS):
            print('%s  vendas=%s  total=%s  contingencia=%s (%s)  chamados=%d' % (
                d['dia'], d['vendas'], d['total'], d['contingencia'], d['valorContingencia'], len(d['chamados'])))
        return
    if acao == 'alerta':
        rota, corpo = '/alerta', {'alerta': args[1] if len(args) > 1 else 'ajuda',
                                  'mensagem': args[2] if len(args) > 2 else ''}
    elif acao == 'fim':
        rota, corpo = '/alerta/fim', {}
    elif acao == 'status':
        rota, corpo = '/status', {'status': args[1]}
        if len(args) > 2:
            corpo['operador'] = args[2]
    elif acao == 'estado':
        print(urllib.request.urlopen(base + '/estado', timeout=3).read().decode('utf-8'))
        return
    else:
        sys.exit('uso: agente.py [diagnostico [segundos] | alerta TIPO "MENSAGEM" | fim | status STATUS [OPERADOR] | estado]')
    req = urllib.request.Request(base + rota, data=json.dumps(corpo).encode('utf-8'), method='POST',
                                 headers={'Content-Type': 'application/json'})
    print(urllib.request.urlopen(req, timeout=3).read().decode('utf-8'))


def main():
    conf = ler_conf()
    if len(sys.argv) > 1:
        return linha_de_comando(conf, sys.argv[1:])
    faltando = [k for k in ('TOKEN', 'LOJA', 'PDV') if not conf[k]]
    if faltando:
        sys.exit('Configure %s em %s' % (', '.join(faltando), os.environ.get('PAINEL_CONF', CONF_PADRAO)))

    agente = Agente(conf)
    servidor = HTTPServer(('127.0.0.1', int(conf['PORTA_LOCAL'])), criar_handler(agente))
    threading.Thread(target=servidor.serve_forever, daemon=True).start()
    if agente.leitor:
        threading.Thread(target=agente.laco_logs, daemon=True).start()
    log('Agente %s | loja %s PDV %s | painel %s | logs AcruxPDV: %s'
        % (VERSAO, conf['LOJA'], conf['PDV'], conf['SERVIDOR'], 'sim' if agente.leitor else 'não'))
    try:
        agente.laco()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
