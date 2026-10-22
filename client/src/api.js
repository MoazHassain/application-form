export async function api(path, { method = 'GET', body, headers, signal } = {}) {
  const res = await fetch(path, { method, body, headers, signal, credentials: 'same-origin' });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}