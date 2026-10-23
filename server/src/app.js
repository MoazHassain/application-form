import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import multer from 'multer';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 2 * 1024 * 1024;
const ROLES = new Set(['role-12', 'role-13']);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const sha = (d) => crypto.createHash('sha256').update(d).digest('hex');
const safeName = (n) => String(n || 'cv.pdf').replace(/[^\w.\- ]/g, '_').slice(0, 80);

export function createApp({ uploadDir = path.resolve('uploads'), dbPath = path.resolve('data.db') } = {}) {
  const app = express();
  app.locals.uploadDir = uploadDir;

  // ---------- Database ----------
  const db = new Database(dbPath);
  if (dbPath !== ':memory:') db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS applications (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL,
      role_id    TEXT NOT NULL,
      name       TEXT NOT NULL,
      email      TEXT NOT NULL,
      note       TEXT NOT NULL DEFAULT '',
      file_id    TEXT NOT NULL,
      file_name  TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (user_id, role_id)            -- the real "one application per user per role" guard
    );
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      user_id     TEXT NOT NULL,
      key         TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      status      INTEGER NOT NULL,
      body        TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, key)           -- same key, same user: one stored result
    );
  `);
  app.locals.db = db;

  const getKey = db.prepare('SELECT fingerprint, status, body FROM idempotency_keys WHERE user_id = ? AND key = ?');
  const hasApp = db.prepare('SELECT 1 FROM applications WHERE user_id = ? AND role_id = ?');
  const insertApp = db.prepare(`INSERT INTO applications (id, user_id, role_id, name, email, note, file_id, file_name)
                                VALUES (@id, @userId, @roleId, @name, @email, @note, @fileId, @fileName)`);
  const insertKey = db.prepare('INSERT INTO idempotency_keys (user_id, key, fingerprint, status, body) VALUES (?, ?, ?, ?, ?)');
  const findFile = db.prepare('SELECT file_id, file_name FROM applications WHERE id = ? AND user_id = ?');
  // Application row + idempotency row commit together or not at all.
  const saveSuccess = db.transaction((rec, key, fingerprint, body) => {
    insertApp.run(rec);
    insertKey.run(rec.userId, key, fingerprint, 201, JSON.stringify(body));
  });

  // ---------- Middleware ----------
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

  // ---------- Auth routes ----------
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

  // ---------- POST /api/applications ----------
  // Authenticate BEFORE parsing the upload, so anonymous callers cost nothing.
  app.post('/api/applications', requireAuth, parseUpload, (req, res, next) => {
    try {
      const userId = req.session.userId;
      const key = req.get('Idempotency-Key');
      if (!key || key.length > 100) return res.status(400).json({ code: 'missing_idempotency_key' });

      const { name = '', email = '', note = '', roleId = '' } = req.body;
      const f = req.file;
      const fingerprint = sha(JSON.stringify([roleId, name, email, note, f ? sha(f.buffer) : '']));

      // 1. Idempotent replay: same key + same payload returns the stored result.
      const prev = getKey.get(userId, key);
      if (prev) {
        if (prev.fingerprint !== fingerprint) return res.status(422).json({ code: 'key_reused' });
        return res.status(prev.status).set('Idempotent-Replay', 'true').json(JSON.parse(prev.body));
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

      // 3. Fast path only (saves writing a file we would throw away). The UNIQUE constraint is the real guard.
      if (hasApp.get(userId, roleId)) return res.status(409).json({ code: 'duplicate' });

      // 4. Write the file under a server-generated name. If this throws, no DB row exists yet.
      fs.mkdirSync(app.locals.uploadDir, { recursive: true });
      const fileId = `${crypto.randomUUID()}.pdf`;
      const filePath = path.join(app.locals.uploadDir, fileId);
      fs.writeFileSync(filePath, f.buffer);

      // 5. Commit the application and the idempotency record atomically.
      const rec = { id: crypto.randomUUID(), userId, roleId, name: name.trim(), email: email.trim(), note, fileId, fileName: safeName(f.originalname) };
      const body = { id: rec.id, name: rec.name, email: rec.email, note: rec.note, fileName: rec.fileName };
      try {
        saveSuccess(rec, key, fingerprint, body);
      } catch (e) {
        fs.rmSync(filePath, { force: true }); // never leave an orphan file behind
        if (e.code === 'SQLITE_CONSTRAINT_UNIQUE' && String(e.message).includes('applications.'))
          return res.status(409).json({ code: 'duplicate' }); // lost a race: the constraint caught it
        throw e;
      }
      res.status(201).json(body);
    } catch (e) { next(e); }
  });

  app.get('/api/applications/:id/file', requireAuth, (req, res) => {
    const row = findFile.get(req.params.id, req.session.userId); // owner only
    if (!row) return res.sendStatus(404);
    res.set('X-Content-Type-Options', 'nosniff');
    res.download(path.join(app.locals.uploadDir, row.file_id), row.file_name); // Content-Disposition: attachment
  });

  app.use((err, req, res, next) => { console.error(err); res.status(500).json({ code: 'server_error' }); });
  return app;
}