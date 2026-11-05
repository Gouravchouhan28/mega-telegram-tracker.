require("dotenv").config();

const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");

const required = [
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_BOT_USERNAME",
  "TELEGRAM_CHANNEL_ID",
  "TELEGRAM_WEBHOOK_SECRET",
  "PUBLIC_URL",
  "ADMIN_USER",
  "ADMIN_PASSWORD"
];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error("Missing required environment variables:", missing.join(", "));
  process.exit(1);
}

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "30kb" }));

const allowedOrigin = process.env.ALLOWED_ORIGIN;
app.use(cors({
  origin(origin, callback) {
    // Allow server-to-server requests with no Origin, plus the exact Pages origin.
    if (!origin || origin === allowedOrigin) return callback(null, true);
    return callback(new Error("Origin not allowed"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Telegram-Bot-Api-Secret-Token"]
}));

const dbPath = process.env.DATABASE_PATH || "./mega-tracker.sqlite";
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS clicks (
  id TEXT PRIMARY KEY,
  fbp TEXT,
  fbc TEXT,
  ip TEXT,
  ua TEXT,
  page_url TEXT,
  utm_source TEXT,
  utm_campaign TEXT,
  utm_adset TEXT,
  utm_ad TEXT,
  fbclid TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trackers (
  token TEXT PRIMARY KEY,
  click_id TEXT NOT NULL,
  telegram_user_id TEXT,
  invite_link TEXT UNIQUE,
  bot_started_at INTEGER,
  joined_at INTEGER,
  botstart_sent INTEGER NOT NULL DEFAULT 0,
  lead_sent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(click_id) REFERENCES clicks(id)
);
CREATE TABLE IF NOT EXISTS capi_queue (
  id TEXT PRIMARY KEY,
  event_name TEXT NOT NULL,
  event_time INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  click_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER,
  FOREIGN KEY(click_id) REFERENCES clicks(id)
);
CREATE INDEX IF NOT EXISTS idx_clicks_created ON clicks(created_at);
CREATE INDEX IF NOT EXISTS idx_trackers_click ON trackers(click_id);
`);

const insertClick = db.prepare(`
INSERT INTO clicks
(id, fbp, fbc, ip, ua, page_url, utm_source, utm_campaign, utm_adset, utm_ad, fbclid, created_at)
VALUES (@id, @fbp, @fbc, @ip, @ua, @page_url, @utm_source, @utm_campaign, @utm_adset, @utm_ad, @fbclid, @created_at)
`);
const findTracker = db.prepare("SELECT * FROM trackers WHERE token = ?");
const findClick = db.prepare("SELECT * FROM clicks WHERE id = ?");
const addQueue = db.prepare(`
INSERT OR IGNORE INTO capi_queue
(id,event_name,event_time,event_id,click_id,status,created_at)
VALUES (?,?,?,?,?,'pending',?)
`);

const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const webhookLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });

function basicAuth(req, res, next) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="MEGA Tracker Admin"');
    return res.status(401).send("Authentication required");
  }
  let decoded = "";
  try { decoded = Buffer.from(header.slice(6), "base64").toString("utf8"); } catch {}
  const separator = decoded.indexOf(":");
  const user = decoded.slice(0, separator);
  const pass = decoded.slice(separator + 1);
  const safeEqual = (a, b) => {
    const aa = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
  };
  if (separator < 0 || !safeEqual(user, process.env.ADMIN_USER) ||
      !safeEqual(pass, process.env.ADMIN_PASSWORD)) {
    return res.status(401).send("Invalid credentials");
  }
  next();
}

async function telegram(method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.description || `Telegram ${method} failed`);
  return body.result;
}

function enqueueMetaEvent(eventName, eventTime, eventId, clickId) {
  addQueue.run(crypto.randomUUID(), eventName, eventTime, eventId, clickId, Math.floor(Date.now() / 1000));
}

async function sendPendingMetaEvents() {
  if (!process.env.META_PIXEL_ID || !process.env.META_ACCESS_TOKEN ||
      !process.env.META_GRAPH_VERSION || process.env.META_GRAPH_VERSION.includes("XX")) return;

  const pending = db.prepare(`
    SELECT q.*, c.fbp, c.fbc, c.ip, c.ua, c.page_url
    FROM capi_queue q JOIN clicks c ON c.id=q.click_id
    WHERE q.status='pending' AND q.attempts < 8
    ORDER BY q.created_at ASC LIMIT 25
  `).all();

  for (const item of pending) {
    try {
      const userData = {};
      if (item.fbp) userData.fbp = item.fbp;
      if (item.fbc) userData.fbc = item.fbc;
      if (item.ip) userData.client_ip_address = item.ip;
      if (item.ua) userData.client_user_agent = item.ua;

      const payload = {
        data: [{
          event_name: item.event_name,
          event_time: item.event_time,
          event_id: item.event_id,
          action_source: "chat",
          event_source_url: item.page_url || process.env.PUBLIC_URL,
          user_data: userData
        }]
      };

      const url = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION}/${process.env.META_PIXEL_ID}/events?access_token=${encodeURIComponent(process.env.META_ACCESS_TOKEN)}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      const result = await response.json();
      if (!response.ok || result.error) throw new Error(result.error?.message || "Meta CAPI request failed");

      db.prepare("UPDATE capi_queue SET status='sent', sent_at=?, attempts=attempts+1, last_error=NULL WHERE id=?")
        .run(Math.floor(Date.now() / 1000), item.id);
    } catch (error) {
      db.prepare("UPDATE capi_queue SET attempts=attempts+1, last_error=? WHERE id=?")
        .run(String(error.message).slice(0, 500), item.id);
    }
  }
}

function isMember(member) {
  if (!member) return false;
  if (["member", "administrator", "creator"].includes(member.status)) return true;
  return member.status === "restricted" && member.is_member === true;
}

app.get("/health", (req, res) => res.json({ ok: true, service: "mega-telegram-tracker" }));

// Called by your GitHub Pages landing page. Each click receives its own bot start token.
app.post("/api/telegram-link", apiLimiter, (req, res) => {
  const body = req.body || {};
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(20).toString("hex");
  const now = Math.floor(Date.now() / 1000);

  const safeText = (value, max = 500) =>
    typeof value === "string" ? value.slice(0, max) : null;

  const fbp = safeText(body.fbp, 200);
  const fbc = safeText(body.fbc, 200);
  const fbclid = safeText(body.fbclid, 500);
  const pageUrl = safeText(body.page_url, 1500);
  const pageOrigin = (() => {
    try { return new URL(pageUrl).origin; } catch { return ""; }
  })();
  if (pageOrigin && pageOrigin !== allowedOrigin) {
    return res.status(400).json({ error: "Invalid page origin" });
  }

  insertClick.run({
    id, fbp, fbc,
    ip: req.ip || null,
    ua: safeText(req.get("user-agent"), 1000),
    page_url: pageUrl || allowedOrigin,
    utm_source: safeText(body.utm_source, 200),
    utm_campaign: safeText(body.utm_campaign, 300),
    utm_adset: safeText(body.utm_adset, 300),
    utm_ad: safeText(body.utm_ad, 300),
    fbclid, created_at: now
  });

  db.prepare("INSERT INTO trackers (token,click_id,created_at) VALUES (?,?,?)")
    .run(token, id, now);

  res.json({
    url: `https://t.me/${process.env.TELEGRAM_BOT_USERNAME.replace(/^@/, "")}?start=${token}`
  });
});

// Telegram webhook. Telegram must be configured with allowed_updates including chat_member.
app.post("/telegram-webhook", webhookLimiter, async (req, res) => {
  if (req.get("X-Telegram-Bot-Api-Secret-Token") !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.sendStatus(403);
  }

  try {
    const update = req.body || {};
    const message = update.message;

    if (message?.text && message.text.startsWith("/start")) {
      const token = message.text.trim().split(/\s+/)[1];
      if (token && /^[a-f0-9]{40}$/.test(token)) {
        const tracker = findTracker.get(token);
        if (tracker && !tracker.bot_started_at) {
          const now = Math.floor(Date.now() / 1000);
          const telegramUserId = String(message.from.id);
          const invite = await telegram("createChatInviteLink", {
            chat_id: process.env.TELEGRAM_CHANNEL_ID,
            name: `MEGA-${token.slice(0, 12)}`,
            member_limit: 1,
            expire_date: now + 86400
          });

          db.prepare(`
            UPDATE trackers SET telegram_user_id=?, bot_started_at=?, invite_link=?, botstart_sent=1
            WHERE token=? AND bot_started_at IS NULL
          `).run(telegramUserId, now, invite.invite_link, token);

          const click = findClick.get(tracker.click_id);
          if (click) enqueueMetaEvent("BotStart", now, `botstart_${token}`, click.id);

          await telegram("sendMessage", {
            chat_id: message.chat.id,
            text: "Welcome! Tap the button below to join our private Telegram channel.",
            reply_markup: {
              inline_keyboard: [[{ text: "Join Private Channel", url: invite.invite_link }]]
            }
          });
        } else if (tracker) {
          await telegram("sendMessage", {
            chat_id: message.chat.id,
            text: "Your tracking invite was already created. Please use the private channel invite message above."
          });
        }
      }
    }

    const memberUpdate = update.chat_member;
    if (memberUpdate &&
        String(memberUpdate.chat.id) === String(process.env.TELEGRAM_CHANNEL_ID) &&
        !isMember(memberUpdate.old_chat_member) &&
        isMember(memberUpdate.new_chat_member) &&
        memberUpdate.invite_link?.invite_link) {

      const tracker = db.prepare("SELECT * FROM trackers WHERE invite_link=?")
        .get(memberUpdate.invite_link.invite_link);

      if (tracker && !tracker.joined_at) {
        const now = Number(memberUpdate.date) || Math.floor(Date.now() / 1000);
        db.prepare("UPDATE trackers SET joined_at=?, lead_sent=1 WHERE token=? AND joined_at IS NULL")
          .run(now, tracker.token);
        enqueueMetaEvent("Lead", now, `lead_${tracker.token}`, tracker.click_id);
      }
    }

    await sendPendingMetaEvents();
    return res.sendStatus(200);
  } catch (error) {
    console.error("Webhook processing error:", error.message);
    return res.sendStatus(500);
  }
});

// Admin dashboard data. Protect with HTTP Basic Auth; use HTTPS only.
app.get("/admin/api/stats", basicAuth, (req, res) => {
  const counts = {
    landingClicks: db.prepare("SELECT COUNT(*) n FROM clicks").get().n,
    botStarts: db.prepare("SELECT COUNT(*) n FROM trackers WHERE bot_started_at IS NOT NULL").get().n,
    verifiedJoins: db.prepare("SELECT COUNT(*) n FROM trackers WHERE joined_at IS NOT NULL").get().n,
    pendingMeta: db.prepare("SELECT COUNT(*) n FROM capi_queue WHERE status='pending'").get().n,
    sentMeta: db.prepare("SELECT COUNT(*) n FROM capi_queue WHERE status='sent'").get().n
  };
  const campaigns = db.prepare(`
    SELECT c.utm_campaign campaign, c.utm_adset adset, c.utm_ad ad,
      COUNT(DISTINCT c.id) clicks,
      COUNT(DISTINCT CASE WHEN t.bot_started_at IS NOT NULL THEN t.token END) bot_starts,
      COUNT(DISTINCT CASE WHEN t.joined_at IS NOT NULL THEN t.token END) joins
    FROM clicks c LEFT JOIN trackers t ON t.click_id=c.id
    GROUP BY c.utm_campaign,c.utm_adset,c.utm_ad
    ORDER BY clicks DESC LIMIT 100
  `).all();
  res.json({ counts, campaigns });
});

app.get("/admin", (req, res) => {
  res.sendFile(require("path").join(__dirname, "public", "admin.html"));
});

app.get("/", (req, res) => res.type("text").send("MEGA Telegram Tracker is running. Admin: /admin"));

setInterval(() => {
  sendPendingMetaEvents().catch((err) => console.error("Meta retry error:", err.message));
}, 30000).unref();

const port = Number(process.env.PORT || 10000);
app.listen(port, () => console.log(`MEGA tracker listening on ${port}`));
