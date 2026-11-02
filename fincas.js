// ─── fincas: movimientos del banco ───────────────────────────────────────────
// Cada archivo de BCP también se guarda en fincas (tabla bank_movements). La base no repite una
// línea ya guardada y la cruza sola con los pagos de los formularios, los pedidos de Apartalo y los
// retiros a caja. Lo que queda va a la lista "Bank movements to match" de Finanzas.
//
// Login: Google en la extensión (chrome.identity) → Firebase apartalo-10146 → token que fincas
// acepta. Nunca se guarda una clave maestra; sólo el token de la persona y su token de renovación.

async function fincasSignIn() {
  const { token } = await chrome.identity.getAuthToken({ interactive: true });
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${FINCAS.firebaseApiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      postBody: `access_token=${token}&providerId=google.com`,
      requestUri: 'http://localhost',
      returnSecureToken: true,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `Firebase ${res.status}`);
  await saveFincasSession(data.idToken, data.refreshToken, data.expiresIn, data.email);
  return data.email;
}

async function fincasSignOut() {
  await chrome.storage.local.remove('fincasSession');
  try {
    const { token } = await chrome.identity.getAuthToken({ interactive: false });
    if (token) await chrome.identity.removeCachedAuthToken({ token });
  } catch (_) { /* no había sesión de Google */ }
}

async function saveFincasSession(idToken, refreshToken, expiresIn, email) {
  const fincasSession = {
    idToken, refreshToken, email,
    expiresAt: Date.now() + (Number(expiresIn) - 60) * 1000, // se renueva un minuto antes
  };
  await chrome.storage.local.set({ fincasSession });
  return fincasSession;
}

// Token vigente, renovándolo si venció. null si no hay sesión.
async function fincasIdToken() {
  const { fincasSession: s } = await chrome.storage.local.get('fincasSession');
  if (!s) return null;
  if (Date.now() < s.expiresAt) return s.idToken;
  const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FINCAS.firebaseApiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(s.refreshToken)}`,
  });
  const data = await res.json();
  if (!res.ok) { await chrome.storage.local.remove('fincasSession'); return null; }
  return (await saveFincasSession(data.id_token, data.refresh_token, data.expires_in, s.email)).idToken;
}

async function fincasEmail() {
  const { fincasSession: s } = await chrome.storage.local.get('fincasSession');
  return s ? s.email : null;
}

// "28/10/2026" -> "2026-10-28"
function bcpDateToIso(str) {
  const [d, m, y] = String(str || '').trim().split('/');
  return y ? `${y.padStart(4, '20')}-${m.padStart(2, '0')}-${d.padStart(2, '0')}` : null;
}

// Envía las filas del archivo (las mismas que van a la hoja). Devuelve el resumen de la base, o
// { skipped: motivo } si no hay sesión o finca configurada.
async function sendToFincas(allRows, fileName, farmId) {
  const token = await fincasIdToken();
  if (!token) return { skipped: 'sin sesión en fincas' };
  if (!farmId) return { skipped: 'sin finca configurada' };
  const rows = allRows
    .map(r => ({
      date: bcpDateToIso(r.fecha),
      description: r.descripcion,
      amount: r.tipo === 'gasto' ? -Math.abs(r.monto) : Math.abs(r.monto),
      operation: r.operacion,
    }))
    .filter(r => r.date && r.amount);
  const res = await fetch(`${FINCAS.supabaseUrl}/rest/v1/rpc/record_bank_movements_v2`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: FINCAS.supabaseKey,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ p_rows: rows, p_source_file: fileName || null, p_business_id: farmId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || `fincas ${res.status}`);
  return data;
}
