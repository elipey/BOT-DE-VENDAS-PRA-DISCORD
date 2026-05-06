import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { config, plans } from './config.js';
import {
  findOrderByPaymentId,
  updateOrder,
  upsertSubscription,
  deactivateSubscription,
  updateSubscription,
  getActiveSubscriptions
} from './storage.js';
import { getPayment } from './mercadopago.js';

export function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + Number(days));
  return d;
}

export function formatMoney(value) {
  return Number(value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function getPlanRoleId(plan) {
  return plan?.roleId || config.vipRoleId || null;
}

export async function log(client, payload) {
  if (!config.logChannelId) return;
  const channel = await client.channels.fetch(config.logChannelId).catch(() => null);
  if (!channel) return;
  await channel.send(payload).catch(() => null);
}

export async function getGuild(client, fallbackGuildId) {
  const guildId = fallbackGuildId || config.guildId || client.guilds.cache.first()?.id;
  if (!guildId) return null;
  return client.guilds.fetch(guildId).catch(() => null);
}

export async function givePlanRole(client, { guildId, userId, planId, reason = 'Assinatura VIP ativada' }) {
  const plan = plans[planId];
  if (!plan) return { ok: false, reason: 'Plano não encontrado.' };

  const roleId = getPlanRoleId(plan);
  if (!roleId) return { ok: false, reason: 'Este plano não tem cargo configurado.' };

  const guild = await getGuild(client, guildId);
  if (!guild) return { ok: false, reason: 'Servidor não encontrado. Configure o servidor no /configurar.' };

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return { ok: false, reason: 'Membro não encontrado no servidor.' };

  await member.roles.add(roleId, reason);
  return { ok: true, guild, member, plan, roleId };
}

export async function approvePaymentAndGiveRole(client, paymentId) {
  const payment = await getPayment(paymentId);
  const order = await findOrderByPaymentId(paymentId);
  if (!order) return { ok: false, reason: 'Pedido não encontrado no banco local.' };

  if (payment.status !== 'approved') {
    await updateOrder(order.id, { status: payment.status, paymentStatusDetail: payment.status_detail });
    return { ok: false, reason: `Pagamento ainda não aprovado: ${payment.status}` };
  }

  if (order.status === 'approved') return { ok: true, reason: 'Já aprovado.' };

  const plan = plans[order.planId];
  const roleResult = await givePlanRole(client, {
    guildId: order.guildId,
    userId: order.userId,
    planId: order.planId,
    reason: `Pagamento aprovado: ${paymentId}`
  });

  if (!roleResult.ok) return roleResult;

  const now = new Date();
  const previousExpires = order.previousExpiresAt ? new Date(order.previousExpiresAt) : null;
  const baseDate = previousExpires && previousExpires > now ? previousExpires : now;
  const expiresAt = addDays(baseDate, plan.durationDays);

  await updateOrder(order.id, {
    status: 'approved',
    approvedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    paymentStatusDetail: payment.status_detail
  });

  await upsertSubscription({
    userId: order.userId,
    guildId: order.guildId || roleResult.guild.id,
    planId: order.planId,
    active: true,
    expiresAt: expiresAt.toISOString(),
    lastPaymentId: String(paymentId),
    renewalReminderSentAt: null
  });

  const logEmbed = new EmbedBuilder()
    .setTitle('✅ Venda aprovada')
    .addFields(
      { name: 'Cliente', value: `<@${order.userId}>`, inline: true },
      { name: 'Plano', value: plan.name, inline: true },
      { name: 'Valor', value: `${formatMoney(order.amount)}${order.couponCode ? ` (cupom ${order.couponCode})` : ''}`, inline: true },
      { name: 'Cargo entregue', value: `<@&${roleResult.roleId}>`, inline: true },
      { name: 'Vence em', value: `<t:${Math.floor(expiresAt.getTime() / 1000)}:F>`, inline: true },
      { name: 'Pagamento', value: String(paymentId), inline: true }
    )
    .setColor(0x2ecc71)
    .setTimestamp();

  await log(client, { embeds: [logEmbed] });

  await roleResult.member.send({
    embeds: [new EmbedBuilder()
      .setTitle('✅ Assinatura ativada')
      .setDescription(`${plan.deliveryMessage || `Seu plano **${plan.name}** foi aprovado e seu cargo VIP foi liberado.`}`)
      .addFields({ name: 'Vence em', value: `<t:${Math.floor(expiresAt.getTime() / 1000)}:F>` })
      .setColor(0x2ecc71)]
  }).catch(() => null);

  return { ok: true, reason: 'Aprovado e cargo entregue.' };
}

export async function checkPendingPayments(client) {
  const { getPendingOrders } = await import('./storage.js');
  const PAYMENT_EXPIRATION_MINUTES = 30; // Define o tempo de expiração para 30 minutos
  const pending = await getPendingOrders();
  const now = new Date();

  for (const order of pending) {
    try {
      const orderCreatedAt = new Date(order.createdAt);
      const minutesPassed = (now.getTime() - orderCreatedAt.getTime()) / (1000 * 60);

      if (minutesPassed >= PAYMENT_EXPIRATION_MINUTES) {
        // Pedido expirou
        await updateOrder(order.id, { status: 'canceled', updatedAt: now.toISOString(), paymentStatusDetail: 'expired_by_timeout' });
        await log(client, `⏰ Pedido expirado automaticamente: <@${order.userId}> (ID: \`${order.id}\`) - Plano: **${plans[order.planId]?.name || order.planId}**.`);
        continue; // Pula para o próximo pedido, este já foi cancelado
      }

      await approvePaymentAndGiveRole(client, order.paymentId);
    } catch (error) {
      console.error('Erro ao checar pagamento pendente:', error.message);
      if (String(error.message).startsWith('MERCADO_PAGO_SEM_TOKEN')) return;
    }
  }
}

export async function removeExpiredRoles(client) {
  const active = await getActiveSubscriptions();
  const now = new Date();

  for (const sub of active) {
    if (new Date(sub.expiresAt) > now) continue;

    const plan = plans[sub.planId];
    const roleId = getPlanRoleId(plan);
    const guild = await getGuild(client, sub.guildId);
    if (!guild || !roleId) continue;

    const member = await guild.members.fetch(sub.userId).catch(() => null);
    if (member) {
      await member.roles.remove(roleId, 'Assinatura vencida').catch(() => null);
      await member.send('⚠️ Sua assinatura VIP venceu e o cargo foi removido. Use o painel de compra para renovar.').catch(() => null);
    }

    await deactivateSubscription(sub.userId);

    const logEmbed = new EmbedBuilder()
      .setTitle('⏰ Assinatura vencida')
      .addFields(
        { name: 'Cliente', value: `<@${sub.userId}>`, inline: true },
        { name: 'Plano', value: plan?.name || sub.planId, inline: true },
        { name: 'Cargo removido', value: `<@&${roleId}>`, inline: true }
      )
      .setColor(0xe74c3c)
      .setTimestamp();

    await log(client, { embeds: [logEmbed] });
  }
}

export async function sendExpirationWarnings(client) {
  const active = await getActiveSubscriptions();
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;

  for (const sub of active) {
    if (sub.renewalReminderSentAt) continue;

    const expiresAt = new Date(sub.expiresAt).getTime();
    const timeLeft = expiresAt - now;
    if (timeLeft <= 0 || timeLeft > oneDay) continue;

    const guild = await getGuild(client, sub.guildId);
    const member = guild ? await guild.members.fetch(sub.userId).catch(() => null) : null;
    const plan = plans[sub.planId];

    if (member) {
      await member.send(`⚠️ Seu **${plan?.name || 'VIP'}** vence em menos de 24 horas. Use o painel de vendas para renovar.`).catch(() => null);
    }

    await updateSubscription(sub.userId, { renewalReminderSentAt: new Date().toISOString() });
    await log(client, `🔔 Aviso de vencimento enviado para <@${sub.userId}>.`);
  }
}

export function qrAttachmentFromBase64(base64) {
  if (!base64) return null;
  return new AttachmentBuilder(Buffer.from(base64, 'base64'), { name: 'pix.png' });
}
