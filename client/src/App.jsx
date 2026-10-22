import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';

const ROLE_ID = 'role-12';
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 8000;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const LABELS = { name: 'Full name', email: 'Email', note: 'Short note', cv: 'CV' };

function clientChecks(v, file) {
  const e = {};
  if (!v.name.trim()) e.name = 'Enter your full name.';
  if (!EMAIL_RE.test(v.email.trim())) e.email = 'Enter an email address like name@example.com.';
  if (!file) e.cv = 'Choose a PDF file.';
  else if (file.size > MAX_BYTES) e.cv = 'This file is over 2 MB. Choose a smaller PDF.';
  return e;
}

function Field({ id, label, hint, error, children }) {
  const describedBy = [hint && `${id}-hint`, error && `${id}-err`].filter(Boolean).join(' ') || undefined;
  return (
    <div className="f">
      <label htmlFor={id}>{label}</label>
      {hint && <p className="hint" id={`${id}-hint`}>{hint}</p>}
      {children({ id, name: id, 'aria-invalid': error ? 'true' : undefined, 'aria-describedby': describedBy })}
      {error && <p className="err" id={`${id}-err`}>Error: {error}</p>}
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = loading, null = signed out
  const [values, setValues] = useState({ name: '', email: '', note: '' });
  const [file, setFile] = useState(null);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState('');
  const [needLogin, setNeedLogin] = useState(false);
  const [done, setDone] = useState(null);

  const pendingRef = useRef(false); // synchronous guard: state updates are async, a ref is not
  const keyRef = useRef(null);      // idempotency key for the current attempt
  const summaryRef = useRef(null);
  const loginRef = useRef(null);
  const sendRef = useRef(null);

  const n = Object.keys(errors).length;
  const hasProblem = n > 0 || !!formError;

  useEffect(() => { api('/api/me').then((r) => setUser(r.status === 200 ? r.data.user : null)); }, []);
  useEffect(() => { if (hasProblem) summaryRef.current?.focus(); }, [errors, formError]);
  useEffect(() => { if (needLogin) loginRef.current?.focus(); }, [needLogin]);

  async function signIn() {
    const r = await api('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'sam.demo' }),
    });
    if (r.status === 200) {
      setUser(r.data.user);
      setNeedLogin(false);
      setStatus('Signed in. Your answers are kept. Send the application when ready.');
      setTimeout(() => sendRef.current?.focus(), 0);
    }
  }

  const onChange = (e) => { keyRef.current = null; setValues((v) => ({ ...v, [e.target.name]: e.target.value })); };
  const onFile = (e) => { keyRef.current = null; setFile(e.target.files[0] ?? null); };

  async function onSubmit(e) {
    e.preventDefault();
    if (pendingRef.current) return; // double-submit guard (click, Enter key, double tap)
    const ce = clientChecks(values, file);
    setFormError('');
    if (Object.keys(ce).length) { setErrors(ce); return; }
    setErrors({});

    pendingRef.current = true; setPending(true); setStatus('Sending your application.');
    keyRef.current ??= crypto.randomUUID(); // reused on every retry of the same payload

    const fd = new FormData();
    fd.append('roleId', ROLE_ID);
    fd.append('name', values.name);
    fd.append('email', values.email);
    fd.append('note', values.note);
    fd.append('cv', file);

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const { status: s, data } = await api('/api/applications', {
        method: 'POST', body: fd, headers: { 'Idempotency-Key': keyRef.current }, signal: ctl.signal,
      });
      setStatus('');
      if (s === 201) { keyRef.current = null; setDone(data); }
      else if (s === 401) { setNeedLogin(true); setStatus('Your session expired. Sign in again to send.'); }
      else if (s === 422 && data?.errors) setErrors(data.errors);
      else if (s === 409) { keyRef.current = null; setFormError('You have already applied for this role. You can only apply once.'); }
      else setFormError('The upload failed and nothing was saved. Check your connection and send again.');
    } catch {
      setStatus('');
      setFormError('This is taking too long. We kept your answers. Send again; this will not create a duplicate.');
    } finally {
      clearTimeout(timer); pendingRef.current = false; setPending(false);
    }
  }

  if (user === undefined) return <main><p>Loading…</p></main>;
  if (user === null) return (
    <main>
      <h1>Apply for Frontend Developer</h1>
      <p>Demo only. You will be signed in as the fictional user sam.demo.</p>
      <button onClick={signIn}>Sign in</button>
    </main>
  );
  if (done) return (
    <main>
      <h1 tabIndex={-1} ref={(el) => el?.focus()}>Application received</h1>
      {/* React escapes these strings, so untrusted input is never parsed as HTML */}
      <dl>
        <dt>Name</dt><dd>{done.name}</dd>
        <dt>Email</dt><dd>{done.email}</dd>
        <dt>Note</dt><dd>{done.note || 'None'}</dd>
        <dt>File</dt><dd>{done.fileName}</dd>
      </dl>
    </main>
  );

  return (
    <main>
      <h1>Apply for Frontend Developer</h1>
      <form onSubmit={onSubmit} noValidate>
        {needLogin && (
          <div className="panel" tabIndex={-1} ref={loginRef}>
            <h2>Your session expired</h2>
            <p>Your answers are still here. Sign in again, then send the form.</p>
            <button type="button" onClick={signIn}>Sign in again</button>
          </div>
        )}
        {hasProblem && (
          <div className="summary" tabIndex={-1} ref={summaryRef} aria-labelledby="sum-h">
            <h2 id="sum-h">{formError || (n === 1 ? 'There is 1 problem' : `There are ${n} problems`)}</h2>
            {n > 0 && (
              <ul>
                {Object.entries(errors).map(([f, m]) => (
                  <li key={f}>
                    <a href={`#${f}`} onClick={(ev) => { ev.preventDefault(); document.getElementById(f)?.focus(); }}>
                      {LABELS[f] || f}: {m}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <Field id="name" label="Full name (required)" error={errors.name}>
          {(p) => <input {...p} type="text" autoComplete="name" maxLength={80} value={values.name} onChange={onChange} />}
        </Field>
        <Field id="email" label="Email (required)" error={errors.email}>
          {(p) => <input {...p} type="email" inputMode="email" autoComplete="email" maxLength={120} value={values.email} onChange={onChange} />}
        </Field>
        <Field id="note" label="Short note" hint="Optional. Up to 500 characters." error={errors.note}>
          {(p) => <textarea {...p} rows={4} maxLength={500} value={values.note} onChange={onChange} />}
        </Field>
        <Field id="cv" label="CV as PDF (required)" hint="PDF only, up to 2 MB." error={errors.cv}>
          {(p) => <input {...p} type="file" accept="application/pdf,.pdf" onChange={onFile} />}
        </Field>

        <div role="status" aria-live="polite" className="hint">{status}</div>
        <div className="sticky">
          <button ref={sendRef} type="submit" aria-disabled={pending}>{pending ? 'Sending…' : 'Send application'}</button>
        </div>
      </form>

      {import.meta.env.DEV && (
        <p className="hint">
          <button type="button" onClick={() => api('/api/dev/expire', { method: 'POST' })}>Dev: expire my session</button>
        </p>
      )}
    </main>
  );
}