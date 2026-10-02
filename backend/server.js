const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const SECRET = process.env.JWT_SECRET || 'mentorminute_dev_secret';
const PLATFORM_CUT = 0.2; // platform keeps 20%, guide gets 80%
const PORT = process.env.PORT || 5000;
const RZP_ID = process.env.RAZORPAY_KEY_ID;
const RZP_SECRET = process.env.RAZORPAY_KEY_SECRET;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ---------- helpers ----------
const now = () => new Date().toISOString();
const r2 = n => Math.round(n * 100) / 100;
const sign = u => jwt.sign({ id: u.id, role: u.role }, SECRET, { expiresIn: '7d' });

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

// billing: per started minute, minimum 1 minute
function calc(s) {
  const end = s.end_time ? new Date(s.end_time) : new Date();
  const secs = Math.max(0, Math.floor((end - new Date(s.start_time)) / 1000));
  const minutes = Math.max(1, Math.ceil(secs / 60));
  return { secs, minutes, cost: r2(minutes * s.rate) };
}

// ends a session and moves money (atomic transaction)
const endTx = db.transaction(id => {
  const s = db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
  if (!s || s.status !== 'active') return s;
  const end = now();
  const { minutes, cost } = calc({ ...s, end_time: end });
  const seeker = db.prepare('SELECT balance FROM users WHERE id=?').get(s.seeker_id);
  const amount = r2(Math.min(cost, seeker.balance));
  const guideShare = r2(amount * (1 - PLATFORM_CUT));

  db.prepare('UPDATE users SET balance = balance - ? WHERE id=?').run(amount, s.seeker_id);
  db.prepare('UPDATE users SET balance = balance + ? WHERE id=?').run(guideShare, s.guide_id);
  db.prepare("UPDATE sessions SET status='ended', end_time=?, minutes=?, amount=? WHERE id=?")
    .run(end, minutes, amount, id);

  const ins = db.prepare('INSERT INTO transactions(user_id,type,amount,session_id,created_at) VALUES (?,?,?,?,?)');
  ins.run(s.seeker_id, 'debit', amount, id, end);
  ins.run(s.guide_id, 'credit', guideShare, id, end);
  return db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
});

function finishSession(id) {
  const s = endTx(id);
  io.to('session:' + id).emit('ended', { id });
  return s;
}

function mySession(req, res) {
  const s = db.prepare('SELECT * FROM sessions WHERE id=?').get(req.params.id);
  if (!s || (s.seeker_id !== req.user.id && s.guide_id !== req.user.id)) {
    res.status(404).json({ error: 'Session not found' });
    return null;
  }
  return s;
}

const GUIDE_SELECT = `SELECT u.id, u.name, g.company, g.domain, g.bio, g.rate_per_min, g.is_online,
  (SELECT ROUND(AVG(r.rating),1) FROM reviews r JOIN sessions s ON s.id=r.session_id
    WHERE s.guide_id=u.id) AS avg_rating
  FROM users u JOIN guide_profiles g ON g.user_id=u.id`;

// ---------- auth ----------
app.post('/api/auth/register', (req, res) => {
  const { name, email, password, role, company, domain, rate, bio } = req.body;
  if (!name || !email || !password || !['seeker', 'guide'].includes(role))
    return res.status(400).json({ error: 'Name, email, password and role are required' });
  if (role === 'guide' && (!company || !domain || !(+rate > 0)))
    return res.status(400).json({ error: 'Guide needs company, domain and a rate' });
  if (db.prepare('SELECT id FROM users WHERE email=?').get(email))
    return res.status(400).json({ error: 'Email already registered' });

  const hash = bcrypt.hashSync(password, 10);
  const id = db.transaction(() => {
    const r = db.prepare('INSERT INTO users(name,email,password_hash,role) VALUES (?,?,?,?)')
      .run(name, email, hash, role);
    if (role === 'guide')
      db.prepare('INSERT INTO guide_profiles(user_id,company,domain,bio,rate_per_min) VALUES (?,?,?,?,?)')
        .run(r.lastInsertRowid, company, domain, bio || '', +rate);
    return r.lastInsertRowid;
  })();
  res.json({ token: sign({ id, role }) });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email || '');
  if (!u || !bcrypt.compareSync(password || '', u.password_hash))
    return res.status(400).json({ error: 'Invalid email or password' });
  res.json({ token: sign(u) });
});

app.get('/api/me', auth, (req, res) => {
  const u = db.prepare('SELECT id,name,email,role,balance FROM users WHERE id=?').get(req.user.id);
  if (!u) return res.status(401).json({ error: 'User not found' });
  if (u.role === 'guide')
    u.profile = db.prepare('SELECT * FROM guide_profiles WHERE user_id=?').get(u.id);
  res.json(u);
});

// ---------- guides ----------
app.get('/api/guides', auth, (req, res) => {
  let sql = GUIDE_SELECT + ' WHERE 1=1';
  const p = [];
  if (req.query.domain) {
    sql += ' AND LOWER(g.domain) LIKE ?';
    p.push('%' + req.query.domain.toLowerCase() + '%');
  }
  if (req.query.online === '1') sql += ' AND g.is_online=1';
  sql += ' ORDER BY g.is_online DESC, avg_rating DESC';
  res.json(db.prepare(sql).all(...p));
});

// Smart Match: keyword-based scoring of guides against the seeker's goal
app.get('/api/guides/match', auth, (req, res) => {
  const words = (req.query.goal || '').toLowerCase().split(/\W+/).filter(w => w.length > 2);
  const rows = db.prepare(GUIDE_SELECT).all();
  rows.forEach(g => {
    const text = `${g.domain} ${g.company} ${g.bio}`.toLowerCase();
    const hits = words.filter(w => text.includes(w)).length;
    g.score = hits * 10 + (g.is_online ? 3 : 0) + (g.avg_rating || 0);
    g.hits = hits;
  });
  res.json(rows.filter(g => g.hits > 0).sort((a, b) => b.score - a.score).slice(0, 5));
});

app.put('/api/guides/me/status', auth, (req, res) => {
  if (req.user.role !== 'guide') return res.status(403).json({ error: 'Guides only' });
  db.prepare('UPDATE guide_profiles SET is_online=? WHERE user_id=?')
    .run(req.body.is_online ? 1 : 0, req.user.id);
  res.json({ ok: true });
});

// ---------- wallet ----------
app.post('/api/wallet/add', auth, (req, res) => { // demo top-up for offline testing
  const amount = +req.body.amount;
  if (req.user.role !== 'seeker') return res.status(403).json({ error: 'Seekers only' });
  if (!(amount > 0 && amount <= 10000)) return res.status(400).json({ error: 'Amount must be 1 to 10000' });
  db.transaction(() => {
    db.prepare('UPDATE users SET balance = balance + ? WHERE id=?').run(amount, req.user.id);
    db.prepare('INSERT INTO transactions(user_id,type,amount,created_at) VALUES (?,?,?,?)')
      .run(req.user.id, 'credit', amount, now());
  })();
  res.json({ ok: true });
});

app.get('/api/wallet', auth, (req, res) => {
  const u = db.prepare('SELECT balance FROM users WHERE id=?').get(req.user.id);
  const tx = db.prepare('SELECT * FROM transactions WHERE user_id=? ORDER BY id DESC LIMIT 50').all(req.user.id);
  res.json({ balance: u.balance, transactions: tx });
});

// ---------- Razorpay payments (test mode) ----------
app.post('/api/payments/create-order', auth, async (req, res) => {
  if (req.user.role !== 'seeker') return res.status(403).json({ error: 'Seekers only' });
  if (!RZP_ID || !RZP_SECRET)
    return res.status(400).json({ error: 'Razorpay keys are not configured on the server' });
  const amount = Math.round(+req.body.amount);
  if (!(amount >= 1 && amount <= 10000)) return res.status(400).json({ error: 'Amount must be 1 to 10000' });
  try {
    const r = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from(RZP_ID + ':' + RZP_SECRET).toString('base64')
      },
      body: JSON.stringify({ amount: amount * 100, currency: 'INR', receipt: 'mm_' + Date.now() })
    });
    const order = await r.json();
    if (!r.ok) return res.status(400).json({ error: (order.error && order.error.description) || 'Could not create order' });
    db.prepare('INSERT INTO payments(order_id,user_id,amount,status,created_at) VALUES (?,?,?,?,?)')
      .run(order.id, req.user.id, amount, 'created', now());
    res.json({ order_id: order.id, amount: order.amount, key: RZP_ID });
  } catch {
    res.status(500).json({ error: 'Payment service unreachable' });
  }
});

app.post('/api/payments/verify', auth, (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  const p = db.prepare('SELECT * FROM payments WHERE order_id=? AND user_id=?')
    .get(razorpay_order_id || '', req.user.id);
  if (!p || p.status !== 'created') return res.status(400).json({ error: 'Invalid order' });
  const expected = crypto.createHmac('sha256', RZP_SECRET || '')
    .update(razorpay_order_id + '|' + razorpay_payment_id).digest('hex');
  if (expected !== razorpay_signature) return res.status(400).json({ error: 'Payment signature mismatch' });
  db.transaction(() => {
    db.prepare("UPDATE payments SET status='paid', payment_id=? WHERE order_id=?")
      .run(razorpay_payment_id, razorpay_order_id);
    db.prepare('UPDATE users SET balance = balance + ? WHERE id=?').run(p.amount, req.user.id);
    db.prepare('INSERT INTO transactions(user_id,type,amount,created_at) VALUES (?,?,?,?)')
      .run(req.user.id, 'credit', p.amount, now());
  })();
  res.json({ ok: true });
});

// ---------- sessions (fixed paths before :id) ----------
app.get('/api/sessions/active', auth, (req, res) => {
  const s = db.prepare(
    "SELECT * FROM sessions WHERE status='active' AND (seeker_id=? OR guide_id=?) ORDER BY id DESC LIMIT 1"
  ).get(req.user.id, req.user.id);
  res.json({ session: s || null });
});

app.get('/api/sessions/history', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT s.id, s.start_time, s.minutes, s.amount, u.name AS other_name, r.rating
    FROM sessions s
    JOIN users u ON u.id = (CASE WHEN s.seeker_id=? THEN s.guide_id ELSE s.seeker_id END)
    LEFT JOIN reviews r ON r.session_id = s.id
    WHERE s.status='ended' AND (s.seeker_id=? OR s.guide_id=?)
    ORDER BY s.id DESC`).all(req.user.id, req.user.id, req.user.id);
  if (req.user.role === 'guide') rows.forEach(r => (r.amount = r2(r.amount * (1 - PLATFORM_CUT))));
  res.json(rows);
});

app.post('/api/sessions/start', auth, (req, res) => {
  if (req.user.role !== 'seeker') return res.status(403).json({ error: 'Only seekers can start sessions' });
  const g = db.prepare('SELECT * FROM guide_profiles WHERE user_id=?').get(req.body.guide_id);
  if (!g) return res.status(404).json({ error: 'Guide not found' });
  if (!g.is_online) return res.status(400).json({ error: 'Guide is offline' });
  const busy = db.prepare("SELECT id FROM sessions WHERE status='active' AND (guide_id=? OR seeker_id=?)")
    .get(g.user_id, req.user.id);
  if (busy) return res.status(400).json({ error: 'You or the guide is already in a session' });
  const u = db.prepare('SELECT balance FROM users WHERE id=?').get(req.user.id);
  if (u.balance < g.rate_per_min)
    return res.status(400).json({ error: 'Insufficient balance. Add money to your wallet first.' });
  const r = db.prepare('INSERT INTO sessions(seeker_id,guide_id,rate,start_time) VALUES (?,?,?,?)')
    .run(req.user.id, g.user_id, g.rate_per_min, now());
  io.to('user:' + g.user_id).emit('incoming', { id: r.lastInsertRowid }); // notify the guide instantly
  res.json({ id: r.lastInsertRowid });
});

app.get('/api/sessions/:id', auth, (req, res) => {
  const s = mySession(req, res);
  if (!s) return;
  const c = calc(s);
  const otherId = s.seeker_id === req.user.id ? s.guide_id : s.seeker_id;
  const other = db.prepare('SELECT name FROM users WHERE id=?').get(otherId);
  const messages = db.prepare('SELECT id,sender_id,text,created_at FROM messages WHERE session_id=? ORDER BY id')
    .all(s.id);
  res.json({ session: s, elapsed: c.secs, cost: c.cost, other_name: other.name, messages });
});

app.post('/api/sessions/:id/end', auth, (req, res) => {
  const s = mySession(req, res);
  if (!s) return;
  res.json({ session: finishSession(s.id) });
});

// ---------- reviews ----------
app.post('/api/reviews', auth, (req, res) => {
  const { session_id, rating, comment } = req.body;
  const s = db.prepare('SELECT * FROM sessions WHERE id=?').get(session_id);
  if (!s || s.seeker_id !== req.user.id || s.status !== 'ended')
    return res.status(400).json({ error: 'You cannot review this session' });
  if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'Rating must be 1 to 5' });
  if (db.prepare('SELECT id FROM reviews WHERE session_id=?').get(session_id))
    return res.status(400).json({ error: 'Already reviewed' });
  db.prepare('INSERT INTO reviews(session_id,rating,comment) VALUES (?,?,?)')
    .run(session_id, Math.round(rating), comment || '');
  res.json({ ok: true });
});

// ---------- Socket.io: chat, live timer, WebRTC signaling ----------
io.use((socket, next) => {
  try {
    socket.user = jwt.verify(socket.handshake.auth.token, SECRET);
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});

io.on('connection', socket => {
  socket.join('user:' + socket.user.id);

  socket.on('join', (sessionId, cb) => {
    const s = db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId);
    if (!s || (s.seeker_id !== socket.user.id && s.guide_id !== socket.user.id))
      return cb && cb({ error: 'Not allowed' });
    socket.join('session:' + s.id);
    cb && cb({ ok: true });
  });

  socket.on('chat', ({ sessionId, text }) => {
    const s = db.prepare('SELECT * FROM sessions WHERE id=?').get(sessionId);
    if (!s || s.status !== 'active') return;
    if (s.seeker_id !== socket.user.id && s.guide_id !== socket.user.id) return;
    const t = String(text || '').trim().slice(0, 500);
    if (!t) return;
    const created = now();
    const r = db.prepare('INSERT INTO messages(session_id,sender_id,text,created_at) VALUES (?,?,?,?)')
      .run(s.id, socket.user.id, t, created);
    io.to('session:' + s.id).emit('chat', {
      id: r.lastInsertRowid, sender_id: socket.user.id, text: t, created_at: created
    });
  });

  // WebRTC signaling: relay offer/answer/ICE to the other person in the session
  socket.on('signal', ({ sessionId, data }) => {
    if (!socket.rooms.has('session:' + sessionId)) return;
    socket.to('session:' + sessionId).emit('signal', data);
  });
});

// server-driven billing timer: broadcast every second, auto-end if wallet runs out
setInterval(() => {
  const active = db.prepare("SELECT * FROM sessions WHERE status='active'").all();
  for (const s of active) {
    const bal = db.prepare('SELECT balance FROM users WHERE id=?').get(s.seeker_id).balance;
    const c = calc(s);
    if (c.cost > bal) { finishSession(s.id); continue; }
    io.to('session:' + s.id).emit('tick', { elapsed: c.secs, cost: c.cost });
  }
}, 1000);

server.listen(PORT, () => console.log(`MentorMinute running at http://localhost:${PORT}`));