import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { config, validateConfig } from './config.js';

validateConfig();

const commands = [
  new SlashCommandBuilder()
    .setName('painel')
    .setDescription('Envia o painel de vendas VIP')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Mostra o status da sua assinatura VIP'),
  new SlashCommandBuilder()
    .setName('saldo')
    .setDescription('Mostra quanto o bot vendeu, quanto foi retirado e o saldo disponível')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('retiradovalor')
    .setDescription('Registra uma retirada manual do saldo do bot')
    .addNumberOption((option) => option.setName('valor').setDescription('Valor retirado, exemplo: 10.50').setRequired(true).setMinValue(0.01))
    .addStringOption((option) => option.setName('motivo').setDescription('Motivo da retirada').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('cancelarvip')
    .setDescription('Remove a assinatura VIP de um usuário')
    .addUserOption((option) => option.setName('usuario').setDescription('Usuário para remover o VIP').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('configurar')
    .setDescription('Abre o painel completo de configuração do bot')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('testar_entrega')
    .setDescription('Simula uma compra aprovada e entrega o cargo de um plano')
    .addStringOption((option) => option.setName('plano_id').setDescription('ID do plano, exemplo: vip_7d').setRequired(true))
    .addUserOption((option) => option.setName('usuario').setDescription('Usuário que vai receber o teste. Se vazio, será você.').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('assinaturas')
    .setDescription('Lista assinaturas VIP ativas')
    .addIntegerOption((option) => option.setName('pagina').setDescription('Página da lista').setRequired(false).setMinValue(1))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('cliente')
    .setDescription('Consulta assinatura e compras de um usuário')
    .addUserOption((option) => option.setName('usuario').setDescription('Usuário para consultar').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('criarcupom')
    .setDescription('Cria ou atualiza um cupom de desconto')
    .addStringOption((option) => option.setName('nome').setDescription('Nome do cupom, exemplo: PROMO10').setRequired(true))
    .addNumberOption((option) => option.setName('desconto').setDescription('Desconto em porcentagem, exemplo: 10').setRequired(true).setMinValue(1).setMaxValue(95))
    .addIntegerOption((option) => option.setName('usos').setDescription('Limite de usos. Deixe vazio para ilimitado').setRequired(false).setMinValue(1))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('removercupom')
    .setDescription('Remove um cupom de desconto')
    .addStringOption((option) => option.setName('nome').setDescription('Nome do cupom').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('cupons')
    .setDescription('Lista cupons cadastrados')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('relatorio')
    .setDescription('Gera relatório de vendas, retiradas e assinaturas')
    .addStringOption((option) => option.setName('tipo').setDescription('Formato do relatório').setRequired(false).addChoices({ name: 'TXT', value: 'txt' }, { name: 'CSV', value: 'csv' }))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('manutencao')
    .setDescription('Ativa ou desativa o modo manutenção de vendas')
    .addStringOption((option) => option.setName('estado').setDescription('Ativar ou desativar').setRequired(true).addChoices({ name: 'Ativar', value: 'ativar' }, { name: 'Desativar', value: 'desativar' }))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('mensagemplano')
    .setDescription('Define a mensagem enviada ao cliente quando um plano é aprovado')
    .addStringOption((option) => option.setName('plano_id').setDescription('ID do plano, exemplo: vip_30d').setRequired(true))
    .addStringOption((option) => option.setName('mensagem').setDescription('Mensagem personalizada de entrega').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('cancelarpedido')
    .setDescription('Cancela o seu pedido pendente atual para permitir uma nova compra')
].map((command) => command.toJSON());

if (!config.clientId || !config.guildId) {
  console.error('❌ Para registrar slash commands, coloque CLIENT_ID e GUILD_ID no .env. O bot pode ligar sem isso, mas os comandos não aparecem sem registrar.');
  process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(config.discordToken);
await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), { body: commands });
console.log('✅ Comandos registrados no servidor.');
