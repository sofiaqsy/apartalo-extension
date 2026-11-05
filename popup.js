// La extensión sólo lee el archivo del BCP y guarda sus líneas en fincas, la base oficial
// (General Manager, 5 nov 2026: la validación de pedidos se hace en la app, Finanzas → Movimientos;
// sin campos que no hacen falta). La base no repite líneas y las cruza sola con los pagos de la app.

// ─── DOM refs ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const dropZone  = $('dropZone');
const fileInput = $('fileInput');
const statusEl  = $('status');

// ─── Init ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  bindEvents();
  await showFincasUser();
  chrome.action.setBadgeText({ text: '' });
});

async function showFincasUser() {
  const email = await fincasEmail();
  $('fincasUser').textContent = email ? `Sesión: ${email}` : 'Sin sesión: inicia sesión para guardar';
  $('btnFincasSignIn').classList.toggle('hidden', !!email);
  $('btnFincasSignOut').classList.toggle('hidden', !email);
  return email;
}

function bindEvents() {
  $('btnFincasSignIn').addEventListener('click', async () => {
    try {
      const email = await fincasSignIn();
      showStatus(`Sesión iniciada: ${email} ✓`, 'success');
    } catch (err) {
      showStatus(`No se pudo iniciar sesión: ${err?.message || err}`, 'error');
    }
    await showFincasUser();
  });
  $('btnFincasSignOut').addEventListener('click', async () => {
    await fincasSignOut();
    await showFincasUser();
    showStatus('Sesión cerrada', 'success');
  });

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
    fileInput.value = ''; // el mismo archivo se puede volver a elegir
  });
}

// ─── File processing ─────────────────────────────────────────────────────────
async function processFile(file) {
  showStatus('Leyendo archivo Excel...', 'loading');
  try {
    const rows = await parseXlsx(file);
    if (rows.length === 0) {
      showStatus('No se encontraron movimientos en el archivo.', 'error');
      return;
    }
    showStatus(`Guardando ${rows.length} movimientos en fincas...`, 'loading');
    const f = await sendToFincas(rows, file.name, FINCAS.defaultFarmId);
    if (f.skipped) {
      showStatus('⚠️ No se guardó: inicia sesión con Google.', 'error');
      return;
    }
    showStatus(`Guardado ✓ ${f.added} nuevas, ${f.already_saved} ya estaban, ${f.matched_now} cruzadas, ` +
      `${f.still_to_match} por conciliar en la app.`, 'success');
  } catch (err) {
    console.error('processFile error:', err);
    showStatus(`⚠️ No se guardó: ${err?.message || err}`, 'error');
  }
}

// ─── Parse BCP Excel ─────────────────────────────────────────────────────────
// BCP "Corriente Soles" format:
//   A: Fecha | B: Descripcion | C: Moneda | D: Monto | E: Numero de Operacion
//   Monto positivo = abono (ingreso); negativo = cargo (gasto).
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

        const allRows = [];
        for (const row of rows.slice(headerIdx + 1)) {
          const raw = row[iM];
          const amount = parseFloat(String(raw).replace(/[,]/g, '.').replace(/[^\d.-]/g, ''));
          if (!amount) continue;
          allRows.push({
            fecha:       iF >= 0 ? String(row[iF]).trim() : '',
            descripcion: iD >= 0 ? String(row[iD]).trim() : '',
            operacion:   iN >= 0 ? String(row[iN]).trim() : '',
            monto:       Math.abs(amount),
            tipo:        amount > 0 ? 'ingreso' : 'gasto',
          });
        }
        resolve(allRows);
      } catch (err) {
        reject(new Error('No se pudo leer el Excel: ' + err.message));
      }
    };
    reader.onerror = () => reject(new Error('Error leyendo el archivo'));
    reader.readAsArrayBuffer(file);
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = type;
  statusEl.classList.remove('hidden');
}
