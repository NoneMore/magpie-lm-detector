(() => {
  const $ = id => document.getElementById(id);
  let models = [], jobId = null, timer = null, currentJob = null;
  const opt = (text, value) => { const o = document.createElement('option'); o.textContent = text; o.value = value; return o; };
  const errText = error => String(error?.message || error);
  const number = (v, suffix = '') => typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) + suffix : '—';

  async function api(url, body) {
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-LMFPD-Console': '1' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let data;
    try { data = await response.json(); } catch { throw Error('服务端没有返回有效 JSON。'); }
    if (!response.ok) throw Error(data?.error || `HTTP ${response.status}`);
    return data;
  }
  function message(text, kind = '') { $('status').className = 'status ' + kind; $('status').textContent = text; }
  function locked(active) {
    for (const id of ['provider','model','api','effort','count','parallel','repeat','timeout','stream','strict']) $(id).disabled = active;
    $('run').disabled = active || !models.length;
    $('cancel').hidden = !active;
  }
  function fillModels() {
    const previous = $('provider').value;
    const providerNames = [...new Set(models.map(m => m.split('/')[0]))].sort();
    $('provider').replaceChildren(...providerNames.map(x => opt(x, x)));
    if (providerNames.includes(previous)) $('provider').value = previous;
    chooseProvider();
  }
  function chooseProvider() {
    const selected = $('model').value;
    const prefix = $('provider').value + '/';
    const matching = models.filter(m => m.startsWith(prefix));
    $('model').replaceChildren(...matching.map(m => opt(m.slice(prefix.length), m)));
    if (matching.includes(selected)) $('model').value = selected;
    $('run').disabled = !!jobId || !matching.length;
  }
  function syncParallel() {
    const n = Number($('count').value), old = Number($('parallel').value);
    $('parallel').replaceChildren(...Array.from({ length: n }, (_, i) => opt(String(i + 1), String(i + 1))));
    $('parallel').value = String(Math.min(old || n, n));
    $('strict').disabled = n !== 3;
    if (n !== 3) $('strict').checked = false;
  }
  async function modelsReload() {
    message('正在从 Gateway 读取模型…');
    try {
      const data = await api('/api/models');
      models = data.models;
      fillModels();
      message(models.length ? `已读取 ${models.length} 个模型。` : 'Gateway 没有可检测的具体模型。', models.length ? 'good' : '');
    } catch (e) { models = []; fillModels(); message('读取模型失败：' + errText(e), 'error'); }
  }
  function renderHistory(list) {
    const root = $('history');
    root.replaceChildren();
    if (!list.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = '尚无检测记录'; root.append(p); return; }
    for (const j of list.slice(0, 12)) {
      const b = document.createElement('button');
      const title = document.createElement('span'); title.textContent = j.model;
      const detail = document.createElement('span'); detail.textContent = `${j.state} · ${new Date(j.startedAt).toLocaleString()}`;
      b.append(title, detail);
      b.addEventListener('click', () => { currentJob = j; jobId = j.state === 'running' ? j.jobId : null; draw(j); if (jobId) watch(); });
      root.append(b);
    }
  }
  function renderProgress(j) {
    $('progressSection').hidden = false;
    const total = j.count * j.repeat;
    const done = Math.min(total, j.completed);
    $('progress').value = 100 * done / total;
    $('progressLabel').textContent = `第 ${j.round || 0}/${j.repeat} 轮 · 已完成 ${done}/${total} 次请求`;
    const root = $('sampleProgress'); root.replaceChildren();
    if (j.state === 'running') {
      const e = document.createElement('p'); e.className = 'muted';
      e.textContent = j.round ? `第 ${j.round} 轮采样中（等待 SDK 返回本轮结果）…` : '正在加载 SDK 参考数据…';
      root.append(e);
    }
    for (const r of j.rounds) {
      const e = document.createElement('div'); e.className = 'sample-item';
      const accepted = r.samples.filter(s => s.state === 'complete' || s.state === 'truncated').length;
      const hint = document.createElement('span'); hint.textContent = `第 ${r.round} 轮：${accepted}/${r.samples.length} 条有效样本`;
      const outcome = document.createElement('span'); outcome.textContent = r.analysis?.prediction_name || r.analysis?.prediction || r.error || '未评分';
      e.append(hint, outcome); root.append(e);
    }
  }
  function renderRound(index) {
    const r = currentJob?.rounds?.[index]; if (!r) return;
    const a = r.analysis;
    $('winner').textContent = a?.prediction_name || a?.prediction || '本轮未评分';
    $('winnerNote').textContent = a?.evidence?.reason || r.error || '无可用排名';
    $('roundMessage').textContent = `第 ${r.round} 轮 · 有效回答 ${a?.used_outputs ?? 0}/${currentJob.count} · 决策：${a?.decision || '无'}。仅在完整有效评分且校准匹配时显示概率。`;
    const anomalies = r.samples.filter(x => x.minimumValidNumber != null && x.minimumValidNumber >= 200);
    $('distributionWarning').hidden = !anomalies.length;
    $('distributionWarning').textContent = anomalies.length ? `样本 ${anomalies.map(x => x.index).join('、')} 的最小有效整数不低于 200，数字分布异常；建议重新检测核验。` : '';
    const root = $('results'); root.replaceChildren();
    for (const item of (a?.results || []).slice(0, 15)) {
      const tr = document.createElement('tr'), name = document.createElement('td'), prob = document.createElement('td'), score = document.createElement('td');
      name.textContent = item.display_name || item.model || '—'; prob.className = 'num'; score.className = 'num';
      if (typeof item.probability === 'number') {
        const bar = document.createElement('span'), fill = document.createElement('i');
        bar.className = 'bar'; fill.style.width = `${Math.min(100, Math.max(0, item.probability * 100))}%`;
        bar.append(fill); prob.append(bar, document.createTextNode((item.probability * 100).toFixed(1) + '%'));
      } else prob.textContent = '—';
      score.textContent = number(item.score);
      tr.append(name, prob, score); root.append(tr);
    }
    $('diagnostics').textContent = JSON.stringify({ request: currentJob ? {
      model: currentJob.model, api: currentJob.api, strict: currentJob.strict,
      count: currentJob.count, parallel: currentJob.parallel, repeat: currentJob.repeat,
    } : {}, ...r }, null, 2);
  }
  function draw(j) {
    currentJob = j;
    locked(j.state === 'running');
    renderProgress(j);
    $('resultSection').hidden = !j.rounds.length;
    if (j.rounds.length) {
      const old = $('roundResult').value, selected = Number(old);
      $('roundResult').replaceChildren(...j.rounds.map((r, i) => opt(`第 ${r.round} 轮`, String(i))));
      const idx = Number.isInteger(selected) && selected >= 0 && selected < j.rounds.length ? selected : j.rounds.length - 1;
      $('roundResult').value = String(idx);
      renderRound(idx);
    }
    if (j.state === 'running') message(`检测中：第 ${j.round || 1}/${j.repeat} 轮 · 完成 ${j.completed}/${j.count * j.repeat} 条`, '');
    else if (j.state === 'cancelled') message('检测已取消。');
    else if (j.state === 'done') message('检测完成，可以查看每一轮的排名。', 'good');
    else message('检测未成功：' + (j.error || '没有可评分结果'), 'error');
  }
  async function watch() {
    clearTimeout(timer);
    if (!jobId) return;
    const id = jobId;
    try {
      const j = await api('/api/jobs/' + id);
      if (jobId !== id) return;
      draw(j);
      if (j.state === 'running') timer = setTimeout(watch, 1500);
      else { jobId = null; locked(false); refreshHistory(); }
    } catch (e) {
      jobId = null; locked(false); message('读取检测任务失败：' + errText(e), 'error');
    }
  }
  async function refreshHistory() {
    try { const data = await api('/api/state'); renderHistory(data.jobs); }
    catch (e) { message('无法读取任务记录：' + errText(e), 'error'); }
  }
  async function begin() {
    if (jobId || !$('model').value) return;
    const params = {
      model: $('model').value, api: $('api').value, stream: $('stream').checked,
      effort: $('effort').value.trim(), count: Number($('count').value),
      parallel: Number($('parallel').value), repeat: Number($('repeat').value),
      timeout: Number($('timeout').value), strict: $('strict').checked,
    };
    $('run').disabled = true;
    try {
      const j = await api('/api/jobs', params);
      jobId = j.jobId;
      $('roundResult').value = '';
      $('resultSection').hidden = true;
      draw(j);
      await refreshHistory();
      watch();
    } catch (e) { message('无法开始检测：' + errText(e), 'error'); locked(false); }
  }
  async function cancel() {
    if (!jobId) return;
    const id = jobId;
    $('cancel').disabled = true;
    try { draw(await api('/api/jobs/' + id + '/cancel', {})); jobId = null; locked(false); await refreshHistory(); }
    catch (e) { message('取消任务失败：' + errText(e), 'error'); }
    finally { $('cancel').disabled = false; }
  }
  async function saveGateway() {
    try {
      const data = await api('/api/config', { gatewayUrl: $('gateway').value.trim(), gatewayKey: $('gatewayKey').value });
      $('gatewayKey').value = '';
      $('gatewayInfo').textContent = data.config.hasGatewayKey ? 'Key 已安全保存' : '';
      await modelsReload();
    } catch (e) { message('保存失败：' + errText(e), 'error'); }
  }
  async function boot() {
    $('provider').addEventListener('change', chooseProvider);
    $('count').addEventListener('change', syncParallel);
    $('run').addEventListener('click', begin);
    $('cancel').addEventListener('click', cancel);
    $('reload').addEventListener('click', modelsReload);
    $('saveGateway').addEventListener('click', saveGateway);
    $('roundResult').addEventListener('change', () => renderRound(Number($('roundResult').value)));
    syncParallel();
    try {
      const data = await api('/api/state');
      $('gateway').value = data.config.gatewayUrl || 'http://127.0.0.1:3425/v1';
      $('gatewayInfo').textContent = data.config.hasGatewayKey ? 'Key 已配置；留空表示不更换' : '请输入 Gateway Key';
      renderHistory(data.jobs);
      const running = data.jobs.find(j => j.state === 'running');
      if (running) { jobId = running.jobId; watch(); }
      else if (data.jobs.length) draw(data.jobs[0]);
      await modelsReload();
    } catch (e) { message('无法初始化控制台：' + errText(e), 'error'); }
    api('/api/reference').then(data => { $('bank').textContent = '参考库：' + data.builtAt; }).catch(e => {
      $('bank').textContent = '参考数据尚不可用（联网或设置 LMFPD_DATA_SOURCE）';
    });
  }
  boot();
})();
