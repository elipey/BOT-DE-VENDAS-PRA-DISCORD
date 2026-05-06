import { randomUUID } from 'node:crypto';
import { config } from './config.js';

const API = 'https://api.mercadopago.com';

function ensureMpToken() {
  const token = String(config.mercadoPagoAccessToken || '').trim();
  if (!token || token.toLowerCase() === 'teste' || token.includes('COLOQUE')) {
    throw new Error('MERCADO_PAGO_SEM_TOKEN: configure o Access Token do Mercado Pago no /configurar ou no .env para gerar Pix real.');
  }
  return token;
}

async function mpFetch(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${ensureMpToken()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers || {})
    }
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.message || data?.error || JSON.stringify(data);
    if (response.status === 401 && message.includes('live credentials')) {
      throw new Error('MERCADO_PAGO_ERRO: 401 - Sua conta não tem permissão para usar Pix Real. Use um Token de Teste (TEST-) ou complete o Checklist de Homologação no painel do MP.');
    }
    throw new Error(`MERCADO_PAGO_ERRO: ${response.status} - ${message}`);
  }
  return data;
}

export async function createPixPayment({ amount, description, email, userId, planId, orderId }) {
  const body = {
    transaction_amount: Number(amount),
    description,
    payment_method_id: 'pix',
    payer: { 
      email,
      first_name: 'Cliente',
      last_name: 'Discord'
    },
    external_reference: `${orderId}:${userId}:${planId}`
  };

  // Mercado Pago rejeita 'localhost' ou IPs locais no notification_url.
  // O bot possui um sistema de checagem manual (polling) a cada minuto,
  // então ignoramos o webhook se a URL for local para evitar erros na geração do Pix.
  const isLocal = config.webhookUrl?.includes('localhost') || config.webhookUrl?.includes('127.0.0.1');
  if (config.webhookUrl && config.webhookUrl.startsWith('http') && !isLocal) {
    body.notification_url = `${config.webhookUrl.replace(/\/$/, '')}/webhook/mercadopago`;
  }

  return mpFetch('/v1/payments', {
    method: 'POST',
    headers: {
      'X-Idempotency-Key': randomUUID()
    },
    body: JSON.stringify(body)
  });
}

export async function getPayment(paymentId) {
  return mpFetch(`/v1/payments/${paymentId}`, { method: 'GET' });
}
