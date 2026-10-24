// UI adapter: the shared codec owns validation, LocalSession owns the match.
(function(root){
  'use strict';
  root.TochkiReplayUI = function(session){
    const $ = id => document.getElementById(id);
    const panel = document.createElement('fieldset');
    panel.id = 'replayPanel';
    panel.innerHTML = `<legend>Реплеи и хранение</legend>
      <button id="exportReplay">Экспорт JSON</button>
      <label>Импорт JSON <input id="importReplay" type="file" accept=".json,application/json"></label>
      <div id="replayError" role="alert"></div>
      <label>Позиция реплея <input id="replayPosition" type="range" min="0" max="0" value="0" disabled> <span id="replayPositionText">—</span></label>
      <button id="replayPrevious" disabled>Назад</button><button id="replayNext" disabled>Вперёд</button>
      <label>Название <input id="replayName" maxlength="120" placeholder="Моя партия"></label>
      <button id="saveReplay">В коллекцию</button>
      <button id="refreshReplays">Обновить коллекцию</button>
      <label>Коллекция <select id="replayCollection"></select></label>
      <button id="loadReplay">Открыть</button><button id="deleteReplay">Удалить</button>
      <div id="storageWarning" role="status"></div>`;
    $('trace').parentNode.before(panel);
    const storage = root.TochkiStorage.createStorage({
      onError: message => { $('storageWarning').textContent = 'Хранилище недоступно: ' + message + '. Игра продолжается; используйте экспорт JSON.'; }
    });
    const fields = ['size', 'targetScore', 'targetFill', 'extra', 'undoAllowed', 'first', 'c1', 'c2', 'w1', 'w2', 'delay'];
    function settings(){
      const value = {};
      fields.forEach(id => { const el = $(id); value[id] = el.type === 'checkbox' ? el.checked : el.value; });
      return value;
    }
    const savedSettings = storage.load('settings');
    if (savedSettings && typeof savedSettings === 'object'){
      fields.forEach(id => {
        const el = $(id), v = savedSettings[id];
        if (el.type === 'checkbox' && typeof v === 'boolean') el.checked = v;
        else if (typeof v === 'string' && v.length < 10000){
          if (el.tagName !== 'SELECT' || Array.from(el.options).some(o => o.value === v)) el.value = v;
        }
      });
    }
    $('delayVal').textContent = $('delay').value;
    fields.forEach(id => $(id).addEventListener('change', () => storage.save('settings', settings())));
    let source = null, collection = [], previous = null;
    function position(n){
      session.importReplay(source, n);
      $('replayPosition').value = n;
      $('replayPositionText').textContent = n + ' / ' + source.events.length + ' событий';
      $('replayPrevious').disabled = n === 0;
      $('replayNext').disabled = n === source.events.length;
    }
    function open(input){
      // Do not alter source, controls or the active match unless validation succeeds.
      session.importReplay(input);
      source = session.getReplay();
      $('replayPosition').max = source.events.length;
      $('replayPosition').disabled = false;
      position(source.events.length);
      $('replayError').textContent = '';
    }
    function attempt(fn){
      try { fn(); $('replayError').textContent = ''; }
      catch (e){ $('replayError').textContent = 'Не удалось открыть реплей: ' + e.message; }
    }
    $('importReplay').onchange = async () => {
      const file = $('importReplay').files[0];
      if (!file) return;
      try {
        if (file.size > root.TochkiReplay.MAX_BYTES) throw new Error('Файл превышает 2 МиБ');
        const text = await file.text();
        open(text);
      } catch (e){ $('replayError').textContent = 'Не удалось импортировать реплей: ' + e.message; }
      $('importReplay').value = '';
    };
    $('replayPosition').oninput = () => attempt(() => position(Number($('replayPosition').value)));
    $('replayPrevious').onclick = () => attempt(() => position(Math.max(0, Number($('replayPosition').value) - 1)));
    $('replayNext').onclick = () => attempt(() => position(Math.min(source.events.length, Number($('replayPosition').value) + 1)));
    $('exportReplay').onclick = () => attempt(() => {
      const blob = new Blob([session.exportReplay()], { type: 'application/json' });
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = 'tochki-replay.json'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    async function refresh(){
      collection = await storage.list();
      $('replayCollection').replaceChildren();
      collection.forEach(item => {
        const option = document.createElement('option');
        option.value = item.id; option.textContent = item.name + ' — ' + item.savedAt;
        $('replayCollection').appendChild(option);
      });
    }
    $('refreshReplays').onclick = refresh;
    $('saveReplay').onclick = async () => {
      try {
        const replay = JSON.parse(session.exportReplay());
        const id = await storage.put($('replayName').value || 'Партия', replay);
        if (id !== null) await refresh();
      } catch (e){ $('replayError').textContent = e.message; }
    };
    const selected = () => collection.find(item => String(item.id) === $('replayCollection').value);
    $('loadReplay').onclick = () => attempt(() => { const item = selected(); if (item) open(item.replay); });
    $('deleteReplay').onclick = async () => { const item = selected(); if (item){ await storage.remove(item.id); await refresh(); } };
    // Small single-slot autosave only; collections never go into localStorage.
    session.subscribe(() => {
      const text = JSON.stringify(session.getReplay());
      if (text === previous) return;
      previous = text;
      if (text.length <= 128 * 1024) storage.save('autosave', JSON.parse(text));
      else storage.save('autosave', null); // never restore an obsolete earlier position
    });
    refresh();
    return {
      restore(){
        const replay = storage.load('autosave');
        if (!replay) return false;
        try { open(replay); return true; }
        catch (e){ $('replayError').textContent = 'Автосохранение не восстановлено: ' + e.message; return false; }
      }
    };
  };
})(typeof self !== 'undefined' ? self : this);
