// Applies the chosen theme before the page draws, so it doesn't flash. Kept in this
// browser only: a phone and a wall tablet can look different.
(() => {
  const KEY = 'theme';
  const LIST = [
    { id: '', name: 'Match device', colors: ['#f6f5f1', '#121212', '#5cb8b2'] },
    { id: 'graphite', name: 'Graphite', colors: ['#121212', '#262626', '#5cb8b2'] },
    { id: 'paper', name: 'Paper', colors: ['#f6f5f1', '#fffefb', '#1f4fd8'] },
    { id: 'blueprint', name: 'Blueprint', colors: ['#0e2a47', '#18406b', '#ffd23f'] },
    { id: 'terminal', name: 'Terminal', colors: ['#0a0d0a', '#182218', '#4ade80'] },
    { id: 'original', name: 'Original', colors: ['#0f1114', '#21252c', '#e8893d'] },
  ];
  const apply = (id) => {
    if (id) document.documentElement.dataset.theme = id;
    else delete document.documentElement.dataset.theme;
  };
  const get = () => {
    try { const id = localStorage.getItem(KEY) || ''; return LIST.some((t) => t.id === id) ? id : ''; } catch { return ''; }
  };
  const set = (id) => {
    apply(id);
    try { if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
  };
  apply(get());
  window.Theme = { list: LIST, get, set };
})();
