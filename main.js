// ============================================================
// BeStreak — lógica principal (Clerk auth + Supabase datos/cámara)
// v2: temas, chat, ranking, heatmap, badges, freezes, racha grupal,
//     reacciones/comentarios, muro de castigos, admin, push, zoom real.
// ============================================================

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  accessToken: async () => {
    if (!window.Clerk || !window.Clerk.session) return null;
    return await window.Clerk.session.getToken();
  }
});

const $ = (id) => document.getElementById(id);
const showScreen = (id) => {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
};

let currentUser = null;
let currentProfile = null;
let currentGroup = null;
let mediaStream = null;
let currentZoomTrack = null;
let capturedBlob = null;
let autoSendTimer = null;
let chatChannel = null;

const todayStr = () => {
  const d = new Date();
  const tz = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return tz.toISOString().slice(0, 10);
};

function randomCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function waitForClerk(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (window.Clerk) return resolve();
    const start = Date.now();
    const check = setInterval(() => {
      if (window.Clerk) { clearInterval(check); resolve(); }
      else if (Date.now() - start > timeoutMs) {
        clearInterval(check);
        reject(new Error('Clerk no cargó a tiempo (revisa tu conexión o que la clave/dominio de Clerk sean correctos)'));
      }
    }, 50);
  });
}

// ============================================================
// TEMAS
// ============================================================
const THEMES = [
  { id: 'mono', label: 'Mono', bg: '#ffffff', fg: '#000000' },
  { id: 'dark', label: 'Oscuro', bg: '#0b0b0c', fg: '#f5f5f5' },
  { id: 'sunset', label: 'Atardecer', bg: '#1a0f1f', fg: '#ff6b6b' },
  { id: 'ocean', label: 'Océano', bg: '#eaf6f8', fg: '#118ab2' },
  { id: 'forest', label: 'Bosque', bg: '#f2f7ee', fg: '#2e7d32' },
  { id: 'neon', label: 'Neón', bg: '#0a0a0f', fg: '#00ffe1' },
  { id: 'pastel', label: 'Pastel', bg: '#fff5f7', fg: '#f4a6c1' },
  { id: 'retro', label: 'Retro', bg: '#fdf3e3', fg: '#d97b3f' },
  { id: 'rosegold', label: 'Oro rosa', bg: '#fff8f5', fg: '#b76e79' },
  { id: 'coffee', label: 'Café', bg: '#f5efe6', fg: '#6f4e37' },
  { id: 'cyberpunk', label: 'Cyberpunk', bg: '#0d0d1a', fg: '#f8f32b' },
  { id: 'lavender', label: 'Lavanda', bg: '#f6f3ff', fg: '#8b6fd6' },
];

function applyTheme(themeId) {
  document.documentElement.setAttribute('data-theme', themeId || 'mono');
  localStorage.setItem('bestreak-theme', themeId || 'mono');
}

function renderThemeGrid() {
  const grid = $('theme-grid');
  grid.innerHTML = '';
  const current = currentProfile?.theme || localStorage.getItem('bestreak-theme') || 'mono';
  THEMES.forEach(t => {
    const btn = document.createElement('button');
    btn.className = 'theme-swatch flex flex-col items-center gap-1' + (t.id === current ? ' selected' : '');
    btn.innerHTML = `
      <span class="w-10 h-10 rounded-full border-2 border-app" style="background:${t.bg}"></span>
      <span class="text-[10px] font-bold text-muted-app">${t.label}</span>
    `;
    btn.addEventListener('click', async () => {
      applyTheme(t.id);
      renderThemeGrid();
      if (currentProfile) {
        currentProfile.theme = t.id;
        await sb.from('profiles').update({ theme: t.id }).eq('id', currentUser.id);
      }
    });
    grid.appendChild(btn);
  });
}

// Aplica un tema guardado (localStorage) mientras carga, para que no
// haya "flash" de blanco antes de saber el tema real del perfil.
applyTheme(localStorage.getItem('bestreak-theme'));

// ============================================================
// TABS
// ============================================================
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
  document.querySelectorAll('.tabpanel').forEach(p => p.classList.toggle('active', p.id === tabId));
  if (tabId === 'tab-ranking') renderRanking();
  if (tabId === 'tab-chat') { renderChat(); }
  if (tabId === 'tab-perfil') { renderProfileTab(); }
  if (tabId === 'tab-admin') { renderAdmin(); }
}

// ============================================================
// ARRANQUE
// ============================================================
async function boot() {
  showScreen('screen-splash');
  try {
    await waitForClerk();
    await window.Clerk.load();
  } catch (err) {
    showScreen('screen-login');
    $('login-msg').textContent = 'Error cargando el sistema de login: ' + err.message;
    return;
  }

  window.Clerk.addListener(({ user }) => {
    if (user && (!currentUser || currentUser.id !== user.id)) handleLoggedIn(user);
    else if (!user && currentUser) {
      currentUser = null; currentProfile = null; currentGroup = null;
      teardownChat();
      showScreen('screen-login');
    }
  });

  try {
    if (window.Clerk.user) await handleLoggedIn(window.Clerk.user);
    else showScreen('screen-login');
  } catch (err) {
    showScreen('screen-login');
    $('login-msg').textContent = 'Error consultando tus datos: ' + err.message;
  }
}

async function handleLoggedIn(user) {
  currentUser = user;
  try { await window.Clerk.session?.getToken(); } catch (_) {}

  const { data: profile } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (!profile) { showScreen('screen-onboarding'); return; }

  currentProfile = profile;
  applyTheme(profile.theme);
  await maybeGrantAdmin();
  await resetMonthlyFreezesIfNeeded();
  await loadGroup();
  setupChatRealtime();
  registerServiceWorkerAndPush(); // no bloqueante
  await renderFeed();
}

// Da rol admin automáticamente a ADMIN_EMAIL apenas detectamos su sesión.
async function maybeGrantAdmin() {
  try {
    const email = currentUser?.primaryEmailAddress?.emailAddress
      || currentUser?.emailAddresses?.[0]?.emailAddress || '';
    if (email && email.toLowerCase() === (window.ADMIN_EMAIL || '').toLowerCase() && !currentProfile.is_admin) {
      const { data } = await sb.from('profiles').update({ is_admin: true }).eq('id', currentUser.id).select().maybeSingle();
      if (data) currentProfile = data;
    }
  } catch (_) { /* si falla, simplemente no se activa admin todavía */ }
  $('tab-admin-btn').classList.toggle('hidden', !currentProfile.is_admin);
}

async function recoverFromDuplicateProfile(msgElId) {
  try {
    const { data: profile } = await sb.from('profiles').select('*').eq('id', currentUser.id).maybeSingle();
    if (profile) {
      currentProfile = profile;
      applyTheme(profile.theme);
      await maybeGrantAdmin();
      await loadGroup();
      setupChatRealtime();
      await renderFeed();
      return true;
    }
    $(msgElId).textContent = 'Ya existe un perfil con tu cuenta, pero no pudimos cargarlo. Cierra sesión y vuelve a entrar.';
    return false;
  } catch (err) {
    $(msgElId).textContent = 'Ya existe un perfil con tu cuenta, pero no pudimos cargarlo (' + (err?.message || err) + '). Cierra sesión y vuelve a entrar.';
    return false;
  }
}

// ---------- Login ----------
$('btn-open-login').addEventListener('click', () => {
  window.Clerk.openSignIn({ afterSignInUrl: window.location.href, afterSignUpUrl: window.location.href });
});

$('btn-logout').addEventListener('click', async () => {
  await window.Clerk.signOut();
  currentUser = null; currentProfile = null; currentGroup = null;
  teardownChat();
  showScreen('screen-login');
});

// ---------- Onboarding ----------
$('btn-tab-join').addEventListener('click', () => {
  $('join-box').classList.remove('hidden');
  $('create-box').classList.add('hidden');
});
$('btn-tab-create').addEventListener('click', () => {
  $('create-box').classList.remove('hidden');
  $('join-box').classList.add('hidden');
});

$('btn-join-group').addEventListener('click', async () => {
  const username = $('input-username').value.trim();
  const code = $('input-code').value.trim().toUpperCase();
  if (!username || !code) { $('onboarding-msg').textContent = 'Completa tu nombre y el código.'; return; }

  const btn = $('btn-join-group');
  btn.disabled = true; btn.textContent = 'Uniendo…';
  let done = false;
  try {
    const { data: group, error: gErr } = await sb.from('groups').select('*').eq('join_code', code).maybeSingle();
    if (gErr || !group) {
      $('onboarding-msg').textContent = gErr ? ('Error: ' + gErr.message) : 'No encontramos ese grupo.';
      return;
    }
    const { error: pErr } = await sb.from('profiles').insert({
      id: currentUser.id, username, group_id: group.id, streak_count: 0, status: 'active'
    });
    if (pErr) {
      if (pErr.code === '23505' && await recoverFromDuplicateProfile('onboarding-msg')) { done = true; return; }
      $('onboarding-msg').textContent = 'Error: ' + pErr.message;
      return;
    }
    await handleLoggedIn(currentUser);
    done = true;
  } catch (err) {
    $('onboarding-msg').textContent = 'Error inesperado: ' + (err?.message || err);
  } finally {
    if (!done) { btn.disabled = false; btn.textContent = 'Unirme al grupo'; }
  }
});

$('btn-create-group').addEventListener('click', async () => {
  const username = $('input-username').value.trim();
  const name = $('input-group-name').value.trim();
  const punishment = $('input-punishment').value.trim();
  if (!username || !name || !punishment) { $('onboarding-msg').textContent = 'Completa todos los campos.'; return; }

  const btn = $('btn-create-group');
  btn.disabled = true; btn.textContent = 'Creando…';
  let done = false;
  try {
    const join_code = randomCode();
    const { data: group, error: gErr } = await sb.from('groups').insert({ name, punishment, join_code }).select().single();
    if (gErr) { $('onboarding-msg').textContent = 'Error: ' + gErr.message; return; }

    const { error: pErr } = await sb.from('profiles').insert({
      id: currentUser.id, username, group_id: group.id, streak_count: 0, status: 'active'
    });
    if (pErr) {
      if (pErr.code === '23505' && await recoverFromDuplicateProfile('onboarding-msg')) { done = true; return; }
      $('onboarding-msg').textContent = 'Error: ' + pErr.message;
      return;
    }
    await handleLoggedIn(currentUser);
    done = true;
  } catch (err) {
    $('onboarding-msg').textContent = 'Error inesperado: ' + (err?.message || err);
  } finally {
    if (!done) { btn.disabled = false; btn.textContent = 'Crear grupo'; }
  }
});

// ============================================================
// FEED
// ============================================================
async function loadGroup() {
  const { data } = await sb.from('groups').select('*').eq('id', currentProfile.group_id).single();
  currentGroup = data;
}

async function renderFeed() {
  showScreen('screen-feed');
  $('feed-group-name').textContent = currentGroup.name;
  $('feed-punishment').textContent = '🎯 ' + currentGroup.punishment + ` · código ${currentGroup.join_code}`;
  $('my-streak').textContent = currentProfile.streak_count;
  $('my-freezes').textContent = `❄️ ${currentProfile.freezes_available ?? 0}`;

  if ((currentGroup.group_streak_count || 0) > 0) {
    $('group-perfect-badge').classList.remove('hidden');
    $('group-perfect-count').textContent = currentGroup.group_streak_count;
  } else {
    $('group-perfect-badge').classList.add('hidden');
  }

  const { data: myPostToday } = await sb.from('posts').select('*')
    .eq('user_id', currentUser.id).eq('date', todayStr()).maybeSingle();

  if (!myPostToday) {
    $('feed-locked').classList.remove('hidden');
    $('feed-unlocked').classList.add('hidden');
    return;
  }

  $('feed-locked').classList.add('hidden');
  $('feed-unlocked').classList.remove('hidden');
  $('feed-unlocked').classList.add('flex');

  const { data: posts } = await sb.from('posts')
    .select('*, profiles(username, streak_count), post_reactions(user_id, emoji), post_comments(id, user_id, body, created_at, profiles(username))')
    .eq('group_id', currentGroup.id).eq('date', todayStr())
    .order('created_at', { ascending: false });

  renderFeedList(posts || []);
}

const REACTION_EMOJIS = ['🔥', '😂', '👀', '💀', '🥶', '🙌'];

function renderFeedList(posts) {
  const list = $('feed-list');
  list.innerHTML = '';
  posts.forEach(p => {
    const card = document.createElement('div');
    card.className = 'border-2 border-app bg-card';

    const reactionCounts = {};
    (p.post_reactions || []).forEach(r => { reactionCounts[r.emoji] = (reactionCounts[r.emoji] || 0) + 1; });
    const myReaction = (p.post_reactions || []).find(r => r.user_id === currentUser.id)?.emoji;

    const reactionsHtml = REACTION_EMOJIS.map(e => `
      <button data-post="${p.id}" data-emoji="${e}"
        class="reaction-btn text-sm px-2 py-1 rounded-full border border-app ${myReaction === e ? 'bg-accent text-accent-fg' : ''}">
        ${e} ${reactionCounts[e] || ''}
      </button>`).join('');

    const commentsHtml = (p.post_comments || [])
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .map(c => `<p class="text-xs"><b>${c.profiles?.username ?? 'usuario'}:</b> ${escapeHtml(c.body)}</p>`)
      .join('');

    card.innerHTML = `
      <div class="flex items-center justify-between px-3 py-2 border-b-2 border-app">
        <span class="font-bold">${p.profiles?.username ?? 'usuario'}</span>
        <span class="text-sm">🔥 ${p.profiles?.streak_count ?? 0} ${p.is_late ? '· <span class="text-fail">tarde</span>' : ''}</span>
      </div>
      <img src="${p.image_url}" class="w-full aspect-[3/4] object-cover" />
      ${p.caption ? `<p class="px-3 pt-2 text-sm">${escapeHtml(p.caption)}</p>` : ''}
      <div class="flex flex-wrap gap-2 px-3 py-2">${reactionsHtml}</div>
      <div class="px-3 pb-2 flex flex-col gap-1">${commentsHtml}</div>
      <form class="comment-form flex gap-2 px-3 pb-3" data-post="${p.id}">
        <input type="text" maxlength="300" placeholder="Comenta…" class="flex-1 border border-app bg-transparent px-2 py-1 text-xs outline-none" />
        <button type="submit" class="text-xs font-bold underline">Enviar</button>
      </form>
    `;
    list.appendChild(card);
  });

  list.querySelectorAll('.reaction-btn').forEach(btn => {
    btn.addEventListener('click', () => toggleReaction(btn.dataset.post, btn.dataset.emoji));
  });
  list.querySelectorAll('.comment-form').forEach(form => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = form.querySelector('input');
      const body = input.value.trim();
      if (!body) return;
      await sb.from('post_comments').insert({ post_id: form.dataset.post, user_id: currentUser.id, body });
      input.value = '';
      await renderFeed();
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function toggleReaction(postId, emoji) {
  const { data: existing } = await sb.from('post_reactions').select('*')
    .eq('post_id', postId).eq('user_id', currentUser.id).maybeSingle();
  if (existing && existing.emoji === emoji) {
    await sb.from('post_reactions').delete().eq('id', existing.id);
  } else if (existing) {
    await sb.from('post_reactions').update({ emoji }).eq('id', existing.id);
  } else {
    await sb.from('post_reactions').insert({ post_id: postId, user_id: currentUser.id, emoji });
  }
  await renderFeed();
}

// ============================================================
// RANKING + MURO DE CASTIGOS
// ============================================================
async function renderRanking() {
  const { data: members } = await sb.from('profiles').select('*')
    .eq('group_id', currentGroup.id).order('streak_count', { ascending: false });

  const list = $('ranking-list');
  list.innerHTML = '';
  (members || []).forEach((m, i) => {
    const row = document.createElement('div');
    row.className = 'flex items-center justify-between border-b border-divider py-2';
    row.innerHTML = `
      <span class="font-bold">${i + 1}. ${m.username}${m.id === currentUser.id ? ' (tú)' : ''}</span>
      <span class="text-sm">🔥 ${m.streak_count} · mejor ${m.best_streak ?? 0}</span>
    `;
    list.appendChild(row);
  });

  const { data: punishments } = await sb.from('punishment_log').select('*, profiles(username)')
    .eq('group_id', currentGroup.id).order('created_at', { ascending: false }).limit(20);

  const wall = $('punishment-wall');
  wall.innerHTML = '';
  if (!punishments || punishments.length === 0) {
    wall.innerHTML = '<p class="text-sm text-muted-app">Nadie ha roto la racha todavía 👀</p>';
    return;
  }
  punishments.forEach(p => {
    const row = document.createElement('div');
    row.className = 'border border-app p-2 text-sm';
    row.innerHTML = `
      <p><b>${p.profiles?.username ?? 'usuario'}</b> rompió la racha el ${p.broken_date}.</p>
      <p class="text-muted-app">Castigo: ${escapeHtml(p.punishment_text)} — ${p.fulfilled ? '✅ cumplido' : '⏳ pendiente'}</p>
      ${!p.fulfilled && p.user_id === currentUser.id ? `<button data-log="${p.id}" class="fulfill-btn text-xs font-bold underline mt-1">Marcar como cumplido</button>` : ''}
    `;
    wall.appendChild(row);
  });
  wall.querySelectorAll('.fulfill-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await sb.from('punishment_log').update({ fulfilled: true }).eq('id', btn.dataset.log);
      renderRanking();
    });
  });
}

// ============================================================
// CHAT DE GRUPO
// ============================================================
async function renderChat() {
  const { data: messages } = await sb.from('group_messages').select('*, profiles(username)')
    .eq('group_id', currentGroup.id).order('created_at', { ascending: true }).limit(200);
  paintChatMessages(messages || []);
}

function paintChatMessages(messages) {
  const list = $('chat-list');
  list.innerHTML = '';
  messages.forEach(m => {
    const mine = m.user_id === currentUser.id;
    const row = document.createElement('div');
    row.className = `max-w-[80%] px-3 py-2 rounded-2xl text-sm ${mine ? 'self-end bg-accent text-accent-fg' : 'self-start bg-card border border-app'}`;
    row.innerHTML = `${!mine ? `<p class="text-xs font-bold opacity-70">${m.profiles?.username ?? 'usuario'}</p>` : ''}<p>${escapeHtml(m.body)}</p>`;
    list.appendChild(row);
  });
  list.scrollTop = list.scrollHeight;
}

function setupChatRealtime() {
  teardownChat();
  chatChannel = sb.channel(`group-chat-${currentGroup.id}`)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'group_messages',
      filter: `group_id=eq.${currentGroup.id}`
    }, async () => { if ($('tab-chat').classList.contains('active')) await renderChat(); })
    .subscribe();
}
function teardownChat() {
  if (chatChannel) { sb.removeChannel(chatChannel); chatChannel = null; }
}

$('btn-chat-send').addEventListener('click', sendChatMessage);
$('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChatMessage(); });
async function sendChatMessage() {
  const input = $('chat-input');
  const body = input.value.trim();
  if (!body) return;
  input.value = '';
  await sb.from('group_messages').insert({ group_id: currentGroup.id, user_id: currentUser.id, body });
  await renderChat();
}

// ============================================================
// PERFIL: heatmap + badges + freezes + temas
// ============================================================
const BADGE_MILESTONES = [
  { days: 7, label: '7 días', emoji: '🥉' },
  { days: 14, label: '14 días', emoji: '🥈' },
  { days: 30, label: '30 días', emoji: '🥇' },
  { days: 60, label: '60 días', emoji: '🏆' },
  { days: 100, label: '100 días', emoji: '💎' },
  { days: 200, label: '200 días', emoji: '👑' },
  { days: 365, label: '1 año', emoji: '🚀' },
];

async function renderProfileTab() {
  $('profile-username').textContent = currentProfile.username;
  $('profile-best').textContent = currentProfile.best_streak ?? 0;
  $('profile-freezes').textContent = currentProfile.freezes_available ?? 0;
  renderThemeGrid();

  const best = Math.max(currentProfile.best_streak || 0, currentProfile.streak_count || 0);
  const badges = $('badges');
  badges.innerHTML = '';
  BADGE_MILESTONES.forEach(b => {
    const unlocked = best >= b.days;
    const el = document.createElement('span');
    el.className = `text-xs font-bold px-3 py-2 rounded-full border border-app ${unlocked ? 'bg-accent text-accent-fg' : 'text-muted-app opacity-40'}`;
    el.textContent = `${b.emoji} ${b.label}`;
    badges.appendChild(el);
  });

  const { data: posts } = await sb.from('posts').select('date')
    .eq('user_id', currentUser.id).order('date', { ascending: false }).limit(105);
  const postedDates = new Set((posts || []).map(p => p.date));

  const grid = $('heatmap');
  grid.innerHTML = '';
  const days = [];
  for (let i = 104; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }
  days.forEach(d => {
    const cell = document.createElement('div');
    const posted = postedDates.has(d);
    cell.className = 'heat-cell';
    cell.title = d;
    cell.style.background = posted ? 'var(--accent)' : 'var(--divider)';
    grid.appendChild(cell);
  });
}

async function resetMonthlyFreezesIfNeeded() {
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  if (currentProfile.last_freeze_reset_month !== month) {
    const { data } = await sb.from('profiles')
      .update({ freezes_available: 2, last_freeze_reset_month: month })
      .eq('id', currentUser.id).select().maybeSingle();
    if (data) currentProfile = data;
  }
}

// ============================================================
// ADMIN
// ============================================================
async function renderAdmin() {
  const { data: groups } = await sb.from('groups').select('*, profiles(id)');
  const gDiv = $('admin-groups');
  gDiv.innerHTML = '';
  (groups || []).forEach(g => {
    const row = document.createElement('div');
    row.className = 'border border-app p-2 text-sm flex items-center justify-between';
    row.innerHTML = `<span>${g.name} · código ${g.join_code} · ${g.profiles?.length ?? 0} miembros</span>`;
    gDiv.appendChild(row);
  });

  const { data: profiles } = await sb.from('profiles').select('*').order('streak_count', { ascending: false });
  const pDiv = $('admin-profiles');
  pDiv.innerHTML = '';
  (profiles || []).forEach(p => {
    const row = document.createElement('div');
    row.className = 'border border-app p-2 text-sm flex items-center justify-between gap-2';
    row.innerHTML = `
      <span>${p.username} ${p.is_admin ? '👑' : ''} · 🔥${p.streak_count}</span>
      <button data-id="${p.id}" class="admin-reset-btn text-xs font-bold underline">Resetear racha</button>
    `;
    pDiv.appendChild(row);
  });
  pDiv.querySelectorAll('.admin-reset-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await sb.from('profiles').update({ streak_count: 0, status: 'active' }).eq('id', btn.dataset.id);
      renderAdmin();
    });
  });
}

// ============================================================
// CAPTURA (sin espejo, con zoom real, auto-envío)
// ============================================================
$('btn-go-capture').addEventListener('click', openCapture);
$('btn-close-capture').addEventListener('click', closeCapture);
$('btn-retry-camera').addEventListener('click', startCamera);

function openCapture() {
  showScreen('screen-capture');
  $('capture-live').classList.remove('hidden'); $('capture-live').classList.add('flex');
  $('capture-preview').classList.add('hidden');
  $('capture-error').classList.add('hidden');
  startCamera();
}

function closeCapture() {
  cancelAutoSend();
  if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
  mediaStream = null;
  renderFeed();
}

async function startCamera() {
  $('capture-error').classList.add('hidden'); $('capture-error').classList.remove('flex');
  $('capture-live').classList.remove('hidden'); $('capture-live').classList.add('flex');
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1080 }, height: { ideal: 1440 } },
      audio: false
    });
    $('video').srcObject = mediaStream;
    setupZoom();
  } catch (err) {
    $('capture-live').classList.add('hidden'); $('capture-live').classList.remove('flex');
    $('capture-error').classList.remove('hidden'); $('capture-error').classList.add('flex');
  }
}

// Zoom "profesional": usa el zoom óptico/de hardware si el navegador lo
// expone (Chrome/Android); si no, hace zoom digital (recorte + escala)
// sobre el propio <video>, que en cualquier navegador se ve igual de bien.
function setupZoom() {
  currentZoomTrack = mediaStream.getVideoTracks()[0];
  const caps = currentZoomTrack.getCapabilities ? currentZoomTrack.getCapabilities() : {};
  const slider = $('zoom-slider');
  const video = $('video');
  $('zoom-controls').classList.remove('hidden');
  $('zoom-controls').classList.add('flex');

  if (caps.zoom) {
    slider.min = caps.zoom.min;
    slider.max = caps.zoom.max;
    slider.step = caps.zoom.step || 0.1;
    slider.value = caps.zoom.min;
    video.style.transform = 'scaleX(-1)'; // sin zoom digital extra
    slider.oninput = async () => {
      const z = parseFloat(slider.value);
      $('zoom-label').textContent = z.toFixed(1) + 'x';
      try { await currentZoomTrack.applyConstraints({ advanced: [{ zoom: z }] }); } catch (_) {}
    };
  } else {
    // Zoom digital: escalamos el video con CSS (mantenemos el espejo).
    slider.min = 1; slider.max = 3; slider.step = 0.1; slider.value = 1;
    slider.oninput = () => {
      const z = parseFloat(slider.value);
      $('zoom-label').textContent = z.toFixed(1) + 'x';
      video.style.transform = `scaleX(-1) scale(${z})`;
    };
  }
  $('zoom-label').textContent = '1.0x';
}

$('btn-shutter').addEventListener('click', () => {
  const video = $('video');
  const canvas = $('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');

  // Aplicamos el mismo zoom digital (si corresponde) al capturar, y
  // NUNCA invertimos horizontalmente: la foto final se ve tal cual la
  // realidad, no como un espejo (aunque el visor en vivo sí es espejo,
  // por comodidad al encuadrarte).
  const videoTransform = video.style.transform || '';
  const zoomMatch = videoTransform.match(/scale\(([\d.]+)\)/);
  const digitalZoom = zoomMatch ? parseFloat(zoomMatch[1]) : 1;

  if (digitalZoom > 1) {
    const cropW = canvas.width / digitalZoom;
    const cropH = canvas.height / digitalZoom;
    const cropX = (canvas.width - cropW) / 2;
    const cropY = (canvas.height - cropH) / 2;
    ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height);
  } else {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  }

  $('capture-live').classList.add('hidden'); $('capture-live').classList.remove('flex');
  $('capture-preview').classList.remove('hidden'); $('capture-preview').classList.add('flex');

  startAutoSendCountdown();
});

$('btn-retake').addEventListener('click', () => {
  cancelAutoSend();
  $('capture-preview').classList.add('hidden'); $('capture-preview').classList.remove('flex');
  $('capture-live').classList.remove('hidden'); $('capture-live').classList.add('flex');
});

// La app ya NO espera a que presiones "Enviar": apenas tomas la foto
// arranca una cuenta regresiva y se sube sola. Solo puedes cancelarla
// tocando "Repetir".
function startAutoSendCountdown() {
  let count = 2;
  $('autosend-count').textContent = count;
  cancelAutoSend();
  autoSendTimer = setInterval(() => {
    count -= 1;
    if (count <= 0) {
      cancelAutoSend();
      sendPhoto();
    } else {
      $('autosend-count').textContent = count;
    }
  }, 1000);
}
function cancelAutoSend() {
  if (autoSendTimer) { clearInterval(autoSendTimer); autoSendTimer = null; }
}

async function sendPhoto() {
  $('capture-preview').classList.add('hidden');
  $('capture-uploading').classList.remove('hidden'); $('capture-uploading').classList.add('flex');

  const canvas = $('canvas');
  const blob = await new Promise(res => canvas.toBlob(res, 'image/webp', 0.85));
  const date = todayStr();
  const path = `${currentUser.id}/${date}.webp`;

  const { error: upErr } = await sb.storage.from('daily-snaps').upload(path, blob, {
    contentType: 'image/webp', upsert: true
  });
  if (upErr) { alert('Error subiendo la foto: ' + upErr.message); closeCapture(); return; }

  const { data: pub } = sb.storage.from('daily-snaps').getPublicUrl(path);

  // Hora de Chile para saber si llega "tarde" (después de las 21:00,
  // que es cuando llega el recordatorio push).
  const chileHour = parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santiago', hour: '2-digit', hour12: false
  }).format(new Date()), 10);
  const isLate = chileHour >= 21;

  const { error: insErr } = await sb.from('posts').insert({
    user_id: currentUser.id, group_id: currentGroup.id, image_url: pub.publicUrl, date, is_late: isLate
  });
  if (insErr) { alert('Error guardando el post: ' + insErr.message); closeCapture(); return; }

  await updateStreak(date);
  await updateGroupPerfectStreak(date);

  if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
  mediaStream = null;
  $('capture-uploading').classList.add('hidden'); $('capture-uploading').classList.remove('flex');
  await renderFeed();
}

// ============================================================
// RACHA (con freeze automático)
// ============================================================
async function updateStreak(date) {
  const { data: prevPosts } = await sb.from('posts').select('date')
    .eq('user_id', currentUser.id).lt('date', date)
    .order('date', { ascending: false }).limit(1);

  const yesterday = new Date(date);
  yesterday.setDate(yesterday.getDate() - 1);
  const yStr = yesterday.toISOString().slice(0, 10);

  const twoDaysAgo = new Date(date);
  twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
  const twoStr = twoDaysAgo.toISOString().slice(0, 10);

  let newCount = 1;
  let newStatus = 'active';
  let usedFreeze = false;
  let freezesLeft = currentProfile.freezes_available ?? 0;

  if (prevPosts?.[0]?.date === yStr) {
    newCount = (currentProfile.streak_count || 0) + 1;
  } else if (prevPosts?.[0]?.date === twoStr && freezesLeft > 0) {
    // Faltó exactamente un día: usamos un freeze automático para
    // salvar la racha, como los "streak freeze" de Duolingo.
    newCount = (currentProfile.streak_count || 0) + 1;
    freezesLeft -= 1;
    usedFreeze = true;
  } else if (prevPosts?.[0]) {
    newStatus = 'failed';
    await registerPunishment(date);
  }

  const bestStreak = Math.max(currentProfile.best_streak || 0, newCount);

  await sb.from('profiles').update({
    streak_count: newCount, status: newStatus, best_streak: bestStreak, freezes_available: freezesLeft
  }).eq('id', currentUser.id);

  if (usedFreeze) await sb.from('posts').update({ used_freeze: true }).eq('user_id', currentUser.id).eq('date', date);

  currentProfile.streak_count = newCount;
  currentProfile.status = newStatus;
  currentProfile.best_streak = bestStreak;
  currentProfile.freezes_available = freezesLeft;

  if (usedFreeze) setTimeout(() => alert('❄️ Usaste un freeze automático para salvar tu racha (te quedan ' + freezesLeft + ').'), 300);
}

async function registerPunishment(brokenDate) {
  await sb.from('punishment_log').insert({
    group_id: currentGroup.id, user_id: currentUser.id, broken_date: brokenDate,
    punishment_text: currentGroup.punishment
  });
}

// Racha grupal "perfecta": si TODOS los miembros activos del grupo
// subieron foto hoy, sube el contador; si no todos subieron, se deja
// como está (se reinicia solo cuando alguien rompe la racha individual
// y por ende ya no hay "todos" un día).
async function updateGroupPerfectStreak(date) {
  const { count: memberCount } = await sb.from('profiles')
    .select('id', { count: 'exact', head: true }).eq('group_id', currentGroup.id);
  const { count: postCount } = await sb.from('posts')
    .select('id', { count: 'exact', head: true }).eq('group_id', currentGroup.id).eq('date', date);

  if (memberCount && postCount && memberCount === postCount) {
    const yesterday = new Date(date); yesterday.setDate(yesterday.getDate() - 1);
    const yStr = yesterday.toISOString().slice(0, 10);
    const wasConsecutive = currentGroup.last_perfect_date === yStr;
    const newCount = wasConsecutive ? (currentGroup.group_streak_count || 0) + 1 : 1;
    await sb.from('groups').update({ group_streak_count: newCount, last_perfect_date: date }).eq('id', currentGroup.id);
    currentGroup.group_streak_count = newCount;
    currentGroup.last_perfect_date = date;
  }
}

// ============================================================
// NOTIFICACIONES PUSH (recordatorio 21:00 si no has subido)
// ============================================================
$('btn-notif').addEventListener('click', async () => {
  if (!('Notification' in window)) { alert('Tu navegador no soporta notificaciones.'); return; }
  if (Notification.permission === 'granted') { alert('Ya tienes activados los recordatorios de las 21:00 🔔'); return; }
  await registerServiceWorkerAndPush(true);
});

async function registerServiceWorkerAndPush(userInitiated = false) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (!VAPID_PUBLIC_KEY || VAPID_PUBLIC_KEY.includes('PON_AQUI')) return; // aún no configurado

  try {
    const reg = await navigator.serviceWorker.register('sw.js');

    if (Notification.permission === 'default' && userInitiated) {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return;
    }
    if (Notification.permission !== 'granted') return;

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      });
    }
    const json = sub.toJSON();
    await sb.from('push_subscriptions').upsert({
      user_id: currentUser.id, endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth
    }, { onConflict: 'user_id,endpoint' });

    if (userInitiated) alert('Listo, te llegará un recordatorio a las 21:00 si aún no subiste tu foto 🔔');
  } catch (err) {
    if (userInitiated) alert('No pudimos activar las notificaciones: ' + (err?.message || err));
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

boot();
