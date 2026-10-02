const fs = require('node:fs');
const path = require('node:path');

// El usuario inicial se crea sin contraseña: la elige él mismo la primera vez que entra.
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
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL
  );
  CREATE TABLE IF NOT EXISTS files (
    id         UUID PRIMARY KEY,
    owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    size       BIGINT NOT NULL DEFAULT 0,
    ready      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS files_owner_name ON files (owner_id, name) WHERE ready;
  INSERT INTO users (username, is_admin) VALUES ('javi', TRUE) ON CONFLICT (username) DO NOTHING;
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

async function connect() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url && process.env.VERCEL) throw new Error('Falta la variable DATABASE_URL');
  const db = url ? connectPostgres(url) : await connectEmbedded();
  // El bloqueo evita que dos arranques simultáneos choquen creando las tablas.
  await db.exec(`BEGIN; SELECT pg_advisory_xact_lock(727274); ${SCHEMA} COMMIT;`);
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
