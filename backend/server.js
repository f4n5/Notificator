require('dotenv').config();
const express = require('express');
const axios = require('axios');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const path = require('path');

const app = express();

// Postgres pool — shared with the bot
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Create config table if it doesn't exist
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_configs (
      guild_id TEXT PRIMARY KEY,
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('db ready');
}
initDb().catch(err => console.error('db init failed:', err.message));

// Middleware
app.use(express.json());
app.use(session({
  store: new PgSession({ pool, tableName: 'session' }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

// 1. Kick off OAuth
app.get('/auth/discord', (req, res) => {
  const url = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify%20guilds`;
  res.redirect(url);
});

// 2. OAuth callback
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('no code');
  try {
    const tokenRes = await axios.post('https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const { access_token } = tokenRes.data;

    const [userRes, guildsRes] = await Promise.all([
      axios.get('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${access_token}` } }),
      axios.get('https://discord.com/api/users/@me/guilds', { headers: { Authorization: `Bearer ${access_token}` } })
    ]);

    req.session.user = {
      id: userRes.data.id,
      username: userRes.data.username,
      avatar: userRes.data.avatar
    };
    // only guilds where user has MANAGE_GUILD (0x20)
    req.session.guilds = guildsRes.data.filter(g => (BigInt(g.permissions) & 0x20n) === 0x20n);

    res.redirect('/dashboard.html');
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send('oauth failed');
  }
});

// 3. Who am I
app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
  res.json({ user: req.session.user, guilds: req.session.guilds });
});

// 4. Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// 5. Save config
app.post('/api/config/:guildId', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
  const { guildId } = req.params;
  const userGuilds = req.session.guilds.map(g => g.id);
  if (!userGuilds.includes(guildId)) return res.status(403).json({ error: 'not in guild' });

  try {
    await pool.query(
      `INSERT INTO guild_configs (guild_id, config, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (guild_id) DO UPDATE SET config = $2, updated_at = NOW()`,
      [guildId, req.body]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'save failed' });
  }
});

// 6. Load config
app.get('/api/config/:guildId', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
  try {
    const r = await pool.query('SELECT config FROM guild_configs WHERE guild_id = $1', [req.params.guildId]);
    res.json(r.rows[0]?.config || {});
  } catch (err) {
    res.status(500).json({ error: 'load failed' });
  }
});

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`web on ${PORT}`));
