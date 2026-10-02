/* ================= state ================= */
let token = localStorage.getItem('token');
let me = null, socket = null;
let curSession = null, curOther = '', curRate = 0, seen = new Set();
let pc = null, localStream = null, pendingIce = [];
let pendingScroll = null, regRole = 'seeker', toastTimer = null;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '\u20B9' + Number(n || 0).toFixed(2);
const fmt = s => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
const initials = n => String(n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();

async function api(path, method = 'GET', body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

/* ================= toast + modal ================= */
function toast(msg, type = 'info') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}
function showModal(html) { $('modal').innerHTML = `<div class="modal-box">${html}</div>`; $('modal').hidden = false; }
function closeModal() { $('modal').hidden = true; $('modal').innerHTML = ''; }

/* ================= routing ================= */
function go(path) {
  const h = '#/' + path;
  if (location.hash === h) route(); else location.hash = h;
}
function currentRoute() {
  const h = location.hash.replace(/^#\/?/, '').split('?')[0];
  return h.split('/').filter(Boolean)[0] || 'home';
}
function jump(id) {
  if (currentRoute() !== 'home') { pendingScroll = id; go(''); }
  else scrollToId(id);
}
function scrollToId(id) {
  if (id === 'top') window.scrollTo(0, 0);
  else { const el = $(id); if (el) el.scrollIntoView(); }
}

async function route() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, qs] = h.split('?');
  const parts = path.split('/').filter(Boolean);
  const name = parts[0] || 'home';
  const params = new URLSearchParams(qs || '');

  if (name !== 'session' && curSession) leaveSession();
  renderNav();

  if (name === 'login') { if (me) return go('dashboard'); renderLogin(); }
  else if (name === 'register') { if (me) return go('dashboard'); renderRegister(params.get('role')); }
  else if (name === 'dashboard') {
    if (!me) return go('login');
    try {
      const a = await api('/sessions/active');
      if (a.session) return go('session/' + a.session.id);
      await refreshMe();
    } catch (e) { return logout(); }
    me.role === 'seeker' ? renderSeeker() : renderGuide();
  }
  else if (name === 'session') {
    if (!me) return go('login');
    showSession(+parts[1]);
  }
  else renderHome();

  if (pendingScroll) { scrollToId(pendingScroll); pendingScroll = null; }
  else window.scrollTo(0, 0);
}

/* ================= navbar ================= */
function renderNav() {
  const links = `<nav class="nav-links">
    <a href="#/" onclick="jump('top');return false">Home</a>
    <a href="#/" onclick="jump('how');return false">How it works</a>
    <a href="#/" onclick="jump('features');return false">Features</a>
    <a href="#/" onclick="jump('domains');return false">Domains</a></nav>`;
  const right = me
    ? `<div class="nav-actions">
         <span class="chip grey">${esc(me.role)}</span><span class="chip">${money(me.balance)}</span>
         <a class="btn btn-outline btn-sm" href="#/dashboard">Dashboard</a>
         <button class="btn btn-primary btn-sm" onclick="logout()">Logout</button></div>`
    : `<div class="nav-actions">
         <a class="btn btn-outline btn-sm" href="#/login">Login</a>
         <a class="btn btn-primary btn-sm" href="#/register">Get started</a></div>`;
  $('navbar').innerHTML = `<a class="logo" href="#/" onclick="jump('top');return false"><span class="logo-mark">M</span>MentorMinute</a>${links}${right}`;
}

/* ================= HOME ================= */
function renderHome() {
  $('app').innerHTML = `
  <section class="hero"><div class="container hero-inner">
    <div>
      <h1>Get career clarity from people who have been there.</h1>
      <p class="lead">Talk to working professionals by chat or video and pay only for the minutes you use. No packages, no retainers.</p>
      <div class="hero-actions">
        <a class="btn btn-primary btn-lg" href="#/register?role=seeker">Find a mentor</a>
        <a class="btn btn-outline btn-lg" href="#/register?role=guide">Become a Guide</a>
      </div>
      <p class="hero-note">Free to sign up. Per-minute billing with a live cost meter.</p>
    </div>
    <div class="sample">
      <div class="sample-tag">SAMPLE SESSION</div>
      <div class="card">
        <div class="person">
          <span class="avatar">AS</span>
          <div class="grow"><b>Aarav S.</b><div class="muted small">Product Manager</div></div>
          <span class="chip green">Online</span>
        </div>
      </div>
      <div class="card">
        <div class="meter">
          <div><b>\u20B912</b><span>Rate / min</span></div>
          <div><b>08:42</b><span>Time</span></div>
          <div><b>\u20B9108.00</b><span>Cost</span></div>
        </div>
      </div>
      <p class="muted small" style="margin:0">Illustration with sample data.</p>
    </div>
  </div></section>

  <section class="highlights"><div class="container grid-4">
    <div><b>Pay per minute</b><span>Billed only for time used</span></div>
    <div><b>Chat and video</b><span>Real-time sessions</span></div>
    <div><b>Secure wallet</b><span>Razorpay payments</span></div>
    <div><b>Rated guides</b><span>Reviews after every session</span></div>
  </div></section>

  <section class="section" id="how"><div class="container">
    <div class="section-head"><h2>How it works</h2><p class="muted">Three steps on each side of the same conversation.</p></div>
    <div class="grid-2">
      <div class="card steps-col"><h3>For Seekers</h3>
        <div class="step"><span class="step-num">1</span><div><b>Find your Guide</b><p>Browse by domain or describe your goal and let Smart Match suggest guides.</p></div></div>
        <div class="step"><span class="step-num">2</span><div><b>Connect instantly</b><p>Start a chat or video session with an online guide. The timer starts right away.</p></div></div>
        <div class="step"><span class="step-num">3</span><div><b>Pay for minutes used</b><p>Your wallet is charged when the session ends. Then rate your guide.</p></div></div>
      </div>
      <div class="card steps-col"><h3>For Guides</h3>
        <div class="step"><span class="step-num">1</span><div><b>Create your Guide profile</b><p>Add your company, domain, bio and your per-minute rate.</p></div></div>
        <div class="step"><span class="step-num">2</span><div><b>Go online</b><p>Switch on availability and get connected to seekers in real time.</p></div></div>
        <div class="step"><span class="step-num">3</span><div><b>Earn for your time</b><p>You receive 80% of every session in your wallet. The platform keeps 20%.</p></div></div>
      </div>
    </div>
  </div></section>

  <section class="section white" id="features"><div class="container">
    <div class="section-head"><h2>Built for real conversations</h2><p class="muted">Everything needed to run a session from start to payout.</p></div>
    <div class="grid-3">
      <div class="card feature"><div class="icon">\u20B9</div><h3>Per-minute billing</h3><p>Cost is calculated per started minute and settled in a single database transaction.</p></div>
      <div class="card feature"><div class="icon">C</div><h3>Real-time chat</h3><p>Messages are delivered instantly over Socket.io and saved with the session.</p></div>
      <div class="card feature"><div class="icon">V</div><h3>Video and voice calls</h3><p>Peer-to-peer calls using WebRTC, set up through the same live connection.</p></div>
      <div class="card feature"><div class="icon">W</div><h3>Wallet and payments</h3><p>Top up with Razorpay. Payments are verified on the server before crediting.</p></div>
      <div class="card feature"><div class="icon">S</div><h3>Smart Match</h3><p>Describe what you need and get the best matching guides ranked for you.</p></div>
      <div class="card feature"><div class="icon">R</div><h3>Ratings and reviews</h3><p>Seekers rate each session so good guides rise to the top.</p></div>
    </div>
  </div></section>

  <section class="section" id="domains"><div class="container">
    <div class="section-head"><h2>A Guide for every question</h2><p class="muted">Choose a domain to get started.</p></div>
    <div class="domains">
      <a class="domain-chip" href="#/register?role=seeker">Tech and Engineering</a>
      <a class="domain-chip" href="#/register?role=seeker">Product</a>
      <a class="domain-chip" href="#/register?role=seeker">MBA and Consulting</a>
      <a class="domain-chip" href="#/register?role=seeker">UPSC</a>
      <a class="domain-chip" href="#/register?role=seeker">Design</a>
      <a class="domain-chip" href="#/register?role=seeker">Finance</a>
    </div>
  </div></section>

  <section class="cta"><div class="container">
    <h2>Ready for your first conversation?</h2>
    <p>Create a free account as a Seeker or a Guide in under two minutes.</p>
    <a class="btn btn-light btn-lg" href="#/register">Get started</a>
  </div></section>`;
}

/* ================= AUTH ================= */
function renderLogin() {
  $('app').innerHTML = `<div class="auth-wrap"><div class="card auth-card">
    <h2>Welcome back</h2><p class="muted">Log in to continue to your dashboard.</p>
    <form onsubmit="doLogin(event)">
      <label for="email">Email</label><input id="email" type="email" placeholder="you@example.com" required>
      <label for="password">Password</label><input id="password" type="password" placeholder="Your password" required>
      <div class="form-error" id="err"></div>
      <button class="btn btn-primary btn-block" type="submit">Login</button>
    </form>
    <div class="auth-switch">New to MentorMinute? <a href="#/register">Create an account</a></div>
  </div></div>`;
}

function renderRegister(role) {
  regRole = role === 'guide' ? 'guide' : 'seeker';
  $('app').innerHTML = `<div class="auth-wrap"><div class="card auth-card">
    <h2>Create your account</h2><p class="muted">Join as a Seeker or as a Guide.</p>
    <form onsubmit="doRegister(event)">
      <label>I want to</label>
      <div class="role-toggle">
        <button type="button" class="role-btn" id="roleSeeker" onclick="setRegRole('seeker')">Get guidance</button>
        <button type="button" class="role-btn" id="roleGuide" onclick="setRegRole('guide')">Mentor others</button>
      </div>
      <label for="name">Full name</label><input id="name" placeholder="Your name" required>
      <label for="email">Email</label><input id="email" type="email" placeholder="you@example.com" required>
      <label for="password">Password</label><input id="password" type="password" placeholder="Create a password" required>
      <div id="guideFields">
        <label for="company">Company</label><input id="company" placeholder="e.g. Google">
        <label for="domain">Domain</label><input id="domain" placeholder="e.g. Tech, Product, MBA, Finance">
        <label for="rate">Rate per minute (\u20B9)</label><input id="rate" type="number" min="1" placeholder="e.g. 12">
        <label for="bio">Short bio</label><textarea id="bio" rows="3" placeholder="Your skills and topics you can help with"></textarea>
      </div>
      <div class="form-error" id="err"></div>
      <button class="btn btn-primary btn-block" type="submit">Create account</button>
    </form>
    <div class="auth-switch">Already have an account? <a href="#/login">Login</a></div>
  </div></div>`;
  setRegRole(regRole);
}
function setRegRole(r) {
  regRole = r;
  $('roleSeeker').classList.toggle('active', r === 'seeker');
  $('roleGuide').classList.toggle('active', r === 'guide');
  $('guideFields').hidden = r !== 'guide';
}

async function afterAuth(d) {
  token = d.token;
  localStorage.setItem('token', token);
  await loadUser();
  go('dashboard');
}
async function doLogin(e) {
  e.preventDefault();
  try { afterAuth(await api('/auth/login', 'POST', { email: $('email').value, password: $('password').value })); }
  catch (err) { $('err').textContent = err.message; }
}
async function doRegister(e) {
  e.preventDefault();
  try {
    afterAuth(await api('/auth/register', 'POST', {
      name: $('name').value, email: $('email').value, password: $('password').value, role: regRole,
      company: $('company').value, domain: $('domain').value, rate: $('rate').value, bio: $('bio').value
    }));
  } catch (err) { $('err').textContent = err.message; }
}
function logout() {
  leaveSession();
  if (socket) { socket.disconnect(); socket = null; }
  localStorage.removeItem('token');
  token = null; me = null;
  go('');
}

async function loadUser() {
  if (!token) return;
  try { me = await api('/me'); connectSocket(); }
  catch { token = null; me = null; localStorage.removeItem('token'); }
}
async function refreshMe() { me = await api('/me'); renderNav(); }

function connectSocket() {
  if (socket) return;
  socket = io({ auth: { token } });
  socket.on('incoming', d => { if (me && me.role === 'guide' && !curSession) go('session/' + d.id); });
  socket.on('connect', () => { if (curSession) socket.emit('join', curSession, () => {}); });
}

/* ================= SEEKER DASHBOARD ================= */
function renderSeeker() {
  $('app').innerHTML = `<section class="page"><div class="container">
    <div class="page-head"><h1>Welcome, ${esc(me.name)}</h1>
      <p class="muted">Find a guide, connect, and pay only for the minutes you use.</p></div>

    <div class="grid-2">
      <div class="card"><h3>Your wallet</h3>
        <div class="big-number">${money(me.balance)}</div>
        <div class="inline-form">
          <input id="amt" type="number" min="1" value="200" placeholder="Amount in \u20B9">
          <button class="btn btn-green" onclick="payRazorpay()">Add money</button>
        </div>
        <p class="muted small" style="margin:10px 0 0">Payments run in Razorpay test mode.
          <a href="#/dashboard" onclick="addTestMoney();return false">Add test credits</a> if keys are not set.</p>
      </div>
      <div class="card"><h3>Smart Match</h3>
        <p class="muted">Describe what you need and we will rank the best guides for you.</p>
        <div class="inline-form">
          <input id="goal" placeholder="e.g. product manager interview">
          <button class="btn btn-primary" onclick="matchGuides()">Find guides</button>
        </div>
      </div>
    </div>

    <h2 class="section-title" id="guidesTitle">Available guides</h2>
    <div class="card" style="margin-bottom:20px">
      <div class="inline-form">
        <input id="fdomain" placeholder="Filter by domain (e.g. Tech)">
        <label class="check" style="white-space:nowrap"><input type="checkbox" id="fonline"> Online only</label>
        <button class="btn btn-outline" onclick="loadGuides()">Search</button>
      </div>
    </div>
    <div id="guides" class="grid-2"></div>

    <h2 class="section-title">Session history</h2>
    <div class="card"><div id="hist"></div></div>
  </div></section>`;
  loadGuides();
  loadHistory();
}

async function addTestMoney() {
  try { await api('/wallet/add', 'POST', { amount: $('amt').value }); toast('Test credits added', 'success'); go('dashboard'); }
  catch (e) { toast(e.message, 'error'); }
}
async function payRazorpay() {
  try {
    const o = await api('/payments/create-order', 'POST', { amount: $('amt').value });
    new Razorpay({
      key: o.key, amount: o.amount, currency: 'INR', name: 'MentorMinute',
      description: 'Wallet top-up', order_id: o.order_id,
      handler: async r => {
        try { await api('/payments/verify', 'POST', r); toast('Payment successful. Wallet updated.', 'success'); go('dashboard'); }
        catch (e) { toast(e.message, 'error'); }
      }
    }).open();
  } catch (e) { toast(e.message, 'error'); }
}

function renderGuides(gs) {
  $('guides').innerHTML = gs.length ? gs.map(g => `<div class="card guide-card">
      <div class="person">
        <span class="avatar">${esc(initials(g.name))}</span>
        <div class="grow"><b>${esc(g.name)}</b><div class="muted small">${esc(g.company)} &middot; ${esc(g.domain)}</div></div>
        <span class="chip ${g.is_online ? 'green' : 'grey'}">${g.is_online ? 'Online' : 'Offline'}</span>
      </div>
      <div class="bio">${esc(g.bio) || 'No bio added yet.'}</div>
      <div class="guide-foot">
        <div><b>${money(g.rate_per_min)}</b><span class="muted small">/min</span>
          &nbsp;&middot;&nbsp;<span class="muted small">${g.avg_rating ? '\u2605 ' + g.avg_rating : 'No ratings yet'}</span></div>
        <button class="btn btn-primary btn-sm" ${g.is_online ? '' : 'disabled'} onclick="startSession(${g.id})">Connect</button>
      </div></div>`).join('')
    : '<div class="card empty">No guides found. Try a different search.</div>';
}
async function loadGuides() {
  $('guidesTitle').textContent = 'Available guides';
  const q = new URLSearchParams({ domain: $('fdomain').value, online: $('fonline').checked ? '1' : '' });
  renderGuides(await api('/guides?' + q));
}
async function matchGuides() {
  const goal = $('goal').value.trim();
  if (!goal) return toast('Type what you need help with first.', 'error');
  $('guidesTitle').textContent = 'Best matches for you';
  renderGuides(await api('/guides/match?goal=' + encodeURIComponent(goal)));
}
async function startSession(guideId) {
  try { const d = await api('/sessions/start', 'POST', { guide_id: guideId }); go('session/' + d.id); }
  catch (e) { toast(e.message, 'error'); }
}

/* ================= GUIDE DASHBOARD ================= */
function renderGuide() {
  const p = me.profile;
  $('app').innerHTML = `<section class="page"><div class="container">
    <div class="page-head"><h1>Guide dashboard</h1>
      <p class="muted">Go online to start receiving sessions from seekers.</p></div>

    <div class="grid-3">
      <div class="card"><h3>Your rate</h3><div class="big-number">${money(p.rate_per_min)}<span class="muted small"> /min</span></div>
        <p class="muted small" style="margin:0">${esc(p.company)} &middot; ${esc(p.domain)}</p></div>
      <div class="card"><h3>Earnings wallet</h3><div class="big-number">${money(me.balance)}</div>
        <p class="muted small" style="margin:0">80% of each session is credited here.</p></div>
      <div class="card"><h3>Availability</h3>
        <div class="big-number" style="font-size:22px" id="onlineText">${p.is_online ? 'Online' : 'Offline'}</div>
        <label class="check"><input type="checkbox" id="online" ${p.is_online ? 'checked' : ''} onchange="setOnline(this.checked)"> Accept sessions</label></div>
    </div>

    <h2 class="section-title">Your profile</h2>
    <div class="card"><div class="person">
      <span class="avatar">${esc(initials(me.name))}</span>
      <div class="grow"><b>${esc(me.name)}</b><div class="muted small">${esc(p.company)} &middot; ${esc(p.domain)}</div></div></div>
      <p class="muted" style="margin:14px 0 0">${esc(p.bio) || 'No bio added.'}</p></div>

    <h2 class="section-title">Session history</h2>
    <div class="card"><div id="hist"></div></div>
  </div></section>`;
  loadHistory();
}
async function setOnline(v) {
  try {
    await api('/guides/me/status', 'PUT', { is_online: v });
    $('onlineText').textContent = v ? 'Online' : 'Offline';
    toast(v ? 'You are online' : 'You are offline', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

/* ================= HISTORY + RATING ================= */
async function loadHistory() {
  const h = await api('/sessions/history');
  const isSeeker = me.role === 'seeker';
  $('hist').innerHTML = h.length ? `<div class="table-wrap"><table class="table">
    <thead><tr><th>${isSeeker ? 'Guide' : 'Seeker'}</th><th>Date</th><th>Minutes</th><th>${isSeeker ? 'Charged' : 'Earned'}</th><th>Rating</th></tr></thead>
    <tbody>${h.map(s => `<tr>
      <td>${esc(s.other_name)}</td><td>${esc(s.start_time.slice(0, 16).replace('T', ' '))}</td>
      <td>${s.minutes}</td><td>${money(s.amount)}</td>
      <td>${s.rating ? '\u2605 ' + s.rating : (isSeeker ? `<button class="btn btn-outline btn-sm" onclick="openRate(${s.id})">Rate</button>` : '-')}</td>
    </tr>`).join('')}</tbody></table></div>`
    : '<p class="muted" style="margin:0">No sessions yet.</p>';
}

function ratingForm(id) {
  return `<label for="rt">Rating</label>
    <select id="rt"><option value="5">5 - Excellent</option><option value="4">4 - Good</option>
      <option value="3">3 - Okay</option><option value="2">2 - Poor</option><option value="1">1 - Bad</option></select>
    <label for="rc">Comment (optional)</label><textarea id="rc" rows="3"></textarea>
    <div class="modal-actions">
      <button class="btn btn-outline" onclick="closeModal()">Skip</button>
      <button class="btn btn-primary" onclick="submitRating(${id})">Submit</button></div>`;
}
function openRate(id) { showModal(`<h3>Rate this session</h3>${ratingForm(id)}`); }
async function submitRating(id) {
  try {
    await api('/reviews', 'POST', { session_id: id, rating: +$('rt').value, comment: $('rc').value });
    closeModal(); toast('Thanks for your review', 'success'); go('dashboard');
  } catch (e) { toast(e.message, 'error'); }
}

/* ================= LIVE SESSION ================= */
function onTick(d) {
  if (!$('sTime')) return;
  $('sTime').textContent = fmt(d.elapsed);
  $('sCost').textContent = money(d.cost);
}
function addMsg(m) {
  if (m.id && seen.has(m.id)) return;
  if (m.id) seen.add(m.id);
  const chat = $('chat');
  if (!chat) return;
  const row = document.createElement('div');
  row.className = 'bubble-row' + (m.sender_id === me.id ? ' me' : '');
  row.innerHTML = `<div class="bubble">${esc(m.text)}</div>`;
  chat.appendChild(row);
  chat.scrollTop = chat.scrollHeight;
}
function onEnded(d) { afterEnd(d.id); }

async function showSession(id) {
  leaveSession();
  curSession = id;
  seen = new Set();
  $('app').innerHTML = `<section class="page"><div class="container">
    <div class="card session-bar">
      <div><span class="muted small">Session with</span><h2 id="sWith">Connecting...</h2></div>
      <div class="stat"><b id="sRate">-</b><span>Rate</span></div>
      <div class="stat"><b id="sTime">00:00</b><span>Time</span></div>
      <div class="stat"><b id="sCost">${money(0)}</b><span>Cost so far</span></div>
      <button class="btn btn-danger" onclick="endSession(${id})">End session</button>
    </div>
    <div class="grid-2 session-grid">
      <div class="card"><h3>Video call</h3>
        <p class="muted small" style="margin:0">Video goes directly between both browsers.</p>
        <div class="video-grid">
          <div class="video-box"><video id="remote" autoplay playsinline></video><span class="video-label">Them</span></div>
          <div class="video-box"><video id="local" autoplay playsinline muted></video><span class="video-label">You</span></div>
        </div>
        <button id="callBtn" class="btn btn-green btn-block" onclick="startCall()">Start video call</button>
      </div>
      <div class="card chat-card"><h3>Chat</h3>
        <div class="chat-box" id="chat"></div>
        <div class="inline-form">
          <input id="txt" placeholder="Type a message" onkeydown="if(event.key==='Enter')sendMsg(${id})">
          <button class="btn btn-primary" onclick="sendMsg(${id})">Send</button>
        </div>
      </div>
    </div></div></section>`;

  socket.on('tick', onTick);
  socket.on('chat', addMsg);
  socket.on('ended', onEnded);
  socket.on('signal', onSignal);
  socket.emit('join', id, () => {});

  try {
    const d = await api('/sessions/' + id);
    if (d.session.status !== 'active') { leaveSession(); toast('This session has already ended.'); return go('dashboard'); }
    curOther = d.other_name; curRate = d.session.rate;
    $('sWith').textContent = d.other_name;
    $('sRate').textContent = money(d.session.rate) + '/min';
    onTick({ elapsed: d.elapsed, cost: d.cost });
    d.messages.forEach(addMsg);
  } catch (e) { leaveSession(); toast(e.message, 'error'); go('dashboard'); }
}

function leaveSession() {
  if (socket) {
    socket.off('tick', onTick); socket.off('chat', addMsg);
    socket.off('ended', onEnded); socket.off('signal', onSignal);
  }
  cleanupCall();
  curSession = null;
}

function sendMsg(id) {
  const t = $('txt').value.trim();
  if (!t) return;
  $('txt').value = '';
  socket.emit('chat', { sessionId: id, text: t });
}

async function endSession(id) {
  if (!confirm('End this session and bill the time used?')) return;
  try { await api('/sessions/' + id + '/end', 'POST'); } catch (e) {}
  afterEnd(id);
}

async function afterEnd(id) {
  if (curSession !== id) return; // runs only once per session
  leaveSession();
  let d;
  try { d = await api('/sessions/' + id); } catch { return go('dashboard'); }
  await refreshMe();
  go('dashboard');
  const isSeeker = me.role === 'seeker';
  const shown = isSeeker ? d.session.amount : d.session.amount * 0.8;
  showModal(`<h3>Session ended</h3>
    <div class="summary-row"><span class="muted">With</span><b>${esc(d.other_name)}</b></div>
    <div class="summary-row"><span class="muted">Minutes billed</span><b>${d.session.minutes}</b></div>
    <div class="summary-row"><span class="muted">${isSeeker ? 'Amount charged' : 'You earned (80%)'}</span><b>${money(shown)}</b></div>
    ${isSeeker ? ratingForm(id) : '<div class="modal-actions"><button class="btn btn-primary" onclick="closeModal()">Close</button></div>'}`);
}

/* ================= WebRTC video ================= */
const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

function cleanupCall() {
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  if (pc) pc.close();
  pc = null; localStream = null; pendingIce = [];
}
async function setupPeer() {
  if (pc) return;
  pc = new RTCPeerConnection(ICE);
  pc.onicecandidate = e => {
    if (e.candidate) socket.emit('signal', { sessionId: curSession, data: { candidate: e.candidate } });
  };
  pc.ontrack = e => { const r = $('remote'); if (r) r.srcObject = e.streams[0]; };
  try {
    try { localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true }); }
    catch { localStream = await navigator.mediaDevices.getUserMedia({ audio: true }); } // camera busy: audio only
  } catch (e) { cleanupCall(); throw e; }
  $('local').srcObject = localStream;
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  $('callBtn').disabled = true;
  $('callBtn').textContent = 'In call';
}
async function flushIce() {
  for (const c of pendingIce) { try { await pc.addIceCandidate(c); } catch (e) {} }
  pendingIce = [];
}
async function startCall() {
  try {
    await setupPeer();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', { sessionId: curSession, data: { sdp: pc.localDescription } });
  } catch (e) { toast('Could not start the call: ' + e.message, 'error'); }
}
async function onSignal(data) {
  try {
    if (data.sdp) {
      if (data.sdp.type === 'offer') {
        await setupPeer();
        await pc.setRemoteDescription(data.sdp);
        await flushIce();
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        socket.emit('signal', { sessionId: curSession, data: { sdp: pc.localDescription } });
      } else if (pc) {
        await pc.setRemoteDescription(data.sdp);
        await flushIce();
      }
    } else if (data.candidate) {
      if (pc && pc.remoteDescription) await pc.addIceCandidate(data.candidate);
      else pendingIce.push(data.candidate);
    }
  } catch (e) { console.log('signal error', e); }
}

/* ================= start ================= */
window.addEventListener('hashchange', route);
(async () => { await loadUser(); route(); })();