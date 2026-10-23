const $ = (id) => document.getElementById(id);
const text = $('text');
const filename = $('filename');
let me = null;

// Carpeta abierta (null es la raíz), su contenido y lo que hay seleccionado ("file:<id>" o "folder:<id>").
let currentFolder = null;
let knownFolders = [];
let knownFiles = [];
const selected = new Set();

// --- utilidades ---

let statusTimer;
function notify(message, isError = false) {
  const el = $('status');
  el.textContent = message;
  el.className = 'show' + (isError ? ' error' : '');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { el.className = ''; }, isError ? 5000 : 2500);
}

function formatSize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return (i === 0 ? bytes : bytes.toFixed(1)) + ' ' + units[i];
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const contentUrl = (file) => `/api/files/${file.id}/content`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Cuenta los saltos de línea de value; si se pasa un límite, para en cuanto lo supera.
function countNewlines(value, limit = Infinity) {
  let count = 0;
  for (let i = value.indexOf('\n'); i !== -1 && count <= limit; i = value.indexOf('\n', i + 1)) count++;
  return count;
}

function button(label, onClick, className) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (className) b.className = className;
  b.addEventListener('click', onClick);
  return b;
}

// Crea una fila de tabla a partir de [clase, contenido] por celda.
function tableRow(cells) {
  const tr = document.createElement('tr');
  for (const [className, content] of cells) {
    const td = document.createElement('td');
    td.className = className;
    td.append(...[].concat(content));
    tr.append(td);
  }
  return tr;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    showLogin();
    throw new Error('La sesión ha caducado: vuelve a entrar');
  }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

// --- acceso ---
// Primero se pide el usuario; según sea su primer acceso o no, se le pide la contraseña o que la elija
// (con el código de activación que le dio el administrador).

let loginStep = 'user';
let loginNeedsCode = false;

function setLoginStep(step, needsCode = false) {
  loginStep = step;
  loginNeedsCode = needsCode;
  $('login-user').readOnly = step !== 'user';
  $('login-back').hidden = step === 'user';
  $('login-pass-row').hidden = step !== 'password';
  $('login-code-row').hidden = step !== 'create' || !needsCode;
  $('login-new-row').hidden = step !== 'create';
  $('login-confirm-row').hidden = step !== 'create';
  $('login-hint').hidden = step !== 'create';
  $('login-submit').textContent = { user: 'Continuar', password: 'Entrar', create: 'Crear contraseña y entrar' }[step];
  $('login-error').textContent = '';
  for (const id of ['login-pass', 'login-code', 'login-new', 'login-confirm']) $(id).value = '';
  $({ user: 'login-user', password: 'login-pass', create: needsCode ? 'login-code' : 'login-new' }[step]).focus();
}

function showLogin() {
  me = null;
  $('users-dialog').close();
  $('move-dialog').close();
  $('app').hidden = true;
  $('login').hidden = false;
  setLoginStep('user');
}

async function submitLogin() {
  const username = $('login-user').value.trim();
  if (loginStep === 'user') {
    const { pending, needsCode } = await api('POST', '/api/auth/check', { username });
    return setLoginStep(pending ? 'create' : 'password', needsCode);
  }
  if (loginStep === 'password') {
    return enterApp(await api('POST', '/api/auth/login', { username, password: $('login-pass').value }));
  }
  const code = $('login-code').value.trim();
  const password = $('login-new').value;
  if (loginNeedsCode && !code) throw new Error('Escribe el código de activación');
  if (password.length < 8) throw new Error('La contraseña debe tener al menos 8 caracteres');
  if (password !== $('login-confirm').value) throw new Error('Las dos contraseñas no coinciden');
  enterApp(await api('POST', '/api/auth/activate', { username, code, password }));
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').textContent = '';
  $('login-submit').disabled = true;
  try {
    await submitLogin();
  } catch (err) {
    $('login-error').textContent = err.message;
  }
  $('login-submit').disabled = false;
});
$('login-back').addEventListener('click', () => setLoginStep('user'));

function enterApp(user) {
  me = user;
  $('login').hidden = true;
  $('app').hidden = false;
  $('me').textContent = user.username;
  $('me-admin').hidden = !user.isAdmin;
  $('users-open').hidden = !user.isAdmin;
  text.focus();
  refresh();
}

// Recargar la página vacía el texto y la lista del usuario que sale.
$('logout').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout').catch(() => {});
  location.hash = '';
  location.reload();
});

// --- usuarios (solo administradores) ---
// Se gestionan en un diálogo aparte. Sus avisos van dentro: el aviso general quedaría tapado por el diálogo.

const NEW_USER_HINT = 'Al crear un usuario recibirás su código de activación: dáselo junto con su nombre de usuario. Lo usará para elegir su contraseña la primera vez que entre.';

function usersMessage(message, isError = false, code = null) {
  const el = $('users-message');
  el.className = isError ? 'error' : 'muted';
  el.textContent = message;
  if (code) {
    const chip = document.createElement('code');
    chip.textContent = code;
    el.append(' Código de activación: ', chip, ' (solo se muestra ahora).');
  }
}

$('users-open').addEventListener('click', () => {
  usersMessage(NEW_USER_HINT);
  $('users-dialog').showModal();
  refreshUsers();
});
$('users-close').addEventListener('click', () => $('users-dialog').close());

async function refreshUsers() {
  let users;
  try {
    users = await api('GET', '/api/users');
  } catch (err) {
    return usersMessage(err.message, true);
  }
  $('users').replaceChildren(...users.map((user) => tableRow([
    ['name', user.username],
    ['num', user.isAdmin ? 'Administrador' : 'Usuario'],
    ['num', user.pending ? 'Pendiente de activar' : 'Activo'],
    ['actions', user.id === me.id ? [] : [
      button('Restablecer contraseña', () => resetUser(user)),
      button('Borrar', () => removeUser(user), 'danger'),
    ]],
  ])));
}

async function userAction(request, message) {
  try {
    const result = await request();
    usersMessage(message, false, result?.activationCode);
  } catch (err) {
    usersMessage(err.message, true);
  }
  await refreshUsers();
}

function resetUser(user) {
  if (!confirm(`¿Restablecer la contraseña de "${user.username}"? Se cerrarán sus sesiones y necesitará el código nuevo para elegir otra.`)) return;
  userAction(() => api('POST', `/api/users/${user.id}/reset`), `Contraseña de ${user.username} restablecida.`);
}

function removeUser(user) {
  if (!confirm(`¿Borrar el usuario "${user.username}" y todos sus ficheros?`)) return;
  userAction(() => api('DELETE', `/api/users/${user.id}`), `Usuario borrado: ${user.username}`);
}

$('user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('user-name').value;
  await userAction(async () => {
    const user = await api('POST', '/api/users', { username, isAdmin: $('user-admin').checked });
    e.target.reset();
    return user;
  }, `Usuario creado: ${username.trim().toLowerCase()}.`);
});

// --- nombre propuesto para el texto ---
// Mientras el texto no se haya guardado ni venga de un fichero, la extensión del nombre sigue al tipo
// de contenido detectado. Solo se toca la extensión que puso la aplicación: si se cambia a mano, se respeta.

let isNewDocument = true;
let suggestedExt = TEXT_TYPE.ext;

function suggestExtension(type) {
  const previous = '.' + suggestedExt;
  suggestedExt = type.ext;
  $('detected').textContent = text.value ? `Tipo detectado: ${type.label}` : '';
  if (!isNewDocument) return;

  const value = filename.value;
  if (!text.value) {
    if (value === previous) filename.value = '';
    return;
  }
  if (value !== '' && !value.endsWith(previous)) return;
  const base = value.slice(0, value.length - (value ? previous.length : 0));
  const caret = Math.min(filename.selectionStart, base.length);
  filename.value = `${base}.${suggestedExt}`;
  if (document.activeElement === filename) filename.setSelectionRange(caret, caret);
}

// Con solo la extensión propuesta, el cursor va delante para escribir el nombre directamente.
filename.addEventListener('focus', () => {
  if (isNewDocument && filename.value === '.' + suggestedExt) setTimeout(() => filename.setSelectionRange(0, 0));
});

function startNewDocument() {
  text.value = '';
  filename.value = '';
  isNewDocument = true;
  updateCounter();
}

// --- contador y detección (con retardo: leer un texto de miles de líneas en cada tecla es caro) ---

let counterTimer;
function updateCounter() {
  clearTimeout(counterTimer);
  counterTimer = setTimeout(() => {
    const value = text.value;
    const lines = value ? countNewlines(value) + 1 : 0;
    $('counter').textContent =
      `${lines.toLocaleString('es')} líneas · ${value.length.toLocaleString('es')} caracteres`;
    suggestExtension(detectType(value));
  }, 150);
}
text.addEventListener('input', updateCounter);

// --- texto ---

// El pegado nativo de Chrome en un textarea es cuadrático con el número de líneas (5.000 líneas ≈ 14 s),
// así que los pegados grandes se insertan directamente. A cambio, esos no se pueden deshacer con Cmd/Ctrl+Z.
const FAST_PASTE_LINES = 200;
function insertText(value) {
  text.setRangeText(value, text.selectionStart, text.selectionEnd, 'end');
  // setRangeText no desplaza la vista hasta el cursor; recuperar el foco sí.
  text.blur();
  text.focus();
  updateCounter();
}

$('paste').addEventListener('click', async () => {
  try {
    insertText(await navigator.clipboard.readText());
  } catch {
    text.focus();
    notify('El navegador no permite leer el portapapeles: usa Cmd/Ctrl+V', true);
  }
});

$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(text.value);
    notify('Copiado al portapapeles');
  } catch {
    text.select();
    notify('El navegador no permite escribir en el portapapeles: usa Cmd/Ctrl+C', true);
  }
});

$('clear').addEventListener('click', () => {
  if (text.value && !confirm('¿Borrar el texto?')) return;
  startNewDocument();
  text.focus();
});

async function saveText() {
  let name = filename.value.trim();
  if (!name || (isNewDocument && name === '.' + suggestedExt)) name = `nota-${timestamp()}.${suggestedExt}`;
  else if (isNewDocument && !name.includes('.')) name += '.' + suggestedExt;
  if (!confirmOverwrite(name)) return;
  const blob = new Blob([text.value], { type: 'text/plain;charset=utf-8' });
  try {
    await upload(name, blob);
    filename.value = name;
    isNewDocument = false;
    notify(`Guardado: ${name}`);
    await refresh();
  } catch (err) {
    notify(err.message, true);
  }
}
$('save').addEventListener('click', saveText);
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's' && me) {
    e.preventDefault();
    saveText();
  }
});

async function openInEditor(file) {
  if (file.size > 20 * 1024 * 1024 &&
      !confirm(`${file.name} ocupa ${formatSize(file.size)}. ¿Abrirlo en el editor igualmente?`)) return;
  if (text.value && !confirm('Se reemplazará el texto actual. ¿Continuar?')) return;
  try {
    const res = await fetch(contentUrl(file));
    if (!res.ok) throw new Error('No se pudo abrir el fichero');
    text.value = await res.text();
    filename.value = file.name;
    isNewDocument = false;
    updateCounter();
    text.scrollTop = 0;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    notify(err.message, true);
  }
}

// --- subir ---

function confirmOverwrite(name) {
  return !knownFiles.some((f) => f.name === name) || confirm(`"${name}" ya existe. ¿Sobrescribir?`);
}

function sendBytes(target, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', target.url);
    for (const [header, value] of Object.entries(target.headers)) xhr.setRequestHeader(header, value);
    if (onProgress) xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded, e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      // El servidor responde { error: "…" }; el almacén, { error: { message: "…" } }.
      let message;
      try {
        const { error } = JSON.parse(xhr.responseText);
        message = error?.message || error;
      } catch {}
      reject(new Error(typeof message === 'string' ? message : `Error ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('error de red'));
    xhr.send(blob);
  });
}

// El servidor decide adónde van los bytes: a él mismo o, si el fichero es grande, directo al almacén.
async function upload(name, blob, onProgress) {
  try {
    const { id, upload: target } = await api('POST', '/api/files', { name, size: blob.size, folderId: currentFolder });
    await sendBytes(target, blob, onProgress);
    await api('POST', `/api/files/${id}/complete`);
  } catch (err) {
    throw new Error(`${name}: ${err.message}`);
  }
}

async function uploadFiles(fileList) {
  const files = [...fileList].filter((f) => confirmOverwrite(f.name));
  if (!files.length) return;
  const progress = $('progress');
  const total = files.reduce((sum, f) => sum + f.size, 0) || 1;
  let done = 0;
  let failed = 0;
  progress.value = 0;
  progress.hidden = false;
  for (const file of files) {
    try {
      await upload(file.name, file, (loaded) => { progress.value = (done + loaded) / total; });
    } catch (err) {
      failed++;
      notify(err.message, true);
    }
    done += file.size;
    progress.value = done / total;
  }
  progress.hidden = true;
  if (!failed) notify(files.length === 1 ? `Subido: ${files[0].name}` : `Subidos ${files.length} ficheros`);
  await refresh();
}

// --- carpetas, lista y selección ---

const describe = ({ files, folders }) =>
  [files && plural(files, 'fichero', 'ficheros'), folders && plural(folders, 'carpeta', 'carpetas')].filter(Boolean).join(' y ');

function openFolder(id) {
  currentFolder = id;
  refresh();
}

async function removeFile(file) {
  if (!confirm(`¿Borrar "${file.name}"?`)) return;
  await runAndRefresh(() => api('DELETE', `/api/files/${file.id}`), `Borrado: ${file.name}`);
}

async function removeFolder(folder) {
  if (!confirm(`¿Borrar la carpeta "${folder.name}" con todo lo que contiene?`)) return;
  await runAndRefresh(async () => `Borrada la carpeta ${folder.name}: ${describe(await api('DELETE', `/api/folders/${folder.id}`))}`);
}

async function runAndRefresh(request, message) {
  try {
    const result = await request();
    notify(message || result);
  } catch (err) {
    notify(err.message, true);
  }
  await refresh();
}

$('new-folder').addEventListener('click', async () => {
  const name = prompt('Nombre de la carpeta nueva');
  if (name === null || !name.trim()) return;
  await runAndRefresh(() => api('POST', '/api/folders', { name, parentId: currentFolder }), `Carpeta creada: ${name.trim()}`);
});

// Cambia la celda del nombre por un campo editable: Intro guarda, Esc o salir del campo cancela.
function startRename(item, cell, save) {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = item.name;
  input.spellcheck = false;
  let finished = false;
  const finish = async (commit) => {
    if (finished) return;
    finished = true;
    const name = input.value.trim();
    if (commit && name && name !== item.name) {
      try {
        await save(name);
        notify(`Renombrado: ${name}`);
      } catch (err) {
        notify(err.message, true);
      }
    }
    await refresh();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(false));
  cell.replaceChildren(input);
  input.focus();
  // Como en el Finder: se selecciona el nombre sin la extensión.
  const dot = item.name.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 ? dot : item.name.length);
}

async function renameFile(file, name) {
  await api('PATCH', `/api/files/${file.id}`, { name });
  // Si es el fichero abierto en el editor, guardar de nuevo debe ir al nombre nuevo.
  if (!isNewDocument && filename.value === file.name) filename.value = name;
}

function renderCrumbs(path) {
  const crumbs = [button('Inicio', () => openFolder(null), 'link')];
  path.forEach((folder, i) => {
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '›';
    const last = i === path.length - 1;
    const label = last ? Object.assign(document.createElement('span'), { className: 'current', textContent: folder.name }) : button(folder.name, () => openFolder(folder.id), 'link');
    crumbs.push(sep, label);
  });
  if (!path.length) crumbs[0].className = 'current';
  $('crumbs').replaceChildren(...crumbs);
}

function selectionKeys() {
  const files = [], folders = [];
  for (const key of selected) (key.startsWith('file:') ? files : folders).push(key.slice(key.indexOf(':') + 1));
  return { files, folders };
}

function updateSelection() {
  const total = knownFolders.length + knownFiles.length;
  const all = $('select-all');
  all.checked = total > 0 && selected.size === total;
  all.indeterminate = selected.size > 0 && selected.size < total;
  for (const row of $('files').children) row.classList.toggle('selected', selected.has(row.dataset.key));
  $('selection').hidden = selected.size === 0;
  $('selection-count').textContent = plural(selected.size, 'elemento seleccionado', 'elementos seleccionados');
}

function checkbox(key) {
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = selected.has(key);
  box.addEventListener('change', () => {
    box.checked ? selected.add(key) : selected.delete(key);
    updateSelection();
  });
  return box;
}

$('select-all').addEventListener('change', (e) => {
  selected.clear();
  if (e.target.checked) {
    for (const folder of knownFolders) selected.add(`folder:${folder.id}`);
    for (const file of knownFiles) selected.add(`file:${file.id}`);
  }
  for (const box of $('files').querySelectorAll('td.check input')) box.checked = e.target.checked;
  updateSelection();
});
$('clear-selection').addEventListener('click', () => {
  selected.clear();
  for (const box of $('files').querySelectorAll('td.check input')) box.checked = false;
  updateSelection();
});

$('delete-selected').addEventListener('click', async () => {
  const items = selectionKeys();
  const warning = items.folders.length ? ' Las carpetas se borran con todo lo que contienen.' : '';
  if (!confirm(`¿Borrar ${plural(selected.size, 'elemento', 'elementos')}?${warning}`)) return;
  await runAndRefresh(async () => `Borrados: ${describe(await api('POST', '/api/batch/delete', items))}`);
});

// Mover: se elige la carpeta de destino entre todas las del usuario, menos las que se están moviendo.
$('move-selected').addEventListener('click', async () => {
  let folders;
  try {
    folders = await api('GET', '/api/folders');
  } catch (err) {
    return notify(err.message, true);
  }
  const moving = new Set(selectionKeys().folders);
  const movingPaths = folders.filter((f) => moving.has(f.id)).map((f) => f.path + '/');
  const options = [{ id: '', path: '/ (Inicio)' }, ...folders.filter((f) => !moving.has(f.id) && !movingPaths.some((p) => f.path.startsWith(p))).map((f) => ({ id: f.id, path: '/' + f.path }))];
  $('move-target').replaceChildren(...options.map((o) => Object.assign(document.createElement('option'), { value: o.id, textContent: o.path })));
  $('move-target').value = currentFolder && options.some((o) => o.id === currentFolder) ? currentFolder : '';
  $('move-dialog').showModal();
});
$('move-cancel').addEventListener('click', () => $('move-dialog').close());
$('move-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('move-dialog').close();
  const body = { ...selectionKeys(), folderId: $('move-target').value || null };
  await runAndRefresh(async () => `Movidos: ${describe(await api('POST', '/api/batch/move', body))}`);
});

function fileRow(file) {
  const download = document.createElement('a');
  download.className = 'button';
  download.href = contentUrl(file);
  download.download = file.name;
  download.textContent = 'Descargar';
  const key = `file:${file.id}`;
  const row = tableRow([
    ['check', checkbox(key)],
    ['name', file.name],
    ['num', formatSize(file.size)],
    ['date', new Date(file.mtime).toLocaleString('es')],
    ['actions', [
      download,
      button('Abrir en editor', () => openInEditor(file)),
      button('Renombrar', () => startRename(file, row.children[1], (name) => renameFile(file, name))),
      button('Borrar', () => removeFile(file), 'danger'),
    ]],
  ]);
  row.dataset.key = key;
  return row;
}

function folderRow(folder) {
  const key = `folder:${folder.id}`;
  const open = button(`📁 ${folder.name}`, () => openFolder(folder.id), 'folder');
  const row = tableRow([
    ['check', checkbox(key)],
    ['name', open],
    ['num', '—'],
    ['date', new Date(folder.mtime).toLocaleString('es')],
    ['actions', [
      button('Renombrar', () => startRename(folder, row.children[1], (name) => api('PATCH', `/api/folders/${folder.id}`, { name }))),
      button('Borrar', () => removeFolder(folder), 'danger'),
    ]],
  ]);
  row.dataset.key = key;
  return row;
}

async function refresh() {
  let data;
  try {
    data = await api('GET', currentFolder ? `/api/files?folder=${currentFolder}` : '/api/files');
  } catch (err) {
    // La carpeta ya no existe (borrada desde otra pestaña, enlace viejo…): vuelta a la raíz.
    if (currentFolder && err.message === 'La carpeta no existe') return openFolder(null);
    return notify(err.message, true);
  }
  knownFolders = data.folders;
  knownFiles = data.files;
  selected.clear();
  history.replaceState(null, '', currentFolder ? `#f=${currentFolder}` : location.pathname);
  renderCrumbs(data.path);
  $('files').replaceChildren(...knownFolders.map(folderRow), ...knownFiles.map(fileRow));
  $('empty').textContent = currentFolder ? 'Esta carpeta está vacía.' : 'Todavía no hay ficheros.';
  $('empty').hidden = knownFolders.length + knownFiles.length > 0;
  updateSelection();
}
$('refresh').addEventListener('click', refresh);

// --- subir: selector, arrastrar y pegar ---

const drop = $('drop');
const picker = $('picker');
drop.addEventListener('click', () => picker.click());
picker.addEventListener('change', async () => {
  await uploadFiles(picker.files);
  picker.value = '';
});

// Arrastrar a cualquier parte de la página, no solo a la zona marcada.
const hasFiles = (e) => me && [...(e.dataTransfer?.types || [])].includes('Files');
let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  drop.classList.add('over');
});
document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) { dragDepth = 0; drop.classList.remove('over'); }
});
document.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  drop.classList.remove('over');
  uploadFiles(e.dataTransfer.files);
});

// Pegar ficheros o imágenes (capturas) los sube; pegar texto va al textarea.
document.addEventListener('paste', (e) => {
  if (!me) return;
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) {
    const pasted = e.target === text ? e.clipboardData?.getData('text/plain') : '';
    if (pasted && countNewlines(pasted, FAST_PASTE_LINES) > FAST_PASTE_LINES) {
      e.preventDefault();
      insertText(pasted);
    }
    return;
  }
  e.preventDefault();
  // Las capturas llegan siempre como "image.png": se renombran para que no se pisen entre sí.
  uploadFiles(files.map((f) =>
    f.name === 'image.png' ? new File([f], `captura-${timestamp()}.png`, { type: f.type }) : f));
});

// --- arranque ---
// La carpeta abierta va en la URL (#f=…) para que una recarga vuelva a ella.

currentFolder = (location.hash.match(/^#f=([0-9a-f-]{36})$/) || [])[1] || null;
api('GET', '/api/me').then(enterApp, () => {});
