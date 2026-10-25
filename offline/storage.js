// offline/storage.js — хранилище offline-лаборатории (B03, issue #26).
//
//   - настройки и небольшое автосохранение — localStorage;
//   - коллекция реплеев — IndexedDB (база 'tochki-offline', store 'replays');
//   - любой отказ хранилища (нет API, SecurityError, QuotaExceededError,
//     приватный режим, повреждённые данные) НЕ бросает исключение наружу:
//     функции возвращают {ok:false, error} / null, игра продолжается.
//
// Работает в браузере (обычный <script>, глобальный TochkiStorage) и в Node
// (require; хранилища передаются явно через createStorage({localStorage, indexedDB})).
(function(root, factory){
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TochkiStorage = factory();
})(typeof self !== 'undefined' ? self : this, function(){
  'use strict';

  const SETTINGS_KEY = 'tochki.offline.settings.v1';
  const AUTOSAVE_KEY = 'tochki.offline.autosave.v1';
  const AUTOSAVE_MAX_CHARS = 256 * 1024; // «небольшое» автосохранение
  const DB_NAME = 'tochki-offline';
  const DB_VERSION = 1;
  const STORE = 'replays';

  function errText(e){
    if (!e) return 'неизвестная ошибка хранилища';
    if (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014) return 'превышена квота хранилища';
    return (e.name ? e.name + ': ' : '') + (e.message || String(e));
  }

  function createStorage(opts){
    opts = opts || {};
    let ls = null, idb = null;
    try { ls = opts.localStorage !== undefined ? opts.localStorage : (typeof localStorage !== 'undefined' ? localStorage : null); } catch (_) { ls = null; }
    try { idb = opts.indexedDB !== undefined ? opts.indexedDB : (typeof indexedDB !== 'undefined' ? indexedDB : null); } catch (_) { idb = null; }
    let lastError = null;
    let dbPromise = null;

    function note(e){ lastError = errText(e); return { ok: false, error: lastError }; }

    // ---------- localStorage ----------
    function lsGet(key){
      if (!ls) return null;
      try {
        const raw = ls.getItem(key);
        if (raw == null) return null;
        return JSON.parse(raw);
      } catch (e){ note(e); return null; }
    }
    function lsSet(key, value, maxChars){
      if (!ls) return note({ message: 'localStorage недоступен' });
      try {
        const raw = JSON.stringify(value);
        if (maxChars && raw.length > maxChars) return note({ name: 'QuotaExceededError', message: 'автосохранение слишком большое' });
        ls.setItem(key, raw);
        return { ok: true };
      } catch (e){ return note(e); }
    }
    function lsRemove(key){
      if (!ls) return { ok: false, error: 'localStorage недоступен' };
      try { ls.removeItem(key); return { ok: true }; } catch (e){ return note(e); }
    }

    const loadSettings = () => { const v = lsGet(SETTINGS_KEY); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; };
    const saveSettings = s => lsSet(SETTINGS_KEY, s);
    const loadAutosave = () => lsGet(AUTOSAVE_KEY);
    const saveAutosave = replayObj => lsSet(AUTOSAVE_KEY, replayObj, AUTOSAVE_MAX_CHARS);
    const clearAutosave = () => lsRemove(AUTOSAVE_KEY);

    // ---------- IndexedDB ----------
    function openDb(){
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        if (!idb || typeof idb.open !== 'function'){ reject(new Error('IndexedDB недоступен')); return; }
        let req;
        try { req = idb.open(DB_NAME, DB_VERSION); } catch (e){ reject(e); return; }
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('IndexedDB: не удалось открыть базу'));
        req.onblocked = () => reject(new Error('IndexedDB: база заблокирована другой вкладкой'));
      });
      dbPromise.catch(() => { dbPromise = null; });
      return dbPromise;
    }
    function tx(mode, fn){
      return openDb().then(db => new Promise((resolve, reject) => {
        let t, result;
        try { t = db.transaction(STORE, mode); } catch (e){ reject(e); return; }
        const store = t.objectStore(STORE);
        try {
          const req = fn(store);
          if (req) req.onsuccess = () => { result = req.result; };
        } catch (e){ reject(e); return; }
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('IndexedDB: транзакция прервана'));
      }));
    }
    function wrap(p){ return p.then(value => ({ ok: true, value }), e => note(e)); }

    // record: {name, savedAt, scores, moves, replay} — replay в общем формате A02.
    function saveReplay(name, replayObj){
      const s = summarize(replayObj);
      const rec = { name: String(name || 'Партия').slice(0, 100), savedAt: Date.now(), summary: s, replay: replayObj };
      return wrap(tx('readwrite', store => store.add(rec)));
    }
    function listReplays(){
      return wrap(tx('readonly', store => store.getAll())).then(r => {
        if (!r.ok) return r;
        return { ok: true, value: (r.value || []).map(x => ({ id: x.id, name: x.name, savedAt: x.savedAt, summary: x.summary })) };
      });
    }
    function getReplay(id){ return wrap(tx('readonly', store => store.get(id))).then(r => r.ok ? { ok: true, value: r.value ? r.value.replay : null } : r); }
    function deleteReplay(id){ return wrap(tx('readwrite', store => store.delete(id))); }

    return {
      loadSettings, saveSettings, loadAutosave, saveAutosave, clearAutosave,
      saveReplay, listReplays, getReplay, deleteReplay,
      available: () => ({ localStorage: !!ls, indexedDB: !!idb }),
      lastError: () => lastError
    };
  }

  function summarize(r){
    try {
      const ev = (r && r.events) || [];
      const end = ev.length && ev[ev.length - 1].type === 'end' ? ev[ev.length - 1] : null;
      return { sizeKey: r.board && r.board.sizeKey, events: ev.length,
        moves: ev.filter(e => e.type === 'move').length, ended: !!end, scores: end ? end.scores : null };
    } catch (_){ return null; }
  }

  return { createStorage, summarize, SETTINGS_KEY, AUTOSAVE_KEY, AUTOSAVE_MAX_CHARS, DB_NAME, STORE };
});
