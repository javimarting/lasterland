const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const db = require('./db');
const auth = require('./auth');
const storage = require('./storage');

// Vercel no admite peticiones de más de 4,5 MB: por encima de este tamaño el navegador sube directo al almacén.
const DIRECT_UPLOAD_MIN = 4 * 1024 * 1024;
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES) || 2 * 1024 ** 3;
const MAX_BATCH = 500;
// Peticiones sin sesión (login, activación…) permitidas por IP en cada ventana.
const AUTH_LIMIT = { requests: Number(process.env.AUTH_RATE_LIMIT) || 30, minutes: 10 };
const UNIQUE_VIOLATION = '23505';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID}$`);

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

// Reenvía el cuerpo de la petición hasta `max` bytes. Si se pasa, el stream de salida falla con 413 y la
// petición se deja de leer sin destruirla, para que la respuesta llegue al cliente. No se lee nada hasta
// que alguien consume la salida: así el error siempre encuentra a quien lo escuche.
function limitBytes(req, max) {
  let received = 0;
  const out = new Readable({ read: () => req.resume() });
  const onData = (chunk) => {
    received += chunk.length;
    if (received > max) {
      req.pause();
      req.off('data', onData);
      return out.destroy(new HttpError(413, 'Fichero demasiado grande'));
    }
    if (!out.push(chunk)) req.pause();
  };
  req.on('data', onData);
  req.pause();
  req.on('end', () => out.push(null));
  req.on('error', (err) => out.destroy(err));
  return out;
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

function validName(value, what) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name === '.' || name === '..' || /[/\\\x00-\x1f]/.test(name) || Buffer.byteLength(name) > 255) {
    throw new HttpError(400, `Nombre de ${what} no válido`);
  }
  return name;
}

// Identificador de carpeta opcional: null es la raíz.
function validFolderId(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new HttpError(400, 'Carpeta no válida');
  return value;
}

function validIdList(value) {
  const ids = Array.isArray(value) ? value : [];
  if (ids.length > MAX_BATCH || !ids.every((id) => typeof id === 'string' && UUID_RE.test(id))) {
    throw new HttpError(400, 'Lista de elementos no válida');
  }
  return [...new Set(ids)];
}

// --- sesión ---

const publicUser = (user) => ({ id: user.id, username: user.username, isAdmin: user.is_admin });

// Dice si el usuario todavía tiene que activar la cuenta (primer acceso) y si necesita código para ello.
async function checkUser({ req, res }) {
  const { username } = await readJson(req);
  const [user] = await db.query(
    'SELECT password_hash IS NULL AS pending, activation_hash IS NOT NULL AS needs_code FROM users WHERE username = $1',
    [normalizeUsername(username)]
  );
  sendJson(res, 200, { pending: Boolean(user?.pending), needsCode: Boolean(user?.pending && user.needs_code) });
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

async function activateUser({ req, res }) {
  const { username, code, password } = await readJson(req);
  const hash = await auth.hashPassword(validPassword(password));
  const user = await auth.activate(normalizeUsername(username), code, hash);
  if (user === 'locked') throw new HttpError(429, 'Demasiados intentos fallidos. Espera unos minutos.');
  if (!user) throw new HttpError(401, 'Código de activación incorrecto o cuenta ya activada');
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

// El código de activación se devuelve una sola vez, aquí; en la base de datos solo queda su hash.
async function createUser({ req, res }) {
  const { username, isAdmin } = await readJson(req);
  const code = auth.newActivationCode();
  const [user] = await db.query(
    `INSERT INTO users (username, is_admin, activation_hash) VALUES ($1, $2, $3)
       ON CONFLICT (username) DO NOTHING RETURNING id, username, is_admin`,
    [validUsername(username), isAdmin === true, auth.hashCode(code)]
  );
  if (!user) throw new HttpError(409, 'Ya existe un usuario con ese nombre');
  sendJson(res, 201, { ...publicUser(user), pending: true, activationCode: code });
}

function otherUserId({ user, params }) {
  const id = Number(params.id);
  if (id === user.id) throw new HttpError(400, 'No puedes hacer esto sobre tu propio usuario');
  return id;
}

// Deja al usuario como recién creado, con un código nuevo: elegirá otra contraseña en su próximo acceso.
async function resetUser(ctx) {
  const code = auth.newActivationCode();
  const [user] = await db.query(
    `UPDATE users SET password_hash = NULL, activation_hash = $2, failed_attempts = 0, locked_until = NULL
      WHERE id = $1 RETURNING id`,
    [otherUserId(ctx), auth.hashCode(code)]
  );
  if (!user) throw new HttpError(404, 'No existe');
  await db.query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
  sendJson(ctx.res, 200, { activationCode: code });
}

async function deleteUser(ctx) {
  const id = otherUserId(ctx);
  const files = await db.query('SELECT id, owner_id FROM files WHERE owner_id = $1', [id]);
  const [user] = await db.query('DELETE FROM users WHERE id = $1 RETURNING id', [id]);
  if (!user) throw new HttpError(404, 'No existe');
  await storage().remove(files.map(storageKey));
  sendJson(ctx.res, 200, { ok: true });
}

// --- carpetas y ficheros (cada usuario solo ve los suyos) ---

const storageKey = (file) => `${file.owner_id}/${file.id}`;
const publicFile = (file) => ({
  id: file.id,
  name: file.name,
  size: Number(file.size),
  mtime: new Date(file.updated_at).getTime(),
});
const publicFolder = (folder) => ({ id: folder.id, name: folder.name, mtime: new Date(folder.created_at).getTime() });

// Los identificadores se pasan como texto separado por comas: funciona igual en pg y en PGlite.
const idList = (ids) => ids.join(',');
const IN_LIST = (param) => `= ANY(string_to_array(${param}, ',')::uuid[])`;

async function findFile({ user, params }, ready) {
  const [file] = await db.query('SELECT * FROM files WHERE id = $1 AND owner_id = $2 AND ready = $3', [
    params.id,
    user.id,
    ready,
  ]);
  if (!file) throw new HttpError(404, 'No existe');
  return file;
}

// Devuelve la carpeta del usuario, o null para la raíz.
async function findFolder(user, id) {
  if (id === null) return null;
  const [folder] = await db.query('SELECT * FROM folders WHERE id = $1 AND owner_id = $2', [id, user.id]);
  if (!folder) throw new HttpError(404, 'La carpeta no existe');
  return folder;
}

// Carpetas desde la raíz hasta la indicada, para la ruta de navegación.
async function folderPath(user, id) {
  if (id === null) return [];
  return db.query(
    `WITH RECURSIVE path AS (
       SELECT id, name, parent_id, 0 AS depth FROM folders WHERE id = $1 AND owner_id = $2
       UNION ALL
       SELECT f.id, f.name, f.parent_id, path.depth + 1 FROM folders f JOIN path ON f.id = path.parent_id
     ) SELECT id, name FROM path ORDER BY depth DESC`,
    [id, user.id]
  );
}

// Identificadores de las carpetas dadas y de todas sus descendientes.
async function folderTree(query, user, ids) {
  if (!ids.length) return [];
  const rows = await query(
    `WITH RECURSIVE tree AS (
       SELECT id FROM folders WHERE owner_id = $2 AND id ${IN_LIST('$1')}
       UNION ALL
       SELECT f.id FROM folders f JOIN tree ON f.parent_id = tree.id
     ) SELECT id FROM tree`,
    [idList(ids), user.id]
  );
  return rows.map((r) => r.id);
}

async function listFolder({ req, res, user }) {
  const folderId = validFolderId(new URL(req.url, 'http://localhost').searchParams.get('folder'));
  await findFolder(user, folderId);
  const [path, folders, files] = await Promise.all([
    folderPath(user, folderId),
    db.query(`SELECT * FROM folders WHERE owner_id = $1 AND parent_id IS NOT DISTINCT FROM $2 ORDER BY name`, [user.id, folderId]),
    db.query(`SELECT * FROM files WHERE owner_id = $1 AND folder_id IS NOT DISTINCT FROM $2 AND ready ORDER BY updated_at DESC`, [user.id, folderId]),
  ]);
  sendJson(res, 200, { path, folders: folders.map(publicFolder), files: files.map(publicFile) });
}

// Todas las carpetas del usuario con su ruta completa, para elegir destino al mover.
async function listAllFolders({ res, user }) {
  const folders = await db.query(
    `WITH RECURSIVE tree AS (
       SELECT id, name AS path FROM folders WHERE owner_id = $1 AND parent_id IS NULL
       UNION ALL
       SELECT f.id, tree.path || '/' || f.name FROM folders f JOIN tree ON f.parent_id = tree.id
     ) SELECT id, path FROM tree ORDER BY path`,
    [user.id]
  );
  sendJson(res, 200, folders);
}

async function createFolder({ req, res, user }) {
  const { name, parentId } = await readJson(req);
  const parent = await findFolder(user, validFolderId(parentId));
  try {
    const [folder] = await db.query(
      'INSERT INTO folders (id, owner_id, parent_id, name) VALUES ($1, $2, $3, $4) RETURNING *',
      [crypto.randomUUID(), user.id, parent?.id ?? null, validName(name, 'carpeta')]
    );
    sendJson(res, 201, publicFolder(folder));
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) throw new HttpError(409, 'Ya existe una carpeta con ese nombre');
    throw err;
  }
}

async function renameFolder({ req, res, user, params }) {
  const { name } = await readJson(req);
  await findFolder(user, params.id);
  try {
    const [folder] = await db.query('UPDATE folders SET name = $3 WHERE id = $1 AND owner_id = $2 RETURNING *', [
      params.id,
      user.id,
      validName(name, 'carpeta'),
    ]);
    sendJson(res, 200, publicFolder(folder));
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) throw new HttpError(409, 'Ya existe una carpeta con ese nombre');
    throw err;
  }
}

// Borra ficheros y carpetas (con todo su contenido). Primero en la base de datos y después en el almacén.
async function deleteItems(user, fileIds, folderIds) {
  const removed = await db.tx(async (query) => {
    const tree = await folderTree(query, user, folderIds);
    const inFolders = tree.length
      ? await query(`SELECT id, owner_id FROM files WHERE owner_id = $2 AND folder_id ${IN_LIST('$1')}`, [idList(tree), user.id])
      : [];
    const direct = fileIds.length
      ? await query(`DELETE FROM files WHERE owner_id = $2 AND ready AND id ${IN_LIST('$1')} RETURNING id, owner_id`, [idList(fileIds), user.id])
      : [];
    if (tree.length) await query(`DELETE FROM folders WHERE owner_id = $2 AND id ${IN_LIST('$1')}`, [idList(tree), user.id]);
    return { files: [...direct, ...inFolders], folders: tree.length };
  });
  await storage().remove(removed.files.map(storageKey));
  return { files: removed.files.length, folders: removed.folders };
}

async function deleteFolder({ res, user, params }) {
  await findFolder(user, params.id);
  sendJson(res, 200, await deleteItems(user, [], [params.id]));
}

async function batchDelete({ req, res, user }) {
  const { files, folders } = await readJson(req);
  sendJson(res, 200, await deleteItems(user, validIdList(files), validIdList(folders)));
}

// Mueve ficheros y carpetas a otra carpeta. Todo o nada: si algo choca de nombre, no se mueve nada.
async function batchMove({ req, res, user }) {
  const body = await readJson(req);
  const fileIds = validIdList(body.files);
  const folderIds = validIdList(body.folders);
  const target = await findFolder(user, validFolderId(body.folderId));
  const targetId = target?.id ?? null;
  try {
    const moved = await db.tx(async (query) => {
      if (targetId && (await folderTree(query, user, folderIds)).includes(targetId)) {
        throw new HttpError(400, 'No se puede mover una carpeta dentro de sí misma');
      }
      const files = fileIds.length
        ? await query(`UPDATE files SET folder_id = $3 WHERE owner_id = $2 AND ready AND id ${IN_LIST('$1')} RETURNING id`, [idList(fileIds), user.id, targetId])
        : [];
      const folders = folderIds.length
        ? await query(`UPDATE folders SET parent_id = $3 WHERE owner_id = $2 AND id ${IN_LIST('$1')} RETURNING id`, [idList(folderIds), user.id, targetId])
        : [];
      return { files: files.length, folders: folders.length };
    });
    sendJson(res, 200, moved);
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) throw new HttpError(409, 'En la carpeta de destino ya hay algo con el mismo nombre');
    throw err;
  }
}

// Una subida tiene tres pasos: crearla (aquí), enviar los bytes a la URL devuelta y confirmarla.
// Hasta que se confirma, el fichero no aparece en la lista ni reemplaza a otro con el mismo nombre.
async function createUpload({ req, res, user }) {
  const { name, size, folderId } = await readJson(req);
  if (typeof size === 'number' && size > MAX_FILE_BYTES) throw new HttpError(413, 'Fichero demasiado grande');
  const folder = await findFolder(user, validFolderId(folderId));
  const file = { id: crypto.randomUUID(), owner_id: user.id };

  const abandoned = await db.query(
    `DELETE FROM files WHERE NOT ready AND created_at < now() - interval '1 day' RETURNING id, owner_id`
  );
  await storage().remove(abandoned.map(storageKey));

  await db.query('INSERT INTO files (id, owner_id, folder_id, name) VALUES ($1, $2, $3, $4)', [
    file.id,
    file.owner_id,
    folder?.id ?? null,
    validName(name, 'fichero'),
  ]);
  const direct = size > DIRECT_UPLOAD_MIN ? await storage().directUpload(storageKey(file), MAX_FILE_BYTES) : null;
  sendJson(res, 201, {
    id: file.id,
    upload: direct || { url: `/api/files/${file.id}/content`, headers: { 'content-type': 'application/octet-stream' } },
  });
}

async function receiveContent(ctx) {
  const file = await findFile(ctx, false);
  await storage().write(storageKey(file), limitBytes(ctx.req, MAX_FILE_BYTES));
  sendJson(ctx.res, 200, { ok: true });
}

async function completeUpload(ctx) {
  const file = await findFile(ctx, false);
  const size = await storage().size(storageKey(file));
  if (size === null) throw new HttpError(400, 'La subida no llegó a completarse');
  if (size > MAX_FILE_BYTES) {
    await db.query('DELETE FROM files WHERE id = $1', [file.id]);
    await storage().remove([storageKey(file)]);
    throw new HttpError(413, 'Fichero demasiado grande');
  }

  const { saved, replaced } = await db.tx(async (query) => {
    const replaced = await query(
      'DELETE FROM files WHERE owner_id = $1 AND name = $2 AND folder_id IS NOT DISTINCT FROM $3 AND ready RETURNING id, owner_id',
      [file.owner_id, file.name, file.folder_id]
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
    const [renamed] = await db.query('UPDATE files SET name = $2 WHERE id = $1 RETURNING *', [file.id, validName(name, 'fichero')]);
    sendJson(ctx.res, 200, publicFile(renamed));
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) throw new HttpError(409, 'Ya existe un fichero con ese nombre');
    throw err;
  }
}

async function deleteFile(ctx) {
  const file = await findFile(ctx, true);
  sendJson(ctx.res, 200, await deleteItems(ctx.user, [file.id], []));
}

// --- rutas ---

const route = (access, method, path, handler) => ({ access, method, pattern: new RegExp(`^${path}$`), handler });

const routes = [
  route('public', 'POST', '/api/auth/check', checkUser),
  route('public', 'POST', '/api/auth/login', login),
  route('public', 'POST', '/api/auth/activate', activateUser),
  route('public', 'POST', '/api/auth/logout', logout),
  route('user', 'GET', '/api/me', ({ res, user }) => sendJson(res, 200, publicUser(user))),

  route('admin', 'GET', '/api/users', listUsers),
  route('admin', 'POST', '/api/users', createUser),
  route('admin', 'POST', '/api/users/(?<id>\\d{1,9})/reset', resetUser),
  route('admin', 'DELETE', '/api/users/(?<id>\\d{1,9})', deleteUser),

  route('user', 'GET', '/api/folders', listAllFolders),
  route('user', 'POST', '/api/folders', createFolder),
  route('user', 'PATCH', `/api/folders/(?<id>${UUID})`, renameFolder),
  route('user', 'DELETE', `/api/folders/(?<id>${UUID})`, deleteFolder),

  route('user', 'GET', '/api/files', listFolder),
  route('user', 'POST', '/api/files', createUpload),
  route('user', 'PUT', `/api/files/(?<id>${UUID})/content`, receiveContent),
  route('user', 'POST', `/api/files/(?<id>${UUID})/complete`, completeUpload),
  route('user', 'GET', `/api/files/(?<id>${UUID})/content`, download),
  route('user', 'PATCH', `/api/files/(?<id>${UUID})`, renameFile),
  route('user', 'DELETE', `/api/files/(?<id>${UUID})`, deleteFile),

  route('user', 'POST', '/api/batch/delete', batchDelete),
  route('user', 'POST', '/api/batch/move', batchMove),
];

async function dispatch(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  const found = routes.find((r) => r.method === req.method && r.pattern.test(pathname));
  if (!found) throw new HttpError(404, 'No encontrado');

  // Los navegadores modernos indican de dónde viene la petición: nada que cambie datos puede venir de otro sitio.
  const site = req.headers['sec-fetch-site'];
  if (req.method !== 'GET' && site && site !== 'same-origin' && site !== 'none') {
    throw new HttpError(403, 'Petición rechazada por venir de otro sitio');
  }

  const ctx = { req, res, params: found.pattern.exec(pathname).groups, user: null };
  if (found.access === 'public') {
    if (await auth.rateLimited(`auth:${auth.clientIp(req)}`, AUTH_LIMIT.requests, AUTH_LIMIT.minutes)) {
      throw new HttpError(429, 'Demasiadas peticiones. Espera unos minutos.');
    }
  } else {
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
