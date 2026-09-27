// ============================================================
// BeStreak — lógica principal (Clerk auth + Supabase datos/cámara)
// ============================================================

// El cliente de Supabase ahora recibe el token de sesión de Clerk
// en cada request, en vez de manejar su propio login (accessToken).
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
      if (window.Clerk) {
        clearInterval(check);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(check);
        reject(new Error('Clerk no cargó a tiempo (revisa tu conexión o que la clave/dominio de Clerk sean correctos)'));
      }
    }, 50);
  });
}

// ---------- Arranque ----------
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

  // Reacciona a cambios de sesión (login/logout) en cualquier momento
  window.Clerk.addListener(({ user }) => {
    if (user && (!currentUser || currentUser.id !== user.id)) {
      handleLoggedIn(user);
    } else if (!user && currentUser) {
      currentUser = null; currentProfile = null; currentGroup = null;
      showScreen('screen-login');
    }
  });

  try {
    if (window.Clerk.user) {
      await handleLoggedIn(window.Clerk.user);
    } else {
      showScreen('screen-login');
    }
  } catch (err) {
    showScreen('screen-login');
    $('login-msg').textContent = 'Error consultando tus datos: ' + err.message;
  }
}

async function handleLoggedIn(user) {
  currentUser = user; // objeto de usuario de Clerk (user.id es tipo "user_xxx")

  // Nos aseguramos de que el token de Clerk ya esté listo antes de
  // consultar Supabase. En un arranque en frío (PWA instalada) esto
  // puede tardar un instante; si consultamos demasiado pronto, la
  // consulta sale sin token válido, la política de seguridad (RLS)
  // no devuelve tu perfil aunque exista, y la app cree que sos nuevo.
  try {
    await window.Clerk.session?.getToken();
  } catch (_) { /* seguimos igual, el reintento de abajo cubre esto */ }

  const { data: profile } = await sb.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (!profile) {
    showScreen('screen-onboarding');
    return;
  }
  currentProfile = profile;
  await loadGroup();
  await renderFeed();
}

// Si un insert de perfil falla porque el id ya existe (23505), es
// casi seguro que el usuario YA tenía perfil y solo falló la lectura
// inicial. En vez de mostrar un error, recuperamos su perfil real.
async function recoverFromDuplicateProfile(msgElId) {
  const { data: profile } = await sb.from('profiles').select('*').eq('id', currentUser.id).maybeSingle();
  if (profile) {
    currentProfile = profile;
    await loadGroup();
    await renderFeed();
    return true;
  }
  $(msgElId).textContent = 'Ya existe un perfil con tu cuenta, pero no pudimos cargarlo. Cierra sesión y vuelve a entrar.';
  return false;
}

// ---------- Login (Clerk) ----------
$('btn-open-login').addEventListener('click', () => {
  window.Clerk.openSignIn({
    afterSignInUrl: window.location.href,
    afterSignUpUrl: window.location.href
  });
});

$('btn-logout').addEventListener('click', async () => {
  await window.Clerk.signOut();
  currentUser = null; currentProfile = null; currentGroup = null;
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

  const { data: group, error: gErr } = await sb.from('groups').select('*').eq('join_code', code).maybeSingle();
  if (gErr || !group) {
    $('onboarding-msg').textContent = 'No encontramos ese grupo.';
    btn.disabled = false; btn.textContent = 'Unirme al grupo';
    return;
  }

  const { error: pErr } = await sb.from('profiles').insert({
    id: currentUser.id, username, group_id: group.id, streak_count: 0, status: 'active'
  });
  if (pErr) {
    if (pErr.code === '23505' && await recoverFromDuplicateProfile('onboarding-msg')) return;
    $('onboarding-msg').textContent = 'Error: ' + pErr.message;
    btn.disabled = false; btn.textContent = 'Unirme al grupo';
    return;
  }

  await handleLoggedIn(currentUser);
});

$('btn-create-group').addEventListener('click', async () => {
  const username = $('input-username').value.trim();
  const name = $('input-group-name').value.trim();
  const punishment = $('input-punishment').value.trim();
  if (!username || !name || !punishment) { $('onboarding-msg').textContent = 'Completa todos los campos.'; return; }

  const btn = $('btn-create-group');
  btn.disabled = true; btn.textContent = 'Creando…';

  const join_code = randomCode();
  const { data: group, error: gErr } = await sb.from('groups')
    .insert({ name, punishment, join_code }).select().single();
  if (gErr) {
    $('onboarding-msg').textContent = 'Error: ' + gErr.message;
    btn.disabled = false; btn.textContent = 'Crear grupo';
    return;
  }

  const { error: pErr } = await sb.from('profiles').insert({
    id: currentUser.id, username, group_id: group.id, streak_count: 0, status: 'active'
  });
  if (pErr) {
    if (pErr.code === '23505' && await recoverFromDuplicateProfile('onboarding-msg')) return;
    $('onboarding-msg').textContent = 'Error: ' + pErr.message;
    btn.disabled = false; btn.textContent = 'Crear grupo';
    return;
  }

  await handleLoggedIn(currentUser);
});

// ---------- Feed ----------
async function loadGroup() {
  const { data } = await sb.from('groups').select('*').eq('id', currentProfile.group_id).single();
  currentGroup = data;
}

async function renderFeed() {
  showScreen('screen-feed');
  $('feed-group-name').textContent = currentGroup.name;
  $('feed-punishment').textContent = '🎯 ' + currentGroup.punishment + ` · código ${currentGroup.join_code}`;
  $('my-streak').textContent = currentProfile.streak_count;

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

  const { data: posts } = await sb.from('posts').select('*, profiles(username, streak_count)')
    .eq('group_id', currentGroup.id).eq('date', todayStr())
    .order('created_at', { ascending: false });

  const list = $('feed-list');
  list.innerHTML = '';
  (posts || []).forEach(p => {
    const card = document.createElement('div');
    card.className = 'border-2 border-black';
    card.innerHTML = `
      <div class="flex items-center justify-between px-3 py-2 border-b-2 border-black">
        <span class="font-bold">${p.profiles?.username ?? 'usuario'}</span>
        <span class="text-sm">🔥 ${p.profiles?.streak_count ?? 0}</span>
      </div>
      <img src="${p.image_url}" class="w-full aspect-[3/4] object-cover" />
    `;
    list.appendChild(card);
  });
}

// ---------- Captura ----------
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
  } catch (err) {
    $('capture-live').classList.add('hidden'); $('capture-live').classList.remove('flex');
    $('capture-error').classList.remove('hidden'); $('capture-error').classList.add('flex');
  }
}

$('btn-shutter').addEventListener('click', () => {
  const video = $('video');
  const canvas = $('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);

  $('capture-live').classList.add('hidden'); $('capture-live').classList.remove('flex');
  $('capture-preview').classList.remove('hidden'); $('capture-preview').classList.add('flex');
});

$('btn-retake').addEventListener('click', () => {
  $('capture-preview').classList.add('hidden'); $('capture-preview').classList.remove('flex');
  $('capture-live').classList.remove('hidden'); $('capture-live').classList.add('flex');
});

$('btn-send').addEventListener('click', async () => {
  $('capture-preview').classList.add('hidden');
  $('capture-uploading').classList.remove('hidden'); $('capture-uploading').classList.add('flex');

  const canvas = $('canvas');
  const blob = await new Promise(res => canvas.toBlob(res, 'image/webp', 0.8));
  const date = todayStr();
  const path = `${currentUser.id}/${date}.webp`;

  const { error: upErr } = await sb.storage.from('daily-snaps').upload(path, blob, {
    contentType: 'image/webp', upsert: true
  });
  if (upErr) { alert('Error subiendo la foto: ' + upErr.message); closeCapture(); return; }

  const { data: pub } = sb.storage.from('daily-snaps').getPublicUrl(path);

  const { error: insErr } = await sb.from('posts').insert({
    user_id: currentUser.id, group_id: currentGroup.id, image_url: pub.publicUrl, date
  });
  if (insErr) { alert('Error guardando el post: ' + insErr.message); closeCapture(); return; }

  await updateStreak(date);

  if (mediaStream) mediaStream.getTracks().forEach(t => t.stop());
  mediaStream = null;
  $('capture-uploading').classList.add('hidden'); $('capture-uploading').classList.remove('flex');
  await renderFeed();
});

// ---------- Racha ----------
async function updateStreak(date) {
  const { data: prevPosts } = await sb.from('posts').select('date')
    .eq('user_id', currentUser.id).lt('date', date)
    .order('date', { ascending: false }).limit(1);

  const yesterday = new Date(date);
  yesterday.setDate(yesterday.getDate() - 1);
  const yStr = yesterday.toISOString().slice(0, 10);

  let newCount = 1;
  let newStatus = 'active';
  if (prevPosts?.[0]?.date === yStr) {
    newCount = (currentProfile.streak_count || 0) + 1;
  } else if (prevPosts?.[0]) {
    newStatus = 'failed'; // hubo una racha previa que se rompió
  }

  await sb.from('profiles').update({ streak_count: newCount, status: newStatus }).eq('id', currentUser.id);
  currentProfile.streak_count = newCount;
  currentProfile.status = newStatus;
}

boot();
