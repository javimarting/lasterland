const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const db = require('./db');
const auth = require('./auth');
const storage = require('./storage');

// Vercel no admite peticiones de más de 4,5 MB: por encima de este tamaño el navegador sube directo al almacén.
const DIRECT_UPLOAD_MIN = 4 * 1024 * 1024;
const UNIQUE_VIOLATION = '23505';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

async function readJson(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 64 * 1024) throw new HttpError(413, 'Petición demasiado grande');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body && typeof body === 'object') return body;
  } catch {}
  throw new HttpError(400, 'Petición no válida');
}

// --- validación ---

const normalizeUsername = (value) => String(value ?? '').trim().toLowerCase();

function validUsername(value) {
  const username = normalizeUsername(value);
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(username)) {
    throw new HttpError(400, 'Nombre de usuario no válido: usa letras, números, punto, guion o guion bajo (máx. 32)');
  }
  return username;
}

function validPassword(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 200) {
    throw new HttpError(400, 'La contraseña debe tener al menos 8 caracteres');
  }
  return value;
}

function validFileName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name === '.' || name === '..' || /[/\\\x00-\x1f]/.test(name) || Buffer.byteLength(name) > 255) {
    throw new HttpError(400, 'Nombre de fichero no válido');
  }
  return name;
}

// --- sesión ---

const publicUser = (user) => ({ id: user.id, username: user.username, isAdmin: user.is_admin });

// Dice si el usuario todavía tiene que elegir contraseña (primer acceso).
async function checkUser({ req, res }) {
  const { username } = await readJson(req);
  const [user] = await db.query('SELECT password_hash IS NULL AS pending FROM users WHERE username = $1', [
    normalizeUsername(username),
  ]);
  sendJson(res, 200, { pending: Boolean(user?.pending) });
}

async function login({ req, res }) {
  const { username, password } = await readJson(req);
  if (typeof password !== 'string' || password.length > 200) throw new HttpError(400, 'Petición no válida');
  const user = await auth.checkCredentials(normalizeUsername(username), password);
  if (user === 'locked') throw new HttpError(429, 'Demasiados intentos fallidos. Espera unos minutos.');
  if (!user) throw new HttpError(401, 'Usuario o contraseña incorrectos');
  await auth.startSession(req, res, user.id);
  sendJson(res, 200, publicUser(user));
}

async function setPassword({ req, res }) {
  const { username, password } = await readJson(req);
  const hash = await auth.hashPassword(validPassword(password));
  // La condición "IS NULL" hace que solo valga para el primer acceso, y solo una vez.
  const [user] = await db.query(
    'UPDATE users SET password_hash = $1 WHERE username = $2 AND password_hash IS NULL RETURNING id, username, is_admin',
    [hash, normalizeUsername(username)]
  );
  if (!user) throw new HttpError(409, 'Este usuario no puede crear contraseña');
  await auth.startSession(req, res, user.id);
  sendJson(res, 200, publicUser(user));
}

async function logout({ req, res }) {
  await auth.endSession(req, res);
  sendJson(res, 200, { ok: true });
}

// --- usuarios (solo administradores) ---

async function listUsers({ res }) {
  const users = await db.query(
    'SELECT id, username, is_admin, password_hash IS NULL AS pending FROM users ORDER BY username'
  );
  sendJson(res, 200, users.map((u) => ({ ...publicUser(u), pending: u.pending })));
}

async function createUser({ req, res }) {
  const { username, isAdmin } = await readJson(req);
  const [user] = await db.query(
    'INSERT INTO users (username, is_admin) VALUES ($1, $2) ON CONFLICT (username) DO NOTHING RETURNING id, username, is_admin',
    [validUsername(username), isAdmin === true]
  );
  if (!user) throw new HttpError(409, 'Ya existe un usuario con ese nombre');
  sendJson(res, 201, { ...publicUser(user), pending: true });
}

function otherUserId({ user, params }) {
  const id = Number(params.id);
  if (id === user.id) throw new HttpError(400, 'No puedes hacer esto sobre tu propio usuario');
  return id;
}

// Deja al usuario como recién creado: volverá a elegir contraseña en su próximo acceso.
async function resetUser(ctx) {
  const [user] = await db.query(
    'UPDATE users SET password_hash = NULL, failed_attempts = 0, locked_until = NULL WHERE id = $1 RETURNING id',
    [otherUserId(ctx)]
  );
  if (!user) throw new HttpError(404, 'No existe');
  await db.query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
  sendJson(ctx.res, 200, { ok: true });
}

async function deleteUser(ctx) {
  const id = otherUserId(ctx);
  const files = await db.query('SELECT id, owner_id FROM files WHERE owner_id = $1', [id]);
  await storage().remove(files.map(storageKey));
  const [user] = await db.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
  if (!user) throw new HttpError(404, 'No existe');
  sendJson(ctx.res, 200, { ok: true });
}

// --- ficheros (cada usuario solo ve los suyos) ---

const storageKey = (file) => `${file.owner_id}/${file.id}`;
const publicFile = (file) => ({
  id: file.id,
  name: file.name,
  size: Number(file.size),
  mtime: new Date(file.updated_at).getTime(),
});

async function findFile({ user, params }, ready) {
  const [file] = await db.query('SELECT * FROM files WHERE id = $1 AND owner_id = $2 AND ready = $3', [
    params.id,
    user.id,
    ready,
  ]);
  if (!file) throw new HttpError(404, 'No existe');
  return file;
}

async function listFiles({ res, user }) {
  const files = await db.query('SELECT * FROM files WHERE owner_id = $1 AND ready ORDER BY updated_at DESC', [user.id]);
  sendJson(res, 200, files.map(publicFile));
}

// Una subida tiene tres pasos: crearla (aquí), enviar los bytes a la URL devuelta y confirmarla.
// Hasta que se confirma, el fichero no aparece en la lista ni reemplaza a otro con el mismo nombre.
async function createUpload({ req, res, user }) {
  const { name, size } = await readJson(req);
  const file = { id: crypto.randomUUID(), owner_id: user.id };

  const abandoned = await db.query(
    `DELETE FROM files WHERE NOT ready AND created_at < now() - interval '1 day' RETURNING id, owner_id`
  );
  await storage().remove(abandoned.map(storageKey));

  await db.query('INSERT INTO files (id, owner_id, name) VALUES ($1, $2, $3)', [file.id, file.owner_id, validFileName(name)]);
  const direct = size > DIRECT_UPLOAD_MIN ? await storage().directUpload(storageKey(file)) : null;
  sendJson(res, 201, {
    id: file.id,
    upload: direct || { url: `/api/files/${file.id}/content`, headers: { 'content-type': 'application/octet-stream' } },
  });
}

async function receiveContent(ctx) {
  const file = await findFile(ctx, false);
  await storage().write(storageKey(file), ctx.req);
  sendJson(ctx.res, 200, { ok: true });
}

async function completeUpload(ctx) {
  const file = await findFile(ctx, false);
  const size = await storage().size(storageKey(file));
  if (size === null) throw new HttpError(400, 'La subida no llegó a completarse');

  const { saved, replaced } = await db.tx(async (query) => {
    const replaced = await query(
      'DELETE FROM files WHERE owner_id = $1 AND name = $2 AND ready RETURNING id, owner_id',
      [file.owner_id, file.name]
    );
    const [saved] = await query(
      'UPDATE files SET ready = TRUE, size = $2, updated_at = now() WHERE id = $1 RETURNING *',
      [file.id, size]
    );
    return { saved, replaced };
  });
  await storage().remove(replaced.map(storageKey));
  sendJson(ctx.res, 200, publicFile(saved));
}

async function download(ctx) {
  const file = await findFile(ctx, true);
  const stream = await storage().read(storageKey(file));
  if (!stream) throw new HttpError(404, 'No existe');
  ctx.res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': Number(file.size),
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  });
  await pipeline(stream, ctx.res);
}

async function renameFile(ctx) {
  const { name } = await readJson(ctx.req);
  const file = await findFile(ctx, true);
  try {
    const [renamed] = await db.query('UPDATE files SET name = $2 WHERE id = $1 RETURNING *', [file.id, validFileName(name)]);
    sendJson(ctx.res, 200, publicFile(renamed));
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) throw new HttpError(409, 'Ya existe un fichero con ese nombre');
    throw err;
  }
}

async function deleteFile(ctx) {
  const file = await findFile(ctx, true);
  await db.query('DELETE FROM files WHERE id = $1', [file.id]);
  await storage().remove([storageKey(file)]);
  sendJson(ctx.res, 200, { ok: true });
}

// --- rutas ---

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const route = (access, method, path, handler) => ({ access, method, pattern: new RegExp(`^${path}$`), handler });

const routes = [
  route('public', 'POST', '/api/auth/check', checkUser),
  route('public', 'POST', '/api/auth/login', login),
  route('public', 'POST', '/api/auth/set-password', setPassword),
  route('public', 'POST', '/api/auth/logout', logout),
  route('user', 'GET', '/api/me', ({ res, user }) => sendJson(res, 200, publicUser(user))),

  route('admin', 'GET', '/api/users', listUsers),
  route('admin', 'POST', '/api/users', createUser),
  route('admin', 'POST', '/api/users/(?<id>\\d{1,9})/reset', resetUser),
  route('admin', 'DELETE', '/api/users/(?<id>\\d{1,9})', deleteUser),

  route('user', 'GET', '/api/files', listFiles),
  route('user', 'POST', '/api/files', createUpload),
  route('user', 'PUT', `/api/files/(?<id>${UUID})/content`, receiveContent),
  route('user', 'POST', `/api/files/(?<id>${UUID})/complete`, completeUpload),
  route('user', 'GET', `/api/files/(?<id>${UUID})/content`, download),
  route('user', 'PATCH', `/api/files/(?<id>${UUID})`, renameFile),
  route('user', 'DELETE', `/api/files/(?<id>${UUID})`, deleteFile),
];

async function dispatch(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  const found = routes.find((r) => r.method === req.method && r.pattern.test(pathname));
  if (!found) throw new HttpError(404, 'No encontrado');

  const ctx = { req, res, params: found.pattern.exec(pathname).groups, user: null };
  if (found.access !== 'public') {
    ctx.user = await auth.currentUser(req);
    if (!ctx.user) throw new HttpError(401, 'Sesión no iniciada');
    if (found.access === 'admin' && !ctx.user.is_admin) throw new HttpError(403, 'Solo para administradores');
  }
  return found.handler(ctx);
}

module.exports = function handleApi(req, res) {
  return dispatch(req, res).catch((err) => {
    if (res.headersSent || res.destroyed) return res.destroy();
    if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
    console.error(err);
    sendJson(res, 500, { error: 'Error interno' });
  });
};
