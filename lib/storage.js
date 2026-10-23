// Dónde viven los bytes de cada fichero. La clave es "<id de usuario>/<id de fichero>"; el nombre
// visible solo está en la base de datos, así que renombrar no toca el almacenamiento.
//
//   write(key, stream)   guarda el cuerpo recibido por el servidor
//   directUpload(key, maxBytes)  URL a la que el navegador puede subir sin pasar por el servidor, o null
//   size(key)            tamaño en bytes, o null si no existe
//   read(key)            stream de lectura, o null si no existe
//   remove(keys)         borra; no falla si ya no existen

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { buffer } = require('node:stream/consumers');

function blobStorage() {
  const blob = require('@vercel/blob');
  const access = 'private';
  return {
    async write(key, stream) {
      await blob.put(key, await buffer(stream), {
        access,
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: 'application/octet-stream',
      });
    },
    // La URL firmada solo sirve para esa clave, para subir, durante 15 minutos y hasta maxBytes.
    async directUpload(key, maxBytes) {
      const validUntil = Date.now() + 15 * 60 * 1000;
      const token = await blob.issueSignedToken({
        pathname: key,
        operations: ['put'],
        validUntil,
        maximumSizeInBytes: maxBytes,
      });
      const { presignedUrl } = await blob.presignUrl(token, {
        operation: 'put',
        pathname: key,
        access,
        validUntil,
        maximumSizeInBytes: maxBytes,
        addRandomSuffix: false,
        allowOverwrite: true,
      });
      return { url: presignedUrl, headers: { 'content-type': 'application/octet-stream' } };
    },
    async size(key) {
      try {
        return (await blob.head(key)).size;
      } catch (err) {
        if (err instanceof blob.BlobNotFoundError) return null;
        throw err;
      }
    },
    async read(key) {
      const result = await blob.get(key, { access });
      return result?.stream ? Readable.fromWeb(result.stream) : null;
    },
    async remove(keys) {
      if (keys.length) await blob.del(keys);
    },
  };
}

function diskStorage(root) {
  const file = (key) => path.join(root, key);
  const missing = (err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  };
  return {
    // Se escribe a un temporal y se renombra al final para no dejar ficheros a medias.
    async write(key, stream) {
      const target = file(key);
      const tmp = `${target}.${crypto.randomUUID()}.tmp`;
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      try {
        await pipeline(stream, fs.createWriteStream(tmp));
        await fs.promises.rename(tmp, target);
      } catch (err) {
        await fs.promises.rm(tmp, { force: true });
        throw err;
      }
    },
    directUpload: async () => null,
    size: (key) => fs.promises.stat(file(key)).then((s) => s.size, missing),
    read: (key) => fs.promises.open(file(key)).then((handle) => handle.createReadStream(), missing),
    async remove(keys) {
      await Promise.all(keys.map((key) => fs.promises.rm(file(key), { force: true })));
    },
  };
}

function createStorage() {
  if (process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN) return blobStorage();
  if (process.env.VERCEL) throw new Error('Falta conectar un Blob store al proyecto');
  return diskStorage(path.join(__dirname, '..', '.data', 'files'));
}

let storage;
module.exports = () => (storage ??= createStorage());
