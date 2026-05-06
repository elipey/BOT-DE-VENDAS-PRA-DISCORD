import 'dotenv/config';
import express from 'express';
import { nanoid } from 'nanoid';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits
} from 'discord.js';
import { config, plans, validateConfig } from './config.js';
import {
  addOrder,
  addWithdrawal,
  buildReportData,
  deleteCoupon,
  getAllSubscriptions,
  getCoupons,
  getFinancialSummary,
  getSubscription,
  getUserOrders,
  getPendingOrderByUser,
  deactivateSubscription,
  updateSettings,
  updatePlan,
  deletePlan,
  upsertCoupon,
  useCoupon,
  upsertSubscription,
  updateOrder
} from './storage.js';
import { createPixPayment } from './mercadopago.js';
import {
  addDays,
  approvePaymentAndGiveRole,
  checkPendingPayments,
  formatMoney,
  getPlanRoleId,
  givePlanRole,
  log,
  qrAttachmentFromBase64,
  removeExpiredRoles,
  sendExpirationWarnings
} from './discord-actions.js';

validateConfig();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

function durationText(days) {
  return Number(days) >= 36500 ? 'Vitalício' : `${days} dias`;
}

function getPlansArray() {
  return Object.values(plans).filter(Boolean);
}

function buildPanel() {
  const planList = getPlansArray();
  const embed = new EmbedBuilder()
    .setTitle('💎 Assinatura VIP')
    .setDescription(config.maintenance ? '🛠️ **Vendas em manutenção.** Aguarde a administração liberar novas compras.' : 'Escolha um plano, pague por Pix e receba o cargo automaticamente após a aprovação.')
    .setColor(0x5865f2);

  if (!planList.length) {
    embed.addFields({ name: 'Nenhum plano configurado', value: 'Use `/configurar` para criar um plano.' });
    return { embeds: [embed], components: [] };
  }

  embed.addFields(planList.slice(0, 25).map((plan) => ({
    name: plan.name,
    value: `${formatMoney(plan.price)} • ${durationText(plan.durationDays)}${plan.description ? `\n${plan.description}` : ''}${getPlanRoleId(plan) ? `\nCargo: <@&${getPlanRoleId(plan)}>` : ''}`,
    inline: true
  })));

  const menu = new StringSelectMenuBuilder()
    .setCustomId('buy_plan')
    .setPlaceholder('Selecione um plano')
    .addOptions(planList.slice(0, 25).map((plan) => ({
      label: plan.name.slice(0, 100),
      description: `${formatMoney(plan.price)} - ${plan.description || durationText(plan.durationDays)}`.slice(0, 100),
      value: plan.id
    })));

  return { embeds: [embed], components: config.maintenance ? [] : [new ActionRowBuilder().addComponents(menu)] };
}

function buildFinancialEmbed(summary) {
  const recentWithdrawals = summary.withdrawals.slice(0, 5);
  const recentText = recentWithdrawals.length
    ? recentWithdrawals.map((w) => `• ${formatMoney(w.amount)} por <@${w.adminId}> em <t:${Math.floor(new Date(w.createdAt).getTime() / 1000)}:f> — ${w.reason || 'Sem motivo'}`).join('\n')
    : 'Nenhuma retirada registrada.';

  return new EmbedBuilder()
    .setTitle('💰 Saldo do Bot')
    .setDescription('Resumo financeiro calculado pelas vendas aprovadas salvas no banco local menos as retiradas registradas.')
    .addFields(
      { name: 'Saldo disponível', value: `**${formatMoney(summary.availableBalance)}**`, inline: true },
      { name: 'Total vendido', value: formatMoney(summary.grossSales), inline: true },
      { name: 'Total retirado', value: formatMoney(summary.totalWithdrawn), inline: true },
      { name: 'Vendas aprovadas', value: String(summary.approvedCount), inline: true },
      { name: 'Pendentes', value: `${summary.pendingCount} pedido(s) • ${formatMoney(summary.pendingSales)}`, inline: true },
      { name: 'Últimas retiradas', value: recentText.slice(0, 1024) }
    )
    .setColor(0x2ecc71)
    .setTimestamp();
}

function buildConfigEmbed() {
  const planList = getPlansArray();
  const plansSummary = planList.map((p) =>
    `🔹 **${p.name}**: ${getPlanRoleId(p) ? `<@&${getPlanRoleId(p)}>` : '`sem cargo`'} • ${formatMoney(p.price)} • ${durationText(p.durationDays)} • \`${p.id}\``
  ).join('\n') || 'Nenhum plano criado.';

  return new EmbedBuilder()
    .setTitle('⚙️ Configurações do Bot')
    .setDescription('Configure vendas, cargos, canais, planos e testes sem mexer no código.')
    .addFields(
      { name: 'Servidor', value: `\`${config.guildId || 'Não definido'}\``, inline: true },
      { name: 'Cargo VIP padrão', value: config.vipRoleId ? `<@&${config.vipRoleId}>` : 'Não definido', inline: true },
      { name: 'Canal de vendas', value: config.salesChannelId ? `<#${config.salesChannelId}>` : 'Não definido', inline: true },
      { name: 'Canal de logs', value: config.logChannelId ? `<#${config.logChannelId}>` : 'Não definido', inline: true },
      { name: 'Webhook URL', value: `\`${config.webhookUrl || 'Não definido'}\`` },
      { name: 'Modo manutenção', value: config.maintenance ? '🛠️ Ativado' : '✅ Desativado', inline: true },
      { name: 'Planos', value: plansSummary.slice(0, 1024) }
    )
    .setColor(0x9b59b6)
    .setTimestamp();
}

function configComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('open_config_modal').setLabel('Config técnica').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('config_roles_ui').setLabel('Cargos').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('config_channels_ui').setLabel('Canais').setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('manage_plans_ui').setLabel('Editar plano').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('create_plan_ui').setLabel('Criar plano').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('remove_plan_ui').setLabel('Remover plano').setStyle(ButtonStyle.Danger)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('send_sales_panel').setLabel('Enviar painel').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('test_delivery_ui').setLabel('Testar entrega').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('test_log_action').setLabel('Testar log').setStyle(ButtonStyle.Secondary)
    )
  ];
}

function planSelect(customId, placeholder = 'Escolha um plano') {
  const planList = getPlansArray();
  if (!planList.length) return null;
  return new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .addOptions(planList.slice(0, 25).map((p) => ({
      label: p.name.slice(0, 100),
      description: `${formatMoney(p.price)} • ${durationText(p.durationDays)}`.slice(0, 100),
      value: p.id
    })));
}

async function ensureGuildSetting(interaction) {
  if (!config.guildId && interaction.guildId) {
    config.guildId = interaction.guildId;
    await updateSettings({ guildId: interaction.guildId });
  }
}

async function replyNoPlans(interaction) {
  await interaction.reply({ content: '❌ Nenhum plano existe ainda. Use `/configurar` > **Criar plano**.', ephemeral: true });
}

function isAdminInteraction(interaction) {
  if (!interaction.inGuild?.()) return false;
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) || interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  if (config.adminRoleId && interaction.member?.roles?.cache?.has?.(config.adminRoleId)) return true;
  return false;
}

async function requireAdmin(interaction) {
  if (isAdminInteraction(interaction)) return true;
  const payload = { content: '❌ Você não tem permissão para usar esse comando.', ephemeral: true };
  if (interaction.deferred || interaction.replied) await interaction.editReply(payload).catch(() => null);
  else await interaction.reply(payload).catch(() => null);
  return false;
}

function csvEscape(value) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

function buildCsvReport(data) {
  const lines = [];
  lines.push('TIPO,ID,USUARIO,PLANO,VALOR,STATUS,CRIADO_EM,VENCE_EM,EXTRA');
  for (const order of data.orders) {
    lines.push([
      'venda',
      order.id,
      order.userId,
      order.planId,
      order.amount,
      order.status,
      order.createdAt,
      order.expiresAt || '',
      order.couponCode ? `cupom=${order.couponCode};desconto=${order.discountAmount || 0}` : ''
    ].map(csvEscape).join(','));
  }
  for (const sub of data.subscriptions) {
    lines.push(['assinatura', sub.lastPaymentId || '', sub.userId, sub.planId, '', sub.active ? 'ativa' : 'inativa', sub.createdAt || '', sub.expiresAt || '', ''].map(csvEscape).join(','));
  }
  for (const withdrawal of data.withdrawals) {
    lines.push(['retirada', withdrawal.id, withdrawal.adminId, '', withdrawal.amount, 'registrada', withdrawal.createdAt, '', withdrawal.reason || ''].map(csvEscape).join(','));
  }
  return lines.join('\n');
}

function buildTxtReport(data) {
  const approved = data.orders.filter((o) => o.status === 'approved');
  const gross = approved.reduce((sum, o) => sum + Number(o.amount || 0), 0);
  const withdrawn = data.withdrawals.reduce((sum, w) => sum + Number(w.amount || 0), 0);
  return [
    'RELATÓRIO BOT DE VENDAS DISCORD',
    `Gerado em: ${new Date().toLocaleString('pt-BR')}`,
    '',
    `Total vendido: ${formatMoney(gross)}`,
    `Total retirado: ${formatMoney(withdrawn)}`,
    `Saldo local: ${formatMoney(gross - withdrawn)}`,
    `Vendas aprovadas: ${approved.length}`,
    `Assinaturas cadastradas: ${data.subscriptions.length}`,
    `Cupons cadastrados: ${Object.keys(data.coupons).length}`,
    '',
    'Últimas vendas:',
    ...data.orders.slice(-20).reverse().map((o) => `- ${o.status} | ${o.userId} | ${o.planId} | ${formatMoney(o.amount || 0)} | ${o.createdAt || ''}`),
    '',
    'Últimas retiradas:',
    ...data.withdrawals.slice(-20).reverse().map((w) => `- ${formatMoney(w.amount)} | ${w.adminId || ''} | ${w.reason || ''} | ${w.createdAt || ''}`)
  ].join('\n');
}

function subscriptionLine(sub) {
  const plan = plans[sub.planId];
  const expires = sub.expiresAt ? `<t:${Math.floor(new Date(sub.expiresAt).getTime() / 1000)}:f>` : 'sem data';
  return `• <@${sub.userId}> — **${plan?.name || sub.planId || 'Plano removido'}** — ${sub.active ? '✅ ativa' : '❌ inativa'} — vence ${expires}`;
}

function applyCouponPrice(price, coupon) {
  const discountPercent = Math.max(0, Math.min(100, Number(coupon.discountPercent || 0)));
  const discountAmount = Number((Number(price) * (discountPercent / 100)).toFixed(2));
  const finalAmount = Math.max(0.01, Number((Number(price) - discountAmount).toFixed(2)));
  return { discountPercent, discountAmount, finalAmount };
}

client.once('ready', async () => {
  console.log(`✅ Bot online como ${client.user.tag}`);

  if (!config.guildId && client.guilds.cache.first()?.id) {
    config.guildId = client.guilds.cache.first().id;
    await updateSettings({ guildId: config.guildId });
  }

  await log(client, '🟢 Bot de vendas iniciado.');
  setInterval(() => checkPendingPayments(client), 60_000);
  setInterval(() => removeExpiredRoles(client), 5 * 60_000);
  setInterval(() => sendExpirationWarnings(client), 60 * 60_000);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.inGuild?.()) await ensureGuildSetting(interaction);

    if (interaction.isChatInputCommand()) {
      const adminCommands = ['painel', 'saldo', 'retiradovalor', 'cancelarvip', 'configurar', 'testar_entrega', 'assinaturas', 'cliente', 'criarcupom', 'removercupom', 'cupons', 'relatorio', 'manutencao', 'mensagemplano'];
      if (adminCommands.includes(interaction.commandName) && !(await requireAdmin(interaction))) return;
      if (interaction.commandName === 'painel') {
        await interaction.reply({ content: '✅ Painel enviado.', ephemeral: true });
        await interaction.channel.send(buildPanel());
        return;
      }

      if (interaction.commandName === 'status') {
        const sub = await getSubscription(interaction.user.id);
        if (!sub || !sub.active) {
          await interaction.reply({ content: 'Você não possui assinatura VIP ativa.', ephemeral: true });
          return;
        }
        const expires = new Date(sub.expiresAt);
        await interaction.reply({
          content: `✅ Sua assinatura está ativa e vence em <t:${Math.floor(expires.getTime() / 1000)}:F>.`,
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === 'saldo') {
        const summary = await getFinancialSummary();
        await interaction.reply({ embeds: [buildFinancialEmbed(summary)], ephemeral: true });
        return;
      }

      if (interaction.commandName === 'cancelarpedido') {
        const pending = await getPendingOrderByUser(interaction.user.id);
        if (!pending) {
          await interaction.reply({ content: '❌ Você não possui nenhum pedido pendente para cancelar.', ephemeral: true });
          return;
        }

        await updateOrder(pending.id, { status: 'canceled', updatedAt: new Date().toISOString() });
        await interaction.reply({ content: `✅ Seu pedido \`${pending.id}\` foi cancelado. Agora você pode gerar um novo pagamento.`, ephemeral: true });
        await log(client, `🚫 Pedido cancelado pelo usuário: <@${interaction.user.id}> (ID: ${pending.id})`);
        return;
      }

      if (interaction.commandName === 'retiradovalor') {
        const amount = interaction.options.getNumber('valor', true);
        const reason = interaction.options.getString('motivo') || 'Retirada manual';

        if (!Number.isFinite(amount) || amount <= 0) {
          await interaction.reply({ content: '❌ Valor inválido. Use um número maior que zero.', ephemeral: true });
          return;
        }

        const before = await getFinancialSummary();
        if (amount > before.availableBalance) {
          await interaction.reply({
            content: `❌ Saldo insuficiente. Saldo atual: **${formatMoney(before.availableBalance)}**.`,
            ephemeral: true
          });
          return;
        }

        const withdrawal = await addWithdrawal({
          amount,
          adminId: interaction.user.id,
          reason
        });
        const after = await getFinancialSummary();

        await interaction.reply({
          content: `✅ Retirada registrada: **${formatMoney(withdrawal.amount)}**. Saldo atual: **${formatMoney(after.availableBalance)}**.`,
          ephemeral: true
        });

        await log(client, {
          embeds: [new EmbedBuilder()
            .setTitle('💸 Retirada registrada')
            .addFields(
              { name: 'Valor', value: formatMoney(withdrawal.amount), inline: true },
              { name: 'Admin', value: `<@${interaction.user.id}>`, inline: true },
              { name: 'Saldo atual', value: formatMoney(after.availableBalance), inline: true },
              { name: 'Motivo', value: reason.slice(0, 1024) }
            )
            .setColor(0xe67e22)
            .setTimestamp()]
        });
        return;
      }


      if (interaction.commandName === 'assinaturas') {
        const pagina = Math.max(1, interaction.options.getInteger('pagina') || 1);
        const all = await getAllSubscriptions();
        const active = all.filter((sub) => sub.active);
        const pageSize = 10;
        const page = active.slice((pagina - 1) * pageSize, pagina * pageSize);

        const embed = new EmbedBuilder()
          .setTitle('📋 Assinaturas ativas')
          .setDescription(page.length ? page.map(subscriptionLine).join('\n').slice(0, 4000) : 'Nenhuma assinatura ativa encontrada.')
          .addFields(
            { name: 'Total ativo', value: String(active.length), inline: true },
            { name: 'Página', value: `${pagina}/${Math.max(1, Math.ceil(active.length / pageSize))}`, inline: true }
          )
          .setColor(0x3498db)
          .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      if (interaction.commandName === 'cliente') {
        const user = interaction.options.getUser('usuario', true);
        const sub = await getSubscription(user.id);
        const orders = await getUserOrders(user.id);
        const plan = sub?.planId ? plans[sub.planId] : null;
        const ordersText = orders.slice(0, 8).map((o) =>
          `• ${o.status} — ${plans[o.planId]?.name || o.planId} — ${formatMoney(o.amount || 0)} — ${o.createdAt ? `<t:${Math.floor(new Date(o.createdAt).getTime() / 1000)}:d>` : 'sem data'}`
        ).join('\n') || 'Nenhuma compra encontrada.';

        const embed = new EmbedBuilder()
          .setTitle(`👤 Cliente: ${user.tag}`)
          .setThumbnail(user.displayAvatarURL())
          .addFields(
            { name: 'Assinatura', value: sub ? `${sub.active ? '✅ Ativa' : '❌ Inativa'} • ${plan?.name || sub.planId}` : 'Nenhuma assinatura registrada.', inline: false },
            { name: 'Vencimento', value: sub?.expiresAt ? `<t:${Math.floor(new Date(sub.expiresAt).getTime() / 1000)}:F>` : 'Sem vencimento.', inline: true },
            { name: 'Último pagamento', value: sub?.lastPaymentId ? `\`${sub.lastPaymentId}\`` : 'Nenhum.', inline: true },
            { name: 'Histórico de compras', value: ordersText.slice(0, 1024) }
          )
          .setColor(0x3498db)
          .setTimestamp();

        await interaction.reply({ embeds: [embed], ephemeral: true });
        return;
      }

      if (interaction.commandName === 'criarcupom') {
        const nome = interaction.options.getString('nome', true).trim().toUpperCase();
        const desconto = interaction.options.getNumber('desconto', true);
        const usos = interaction.options.getInteger('usos');

        if (!/^[A-Z0-9_-]{2,30}$/.test(nome)) {
          await interaction.reply({ content: '❌ Nome inválido. Use 2 a 30 caracteres, letras, números, _ ou -.', ephemeral: true });
          return;
        }

        if (desconto <= 0 || desconto > 95) {
          await interaction.reply({ content: '❌ O desconto precisa ser maior que 0 e no máximo 95%.', ephemeral: true });
          return;
        }

        const coupon = await upsertCoupon(nome, {
          discountPercent: desconto,
          maxUses: usos || null,
          active: true,
          createdBy: interaction.user.id
        });

        await interaction.reply({ content: `✅ Cupom **${coupon.name}** criado: **${coupon.discountPercent}%** de desconto${coupon.maxUses ? ` • ${coupon.maxUses} uso(s)` : ' • usos ilimitados'}.`, ephemeral: true });
        await log(client, `🏷️ Cupom criado: **${coupon.name}** (${coupon.discountPercent}%) por <@${interaction.user.id}>.`);
        return;
      }

      if (interaction.commandName === 'removercupom') {
        const nome = interaction.options.getString('nome', true).trim().toUpperCase();
        const ok = await deleteCoupon(nome);
        await interaction.reply({ content: ok ? `✅ Cupom **${nome}** removido.` : `❌ Cupom **${nome}** não encontrado.`, ephemeral: true });
        if (ok) await log(client, `🗑️ Cupom removido: **${nome}** por <@${interaction.user.id}>.`);
        return;
      }

      if (interaction.commandName === 'cupons') {
        const coupons = await getCoupons();
        const items = Object.values(coupons);
        const text = items.length ? items.map((c) =>
          `• **${c.name}** — ${c.discountPercent}% — ${c.active ? 'ativo' : 'inativo'} — usos ${c.uses || 0}${c.maxUses ? `/${c.maxUses}` : ''}`
        ).join('\n') : 'Nenhum cupom cadastrado.';

        await interaction.reply({
          embeds: [new EmbedBuilder().setTitle('🏷️ Cupons').setDescription(text.slice(0, 4000)).setColor(0xf1c40f).setTimestamp()],
          ephemeral: true
        });
        return;
      }

      if (interaction.commandName === 'relatorio') {
        const tipo = interaction.options.getString('tipo') || 'txt';
        const data = await buildReportData();
        const content = tipo === 'csv' ? buildCsvReport(data) : buildTxtReport(data);
        const filename = tipo === 'csv' ? 'relatorio-pda-vendas.csv' : 'relatorio-pda-vendas.txt';
        const attachment = new AttachmentBuilder(Buffer.from(content, 'utf8'), { name: filename });

        await interaction.reply({ content: '✅ Relatório gerado.', files: [attachment], ephemeral: true });
        await log(client, `📄 Relatório **${tipo.toUpperCase()}** gerado por <@${interaction.user.id}>.`);
        return;
      }

      if (interaction.commandName === 'manutencao') {
        const estado = interaction.options.getString('estado', true);
        const active = estado === 'ativar';
        config.maintenance = active;
        await updateSettings({ maintenance: active });
        await interaction.reply({ content: active ? '✅ Modo manutenção ativado. Novas compras foram pausadas.' : '✅ Modo manutenção desativado. Compras liberadas.', ephemeral: true });
        await log(client, `${active ? '🛠️' : '✅'} Modo manutenção ${active ? 'ativado' : 'desativado'} por <@${interaction.user.id}>.`);
        return;
      }

      if (interaction.commandName === 'mensagemplano') {
        const planId = interaction.options.getString('plano_id', true);
        const mensagem = interaction.options.getString('mensagem', true);
        if (!plans[planId]) {
          await interaction.reply({ content: `❌ Plano \`${planId}\` não encontrado.`, ephemeral: true });
          return;
        }
        await updatePlan(planId, { deliveryMessage: mensagem });
        plans[planId] = { ...plans[planId], deliveryMessage: mensagem };
        await interaction.reply({ content: `✅ Mensagem personalizada definida para **${plans[planId].name}**.`, ephemeral: true });
        return;
      }

      if (interaction.commandName === 'cancelarvip') {
        const user = interaction.options.getUser('usuario', true);
        const sub = await getSubscription(user.id);
        const plan = sub?.planId ? plans[sub.planId] : null;
        const roleId = getPlanRoleId(plan) || config.vipRoleId;
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (member && roleId) await member.roles.remove(roleId, 'VIP removido por administrador').catch(() => null);
        await deactivateSubscription(user.id);
        await interaction.reply({ content: `✅ VIP de ${user} removido.`, ephemeral: true });
        await log(client, `🛑 VIP removido manualmente de ${user} por <@${interaction.user.id}>.`);
        return;
      }

      if (interaction.commandName === 'configurar') {
        await interaction.reply({ embeds: [buildConfigEmbed()], components: configComponents(), ephemeral: true });
        return;
      }

      if (interaction.commandName === 'testar_entrega') {
        const planId = interaction.options.getString('plano_id', true);
        const user = interaction.options.getUser('usuario') || interaction.user;
        const plan = plans[planId];
        if (!plan) {
          await interaction.reply({ content: `❌ Plano \`${planId}\` não encontrado. Veja os IDs em /configurar.`, ephemeral: true });
          return;
        }

        const roleResult = await givePlanRole(client, {
          guildId: interaction.guildId,
          userId: user.id,
          planId,
          reason: `Teste de entrega feito por ${interaction.user.tag}`
        });

        if (!roleResult.ok) {
          await interaction.reply({ content: `❌ ${roleResult.reason}`, ephemeral: true });
          return;
        }

        const now = new Date();
        const expiresAt = addDays(now, plan.durationDays);
        await upsertSubscription({
          userId: user.id,
          guildId: interaction.guildId,
          planId,
          active: true,
          expiresAt: expiresAt.toISOString(),
          lastPaymentId: 'teste_manual',
          renewalReminderSentAt: null
        });

        await interaction.reply({ content: `✅ Teste concluído: ${user} recebeu **${plan.name}** até <t:${Math.floor(expiresAt.getTime() / 1000)}:F>.`, ephemeral: true });
        await log(client, `🧪 Teste de entrega: ${user} recebeu **${plan.name}** por ação de <@${interaction.user.id}>.`);
        return;
      }
    }

    if (interaction.isButton() && interaction.customId === 'open_config_modal') {
      const modal = new ModalBuilder().setCustomId('config_modal').setTitle('Editar Configuração Técnica');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder()
          .setCustomId('guildId').setLabel('ID do Servidor').setValue(config.guildId || interaction.guildId || '').setStyle(TextInputStyle.Short)),
        new ActionRowBuilder().addComponents(new TextInputBuilder()
          .setCustomId('webhookUrl').setLabel('URL Webhook').setValue(config.webhookUrl || 'http://localhost:3000').setStyle(TextInputStyle.Short).setRequired(false)),
        new ActionRowBuilder().addComponents(new TextInputBuilder()
          .setCustomId('mercadoPagoAccessToken').setLabel('Access Token Mercado Pago').setValue(config.mercadoPagoAccessToken || '').setStyle(TextInputStyle.Paragraph).setRequired(false))
      );
      await interaction.showModal(modal);
      return;
    }

    if (interaction.isButton() && interaction.customId === 'config_roles_ui') {
      const selectDefault = new RoleSelectMenuBuilder()
        .setCustomId('set_default_vip_role')
        .setPlaceholder('Escolha o cargo VIP padrão');

      const selectPlan = planSelect('select_plan_for_role', 'Escolha um plano para definir cargo específico');
      const components = [new ActionRowBuilder().addComponents(selectDefault)];
      if (selectPlan) components.push(new ActionRowBuilder().addComponents(selectPlan));

      await interaction.reply({ content: 'Configure o cargo padrão ou escolha um plano para definir um cargo específico.', components, ephemeral: true });
      return;
    }

    if (interaction.isButton() && interaction.customId === 'config_channels_ui') {
      const logChannel = new ChannelSelectMenuBuilder()
        .setCustomId('set_log_channel')
        .setPlaceholder('Escolha o canal de logs')
        .setChannelTypes(ChannelType.GuildText);

      const salesChannel = new ChannelSelectMenuBuilder()
        .setCustomId('set_sales_channel')
        .setPlaceholder('Escolha o canal de vendas')
        .setChannelTypes(ChannelType.GuildText);

      await interaction.reply({
        content: 'Escolha os canais usados pelo bot.',
        components: [new ActionRowBuilder().addComponents(logChannel), new ActionRowBuilder().addComponents(salesChannel)],
        ephemeral: true
      });
      return;
    }

    if (interaction.isButton() && interaction.customId === 'test_log_action') {
      if (!config.logChannelId) {
        await interaction.reply({ content: '❌ Nenhum canal de logs configurado.', ephemeral: true });
        return;
      }
      await log(client, `🔔 **Teste de Log:** notificações funcionando. Admin: <@${interaction.user.id}>.`);
      await interaction.reply({ content: '✅ Log de teste enviado.', ephemeral: true });
      return;
    }

    if (interaction.isButton() && interaction.customId === 'send_sales_panel') {
      const target = config.salesChannelId
        ? await client.channels.fetch(config.salesChannelId).catch(() => null)
        : interaction.channel;

      if (!target) {
        await interaction.reply({ content: '❌ Canal de vendas não encontrado. Configure em /configurar > Canais.', ephemeral: true });
        return;
      }

      await target.send(buildPanel());
      await interaction.reply({ content: `✅ Painel enviado em ${target}.`, ephemeral: true });
      return;
    }

    if (interaction.isButton() && interaction.customId === 'test_delivery_ui') {
      const select = planSelect('select_plan_for_test', 'Escolha o plano para testar em você');
      if (!select) return replyNoPlans(interaction);
      await interaction.reply({ content: 'Escolha um plano para simular entrega em você mesmo.', components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
      return;
    }

    if (interaction.isButton() && interaction.customId === 'manage_plans_ui') {
      const select = planSelect('select_plan_to_edit', 'Escolha um plano para editar');
      if (!select) return replyNoPlans(interaction);
      await interaction.reply({ content: 'Selecione abaixo o plano que deseja modificar:', components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
      return;
    }

    if (interaction.isButton() && interaction.customId === 'remove_plan_ui') {
      const select = planSelect('select_plan_to_remove', 'Escolha um plano para remover');
      if (!select) return replyNoPlans(interaction);
      await interaction.reply({ content: 'Selecione o plano que deseja remover.', components: [new ActionRowBuilder().addComponents(select)], ephemeral: true });
      return;
    }

    if (interaction.isButton() && interaction.customId === 'create_plan_ui') {
      const modal = new ModalBuilder().setCustomId('create_plan_modal').setTitle('Criar Novo Plano');
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder()
          .setCustomId('id').setLabel('ID único').setPlaceholder('ex: vip_15d').setStyle(TextInputStyle.Short)),
        new ActionRowBuilder().addComponents(new TextInputBuilder()
          .setCustomId('name').setLabel('Nome do plano').setPlaceholder('Ex: VIP 15 Dias').setStyle(TextInputStyle.Short)),
        new ActionRowBuilder().addComponents(new TextInputBuilder()
          .setCustomId('price').setLabel('Preço').setPlaceholder('15.00').setStyle(TextInputStyle.Short)),
        new ActionRowBuilder().addComponents(new TextInputBuilder()
          .setCustomId('durationDays').setLabel('Duração em dias').setPlaceholder('30 ou 36500 para vitalício').setStyle(TextInputStyle.Short)),
        new ActionRowBuilder().addComponents(new TextInputBuilder()
          .setCustomId('description').setLabel('Descrição').setStyle(TextInputStyle.Paragraph))
      );
      await interaction.showModal(modal);
      return;
    }

    if (interaction.isRoleSelectMenu() && interaction.customId === 'set_default_vip_role') {
      const roleId = interaction.values[0];
      config.vipRoleId = roleId;
      await updateSettings({ vipRoleId: roleId });
      await interaction.reply({ content: `✅ Cargo VIP padrão definido como <@&${roleId}>.`, ephemeral: true });
      return;
    }

    if (interaction.isChannelSelectMenu() && interaction.customId === 'set_log_channel') {
      const channelId = interaction.values[0];
      config.logChannelId = channelId;
      await updateSettings({ logChannelId: channelId });
      await interaction.reply({ content: `✅ Canal de logs definido como <#${channelId}>.`, ephemeral: true });
      return;
    }

    if (interaction.isChannelSelectMenu() && interaction.customId === 'set_sales_channel') {
      const channelId = interaction.values[0];
      config.salesChannelId = channelId;
      await updateSettings({ salesChannelId: channelId });
      await interaction.reply({ content: `✅ Canal de vendas definido como <#${channelId}>.`, ephemeral: true });
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'select_plan_for_role') {
      const planId = interaction.values[0];
      const roleSelect = new RoleSelectMenuBuilder()
        .setCustomId(`set_plan_role_${planId}`)
        .setPlaceholder(`Escolha o cargo para ${plans[planId].name}`);
      await interaction.reply({ content: `Escolha o cargo que será entregue no plano **${plans[planId].name}**.`, components: [new ActionRowBuilder().addComponents(roleSelect)], ephemeral: true });
      return;
    }

    if (interaction.isRoleSelectMenu() && interaction.customId.startsWith('set_plan_role_')) {
      const planId = interaction.customId.replace('set_plan_role_', '');
      const roleId = interaction.values[0];
      await updatePlan(planId, { roleId });
      plans[planId] = { ...plans[planId], roleId };
      await interaction.reply({ content: `✅ Plano **${plans[planId].name}** agora entrega <@&${roleId}>.`, ephemeral: true });
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'select_plan_for_test') {
      const planId = interaction.values[0];
      const plan = plans[planId];
      const roleResult = await givePlanRole(client, {
        guildId: interaction.guildId,
        userId: interaction.user.id,
        planId,
        reason: `Teste de entrega feito por ${interaction.user.tag}`
      });

      if (!roleResult.ok) {
        await interaction.reply({ content: `❌ ${roleResult.reason}`, ephemeral: true });
        return;
      }

      const expiresAt = addDays(new Date(), plan.durationDays);
      await upsertSubscription({
        userId: interaction.user.id,
        guildId: interaction.guildId,
        planId,
        active: true,
        expiresAt: expiresAt.toISOString(),
        lastPaymentId: 'teste_manual',
        renewalReminderSentAt: null
      });
      await interaction.reply({ content: `✅ Você recebeu **${plan.name}** até <t:${Math.floor(expiresAt.getTime() / 1000)}:F>.`, ephemeral: true });
      await log(client, `🧪 Teste de entrega: <@${interaction.user.id}> recebeu **${plan.name}**.`);
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'select_plan_to_remove') {
      const planId = interaction.values[0];
      const planName = plans[planId]?.name || planId;
      await deletePlan(planId);
      delete plans[planId];
      await interaction.reply({ content: `✅ Plano **${planName}** removido.`, ephemeral: true });
      await log(client, `🗑️ Plano removido: **${planName}** por <@${interaction.user.id}>.`);
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'select_plan_to_edit') {
      const planId = interaction.values[0];
      const plan = plans[planId];
      const modal = new ModalBuilder().setCustomId(`edit_plan_modal_${planId}`).setTitle(`Editar ${plan.name}`);
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder()
          .setCustomId('name').setLabel('Nome do plano').setValue(plan.name).setStyle(TextInputStyle.Short)),
        new ActionRowBuilder().addComponents(new TextInputBuilder()
          .setCustomId('price').setLabel('Preço').setValue(String(plan.price)).setStyle(TextInputStyle.Short)),
        new ActionRowBuilder().addComponents(new TextInputBuilder()
          .setCustomId('durationDays').setLabel('Duração em dias').setValue(String(plan.durationDays)).setStyle(TextInputStyle.Short)),
        new ActionRowBuilder().addComponents(new TextInputBuilder()
          .setCustomId('roleId').setLabel('ID do cargo deste plano').setValue(plan.roleId || '').setStyle(TextInputStyle.Short).setRequired(false)),
        new ActionRowBuilder().addComponents(new TextInputBuilder()
          .setCustomId('description').setLabel('Descrição').setValue(plan.description || '').setStyle(TextInputStyle.Paragraph).setRequired(false))
      );
      await interaction.showModal(modal);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === 'create_plan_modal') {
      const planId = interaction.fields.getTextInputValue('id').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
      if (!planId) {
        await interaction.reply({ content: '❌ ID inválido. Use apenas letras, números e underscores.', ephemeral: true });
        return;
      }
      if (plans[planId]) {
        await interaction.reply({ content: `❌ Já existe um plano com o ID \`${planId}\`.`, ephemeral: true });
        return;
      }

      const newPlanData = {
        id: planId,
        name: interaction.fields.getTextInputValue('name'),
        price: parseFloat(interaction.fields.getTextInputValue('price').replace(',', '.')),
        durationDays: parseInt(interaction.fields.getTextInputValue('durationDays')),
        description: interaction.fields.getTextInputValue('description')
      };

      if (isNaN(newPlanData.price) || isNaN(newPlanData.durationDays)) {
        await interaction.reply({ content: '❌ Preço ou duração inválidos. Use apenas números.', ephemeral: true });
        return;
      }

      await updatePlan(planId, newPlanData);
      plans[planId] = newPlanData;
      await interaction.reply({ content: `✅ Plano **${newPlanData.name}** criado. Use **Cargos** para escolher qual cargo ele entrega.`, ephemeral: true });
      await log(client, `🆕 Plano criado: **${newPlanData.name}** (${formatMoney(newPlanData.price)} / ${durationText(newPlanData.durationDays)}).`);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('edit_plan_modal_')) {
      const planId = interaction.customId.replace('edit_plan_modal_', '');
      const roleId = interaction.fields.getTextInputValue('roleId').trim();
      const newPlanData = {
        name: interaction.fields.getTextInputValue('name'),
        price: parseFloat(interaction.fields.getTextInputValue('price').replace(',', '.')),
        durationDays: parseInt(interaction.fields.getTextInputValue('durationDays')),
        roleId,
        description: interaction.fields.getTextInputValue('description')
      };

      if (isNaN(newPlanData.price) || isNaN(newPlanData.durationDays)) {
        await interaction.reply({ content: '❌ Preço ou duração inválidos. Use números.', ephemeral: true });
        return;
      }

      await updatePlan(planId, newPlanData);
      plans[planId] = { ...plans[planId], ...newPlanData };
      await interaction.reply({ content: `✅ Plano **${newPlanData.name}** atualizado.`, ephemeral: true });
      await log(client, `📝 Plano editado: **${newPlanData.name}** por <@${interaction.user.id}>.`);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === 'config_modal') {
      const newSettings = {
        guildId: interaction.fields.getTextInputValue('guildId').trim(),
        webhookUrl: interaction.fields.getTextInputValue('webhookUrl').trim(),
        mercadoPagoAccessToken: interaction.fields.getTextInputValue('mercadoPagoAccessToken').trim()
      };
      await updateSettings(newSettings);
      Object.assign(config, newSettings);
      await interaction.reply({ content: '✅ Configuração técnica atualizada.', ephemeral: true });
      await log(client, `⚙️ Configurações técnicas alteradas por <@${interaction.user.id}>.`);
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'buy_plan') {
      if (config.maintenance) {
        await interaction.reply({ content: '🛠️ As vendas estão em manutenção no momento. Tente novamente mais tarde.', ephemeral: true });
        return;
      }

      const planId = interaction.values[0];
      const plan = plans[planId];
      if (!plan) {
        await interaction.reply({ content: 'Plano inválido.', ephemeral: true });
        return;
      }

      if (!getPlanRoleId(plan)) {
        await interaction.reply({ content: '❌ Este plano ainda não tem cargo configurado. Avise a administração.', ephemeral: true });
        return;
      }

      const modal = new ModalBuilder().setCustomId(`buy_coupon_modal_${planId}`).setTitle(`Comprar ${plan.name}`.slice(0, 45));
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder()
          .setCustomId('coupon')
          .setLabel('Cupom de desconto (opcional)')
          .setPlaceholder('Ex: PROMO10')
          .setStyle(TextInputStyle.Short)
          .setRequired(false))
      );
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder()
          .setCustomId('payerEmail')
          .setLabel('Seu e-mail para o pagamento')
          .setPlaceholder('ex: seuemail@exemplo.com')
          .setStyle(TextInputStyle.Short)
          .setRequired(true))
      );
      await interaction.showModal(modal);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('buy_coupon_modal_')) {
      await interaction.deferReply({ ephemeral: true });
      if (config.maintenance) {
        await interaction.editReply('🛠️ As vendas estão em manutenção no momento. Tente novamente mais tarde.');
        return;
      }

      const planId = interaction.customId.replace('buy_coupon_modal_', '');
      const plan = plans[planId];
      if (!plan) {
        await interaction.editReply('Plano inválido.');
        return;
      }

      const pendingOrder = await getPendingOrderByUser(interaction.user.id);
      if (pendingOrder) {
        await interaction.editReply(`⚠️ Você já tem um pagamento pendente. Pague ou aguarde expirar antes de gerar outro. ID: \`${pendingOrder.id}\``);
        return;
      }

      let finalAmount = Number(plan.price);
      let discountAmount = 0;
      let couponCode = null;
      const rawCoupon = interaction.fields.getTextInputValue('coupon')?.trim().toUpperCase(); // Pega o cupom

      if (rawCoupon) {
        const coupons = await getCoupons();
        const coupon = coupons[rawCoupon];
        if (!coupon || !coupon.active) {
          await interaction.editReply(`❌ Cupom **${rawCoupon}** não encontrado ou inativo.`);
          return;
        }
        if (coupon.maxUses !== null && coupon.maxUses !== undefined && Number(coupon.uses || 0) >= Number(coupon.maxUses)) {
          await interaction.editReply(`❌ Cupom **${rawCoupon}** esgotado.`);
          return;
        }
        const price = applyCouponPrice(plan.price, coupon);
        finalAmount = price.finalAmount;
        discountAmount = price.discountAmount;
        couponCode = rawCoupon;
      }

      const existingSub = await getSubscription(interaction.user.id);
      const isRenewal = Boolean(existingSub?.active && new Date(existingSub.expiresAt) > new Date());
      const orderId = nanoid(12);
      const payerEmail = interaction.fields.getTextInputValue('payerEmail'); // Pega o e-mail do usuário

      let payment;
      try {
        payment = await createPixPayment({
          amount: finalAmount,
          description: `${plan.name} - Discord VIP`,
          email: payerEmail, // Usa o e-mail fornecido pelo usuário
          userId: interaction.user.id,
          planId,
          orderId
        });
      } catch (error) {
        const raw = String(error.message || '');
        if (raw.startsWith('MERCADO_PAGO_SEM_TOKEN')) {
          await interaction.editReply('❌ Mercado Pago ainda não está configurado. Um administrador precisa colocar o Access Token real em `/configurar`.');
          return;
        }
        if (raw.startsWith('MERCADO_PAGO_ERRO')) {
          await interaction.editReply(`❌ Erro do Mercado Pago ao gerar Pix: ${raw.replace('MERCADO_PAGO_ERRO: ', '')}`);
          return;
        }
        throw error;
      }

      if (couponCode) await useCoupon(couponCode);

      await addOrder({
        id: orderId,
        userId: interaction.user.id,
        username: interaction.user.tag,
        guildId: interaction.guildId,
        planId,
        amount: finalAmount,
        originalAmount: Number(plan.price),
        discountAmount,
        couponCode,
        status: payment.status || 'pending',
        paymentId: String(payment.id),
        previousExpiresAt: isRenewal ? existingSub.expiresAt : null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      const tx = payment.point_of_interaction?.transaction_data || {};
      const pixCode = tx.qr_code || 'Código Pix não retornado pelo Mercado Pago.';
      const ticketUrl = tx.ticket_url;
      const attachment = qrAttachmentFromBase64(tx.qr_code_base64);

      const embed = new EmbedBuilder()
        .setTitle('🧾 Pagamento Pix gerado')
        .setDescription(`${isRenewal ? '🔁 **Renovação detectada:** os dias serão somados ao seu vencimento atual.\n\n' : ''}Plano: **${plan.name}**\nValor: **${formatMoney(finalAmount)}**${couponCode ? `\nCupom: **${couponCode}** (-${formatMoney(discountAmount)})` : ''}\n\nCopie o Pix abaixo ou escaneie o QR Code.`)
        .addFields(
          { name: 'Pix copia e cola', value: `\`\`\`${pixCode.slice(0, 950)}\`\`\`` },
          { name: 'Após pagar', value: 'O bot checa automaticamente e libera o cargo quando aprovar.' }
        )
        .setColor(0xf1c40f)
        .setFooter({ text: `Pedido: ${orderId}` });

      if (attachment) embed.setImage('attachment://pix.png');
      const components = [];
      if (ticketUrl) {
        components.push(new ActionRowBuilder().addComponents(
          new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(ticketUrl).setLabel('Abrir Pix no Mercado Pago')
        ));
      }

      await interaction.editReply({ embeds: [embed], files: attachment ? [attachment] : [], components });
      await log(client, `🛒 Novo pedido: <@${interaction.user.id}> escolheu **${plan.name}** - ${formatMoney(finalAmount)}${couponCode ? ` com cupom **${couponCode}**` : ''} - pagamento ${payment.id}.`);
      return;
    }
  } catch (error) {
    console.error(error);
    const msg = '❌ Ocorreu um erro. Confira o console/logs da hospedagem.';
    if (interaction.deferred || interaction.replied) await interaction.editReply(msg).catch(() => null);
    else await interaction.reply({ content: msg, ephemeral: true }).catch(() => null);
  }
});

const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Bot de vendas online.');
});

app.post('/webhook/mercadopago', async (req, res) => {
  res.sendStatus(200);
  try {
    const body = req.body || {};
    const paymentId = body?.data?.id || body?.id || body?.resource?.split('/').pop();
    const topic = body?.type || body?.topic;
    if (!paymentId || (topic && !String(topic).includes('payment'))) return;
    await approvePaymentAndGiveRole(client, paymentId);
  } catch (error) {
    console.error('Erro no webhook Mercado Pago:', error.message);
  }
});

app.listen(config.port, () => console.log(`🌐 Webhook ouvindo na porta ${config.port}`));
await client.login(config.discordToken);
