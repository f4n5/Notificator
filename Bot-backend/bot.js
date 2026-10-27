require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
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

// --- shared helper ---
async function getAllConfigs() {
  const r = await pool.query('SELECT guild_id, config FROM guild_configs');
  return r.rows;
}

async function getGuildConfig(guildId) {
  const r = await pool.query('SELECT config FROM guild_configs WHERE guild_id = $1', [guildId]);
  return r.rows[0]?.config || {};
}

// --- send to one guild ---
async function sendToGuild(guildId, config, embed) {
  if (!config.channel) return;
  try {
    const channel = await client.channels.fetch(config.channel).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    await channel.send({
      content: config.role && config.role !== 'none' ? config.role : '',
      embeds: [embed]
    });
    console.log(`sent -> ${guildId} #${channel.name}`);
  } catch (err) {
    console.error(`send fail ${guildId}:`, err.message);
  }
}

// --- update poller ---
async function checkUpdates() {
  try {
    const res = await axios.get(ROBLOX_API, { timeout: 10000 });
    const currentVersion = res.data.clientVersionUpload;

    if (lastVersion && currentVersion !== lastVersion) {
      console.log(`new version: ${currentVersion}`);
      const configs = await getAllConfigs();
      for (const row of configs) {
        if (row.config.updates === false) continue;
        const embed = new EmbedBuilder()
          .setTitle('🔄 roblox update detected')
          .setDescription('new client build live on LIVE channel')
          .addFields({ name: 'version', value: `\`${currentVersion}\`` })
          .setColor('#6bc8ff')
          .setTimestamp();
        await sendToGuild(row.guild_id, row.config, embed);
      }
    }
    lastVersion = currentVersion;
  } catch (err) {
    console.error('roblox api:', err.message);
  }
}

// --- HTTP endpoint so you can manually fire banwave alerts ---
// POST http://bot-host:port/banwave  with { "secret": "yoursecret", "message": "optional text" }
const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/banwave') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        if (data.secret !== process.env.WEBHOOK_SECRET) {
          res.writeHead(403); return res.end('nope');
        }
        const configs = await getAllConfigs();
        for (const row of configs) {
          if (row.config.banwaves === false) continue;
          const embed = new EmbedBuilder()
            .setTitle('⚠️ BANWAVE DETECTED')
            .setDescription(data.message || 'mass detection event in progress. lock in.')
            .setColor('#ff3b5c')
            .setTimestamp();
          await sendToGuild(row.guild_id, row.config, embed);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, guilds: configs.length }));
      } catch (e) {
        res.writeHead(500); res.end('err');
      }
    });
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200); res.end('ok');
  } else {
    res.writeHead(404); res.end();
  }
});

server.listen(process.env.PORT || 8080, () => {
  console.log(`http control on ${process.env.PORT || 8080}`);
});

// --- discord ready ---
client.once('ready', () => {
  console.log(`bot online: ${client.user.tag}`);
  checkUpdates();
  setInterval(checkUpdates, POLL_INTERVAL);
});

// --- bot slash commands for setting channel/role from inside discord ---
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'setchannel') {
    const channel = interaction.options.getChannel('channel');
    const cfg = await getGuildConfig(interaction.guildId);
    cfg.channel = channel.id;
    await pool.query(
      `INSERT INTO guild_configs (guild_id, config, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (guild_id) DO UPDATE SET config = $2, updated_at = NOW()`,
      [interaction.guildId, cfg]
    );
    await interaction.reply({ content: `alerts -> <#${channel.id}>`, ephemeral: true });
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
