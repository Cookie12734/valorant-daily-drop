export function setupUpdates(request) {
  const $ = id => document.getElementById(id);
  const button = $('update-button'), dialog = $('update-dialog');
  let running = false, updating = false;
  const phases = { downloading: '最新版をダウンロードしています…', preparing: '更新ファイルを確認・展開しています…', restarting: '再起動しています…' };
  function render(state) {
    updating = Object.hasOwn(phases, state.phase);
    button.hidden = !state.release;
    button.textContent = updating ? 'アップデート中…' : 'アップデート';
    $('update-version').textContent = state.release ? `${state.currentVersion} → ${state.release.version} · ${state.release.name}` : `現在のバージョン：${state.currentVersion}`;
    $('update-notes').textContent = state.release?.notes ?? '';
    $('update-message').textContent = state.error || phases[state.phase] || (state.supported ? state.release ? '新しいバージョンを利用できます。' : '現在は最新版です。' : '自動更新はWindows配布版で利用できます。');
    $('update-install').disabled = updating || !state.supported || !state.release;
    $('update-check').disabled = updating;
    dialog.setAttribute('aria-busy', String(updating));
  }
  async function call(action) {
    if (running) return;
    running = true;
    $('update-check').disabled = true;
    if (action === 'install') $('update-install').disabled = true;
    try {
      const response = await request(`/api/update/${action}`, action === 'status' ? { signal: AbortSignal.timeout(20000) } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(20000) });
      const state = await response.json();
      if (!response.ok) throw new Error(state.error || '更新を確認できません。');
      render(state);
    } catch (error) {
      $('update-message').textContent = error.message;
      $('update-check').disabled = false;
      if (action === 'install') $('update-install').disabled = false;
    } finally { running = false; }
  }
  button.addEventListener('click', () => { dialog.showModal(); void call('check'); });
  $('update-check').addEventListener('click', () => void call('check'));
  $('update-install').addEventListener('click', () => void call('install'));
  void call('check');
  setInterval(() => { if (updating) void call('status'); }, 1000);
  setInterval(() => { if (!updating) void call('check'); }, 30 * 60 * 1000);
}
