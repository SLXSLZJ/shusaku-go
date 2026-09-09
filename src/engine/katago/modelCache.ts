/**
 * 模型二进制的 IndexedDB 缓存。
 *
 * 首次从网络取回后写入 IDB（约 93–99MB/个），之后每次进页面直接读本地，
 * 免除重复下载。IDB 不可用（隐私模式 / 配额不足）时静默回退为普通 fetch。
 * 缓存键 = 模型 URL；模型更新时换 URL 即换缓存。
 */

const DB_NAME = 'shusaku-models'
const STORE = 'models'
const VERSION = 1

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
  })
}

function idbGet(url: string): Promise<ArrayBuffer | null> {
  return openDb().then(
    (db) =>
      new Promise<ArrayBuffer | null>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly')
        const req = tx.objectStore(STORE).get(url)
        req.onsuccess = () => resolve((req.result as ArrayBuffer | undefined) ?? null)
        req.onerror = () => reject(req.error ?? new Error('IndexedDB get failed'))
      }),
  )
}

function idbPut(url: string, data: ArrayBuffer): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite')
        tx.objectStore(STORE).put(data, url)
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
        tx.onerror = () => reject(tx.error ?? new Error('IndexedDB put failed'))
      }),
  )
}

/** 取模型二进制：优先 IDB 缓存，未命中则 fetch 并回填缓存。 */
export async function fetchModelWithCache(url: string): Promise<Uint8Array> {
  let cached: ArrayBuffer | null = null
  try {
    cached = await idbGet(url)
  } catch {
    cached = null
  }
  if (cached && cached.byteLength > 0) return new Uint8Array(cached)

  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch model: ${res.status} ${res.statusText}`)
  const buf = await res.arrayBuffer()
  // 后台回填缓存：失败（配额/隐私模式）不影响本次使用
  void idbPut(url, buf.slice(0)).catch(() => {})
  return new Uint8Array(buf)
}
