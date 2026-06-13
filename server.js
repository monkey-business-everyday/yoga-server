
const express    = require('express');
const { Pool }   = require('pg');
const nodemailer = require('nodemailer');
const twilio     = require('twilio');
const cors       = require('cors');
const path       = require('path');

const app  = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // admin dashboard

// ── Database ──────────────────────────────────────────────────────────────────
const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS slots (
      id          SERIAL PRIMARY KEY,
      day_of_week INT,           -- 0=Sun..6=Sat, NULL = one-off
      start_time  TIME NOT NULL,
      date        DATE,          -- NULL for recurring, set for one-offs
      activity    TEXT NOT NULL,
      capacity    INT  DEFAULT 1,
      active      BOOL DEFAULT TRUE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id           SERIAL PRIMARY KEY,
      slot_id      INT REFERENCES slots(id),
      email        TEXT,
      whatsapp     TEXT,
      activity     TEXT NOT NULL,
      session_date DATE NOT NULL,
      session_time TIME NOT NULL,
      status       TEXT DEFAULT 'confirmed', -- confirmed | cancelled
      reminder_sent BOOL DEFAULT FALSE,
      booked_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('DB ready');
}

// ── Notifications ─────────────────────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

const sms = twilio(process.env.TWILIO_SID, process.env.TWILIO_TOKEN);

async function sendEmail(to, subject, html) {
  if (!to || !process.env.EMAIL_USER) return;
  await mailer.sendMail({ from: `"Evryday Evrywhr Yoga" <${process.env.EMAIL_USER}>`, to, subject, html });
  console.log('Email →', to);
}

async function sendWhatsApp(to, body) {
  if (!to || !process.env.TWILIO_SID) return;
  await sms.messages.create({ from: process.env.TWILIO_WHATSAPP, to: `whatsapp:${to}`, body });
  console.log('WhatsApp →', to);
}

// ── Reminder scheduler — runs every 15 min ────────────────────────────────────
async function sendDueReminders() {
  const { rows } = await db.query(`
    SELECT b.* FROM bookings b
    WHERE b.status = 'confirmed'
      AND b.reminder_sent = FALSE
      AND (b.session_date + b.session_time) BETWEEN NOW() + INTERVAL '1h 45m'
                                                 AND NOW() + INTERVAL '2h 15m'
  `);
  for (const b of rows) {
    const msg = `⏰ Reminder: your "${b.activity}" session starts in ~2 hours! See you soon 🧘`;
    const html = `<h3>⏰ Session Reminder</h3><p>Your <strong>${b.activity}</strong> session starts in about 2 hours.</p><p>See you soon! 🧘‍♀️</p>`;
    try {
      await sendEmail(b.email, '⏰ Session Reminder', html);
      await sendWhatsApp(b.whatsapp, msg);
      await db.query('UPDATE bookings SET reminder_sent=TRUE WHERE id=$1', [b.id]);
    } catch (e) { console.error('Reminder failed:', e.message); }
  }
}
setInterval(sendDueReminders, 15 * 60 * 1000); // every 15 min

// ══ API ROUTES ════════════════════════════════════════════════════════════════

// ── GET /slots — available slots for next 4 weeks ────────────────────────────
app.get('/slots', async (req, res) => {
  try {
    // Generate recurring slots for next 28 days
    const { rows: recurring } = await db.query(`
      SELECT * FROM slots WHERE day_of_week IS NOT NULL AND active = TRUE
    `);
    const { rows: oneoffs } = await db.query(`
      SELECT * FROM slots
      WHERE day_of_week IS NULL AND active = TRUE AND date >= CURRENT_DATE
    `);

    const slots = [];
    const today = new Date();

    // Expand recurring slots for next 28 days
    for (let d = 0; d < 28; d++) {
      const date = new Date(today);
      date.setDate(today.getDate() + d);
      const dow = date.getDay();
      for (const s of recurring) {
        if (s.day_of_week === dow) {
          const dateStr = date.toISOString().split('T')[0];
          // Check bookings count vs capacity
          const { rows: booked } = await db.query(
            `SELECT COUNT(*) FROM bookings WHERE slot_id=$1 AND session_date=$2 AND status='confirmed'`,
            [s.id, dateStr]
          );
          if (parseInt(booked[0].count) < s.capacity) {
            slots.push({ ...s, date: dateStr, type: 'recurring' });
          }
        }
      }
    }

    // Add one-off slots
    for (const s of oneoffs) {
      const { rows: booked } = await db.query(
        `SELECT COUNT(*) FROM bookings WHERE slot_id=$1 AND session_date=$2 AND status='confirmed'`,
        [s.id, s.date]
      );
      if (parseInt(booked[0].count) < s.capacity) {
        slots.push({ ...s, type: 'oneoff' });
      }
    }

    // Sort by date then time
    slots.sort((a, b) => `${a.date}${a.start_time}`.localeCompare(`${b.date}${b.start_time}`));
    res.json(slots);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /book — create a booking ────────────────────────────────────────────
app.post('/book', async (req, res) => {
  const { slot_id, email, whatsapp, activity, session_date, session_time } = req.body;
  if (!email && !whatsapp) return res.status(400).json({ error: 'Email or WhatsApp required' });
  if (!activity)           return res.status(400).json({ error: 'Activity required' });

  try {
    // Check slot still has capacity
    if (slot_id) {
      const { rows: booked } = await db.query(
        `SELECT COUNT(*) FROM bookings WHERE slot_id=$1 AND session_date=$2 AND status='confirmed'`,
        [slot_id, session_date]
      );
      const { rows: slot } = await db.query('SELECT * FROM slots WHERE id=$1', [slot_id]);
      if (slot.length && parseInt(booked[0].count) >= slot[0].capacity) {
        return res.status(409).json({ error: 'Slot is fully booked' });
      }
    }

    const { rows } = await db.query(
      `INSERT INTO bookings (slot_id, email, whatsapp, activity, session_date, session_time)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [slot_id || null, email || null, whatsapp || null, activity, session_date, session_time]
    );
    const booking = rows[0];

    // Send confirmation
    const html = `
      <h2>🐒 Session Confirmed!</h2>
      <p>Your <strong>${activity}</strong> session is booked for
         <strong>${session_date} at ${session_time}</strong>.</p>
      <p>You'll get a reminder 2 hours before. See you soon! 🧘</p>
      <p style="color:#999;font-size:12px">Booking ID: ${booking.id}</p>
    `;
    const msg = `🐒 Confirmed! "${activity}" on ${session_date} at ${session_time}. Reminder coming 2hrs before. See you! 🧘`;
    await sendEmail(email, '✅ Session Confirmed!', html);
    await sendWhatsApp(whatsapp, msg);

    res.json({ success: true, bookingId: booking.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /cancel — cancel a booking ──────────────────────────────────────────
app.post('/cancel', async (req, res) => {
  const { bookingId } = req.body;
  try {
    const { rows } = await db.query(
      `UPDATE bookings SET status='cancelled' WHERE id=$1 RETURNING *`, [bookingId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Booking not found' });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: POST /admin/slots — add a slot ────────────────────────────────────
app.post('/admin/slots', async (req, res) => {
  const { day_of_week, start_time, date, activity, capacity } = req.body;
  // Simple admin key check — replace with proper auth later
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { rows } = await db.query(
      `INSERT INTO slots (day_of_week, start_time, date, activity, capacity)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [day_of_week || null, start_time, date || null, activity, capacity || 1]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: DELETE /admin/slots/:id — deactivate a slot ───────────────────────
app.delete('/admin/slots/:id', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    await db.query('UPDATE slots SET active=FALSE WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: GET /admin/bookings — all bookings ─────────────────────────────────
app.get('/admin/bookings', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { rows } = await db.query(
      `SELECT * FROM bookings ORDER BY session_date DESC, session_time DESC`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok 🧘' }));

// ── Start ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(process.env.PORT || 3000, () =>
    console.log(`Server on port ${process.env.PORT || 3000}`)
  );
});