// Listen for completed downloads matching BCP's "Corriente Soles" Excel files
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state?.current !== 'complete') return;

  chrome.downloads.search({ id: delta.id }, ([item]) => {
    if (!item) return;
    const filename = item.filename.replace(/\\/g, '/').split('/').pop();
    if (/Corriente.Soles.*\.xlsx$/i.test(filename)) {
      chrome.storage.local.set({
        lastBcpFile: { filename, path: item.filename, downloadedAt: Date.now() }
      });
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#e85d04' });
    }
  });
});

// Clear badge when popup opens
chrome.action.onClicked.addListener(() => {
  chrome.action.setBadgeText({ text: '' });
});

// ─── Save rows to Google Sheet ───────────────────────────────────────────────
// La HOJA es la fuente de verdad: antes de enviar se le pregunta qué Nº de
// operación BCP ya tiene y sólo se manda lo que falta. Antes se confiaba en un
// historial local de "ya enviado" (sentSheetKeys); si una fila se enviaba pero
// no quedaba visible en la hoja (por ejemplo por un filtro activo), la
// extensión la daba por guardada para siempre y nunca la reintentaba.

// "02108000" -> "2108000". Sin operación (vacío, "0", "00000000") -> "".
// La hoja guarda el Nº como número, así que pierde los ceros a la izquierda.
function normOp(v) {
  return String(v == null ? '' : v).replace(/\D/g, '').replace(/^0+/, '');
}

// Para filas sin Nº de operación (p. ej. ITF): fecha + monto + descripción.
function fallbackKey(r) {
  return `${String(r.fecha || '').trim()}|${Number(r.monto)}|${String(r.descripcion || '').trim()}`;
}

// Pregunta a la hoja qué ya tiene. Devuelve null si el Apps Script es una
// versión anterior (sin doGet) o no responde.
async function fetchSheetState(url) {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow' });
    const data = JSON.parse(await res.text());
    if (data && data.ok && Array.isArray(data.ops)) {
      return { ops: new Set(data.ops), fallbacks: new Set(data.fallbacks || []) };
    }
  } catch (_) { /* Apps Script antiguo o sin red: se usa el modo heredado */ }
  return null;
}

async function postRows(url, rows) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(rows),
    redirect: 'follow',
  });
  const text = await res.text();
  console.log('[Sheets] Respuesta:', text);
  if (!res.ok) throw new Error(`Apps Script error ${res.status}: ${text}`);
  return text;
}

async function saveToSheets(url, rows) {
  const state = await fetchSheetState(url);
  if (state) return saveAgainstSheet(url, rows, state);
  console.warn('[Sheets] El Apps Script no responde al GET: modo heredado. ' +
               'Actualiza apps-script/Code.gs para validar contra la hoja.');
  return saveLegacy(url, rows);
}

// Modo nuevo: sólo se envían las filas cuyo Nº de operación NO está en la hoja.
async function saveAgainstSheet(url, rows, state) {
  const seen = new Set();
  const newRows = rows.filter(r => {
    const op = normOp(r.operacion);
    const key = op ? `op:${op}` : `fb:${fallbackKey(r)}`;
    if (seen.has(key)) return false;                 // repetida dentro del mismo archivo
    seen.add(key);
    return op ? !state.ops.has(op) : !state.fallbacks.has(fallbackKey(r));
  });

  // Se envía igual aunque no haya filas nuevas (lista vacía): el Apps Script
  // vuelve a conciliar con Gastos y Compras, por si registraste algo después.
  if (newRows.length === 0) {
    console.log('[Sheets] Sin filas nuevas: todas las operaciones ya están en la hoja');
  }

  const text = await postRows(url, newRows);
  let reply = null;
  try { reply = JSON.parse(text); } catch (_) {}
  if (reply && reply.ok === false) throw new Error(`Apps Script: ${reply.error}`);

  // El conteo lo da la hoja: eso es lo que realmente quedó escrito.
  const added = reply && typeof reply.added === 'number' ? reply.added : newRows.length;
  const reconciled = reply && typeof reply.reconciled === 'number' ? reply.reconciled : 0;
  return { result: added > 0 ? 'sent' : 'skipped', added, skipped: rows.length - added, reconciled };
}

// Modo heredado (Apps Script sin doGet): historial local, como antes.
async function saveLegacy(url, rows) {
  const stored = await chrome.storage.local.get(['sentSheetKeys']);
  const sentKeys = new Set(stored.sentSheetKeys || []);
  const keyOf = r => {
    const op = normOp(r.operacion);
    return op ? `op:${op}` : `${r.fecha}|${r.monto}|${String(r.descripcion || '').trim()}`;
  };

  const newRows = rows.filter(r => !sentKeys.has(keyOf(r)));
  if (newRows.length === 0) {
    return { result: 'skipped', added: 0, skipped: rows.length, legacy: true };
  }

  await postRows(url, newRows);
  newRows.forEach(r => sentKeys.add(keyOf(r)));
  await chrome.storage.local.set({ sentSheetKeys: [...sentKeys] });
  return { result: 'sent', added: newRows.length, skipped: rows.length - newRows.length, legacy: true };
}

// Deja "Cliente · ORD-..." en la columna H de la fila del ingreso validado.
// Sólo se envía si el Apps Script declara la capacidad 'assign': un script
// antiguo tomaría este mensaje como una fila bancaria y la agregaría a la hoja.
// Estado de la hoja y capacidades del Apps Script (null si no responde).
async function getSheetCaps(url) {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow' });
    return JSON.parse(await res.text());
  } catch (_) { return null; }
}

const supportsAssign = caps => !!caps && Array.isArray(caps.features) && caps.features.includes('assign');

async function assignPedidos(url, items) {
  const caps = await getSheetCaps(url);
  if (!supportsAssign(caps)) return { ok: false, unsupported: true };
  const text = await postRows(url, { action: 'assign', items });
  try { return JSON.parse(text); } catch (_) { return { ok: false, error: 'respuesta inválida' }; }
}

// Origen de los ingresos que ya existen en la hoja con la columna H vacía:
// de todas las operaciones ya verificadas en Apartalo (candidates) sólo se
// envían las que corresponden a un ingreso sin cliente/pedido.
async function fillOrigins(url, candidates) {
  const caps = await getSheetCaps(url);
  if (!supportsAssign(caps) || !Array.isArray(caps.blankIncomes)) return { ok: false, unsupported: true };
  const blank = new Set(caps.blankIncomes.map(normOp));
  const items = candidates.filter(c => blank.has(normOp(c.operacion)));
  if (items.length === 0) return { ok: true, assigned: 0, pending: blank.size };
  const text = await postRows(url, { action: 'assign', items });
  let reply; try { reply = JSON.parse(text); } catch (_) { return { ok: false, error: 'respuesta inválida' }; }
  return { ...reply, pending: blank.size - (reply.assigned || 0) };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'FILL_ORIGINS' && msg.url && Array.isArray(msg.items)) {
    fillOrigins(msg.url, msg.items)
      .then(reply => sendResponse(reply))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'ASSIGN_PEDIDO' && msg.url && Array.isArray(msg.items)) {
    assignPedidos(msg.url, msg.items)
      .then(reply => sendResponse(reply))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type !== 'SAVE_TO_SHEETS' || !msg.url || !msg.rows) return;
  saveToSheets(msg.url, msg.rows)
    .then(outcome => sendResponse({ ok: true, ...outcome }))
    .catch(e => {
      console.warn('[Sheets] ❌ Error:', e.message);
      sendResponse({ ok: false, error: e.message });
    });
  return true; // keep channel open for async sendResponse
});
