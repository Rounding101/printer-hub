// Sign-in page, and first-run creation of the admin account.
(async () => {
  const next = () => {
    // Back to the view the user was on (only same-site hash routes).
    const n = new URLSearchParams(location.search).get('next') || '';
    location.replace(/^#[\w/%-]*$/.test(n) ? `/${n}` : '/');
  };
  const me = await fetch('/api/auth/me').then((r) => r.json()).catch(() => ({}));
  if (me.user) return next();

  const form = document.getElementById(me.setup ? 'setup-form' : 'login-form');
  form.hidden = false;
  form.querySelector('input:not([value])')?.focus();
  const err = form.querySelector('.err');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    err.hidden = true;
    if (me.setup && f.password !== f.password2) {
      err.textContent = 'The passwords don\'t match';
      err.hidden = false;
      return;
    }
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const body = me.setup
        ? { code: f.code, username: f.username, password: f.password }
        : { username: f.username, password: f.password, remember: f.remember === 'on' };
      const res = await fetch(me.setup ? '/api/auth/setup' : '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Sign-in failed (${res.status})`);
      next();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      form.querySelector('[name=password]').select();
    } finally {
      btn.disabled = false;
    }
  });
})();
