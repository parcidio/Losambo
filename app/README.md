# Losambo

OTP e mensagens WhatsApp para startups, com o número que o negócio já usa.
Implementação do design "Losambo — WhatsApp SaaS" (Claude Design) em Node/TypeScript,
com o **WAHA** como motor WhatsApp e PostgreSQL.

```
App do cliente ──Bearer lsb_live_…──▶ Losambo (/v1)  ──X-Api-Key──▶ WAHA ──▶ WhatsApp
                                         ▲                            │
             servidor do cliente ◀── webhooks assinados ◀── /hooks/waha/<token>
```

## Arrancar

1. WAHA a correr (ex.: `devlikeapro/waha` na porta 3000), de preferência com
   `WHATSAPP_DEFAULT_ENGINE=GOWS`.
2. `cp .env.example .env` e preencher **`WAHA_API_KEY`** (a mesma do container WAHA)
   e `WAHA_WEBHOOK_TOKEN` (valor aleatório).
3. Base de dados e servidor:

```bash
npm install
npm run db:up
npm run dev
```

Abrir http://localhost:4000. A primeira conta criada fica super-admin (vê "Contas e planos").

Contas de teste locais criadas durante o desenvolvimento (palavra-passe `teste-local-2026`):
`teste@losambo.test` (super-admin) e `teste2@losambo.test`.

## Páginas

| Rota | Ecrã do design |
|---|---|
| `/` | Landing page |
| `/entrar`, `/entrar#criar` | Entrar / criar conta |
| `/consola` | Início |
| `/consola#/numeros` | Números e saúde da sessão (capping, timelock, ritmo de envio) |
| `/consola#/numeros/ligar` | Ligar número por QR ou código de 8 caracteres |
| `/consola#/monitor` | Monitor de eventos (ao vivo, com estado de entrega) |
| `/consola#/otp`, `#/mensagens` | Testar OTP (envio e inverso) e mensagens |
| `/consola#/webhooks`, `#/chaves` | Webhooks (HMAC, repetições) e chaves API |
| `/consola#/admin` | Admin — contas, plano Interno, estado do WAHA |
| `/docs` | Documentação da API |

## API pública (`/v1`)

| Losambo | WAHA por baixo |
|---|---|
| `GET/POST /numbers` | `GET/POST /api/sessions` |
| `GET /numbers/{id}/qr` | `GET /api/{s}/auth/qr` |
| `POST /numbers/{id}/pairing-code` | `POST /api/{s}/auth/request-code` |
| `GET /numbers/{id}/health` | `/api/sessions/{s}` · `/capping` · `/timelock` |
| `POST /numbers/{id}/restart` | `POST /api/sessions/{s}/restart` |
| `DELETE /numbers/{id}` | `logout` + `DELETE /api/sessions/{s}` |
| `POST /otp/send` | `check-exists` → `capping` → `startTyping` → `sendText` → `stopTyping` |
| `POST /otp/reverse` | webhook `message` com `LSB-XXXXXX` |
| `POST /otp/verify` | — (só Losambo) |
| `POST /messages` | `sendText` · `sendImage` · `sendFile` |
| `GET /contacts/{phone}` | `GET /api/contacts/check-exists` |

Permissões das chaves: `read`, `send`, `control`, `settings`, `delete`.
Webhooks enviados com `X-Losambo-Signature: sha256=<HMAC do corpo>`.

## Entrar com Google

1. Em https://console.cloud.google.com/apis/credentials crie um *OAuth client ID* do tipo
   **Aplicação Web** (e configure o ecrã de consentimento, se ainda não existir).
2. Em *URIs de redirecionamento autorizados* adicione `http://localhost:4000/auth/google/callback`
   (e o equivalente em produção).
3. Preencha `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` e `GOOGLE_REDIRECT_URI` no `.env` e reinicie.

O botão "Continuar com Google" só aparece quando o Google está configurado. Quem entra pela primeira vez
com o Google ganha uma conta (com os números Losambo por omissão); se já existir uma conta com o mesmo
e-mail verificado, o Google fica ligado a essa conta.

## Números: Losambo vs. próprios

- **Números Losambo** (sessões `lsb_NN`): ligados pelo super-admin em *Números Losambo* e partilhados
  pelas contas a que forem atribuídos. Grátis e Startup **só** usam estes números.
  Os marcados "Por omissão" são atribuídos automaticamente a cada conta nova.
- **Números próprios** (sessões `<conta>-NN`, ligados pelo cliente por QR/código): só no plano
  **Negócio** (e Interno). Num downgrade, as chaves WAHA dos números próprios são desligadas.
- As contas não controlam números Losambo (QR, parar, reiniciar, apagar, ritmo → `403 platform_number`).
- Respostas recebidas num número partilhado vão para a conta que falou por último com esse contacto
  por esse número; códigos `LSB-XXXXXX` da verificação inversa identificam a conta diretamente.

## Chaves WAHA por conta e subscrição

- Cada conta tem uma **chave WAHA própria por cada número que usa** (`POST /api/keys`, várias chaves
  por sessão). É criada quando o número é atribuído — no registo, para os números Losambo por omissão.
  Em números Losambo a chave só lê e envia; em números próprios também controla a sessão.
  A chave admin (`WAHA_API_KEY`) serve apenas para criar/apagar sessões e gerir chaves.
  As chaves das contas ficam cifradas (AES-256-GCM, `LOSAMBO_SECRET_KEY`).
- Envios, QR, código de emparelhamento, capping e controlo da sessão usam a chave da conta.
- **A API `/v1` só funciona com a subscrição ativa** (`402 subscription_inactive` caso contrário).
  Sem subscrição também ficam bloqueados os envios e a ligação de números na consola, e as
  chaves WAHA da conta são desligadas no próprio WAHA (`isActive: false`).
- O super-admin ativa/desativa a subscrição e define a data de fim em *Contas e planos*.
  A cada 5 minutos as subscrições com a data de fim ultrapassada passam a "Expirada" e as chaves são desligadas.
- O plano Interno conta sempre como subscrição ativa.

## Notas

- O WAHA deve ficar só na rede interna; a Losambo é a única porta pública.
- O teto por minuto é em memória (um processo). Para vários processos, passar para Redis.
- O WAHA chama a Losambo em `WAHA_WEBHOOK_BASE` (por omissão `host.docker.internal:4000`).
  Os webhooks ficam gravados na sessão quando o número é criado.
- `scripts/convert-design.mjs` converte um artboard `.dc.html` do Claude Design em HTML
  (usado para `index.html` e `docs.html`).
