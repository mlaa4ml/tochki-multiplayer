// Registration is separate from the game: an installation failure never blocks play.
(function(){
  'use strict';
  const panel = document.createElement('div');
  panel.setAttribute('role', 'status');
  document.body.prepend(panel);
  if (location.protocol === 'file:' || !window.isSecureContext || !('serviceWorker' in navigator)){
    panel.textContent = 'PWA недоступна: откройте игру по HTTPS или localhost. Через file:// автономная установка не поддерживается.';
    return;
  }
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) location.reload();
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => {
    function offerUpdate(){
      if (!reg.waiting || !navigator.serviceWorker.controller) return;
      panel.textContent = 'Доступна новая версия. Перезагрузка прервёт текущую партию. ';
      const button = document.createElement('button');
      button.textContent = 'Обновить и перезагрузить';
      button.onclick = () => {
        if (!reg.waiting) return;
        reloading = true;
        reg.waiting.postMessage('SKIP_WAITING');
      };
      panel.appendChild(button);
    }
    offerUpdate();
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      if (worker) worker.addEventListener('statechange', () => {
        if (worker.state === 'installed') offerUpdate();
      });
    });
    navigator.serviceWorker.ready.then(() => {
      if (!reg.waiting) panel.textContent = 'Игра сохранена для работы без сети в этом браузере.';
    });
  }).catch(err => {
    panel.textContent = 'Не удалось сохранить игру для работы без сети: ' + err.message;
  });
})();
