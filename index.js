// index.js — NewEra Daily Submission Bot (Panel Version, with diagnostics)

import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { DateTime } from 'luxon';
import fs from 'fs';
import express from 'express';

// ===== ENV & CONSTANTS =====
const TOKEN = process.env.DISCORD_TOKEN?.trim();
const GUILD_ID = process.env.GUILD_ID?.trim();
const TZ = 'America/Detroit';
const DATA_FILE = './data.json';

console.log('ENV check → TOKEN len:', TOKEN?.length || 0, '| GUILD_ID:', GUILD_ID);
if (!TOKEN) console.error('🚫 DISCORD_TOKEN is missing.');
if (!GUILD_ID || !/^\d{10,}$/.test(GUILD_ID)) console.error('🚫 GUILD_ID missing/invalid. Must be a numeric Server ID.');

// ===== DATA PERSISTENCE =====
function todayISO() {
  return DateTime.now().setZone(TZ).toISODate(); // YYYY-MM-DD
}
function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return {
      currentDate: todayISO(),
      completed: [],
      gangRoleId: null,
      panelMessageId: null,
      panelChannelId: null,
    };
  }
}
function saveData(d) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}
function ensureToday(d) {
  const t = todayISO();
  if (d.currentDate !== t) {
    d.currentDate = t;
    d.completed = [];
    saveData(d);
    console.log(`🔁 New day detected (${t}) — reset completed list.`);
  }
}

const data = loadData();
ensureToday(data);

// ===== DISCORD CLIENT =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

// ===== COMMANDS =====
const commands = [
  { name: 'done', description: 'Mark that you submitted today’s 1000 bud.' },
  { name: 'status', description: 'See today’s done vs remaining.' },
  { name: 'remaining', description: 'List members who still need to submit today.' },
  {
    name: 'setgangrole',
    description: 'Set the required gang role for submissions.',
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
    options: [{ name: 'role', description: 'Select the gang role', type: 8, required: true }], // ROLE
  },
  {
    name: 'force-reset',
    description: 'Force reset today’s checklist (admin).',
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
  },
  {
    name: 'ping-remaining',
    description: 'Ping members who haven’t submitted yet (admin).',
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
  },
  {
    name: 'panel',
    description: 'Post the control panel message in this channel (admin).',
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
  },
];

// ===== HELPERS =====
function getGangMembers(guild) {
  if (!data.gangRoleId) return null;
  const role = guild.roles.cache.get(data.gangRoleId);
  if (!role) return null;
  return role.members; // Collection<Snowflake, GuildMember>
}
function isGangMember(member) {
  if (!data.gangRoleId) return true; // allow until configured
  return member.roles.cache.has(data.gangRoleId);
}
function summarize(guild) {
  ensureToday(data);
  const members = getGangMembers(guild);
  if (!members) {
    return { total: null, doneCount: data.completed.length, remainingCount: null, remaining: [] };
  }
  const total = members.size;
  const doneSet = new Set(data.completed);
  const remaining = members
    .filter((m) => !doneSet.has(m.id))
    .map((m) => m)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { total, doneCount: Math.min(doneSet.size, total), remainingCount: remaining.length, remaining };
}
function panelComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('btn_done').setLabel("I'm Done").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('btn_status').setLabel('Status').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('btn_remaining').setLabel("Who’s Left").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('btn_ping').setLabel('Ping Remaining').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('btn_help').setLabel('Help').setStyle(ButtonStyle.Secondary),
    ),
  ];
}
function panelEmbed(guild) {
  const { total, doneCount, remainingCount } = summarize(guild);
  const lines =
    total !== null
      ? [`**Done:** ${doneCount}/${total}`, `**Remaining:** ${remainingCount}`]
      : [`**Done:** ${doneCount}`, `*(Set a gang role with /setgangrole)*`];
  return new EmbedBuilder()
    .setTitle('NewEra Daily Submission Panel')
    .setDescription(`Submit your **1000 bud** for **${data.currentDate}**.\n${lines.join('\n')}`)
    .setFooter({ text: 'Click “I’m Done” after you submit. Auto-resets daily (America/Detroit).' })
    .setTimestamp();
}

// ===== COMMAND REGISTRATION (with diagnostics + fallback) =====
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const app = await client.application.fetch();
  console.log('🆔 App ID:', app.id, '| GUILD_ID:', GUILD_ID);

  // 1) Clear guild commands to avoid stale cache
  await rest.put(Routes.applicationGuildCommands(app.id, GUILD_ID), { body: [] });
  console.log('🧹 Cleared old guild commands');

  // 2) Register guild commands (fast)
  await rest.put(Routes.applicationGuildCommands(app.id, GUILD_ID), { body: commands });
  console.log('✅ Registered GUILD commands:', commands.map((c) => c.name).join(', '));

  // 3) Diagnostics: read back what exists
  const guildCmds = await rest.get(Routes.applicationGuildCommands(app.id, GUILD_ID));
  console.log('🔎 Guild commands now on server:', guildCmds.map((c) => c.name));
}

// ===== READY =====
client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (e) {
    console.error('❌ Failed to register commands via REST:', e?.message || e);
  }

  // Fallback: also set via discord.js GuildCommandManager
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.commands.set(commands);
    console.log('🛠️ guild.commands.set() applied (fallback)');
  } catch (e) {
    console.error('guild.commands.set() failed:', e?.message || e);
  }

  // Auto-reset checker
  setInterval(() => ensureToday(data), 60 * 1000);

  // Refresh panel on restart if we still have its IDs
  if (data.panelChannelId && data.panelMessageId) {
    try {
      const ch = await client.channels.fetch(data.panelChannelId);
      const msg = await ch.messages.fetch(data.panelMessageId);
      await msg.edit({ embeds: [panelEmbed(msg.guild)], components: panelComponents() });
      console.log('♻️ Panel refreshed after restart');
    } catch {
      console.log('ℹ️ Panel not found (maybe deleted). Use /panel again if needed.');
    }
  }
});

// ===== INTERACTIONS =====
client.on('interactionCreate', async (interaction) => {
  ensureToday(data);

  // BUTTONS
  if (interaction.isButton()) {
    const id = interaction.customId;
    const member = await interaction.guild.members.fetch(interaction.user.id);

    if (id === 'btn_help') {
      return interaction.reply({
        ephemeral: true,
        content:
          '**How it works**\n' +
          '• Click **I’m Done** after you submit your 1000 bud.\n' +
          '• **Status** shows today’s progress.\n' +
          '• **Who’s Left** lists remaining members.\n' +
          '• Admins can press **Ping Remaining** to remind everyone.\n\n' +
          '*(Tip: admins run **/setgangrole** once to choose the gang role.)*',
      });
    }

    if (id === 'btn_done') {
      if (!isGangMember(member)) {
        return interaction.reply({ content: '❌ You don’t have the required gang role.', ephemeral: true });
      }
      if (!data.completed.includes(member.id)) {
        data.completed.push(member.id);
        saveData(data);
      }
      try {
        if (data.panelChannelId && data.panelMessageId) {
          const ch = await interaction.guild.channels.fetch(data.panelChannelId);
          const msg = await ch.messages.fetch(data.panelMessageId);
          await msg.edit({ embeds: [panelEmbed(interaction.guild)], components: panelComponents() });
        }
      } catch {}
      return interaction.reply({ content: `✅ Marked **DONE** for ${data.currentDate}.`, ephemeral: true });
    }

    if (id === 'btn_status') {
      const { total, doneCount, remainingCount } = summarize(interaction.guild);
      const text =
        total !== null
          ? `**Done:** ${doneCount}/${total}\n**Remaining:** ${remainingCount}`
          : `**Done:** ${doneCount}\n*(Set a gang role with /setgangrole)*`;
      return interaction.reply({ content: text, ephemeral: true });
    }

    if (id === 'btn_remaining') {
      const { remaining } = summarize(interaction.guild);
      if (!remaining) return interaction.reply({ content: 'Set a gang role with **/setgangrole** first.', ephemeral: true });
      const list = remaining.length ? remaining.map((m) => `${m}`).join('\n') : 'Everyone is done. 🎉';
      return interaction.reply({ content: list, ephemeral: true });
    }

    if (id === 'btn_ping') {
      if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: '❌ Admins only (Manage Server).', ephemeral: true });
      }
      const { remaining } = summarize(interaction.guild);
      if (!remaining) return interaction.reply({ content: 'Set a gang role with **/setgangrole** first.', ephemeral: true });
      if (!remaining.length) return interaction.reply({ content: 'Everyone is done. 🎉', ephemeral: true });
      const mentions = remaining.map((m) => `${m}`).join(' ');
      return interaction.reply({ content: `⏰ Daily check: ${mentions}\nPlease submit your 1000 bud and press **I’m Done**.` });
    }

    return; // end button handling
  }

  // SLASH COMMANDS
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'setgangrole') {
    const role = interaction.options.getRole('role');
    data.gangRoleId = role.id;
    saveData(data);
    try {
      if (data.panelChannelId && data.panelMessageId) {
        const ch = await interaction.guild.channels.fetch(data.panelChannelId);
        const msg = await ch.messages.fetch(data.panelMessageId);
        await msg.edit({ embeds: [panelEmbed(interaction.guild)], components: panelComponents() });
      }
    } catch {}
    return interaction.reply({ content: `✅ Gang role set to **${role.name}**.`, ephemeral: true });
  }

  if (interaction.commandName === 'force-reset') {
    data.currentDate = todayISO();
    data.completed = [];
    saveData(data);
    try {
      if (data.panelChannelId && data.panelMessageId) {
        const ch = await interaction.guild.channels.fetch(data.panelChannelId);
        const msg = await ch.messages.fetch(data.panelMessageId);
        await msg.edit({ embeds: [panelEmbed(interaction.guild)], components: panelComponents() });
      }
    } catch {}
    return interaction.reply({ content: '♻️ Today’s checklist has been reset.', ephemeral: true });
  }

  if (interaction.commandName === 'done') {
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!isGangMember(member)) {
      return interaction.reply({ content: '❌ You don’t have the required gang role.', ephemeral: true });
    }
    if (!data.completed.includes(member.id)) {
      data.completed.push(member.id);
      saveData(data);
    }
    try {
      if (data.panelChannelId && data.panelMessageId) {
        const ch = await interaction.guild.channels.fetch(data.panelChannelId);
        const msg = await ch.messages.fetch(data.panelMessageId);
        await msg.edit({ embeds: [panelEmbed(interaction.guild)], components: panelComponents() });
      }
    } catch {}
    return interaction.reply({ content: `✅ You’re marked as done for **${data.currentDate}**.`, ephemeral: true });
  }

  if (interaction.commandName === 'status') {
    const { total, doneCount, remainingCount, remaining } = summarize(interaction.guild);
    const remainingPreview = remaining?.slice(0, 20).map((m) => `• ${m}`).join('\n') || '—';
    const embed = new EmbedBuilder()
      .setTitle(`Today’s Progress (${data.currentDate})`)
      .setDescription(
        total
          ? `**Done:** ${doneCount}/${total}\n**Remaining:** ${remainingCount}`
          : `**Done:** ${doneCount}\n*(Set a gang role with **/setgangrole**)*`,
      )
      .addFields({ name: 'Remaining (first 20)', value: remainingPreview })
      .setTimestamp();
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (interaction.commandName === 'remaining') {
    const { remaining } = summarize(interaction.guild);
    if (!remaining) return interaction.reply({ content: 'Set a gang role with **/setgangrole** first.', ephemeral: true });
    const list = remaining.length ? remaining.map((m) => `${m}`).join('\n') : 'Everyone is done. 🎉';
    return interaction.reply({ content: list, ephemeral: true });
  }

  if (interaction.commandName === 'ping-remaining') {
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return interaction.reply({ content: '❌ Admins only (Manage Server).', ephemeral: true });
    }
    const { remaining } = summarize(interaction.guild);
    if (!remaining) return interaction.reply({ content: 'Set a gang role with **/setgangrole** first.', ephemeral: true });
    if (!remaining.length) return interaction.reply({ content: 'Everyone is done. 🎉', ephemeral: true });
    const mentions = remaining.map((m) => `${m}`).join(' ');
    return interaction.reply({ content: `⏰ Daily check: ${mentions}\nPlease submit your 1000 bud and press **I’m Done**.` });
  }

  if (interaction.commandName === 'panel') {
    const embed = panelEmbed(interaction.guild);
    const components = panelComponents();
    const sent = await interaction.channel.send({ embeds: [embed], components });
    data.panelMessageId = sent.id;
    data.panelChannelId = sent.channel.id;
    saveData(data);
    return interaction.reply({ content: '✅ Panel posted. Consider pinning it.', ephemeral: true });
  }
});

// ===== HEALTH SERVER (Render / UptimeRobot) =====
const app = express();
app.get('/', (_, res) => res.send('OK'));
app.get('/health', (_, res) => res.json({ ok: true, date: new Date().toISOString() }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🩺 Health server listening on ${PORT}`));

// ===== LOGIN =====
client.login(TOKEN).catch((e) => {
  console.error('❌ Login failed. Check DISCORD_TOKEN. Error:', e?.message || e);
});
