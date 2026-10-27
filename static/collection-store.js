// One active collection per browser origin. Search results are local; OAuth tokens are never stored.
(() => {
  const database = new Promise((resolve, reject) => {
    const request = indexedDB.open('twitt-collections', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('collections');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Cannot open local collection storage. Enable browser storage to continue.'));
  });
  async function transaction(mode, action) {
    const db = await database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('collections', mode);
      const request = action(tx.objectStore('collections'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(new Error('Could not save collection progress in this browser. Free local storage and retry; do not clear this tab.'));
    });
  }
  window.CollectionStore = {
    load: () => transaction('readonly', store => store.get('active')),
    save: collection => transaction('readwrite', store => store.put(collection, 'active')),
    clear: () => transaction('readwrite', store => store.delete('active')),
    loadPrevious: () => transaction('readonly', store => store.get('previous-multimonth')),
    savePrevious: collection => transaction('readwrite', store => store.put(collection, 'previous-multimonth')),
    loadReplies: () => transaction('readonly', store => store.get('replies-active')),
    saveReplies: state => transaction('readwrite', store => store.put(state, 'replies-active'))
  };
})();
