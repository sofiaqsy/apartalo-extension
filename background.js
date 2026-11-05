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
