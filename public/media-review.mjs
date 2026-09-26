const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export function mediaEvidenceLabel(evidence = {}) {
  const decode = ({ playable: '格式可播放', partial: '音频不完整', failed: '格式无法播放', notChecked: '格式尚未检查' })[evidence.decodeState] || '格式尚未检查';
  const matched=evidence.contentCheckMethod==='asr-text-comparison-v1'?'ASR 文本一致 · 待人工核听':evidence.contentCheckMethod==='user-review'?'人工已确认对应内容':'内容已核对';
  const content = ({ matched, conflict: '对应内容有冲突', inconclusive: '对应关系无法确认', notChecked: '内容尚未核对' })[evidence.contentCheckState] || '内容尚未核对';
  return `${decode} · ${content}`;
}

export function renderMediaMappingSummary(items = []) {
  const basis = { explicitRef: '明确引用', filename: '文件名配对', sequence: '同一范围内按顺序配对', user: '人工修正', content: '内容核对' };
  return `<div class="media-mapping-summary">${items.map(item => `<div class="media-mapping-row" data-state="${escapeHtml(item.mappingState || 'proposed')}"><strong>${escapeHtml(item.targetLabel || item.targetId || '媒体位置')}</strong><span>${item.assetName ? escapeHtml(item.assetName) : '尚未配对'}</span><span>${escapeHtml(basis[item.mappingBasis] || '尚无依据')}</span><span>${escapeHtml(mediaEvidenceLabel(item))}</span></div>`).join('')}</div>`;
}
