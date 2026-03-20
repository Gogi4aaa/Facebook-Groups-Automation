const express   = require('express');
const cors      = require('cors');
const path      = require('path');
const fs        = require('fs');
const initSqlJs = require('sql.js');
const webpush   = require('web-push');

const PORT = process.env.PORT || 3001;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'posts.db');

// ── VAPID ключове за Web Push ─────────────────────────────────
// Генерират се веднъж и се пазят в env variables
let VAPID_PUBLIC, VAPID_PRIVATE;
if (process.env.VAPID_PUBLIC && process.env.VAPID_PRIVATE) {
  VAPID_PUBLIC  = process.env.VAPID_PUBLIC;
  VAPID_PRIVATE = process.env.VAPID_PRIVATE;
} else {
  // Локално — генерираме и записваме в .env.local
  const vapidFile = path.join(__dirname, '.vapid.json');
  if (fs.existsSync(vapidFile)) {
    const v = JSON.parse(fs.readFileSync(vapidFile));
    VAPID_PUBLIC  = v.public;
    VAPID_PRIVATE = v.private;
  } else {
    const keys = webpush.generateVAPIDKeys();
    VAPID_PUBLIC  = keys.publicKey;
    VAPID_PRIVATE = keys.privateKey;
    fs.writeFileSync(vapidFile, JSON.stringify({ public: VAPID_PUBLIC, private: VAPID_PRIVATE }));
    console.log('\n📋 VAPID ключове генерирани — добави ги в Railway env variables:');
    console.log(`VAPID_PUBLIC=${VAPID_PUBLIC}`);
    console.log(`VAPID_PRIVATE=${VAPID_PRIVATE}\n`);
  }
}

webpush.setVapidDetails(
  'mailto:admin@fbmonitor.local',
  VAPID_PUBLIC,
  VAPID_PRIVATE
);

// ── База данни ────────────────────────────────────────────────
let db;

async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS posts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id     TEXT UNIQUE,
      author_name TEXT,
      author_url  TEXT,
      text        TEXT,
      post_url    TEXT,
      group_name  TEXT,
      group_url   TEXT,
      captured_at TEXT,
      seen        INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT UNIQUE,
      data     TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_group ON posts(group_name);
    CREATE INDEX IF NOT EXISTS idx_seen  ON posts(seen);
  `);
  saveDb();
}

function saveDb() {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function dbAll(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  } catch(e) { console.error(e); return []; }
}

function dbGet(sql, params = []) { return dbAll(sql, params)[0] || null; }
function dbRun(sql, params = []) { db.run(sql, params); saveDb(); }

// ── Express ───────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Web Push endpoints ────────────────────────────────────────

// Връща публичния VAPID ключ на клиента
app.get('/api/vapid-public', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC });
});

// Клиентът се абонира за push нотификации
app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint) return res.status(400).json({ error: 'Невалиден subscription' });
  dbRun(
    `INSERT OR REPLACE INTO push_subscriptions (endpoint, data) VALUES (?, ?)`,
    [sub.endpoint, JSON.stringify(sub)]
  );
  console.log('[Push] Нов абонат:', sub.endpoint.slice(0, 50) + '...');
  res.json({ ok: true });
});

// Изпраща push до всички абонати
async function sendPushToAll(payload) {
  const subs = dbAll(`SELECT data FROM push_subscriptions`);
  for (const row of subs) {
    try {
      const sub = JSON.parse(row.data);
      await webpush.sendNotification(sub, JSON.stringify(payload));
    } catch(e) {
      if (e.statusCode === 410) {
        // Абонатът е изтрит от устройството
        dbRun(`DELETE FROM push_subscriptions WHERE data LIKE ?`, [`%${JSON.parse(row.data).endpoint}%`]);
      }
    }
  }
}

// ── Posts API ─────────────────────────────────────────────────

app.post('/api/posts', async (req, res) => {
  const { post_id, author_name, author_url, text, post_url, group_name, group_url, captured_at } = req.body;
  if (!post_id || !text) return res.status(400).json({ error: 'Липсват данни' });

  const existing = dbGet('SELECT id FROM posts WHERE post_id = ?', [post_id]);
  if (!existing) {
    dbRun(
      `INSERT INTO posts (post_id, author_name, author_url, text, post_url, group_name, group_url, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [post_id, author_name, author_url, text, post_url, group_name, group_url, captured_at]
    );
    console.log(`[+] ${author_name} в "${group_name}"`);

    // Изпрати push нотификация
    sendPushToAll({
      title: `${author_name} в ${group_name}`,
      body: text.slice(0, 120),
      url: post_url || '/'
    });

    // SSE push към dashboard
    const data = `data: ${JSON.stringify({ post_id, author_name, text, group_name, post_url, captured_at })}\n\n`;
    sseClients.forEach(c => c.write(data));

    return res.json({ ok: true, inserted: true });
  }
  res.json({ ok: true, inserted: false });
});

app.get('/api/posts', (req, res) => {
  const { q, group, seen, page = 1, limit = 50 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  let where = [], params = [];
  if (q) { where.push(`(text LIKE ? OR author_name LIKE ?)`); params.push(`%${q}%`, `%${q}%`); }
  if (group) { where.push(`group_name = ?`); params.push(group); }
  if (seen !== undefined) { where.push(`seen = ?`); params.push(seen === 'true' ? 1 : 0); }
  const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (dbGet(`SELECT COUNT(*) as c FROM posts ${whereSQL}`, params) || {}).c || 0;
  const posts = dbAll(`SELECT * FROM posts ${whereSQL} ORDER BY captured_at DESC LIMIT ? OFFSET ?`, [...params, parseInt(limit), offset]);
  res.json({ total, page: parseInt(page), posts });
});

app.patch('/api/posts/:id/seen', (req, res) => {
  dbRun(`UPDATE posts SET seen = ? WHERE id = ?`, [req.body.seen ? 1 : 0, parseInt(req.params.id)]);
  res.json({ ok: true });
});

app.delete('/api/posts/:id', (req, res) => {
  dbRun(`DELETE FROM posts WHERE id = ?`, [parseInt(req.params.id)]);
  res.json({ ok: true });
});

app.get('/api/groups', (req, res) => {
  res.json(dbAll(`SELECT group_name, COUNT(*) as count FROM posts GROUP BY group_name ORDER BY count DESC`));
});

app.get('/api/status', (req, res) => {
  const total  = (dbGet(`SELECT COUNT(*) as c FROM posts`) || {}).c || 0;
  const unseen = (dbGet(`SELECT COUNT(*) as c FROM posts WHERE seen = 0`) || {}).c || 0;
  res.json({ total, unseen, ok: true });
});

// ── SSE ───────────────────────────────────────────────────────
const sseClients = new Set();

app.get('/api/live', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// ── Service Worker за PWA ─────────────────────────────────────
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// ── Start ─────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ Сървърът работи на порт ${PORT}`);
  });
});
