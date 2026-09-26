// Shared by extraction and the source-only review component. Unknown future
// fields default to reference visibility until the host explicitly classifies them.
export function isReferenceField(path) {
  return !/^groups\.\d+\.(?:passage|questions\.\d+\.(?:prompt|sentenceFrame|options\.\d+\.text))$/.test(String(path));
}

export function hasReferenceMarker(text) {
  return /(?:^|\n)\s*(?:(?:Answer(?:\s+Key|s)?|Explanation|Rationale|Transcript|Hidden\s+Reference|Sample\s+(?:Answer|Response))\s*(?::|$)|(?:答案|参考答案|解析|参考转录)\s*[:：]?)/i.test(String(text));
}

export function isReferenceBlock(block) {
  return block.visibility === 'reference' || ['answer','explanation','transcript','hiddenReference','reference'].includes(block.role) || hasReferenceMarker(block.text);
}
