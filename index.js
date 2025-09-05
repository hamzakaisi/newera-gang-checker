import 'dotenv/config';
import {
  Client, GatewayIntentBits, REST, Routes,
  PermissionFlagsBits, EmbedBuilder
} from 'discord.js';
import { DateTime } from 'luxon';
import fs from 'fs';
import express from 'express';

const TZ = 'America/Detroit';
const DATA_FILE = './data.json';

// --- persistence helpers ---
function today() {
  return DateTime.now().setZone(TZ).toISODate(); // YYYY-MM-DD
}
function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { currentDate: today(), completed: [], gangRoleId: null };
  }
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}
function ensureToday(data) {
  const t = today();
  if (data.currentDate !== t) {
    data.currentDate = t;
    data.completed = [];
    saveData(data);
  }
}

const data = loadData();
ensureToday(data);

// --- discord client ---
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

const commands = [
  { name: 'done', description: 'Mark that you submitted today’s 1000 bud.' },
  { name: 'status', description: 'See today’s progress (done vs remaining).' },
  { name: 'remaining', description: 'List members who still need to submit today.' },
  {
    name: 'setgangrole',
    description: 'Set the required gang role for submissions.',
    default_member_permissions: String(PermissionFlagsBits.ManageGuild),
    options: [
      { name: 'role', description: 'Select the gang role', type: 8, required: true } // ROLE
    ]
  },
  {
    name: 'force-reset',
    description: 'Force reset today’s checklist (admin).',
    default_member_permissions: String(PermissionFlagsBits.ManageGuild)
  },
  {
    name: 'ping-remaining',
    description: 'Ping the members who haven’t submitted yet (admin).',
    default_member_permissions: String(PermissionFlagsBits.ManageGuild)
  }
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const app = await client.application.fetch();
  await rest.put(
    Routes.applicationGuildCommands(app.id, process.env.GUILD_ID),
    { body: commands }
  );
}

function getGangMembers(guild) {
  if (!data.gangRoleId) return null;
  const role = guild.roles.cache.get(data.gangRoleId);
  if (!role) return null;
  return role.members;
}
function isGangMember(member) {
  if (!data.gangRoleId) return true; // until configured
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
    .filter(m => !doneSet.has(m.id))
    .map(m => m)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return { total, doneCount: Math.min(doneSet.size, total), remainingCount: remaining.length, remaining };
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
  setInterval(() => ensureToday(data), 60 * 1000); // daily rollover check
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  ensureToday(data);

  if (interaction.commandName === 'setgangrole') {
    const role = interaction.options.getRole('role');
    data.gangRoleId = role.id;
    saveData(data);
    return interaction.reply({ content: `✅ Gang role set to **${role.name}**.`, ephemeral: true });
  }

  if (interaction.commandName === 'force-reset') {
    data.currentDate = today();
    data.completed = [];
    saveData(data);
    return interaction.reply({ content: '♻️ Today’s checklist has been reset.', ephemeral: true });
  }

  if (interaction.commandName === 'done') {
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!isGangMember(member)) {
      return interaction.reply({ content: `❌ You don’t have the required gang role to submit.`, ephemeral: true });
    }
    if (data.completed.includes(member.id)) {
      return interaction.reply({ content: `✅ You’re already marked as done for **${data.currentDate}**.`, ephemeral: true });
    }
    data.completed.push(member.id);
    saveData(data);
    const { total, doneCount, remainingCount } = summarize(interaction.guild);
    const embed = new EmbedBuilder()
      .setTitle('Submission Recorded')
      .setDescription(`You’re marked as **DONE** for **${data.currentDate}**.`)
      .addFields(
        total
          ? [
              { name: 'Done', value: `${doneCount}/${total}`, inline: true },
              { name: 'Remaining', value: `${remainingCount}`, inline: true }
            ]
          : [{ name: 'Done (no role set yet)', value: `${doneCount}`, inline: true }]
      )
      .setTimestamp();
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (interaction.commandName === 'status') {
    const { total, doneCount, remainingCount, remaining } = summarize(interaction.guild);
    const remainingPreview = remaining?.slice(0, 20).map(m => `• ${m}`).join('\n') || '—';
    const embed = new EmbedBuilder()
      .setTitle(`Today’s Progress (${data.currentDate})`)
      .setDescription(
        total
          ? `**Done:** ${doneCount}/${total}\n**Remaining:** ${remainingCount}`
          : `**Done:** ${doneCount}\n*(Set a gang role with **/setgangrole** to track everyone automatically)*`
      )
      .addFields({ name: 'Remaining (first 20)', value: remainingPreview })
      .setTimestamp();
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }

  if (interaction.commandName === 'remaining') {
    const { remaining } = summarize(interaction.guild);
    if (!remaining) return interaction.reply({ content: 'Set a gang role with **/setgangrole** first.', ephemeral: true });
    const list = remaining.length ? remaining.map(m => `${m}`).join('\n') : 'Everyone is done. 🎉';
    return interaction.reply({ content: list, ephemeral: true });
  }

  if (interaction.commandName === 'ping-remaining') {
    const { remaining } = summarize(interaction.guild);
    if (!remaining) return interaction.reply({ content: 'Set a gang role with **/setgangrole** first.', ephemeral: true });
    if (!remaining.length) return interaction.reply({ content: 'Everyone is done. 🎉', ephemeral: true });
    const mentions = remaining.map(m => `${m}`).join(' ');
    return interaction.reply({ content: `⏰ Daily check: ${mentions}\nPlease submit your 1000 bud and use **/done**.` });
  }
});

// --- tiny web server for Render/UptimeRobot ---
const app = express();
app.get('/', (_, res) => res.send('OK'));
app.get('/health', (_, res) => res.json({ ok: true, date: new Date().toISOString() }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Health server listening on ${PORT}`));

client.login(process.env.DISCORD_TOKEN);
