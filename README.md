# BOT DE VENDAS DISCORD

Bot open source de vendas para Discord com Pix Mercado Pago, cargos automáticos por plano, assinaturas, saldo, retiradas, cupons, relatórios e painel de configuração.

## Aviso de segurança

Este repositório não deve conter tokens reais. Nunca publique `.env`, `data/db.json` ou arquivos dentro de `data/backups/`.

Se você já publicou algum token sem querer, gere um novo token no Discord Developer Portal e no Mercado Pago, porque o token antigo deve ser considerado vazado.

## Requisitos

- Node.js 22.12.0 ou superior
- Uma aplicação/bot no Discord Developer Portal
- Uma conta/app do Mercado Pago com Access Token

## Instalação

```bash
npm install
```

Copie o arquivo de exemplo:

```bash
cp .env.example .env
```

No Windows PowerShell, pode usar:

```powershell
copy .env.example .env
notepad .env
```

Preencha as variáveis no `.env`:

```env
DISCORD_TOKEN=COLOQUE_SEU_TOKEN_DO_BOT_AQUI
CLIENT_ID=ID_DA_APPLICATION_DO_BOT
GUILD_ID=ID_DO_SEU_SERVIDOR
PORT=3000
WEBHOOK_URL=http://localhost:3000
MERCADO_PAGO_ACCESS_TOKEN=COLOQUE_SEU_ACCESS_TOKEN_AQUI
MAINTENANCE=false
```

## Registrar comandos slash

```bash
npm run register
```

## Iniciar o bot

```bash
npm start
```

## Desenvolvimento

```bash
npm run dev
```

## Comandos principais

- `/configurar` — abre o painel de configuração do bot.
- `/painel` — envia o painel de vendas.
- `/testar_entrega` — testa entrega de cargo sem Pix real.
- `/saldo` — mostra total vendido, retirado e saldo local.
- `/retiradovalor` — registra uma retirada manual.
- `/assinaturas` — lista assinaturas ativas.
- `/cliente` — consulta histórico de um usuário.
- `/criarcupom` — cria cupom de desconto.
- `/removercupom` — remove cupom.
- `/cupons` — lista cupons.
- `/relatorio` — gera TXT ou CSV.
- `/manutencao` — pausa/libera novas compras.
- `/mensagemplano` — define mensagem personalizada para quando um plano for aprovado.
- `/cancelarvip` — remove VIP de um usuário.

## Observações importantes

- O bot precisa ficar ligado para checar pagamentos pendentes.
- Se estiver hospedado localmente, `localhost` não é acessível pelo Mercado Pago externamente. Mesmo assim, o bot checa pagamentos pendentes periodicamente.
- O cargo do bot precisa estar acima dos cargos VIP no Discord.
- Use `npm run register` sempre que adicionar ou alterar comandos slash.

## Arquivos que não vão para o GitHub

Estes arquivos estão no `.gitignore` por segurança:

- `.env`
- `node_modules/`
- `data/db.json`
- `data/backups/*.json`

## Licença

Defina uma licença antes de publicar, por exemplo MIT.
