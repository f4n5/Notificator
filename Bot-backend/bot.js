require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const axios = require('axios');
const { Pool } = require('pg');
const http = require('http');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const ROBLOX_API = 'https://clientsettings.roblox.com/v2/client-version/WindowsPlayer/channel/LIVE';
const POLL_INTERVAL = 60 * 1000;
let lastVersion = null;

// --- DB HELPERS ---
async function getAllConfigs() {
  const r = await pool.query('SELECT guild_id, config FROM guild_configs');
  return r.rows;
}

async function getGuildConfig(guildId) {
  const r = await pool.query('SELECT config FROM guild_configs WHERE guild_id = $1', [guildId]);
  return r.rows[0]?.config || {};
}

async function saveGuildConfig(guildId, config) {
  await pool.query(
    `INSERT INTO guild_configs (guild_id, config, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (guild_id) DO UPDATE SET config = $2, updated_at = NOW()`,
    [guildId, config]
  );
}

// --- SEND HELPER ---
async function sendToGuild(guildId, config, embed) {
  if (!config.channel) return;
  try {
    const channel = await client.channels.fetch(config.channel).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    
    let content = '';
    if (config.role && config.role !== 'none') {
      content = config.role.startsWith('<@&') ? config.role : `<@&${config.role}>`;
    }

    await channel.send({ content, embeds: [embed] });
    console.log(`[ALERT] sent to ${guildId} in #${channel.name}`);
  } catch (err) {
    console.error(`[ERROR] send fail ${guildId}:`, err.message);
  }
}

// --- ROBLOX POLLER ---
async function checkUpdates() {
  try {
    const res = await axios.get(ROBLOX_API, { timeout: 10000 });
    const currentVersion = res.data.clientVersionUpload;

    if (lastVersion && currentVersion !== lastVersion) {
      console.log(`[POLLER] new roblox version: ${currentVersion}`);
      const configs = await getAllConfigs();
      
      for (const row of configs) {
        if (row.config.updates === false) continue;
        
        const embed = new EmbedBuilder()
          .setTitle('🔄 Roblox Update Detected')
          .setDescription('A new client build is live on the LIVE channel.')
          .addFields({ name: 'Version', value: `\`${currentVersion}\`` })
          .setColor('#6bc8ff')
          .setTimestamp();
          
        await sendToGuild(row.guild_id, row.config, embed);
      }
    }
    lastVersion = currentVersion;
  } catch (err) {
    console.error('[POLLER ERROR]', err.message);
  }
}

// --- HTTP CONTROL (for website webhooks) ---
const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/banwave') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        if (data.secret !== process.env.WEBHOOK_SECRET) {
          res.writeHead(403); return res.end('unauthorized');
        }
        
        const configs = await getAllConfigs();
        for (const row of configs) {
          if (row.config.banwaves === false) continue;
          
          const embed = new EmbedBuilder()
            .setTitle('⚠️ BANWAVE DETECTED')
            .setDescription(data.message || 'Mass detection event in progress. Lock in.')
            .setColor('#ff3b5c')
            .setTimestamp();
            
          await sendToGuild(row.guild_id, row.config, embed);
        }
        res.writeHead(200); res.end('ok');
      } catch (e) {
        res.writeHead(500); res.end('err');
      }
    });
  } else {
    res.writeHead(404); res.end();
  }
});

// --- BOT READY & SLASH COMMANDS ---
client.once('ready', async () => {
  console.log(`[BOT] Online as ${client.user.tag}`);

  const commands = [
    new SlashCommandBuilder()
      .setName('setup')
      .setDescription('Set the channel for RBX Watch alerts')
      .addChannelOption(opt => opt.setName('channel').setDescription('The channel to send alerts').setRequired(true))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName('toggle')
      .setDescription('Turn updates or banwave alerts on/off')
      .addStringOption(opt => opt.setName('type').setDescription('What to toggle').setRequired(true).addChoices({ name: 'Updates', value: 'updates' }, { name: 'Banwaves', value: 'banwaves' }))
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
    new SlashCommandBuilder()
      .setName('banwave')
      .setDescription('Force send a test banwave alert to this server')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  ];

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('[BOT] Slash commands registered.');
  } catch (error) {
    console.error(error);
  }

  checkUpdates();
  setInterval(checkUpdates, POLL_INTERVAL);
});

// --- INTERACTION HANDLER ---
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const config = await getGuildConfig(interaction.guildId);

  if (interaction.commandName === 'setup') {
    const channel = interaction.options.getChannel('channel');
    config.channel = channel.id;
    await saveGuildConfig(interaction.guildId, config);
    await interaction.reply({ content: `✅ Alerts will now be sent to <#${channel.id}>.`, ephemeral: true });
  }

  if (interaction.commandName === 'toggle') {
    const type = interaction.options.getString('type');
    const currentState = config[type] !== false;
    config[type] = !currentState;
    await saveGuildConfig(interaction.guildId, config);
    await interaction.reply({ content: `✅ **${type}** alerts are now **${config[type] ? 'ON' : 'OFF'}**.`, ephemeral: true });
  }

  if (interaction.commandName === 'banwave') {
    if (!config.channel) {
      return interaction.reply({ content: '❌ You need to set a channel first. Use `/setup`.', ephemeral: true });
    }
    await interaction.deferReply({ ephemeral: true });
    const embed = new EmbedBuilder()
      .setTitle('⚠️ BANWAVE DETECTED')
      .setDescription('This is a manual test alert triggered from Discord.')
      .setColor('#ff3b5c')
      .setTimestamp();
    await sendToGuild(interaction.guildId, config, embed);
    await interaction.editReply({ content: '✅ Test banwave sent!' });
  }
});

server.listen(process.env.PORT || 8080, () => {
  console.log(`[HTTP] Control server on port ${process.env.PORT || 8080}`);
});
client.login(process.env.DISCORD_BOT_TOKEN);
