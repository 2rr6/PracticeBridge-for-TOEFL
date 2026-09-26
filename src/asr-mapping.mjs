import crypto from 'node:crypto';

const tokens = text => String(text).normalize('NFKC').toLowerCase().replace(/[’]/g, "'").match(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu) || [];
const normalized = text => tokens(text).join(' ');
const NEGATION = /^(?:no|not|never|neither|nor|without|cannot|\w+n't)$/;
const NUMBER = /^(?:\d+(?:\.\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million)$/;
// Retain complete non-letter runs containing a number, including unfamiliar
// symbols and spaced modifiers. Enumerating known signs silently drops the
// next unrecognized sign. Only trailing sentence punctuation is discarded;
// internal separators, leading signs, brackets and unknown modifiers remain
// literal evidence. This is deliberately not locale/value interpretation.
const numericExpressions = text => JSON.stringify((String(text).normalize('NFKC').match(/[^\p{L}]+/gu) || [])
  .filter(value => /\p{N}/u.test(value))
  .map(value => value.trim().replace(/[.!?,;:]+$/, '').trim().replace(/\s+/g, ' ')));
const selected = (text, pattern) => tokens(text).filter(token => pattern.test(token)).join(' ');
const similarity = (a, b) => { const aa = new Set(tokens(a)), bb = new Set(tokens(b)); return [...aa].filter(x => bb.has(x)).length / Math.max(1, new Set([...aa, ...bb]).size); };

/** Conservative text comparison, not an ASR accuracy or pronunciation score. */
export function compareAsrEvidence({ assetId, targetId, candidateRevision, transcript, reference = null, adjacentReferences = [], properNames = [], asrIssues = [{ code: 'engine_evidence_unchecked' }] }) {
  if (!/^[a-f0-9]{64}$/.test(assetId) || typeof targetId !== 'string' || !targetId || targetId.length > 200 || !Number.isInteger(candidateRevision) || candidateRevision < 0 || typeof transcript !== 'string' || transcript.length > 200000 || (reference !== null && (typeof reference !== 'string' || reference.length > 200000)) || !Array.isArray(adjacentReferences) || adjacentReferences.length > 20 || adjacentReferences.some(x => typeof x !== 'string' || x.length > 200000) || !Array.isArray(properNames) || properNames.length > 100 || properNames.some(x => typeof x !== 'string' || x.length > 200)) throw new TypeError('ASR comparison relation is invalid.');
  if (!Array.isArray(asrIssues) || asrIssues.length > 100 || asrIssues.some(issue => !issue || !['segment_outside_audio', 'possible_non_speech', 'empty_transcript', 'engine_evidence_unchecked'].includes(issue.code))) throw new TypeError('ASR engine issues are invalid.');
  const item = { evidenceId: crypto.randomUUID(), assetId, targetId, candidateRevision, reference, transcript, method: 'asr-text-comparison-v1', kind: 'transcribed', state: 'notChecked', doubts: asrIssues.map(issue => ({ code: issue.code })), retracted: false };
  if (!reference?.trim()) return item;
  item.kind = 'comparison';
  const same = normalized(reference) === normalized(transcript);
  item.state = same && normalized(transcript) ? 'matched' : 'inconclusive';
  if (selected(reference, NEGATION) !== selected(transcript, NEGATION)) item.doubts.push({ code: 'negation_difference' });
  if (numericExpressions(reference) !== numericExpressions(transcript) || selected(reference, NUMBER) !== selected(transcript, NUMBER)) item.doubts.push({ code: 'number_difference' });
  // Capitalized terms are only name suspects; retain the original text for human review.
  const nameSuspects = [...new Set([...properNames, ...(reference.match(/\b[A-Z][a-z]{1,}\b/g) || []), ...(transcript.match(/\b[A-Z][a-z]{1,}\b/g) || [])])].filter(x => !['The','This','That','There','I','We','It','He','She','They','A','An'].includes(x));
  if (nameSuspects.some(name => normalized(reference).includes(normalized(name)) !== normalized(transcript).includes(normalized(name)))) item.doubts.push({ code: 'name_difference' });
  if (item.doubts.some(issue => ['negation_difference', 'number_difference', 'name_difference'].includes(issue.code))) item.state = 'conflict';
  else if (!same) item.doubts.push({ code: 'text_difference' });
  if (adjacentReferences.some(text => similarity(text, transcript) >= 0.8)) { item.doubts.push({ code: 'similar_adjacent_candidate' }); if (item.state !== 'conflict') item.state = 'inconclusive'; }
  if (asrIssues.length || !transcript.trim()) item.state = 'inconclusive';
  return item;
}

export function retractAsrEvidence(evidence) { return { ...structuredClone(evidence), state: 'notChecked', retracted: true }; }
