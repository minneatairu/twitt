// Session memory only: no IndexedDB, localStorage, sessionStorage, or automatic restore.
// Each tab owns its data. CSV/Google exports and downloaded checkpoints are explicit saves.
(() => {
  const values = new Map();
  const read = async key => values.has(key) ? structuredClone(values.get(key)) : undefined;
  const write = async (key, value) => { values.set(key, structuredClone(value)); };
  window.CollectionStore = {
    load: () => read('active'),
    save: collection => write('active', collection),
    clear: async () => { values.delete('active'); },
    clearReplies: async () => { values.delete('replies-active'); },
    loadReplies: () => read('replies-active'),
    saveReplies: state => write('replies-active', state)
  };
})();
