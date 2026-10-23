const crypto = require('node:crypto');
const { promisify } = require('node:util');
const db = require('./db');

const scrypt = promisify(crypto.scrypt);

const SESSION_DAYS = 30;
// Parámetros de scrypt dentro de lo que recomienda OWASP (N=2^15, r=8, p=3). Se guardan en cada hash.
const SCRYPT = { logN: 15, p: 3 };
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
// Alfabeto sin caracteres que se confunden (0/O, 1/I/L).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// --- contraseñas ---

function derive(password, salt, { logN, p }) {
  // maxmem: scrypt necesita 128·N·r bytes, más que el límite por defecto de Node con N=2^15.
  return scrypt(password.normalize('NFKC'), salt, 32, { N: 2 ** logN, r: 8, p, maxmem: 2 ** 26 });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await derive(password, salt, SCRYPT);
  return `scrypt$${SCRYPT.logN}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const parts = stored.split('$');
  // Formato antiguo sin "p" (siempre era 1).
  const [logN, p, salt, hash] = parts.length === 4 ? [parts[1], 1, parts[2], parts[3]] : parts.slice(1);
  const actual = await derive(password, Buffer.from(salt, 'base64'), { logN: Number(logN), p: Number(p) });
  return crypto.timingSafeEqual(actual, Buffer.from(hash, 'base64'));
}

// --- códigos de activación (primer acceso) ---

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const normalizeCode = (code) => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashCode = (code) => sha256(normalizeCode(code));

function newActivationCode() {
  const bytes = crypto.randomBytes(10);
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

function codeMatches(code, storedHash) {
  const a = Buffer.from(hashCode(code));
  const b = Buffer.from(storedHash || '');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- sesiones ---
// La cookie lleva el prefijo __Host- cuando va por HTTPS: así el navegador exige Secure y Path=/.

function isSecure(req) {
  return Boolean(process.env.VERCEL) || req.headers['x-forwarded-proto'] === 'https';
}

const cookieName = (req) => (isSecure(req) ? '__Host-session' : 'session');

function readToken(req) {
  const name = cookieName(req);
  for (const part of (req.headers.cookie || '').split(';')) {
    const [key, value] = part.trim().split('=');
    if (key === name && value) return value;
  }
  return null;
}

function setCookie(req, res, value, maxAgeSeconds) {
  const secure = isSecure(req) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${cookieName(req)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`
  );
}

// En la base de datos solo se guarda el hash del token: una copia de la tabla no sirve para entrar.
async function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  await db.query('DELETE FROM sessions WHERE expires_at < now()');
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + $3 * interval '1 day')`,
    [sha256(token), userId, SESSION_DAYS]
  );
  setCookie(req, res, token, SESSION_DAYS * 24 * 60 * 60);
}

async function endSession(req, res) {
  const token = readToken(req);
  if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
  setCookie(req, res, '', 0);
}

async function currentUser(req) {
  const token = readToken(req);
  if (!token) return null;
  const [user] = await db.query(
    `SELECT u.id, u.username, u.is_admin
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)]
  );
  return user || null;
}

// --- intentos fallidos ---
// Tras MAX_FAILED_ATTEMPTS fallos seguidos (de contraseña o de código de activación) la cuenta
// queda bloqueada LOCK_MINUTES minutos.

async function findAccount(username) {
  const [user] = await db.query(
    `SELECT id, username, is_admin, password_hash, activation_hash, locked_until > now() AS locked
       FROM users WHERE username = $1`,
    [username]
  );
  return user || null;
}

async function recordFailure(userId) {
  await db.query(
    `UPDATE users
        SET failed_attempts = CASE WHEN failed_attempts + 1 >= $2 THEN 0 ELSE failed_attempts + 1 END,
            locked_until    = CASE WHEN failed_attempts + 1 >= $2 THEN now() + $3 * interval '1 minute' END
      WHERE id = $1`,
    [userId, MAX_FAILED_ATTEMPTS, LOCK_MINUTES]
  );
}

const clearFailures = (userId) =>
  db.query('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [userId]);

// Devuelve el usuario si las credenciales son correctas, 'locked' si está bloqueado por intentos, o null.
async function checkCredentials(username, password) {
  const user = await findAccount(username);
  if (!user || !user.password_hash) {
    // Mismo coste que una comprobación real, para que el tiempo de respuesta no delate qué usuarios existen.
    await derive(password, Buffer.alloc(16), SCRYPT);
    return null;
  }
  if (user.locked) return 'locked';
  if (await verifyPassword(password, user.password_hash)) {
    await clearFailures(user.id);
    return user;
  }
  await recordFailure(user.id);
  return null;
}

// Primer acceso: fija la contraseña si el usuario está pendiente y el código de activación es correcto.
// Devuelve el usuario, 'locked', o null si no procede o el código falla.
async function activate(username, code, passwordHash) {
  const user = await findAccount(username);
  if (!user || user.password_hash) return null;
  if (user.locked) return 'locked';
  // Las cuentas creadas antes de que existieran los códigos no tienen ninguno: se activan sin él.
  if (user.activation_hash && !codeMatches(code, user.activation_hash)) {
    await recordFailure(user.id);
    return null;
  }
  const [activated] = await db.query(
    `UPDATE users SET password_hash = $2, activation_hash = NULL, failed_attempts = 0, locked_until = NULL
      WHERE id = $1 AND password_hash IS NULL RETURNING id, username, is_admin`,
    [user.id, passwordHash]
  );
  return activated || null;
}

// --- límite de peticiones por IP (para las rutas sin sesión) ---

function clientIp(req) {
  // En Vercel la cabecera la pone su propio proxy; fuera de Vercel no es fiable y se usa la conexión.
  const forwarded = process.env.VERCEL ? req.headers['x-forwarded-for'] : null;
  return (forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress) || 'desconocida';
}

// Cuenta peticiones por clave en ventanas de `minutes`; devuelve true si se ha superado `limit`.
async function rateLimited(key, limit, minutes) {
  const [row] = await db.query(
    `INSERT INTO rate_limits (key, count, reset_at) VALUES ($1, 1, now() + $2 * interval '1 minute')
       ON CONFLICT (key) DO UPDATE SET
         count    = CASE WHEN rate_limits.reset_at < now() THEN 1 ELSE rate_limits.count + 1 END,
         reset_at = CASE WHEN rate_limits.reset_at < now() THEN now() + $2 * interval '1 minute' ELSE rate_limits.reset_at END
       RETURNING count`,
    [key, minutes]
  );
  if (Math.random() < 0.01) await db.query(`DELETE FROM rate_limits WHERE reset_at < now() - interval '1 day'`);
  return row.count > limit;
}

module.exports = {
  hashPassword,
  hashCode,
  newActivationCode,
  startSession,
  endSession,
  currentUser,
  checkCredentials,
  activate,
  clientIp,
  rateLimited,
};
