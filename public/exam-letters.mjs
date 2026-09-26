// One edit transaction; spaces in the stored answer preserve unfilled cells.
export function reduceBlankEdit(cells, index, text, { deletion = false } = {}) {
  const before = cells.map(value => /^[A-Za-z]$/.test(value || '') ? value : '');
  if (!Number.isInteger(index) || index < 0 || index >= before.length) return { valid: false };
  if (typeof text !== 'string' || (deletion ? text !== '' : !/^[A-Za-z]+$/.test(text)) || text.length > before.length - index) return { valid: false };
  const next = [...before], wasComplete = before.every(Boolean);
  if (deletion) next[index] = '';
  else [...text].forEach((value, offset) => { next[index + offset] = value; });
  const completed = !wasComplete && next.every(Boolean);
  const candidates = [...next.keys()].slice(index + text.length).concat([...next.keys()].slice(0, index));
  return { valid: true, cells: next, answer: next.map(value => value || ' ').join('').trimEnd(), completed,
    nextIndex: deletion || wasComplete || completed ? index : candidates.find(i => !next[i]) ?? index };
}
