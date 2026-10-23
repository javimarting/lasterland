const fs = require('node:fs');
const path = require('node:path');

// Todas las sentencias son idempotentes: se ejecutan en cada arranque y sirven también de migración.
const NO_FOLDER = '00000000-0000-0000-0000-000000000000';
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id              SERIAL PRIMARY KEY,
    username        TEXT NOT NULL UNIQUE,
    password_hash   TEXT,
    is_admin        BOOLEAN NOT NULL DEFAULT FALSE,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE users ADD COLUMN IF NOT EXISTS activation_hash TEXT;
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
  );
  CREATE TABLE IF NOT EXISTS folders (
    id         UUID PRIMARY KEY,
    owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_id  UUID REFERENCES folders(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS folders_parent_name
    ON folders (owner_id, COALESCE(parent_id, '${NO_FOLDER}'::uuid), name);
  CREATE TABLE IF NOT EXISTS files (
    id         UUID PRIMARY KEY,
    owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    size       BIGINT NOT NULL DEFAULT 0,
    ready      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE files ADD COLUMN IF NOT EXISTS folder_id UUID REFERENCES folders(id) ON DELETE CASCADE;
  DROP INDEX IF EXISTS files_owner_name;
  CREATE UNIQUE INDEX IF NOT EXISTS files_folder_name
    ON files (owner_id, COALESCE(folder_id, '${NO_FOLDER}'::uuid), name) WHERE ready;
  CREATE TABLE IF NOT EXISTS rate_limits (
    key      TEXT PRIMARY KEY,
    count    INTEGER NOT NULL,
    reset_at TIMESTAMPTZ NOT NULL
  );
`;

function connectPostgres(connectionString) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString, max: 5, idleTimeoutMillis: 10_000 });
  // Un cliente inactivo que pierde la conexión no debe tumbar el proceso.
  pool.on('error', (err) => console.error('Postgres:', err.message));
  return {
    query: (text, params) => pool.query(text, params).then((r) => r.rows),
    exec: (sql) => pool.query(sql),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn((text, params) => client.query(text, params).then((r) => r.rows));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

// Importar a través de un parámetro impide que Vercel rastree el módulo y lo empaquete en producción.
const importDevDependency = (name) => import(name);

// Solo para desarrollo: un Postgres embebido en .data/ para no necesitar base de datos en local.
async function connectEmbedded() {
  const { PGlite } = await importDevDependency('@electric-sql/pglite');
  const dataDir = path.join(__dirname, '..', '.data');
  fs.mkdirSync(dataDir, { recursive: true });
  const db = await PGlite.create(path.join(dataDir, 'pg'));
  return {
    query: (text, params) => db.query(text, params).then((r) => r.rows),
    exec: (sql) => db.exec(sql),
    tx: (fn) => db.transaction((t) => fn((text, params) => t.query(text, params).then((r) => r.rows))),
  };
}

// El primer administrador se crea sin contraseña, con un código de activación que solo sale por el log.
async function seedAdmin(db) {
  const { hashCode, newActivationCode } = require('./auth');
  const code = newActivationCode();
  const [created] = await db.query(
    `INSERT INTO users (username, is_admin, activation_hash) VALUES ('javi', TRUE, $1)
       ON CONFLICT (username) DO NOTHING RETURNING id`,
    [hashCode(code)]
  );
  if (created) console.log(`Usuario "javi" creado. Código de activación para su primer acceso: ${code}`);
}

async function connect() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url && process.env.VERCEL) throw new Error('Falta la variable DATABASE_URL');
  const db = url ? connectPostgres(url) : await connectEmbedded();
  // El bloqueo evita que dos arranques simultáneos choquen creando las tablas.
  await db.exec(`BEGIN; SELECT pg_advisory_xact_lock(727274); ${SCHEMA} COMMIT;`);
  await seedAdmin(db);
  return db;
}

let connection;
function getDb() {
  connection ??= connect().catch((err) => {
    connection = undefined;
    throw err;
  });
  return connection;
}

module.exports = {
  query: async (text, params) => (await getDb()).query(text, params),
  tx: async (fn) => (await getDb()).tx(fn),
};
