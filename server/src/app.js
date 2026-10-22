import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 2 * 1024 * 1024;
const ROLES = new Set(['role-12', 'role-13']);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const sha = (d) => crypto.createHash('sha256').update(d).digest('hex');
const safeName = (n) => String(n || 'cv.pdf').replace(/[^\w.\- ]/g, '_').slice(0, 80);

export function createApp({ uploadDir = path.resolve('uploads') } = {}) {
  const app = express();
  app.locals.uploadDir = uploadDir;
  const applications = new Map(); // "userId:roleId" -> record
  const idempotency = new Map();  // "userId:key"    -> { fingerprint, status, body }

  app.use(helmet());
  app.use(express.json({ limit: '10kb' }));
  app.use(session({
    name: 'sid',
    secret: process.env.SESSION_SECRET || 'dev-only-secret',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 15 * 60 * 1000 },
  }));

  const requireAuth = (req, res, next) =>
    req.session.userId ? next() : res.status(401).json({ code: 'session_expired' });

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1, fields: 10 } });
  const parseUpload = (req, res, next) => upload.single('cv')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE')
      return res.status(422).json({ errors: { cv: 'This file is over 2 MB. Choose a smaller PDF.' } });
    return res.status(400).json({ code: 'bad_upload' });
  });

  app.post('/api/login', (req, res) => {
    const username = String(req.body?.username || '').trim();
    if (!/^[\w.-]{1,40}$/.test(username)) return res.status(422).json({ code: 'bad_username' });
    req.session.regenerate((err) => {
      if (err) return res.sendStatus(500);
      req.session.userId = username;
      res.json({ user: { id: username } });
    });
  });

  app.get('/api/me', requireAuth, (req, res) => res.json({ user: { id: req.session.userId } }));

  if (process.env.NODE_ENV !== 'production') {
    app.post('/api/dev/expire', (req, res) => req.session.destroy(() => res.sendStatus(204)));
  }

  // Order matters: authenticate BEFORE parsing the upload, so anonymous callers cost nothing.
  app.post('/api/applications', requireAuth, parseUpload, (req, res, next) => {
    try {
      const userId = req.session.userId;
      const key = req.get('Idempotency-Key');
      if (!key || key.length > 100) return res.status(400).json({ code: 'missing_idempotency_key' });

      const { name = '', email = '', note = '', roleId = '' } = req.body;
      const f = req.file;
      const fingerprint = sha(JSON.stringify([roleId, name, email, note, f ? sha(f.buffer) : '']));

      // 1. Idempotent replay: same key + same payload returns the stored result.
      const prev = idempotency.get(`${userId}:${key}`);
      if (prev) {
        if (prev.fingerprint !== fingerprint) return res.status(422).json({ code: 'key_reused' });
        return res.status(prev.status).set('Idempotent-Replay', 'true').json(prev.body);
      }

      // 2. Validate. The server is the authority; client checks are only UX.
      const errors = {};
      if (!name.trim() || name.length > 80) errors.name = 'Enter your full name (up to 80 characters).';
      if (!EMAIL_RE.test(email.trim())) errors.email = 'Enter an email address like name@example.com.';
      if (note.length > 500) errors.note = 'Keep the note under 500 characters.';
      if (!ROLES.has(roleId)) errors.roleId = 'Unknown role.';
      if (!f) errors.cv = 'Choose a PDF file.';
      else if (f.mimetype !== 'application/pdf') errors.cv = 'This is not a PDF. Choose a .pdf file.';
      else if (f.buffer.subarray(0, 5).toString('latin1') !== '%PDF-') errors.cv = 'The file contents are not a valid PDF.';
      if (Object.keys(errors).length) return res.status(422).json({ errors });

      // 3. One application per user per role (check-and-set is synchronous, so it is race-free here).
      const uniq = `${userId}:${roleId}`;
      if (applications.has(uniq)) return res.status(409).json({ code: 'duplicate' });

      // 4. Persist the file under a server-generated name. A failure here throws BEFORE any record exists.
      fs.mkdirSync(app.locals.uploadDir, { recursive: true });
      const fileId = `${crypto.randomUUID()}.pdf`;
      fs.writeFileSync(path.join(app.locals.uploadDir, fileId), f.buffer);

      const rec = { id: crypto.randomUUID(), userId, roleId, name: name.trim(), email: email.trim(), note, fileId, fileName: safeName(f.originalname) };
      applications.set(uniq, rec);
      const body = { id: rec.id, name: rec.name, email: rec.email, note: rec.note, fileName: rec.fileName };
      idempotency.set(`${userId}:${key}`, { fingerprint, status: 201, body }); // only successes are stored
      res.status(201).json(body);
    } catch (e) { next(e); }
  });

  app.get('/api/applications/:id/file', requireAuth, (req, res) => {
    const rec = [...applications.values()].find((a) => a.id === req.params.id && a.userId === req.session.userId);
    if (!rec) return res.sendStatus(404);
    res.set('X-Content-Type-Options', 'nosniff');
    res.download(path.join(app.locals.uploadDir, rec.fileId), rec.fileName); // Content-Disposition: attachment
  });

  app.use((err, req, res, next) => { console.error(err); res.status(500).json({ code: 'server_error' }); });
  return app;
}