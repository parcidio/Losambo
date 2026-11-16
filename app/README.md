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

## Produção no Coolify (Losambo + WAHA + PostgreSQL)

`docker-compose.yml` põe tudo numa só stack, com o PostgreSQL local (sem Supabase):

| Serviço | Para quê | Domínio |
|---|---|---|
| `losambo` | consola, API `/v1`, webhooks do WAHA | sim, ex.: `https://message.beeznoo.ao` → porta 4000 |
| `waha` | motor WhatsApp (GOWS), sessões guardadas no PostgreSQL | não (só rede interna) |
| `postgres` | base `losambo` + bases `waha_…` das sessões | não |

1. **New Resource → Docker Compose** (a partir do repositório GitHub, ramo `main`).
2. **Base Directory**: `/app` · **Docker Compose Location**: `/docker-compose.yml`.
   (O `docker-compose.dev.yml` é só para desenvolvimento e tem apenas o PostgreSQL.)
3. Em **Environment Variables**:

   | Variável | Valor |
   |---|---|
   | `POSTGRES_PASSWORD` | aleatório, **só letras e números** |
   | `WAHA_DB_PASSWORD` | aleatório, **só letras e números** (utilizador `waha`, sem acesso à base da Losambo) |
   | `WAHA_API_KEY` | aleatório (chave admin do WAHA) |
   | `WAHA_WEBHOOK_TOKEN` | aleatório |
   | `LOSAMBO_SECRET_KEY` | aleatório, longo (cifra as chaves WAHA das contas — não mude depois) |
   | `PUBLIC_URL` | `https://message.beeznoo.ao` (sem `/` no fim) |
   | `RESEND_API_KEY` | chave do Resend (envio dos e-mails de confirmação) |
   | `EMAIL_FROM` | remetente num domínio verificado no Resend, ex.: `Losambo <no-reply@message.beeznoo.ao>` |
   | `INTERNAL_EMAIL_DOMAINS` | domínios da equipa, ex.: `beeznoo.ao` — contas com e-mail confirmado destes domínios ficam Interno |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | opcional |
   | `WHATSAPP_AUTH_SESSION` | opcional (número Losambo que envia os códigos de entrada) |

4. No serviço **losambo**, defina o domínio `https://message.beeznoo.ao:4000`
   (o `:4000` diz ao Coolify a porta interna; o site fica em `https://message.beeznoo.ao`). Deploy.

A primeira conta criada fica super-admin — crie a sua logo após o primeiro deploy.

**Persistência:** contas, sessões de entrada, mensagens e as sessões WhatsApp do WAHA (ligações, chaves) ficam no
PostgreSQL, no volume `postgres-data`; os ficheiros do WAHA no volume `waha-media`. Sobrevivem a reinícios,
redeploys e atualizações. Depois de um reinício o WAHA volta a ligar sozinho todas as sessões guardadas
(`WHATSAPP_RESTART_ALL_SESSIONS`, `WAHA_WORKER_ID` fixo). Não mude `LOSAMBO_SECRET_KEY` depois do primeiro deploy.

**Outras variáveis** (todas com valores por omissão no compose; mude no Coolify se precisar):

| Variável | Omissão | Para quê |
|---|---|---|
| `PLAN_FREE_MONTHLY_MESSAGES` | `100` | mensagens/mês no plano Grátis |
| `PLAN_STARTUP_MONTHLY_MESSAGES` | `5000` | mensagens/mês no plano Startup |
| `PLAN_BUSINESS_MONTHLY_MESSAGES` | `ilimitado` | mensagens/mês no plano Negócio |
| `PLAN_*_ALLOW_OWN_NUMBERS` | Grátis/Startup `false`, Negócio `true` | pode ligar números próprios |
| `PLAN_*_MAX_OWN_NUMBERS` | Grátis/Startup `0`, Negócio `ilimitado` | máximo de números próprios |
| `PLAN_*_LABEL` | Grátis, Startup, Negócio, Interno | nome do plano na consola |
| `OTP_TTL_SECONDS` / `OTP_MAX_ATTEMPTS` | `300` / `5` | validade e tentativas dos códigos |
| `SESSION_DAYS` | `14` | duração da sessão na consola |
| `WHATSAPP_AUTH_RESEND_SECONDS` | `60` | espera entre códigos de entrada |
| `WHATSAPP_AUTH_MAX_PER_PHONE_HOUR` / `_PER_IP_HOUR` | `5` / `20` | limites dos códigos de entrada |
| `DATABASE_POOL_MAX` | `10` | ligações à base de dados |
| `WAHA_LOG_LEVEL` / `TZ` | `info` / `Africa/Luanda` | registos e fuso horário do WAHA |

O plano Interno é sempre sem limites.

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
com o Google ganha uma conta (com um número Losambo livre); se já existir uma conta com o mesmo
e-mail verificado, o Google fica ligado a essa conta.

## Confirmação de e-mail, contas internas e programa Grátis

- **Todos os e-mails são confirmados.** Ao criar conta com e-mail, a Losambo envia um link (modelo React Email em
  `src/emails/verify-email.tsx`, enviado pelo Resend). Sem confirmar não se entra. Uma inscrição nunca confirmada
  não reserva o e-mail (quem confirmar a seguir fica com ele) e é apagada ao fim de 7 dias.
  Contas Google já chegam confirmadas; contas WhatsApp não têm e-mail. Pré-visualizar o modelo: `npm run email`.
- **Plano Interno por domínio:** quem confirmar um e-mail de um domínio em `INTERNAL_EMAIL_DOMAINS` fica com a conta
  no plano Interno (também ao entrar, se o domínio for acrescentado depois).
- **Programa Grátis:** os utilizadores de contas Interno veem *Programa Grátis* na consola e escolhem que contas Grátis
  têm a API e os envios ativos (com data de fim opcional). Não mexem em planos pagos nem Interno — isso é do super-admin.

## Entrar com WhatsApp

- **Entrar** (`/entrar#whatsapp`): o número tem de pertencer a uma conta e é confirmado no WhatsApp
  (`GET /api/contacts/check-exists`); depois recebe um código de 6 dígitos por WhatsApp.
- **Criar conta** (`/entrar#criar-whatsapp`): nome, empresa e número → check-exists → código por WhatsApp →
  a conta só é criada depois de o código ser confirmado.
- Os códigos saem de um número Losambo ligado (`WORKING`): o de `WHATSAPP_AUTH_SESSION`, ou o primeiro
  número Losambo sem conta (os números das contas são só delas). Sem nenhum ligado, a opção responde
  "indisponível" e mantém-se a entrada por e-mail.
- Limites: 1 código por minuto e 5 por hora por número, 20 por hora por IP; 5 tentativas por código; expira em 5 minutos.
- API da consola: `POST /console-api/auth/whatsapp/start` e `POST /console-api/auth/whatsapp/verify`.

## Números: Losambo vs. próprios

- **Números Losambo** (sessões `lsb_NN`): ligados pelo super-admin em *Números Losambo*. **Cada número
  pertence a uma só conta** (índice único em `number_assignments.number_id`). Grátis e Startup **só** usam estes números.
  Cada conta nova recebe automaticamente **um número livre** marcado "Para contas novas"; sem números livres,
  a conta fica sem número até o admin lhe atribuir um. Ligue números de reserva para não faltarem.
- **Números próprios** (sessões `<conta>-NN`, ligados pelo cliente por QR/código): só no plano
  **Negócio** (e Interno). Num downgrade, as chaves WAHA dos números próprios são desligadas.
- As contas não controlam números Losambo (QR, parar, reiniciar, apagar, ritmo → `403 platform_number`).
- As respostas recebidas num número vão sempre para a conta dona desse número — nenhuma outra conta
  as pode desviar.

## Chaves WAHA por conta e subscrição

- Cada conta tem uma **chave WAHA própria por cada número que usa** (`POST /api/keys`, várias chaves
  por sessão). É criada quando o número é atribuído — no registo, para o número Losambo livre.
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
