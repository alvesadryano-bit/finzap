# 💰 FinZap — controle financeiro pelo WhatsApp

Você manda **texto, áudio ou a foto de um recibo** no WhatsApp. O app entende, classifica e registra.

```
você:  gastei 45,90 no uber
bot:   💸 Gasto registrado
       - R$ 45,90 — 🚗 Transporte
       🗓 04/09
       📊 Setembro: saídas R$ 45,90 · saldo -R$ 45,90
       Orçamento: ▰▱▱▱▱▱▱▱▱▱ 2% de R$ 2.500,00
```

Funciona igual com 🎤 áudio (“acabei de gastar trinta e cinco reais no mercado”) e com 📷 foto de nota fiscal.

---

## Rodar agora

```bash
cd finzap
npm install
npm start          # http://localhost:3000
```

Sem nenhuma configuração o app abre em **modo demo**: o painel tem um chat que simula a conversa
do WhatsApp e passa áudio/imagem pelo *mesmo* parser do backend. Útil para testar o entendimento
das mensagens antes de plugar o número de verdade.

Testes do parser:

```bash
npm test           # 13 casos: valores, datas relativas, OCR, áudio, parcelas, estornos
```

---

## Conectar seu número pelo Baileys (QR Code) — o jeito rápido

Este é o modo **padrão** quando você não configura a API da Meta.

```bash
npm start
```

O console já te dá a URL. Abra no navegador:

```
http://localhost:3000/parear        ←  é AQUI que aparece o QR Code
```

**Onde bater o QR, no celular:**

1. Abra o **WhatsApp** no celular
2. **Configurações** (Android: ⋮) → **Aparelhos conectados**
3. **Conectar um aparelho**
4. Aponte a câmera para o QR da página `/parear`

Pronto: a página vira para ✅ *Conectado como <seu nome>*.

**Como falo com ele pelo meu WhatsApp?**

O Baileys entra como se fosse o WhatsApp Web do seu número — o bot **é** o seu número. Então:

- **Padrão (recomendado):** abra o WhatsApp, procure o seu próprio nome na lista de conversas
  (o chat “Você”, que funciona como bloco de notas) e mande `gastei 20 no mercado`.
  O FinZap lê a sua mensagem e responde ali mesmo.
- **Outro contato:** se você preferir que um chip diferente fale com o bot, suba com
  `BAILEYS_OWNER_JID=5511999998888` e o bot só responde mensagens desse número.

A sessão fica salva em `.baileys-auth/` (não suba essa pasta para git — são as credenciais do
seu WhatsApp).

> ⚠️ O Baileys é cliente **não oficial**. Há risco de banimento do número. Ótimo para testar; para
> uso sério/diário, prefira a Cloud API abaixo.

---

## Ligar na API oficial da Meta (recomendado para uso sério)

É o caminho estável e permitido. Leva ~20 minutos.

**1. Criar o app**
- Acesse https://developers.facebook.com → *My Apps* → *Create App* → tipo **Business**
- Adicione o produto **WhatsApp**

**2. Pegar as credenciais** (tela *API Setup*)
- `WHATSAPP_PHONE_ID` — o *Phone number ID*
- `WHATSAPP_TOKEN` — gere um *System User token* em Business Settings → Users → System Users
  (escopos: `whatsapp_business_messaging`, `whatsapp_business_management`) e marque como **nunca expira**

**3. Expor o servidor** (a Meta precisa alcançar seu webhook por HTTPS)

```bash
cloudflared tunnel --url http://localhost:3000     # ou: ngrok http 3000
```

**4. Cadastrar o webhook** (tala *Configuration* → *Webhook*)
- Callback URL: `https://SEU-TUNEL.trycloudflare.com/api/whatsapp/webhook`
- Verify token: qualquer string, ex. `finzap123`
- Assine o campo **messages**

**5. Subir com as variáveis**

```bash
export WHATSAPP_TOKEN=EAAG...
export WHATSAPP_PHONE_ID=1234567890
export WHATSAPP_VERIFY_TOKEN=finzap123
export AI_PROVIDER=openai            # ou gemini
export OPENAI_API_KEY=sk-...
npm start
```

O badge no topo do painel muda de `modo demo` para `WhatsApp conectado`.

**6. Mandar mensagem para o seu número** — no app de teste da Meta, adicione seu celular como
destinatário e envie “gastei 20 no mercado”.

> **Limite da janela de 24h:** o bot só pode responder espontaneamente dentro de 24h da última
> mensagem do usuário. Para um uso de “mando o gasto e ele responde”, isso nunca é problema.

---

## Entender áudio e foto de recibo

A Meta envia mídia por *id*, não o arquivo. O backend baixa e transcreve com o provedor configurado:

| Provedor | Áudio | Imagem | Variáveis |
|---|---|---|---|
| OpenAI | Whisper | GPT‑4o mini | `AI_PROVIDER=openai` `OPENAI_API_KEY` |
| Gemini | Gemini 2.0 Flash | idem | `AI_PROVIDER=gemini` `GEMINI_API_KEY` |
| Mock | frases de exemplo | recibo de exemplo | *(padrão, sem chave)* |

Custo por mensagem: centavos. O Whisper da OpenAI cobra por minuto de áudio.

---

## O que o parser entende

| Você escreve | Vira |
|---|---|
| `gastei 45,90 no uber` | R$ 45,90 · saída · Transporte · hoje |
| `mercado 320 ontem` | R$ 320,00 · Mercado · ontem |
| `paguei 1.280 de aluguel` | R$ 1.280,00 · Moradia |
| `recebi 3.500 de salário` | R$ 3.500,00 · **entrada** · Salário |
| `estorno do ifood 32,90` | entrada (não vira gasto) |
| `tênis em 10x de 89,90` | R$ 899,00 · 10 parcelas |
| `segunda-feira 150 de luz` | data da segunda mais recente |
| `gasto às 18:30 de 25` | R$ 25 (hora não vira valor) |
| foto de nota fiscal | pega a linha **TOTAL**, ignora CNPJ/CPF |
| `quanto gastei esse mês?` | resumo por categoria |
| `desfaz o último` | remove o último lançamento |

Regras em `lib/parseTransaction.js` — é um arquivo só, sem dependências, fácil de ajustar ao seu
vocabulário (basta acrescentar palavras em `REGRA_CATEGORIA`).

---

## Estrutura

```
finzap/
├── server.js                 Express: painel, /api/simulate, /parear, webhook da Meta
├── lib/
│   ├── parseTransaction.js   texto -> lançamento (valor, tipo, categoria, data, parcelas)
│   ├── whatsappBaileys.js    QR Code (não oficial): sessão, eco, chat próprio, mídia
│   ├── whatsapp.js           Cloud API oficial: baixar mídia, responder, verificar webhook
│   ├── ai.js                 Whisper/Gemini plugáveis + mock
│   └── store.js              memória; opcional FINZAP_DB=./dados.json
├── public/
│   ├── index.html            chat + dashboard (instalável no celular, PWA)
│   └── parear.html           página do QR Code
└── test/                     23 testes (parser + normalização Baileys/eco)
```

**Endpoints**

| Método | Rota | Uso |
|---|---|---|
| GET | `/parear` | página do QR Code (Baileys) |
| GET | `/api/parear` · POST `/api/parear/reiniciar` `/api/parear/sair` `/api/parear/teste` | sessão Baileys |
| GET | `/api/whatsapp/webhook` | verificação `hub.challenge` |
| POST | `/api/whatsapp/webhook` | mensagens recebidas (responde 200 na hora) |
| POST | `/api/simulate` | chat do painel (`texto` e/ou `arquivo`) |
| GET | `/api/transacoes` `/api/resumo` `/api/status` | dados |
| POST | `/api/orcamento` · DELETE `/api/transacoes/:id` | ajustes |

Variáveis: `WHATSAPP_MODE=baileys|cloud|demo` (padrão: `baileys` sem credenciais Meta, `cloud` com elas),
`BAILEYS_OWNER_JID=5511...` (opcional), `AI_PROVIDER=openai|gemini` + chave, `FINZAP_DB=./dados.json`.

---

## Instalar no celular

O painel é um PWA (`public/manifest.webmanifest`). Abra a URL no Chrome do Android ou Safari do iOS
e use *Adicionar à tela inicial*. Para gravar áudio o navegador exige HTTPS — o túnel do cloudflared
já resolve isso.

---

## Colocar online: Vercel + Supabase (a verdade sobre cada peça)

Nem tudo cabe na Vercel. A Vercel é **serverless** (funções que nascem e morrem a cada request),
e o Baileys precisa de um **processo vivo com WebSocket permanente**. Então a divisão certa é:

| Peça | Onde roda | Por quê |
|---|---|---|
| Painel web (PWA) | ✅ Vercel | HTML/JS estático |
| API `/api/simulate`, consultas, painel | ✅ Vercel | funções serverless servem request/response |
| Webhook **Cloud API (Meta)** | ✅ Vercel | a Meta chama e espera resposta — cabe em serverless |
| **Baileys (QR / WebSocket)** | ❌ Vercel · ✅ Railway/Render/Fly.io/VPS | precisa de processo permanente + sessão em disco |
| Banco de dados | ✅ Supabase | Postgres gerenciado, isola por usuário (RLS) |

**Recomendado para múltiplos usuários:**
1. Rode `supabase/schema.sql` no SQL Editor do seu Supabase (cria `lancamentos` + `perfis` com RLS).
2. Suba o backend num serviço com processo persistente (Railway/Render) com:
   `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `WHATSAPP_MODE=baileys`.
   Cada usuário escaneia o próprio QR (multi-sessão) e os dados ficam isolados por número.
3. Opcional: sirva o painel pela Vercel apontando para esse backend.

Sem `SUPABASE_URL` o app usa memória/arquivo — nada quebra. O write-through grava no Postgres
em segundo plano e o boot recarrega tudo com `store.carregar()`.

> Para o painel web com **vários usuários logados**, falta a camada de login (Supabase Auth) —
> o isolamento no lado do WhatsApp já existe (`autor`), mas o navegador ainda não autentica.
> É o próximo passo natural.

---

## Próximo passo (produção)

- **Login do painel** com Supabase Auth para cada usuário ver só os seus dados no navegador.
- **Multi-sessão Baileys**: uma sessão por usuário, com o auth state gravado no Supabase
  (hoje a sessão fica em `.baileys-auth/` no disco do servidor).
- **Custo**: na Cloud API, mensagens *service* são pagas por conversa; respostas na janela de 24h
  não geram custo extra de template. Baileys não custa por mensagem, mas tem risco de banimento.

