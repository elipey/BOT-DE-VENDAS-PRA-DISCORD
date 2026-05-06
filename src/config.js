import 'dotenv/config';
import fs from 'fs';
import path from 'path';

export const config = {
  discordToken: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  guildId: process.env.GUILD_ID,
  vipRoleId: process.env.VIP_ROLE_ID,
  adminRoleId: process.env.ADMIN_ROLE_ID,
  logChannelId: process.env.LOG_CHANNEL_ID,
  salesChannelId: process.env.SALES_CHANNEL_ID,
  mercadoPagoAccessToken: process.env.MERCADO_PAGO_ACCESS_TOKEN,
  webhookUrl: process.env.WEBHOOK_URL,
  port: Number(process.env.PORT || 3000),
  maintenance: process.env.MAINTENANCE === 'true',
};

export const plans = {};

// Carrega configurações persistentes do banco de dados de forma síncrona para inicialização
try {
  const dbPath = path.resolve('data', 'db.json');
  if (fs.existsSync(dbPath)) {
    const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

    if (db.settings) {
      Object.assign(config, db.settings);
    }

    if (db.plans) {
      Object.assign(plans, db.plans);
    }
  }
} catch (error) {
  console.error('Erro ao carregar configurações do banco:', error.message);
}

export function validateConfig() {
  const required = [
    'discordToken'
  ];

  const missing = required.filter((key) => !config[key]);

  if (missing.length > 0) {
    throw new Error(`Faltam variáveis no .env: ${missing.join(', ')}`);
  }
}
