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

// Save rows to Google Sheet — dedup in extension to avoid Apps Script date parsing issues
async function saveToSheets(url, rows) {
  const stored = await chrome.storage.local.get(['sentSheetKeys']);
  const sentKeys = new Set(stored.sentSheetKeys || []);

  const newRows = rows.filter(r => {
    const op = String(r.operacion || '').trim();
    // If Op. BCP is non-zero, use it alone as unique key (handles BCP two-date interbank transfers)
    // If Op. BCP is 0 or empty (e.g. ITF), fall back to fecha+monto+descripcion
    const key = op && op !== '0'
      ? `op:${op}`
      : `${r.fecha}|${r.monto}|${String(r.descripcion || '').trim()}`;
    return !sentKeys.has(key);
  });

  if (newRows.length === 0) {
    console.log('[Sheets] ⏭ Sin filas nuevas (todo ya fue enviado)');
    return 'skipped';
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(newRows),
    redirect: 'follow',
  });
  const text = await res.text();
  console.log('[Sheets] ✅ Respuesta:', text);
  if (!res.ok) throw new Error(`Apps Script error ${res.status}: ${text}`);

  newRows.forEach(r => {
    const op = String(r.operacion || '').trim();
    const key = op && op !== '0'
      ? `op:${op}`
      : `${r.fecha}|${r.monto}|${String(r.descripcion || '').trim()}`;
    sentKeys.add(key);
  });
  await chrome.storage.local.set({ sentSheetKeys: [...sentKeys] });
  return 'sent';
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'SAVE_TO_SHEETS' || !msg.url || !msg.rows) return;
  saveToSheets(msg.url, msg.rows)
    .then(result => sendResponse({ ok: true, result }))
    .catch(e => {
      console.warn('[Sheets] ❌ Error:', e.message);
      sendResponse({ ok: false, error: e.message });
    });
  return true; // keep channel open for async sendResponse
});
