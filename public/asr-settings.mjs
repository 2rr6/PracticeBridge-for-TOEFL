import { esc } from './ui.mjs';

export async function renderAsrSettings(container, { api }) {
  container.innerHTML = '<h2>可选本地转写</h2><p class="hint">正在读取本机配置…</p>';
  let initial;
  try { initial = await api('/asr'); } catch (error) { if (container.isConnected) container.textContent = error.message; return; }
  if (!container.isConnected) return;
  const c = initial.configuration || {};
  container.innerHTML = `<h2>可选本地转写</h2><p class="hint">独立 faster-whisper 环境。仅使用本地固定来源模型，不安装、不下载、不自动切换 CPU、精度或云端。识别结果用于可撤回的核对证据，不提供发音分数。</p><form data-asr-form>
    <label class="field"><span>Python 解释器完整路径</span><input type="text" name="interpreter" maxlength="1000" value="${esc(c.interpreter || '')}" placeholder="独立环境的 python.exe" required></label>
    <label class="field"><span>固定来源模型</span><select name="modelId"><option value="base">Systran base · 固定版本</option><option value="large-v3">Systran large-v3 · 固定版本</option></select></label>
    <label class="field"><span>本地模型目录</span><input type="text" name="modelDirectory" maxlength="1000" value="${esc(c.modelDirectory || '')}" required></label>
    <div class="fields-grid"><label class="field"><span>设备</span><select name="device"><option value="cpu">CPU</option><option value="cuda">NVIDIA GPU / CUDA</option></select></label><label class="field"><span>GPU 编号（CPU 留 0）</span><input name="deviceIndex" type="number" min="0" max="15" value="${c.deviceIndex || 0}"></label><label class="field"><span>精度（显式选择）</span><select name="computeType"><option value="int8_float32">int8_float32 · CPU</option><option value="float32">float32</option><option value="float16">float16 · GPU</option><option value="int8_float16">int8_float16 · GPU</option></select></label></div>
    <label class="field"><span>NVIDIA 运行库目录（每行一个，可留空）</span><textarea name="dllDirectories" rows="3" maxlength="5000">${esc((c.dllDirectories || []).join('\n'))}</textarea><small>所需库由独立环境版本决定；当前适配器要求 faster-whisper 1.2.1 / CTranslate2 4.8.2 / PyAV 18.1.0。GPU 需兼容的 CUDA 12 cuBLAS 与 cuDNN 9。</small></label>
    <label class="hint"><input name="confirmed" type="checkbox" required> 我确认以上是本机可信解释器、固定来源模型和运行库；只授权本次配置。</label>
    <p data-asr-dirty role="status" class="hint"></p><pre data-asr-saved class="hint prewrap"></pre>
    <div class="button-row mt"><button class="button" type="submit">保存／重新选择配置</button><button class="button primary" type="button" data-asr-test>实际自检</button><button class="button" type="button" data-asr-cancel>取消</button><button class="button" type="button" data-asr-disable>停用</button></div></form><p data-asr-status role="status" class="notice"></p><pre data-asr-actual class="hint prewrap"></pre><p class="hint">自检使用一秒本地产生的静音，只证明能实际执行；准确性需要另用音频核听。未验证操作系统网络隔离。</p>`;
  const form = container.querySelector('form');
  let requestVersion = 0, pollTimer, saving = false, lastStatus = initial;
  const stateLabels = { disabled: '已停用', configured: '已配置', testing: '正在自检', ready: '本机可运行', unavailable: '当前不可用', unconfirmed: '待确认' };
  for (const key of ['modelId', 'device', 'computeType']) if (c[key]) form.elements[key].value = c[key];
  form.elements.confirmed.checked = c.confirmed === true;
  const formConfiguration = () => { const data = Object.fromEntries(new FormData(form)); data.deviceIndex = Number(data.deviceIndex); data.dllDirectories = data.dllDirectories.split(/\r?\n/).map(value => value.trim()).filter(Boolean); data.confirmed = form.elements.confirmed.checked; return data; };
  const configurationKey = config => JSON.stringify(['interpreter', 'modelId', 'modelDirectory', 'device', 'deviceIndex', 'computeType', 'dllDirectories', 'confirmed'].map(key => config?.[key]));
  const dirty = () => configurationKey(formConfiguration()) !== configurationKey(lastStatus.configuration);
  const updateControls = () => {
    const changed = dirty(), saved = lastStatus.configuration;
    container.querySelector('[data-asr-dirty]').textContent = saving ? '正在保存提交时的配置；保存期间的新编辑仍须再次保存。' : changed ? '表单有未保存的更改，请先保存，再运行实际自检。' : '表单与已保存配置一致；实际自检使用下列已保存目标。';
    container.querySelector('[data-asr-saved]').textContent = saved ? `已保存的自检目标：${saved.modelId} · ${saved.device} / ${saved.deviceIndex} · ${saved.computeType}\n模型目录：${saved.modelDirectory}\n解释器：${saved.interpreter}\n运行库目录：${saved.dllDirectories.join('；') || '无'}\n本次授权：${saved.confirmed ? '已确认' : '未确认或已停用'}` : '尚无已保存的自检目标。';
    container.querySelector('[data-asr-test]').disabled = saving || changed || lastStatus.running || !saved?.confirmed;
    form.querySelector('[type=submit]').disabled = saving;
    container.querySelector('[data-asr-cancel]').disabled = !lastStatus.running;
  };
  form.addEventListener('input', updateControls);
  form.addEventListener('change', updateControls);
  const show = (status, version = requestVersion) => {
    if (!container.isConnected || version !== requestVersion) return;
    lastStatus = status;
    container.querySelector('[data-asr-status]').dataset.state = status.state;
    container.querySelector('[data-asr-status]').textContent = `${stateLabels[status.state] || '待检查'} · ${status.detail}`;
    container.querySelector('[data-asr-actual]').textContent = status.result?.actual ? `实际引擎：${status.result.actual.engine}\n实际设备：${status.result.actual.device} / ${JSON.stringify(status.result.actual.deviceIndex)}\n实际精度：${status.result.actual.computeType}\n模型：${status.result.actual.modelId}\n完整推理耗时：${status.result.elapsedSeconds} 秒\n样本：合成静音；不是准确率或发音评分` : '';
    updateControls();
    clearTimeout(pollTimer);
    if (status.running) pollTimer = setTimeout(async () => { if (!container.isConnected || version !== requestVersion) return; try { show(await api('/asr'), version); } catch (error) { if (container.isConnected && version === requestVersion) container.querySelector('[data-asr-status]').textContent = error.message; } }, 1000);
  };
  const action = async (endpoint, data = {}) => { const version = ++requestVersion; clearTimeout(pollTimer); try { const status = await api(endpoint, data); show(status, version); if (container.isConnected && version === requestVersion) return status; } catch (error) { if (container.isConnected && version === requestVersion) container.querySelector('[data-asr-status]').textContent = error.message; } };
  form.onsubmit = async event => {
    event.preventDefault(); if (saving) return;
    const data = formConfiguration(); saving = true; updateControls();
    try {
      const status = await action('/asr/configure', data);
      // Adopt canonical host paths only if no newer edit replaced this submission.
      if (status?.configuration && configurationKey(formConfiguration()) === configurationKey(data)) {
        for (const [key, value] of Object.entries(status.configuration)) {
          if (key === 'confirmed') form.elements[key].checked = value;
          else form.elements[key].value = key === 'dllDirectories' ? value.join('\n') : value;
        }
      }
    } finally { saving = false; if (container.isConnected) updateControls(); }
  };
  container.querySelector('[data-asr-test]').onclick = () => { if (!saving && !dirty() && !lastStatus.running && lastStatus.configuration?.confirmed) return action('/asr/test'); };
  container.querySelector('[data-asr-cancel]').onclick = () => action('/asr/cancel');
  container.querySelector('[data-asr-disable]').onclick = () => action('/asr/disable');
  show(initial);
}
