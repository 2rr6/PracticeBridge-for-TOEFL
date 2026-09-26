import { esc } from './ui.mjs';

const doubts = { negation_difference: '否定词差异', number_difference: '数字或数字写法差异', name_difference: '专名或大写词差异', similar_adjacent_candidate: '相邻候选内容相似', text_difference: '文本差异', segment_outside_audio: '识别时间戳超出音频范围', possible_non_speech: '可能不是语音', empty_transcript: '没有识别文字' };
export function renderAsrComparison(evidence) {
  const state = evidence.retracted ? '已撤回 · 尚未核对' : evidence.historical?'历史证据 · 当前尚未核对':({ matched: '文本一致 · 仍是 ASR 证据', conflict: '存在差异 · 请核听', inconclusive: '无法确认 · 请核听', notChecked: '仅转写 · 尚未核对' }[evidence.state] || '尚未核对');
  const scope=evidence.sourceRange?`实际解码范围 ${esc(evidence.sourceRange.startSeconds)}–${esc(evidence.sourceRange.endSeconds)} 秒；${evidence.requestedRange?`请求范围 ${esc(evidence.requestedRange.startSeconds)}–${esc(evidence.requestedRange.endSeconds)} 秒；`:''}`:'';
  return `<section class="card asr-comparison"><h3>本地转写核对</h3><p class="notice">${state}</p><div class="fields-grid"><div><h4>参考原文</h4><p class="prewrap">${esc(evidence.reference || '未提供参考文本')}</p></div><div><h4>ASR 转写</h4><p class="prewrap">${esc(evidence.transcript || '没有识别文字')}</p></div></div><p class="hint">${(evidence.doubts || []).map(issue => esc(doubts[issue.code] || '需要核对')).join(' · ')}</p><p class="hint">${scope}原核对对应候选版本 ${esc(evidence.binding?.candidateRevision??evidence.candidateRevision)}。当前适用状态由音频映射、范围、参考文字及工作区版本共同核实；不提供发音分数。</p><button class="button tiny" data-retract-asr="${esc(evidence.evidenceId)}" ${evidence.retracted ? 'disabled' : ''}>撤回这条 ASR 证据</button></section>`;
}

/** onRetract must persist a guarded new candidate/evidence revision in the host. */
export function mountAsrComparison(container, evidence, { onRetract }) {
  container.innerHTML = renderAsrComparison(evidence);
  container.querySelector('[data-retract-asr]').onclick = async event => {
    const button = event.currentTarget; button.disabled = true;
    try { const updated = await onRetract(evidence); if (button.isConnected) mountAsrComparison(container, updated, { onRetract }); }
    catch (error) { if (button.isConnected) { button.disabled = false; container.querySelector('.notice').textContent = error.message; } }
  };
}
