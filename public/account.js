// Signed-in user: the Account view (password, devices) and, for admins, the
// Users view. Uses api() and toast() from app.js.
const Account = (() => {
  let me = null;
  const $ = (id) => document.getElementById(id);
  const ROLE_LABEL = { admin: 'Admin', operator: 'Operator', viewer: 'Viewer' };
  const ROLE_HINT = {
    admin: 'You can do everything, including managing users.',
    operator: 'You can print, control printers, and manage files, rolls and the job log.',
    viewer: 'You can watch status, cameras and logs. Ask an admin if you need to control printers.',
  };
  const when = (t) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');

  // Sends the browser to the sign-in page, coming back to the current view after.
  function toLogin() {
    location.replace(`/login${location.hash ? `?next=${encodeURIComponent(location.hash)}` : ''}`);
  }

  // The signed-in user, or null after sending the browser to sign in. If the hub
  // can't be reached (e.g. restarting), keeps the last known user and retries.
  async function load() {
    const res = await fetch('/api/auth/me').catch(() => null);
    if (!res || !res.ok) {
      if (me) return me;
      await new Promise((r) => setTimeout(r, 3000));
      return load();
    }
    const data = await res.json().catch(() => ({}));
    if (!data.user) { toLogin(); return null; }
    me = data.user;
    document.body.dataset.role = me.role;
    $('me').querySelector('.me-name').textContent = me.username;
    $('me').querySelector('.me-role').textContent = me.role === 'operator' ? '' : ROLE_LABEL[me.role];
    $('nav-settings').hidden = me.role !== 'admin';
    if (data.hub) showVersion(data.hub);
    return me;
  }

  // "v0.9 · Oct 31, 2026" next to the name; the tooltip adds the slicer.
  async function showVersion(hub) {
    const el = $('version');
    const short = hub.version.replace(/\.0$/, '');
    const date = hub.released ? new Date(`${hub.released}T12:00:00`).toLocaleDateString([], { dateStyle: 'medium' }) : '';
    el.textContent = `v${short}${date ? ` · ${date}` : ''}`;
    el.title = `Printer Hub ${hub.version}${date ? `, released ${date}` : ''}`;
    const s = await api('/api/slicer').catch(() => null);
    el.title += !s ? '' : !s.available ? '\nSlicer: not reachable'
      : `\nSlicer: OrcaSlicer ${s.version || '?'}, STEP files ${s.step ? 'supported' : 'not supported (old slicer image)'}`;
  }

  // Short device name from a user agent string.
  function device(ua) {
    if (!ua) return 'Unknown';
    const os = /iPhone|iPad/.test(ua) ? (ua.includes('iPad') ? 'iPad' : 'iPhone') : /Android/.test(ua) ? 'Android'
      : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
    const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl/.test(ua) ? 'curl' : '';
    return [br, os].filter(Boolean).join(' on ') || ua.slice(0, 40);
  }

  const cell = (tr, text, cls) => { const td = document.createElement('td'); if (cls) td.className = cls; td.textContent = text ?? ''; tr.append(td); return td; };
  const button = (text, cls, onclick) => { const b = document.createElement('button'); b.type = 'button'; b.className = `btn small ${cls || ''}`; b.textContent = text; b.onclick = onclick; return b; };

  // ---- Account view -------------------------------------------------------------

  async function renderAccount() {
    if (!me) return;
    $('acct-name').textContent = me.username;
    $('acct-role').textContent = ROLE_LABEL[me.role];
    $('acct-role-hint').textContent = ROLE_HINT[me.role];
    const sessions = await api('/api/auth/sessions').catch((err) => { toast(err.message, true); return []; });
    $('sess-body').replaceChildren(...sessions.map((s) => {
      const tr = document.createElement('tr');
      const d = cell(tr, device(s.userAgent), 'strong');
      d.title = s.userAgent || '';
      if (s.current) d.append(Object.assign(document.createElement('span'), { className: 'pill tag', textContent: 'This device' }));
      cell(tr, s.ip?.replace(/^::ffff:/, '') || '—', 'nowrap');
      cell(tr, when(s.createdAt), 'nowrap');
      cell(tr, when(s.lastSeen), 'nowrap');
      const a = cell(tr, '', 'actions');
      if (!s.current) a.append(button('Sign out', 'ghost', async () => {
        try { await api(`/api/auth/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' }); renderAccount(); }
        catch (err) { toast(err.message, true); }
      }));
      return tr;
    }));
    $('sess-others').disabled = sessions.length < 2;
  }

  $('sess-others').onclick = async () => {
    try { await api('/api/auth/sessions', { method: 'DELETE' }); toast('Other devices signed out'); renderAccount(); }
    catch (err) { toast(err.message, true); }
  };

  $('acct-logout').onclick = async () => {
    await api('/api/auth/logout', { body: {} }).catch(() => {});
    location.replace('/login');
  };

  $('pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const f = Object.fromEntries(new FormData(form));
    const err = form.querySelector('.err');
    err.hidden = true;
    try {
      if (f.password !== f.password2) throw new Error('The new passwords don\'t match');
      await api('/api/auth/password', { body: { current: f.current, password: f.password } });
      form.reset();
      toast('Password changed. Other devices were signed out.');
      renderAccount();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });

  // ---- Users view (admins) --------------------------------------------------------

  async function renderUsers() {
    if (me?.role !== 'admin') return;
    const users = await api('/api/users').catch((err) => { toast(err.message, true); return []; });
    const admins = users.filter((u) => u.role === 'admin').length;
    $('users-body').replaceChildren(...users.map((u) => {
      const tr = document.createElement('tr');
      const n = cell(tr, u.username, 'strong');
      if (u.id === me.id) n.append(Object.assign(document.createElement('span'), { className: 'pill tag', textContent: 'You' }));
      const sel = document.createElement('select');
      sel.className = 'small';
      sel.setAttribute('aria-label', `Role for ${u.username}`);
      for (const r of ['admin', 'operator', 'viewer']) sel.append(new Option(ROLE_LABEL[r], r, false, r === u.role));
      sel.disabled = u.role === 'admin' && admins === 1;
      if (sel.disabled) sel.title = 'There has to be at least one admin';
      sel.onchange = async () => {
        try { await api(`/api/users/${encodeURIComponent(u.id)}`, { method: 'PATCH', body: { role: sel.value } }); toast(`${u.username} is now ${ROLE_LABEL[sel.value]}`); }
        catch (err) { toast(err.message, true); }
        if (u.id === me.id) await load();
        renderUsers();
      };
      cell(tr, '').append(sel);
      cell(tr, when(u.createdAt), 'nowrap');
      cell(tr, when(u.lastLoginAt), 'nowrap');
      const a = cell(tr, '', 'actions');
      const wrap = document.createElement('div');
      wrap.className = 'row-actions';
      wrap.append(button('Set password…', 'ghost', () => resetPassword(u)));
      if (u.id !== me.id) wrap.append(button('Delete', 'ghost danger', async () => {
        if (!confirm(`Delete ${u.username}? They're signed out everywhere.`)) return;
        try { await api(`/api/users/${encodeURIComponent(u.id)}`, { method: 'DELETE' }); renderUsers(); }
        catch (err) { toast(err.message, true); }
      }));
      a.append(wrap);
      return tr;
    }));
  }

  function resetPassword(u) {
    const dlg = $('reset-dlg');
    const form = dlg.querySelector('form');
    form.reset();
    dlg.querySelector('.reset-hint').textContent = u.id === me.id
      ? 'Your other devices are signed out.'
      : `${u.username} is signed out everywhere and has to use the new password.`;
    dlg.onclose = async () => {
      if (dlg.returnValue !== 'save') return;
      try {
        await api(`/api/users/${encodeURIComponent(u.id)}`, { method: 'PATCH', body: { password: form.password.value } });
        toast(`Password set for ${u.username}`);
      } catch (err) { toast(err.message, true); }
    };
    dlg.showModal();
  }

  $('user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const err = form.querySelector('.err');
    err.hidden = true;
    try {
      const u = await api('/api/users', { body: Object.fromEntries(new FormData(form)) });
      form.reset();
      toast(`Added ${u.username}`);
      renderUsers();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });

  return {
    load, toLogin, renderAccount, renderUsers,
    get user() { return me; },
  };
})();
