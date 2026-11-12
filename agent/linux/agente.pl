#!/usr/bin/perl
# Agente do Painel Self-Checkout para PDVs sem Python (ex.: Slackware 14.0).
# Mesma lógica do agente.py: lê os logs do AcruxPDV (só leitura), deduz a situação
# do self e envia ao painel. Usa só módulos que vêm com o Perl (5.14+):
# HTTP::Tiny e JSON::PP.
#
#   perl agente.pl                     # roda o agente
#   perl agente.pl diagnostico [seg]   # só lê os logs e mostra o que deduziu (não envia nada)
#
# Configuração: /etc/painel-self/agente.conf (ou o arquivo em PAINEL_CONF).
# Diferença do agente.py: não tem a API local (porta 8765); os alertas vêm só dos logs.
use strict;
use warnings;
use utf8;  # textos deste arquivo (com acento) são UTF-8
use HTTP::Tiny;
use JSON::PP;
use POSIX qw(strftime);
use Time::Local qw(timelocal);

my $VERSAO = '1.13.0-perl';
# Histórico mandado ao painel depois de conectar (recupera o que ele perdeu se esteve desligado).
my $HISTORICO_DIAS = 30;
my $HISTORICO_A_CADA = 6 * 3600;
my $PASTA_ACRUX = '/c5client/AcruxPDV';
$| = 1;
binmode STDOUT, ':encoding(UTF-8)';
binmode STDERR, ':encoding(UTF-8)';

my %PRIORIDADE = (
    pagamento => 3, erro => 3,
    chamado => 2, fiscal => 2, peso => 2, idade => 2, ajuda => 2, mensagem => 2, cancelamento => 2,
    sem_papel => 1,
);
my %ACOES_FISCAL = (
    mtDescontoItem => 'Desconto de item',
    mtCancelarItem => 'Cancelamento de item',
    mtCancelarCupom => 'Cancelamento da compra',
    mtConsultaPreco => 'Consulta de preço',
    mtTransacaoGerencialTEF => 'Operação de TEF',
);

sub registrar { print strftime('%Y-%m-%d %H:%M:%S', localtime), ' ', @_, "\n" }

# ---------------------------------------------------------------- configuração
sub ler_conf {
    my %c = (
        SERVIDOR => 'http://127.0.0.1:8080', TOKEN => '', LOJA => '', PDV => '', NOME => '',
        PORTA_VNC => '5900', INTERVALO => '5',
        LER_LOGS_ACRUX => '1', PASTA_LOGS_ACRUX => "$PASTA_ACRUX/log/aplicacao",
        SEGUNDOS_PESO => '15', SEGUNDOS_MENSAGEM => '45', SEGUNDOS_VENDA_PARADA => '300',
    );
    my $arq = $ENV{PAINEL_CONF} || '/etc/painel-self/agente.conf';
    if (open my $f, '<', $arq) {
        while (my $l = <$f>) {
            $l =~ s/[\r\n]+$//;
            next if $l =~ /^\s*(#|$)/ or $l !~ /=/;
            my ($k, $v) = split /=/, $l, 2;
            $k =~ s/^\s+|\s+$//g;
            $v =~ s/^\s+|\s+$//g;
            $v =~ s/^["']|["']$//g;
            $c{$k} = $v;
        }
        close $f;
    }
    for my $k (keys %c) { $c{$k} = $ENV{$k} if defined $ENV{$k} && $ENV{$k} ne '' }
    unless ($c{LOJA} ne '' && $c{PDV} ne '') {
        my $texto = '';
        for my $n ('AcruxPDV.info', 'AcruxPDV.terminal') {
            if (open my $f, '<', "$PASTA_ACRUX/$n") { local $/; $texto .= <$f> . "\n"; close $f }
        }
        $c{LOJA} = int($1) if $c{LOJA} eq '' && $texto =~ /NroEmpresa\s*=\s*(\d+)/;
        $c{PDV} = int($1) if $c{PDV} eq '' && $texto =~ /NroCheckout\s*=\s*(\d+)/;
    }
    return \%c;
}

# ---------------------------------------------------------------- acompanhar arquivo (tail -f)
sub novo_arquivo { my ($caminho) = @_; return { caminho => $caminho, pos => 0, resto => '' } }

sub ir_para_fim { my ($a) = @_; $a->{pos} = -s $a->{caminho} || 0 }

sub linhas_novas {
    my ($a) = @_;
    my $tam = -s $a->{caminho};
    return () unless defined $tam;
    if ($tam < $a->{pos}) { $a->{pos} = 0; $a->{resto} = '' }  # recriado/truncado
    return () if $tam == $a->{pos};
    open my $f, '<:raw', $a->{caminho} or return ();
    seek $f, $a->{pos}, 0;
    my $dados = '';
    read $f, $dados, $tam - $a->{pos};
    close $f;
    $a->{pos} = $tam;
    my @partes = split /\n/, $a->{resto} . $dados, -1;
    $a->{resto} = pop @partes;
    s/\r$// for @partes;
    return @partes;
}

# ---------------------------------------------------------------- leitura dos logs do AcruxPDV
sub novo_leitor {
    my ($conf) = @_;
    my $l = {
        pasta => $conf->{PASTA_LOGS_ACRUX},
        limite_peso => $conf->{SEGUNDOS_PESO},
        limite_msg => $conf->{SEGUNDOS_MENSAGEM},
        limite_venda_parada => $conf->{SEGUNDOS_VENDA_PARADA},
        dia => '',
    };
    $l->{selfck} = novo_arquivo("$l->{pasta}/selfcheckout.log");
    $l->{primeira_selfck} = 1;
    zerar_dia($l);
    return $l;
}

sub zerar_dia {
    my ($l) = @_;
    $l->{ops} = {}; $l->{mt} = ''; $l->{vendas} = 0; $l->{total} = 0;
    $l->{dialogo_desde} = undef; $l->{peso_desde} = undef; $l->{peso_pagto} = undef;
    # Tara automática: fim da venda e a tara que o AcruxPDV fez (ver talvez_tarar)
    $l->{em_pagamento} = 0; $l->{fim_venda_em} = undef; $l->{tara_final} = undef;
    $l->{precisa_tara} = 0; $l->{tara_enviada_em} = undef; $l->{resultado_tara} = undef;
    # Para caixas sem trace: estado pelo selfcheckout.log e vendas pelas NFC-e autorizadas
    $l->{status_selfck} = 'livre'; $l->{notas} = {}; $l->{cache_nfce} = {}; $l->{proxima_nfce} = 0;
    # Chamado do fiscal (EnviarAlerta no log da aplicação) e cancelamento de item
    $l->{chamado_desde} = undef; $l->{cancelamento_desde} = undef;
    $l->{ultimo_mov_venda} = time; $l->{notas_iniciais} = 0;
    # Situação fiscal: erros de envio da NFC-e no log nfe_AAMMDD.log de hoje
    $l->{erros_nfe} = []; $l->{proxima_log_nfe} = 0;
}

# Erros de envio da NFC-e hoje (horário de cada um), do log fiscal do AcruxPDV.
# Cada bloco começa com "11-11-26 07:19:54 Mt=..."; erro é "Erro na thread de envio" ou "Erro HTTP".
sub ler_log_nfe {
    my ($l) = @_;
    my @erros;
    my $t;
    if (open my $f, '<', "$l->{pasta}/nfe_" . strftime('%y%m%d', localtime) . '.log') {
        while (my $linha = <$f>) {
            if ($linha =~ /^(\d\d)-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) /) {
                $t = timelocal($6, $5, $4, $1, $2 - 1, 2000 + $3);
            } elsif (defined $t && ($linha =~ /Erro na thread de envio/ || $linha =~ /Erro HTTP/)) {
                push @erros, $t;
            }
        }
        close $f;
    }
    $l->{erros_nfe} = \@erros;
}

# Notas sem autorização: rascunhos criados DEPOIS da última nota autorizada (os anteriores são
# vendas abandonadas), mais os erros de envio desde então.
sub fiscal {
    my ($l) = @_;
    my @c = values %{ $l->{cache_nfce} };
    my @aut = map { $_->[0] } grep { $_->[1] } @c;
    my $ultima = 0;
    for (@aut) { $ultima = $_ if $_ > $ultima }
    my @pend = sort { $a <=> $b } map { $_->[0] } grep { !$_->[1] && $_->[0] > $ultima } @c;
    my @erros = sort { $a <=> $b } grep { $_ > $ultima } @{ $l->{erros_nfe} };
    # Contingência: notas do dia não autorizadas no caixa (cada uma é uma venda concluída).
    my @nao = grep { !$_->[1] } @c;
    my $valor_nao = 0;
    $valor_nao += $_->[3] for @nao;
    return {
        autorizadas => 0 + scalar @aut,
        contingencia => 0 + scalar @nao,
        valorContingencia => 0 + sprintf('%.2f', $valor_nao),
        pendentes => 0 + scalar @pend,
        pendenteDesde => @pend ? 1000 * $pend[0] : undef,
        errosEnvio => 0 + scalar @erros,
        ultimoErro => @erros ? 1000 * $erros[-1] : undef,
    };
}

# O AcruxPDV avisa o monitor do fiscal e registra no log da aplicação quando o envio falha:
# EnviarAlerta = o self chamou o fiscal; RemoverAlerta = o chamado acabou.
sub linha_app {
    my ($l, $linha) = @_;
    my %campos = map { $_ => 1 } split /\t/, $linha;
    if ($campos{EnviarAlerta}) { $l->{chamado_desde} = time unless defined $l->{chamado_desde} }
    elsif ($campos{RemoverAlerta}) { $l->{chamado_desde} = undef }
}

# Vendas e valor do dia pelas NFC-e autorizadas (caixas sem trace):
# documento/nf-e/gerada/AAAAMMDD/NFCe/<chave>-nfe.xml com <cStat>100</cStat> e o total em <vNF>.
sub varrer_nfce {
    my ($l) = @_;
    my $pasta = "$PASTA_ACRUX/documento/nf-e/gerada/" . strftime('%Y%m%d', localtime) . '/NFCe';
    opendir(my $dh, $pasta) or return;
    my $mudou = 0;
    for my $nome (grep { /-nfe\.xml$/ } readdir $dh) {
        my $caminho = "$pasta/$nome";
        my $mtime = (stat $caminho)[9];
        next unless defined $mtime;
        next if $l->{cache_nfce}{$nome} && $l->{cache_nfce}{$nome}[0] == $mtime;
        open my $f, '<:raw', $caminho or next;
        my $xml = do { local $/; <$f> };
        close $f;
        my $ok = index($xml, '<cStat>100</cStat>') >= 0;
        my ($numero) = $xml =~ /<nNF>(\d+)<\/nNF>/;
        my ($valor) = $xml =~ /<vNF>([\d.]+)<\/vNF>/;
        $numero = '0' unless defined $numero;
        $l->{cache_nfce}{$nome} = [$mtime, ($ok && $numero ne '0') ? 1 : 0, $numero, $valor || 0];
        $mudou = 1;
    }
    closedir $dh;
    if ($mudou) {
        my %notas;
        for my $c (values %{ $l->{cache_nfce} }) { $notas{ $c->[2] } = $c->[3] if $c->[1] }
        # Nota nova autorizada: a venda terminou (a primeira varredura do dia só conta).
        $l->{status_selfck} = 'livre' if $l->{notas_iniciais} && keys(%notas) > keys(%{ $l->{notas} });
        $l->{notas} = \%notas;
        $l->{notas_iniciais} = 1;
    }
}

sub tem_trace { my ($l) = @_; return -e "$l->{pasta}/trace_$l->{dia}.log" }

sub atualizar_leitor {
    my ($l) = @_;
    my $hoje = strftime('%d%m%y', localtime);
    my $historico = 0;
    if ($hoje ne $l->{dia}) {
        $l->{dia} = $hoje;
        zerar_dia($l);
        $l->{trace} = novo_arquivo("$l->{pasta}/trace_$hoje.log");
        $l->{app} = novo_arquivo("$l->{pasta}/app_$hoje.log");
        ir_para_fim($l->{app});  # chamados: só os que acontecem daqui em diante
        $historico = 1;
    }
    linha_trace($l, $_) for linhas_novas($l->{trace});
    linha_app($l, $_) for linhas_novas($l->{app});
    $l->{dialogo_desde} = time if $historico && defined $l->{dialogo_desde};
    # As notas são lidas em todos os caixas (notas sem autorização); as vendas só saem delas
    # nos caixas sem trace (ver vendas_dia).
    if (time >= $l->{proxima_nfce}) {
        $l->{proxima_nfce} = time + 15;
        varrer_nfce($l);
    }
    if (time >= $l->{proxima_log_nfe}) {
        $l->{proxima_log_nfe} = time + 30;
        ler_log_nfe($l);
    }
    if (time >= ($l->{proxima_fila} || 0)) {
        $l->{proxima_fila} = time + 3;
        ler_fila($l);
    }
    my $hist_selfck = $l->{primeira_selfck};
    $l->{primeira_selfck} = 0;
    linha_selfck($l, $_, $hist_selfck) for linhas_novas($l->{selfck});
}

sub vendas_dia { my ($l) = @_; return tem_trace($l) ? $l->{vendas} : scalar keys %{ $l->{notas} } }
sub total_dia {
    my ($l) = @_;
    my $t = 0;
    if (tem_trace($l)) { $t = $l->{total} } else { $t += $_ for values %{ $l->{notas} } }
    return 0 + sprintf('%.2f', $t);
}

sub linha_trace {
    my ($l, $linha) = @_;
    if ($linha =~ /^\d{9} \d\d:\d\d:\d\d\.\d{3} (.*)$/) {
        my $t = $1;
        if    ($t =~ /^CreateForm frmMessageDlg/) { $l->{dialogo_desde} = time }
        elsif ($t =~ /^CloseForm frmMessageDlg/)  { $l->{dialogo_desde} = undef }
        elsif ($t =~ /^Venda\.Perf/)              { $l->{vendas}++ }
        elsif ($t =~ /^RegistrarTroco\.ValoresCupomCorrente.*SubTotal=(\d+(?:,\d+)?)/) {
            (my $v = $1) =~ tr/,/./;
            $l->{total} += $v;
        }
        return;
    }
    (my $limpa = $linha) =~ s/^\s+|\s+$//g;
    if ($limpa =~ /^op:\[(.*)\]$/) {
        $l->{ops} = { map { $_ => 1 } split ' ', $1 };
        $l->{mt} = '' unless $l->{ops}{opAutenticacao};
    } elsif ($limpa =~ /^mt:\[(.*)\]$/) {
        ($l->{mt} = $1) =~ s/^\s+|\s+$//g;
    }
}

# '11:27:48.071 ...' -> horário de hoje em segundos (epoch)
sub hora_do_log {
    my ($linha) = @_;
    return time unless $linha =~ /^(\d\d):(\d\d):(\d\d)/;
    my @t = localtime;
    return POSIX::mktime($3, $2, $1, $t[3], $t[4], $t[5], 0, 0, -1) || time;
}

sub linha_selfck {
    my ($l, $linha, $historico) = @_;
    return unless $linha =~ /^\d\d:\d\d:\d\d\.\d{3} (\w+) (\d+):/;
    my ($ev, $passo) = ($1, $2);
    if ($ev =~ /^(VenderItem|Pagamento|VendaCancelar|TaraBalanca)/) { $l->{ultimo_mov_venda} = hora_do_log($linha) }
    if ($ev eq 'VenderItemApos') { $l->{status_selfck} = 'em_venda' }
    elsif ($ev eq 'PagamentoAntes' || ($ev eq 'PagamentoApos' && $passo == 1)) { $l->{status_selfck} = 'pagamento' }
    elsif ($ev eq 'TaraBalancaConferencia' || ($ev eq 'PagamentoApos' && $passo >= 2)) { $l->{status_selfck} = 'livre' }
    return if $historico;  # peso: só o que acontece daqui em diante
    my $agora = time;
    # Cancelamento de item: exige o fiscal. Passo 4 encerra; a venda seguir também.
    if ($ev eq 'VendaCancelarItemAntes') {
        if ($passo >= 4) { $l->{cancelamento_desde} = undef }
        else { $l->{cancelamento_desde} = $agora unless defined $l->{cancelamento_desde} }
    } elsif ($ev eq 'VenderItemApos' || $ev eq 'PagamentoAntes' || $ev eq 'TaraBalancaConferencia') {
        $l->{cancelamento_desde} = undef;
    }
    # Chamado do fiscal: cliente voltou a usar o caixa = atendimento terminou.
    if (defined $l->{chamado_desde} && $agora - $l->{chamado_desde} > 5
        && (($ev eq 'VenderItemApos' && $passo == 0) || $ev eq 'PagamentoAntes' || $ev eq 'TaraBalancaConferencia')) {
        $l->{chamado_desde} = undef;
    }
    # Passos 15/16: o self espera o peso bater; 17 (ou novo item/pagamento) encerra a espera.
    if ($ev eq 'VenderItemApos' && ($passo == 15 || $passo == 16)) {
        $l->{peso_desde} = time unless defined $l->{peso_desde};
    } elsif (($ev eq 'VenderItemApos' && ($passo == 0 || $passo == 17)) || $ev =~ /^Pagamento/) {
        $l->{peso_desde} = undef;
    }
    conferir_peso_pagamento($l, $ev, $passo, $linha, $agora);
    acompanhar_tara($l, $ev, $linha, $agora);
}

# Fim da venda = TaraBalancaConferencia logo depois do pagamento (o AcruxPDV tara sozinho).
# Guarda o peso que estava na balança nessa tara. Tara fora do pagamento = manual (fiscal,
# tecla "b") ou a do próprio agente (confirmação).
sub acompanhar_tara {
    my ($l, $ev, $linha, $agora) = @_;
    if ($ev eq 'PagamentoAntes' || $ev eq 'PagamentoApos') {
        $l->{em_pagamento} = 1;
    } elsif ($ev =~ /^VenderItem/) {
        $l->{em_pagamento} = 0;
        $l->{precisa_tara} = 0;  # outra venda começou: o AcruxPDV tara no fim dela
    } elsif ($ev eq 'TaraBalancaConferencia') {
        my $peso;
        if ($linha =~ /PesoBalanca (-?\d+(?:,\d+)?)/) { ($peso = $1) =~ tr/,/./; $peso += 0; $peso = undef if $peso <= -999 }
        if (defined $l->{tara_enviada_em} && $agora - $l->{tara_enviada_em} <= 15) {
            $l->{resultado_tara}{ok} = JSON::PP::true;
            $l->{resultado_tara}{peso} = $peso;
            $l->{tara_enviada_em} = undef;
            $l->{precisa_tara} = 0;
        } elsif ($l->{em_pagamento}) {
            $l->{em_pagamento} = 0;
            $l->{fim_venda_em} = $agora;
            $l->{tara_final} = $peso;
            $l->{precisa_tara} = 1;
        } else {
            $l->{precisa_tara} = 0;  # alguém tarou na mão
        }
    }
}

# ---------------------------------------------------------------- tela do caixa (tara automática)
# Só aperta tecla com a janela principal do AcruxPDV na frente (nunca com mensagem aberta).
my $JANELA_ACRUX = 'AcruxPDV';

# DISPLAY e XAUTHORITY da sessão gráfica, lidos do processo do X (o agente roda como root).
sub ambiente_x {
    my ($disp, $auth) = (':0', undef);
    opendir(my $dh, '/proc') or return ($disp, $auth);
    for my $pid (grep { /^\d+$/ } readdir $dh) {
        open my $f, '<', "/proc/$pid/cmdline" or next;
        my $c = do { local $/; <$f> };
        close $f;
        next unless defined $c;
        my @a = split /\0/, $c;
        next unless @a && $a[0] =~ m{(?:^|/)X(?:org)?$};
        for my $i (0 .. $#a) {
            $auth = $a[$i + 1] if $a[$i] eq '-auth' && $i < $#a;
            $disp = $a[$i] if $a[$i] =~ /^:\d+$/;
        }
        last;
    }
    closedir $dh;
    $auth = '/root/.Xauthority' if !defined $auth && -e '/root/.Xauthority';
    return ($disp, $auth);
}

# Roda o xdotool na sessão do caixa (até 5 s). Devolve (código, saída).
sub xdotool {
    my @args = @_;
    my ($disp, $auth) = ambiente_x();
    local $ENV{DISPLAY} = $disp;
    local $ENV{XAUTHORITY} = $auth if defined $auth;
    my $saida = '';
    my $ok = eval {
        local $SIG{ALRM} = sub { die "tempo esgotado\n" };
        alarm 5;
        open(my $p, '-|', 'xdotool', @args) or die "xdotool: $!\n";
        $saida = do { local $/; <$p> };
        close $p;
        alarm 0;
        1;
    };
    alarm 0;
    return (-1, $@) unless $ok;
    $saida = '' unless defined $saida;
    $saida =~ s/\s+$//;
    return ($? >> 8, $saida);
}

sub janela_ativa {
    my ($c, $nome) = xdotool('getactivewindow', 'getwindowname');
    return $c == 0 ? $nome : undef;
}

# PDV normal: a tela em que o caixa pede a senha do fiscal (formulário TfrmAutenticarUsuario do
# AcruxPDV), reconhecida pelo nome da janela ativa. Lida no máximo a cada 2 s.
my $JANELA_SENHA_FISCAL = qr/autentica|senha|supervis|fiscal|autoriza/i;
my ($janela_lida_em, $janela_pdv) = (0, undef);
sub pede_senha_fiscal { my ($nome) = @_; return defined $nome && $nome =~ $JANELA_SENHA_FISCAL ? 1 : 0 }
sub condicoes_pdv {
    if (time - $janela_lida_em >= 2) { $janela_lida_em = time; $janela_pdv = janela_ativa() }
    return pede_senha_fiscal($janela_pdv) ? { fiscal => 'O caixa está pedindo a senha do fiscal' } : {};
}

# Aperta "b" (tara da balança de conferência, a mesma tecla do fiscal).
sub apertar_tara {
    my ($c, $saida) = xdotool('key', '--clearmodifiers', 'b');
    return ($c == 0, $saida);
}

# Tara automática, ligada pelo painel por loja ou caixa: 'desligado' (padrão), 'precisa' (só
# quando a tara do fim da venda ficou com peso) ou 'sempre'. Só aperta "b" com a venda terminada
# há 20 s, sem alerta, caixa livre e a tela principal do AcruxPDV na frente; confere no log.
my $ESPERA_TARA = 20;
my $DESISTE_TARA = 300;
sub talvez_tarar {
    my ($l, $modo, $ocupado) = @_;
    my $agora = time;
    if (defined $l->{tara_enviada_em} && $agora - $l->{tara_enviada_em} > 15) {
        $l->{resultado_tara}{ok} = JSON::PP::false;
        $l->{resultado_tara}{motivo} = 'o AcruxPDV não registrou a tara depois da tecla';
        $l->{tara_enviada_em} = undef;
        registrar('Tara automática: sem confirmação no log do AcruxPDV');
    }
    # Venda que terminou sem a tara final registrada (ex.: a tara do AcruxPDV falhou).
    if ($l->{em_pagamento} && status_leitor($l) eq 'livre' && $agora - $l->{ultimo_mov_venda} >= 30) {
        $l->{em_pagamento} = 0;
        $l->{fim_venda_em} = $agora;
        $l->{tara_final} = undef;
        $l->{precisa_tara} = 1;
    }
    return unless ($modo eq 'precisa' || $modo eq 'sempre') && $l->{precisa_tara};
    if ($modo eq 'precisa' && defined $l->{tara_final} && abs($l->{tara_final}) < 0.02) {
        $l->{precisa_tara} = 0;  # a tara do fim da venda ficou certa
        return;
    }
    my $ref = $l->{fim_venda_em} || 0;
    $ref = $l->{ultimo_mov_venda} if $l->{ultimo_mov_venda} > $ref;
    my $parado = $agora - $ref;
    return if $parado < $ESPERA_TARA;
    my $desistir = sub {
        $l->{precisa_tara} = 0;
        $l->{resultado_tara} = { em => $agora * 1000, ok => JSON::PP::false, peso => undef, motivo => $_[0] };
        registrar("Tara automática não feita: $_[0]");
    };
    $ocupado ||= status_leitor($l) ne 'livre';
    my $nome = $ocupado ? undef : janela_ativa();
    if ($ocupado || !defined $nome || $nome ne $JANELA_ACRUX) {
        $desistir->($ocupado ? 'caixa ocupado' : 'janela "' . (defined $nome ? $nome : '?') . '" aberta na tela') if $parado > $DESISTE_TARA;
        return;
    }
    my ($ok, $saida) = apertar_tara();
    $l->{precisa_tara} = 0;
    my $final = defined $l->{tara_final} ? sprintf('%.3f kg', $l->{tara_final}) : 'não registrada';
    $final =~ tr/./,/;
    unless ($ok) { $desistir->('não foi possível apertar a tecla (' . substr($saida, 0, 60) . ')'); return }
    $l->{tara_enviada_em} = $agora;
    $l->{resultado_tara} = { em => $agora * 1000, ok => undef, peso => undef, motivo => "depois da venda (tara final: $final)" };
    registrar("Tara automática: tecla \"b\" enviada (tara final da venda: $final)");
}

# Balança de conferência no pagamento (selfcheckout.log):
#   PagamentoAntes 4: PesoBalanca X UltimoPesoTotal Y Tolerancia T -> antes de pagar, peso diferente
#     do registrado: o AcruxPDV trava com "Aguarde pela operadora, -2,150 Kg".
#   PagamentoApos 1: ... PesoLiquido L PesoTolerancia T -> depois de pagar, espera a balança
#     esvaziar (repete a cada 2s). PagamentoApos 2 (operador liberou) ou TaraBalancaConferencia encerra.
#   PesoBalanca -1000 = leitura instável, não muda nada.
sub conferir_peso_pagamento {
    my ($l, $ev, $passo, $linha, $agora) = @_;
    my $resto = (split /:/, $linha, 4)[-1];
    my %v;
    while ($resto =~ /(\w+) (-?\d+(?:,\d+)?)/g) { my ($k, $x) = ($1, $2); $x =~ tr/,/./; $v{$k} = $x + 0 }
    my $bal = defined $v{PesoBalanca} ? $v{PesoBalanca} : 0;
    if ($ev eq 'PagamentoAntes' && $passo >= 4 && defined $v{UltimoPesoTotal}) {
        my $dif = $bal - $v{UltimoPesoTotal};
        my $tol = defined $v{Tolerancia} ? $v{Tolerancia} : 0.05;
        if ($bal > -999 && abs($dif) > $tol + 1e-9) {
            $l->{peso_pagto} = ['antes', $agora, $dif] unless $l->{peso_pagto} && $l->{peso_pagto}[0] eq 'antes';
            $l->{peso_pagto}[2] = $dif;
        } else { $l->{peso_pagto} = undef }
    } elsif ($ev eq 'PagamentoApos' && $passo == 1 && defined $v{PesoLiquido}) {
        return if $bal <= -999;
        my $liq = $v{PesoLiquido};
        my $tol = defined $v{PesoTolerancia} ? $v{PesoTolerancia} : 0.02;
        if (abs($liq) > $tol + 1e-9) {
            $l->{peso_pagto} = ['apos', $agora, $liq] unless $l->{peso_pagto} && $l->{peso_pagto}[0] eq 'apos';
            $l->{peso_pagto}[2] = $liq;
        } else { $l->{peso_pagto} = undef }
    } elsif (($ev eq 'PagamentoApos' && $passo >= 2) || $ev eq 'TaraBalancaConferencia'
             || $ev eq 'VenderItemApos' || $ev =~ /^VendaCancelar/) {
        $l->{peso_pagto} = undef;
    }
}

# ---- PDV normal: abertura/fechamento do caixa, operadora e venda pela fila de saída
# O AcruxPDV grava cada movimento em cache/output/AAAA-MM-DD/<sequência> (compactado com zlib),
# com linhas "60|seq|mtOperacao|operador|DDMMAAAAhhmmss|...": mtAbrirCaixa, mtCupomFiscal (venda
# começou), mtFinalizadora... (pagou), mtCancelarCupom, mtFecharCaixa, mtEncerrarTurno.
my $TEM_ZLIB = eval { require Compress::Zlib; 1 } ? 1 : 0;

sub ler_registro_fila {
    my ($caminho) = @_;
    return () unless $TEM_ZLIB;
    my $tam = -s $caminho;
    return () if !defined $tam || $tam > 20000;  # os grandes são lotes de documentos repetidos
    open my $fh, '<:raw', $caminho or return ();
    my $b = do { local $/; <$fh> };
    close $fh;
    my $texto;
    for my $marca ("\x78\x9c", "\x78\xda", "\x78\x01") {
        my $i = index($b, $marca);
        next if $i < 0;
        $texto = Compress::Zlib::uncompress(substr($b, $i));
        last if defined $texto;
    }
    return () unless defined $texto;
    my @ops;
    for my $linha (split /\r?\n/, $texto) {
        next unless $linha =~ /^60\|(\d+)\|(mt\w+)\|(\d*)\|(\d{14})/;
        my ($seq, $op, $operador, $h) = ($1, $2, $3, $4);
        push @ops, [ substr($h, 4, 4) . substr($h, 2, 2) . substr($h, 0, 2) . substr($h, 8), $seq, $op, $operador ];
    }
    return @ops;
}

sub aplicar_op_fila {
    my ($l, $op, $operador) = @_;
    if ($op eq 'mtAbrirCaixa') { $l->{fila_estado} = 'livre'; $l->{fila_operador} = $operador || undef }
    elsif ($op eq 'mtFecharCaixa' || $op eq 'mtEncerrarTurno') { $l->{fila_estado} = 'fechado'; $l->{fila_operador} = undef }
    elsif ($op eq 'mtCupomFiscal') { $l->{fila_estado} = 'em_venda'; $l->{fila_operador} = $operador if $operador }
    elsif ($op =~ /^mtFinalizadora/ || $op eq 'mtCancelarCupom') { $l->{fila_estado} = 'livre' if ($l->{fila_estado} || '') ne 'fechado' }
}

sub ordenar_ops { return sort { $a->[0] cmp $b->[0] || $a->[1] <=> $b->[1] } @_ }

sub ler_fila {
    my ($l) = @_;
    my $base = "$PASTA_ACRUX/cache/output";
    return unless -d $base;
    my $hoje = strftime('%Y-%m-%d', localtime);
    if (($l->{fila_dia} || '') ne $hoje) { $l->{fila_dia} = $hoje; $l->{fila_vistos} = {} }
    if (!defined $l->{fila_estado}) {
        # Início: o último estado de um dia anterior (caixa aberto de um dia para o outro).
        if (opendir(my $dh, $base)) {
            my @dias = sort grep { /^\d{4}-\d{2}-\d{2}$/ && $_ lt $hoje } readdir $dh;
            closedir $dh;
            if (@dias && opendir(my $d2, "$base/$dias[-1]")) {
                my @nomes = sort grep { /^\d+$/ } readdir $d2;
                closedir $d2;
                @nomes = @nomes[-60 .. -1] if @nomes > 60;
                aplicar_op_fila($l, $_->[2], $_->[3]) for ordenar_ops(map { ler_registro_fila("$base/$dias[-1]/$_") } @nomes);
            }
        }
        $l->{fila_estado} = 'fechado' unless defined $l->{fila_estado};
    }
    opendir(my $dh, "$base/$hoje") or return;
    my @novos = sort grep { /^\d+$/ && !$l->{fila_vistos}{$_} } readdir $dh;
    closedir $dh;
    my @ops;
    for my $n (@novos) { $l->{fila_vistos}{$n} = 1; push @ops, ler_registro_fila("$base/$hoje/$n") }
    aplicar_op_fila($l, $_->[2], $_->[3]) for ordenar_ops(@ops);
}

# PDV normal: sem trace e sem selfcheckout.log, o estado vem da fila de saída.
sub usa_fila {
    my ($l) = @_;
    return !tem_trace($l) && defined $l->{fila_estado} && !-e "$l->{pasta}/selfcheckout.log";
}

sub status_leitor {
    my ($l) = @_;
    return $l->{fila_estado} if usa_fila($l);
    unless (tem_trace($l)) {
        # Venda abandonada/cancelada nem sempre deixa marca: parada há muito tempo = livre.
        $l->{status_selfck} = 'livre'
            if $l->{status_selfck} ne 'livre' && time - $l->{ultimo_mov_venda} > $l->{limite_venda_parada};
        return $l->{status_selfck};
    }
    my $o = $l->{ops};
    return 'pagamento' if $o->{opPagamento} || $o->{opImprimindoPagamento};
    return 'em_venda' if $o->{opVendaAberta};
    return 'fechado' if $o->{opCaixaFechado};
    return 'livre';
}

sub condicoes {
    my ($l) = @_;
    my %c;
    my $agora = time;
    if (defined $l->{chamado_desde}) {
        if ($agora - $l->{chamado_desde} > 600) { $l->{chamado_desde} = undef }  # sem sinal de fim em 10 min
        else { $c{chamado} = 'O self pediu atendimento do fiscal' }
    }
    $c{cancelamento} = 'Cliente cancelando um item (precisa do fiscal)' if defined $l->{cancelamento_desde};
    $c{fiscal} = $ACOES_FISCAL{$l->{mt}} || 'O caixa está pedindo a senha do fiscal' if $l->{ops}{opAutenticacao};
    $c{peso} = sprintf('Peso na balança diferente do esperado há %ds', $agora - $l->{peso_desde})
        if defined $l->{peso_desde} && $agora - $l->{peso_desde} >= $l->{limite_peso};
    $l->{peso_pagto} = undef if $l->{peso_pagto} && $agora - $l->{peso_pagto}[1] > 900;  # 15 min sem fim
    if (my $p = $l->{peso_pagto}) {
        my ($fase, $desde, $kg) = @$p;
        (my $kg_txt = sprintf('%.3f', $kg)) =~ tr/./,/;
        my $espera = $l->{limite_peso} * 2 > 30 ? $l->{limite_peso} * 2 : 30;
        if ($fase eq 'antes') {
            $c{peso} = "Peso diferente no pagamento ($kg_txt kg): aguarda o fiscal";
        } elsif ($agora - $desde >= $espera) {
            $c{peso} = sprintf('Balança não esvaziou após o pagamento (%s kg) há %ds', $kg_txt, $agora - $desde);
        }
    }
    $c{mensagem} = sprintf('Mensagem aberta na tela há %ds sem resposta', $agora - $l->{dialogo_desde})
        if defined $l->{dialogo_desde} && $agora - $l->{dialogo_desde} >= $l->{limite_msg};
    return \%c;
}

# ---------------------------------------------------------------- histórico
# Relê um dia do que o AcruxPDV guardou (só lê, não muda nada no caixa):
#  - vendas e valor pelas NFC-e autorizadas (documento/nf-e/gerada/AAAAMMDD/NFCe);
#  - "Self chamou o fiscal": pares EnviarAlerta -> RemoverAlerta do app_DDMMAA.log.
# $t é qualquer horário daquele dia. Devolve undef se não há nada daquele dia.
sub historico_do_dia {
    my ($conf, $t) = @_;
    my @lt = localtime $t;
    my %item = (dia => strftime('%Y-%m-%d', @lt), vendas => undef, total => undef, chamados => [],
                contingencia => undef, valorContingencia => undef);
    my $pasta = "$PASTA_ACRUX/documento/nf-e/gerada/" . strftime('%Y%m%d', @lt) . '/NFCe';
    if (opendir(my $dh, $pasta)) {
        my %notas;
        my ($n_cont, $v_cont) = (0, 0);  # notas não autorizadas no caixa (contingência)
        for my $nome (grep { /-nfe\.xml$/ } readdir $dh) {
            open my $f, '<:raw', "$pasta/$nome" or next;
            my $xml = do { local $/; <$f> };
            close $f;
            my ($n) = $xml =~ /<nNF>(\d+)<\/nNF>/;
            my ($v) = $xml =~ /<vNF>([\d.]+)<\/vNF>/;
            if (index($xml, '<cStat>100</cStat>') >= 0 && defined $n && $n ne '0') {
                $notas{$n} = $v || 0;
            } else {
                $n_cont++;
                $v_cont += $v || 0;
            }
        }
        closedir $dh;
        my $soma = 0;
        $soma += $_ for values %notas;
        $item{vendas} = 0 + scalar keys %notas;
        $item{total} = 0 + sprintf('%.2f', $soma);
        $item{contingencia} = 0 + $n_cont;
        $item{valorContingencia} = 0 + sprintf('%.2f', $v_cont);
    }
    my $arq = "$conf->{PASTA_LOGS_ACRUX}/app_" . strftime('%d%m%y', @lt) . '.log';
    if (open my $f, '<', $arq) {
        # Nem todo caixa registra o RemoverAlerta: sem ele o chamado vai sem fim (conta no total,
        # fica fora do tempo de espera). EnviarAlerta repetido em menos de 1 min é o mesmo chamado.
        my ($aberto, $ultimo_envio);
        while (my $linha = <$f>) {
            next unless index($linha, 'Alerta') >= 0;
            $linha =~ s/[\r\n]+$//;
            my @c = split /\t/, $linha;
            next unless ($c[0] || '') =~ m{^(\d\d)/(\d\d)/(\d{4}) (\d\d):(\d\d):(\d\d)};
            my $ms = 1000 * timelocal($6, $5, $4, $1, $2 - 1, $3);
            my %campos = map { $_ => 1 } @c;
            if ($campos{EnviarAlerta}) {
                if (defined $aberto && $ms - $ultimo_envio >= 60000) { push @{ $item{chamados} }, [0 + $aberto, undef]; $aberto = undef }
                $aberto = $ms unless defined $aberto;
                $ultimo_envio = $ms;
            } elsif ($campos{RemoverAlerta} && defined $aberto) {
                push @{ $item{chamados} }, [0 + $aberto, 0 + $ms];
                $aberto = undef;
            }
        }
        close $f;
        push @{ $item{chamados} }, [0 + $aberto, undef] if defined $aberto;
    }
    return (defined $item{vendas} || @{ $item{chamados} }) ? \%item : undef;
}

# ---------------------------------------------------------------- diagnóstico
sub diagnostico {
    my ($conf, $seg) = @_;
    printf "Loja %s, PDV %s | logs em %s\n", $conf->{LOJA} || '?', $conf->{PDV} || '?', $conf->{PASTA_LOGS_ACRUX};
    my $l = novo_leitor($conf);
    my $fim = time + $seg;
    my $anterior = '';
    while (1) {
        atualizar_leitor($l);
        my $c = condicoes($l);
        my $al = join(', ', map { "$_: $c->{$_}" } sort keys %$c) || '-';
        my $total = total_dia($l);
        my $atual = sprintf('[%s] status=%s vendas=%d total=%s alertas=%s | op=[%s] mt=[%s]',
            tem_trace($l) ? 'trace' : 'sem trace: selfcheckout + XML das NFC-e',
            status_leitor($l), vendas_dia($l), defined $total ? sprintf('%.2f', $total) : '?', $al,
            join(' ', sort keys %{ $l->{ops} }), $l->{mt});
        if ($atual ne $anterior) { print strftime('%H:%M:%S', localtime), " $atual\n"; $anterior = $atual }
        last if time >= $fim;
        sleep 1;
    }
}

# ---------------------------------------------------------------- agente
sub principal {
    my $conf = ler_conf();
    if (@ARGV && $ARGV[0] eq 'diagnostico') { return diagnostico($conf, $ARGV[1] || 0) }
    if (@ARGV && $ARGV[0] eq 'fiscal') {
        # Só mostra a situação fiscal de hoje (notas sem autorização e erros de envio).
        my $l = novo_leitor($conf);
        atualizar_leitor($l);
        my $f = fiscal($l);
        my $hora = sub { $_[0] ? strftime('%H:%M:%S', localtime($_[0] / 1000)) : '-' };
        printf "autorizadas=%d  pendentes=%d (desde %s)  erros de envio=%d (ultimo %s)\n",
            $f->{autorizadas}, $f->{pendentes}, $hora->($f->{pendenteDesde}), $f->{errosEnvio}, $hora->($f->{ultimoErro});
        return;
    }
    if (@ARGV && $ARGV[0] eq 'estado') {
        # Só mostra o estado que o agente enviaria (não envia nada).
        my $l = novo_leitor($conf);
        atualizar_leitor($l);
        printf "estado=%s  fonte=%s  operador=%s  vendas=%s  zlib=%s\n", status_leitor($l),
            usa_fila($l) ? 'fila de saída (PDV normal)' : (tem_trace($l) ? 'trace' : 'selfcheckout.log'),
            defined $l->{fila_operador} ? $l->{fila_operador} : '-', vendas_dia($l), $TEM_ZLIB ? 'sim' : 'NÃO';
        my $janela = janela_ativa();
        printf "janela ativa: %s  pede senha do fiscal: %s\n", defined $janela ? $janela : '(xdotool não respondeu)',
            pede_senha_fiscal($janela) ? 'SIM' : 'não';
        return;
    }
    if (@ARGV && $ARGV[0] eq 'tara') {
        # Piloto da tara automática. "tara": só mostra a sessão gráfica e a janela ativa.
        # "tara enviar": aperta "b" UMA vez, só se a tela principal do AcruxPDV estiver na frente.
        my ($disp, $auth) = ambiente_x();
        my $nome = janela_ativa();
        print "DISPLAY=$disp XAUTHORITY=" . (defined $auth ? $auth : '-') . "\n";
        print 'janela ativa: ' . (defined $nome ? $nome : '(xdotool não respondeu)') . "\n";
        if (($ARGV[1] || '') eq 'enviar') {
            if (!defined $nome || $nome ne $JANELA_ACRUX) { print "NÃO enviado: a janela ativa não é a tela principal \"$JANELA_ACRUX\".\n"; return }
            my ($ok, $saida) = apertar_tara();
            print $ok ? "tecla \"b\" enviada\n" : "falhou: $saida\n";
            print "Confira na balança/tela e no log: grep TaraBalanca $conf->{PASTA_LOGS_ACRUX}/selfcheckout.log | tail -2\n";
        }
        return;
    }
    if (@ARGV && $ARGV[0] eq 'historico') {
        # Só mostra o que seria enviado ao painel (não envia nada).
        my $dias = $ARGV[1] || $HISTORICO_DIAS;
        for (my $i = $dias; $i >= 0; $i--) {
            my $d = historico_do_dia($conf, time - $i * 86400) or next;
            printf "%s  vendas=%s  total=%s  contingencia=%s (%s)  chamados=%d\n", $d->{dia},
                defined $d->{vendas} ? $d->{vendas} : 'None', defined $d->{total} ? $d->{total} : 'None',
                defined $d->{contingencia} ? $d->{contingencia} : 'None', defined $d->{valorContingencia} ? $d->{valorContingencia} : 'None',
                scalar @{ $d->{chamados} };
        }
        return;
    }
    for my $k (qw(TOKEN LOJA PDV)) { die "Configure $k em /etc/painel-self/agente.conf\n" if $conf->{$k} eq '' }

    my $leitor;
    if ($conf->{LER_LOGS_ACRUX} eq '1') {
        if (-d $conf->{PASTA_LOGS_ACRUX}) { $leitor = novo_leitor($conf) }
        else { registrar("Pasta de logs do AcruxPDV não encontrada: $conf->{PASTA_LOGS_ACRUX}") }
    }
    my $http = HTTP::Tiny->new(timeout => 8, agent => "painel-self-agente/$VERSAO");
    my $json = JSON::PP->new->utf8->canonical;
    # SERVIDOR pode ter vários endereços (espaço ou vírgula): o primeiro é o principal,
    # os outros (ex.: teste) recebem uma cópia com espera curta.
    my @urls = map { my $u = $_; $u =~ s{/$}{}; "$u/api/agente" } grep { length } split /[\s,]+/, $conf->{SERVIDOR};
    my $http2 = HTTP::Tiny->new(timeout => 3, agent => "painel-self-agente/$VERSAO");
    my $http_hist = HTTP::Tiny->new(timeout => 30, agent => "painel-self-agente/$VERSAO");
    my %conectado_em;
    # Histórico por painel: quando mandou, dias pendentes depois de falha, e a fila em leitura
    # (um dia por volta do laço, para não parar o envio do estado enquanto lê).
    my (%hist_em, %hist_pendente, %hist_fila);
    my %situacao = (status => 'livre', vendasHoje => 0, totalHoje => 0);
    my %reconhecidos;
    my $cond = {};
    # Tara automática: definida no painel (Configurações). Vale a do principal; se ele não
    # respondeu, a do primeiro que respondeu.
    my $modo_tara = 'desligado';
    my $tipo_caixa = 'self';  # 'pdv' = PDV normal (com operador): só acompanha, sem alertas de self
    my %config_de;
    my $conectado = 0;
    my $ja_avisou = 0;
    my $proximo_envio = 0;
    my $ultimo = '';
    registrar("Agente $VERSAO | loja $conf->{LOJA} PDV $conf->{PDV} | painel $conf->{SERVIDOR} | logs AcruxPDV: " . ($leitor ? 'sim' : 'não'));

    my $alerta_atual = sub {
        my @cand = grep { !$reconhecidos{$_} } keys %$cond;
        return undef unless @cand;
        my ($tipo) = sort { ($PRIORIDADE{$b} || 1) <=> ($PRIORIDADE{$a} || 1) || $a cmp $b } @cand;
        return { alerta => $tipo, mensagem => $cond->{$tipo} };
    };

    while (1) {
        if ($leitor) {
            eval {
                atualizar_leitor($leitor);
                $situacao{status} = status_leitor($leitor);
                if (usa_fila($leitor)) {
                    # PDV normal: a operadora do turno (código do AcruxPDV), vazia com o caixa fechado.
                    my $op = $leitor->{fila_operador};
                    $situacao{operador} = ($op && $leitor->{fila_estado} ne 'fechado') ? "Op. $op" : undef;
                }
                $situacao{vendasHoje} = vendas_dia($leitor);
                $situacao{totalHoje} = total_dia($leitor);
                $situacao{fiscal} = fiscal($leitor);
                # PDV normal: só a senha do fiscal vira alerta (peso, mensagem aberta e chamado são
                # situações de self e virariam alertas falsos aqui).
                $cond = $tipo_caixa eq 'pdv' ? condicoes_pdv() : condicoes($leitor);
                for (keys %reconhecidos) { delete $reconhecidos{$_} unless $cond->{$_} }  # sumiu: pode alertar de novo
                1;
            } or registrar("Erro lendo logs do AcruxPDV: $@");
            # Tara automática: nunca pode parar a leitura dos logs.
            eval {
                my $ocupado = $alerta_atual->() ? 1 : 0;
                talvez_tarar($leitor, $tipo_caixa eq 'pdv' ? 'desligado' : $modo_tara, $ocupado);
                $situacao{taraAuto} = { %{ $leitor->{resultado_tara} } } if $leitor->{resultado_tara};
                1;
            } or registrar("Erro na tara automática: $@");
        }
        my $a = $alerta_atual->();
        my $chave = $situacao{status} . '|' . ($a ? $a->{alerta} : '');
        if (time >= $proximo_envio || $chave ne $ultimo) {
            $ultimo = $chave;
            $proximo_envio = time + $conf->{INTERVALO};
            my $corpo = $json->encode({
                %situacao,
                loja => 0 + $conf->{LOJA}, pdv => 0 + $conf->{PDV},
                nome => ($conf->{NOME} ne '' ? $conf->{NOME} : undef),
                versao => $VERSAO, portaVnc => 0 + $conf->{PORTA_VNC},
                alerta => $a,
            });
            for my $i (0 .. $#urls) {
                my $url = $urls[$i];
                my $r = ($i == 0 ? $http : $http2)->post($url, {
                    content => $corpo,
                    headers => { 'Content-Type' => 'application/json', Authorization => "Bearer $conf->{TOKEN}" },
                });
                my $antes = $conectado_em{$url};
                if ($r->{success}) {
                    my $resp = eval { $json->decode($r->{content}) } || {};
                    registrar("Conectado ao painel $url como " . ($resp->{id} || '?')) unless $antes;
                    $conectado_em{$url} = 1;
                    $config_de{$url} = ref $resp->{config} eq 'HASH' ? $resp->{config} : {};
                    for my $cmd (@{ $resp->{comandos} || [] }) {
                        registrar("Comando do painel: " . ($cmd->{acao} || '') . ' (' . ($cmd->{usuario} || '') . ')');
                        # Liberado no painel: não reabrir enquanto a condição continuar.
                        if (($cmd->{acao} || '') eq 'liberar') { $reconhecidos{$_} = 1 for keys %$cond }
                    }
                    # Conectado: hora de mandar o histórico? 30 dias na primeira vez, 2 a cada 6 h.
                    if (!$hist_fila{$url} && (!defined $hist_em{$url} || time - $hist_em{$url} >= $HISTORICO_A_CADA)) {
                        my $dias = delete $hist_pendente{$url};
                        $dias = defined $hist_em{$url} ? 2 : $HISTORICO_DIAS unless defined $dias;
                        $hist_em{$url} = time;
                        $hist_fila{$url} = { total => $dias, dias => [ map { time - $_ * 86400 } reverse 0 .. $dias ], itens => [] };
                    }
                } else {
                    # Avisa só na mudança (conectado -> sem conexão), para não encher o log.
                    registrar("Sem conexão com o painel $url ($r->{status}): " . substr($r->{content} || $r->{reason} || '', 0, 200))
                        if $antes || !defined $antes;
                    $conectado_em{$url} = 0;
                }
            }
            $conectado = $conectado_em{$urls[0]} ? 1 : 0;
            if (my ($url) = grep { $conectado_em{$_} && $config_de{$_} } @urls) {
                my $tipo = ($config_de{$url}{tipo} || '') eq 'pdv' ? 'pdv' : 'self';
                registrar('Tipo do caixa no painel: ' . ($tipo eq 'pdv' ? 'PDV normal (sem alertas de self)' : 'self-checkout')) if $tipo ne $tipo_caixa;
                $tipo_caixa = $tipo;
                my $modo = $config_de{$url}{taraAuto} || 'desligado';
                $modo = 'desligado' unless $modo =~ /^(desligado|precisa|sempre)$/;
                registrar("Tara automática: $modo (definido no painel $url)") if $modo ne $modo_tara;
                $modo_tara = $modo;
            }
        }
        # Histórico: lê um dia por volta; quando terminar, manda tudo de uma vez.
        if (my ($url) = grep { $hist_fila{$_} } @urls) {
            my $fila = $hist_fila{$url};
            if (@{ $fila->{dias} }) {
                my $item = eval { historico_do_dia($conf, shift @{ $fila->{dias} }) };
                push @{ $fila->{itens} }, $item if $item;
            } else {
                delete $hist_fila{$url};
                my $r = $http_hist->post("$url/historico", {
                    content => $json->encode({ loja => 0 + $conf->{LOJA}, pdv => 0 + $conf->{PDV}, versao => $VERSAO, dias => $fila->{itens} }),
                    headers => { 'Content-Type' => 'application/json', Authorization => "Bearer $conf->{TOKEN}" },
                });
                if ($r->{success}) {
                    my $resp = eval { $json->decode($r->{content}) } || {};
                    registrar(sprintf('Histórico (%d dias) enviado a %s: %s dia(s) de vendas atualizados, %s chamado(s) recuperado(s)',
                        $fila->{total}, $url, $resp->{diasVendas} // '?', $resp->{chamados} // '?'));
                } else {
                    registrar("Não foi possível enviar o histórico a $url ($r->{status}); tenta de novo em 10 min");
                    $hist_pendente{$url} = $fila->{total};
                    $hist_em{$url} = time - $HISTORICO_A_CADA + 600;
                }
            }
        }
        sleep 1;
    }
}

principal();
