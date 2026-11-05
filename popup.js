// ─── Constants ───────────────────────────────────────────────────────────────
const DEFAULT_API = 'https://apartalo-core-9d633cdb9e1a.herokuapp.com';

// ─── State ───────────────────────────────────────────────────────────────────
let settings = { apiUrl: DEFAULT_API, businessId: '', fincasFarmId: '' };
let pendingOrders = [];
let bcpTransfers = [];
let matches = [];
let manualCandidates = []; // rows in the "sin transferencia" alert, indexed by button
let autoVerifiedCount = 0;

// ─── DOM refs ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const dropZone      = $('dropZone');
const fileInput     = $('fileInput');
const settingsPanel = $('settingsPanel');
const statusEl      = $('status');
const resultsEl     = $('results');
const matchList     = $('matchList');
const noMatches     = $('noMatches');

// ─── Init ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  bindEvents();
  chrome.action.setBadgeText({ text: '' });
});

async function loadSettings() {
  const stored = await chrome.storage.local.get(['apiUrl', 'businessId', 'fincasFarmId']);
  settings.apiUrl       = stored.apiUrl       || DEFAULT_API;
  settings.businessId   = stored.businessId   || '';
  settings.fincasFarmId = stored.fincasFarmId || FINCAS.defaultFarmId;
  $('apiUrl').value       = settings.apiUrl;
  $('businessId').value   = settings.businessId;
  $('fincasFarmId').value = settings.fincasFarmId;
  await showFincasUser();
}

async function showFincasUser() {
  const email = await fincasEmail();
  $('fincasUser').textContent = email ? `fincas: ${email}` : 'fincas: sin sesión';
  $('btnFincasSignIn').classList.toggle('hidden', !!email);
  $('btnFincasSignOut').classList.toggle('hidden', !email);
}

function bindEvents() {
  // Settings toggle
  $('btnSettings').addEventListener('click', () => {
    settingsPanel.classList.toggle('hidden');
  });

  $('btnSaveSettings').addEventListener('click', async () => {
    settings.apiUrl     = $('apiUrl').value.trim().replace(/\/$/, '');
    settings.businessId = $('businessId').value.trim();
    settings.fincasFarmId = $('fincasFarmId').value.trim();
    await chrome.storage.local.set(settings);
    settingsPanel.classList.add('hidden');
    showStatus('Configuración guardada ✓', 'success');
  });

  // fincas login
  $('btnFincasSignIn').addEventListener('click', async () => {
    try {
      const email = await fincasSignIn();
      showStatus(`Sesión de fincas iniciada: ${email} ✓`, 'success');
    } catch (err) {
      showStatus(`No se pudo iniciar sesión en fincas: ${err?.message || err}`, 'error');
    }
    await showFincasUser();
  });
  $('btnFincasSignOut').addEventListener('click', async () => {
    await fincasSignOut();
    await showFincasUser();
    showStatus('Sesión de fincas cerrada', 'success');
  });

  // Drop zone
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) processFile(fileInput.files[0]);
  });

  // Confirm all
  $('btnConfirmAll').addEventListener('click', () => confirmAll());
}

// ─── File processing ─────────────────────────────────────────────────────────
async function processFile(file) {
  if (!settings.businessId) {
    showStatus('⚠️ Configura el Business ID primero (⚙️)', 'error');
    settingsPanel.classList.remove('hidden');
    return;
  }

  showStatus('Leyendo archivo Excel...', 'loading');
  resultsEl.classList.add('hidden');

  try {
    const parsed = await parseXlsx(file);
    bcpTransfers = parsed.transfers;
    if (bcpTransfers.length === 0 && parsed.allRows.length === 0) {
      showStatus('No se encontraron transferencias en el archivo.', 'error');
      return;
    }

    // Cada línea del banco se guarda sólo en fincas, la base oficial (General Manager, 5 nov 2026: ya no en la hoja).
    // La base no repite líneas y las cruza sola con los pagos de la app, los pedidos y los retiros a caja.
    let fincasSummary;
    try {
      const f = await sendToFincas(parsed.allRows, file.name, settings.fincasFarmId);
      if (f.skipped) {
        showStatus(`⚠️ No se guardó en fincas (${f.skipped}). Ve a ⚙️ e inicia sesión con Google.`, 'error');
        settingsPanel.classList.remove('hidden');
        return;
      }
      fincasSummary = `fincas: ${f.added} nuevas, ${f.already_saved} ya estaban, ${f.matched_now} cruzadas, ${f.still_to_match} sin cruzar.`;
    } catch (err) {
      console.error('sendToFincas error:', err);
      showStatus(`⚠️ No se guardó en fincas: ${err?.message || err}`, 'error');
      return;
    }

    showStatus(`${fincasSummary} Encontradas ${bcpTransfers.length} transacciones. Cargando pedidos...`, 'loading');
    pendingOrders = await fetchPendingOrders();

    if (pendingOrders.length === 0) {
      showStatus(`${fincasSummary} No hay pedidos pendientes de pago en Apartalo.`, 'success');
      return;
    }

    // Auto-verificar: pedidos con pago registrado pero sin evidencia
    showStatus('Verificando pagos sin comprobante...', 'loading');
    autoVerifiedCount = await autoVerifyNoVoucherPayments(bcpTransfers, pendingOrders);

    // Recargar pedidos para que reflejen las evidencias recién creadas
    if (autoVerifiedCount > 0) {
      pendingOrders = await fetchPendingOrders();
    }

    showStatus('Leyendo comprobantes (OCR)...', 'loading');
    await extractOperationNumbersFromVouchers(pendingOrders);

    const { results, unmatchedTransfers, unmatchedEvidencias } = matchPayments(bcpTransfers, pendingOrders);
    matches = results;

    // Izipay orders: paid online, not in BCP — need manual check in Izipay account
    // Exclude cancelled orders
    const CANCELLED = ['CANCELADO', 'CANCELLED', 'canceled', 'cancelled'];
    const izipayOrders = pendingOrders.filter(o =>
      (o.paymentMethod || '').startsWith('izipay') &&
      !CANCELLED.includes((o.estado || '').toUpperCase()) &&
      !CANCELLED.includes(o.estado || '')
    );

    renderResults(unmatchedTransfers, unmatchedEvidencias, izipayOrders);
  } catch (err) {
    const msg = err?.message || String(err) || 'Error desconocido';
    showStatus(`Error: ${msg}`, 'error');
    console.error('processFile error:', err);
  }
}

// ─── Parse BCP Excel ─────────────────────────────────────────────────────────
// BCP "Corriente Soles" format:
//   A: Fecha | B: Descripcion | C: Moneda | D: Monto | E: Numero de Operacion
//   Positive Monto = incoming payment. Negative = debit (ignored).
function parseXlsx(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

        // Find header row containing "Fecha" and "Monto"
        let headerIdx = rows.findIndex(row =>
          row.some(c => /^fecha$/i.test(String(c).trim())) &&
          row.some(c => /^monto$/i.test(String(c).trim()))
        );
        if (headerIdx === -1) headerIdx = 0; // fallback to first row

        const headers = rows[headerIdx].map(h => String(h).trim().toLowerCase());
        const iF = headers.indexOf('fecha');
        const iD = headers.indexOf('descripcion');
        const iM = headers.indexOf('monto');
        const iN = headers.findIndex(h => /numero|operacion/i.test(h));

        const transfers = [];
        const allRows = [];
        for (const row of rows.slice(headerIdx + 1)) {
          const raw = row[iM];
          const amount = parseFloat(String(raw).replace(/[,]/g, '.').replace(/[^\d.-]/g, ''));
          if (!amount) continue;

          const entry = {
            fecha:       iF >= 0 ? String(row[iF]).trim() : '',
            descripcion: iD >= 0 ? String(row[iD]).trim() : '',
            operacion:   iN >= 0 ? String(row[iN]).trim() : '',
            monto:       Math.abs(amount),
            tipo:        amount > 0 ? 'ingreso' : 'gasto',
          };
          allRows.push(entry);
          if (amount > 0) transfers.push(entry);
        }
        resolve({ transfers, allRows });
      } catch (err) {
        reject(new Error('No se pudo leer el Excel: ' + err.message));
      }
    };
    reader.onerror = () => reject(new Error('Error leyendo el archivo'));
    reader.readAsArrayBuffer(file);
  });
}

// ─── Fetch pending orders from Apartalo ──────────────────────────────────────
// Fetches orders with estadoPago = PAGADO or PARCIAL in parallel
async function fetchPendingOrders() {
  const base = `${settings.apiUrl}/api/pedidos/${settings.businessId}`;
  const [resPagado, resParcial, resPendiente] = await Promise.all([
    fetch(`${base}?estadoPago=PAGADO&limite=200`),
    fetch(`${base}?estadoPago=PARCIAL&limite=200`),
    fetch(`${base}?estadoPago=PENDIENTE_PAGO&limite=200`),
  ]);
  if (!resPagado.ok) throw new Error(`Apartalo API error: ${resPagado.status}`);
  if (!resParcial.ok) throw new Error(`Apartalo API error: ${resParcial.status}`);

  const toArray = d => Array.isArray(d) ? d : (d.pedidos || d.data || []);
  const [dataPagado, dataParcial, dataPendiente] = await Promise.all([
    resPagado.json(), resParcial.json(), resPendiente.ok ? resPendiente.json() : Promise.resolve([])
  ]);

  // Merge and deduplicate by id
  const all = [...toArray(dataPagado), ...toArray(dataParcial), ...toArray(dataPendiente)];
  const seen = new Set();
  return all.filter(o => seen.has(o.id) ? false : seen.add(o.id));
}

// ─── OCR: extract operation number via backend ───────────────────────────────
// Only processes unverified vouchers within the BCP Excel date range.
async function extractOperationNumbersFromVouchers(orders) {
  const parseBCPDate = str => {
    const [d, m, y] = (str || '').split('/');
    return y ? new Date(`${y}-${m}-${d}`) : null;
  };
  const bcpDates = bcpTransfers.map(t => parseBCPDate(t.fecha)).filter(Boolean);
  const minDate = bcpDates.length ? new Date(Math.min(...bcpDates) - 86400000) : null;
  const maxDate = bcpDates.length ? new Date(Math.max(...bcpDates) + 86400000) : null;

  const toProcess = [];
  for (const order of orders) {
    for (const ev of (order.evidencias || [])) {
      if (!ev.url) continue;
      if (ev.verificacion?.estado === 'VERIFICADO') continue;
      if (ev.operacionBCP) continue;
      if (minDate && maxDate && ev.fecha) {
        const evDate = new Date(ev.fecha);
        if (evDate < minDate || evDate > maxDate) continue;
      }
      toProcess.push(ev);
    }
  }

  if (toProcess.length === 0) return;

  showStatus(`Leyendo ${toProcess.length} comprobante(s) con OCR...`, 'loading');

  await Promise.all(toProcess.map(async ev => {
    try {
      const res = await fetch(
        `${settings.apiUrl}/api/ocr/voucher?url=${encodeURIComponent(ev.url)}`
      );
      if (!res.ok) return;
      const { operacion } = await res.json();
      if (operacion) ev.operacionBCP = operacion;
    } catch (e) {
      console.warn('OCR failed for', ev.id, e.message);
    }
  }));
}

// ─── Genera PNG con canvas y lo sube a Supabase vía backend ──────────────────
function drawBcpReceiptCanvas(operacion, monto, fecha, descripcion) {
  const canvas = document.createElement('canvas');
  canvas.width  = 480;
  canvas.height = 220;
  const ctx = canvas.getContext('2d');

  // Fondo
  ctx.fillStyle = '#f0fdf4';
  ctx.beginPath();
  ctx.roundRect(0, 0, 480, 220, 12);
  ctx.fill();

  // Borde verde
  ctx.strokeStyle = '#16a34a';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(2, 2, 476, 216, 10);
  ctx.stroke();

  // Cabecera
  ctx.fillStyle = '#15803d';
  ctx.font = 'bold 15px Arial';
  ctx.fillText('✓  BCP · Transferencia Verificada', 20, 38);

  // Línea separadora
  ctx.strokeStyle = '#bbf7d0';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(20, 50); ctx.lineTo(460, 50);
  ctx.stroke();

  // Operación
  ctx.fillStyle = '#6b7280';
  ctx.font = '13px Arial';
  ctx.fillText('Operación:', 20, 78);
  ctx.fillStyle = '#111827';
  ctx.font = 'bold 14px Arial';
  ctx.fillText(operacion || '—', 120, 78);

  // Monto
  ctx.fillStyle = '#6b7280';
  ctx.font = '13px Arial';
  ctx.fillText('Monto:', 20, 112);
  ctx.fillStyle = '#15803d';
  ctx.font = 'bold 22px Arial';
  ctx.fillText(`S/ ${parseFloat(monto).toFixed(2)}`, 120, 114);

  // Fecha
  ctx.fillStyle = '#6b7280';
  ctx.font = '13px Arial';
  ctx.fillText('Fecha:', 20, 148);
  ctx.fillStyle = '#111827';
  ctx.font = '14px Arial';
  ctx.fillText(fecha || '', 120, 148);

  // Descripción
  ctx.fillStyle = '#374151';
  ctx.font = '12px Arial';
  ctx.fillText((descripcion || '').substring(0, 55), 20, 175);

  // Footer
  ctx.fillStyle = '#9ca3af';
  ctx.font = '10px Arial';
  ctx.fillText('Auto-verificado · BCP Apartalo Validator', 20, 208);

  return canvas.toDataURL('image/png');
}

async function uploadBcpReceipt(operacion, monto, fecha, descripcion) {
  try {
    const image    = drawBcpReceiptCanvas(operacion, monto, fecha, descripcion);
    const filename = `bcp-${(operacion || Date.now()).toString().replace(/[^a-zA-Z0-9]/g, '')}-${Date.now()}.png`;

    // upload-router espera POST /api/upload/:businessId con { image, filename, type }
    const res = await fetch(`${settings.apiUrl}/api/upload/${settings.businessId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, filename, type: 'image/png' })
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => res.status);
      console.warn('[uploadReceipt] upload failed', res.status, txt);
      return '';
    }

    const data = await res.json();
    const url  = data.url || '';
    if (!url) console.warn('[uploadReceipt] no URL in response', data);
    return url;
  } catch (e) {
    console.warn('[uploadReceipt] error:', e.message);
    return '';
  }
}

// ─── Auto-verify: pedidos con pago pero sin evidencia ────────────────────────
// Para cada pedido que tenga pagos registrados pero ningún comprobante:
//   1. Busca una transferencia BCP con monto exacto
//   2. Crea la evidencia con los datos BCP
//   3. La marca como VERIFICADO automáticamente
// Devuelve el número de pedidos auto-verificados.
async function autoVerifyNoVoucherPayments(transfers, orders) {
  const usedTransferIdxs = new Set();
  let verified = 0;

  // Marcar las transferencias ya usadas por evidencias VERIFICADAS existentes
  for (const order of orders) {
    for (const ev of (order.evidencias || [])) {
      if (ev.verificacion?.estado === 'VERIFICADO' && ev.verificacion.operacionBCP) {
        const idx = transfers.findIndex((t, i) =>
          !usedTransferIdxs.has(i) && t.operacion === ev.verificacion.operacionBCP
        );
        if (idx !== -1) usedTransferIdxs.add(idx);
      }
    }
  }

  const parseBCPDateAV = str => {
    const [d, m, y] = (str || '').split('/');
    return y ? new Date(`${y}-${m}-${d}`) : null;
  };

  for (const order of orders) {
    if ((order.pagos || []).length === 0) continue;       // sin pago registrado
    if ((order.evidencias || []).length > 0) continue;    // ya tiene comprobante
    const orderTotal = parseFloat(order.total) || 0;
    if (orderTotal <= 0) continue;

    // Get order payment date for date proximity check
    const pagoDates = (order.pagos || []).map(p => p.fecha ? new Date(p.fecha) : null).filter(Boolean);
    const orderPayDate = pagoDates.length ? new Date(Math.max(...pagoDates)) : (order.fechaPago ? new Date(order.fechaPago) : null);

    // Buscar transferencia BCP con monto exacto y fecha cercana (±5 días)
    const matchIdx = transfers.findIndex((t, i) => {
      if (usedTransferIdxs.has(i)) return false;
      if (Math.abs(t.monto - orderTotal) >= 0.01) return false;
      if (orderPayDate) {
        const bcpD = parseBCPDateAV(t.fecha);
        if (bcpD && Math.abs((bcpD - orderPayDate) / 86400000) > 5) return false;
      }
      return true;
    });
    if (matchIdx === -1) continue;

    const t = transfers[matchIdx];
    const opRef = t.operacion || `AUTO-${t.fecha}-${t.monto}`;
    try {
      const base = `${settings.apiUrl}/api/pedidos/${settings.businessId}`;

      // 1. Generar y subir imagen PNG del comprobante BCP
      const receiptUrl = await uploadBcpReceipt(opRef, t.monto, t.fecha, t.descripcion);
      const resEv = await fetch(`${base}/${order.id}/evidencias`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: receiptUrl,
          tipo: 'BCP',
          descripcion: `Auto-verificado · Op. ${opRef} · ${t.fecha}`
        })
      });
      if (!resEv.ok) { console.warn(`[autoVerify] Error creando evidencia para ${order.id}:`, resEv.status); continue; }
      const evData = await resEv.json();
      const evidenciaId = evData.evidencia?.id;
      if (!evidenciaId) { console.warn(`[autoVerify] Sin evidenciaId para ${order.id}`); continue; }

      // 2. Marcar como VERIFICADO
      const resVer = await fetch(`${base}/${order.id}/evidencias/${evidenciaId}/verificar`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operacionBCP: opRef, montoVerificado: t.monto, fechaOperacion: t.fecha })
      });
      if (!resVer.ok) { console.warn(`[autoVerify] Error verificando evidencia para ${order.id}:`, resVer.status); continue; }

      usedTransferIdxs.add(matchIdx);
      verified++;
      console.log(`[autoVerify] ✅ ${order.id} (${order.cliente}) S/${t.monto} — Op. ${opRef}`);
    } catch (e) {
      console.warn(`[autoVerify] Excepción para ${order.id}:`, e.message);
    }
  }

  return verified;
}

function findSubsetSum(candidates, target, limit) {
  // Sort descending by amount to prune search tree faster
  const sorted = [...candidates].sort((a, b) => b.expectedAmount - a.expectedAmount);
  function searchSorted(start, remaining, current) {
    if (Math.abs(remaining) < 0.01) return current;
    if (current.length >= limit || start >= sorted.length) return null;
    for (let i = start; i < sorted.length; i++) {
      const amt = sorted[i].expectedAmount;
      if (amt > remaining + 0.01) continue;
      const result = searchSorted(i + 1, remaining - amt, [...current, sorted[i]]);
      if (result) return result;
    }
    return null;
  }
  return searchSorted(0, target, []);
}

// ─── Match transfers to individual unverified vouchers ───────────────────────
// Priority: match by operation number (exact). Fallback: amount + date proximity.
// Fallback uses global best-match assignment (closest date wins, not first-come).
function matchPayments(transfers, orders) {
  const results = [];
  const usedTransfers = new Set();
  const usedEvidencias = new Set(); // key: "orderId:evidenciaId"

  const parseBCPDate = str => {
    const [d, m, y] = (str || '').split('/');
    return y ? new Date(`${y}-${m}-${d}`) : null;
  };

  // Pre-mark transfers already consumed by VERIFICADO evidencias
  for (const order of orders) {
    for (const ev of (order.evidencias || [])) {
      if (ev.verificacion?.estado === 'VERIFICADO' && ev.verificacion.operacionBCP) {
        const idx = transfers.findIndex(
          (t, i) => !usedTransfers.has(i) && t.operacion === ev.verificacion.operacionBCP
        );
        if (idx !== -1) usedTransfers.add(idx);
      }
    }
  }

  // Build flat list of unverified evidencias with expected amounts
  const candidates = [];
  for (const order of orders) {
    const evidencias = order.evidencias || [];
    const pagos = order.pagos || [];
    const orderTotal = parseFloat(order.total) || 0;
    const unverified = evidencias.filter(
      e => !e.verificacion || e.verificacion.estado !== 'VERIFICADO'
    );
    if (unverified.length === 0) continue;

    const verifiedTotal = evidencias
      .filter(e => e.verificacion?.estado === 'VERIFICADO')
      .reduce((sum, e) => sum + (parseFloat(e.verificacion?.montoVerificado) || 0), 0);
    const remaining = orderTotal - verifiedTotal;

    unverified.forEach(evidencia => {
      const originalIdx = evidencias.indexOf(evidencia);
      const pagoMonto = pagos[originalIdx] ? parseFloat(pagos[originalIdx].monto) : null;
      const expectedAmount = pagoMonto || (remaining / unverified.length);
      candidates.push({ order, evidencia, expectedAmount });
    });
  }

  // Pass 0: grouped match — multiple evidencias sharing the same OCR operation number
  // (one BCP transfer paying several orders at once)
  const opGroups = new Map();
  for (const c of candidates) {
    if (!c.evidencia.operacionBCP) continue;
    const key = c.evidencia.operacionBCP;
    if (!opGroups.has(key)) opGroups.set(key, []);
    opGroups.get(key).push(c);
  }
  for (const [op, group] of opGroups) {
    if (group.length < 2) continue; // single evidencia → handled by Pass 1
    const totalAmount = group.reduce((sum, g) => sum + g.expectedAmount, 0);
    const matchIdx = transfers.findIndex((t, i) =>
      !usedTransfers.has(i) && t.operacion === op && Math.abs(t.monto - totalAmount) < 0.01
    );
    if (matchIdx === -1) continue;
    usedTransfers.add(matchIdx);
    group.forEach(g => usedEvidencias.add(`${g.order.id}:${g.evidencia.id}`));
    results.push({
      type: 'grouped',
      group: group.map(g => ({ order: g.order, evidencia: g.evidencia })),
      transfer: transfers[matchIdx],
      totalAmount,
      confirmed: false,
    });
  }

  // Pass 1: OCR exact match by operation number
  for (const { order, evidencia, expectedAmount } of candidates) {
    if (!evidencia.operacionBCP) continue;
    const evKey = `${order.id}:${evidencia.id}`;
    const matchIdx = transfers.findIndex((t, i) =>
      !usedTransfers.has(i) && t.operacion === evidencia.operacionBCP
    );
    if (matchIdx !== -1) {
      usedTransfers.add(matchIdx);
      usedEvidencias.add(evKey);
      results.push({ type: 'single', order, evidencia, transfer: transfers[matchIdx], confirmed: false });
    }
  }

  // Truncate date to midnight UTC to avoid time-of-day skewing the diff
  const toMidnight = d => {
    const m = new Date(d);
    m.setUTCHours(0, 0, 0, 0);
    return m;
  };

  // Reference date for an evidencia, preferring the date the transfer actually
  // happened over the date the voucher was uploaded. Clients often upload a
  // voucher days after paying, so `evidencia.fecha` (upload time) lags the BCP
  // statement date and must be compared with a looser, one-sided window.
  const getEvidenciaRefDate = (evidencia, order) => {
    const exact = evidencia.fechaOperacion
      || evidencia.fechaTransferencia
      || evidencia.verificacion?.fechaOperacion;
    if (exact) {
      const d = new Date(exact);
      if (!isNaN(d)) return { date: toMidnight(d), exact: true };
    }
    // A pago row records when the payment was registered — closer to the real
    // transfer date than the upload timestamp, but still not authoritative.
    const idx = (order.evidencias || []).indexOf(evidencia);
    const pago = (order.pagos || [])[idx];
    if (pago?.fecha) {
      const d = new Date(pago.fecha);
      if (!isNaN(d)) return { date: toMidnight(d), exact: false };
    }
    if (evidencia.fecha) {
      const d = new Date(evidencia.fecha);
      if (!isNaN(d)) return { date: toMidnight(d), exact: false };
    }
    return { date: null, exact: false };
  };

  // Window when the reference date is the real operation date: symmetric and tight.
  const EXACT_WINDOW_DAYS = 2;
  // Window when the reference date is an upload/registration date: the transfer
  // can precede it by days, but should never come meaningfully after it.
  const LAG_BEFORE_DAYS = 10;
  const LAG_AFTER_DAYS  = 2;

  // Pass 2: fallback — collect all valid (evidencia, transfer) pairs with date diff
  const fallbackPairs = [];
  for (const { order, evidencia, expectedAmount } of candidates) {
    const evKey = `${order.id}:${evidencia.id}`;
    if (usedEvidencias.has(evKey)) continue; // already matched by OCR
    const { date: evDate, exact: evDateExact } = getEvidenciaRefDate(evidencia, order);

    for (let i = 0; i < transfers.length; i++) {
      if (usedTransfers.has(i)) continue;
      const t = transfers[i];
      if (Math.abs(t.monto - expectedAmount) >= 0.01) continue;
      let dateDiff = 0;
      if (evDate && t.fecha) {
        const bcpDate = parseBCPDate(t.fecha);
        if (bcpDate) {
          // Positive = BCP transfer happened before the evidencia reference date
          const delta = (evDate - toMidnight(bcpDate)) / 86400000;
          if (evDateExact) {
            if (Math.abs(delta) > EXACT_WINDOW_DAYS) continue;
          } else if (delta > LAG_BEFORE_DAYS || delta < -LAG_AFTER_DAYS) {
            continue;
          }
          dateDiff = Math.abs(delta);
        }
      }
      fallbackPairs.push({ order, evidencia, evKey, transferIdx: i, dateDiff });
    }
  }

  // Sort by closest date first so best matches are assigned before worse ones
  fallbackPairs.sort((a, b) => a.dateDiff - b.dateDiff);

  // Greedy assignment: closest date pair wins
  for (const pair of fallbackPairs) {
    if (usedEvidencias.has(pair.evKey)) continue;
    if (usedTransfers.has(pair.transferIdx)) continue;
    usedTransfers.add(pair.transferIdx);
    usedEvidencias.add(pair.evKey);
    results.push({ type: 'single', order: pair.order, evidencia: pair.evidencia, transfer: transfers[pair.transferIdx], confirmed: false });
  }

  // Pass 3: subset-sum fallback — unmatched transfer whose amount equals the sum
  // of 2-5 unmatched orders (handles OCR misread operation numbers)
  const unmatchedCandidates = candidates.filter(
    c => !usedEvidencias.has(`${c.order.id}:${c.evidencia.id}`)
  );
  // Group unmatched candidates by order (one entry per order, take first evidencia)
  const unmatchedOrderMap = new Map();
  for (const c of unmatchedCandidates) {
    if (!unmatchedOrderMap.has(c.order.id)) unmatchedOrderMap.set(c.order.id, c);
  }
  const unmatchedOrderList = [...unmatchedOrderMap.values()];

  // Group unmatched candidates by client name — only search within same client
  const byClient = new Map();
  for (const c of unmatchedOrderList) {
    const key = (c.order.cliente || '').trim().toLowerCase();
    if (!byClient.has(key)) byClient.set(key, []);
    byClient.get(key).push(c);
  }

  // Same asymmetry as Pass 2: order dates are registration dates, so the BCP
  // transfer may precede them by several days but should not follow them.
  const MAX_DATE_BEFORE_DAYS = LAG_BEFORE_DAYS;
  const MAX_DATE_AFTER_DAYS  = LAG_AFTER_DAYS;

  // Helper: get the best date from an order to compare against BCP transfer
  // Uses most recent pago date, then fechaPago, then order creation date
  const getOrderDate = order => {
    const pagos = order.pagos || [];
    if (pagos.length > 0) {
      const dates = pagos.map(p => p.fecha ? new Date(p.fecha) : null).filter(Boolean);
      if (dates.length) return new Date(Math.max(...dates));
    }
    if (order.fechaPago) return new Date(order.fechaPago);
    if (order.fecha) return new Date(order.fecha);
    return null;
  };

  for (let ti = 0; ti < transfers.length; ti++) {
    if (usedTransfers.has(ti)) continue;
    const t = transfers[ti];
    const bcpDate = parseBCPDate(t.fecha);
    let found = null;
    for (const clientCandidates of byClient.values()) {
      if (clientCandidates.length < 2) continue; // need at least 2 orders
      // Filter to orders whose payment date is within ±5 days of the BCP transfer
      const nearby = bcpDate
        ? clientCandidates.filter(c => {
            const od = getOrderDate(c.order);
            if (!od) return true; // no date info → allow
            const delta = (toMidnight(od) - toMidnight(bcpDate)) / 86400000;
            return delta <= MAX_DATE_BEFORE_DAYS && delta >= -MAX_DATE_AFTER_DAYS;
          })
        : clientCandidates;
      if (nearby.length < 2) continue;
      found = findSubsetSum(nearby, t.monto, 5);
      if (found) break;
    }
    if (!found) continue;
    usedTransfers.add(ti);
    const group = found.map(c => {
      usedEvidencias.add(`${c.order.id}:${c.evidencia.id}`);
      return { order: c.order, evidencia: c.evidencia };
    });
    results.push({
      type: 'grouped',
      group,
      transfer: t,
      totalAmount: found.reduce((s, c) => s + c.expectedAmount, 0),
      confirmed: false,
    });
  }

  // Sort all results: grouped first, then by transfer date desc
  results.sort((a, b) => {
    if (a.type === 'grouped' && b.type !== 'grouped') return -1;
    if (b.type === 'grouped' && a.type !== 'grouped') return 1;
    const toMs = str => {
      const [d, m, y] = (str || '').split('/');
      return y ? new Date(`${y}-${m}-${d}`).getTime() : 0;
    };
    return toMs(b.transfer.fecha) - toMs(a.transfer.fecha);
  });

  // Collect unmatched incoming transfers
  const unmatchedTransfers = transfers.filter((_, i) => !usedTransfers.has(i));

  // Collect evidencias with a voucher that got no match — only within BCP date window ±5 days
  const bcpDatesAll = transfers.map(t => parseBCPDate(t.fecha)).filter(Boolean);
  const bcpMin = bcpDatesAll.length ? new Date(Math.min(...bcpDatesAll) - 5 * 86400000) : null;
  const bcpMax = bcpDatesAll.length
    ? new Date(Math.max(...bcpDatesAll) + LAG_BEFORE_DAYS * 86400000)
    : null;

  const unmatchedEvidencias = [];
  for (const { order, evidencia } of candidates) {
    const evKey = `${order.id}:${evidencia.id}`;
    if (!usedEvidencias.has(evKey) && evidencia.url) {
      // Filter by date: evidencia date or order pago date must be within BCP window
      if (bcpMin && bcpMax) {
        const evDate = evidencia.fecha ? new Date(evidencia.fecha) : null;
        const pagoDates = (order.pagos || []).map(p => p.fecha ? new Date(p.fecha) : null).filter(Boolean);
        const refDate = evDate || (pagoDates.length ? new Date(Math.max(...pagoDates)) : null);
        if (refDate && (refDate < bcpMin || refDate > bcpMax)) continue;
      }
      unmatchedEvidencias.push({ order, evidencia });
    }
  }

  return { results, unmatchedTransfers, unmatchedEvidencias };
}

// ─── Render grouped match card ────────────────────────────────────────────────
function renderGroupedCard(m, i) {
  const card = document.createElement('div');
  card.className = 'match-card match-card--grouped';
  card.id = `card-${i}`;

  const orderRows = m.group.map(({ order }) =>
    `<li>
       <strong>${order.id}</strong> · ${order.cliente || 'Sin nombre'} ·
       S/ ${parseFloat(order.total).toFixed(2)}
     </li>`
  ).join('');

  card.innerHTML = `
    <div class="match-top">
      <span class="match-cliente">
        🔗 ${m.group.length} pedidos · mismo comprobante
      </span>
      <span class="match-amount">S/ ${m.transfer.monto.toFixed(2)}</span>
    </div>
    <div class="match-meta">
      <div>${m.transfer.fecha} · Op. <strong>${m.transfer.operacion}</strong></div>
      <div class="match-desc">${m.transfer.descripcion}</div>
    </div>
    <ul class="grouped-orders">${orderRows}</ul>
    <div class="grouped-total">
      Total pedidos: <strong>S/ ${m.totalAmount.toFixed(2)}</strong>
      ${Math.abs(m.transfer.monto - m.totalAmount) < 0.01
        ? '<span class="grouped-ok">✓ Cubierto</span>'
        : `<span class="grouped-diff">Diferencia: S/ ${(m.transfer.monto - m.totalAmount).toFixed(2)}</span>`
      }
    </div>
    <div class="match-actions">
      <button class="btn-primary btn-small" data-action="confirm" data-idx="${i}">✓ Verificar todos</button>
      <button class="btn-ghost" data-action="skip" data-idx="${i}">Ignorar</button>
    </div>
  `;
  card.querySelector('[data-action="confirm"]').addEventListener('click', () => confirmMatch(i));
  card.querySelector('[data-action="skip"]').addEventListener('click', () => skipMatch(i));
  matchList.appendChild(card);
}

// ─── Render results ───────────────────────────────────────────────────────────
function renderResults(unmatchedTransfers = [], unmatchedEvidencias = [], izipayOrders = []) {
  matchList.innerHTML = '';
  statusEl.classList.add('hidden');
  resultsEl.classList.remove('hidden');

  if (matches.length === 0) {
    noMatches.classList.remove('hidden');
    $('resultsSummary').textContent = 'Sin coincidencias';
    $('btnConfirmAll').classList.add('hidden');
    renderAlerts(unmatchedTransfers, unmatchedEvidencias, izipayOrders);
    return;
  }

  noMatches.classList.add('hidden');
  const autoTxt = autoVerifiedCount > 0 ? ` · ${autoVerifiedCount} auto-verificado${autoVerifiedCount > 1 ? 's' : ''}` : '';
  $('resultsSummary').textContent = `${matches.length} coincidencia${matches.length > 1 ? 's' : ''} encontrada${matches.length > 1 ? 's' : ''}${autoTxt}`;
  $('btnConfirmAll').classList.remove('hidden');

  matches.forEach((m, i) => {
    if (m.type === 'grouped') {
      renderGroupedCard(m, i);
      return;
    }

    const rawUrl = m.evidencia ? m.evidencia.url : null;

    // Convertir drive.google.com/uc?id=X → drive.usercontent.google.com/download?id=X
    const toDirectUrl = url => {
      const match = url && url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
      return (match && url.includes('drive.google.com'))
        ? `https://drive.usercontent.google.com/download?id=${match[1]}&export=view`
        : url;
    };
    const voucherUrl  = rawUrl ? toDirectUrl(rawUrl) : null;

    const proxyThumb = rawUrl
      ? `${settings.apiUrl}/api/ocr/image?url=${encodeURIComponent(rawUrl)}`
      : null;

    const voucherHtml = rawUrl
      ? `<div class="voucher-wrap">
           <img class="voucher-thumb" data-src="${proxyThumb}" alt="Comprobante" />
           <a class="voucher-link" href="${voucherUrl}" target="_blank">Ver comprobante ↗</a>
         </div>`
      : m.noVoucher
        ? '<div class="muted voucher-empty" style="color:#b45309">⚠️ Pago registrado sin comprobante adjunto</div>'
        : '<div class="muted voucher-empty">Sin comprobante adjunto</div>';

    const totalEvidencias = (m.order.evidencias || []).length;
    const esParcia = totalEvidencias > 1
      ? ` <span class="badge-parcial">Pago ${(m.order.evidencias || []).indexOf(m.evidencia) + 1}/${totalEvidencias}</span>`
      : '';

    const card = document.createElement('div');
    card.className = 'match-card';
    card.id = `card-${i}`;
    card.innerHTML = `
      <div class="match-top">
        <span class="match-cliente">${m.order.cliente || 'Sin nombre'}${esParcia}</span>
        <span class="match-amount">S/ ${m.transfer.monto.toFixed(2)}</span>
      </div>
      <div class="match-meta">
        <div>Pedido: <strong>${m.order.id}</strong> · Total: S/ ${parseFloat(m.order.total).toFixed(2)}</div>
        <div class="match-desc">${m.transfer.descripcion}</div>
        <div>${m.transfer.fecha} · Op. <strong>${m.transfer.operacion}</strong></div>
      </div>
      ${voucherHtml}
      <div class="match-actions">
        <button class="btn-primary btn-small" data-action="confirm" data-idx="${i}">✓ Verificar</button>
        <button class="btn-ghost" data-action="skip" data-idx="${i}">Ignorar</button>
      </div>
    `;
    card.querySelector('[data-action="confirm"]').addEventListener('click', () => confirmMatch(i));
    card.querySelector('[data-action="skip"]').addEventListener('click', () => skipMatch(i));
    const thumb = card.querySelector('.voucher-thumb');
    if (thumb) {
      thumb.src = thumb.dataset.src;
      thumb.addEventListener('error', () => { thumb.style.display = 'none'; });
    }
    matchList.appendChild(card);
  });

  renderAlerts(unmatchedTransfers, unmatchedEvidencias, izipayOrders);
}

// ─── Render alert notes for unmatched items ───────────────────────────────────
function renderAlerts(unmatchedTransfers = [], unmatchedEvidencias = [], izipayOrders = []) {
  ['alertTransfers', 'alertEvidencias', 'alertIzipay'].forEach(id => { const el = $(id); if (el) el.remove(); });

  if (unmatchedTransfers.length > 0) {
    const note = document.createElement('div');
    note.id = 'alertTransfers';
    note.className = 'unmatched-note';
    note.innerHTML = `
      <div class="unmatched-title">⚠️ ${unmatchedTransfers.length} abono${unmatchedTransfers.length > 1 ? 's' : ''} en el estado de cuenta sin pedido asociado</div>
      <ul class="unmatched-list">
        ${unmatchedTransfers.map(t =>
          `<li>${t.fecha} · <strong>S/ ${t.monto.toFixed(2)}</strong> · ${t.descripcion} · Op. ${t.operacion}</li>`
        ).join('')}
      </ul>
    `;
    matchList.appendChild(note);
  }

  if (unmatchedEvidencias.length > 0) {
    const note = document.createElement('div');
    note.id = 'alertEvidencias';
    note.className = 'unmatched-note unmatched-note--blue';
    note.innerHTML = `
      <div class="unmatched-title">ℹ️ ${unmatchedEvidencias.length} pedido${unmatchedEvidencias.length > 1 ? 's' : ''} con comprobante sin transferencia en el estado de cuenta</div>
      <ul class="unmatched-list">
        ${unmatchedEvidencias.map(({ order, evidencia }, i) => {
          const fecha = evidencia.fecha ? new Date(evidencia.fecha).toLocaleDateString('es-PE') : '—';
          return `<li id="unmatched-ev-${i}">
            <strong>${order.id}</strong> · ${order.cliente || 'Sin nombre'} · S/ ${parseFloat(order.total).toFixed(2)} · ${fecha}
            <span class="unmatched-actions">
              <button class="btn-primary btn-small" data-action="manual-verify" data-idx="${i}">Validar</button>
            </span>
          </li>`;
        }).join('')}
      </ul>
    `;
    // Keep the rows so a click can resolve its index back to the order
    manualCandidates = unmatchedEvidencias;
    note.querySelectorAll('[data-action="manual-verify"]').forEach(btn => {
      btn.addEventListener('click', () => manualVerify(Number(btn.dataset.idx)));
    });
    matchList.appendChild(note);
  }

  if (izipayOrders.length > 0) {
    const total = izipayOrders.reduce((s, o) => s + (parseFloat(o.total) || 0), 0);
    const note = document.createElement('div');
    note.id = 'alertIzipay';
    note.className = 'unmatched-note unmatched-note--orange';
    note.innerHTML = `
      <div class="unmatched-title">💳 ${izipayOrders.length} pedido${izipayOrders.length > 1 ? 's' : ''} pagado${izipayOrders.length > 1 ? 's' : ''} con Izipay · S/ ${total.toFixed(2)} total</div>
      <div style="font-size:11px;margin:4px 0 6px;color:#92400e">Estos pagos están en tu cuenta Izipay, no en BCP. Verifica el monto en tu panel Izipay.</div>
      <ul class="unmatched-list">
        ${izipayOrders.map(o =>
          `<li><strong>${o.id}</strong> · ${o.cliente || 'Sin nombre'} · S/ ${parseFloat(o.total).toFixed(2)}</li>`
        ).join('')}
      </ul>
    `;
    matchList.appendChild(note);
  }
}

// ─── Confirm a single match ───────────────────────────────────────────────────
async function confirmMatch(i) {
  const m = matches[i];
  if (m.confirmed) return;

  const card = $(`card-${i}`);
  card.querySelector('.match-actions').innerHTML = '<span class="muted">Guardando...</span>';

  // Grouped: verify each evidencia in the group sequentially
  if (m.type === 'grouped') {
    try {
      const opRef = m.transfer.operacion || `AUTO-${m.transfer.fecha}-${m.transfer.monto}`;
      for (const { order, evidencia } of m.group) {
        await verifyEvidencia(order.id, evidencia.id, opRef, parseFloat(order.total), m.transfer.fecha);
      }
      m.confirmed = true;
      card.classList.add('confirmed');
      card.querySelector('.match-actions').innerHTML = '<span class="confirmed-badge">✓ Todos verificados</span>';
    } catch (err) {
      card.querySelector('.match-actions').innerHTML =
        `<span style="color:red;font-size:11px">Error: ${err.message}</span>
         <button class="btn-primary btn-small" data-action="retry" data-idx="${i}">Reintentar</button>`;
      card.querySelector('[data-action="retry"]').addEventListener('click', () => confirmMatch(i));
    }
    return;
  }

  try {
    const opRef = m.transfer.operacion || `AUTO-${m.transfer.fecha}-${m.transfer.monto}`;

    if (m.noVoucher || !m.evidencia?.url) {
      // Sin comprobante: generar imagen PNG, subirla, crear evidencia y verificar
      const base       = `${settings.apiUrl}/api/pedidos/${settings.businessId}`;
      const receiptUrl = await uploadBcpReceipt(opRef, m.transfer.monto, m.transfer.fecha, m.transfer.descripcion);

      let evidenciaId = m.evidencia?.id || null;

      if (!evidenciaId) {
        // Crear evidencia nueva con la imagen
        const resEv = await fetch(`${base}/${m.order.id}/evidencias`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: receiptUrl, tipo: 'BCP', descripcion: `BCP Op. ${opRef} — ${m.transfer.fecha}` })
        });
        if (!resEv.ok) throw new Error(`Error creando evidencia: ${resEv.status}`);
        const evData = await resEv.json();
        evidenciaId  = evData.evidencia?.id;
        if (!evidenciaId) throw new Error('No se obtuvo ID de evidencia');
      }

      await verifyEvidencia(m.order.id, evidenciaId, opRef, m.transfer.monto, m.transfer.fecha);
    } else {
      // Tiene comprobante propio — solo marcar como VERIFICADO
      await verifyEvidencia(m.order.id, m.evidencia.id, opRef, m.transfer.monto, m.transfer.fecha);
    }
    m.confirmed = true;
    card.classList.add('confirmed');
    card.querySelector('.match-actions').innerHTML = '<span class="confirmed-badge">✓ Verificado</span>';
  } catch (err) {
    card.querySelector('.match-actions').innerHTML =
      `<span style="color:red;font-size:11px">Error: ${err.message}</span>
       <button class="btn-primary btn-small" data-action="retry" data-idx="${i}">Reintentar</button>`;
    card.querySelector('[data-action="retry"]').addEventListener('click', () => confirmMatch(i));
  }
}

// ─── Call backend to mark evidencia as VERIFICADO (estadoPago unchanged) ──────
async function verifyEvidencia(pedidoId, evidenciaId, operacionBCP, montoVerificado, fechaOperacion) {
  const url = `${settings.apiUrl}/api/pedidos/${settings.businessId}/${pedidoId}/evidencias/${evidenciaId}/verificar`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operacionBCP, montoVerificado, fechaOperacion })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

// ─── Manually validate a payment with no matching BCP transfer ─────────────
// Marks the evidencia VERIFICADO on the operator's word alone: there is no bank
// row to point at, so it is tagged MANUAL-<orderId> to stay distinguishable
// from statement-backed verifications.
async function manualVerify(i) {
  const entry = manualCandidates[i];
  if (!entry || entry.confirmed) return;
  const { order, evidencia } = entry;

  const monto = parseFloat(order.total) || 0;
  const ok = confirm(
    `¿Validar manualmente este pedido?\n\n` +
    `Pedido: ${order.id}\n` +
    `Cliente: ${order.cliente || 'Sin nombre'}\n` +
    `Monto: S/ ${monto.toFixed(2)}\n\n` +
    `Se marcará como VERIFICADO sin respaldo del estado de cuenta.`
  );
  if (!ok) return;

  const row     = $(`unmatched-ev-${i}`);
  const actions = row?.querySelector('.unmatched-actions');
  if (actions) actions.innerHTML = '<span class="muted">Guardando...</span>';

  try {
    const opRef = `MANUAL-${order.id}`;
    const fechaOperacion = evidencia.fecha
      ? new Date(evidencia.fecha).toLocaleDateString('es-PE')
      : '';
    await verifyEvidencia(order.id, evidencia.id, opRef, monto, fechaOperacion);
    entry.confirmed = true;
    if (actions) actions.innerHTML = '<span class="confirmed-badge">✓ Validado manualmente</span>';
  } catch (err) {
    if (actions) {
      actions.innerHTML =
        `<span style="color:red;font-size:11px">Error: ${err.message}</span>
         <button class="btn-primary btn-small" data-action="manual-retry">Reintentar</button>`;
      actions.querySelector('[data-action="manual-retry"]').addEventListener('click', () => manualVerify(i));
    }
  }
}

async function confirmAll() {
  for (let i = 0; i < matches.length; i++) {
    if (!matches[i].confirmed) await confirmMatch(i);
  }
}

function skipMatch(i) {
  const card = $(`card-${i}`);
  card.style.opacity = '0.4';
  card.querySelector('.match-actions').innerHTML = '<span class="muted">Ignorado</span>';
}


// ─── Helpers ──────────────────────────────────────────────────────────────────
function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = type;
  statusEl.classList.remove('hidden');
}
