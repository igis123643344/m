// スマホ内保存（IndexedDB）
const DB_NAME = 'maimai-rate';
const DB_VER = 1;
let dbp = null;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('plays')) {
          const s = db.createObjectStore('plays', { keyPath: 'id', autoIncrement: true });
          s.createIndex('chartKey', 'chartKey');
        }
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });
        if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', { keyPath: 'vp' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export async function getAll(name) {
  return wrap((await store(name)).getAll());
}
export async function put(name, value) {
  return wrap((await store(name, 'readwrite')).put(value));
}
export async function del(name, key) {
  return wrap((await store(name, 'readwrite')).delete(key));
}
export async function clear(name) {
  return wrap((await store(name, 'readwrite')).clear());
}
export async function kvGet(k, fallback = null) {
  const r = await wrap((await store('kv')).get(k));
  return r ? r.v : fallback;
}
export async function kvSet(k, v) {
  return put('kv', { k, v });
}

export async function bulkPut(name, values) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readwrite');
    const s = tx.objectStore(name);
    for (const v of values) s.put(v);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ブラウザに「このサイトのデータを勝手に消さない」よう依頼
export async function requestPersist() {
  if (!navigator.storage?.persist) return null;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}
export async function isPersisted() {
  if (!navigator.storage?.persisted) return null;
  return navigator.storage.persisted();
}
