#!/bin/sh
# Corre só na primeira inicialização do volume do PostgreSQL.
# O WAHA tem um utilizador próprio: cria as suas bases (waha_…) mas não tem acesso à base "losambo".
set -eu

if [ -z "${WAHA_DB_PASSWORD:-}" ]; then
  echo "WAHA_DB_PASSWORD não definido" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v waha_password="$WAHA_DB_PASSWORD" <<'SQL'
CREATE ROLE waha LOGIN CREATEDB PASSWORD :'waha_password';
REVOKE ALL ON DATABASE losambo FROM PUBLIC;
SQL
