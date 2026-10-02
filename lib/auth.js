const crypto = require('node:crypto');
const { promisify } = require('node:util');
const db = require('./db');

const scrypt = promisify(crypto.scrypt);

const COOKIE = 'session';
const SESSION_DAYS = 30;
const SCRYPT_LOG_N = 15;
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

function derive(password, salt, logN) {
  // maxmem: scrypt necesita 128·N·r bytes, algo más que el límite por defecto de Node con N=2^15.
  return scrypt(password.normalize('NFKC'), salt, 32, { N: 2 ** logN, r: 8, p: 1, maxmem: 2 ** 26 });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await derive(password, salt, SCRYPT_LOG_N);
  return `scrypt$${SCRYPT_LOG_N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [, logN, salt, hash] = stored.split('$');
  const expected = Buffer.from(hash, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), Number(logN));
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function readToken(req) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === COOKIE && value) return value;
  }
  return null;
}

function setCookie(req, res, value, maxAgeSeconds) {
  const secure = process.env.VERCEL || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`
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

// Devuelve el usuario si las credenciales son correctas, 'locked' si está bloqueado por intentos, o null.
async function checkCredentials(username, password) {
  const [user] = await db.query(
    'SELECT id, username, is_admin, password_hash, locked_until > now() AS locked FROM users WHERE username = $1',
    [username]
  );
  if (!user || !user.password_hash) {
    // Mismo coste que una comprobación real, para que el tiempo de respuesta no delate qué usuarios existen.
    await derive(password, Buffer.alloc(16), SCRYPT_LOG_N);
    return null;
  }
  if (user.locked) return 'locked';
  if (await verifyPassword(password, user.password_hash)) {
    await db.query('UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [user.id]);
    return user;
  }
  await db.query(
    `UPDATE users
        SET failed_attempts = CASE WHEN failed_attempts + 1 >= $2 THEN 0 ELSE failed_attempts + 1 END,
            locked_until    = CASE WHEN failed_attempts + 1 >= $2 THEN now() + $3 * interval '1 minute' END
      WHERE id = $1`,
    [user.id, MAX_FAILED_ATTEMPTS, LOCK_MINUTES]
  );
  return null;
}

module.exports = { hashPassword, startSession, endSession, currentUser, checkCredentials };
