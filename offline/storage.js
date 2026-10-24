// Best-effort persistence. Every failure is reported, never propagated into play.
(function(root, factory){
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TochkiStorage = factory();
})(typeof self !== 'undefined' ? self : this, function(){
  'use strict';
  function createStorage(options){
    options = options || {};
    const warn = error => {
      try { if (options.onError) options.onError(String(error && error.message || error)); } catch (_) {}
    };
    const local = () => Object.prototype.hasOwnProperty.call(options, 'localStorage') ? options.localStorage : window.localStorage;
    function load(key){
      try { const text = local().getItem('tochki.' + key); return text === null ? null : JSON.parse(text); }
      catch (e){ warn(e); return null; }
    }
    function save(key, value){
      try { local().setItem('tochki.' + key, JSON.stringify(value)); return true; }
      catch (e){ warn(e); return false; }
    }
    let connection;
    function open(){
      if (connection) return connection;
      connection = new Promise((resolve, reject) => {
        const idb = Object.prototype.hasOwnProperty.call(options, 'indexedDB') ? options.indexedDB : window.indexedDB;
        const request = idb.open('tochki-offline', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('replays', { keyPath: 'id', autoIncrement: true });
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('IndexedDB заблокирована другой вкладкой'));
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); connection = null; };
          resolve(db);
        };
      });
      connection.catch(() => { connection = null; });
      return connection;
    }
    async function transaction(mode, action, fallback){
      try {
        const db = await open();
        return await new Promise((resolve, reject) => {
          const tx = db.transaction('replays', mode);
          const req = action(tx.objectStore('replays'));
          tx.oncomplete = () => resolve(req.result);
          tx.onerror = tx.onabort = () => reject(tx.error || req.error || new Error('IndexedDB transaction failed'));
        });
      } catch (e){ warn(e); return fallback; }
    }
    return {
      load, save,
      list: () => transaction('readonly', store => store.getAll(), []),
      put: (name, replay) => transaction('readwrite', store => store.add({ name, replay, savedAt: new Date().toISOString() }), null),
      remove: id => transaction('readwrite', store => store.delete(id), null)
    };
  }
  return { createStorage };
});
