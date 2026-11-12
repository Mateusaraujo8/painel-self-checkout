#!/bin/sh
# Instala (ou atualiza) o agente do Painel Self-Checkout.
# Uso (como root, na pasta onde estão os arquivos):
#   sh instalar.sh            -> loja e PDV lidos do AcruxPDV (AcruxPDV.info)
#   sh instalar.sh LOJA PDV   -> força loja e PDV
#
# Detecta o tipo de caixa:
#   - python3 + systemd (Ubuntu): agente.py como serviço systemd
#   - só perl (ex.: Slackware 14): agente.pl iniciado pelo /etc/rc.d/rc.local, com reinício automático
set -e
LOJA="$1"
PDV="$2"

if command -v python3 >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1; then
  TIPO=python
elif command -v perl >/dev/null 2>&1 && perl -MHTTP::Tiny -MJSON::PP -e 1 2>/dev/null; then
  TIPO=perl
else
  echo "Nem python3+systemd nem perl (com HTTP::Tiny e JSON::PP) encontrados neste caixa."
  exit 1
fi
echo "Tipo de caixa: $TIPO"

GRUPO=$(id -gn nobody 2>/dev/null || echo nogroup)
mkdir -p /opt/painel-self /etc/painel-self

if [ ! -f /etc/painel-self/agente.conf ]; then
  cp agente.conf /etc/painel-self/agente.conf
fi
# Ao atualizar, o endereço do(s) painel(is) sempre vem do pacote (o resto da configuração fica).
NOVO_SERVIDOR=$(grep '^SERVIDOR=' agente.conf | head -n 1 | tr -d '\r')
if [ -n "$NOVO_SERVIDOR" ]; then
  if grep -q '^SERVIDOR=' /etc/painel-self/agente.conf; then
    sed -i "s|^SERVIDOR=.*|$NOVO_SERVIDOR|" /etc/painel-self/agente.conf
  else
    echo "$NOVO_SERVIDOR" >> /etc/painel-self/agente.conf
  fi
  echo "Painel: ${NOVO_SERVIDOR#SERVIDOR=}"
fi
if [ -n "$LOJA" ] && [ -n "$PDV" ]; then
  sed -i "s/^#\?\s*LOJA=.*/LOJA=$LOJA/; s/^#\?\s*PDV=.*/PDV=$PDV/" /etc/painel-self/agente.conf
fi
# O token fica legível só para root e para o usuário do serviço.
chown root:"$GRUPO" /etc/painel-self/agente.conf
chmod 640 /etc/painel-self/agente.conf

echo "Conferindo o que o agente enxerga nos logs do AcruxPDV:"
if [ "$TIPO" = python ]; then
  cp agente.py /opt/painel-self/agente.py
  chmod 755 /opt/painel-self/agente.py
  PAINEL_CONF=/etc/painel-self/agente.conf python3 /opt/painel-self/agente.py diagnostico 0 || true
  echo
  cp painel-self-agente.service /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable painel-self-agente
  systemctl restart painel-self-agente
  sleep 3
  systemctl --no-pager status painel-self-agente | head -n 12
  echo
  echo "Logs: journalctl -u painel-self-agente -f"
  exit 0
fi

# ---------------------------------------------------------------- perl (sem systemd)
cp agente.pl /opt/painel-self/agente.pl
chmod 755 /opt/painel-self/agente.pl
PAINEL_CONF=/etc/painel-self/agente.conf perl /opt/painel-self/agente.pl diagnostico 0 || true
echo

LOG=/var/log/painel-self-agente.log
touch "$LOG"
chown nobody:"$GRUPO" "$LOG"

cat > /opt/painel-self/rodar.sh <<'EOF'
#!/bin/sh
# Mantém o agente rodando: se o perl sair, espera 5 s e inicia de novo.
while true; do
  perl /opt/painel-self/agente.pl >> /var/log/painel-self-agente.log 2>&1
  sleep 5
done
EOF
chmod 755 /opt/painel-self/rodar.sh

cat > /opt/painel-self/iniciar.sh <<'EOF'
#!/bin/sh
# Para a instância anterior (se houver) e inicia o agente como "nobody".
pkill -f /opt/painel-self/rodar.sh 2>/dev/null
pkill -f /opt/painel-self/agente.pl 2>/dev/null
sleep 1
# Mantém o log pequeno: guarda só as últimas 2000 linhas a cada início.
if [ -f /var/log/painel-self-agente.log ]; then
  tail -n 2000 /var/log/painel-self-agente.log > /var/log/painel-self-agente.log.tmp && \
    cat /var/log/painel-self-agente.log.tmp > /var/log/painel-self-agente.log
  rm -f /var/log/painel-self-agente.log.tmp
fi
nohup su -s /bin/sh nobody -c /opt/painel-self/rodar.sh >/dev/null 2>&1 &
EOF
chmod 755 /opt/painel-self/iniciar.sh

RCLOCAL=/etc/rc.d/rc.local
[ -f "$RCLOCAL" ] || { echo '#!/bin/sh' > "$RCLOCAL"; }
chmod 755 "$RCLOCAL"
# A linha de início precisa ficar ANTES do primeiro "exit" do rc.local (nos caixas Slackware ele
# termina com "exit 0"; o que vier depois nunca roda). Tira a linha de instalações anteriores
# (que ficou depois do exit) e põe de novo no lugar certo.
cp "$RCLOCAL" "$RCLOCAL.antes-painel-self"
awk '
  /# Agente do Painel Self-Checkout/ || /\/opt\/painel-self\/iniciar\.sh/ { next }
  !feito && /^exit([[:space:]]|$)/ {
    print "# Agente do Painel Self-Checkout"
    print "[ -x /opt/painel-self/iniciar.sh ] && /opt/painel-self/iniciar.sh"
    feito = 1
  }
  { print }
  END {
    if (!feito) {
      print "# Agente do Painel Self-Checkout"
      print "[ -x /opt/painel-self/iniciar.sh ] && /opt/painel-self/iniciar.sh"
    }
  }
' "$RCLOCAL.antes-painel-self" > "$RCLOCAL.novo" && cat "$RCLOCAL.novo" > "$RCLOCAL"
rm -f "$RCLOCAL.novo"
chmod 755 "$RCLOCAL"
echo "rc.local: agente inicia no boot (linha $(grep -n 'painel-self/iniciar.sh' "$RCLOCAL" | cut -d: -f1), primeiro exit na linha $(grep -n '^exit' "$RCLOCAL" | head -n 1 | cut -d: -f1))"

/opt/painel-self/iniciar.sh
sleep 4
if pgrep -f /opt/painel-self/agente.pl >/dev/null; then
  echo "Active: active (running) (perl, iniciado pelo rc.local)"
else
  echo "O agente não ficou rodando. Veja $LOG"
fi
tail -n 5 "$LOG"
echo
echo "Logs: tail -f $LOG"
