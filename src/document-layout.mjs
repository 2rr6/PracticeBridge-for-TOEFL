import { createHash } from 'node:crypto';
import {hasReferenceMarker,isReferenceBlock,isReferenceField} from '../public/document-source-policy.mjs';

const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 20);
const finite = value => Number.isFinite(value);
const normal = value => String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
const point = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const union = items => {
  const x = Math.min(...items.map(i => i.bounds.x)), y = Math.min(...items.map(i => i.bounds.y));
  return { x, y, width: Math.max(...items.map(i => i.bounds.x + i.bounds.width)) - x, height: Math.max(...items.map(i => i.bounds.y + i.bounds.height)) - y };
};
function bounds(item, transform) {
  const axis = item.transform || [1, 0, 0, 1];
  const scaleX = Math.hypot(axis[0], axis[1]) || 1, scaleY = Math.hypot(axis[2], axis[3]) || 1;
  const dx = [axis[0] / scaleX * item.width, axis[1] / scaleX * item.width];
  const dy = [axis[2] / scaleY * item.height, axis[3] / scaleY * item.height];
  const corners = [[item.x, item.y], [item.x + dx[0], item.y + dx[1]], [item.x + dy[0], item.y + dy[1]], [item.x + dx[0] + dy[0], item.y + dx[1] + dy[1]]].map(([x,y]) => point(transform, x, y));
  const x = Math.min(...corners.map(p => p[0])), y = Math.min(...corners.map(p => p[1]));
  return { x, y, width: Math.max(...corners.map(p => p[0])) - x, height: Math.max(...corners.map(p => p[1])) - y };
}
function joinRuns(runs) {
  let text = '', previous;
  for (const run of runs) {
    const gap = previous ? run.bounds.x - previous.bounds.x - previous.bounds.width : Infinity;
    const touching = /[\p{L}]$/u.test(text) && /^[\p{L}]/u.test(run.str) && gap >= -0.5 && gap <= 0.5;
    if (text && run.str && !/\s$/.test(text) && !/^\s/.test(run.str) && !touching) text += ' ';
    text += run.str; previous = run;
  }
  return text;
}

const rowSort = (a,b) => Math.abs(a.baseline-b.baseline)>3 ? a.baseline-b.baseline : a.bounds.x-b.bounds.x;
const numberCell = text => /^\d+[.)]?$/.test(text.trim());

// A gap already split into regions must not be silently undone downstream.
// Explicit number/answer rows can remain row-major across their cell gutters.
function projectedRows(blocks) {
  const rows=[];
  for(const block of blocks){
    const previous=rows.at(-1)?.at(-1),first=rows.at(-1)?.[0];
    const gap=previous?.bounds&&block.bounds ? block.bounds.x-previous.bounds.x-previous.bounds.width : Infinity;
    const sameRow=previous&&finite(block.baseline)&&finite(previous.baseline)&&Math.abs(previous.baseline-block.baseline)<=3&&previous.region===block.region&&gap>=-1;
    if(sameRow&&(gap<=Math.max(24,block.bounds.height*2)||numberCell(first.text)||first.tabular||/^(?:To|From|Date|Subject|Cc|Bcc):$/i.test(first.text.trim())))rows.at(-1).push(block);
    else rows.push([block]);
  }
  return rows;
}

function orderRegions(body,page,ambiguities) {
  const width=page.layout.width||Math.max(...body.map(b=>b.bounds.x+b.bounds.width),0);
  const spanning=body.filter(b=>b.bounds.width>width*.6&&!body.some(other=>other!==b&&Math.abs(other.baseline-b.baseline)<=3)).sort(rowSort);
  const tableHeader=body.find(b=>/^Type of Task$/i.test(b.text.trim())&&body.some(other=>/^Description$/i.test(other.text.trim())&&Math.abs(other.baseline-b.baseline)<=3));
  if(tableHeader){
    const end=spanning.find(b=>b.baseline>tableHeader.baseline)?.baseline??Infinity;
    for(const b of body)if(b.baseline>=tableHeader.baseline-3&&b.baseline<end)b.tabular=true;
  }
  let remaining=body.filter(b=>!spanning.includes(b));
  let band=0;
  const orderBand=blocks=>{
    const prefix=`band-${band++}`,byX=[...blocks].sort((a,b)=>a.bounds.x-b.bounds.x);
    if(blocks.some(b=>b.tabular)){for(const b of blocks)b.region=prefix;return blocks.sort(rowSort);}
    let split=null,largest=0;
    for(let i=2;i<=byX.length-2;i++){
      const left=byX.slice(0,i),right=byX.slice(i),edge=Math.max(...left.map(b=>b.bounds.x+b.bounds.width));
      const gap=right[0].bounds.x-edge;
      if(gap>Math.max(24,width*.045)&&gap>largest&&left.some(b=>b.text.trim().length>15)&&!left.every(b=>/^(?:\d+[.)]?|Question|Number|Answer)$/i.test(b.text.trim()))){split=[left,right];largest=gap;}
    }
    if(split)return split.flatMap((column,ci)=>column.sort(rowSort).map(b=>{b.region=`${prefix}-column-${ci+1}`;return b;}));
    const sorted=blocks.sort(rowSort);
    for(const b of sorted)b.region=prefix;
    for(let i=1;i<sorted.length;i++){
      const a=sorted[i-1],b=sorted[i];
      if(Math.abs(a.baseline-b.baseline)<=3&&b.bounds.x-a.bounds.x-a.bounds.width>Math.max(24,b.bounds.height*2)&&!numberCell(a.text)&&!(/^(?:Question|Number)$/i.test(a.text.trim())&&/^Answer$/i.test(b.text.trim())))
        ambiguities.push({code:'unresolved_regions',page:page.page,name:page.name,blockIds:[a.id,b.id],reason:'Separated text regions retained; reading order needs source review.'});
    }
    return sorted;
  };
  const ordered=[];
  for(const span of spanning){
    const before=remaining.filter(b=>b.baseline<span.baseline-3);
    remaining=remaining.filter(b=>!before.includes(b));
    ordered.push(...orderBand(before));span.region=`spanning-${band++}`;ordered.push(span);
    const overlaps=remaining.filter(b=>Math.abs(b.baseline-span.baseline)<=3);
    if(overlaps.length)ambiguities.push({code:'overlapping_regions',page:page.page,name:page.name,blockIds:[span.id,...overlaps.map(b=>b.id)],reason:'A spanning region overlaps another text region; verify against source.'});
  }
  return [...ordered,...orderBand(remaining)];
}

/** Pure, versioned view of evidence. rawPages and every original text run remain unchanged. */
export function projectDocumentLayout(rawPages, profile = {}) {
  const blocks = [], evidenceMap = {}, ambiguities = [], pageBlocks = [];
  for (const [chunkIndex, page] of rawPages.entries()) {
    const transform = page.layout?.transform || [1, 0, 0, -1, 0, page.layout?.height || 0];
    const items = page.layout?.items || [];
    const positioned = items.length && items.every(i => [i.x, i.y, i.width, i.height].every(finite));
    let lines;
    if (positioned) {
      const runs = items.map((item, index) => {
        const axis = item.transform || [1,0,0,1];
        const dx = transform[0]*axis[0]+transform[2]*axis[1], dy = transform[1]*axis[0]+transform[3]*axis[1];
        return { ...item, rawIndex: index, vertical: Math.abs(dy)>Math.abs(dx), baseline: point(transform,item.x,item.y)[1], bounds: bounds(item, transform) };
      });
      // Region segmentation happens BEFORE reading order: separate large gaps on
      // a baseline, so two columns are never joined into a single text line.
      const rows = [];
      for (const run of runs) {
        let row = profile.readingOrder === 'source' ? rows.find(row => run.line && row[0].line === run.line) : run.vertical ? null : rows.find(row => !row[0].vertical && Math.abs(row[0].baseline - run.baseline) <= 3);
        if (!row) rows.push(row = []);
        row.push(run);
      }
      lines = [];
      for (const row of rows) {
        if (profile.readingOrder !== 'source') row.sort((a,b) => a.bounds.x - b.bounds.x);
        let segment = [];
        for (const run of row) {
          const previous = segment.at(-1);
          if (previous && run.bounds.x - previous.bounds.x - previous.bounds.width > Math.max(24, run.bounds.height * 2)) { lines.push(segment); segment = []; }
          segment.push(run);
        }
        if (segment.length) lines.push(segment);
      }
      lines.sort((a,b) => Math.min(...a.map(i => i.rawIndex)) - Math.min(...b.map(i => i.rawIndex)));
    } else {
      lines = String(page.text || '').replace(/\r\n?/g, '\n').split('\n').map((str,index) => [{ str, rawLine: index + 1 }]).filter(line => line[0].str.trim());
    }
    const current = [];
    for (const line of lines) {
      const rawItemIndexes = line.map(i => i.rawIndex).filter(Number.isInteger);
      const rawLines = [...new Set(line.map(i => i.rawLine || i.line).filter(Number.isInteger))];
      const id = `block-${hash(JSON.stringify([page.name, page.page ?? null, chunkIndex, rawItemIndexes, rawLines]))}`;
      const block = { id, name: page.name, page: page.page ?? null, paragraph: page.paragraph ?? null, text: positioned ? joinRuns(line) : line[0].str,
        role: 'body', region: 'body', bounds: positioned ? union(line) : null, baseline: positioned ? line[0].baseline : null, layoutState: positioned ? 'projected' : 'unknown', chunkIndex };
      blocks.push(block); current.push(block);
      evidenceMap[id] = { name: page.name, page: page.page ?? null, paragraph: page.paragraph ?? null, chunkIndex, rawItemIndexes, rawLines, transform: positioned ? [...transform] : null, semantic: page.semantic || null, method: positioned ? 'pdf-text-layer' : page.kind === 'docx' ? 'docx-semantic' : 'source-text' };
    }
    pageBlocks.push(current);
  }
  const marginGroups = new Map();
  for (const block of blocks) {
    const page = rawPages[block.chunkIndex], b = block.bounds;
    if (!b || !page.layout?.height) continue;
    const role = b.y < page.layout.height * .07 ? 'header' : b.y > page.layout.height * .91 ? 'footer' : null;
    // Structural headings are meaningful even when repeated in the margin.
    if (!role || /(?:Section|Module|Question|Read |Listen |Fill in)/i.test(block.text)) continue;
    const key = `${block.name}|${role}|${normal(block.text).replace(/\d+/g, '#')}`;
    const list = marginGroups.get(key) || []; list.push({ block, role }); marginGroups.set(key, list);
  }
  const trailingNumber=block=>{const match=block.text.match(/\d+\s*$/);return match?Number(match[0]):null;};
  const tracksPages=(list,target)=>{
    const n=trailingNumber(target);if(n===null)return false;
    const same=list.filter(({block})=>trailingNumber(block)!==null&&trailingNumber(block)-block.page===n-target.page&&Math.abs((block.bounds.x+block.bounds.width)-(target.bounds.x+target.bounds.width))<=12);
    return new Set(same.map(({block})=>block.page)).size>=2;
  };
  const confirmedCounters=new Set([...marginGroups.values()].flatMap(list=>list.filter(({block})=>/^\d+$/.test(block.text.trim())&&tracksPages(list,block)).map(({block})=>block.id)));
  for (const list of marginGroups.values()) if (new Set(list.map(x => x.block.page)).size >= 2) for (const {block,role} of list) {
    // Repetition is a candidate signal, not permission to erase arbitrary prose.
    // Only bounded page labels and conventional document imprints are excluded.
    const pageLabel=/^(?:\d+|Page\s+\d+)$/i.test(block.text.trim())&&tracksPages(list,block);
    const titleLabel=/^(?:(?:Original|Practice|Sample|Mock)\s+(?:Workbook|Test)|(?:TOEFL\s+iBT[®™]?\s+)?(?:Teacher Resources\s*[–—-]\s*)?(?:Practice|Sample|Mock)\s+Test)\s+#?\d+(?:\s+\d+)?$/i.test(block.text.trim());
    const counter=pageBlocks[block.chunkIndex].some(b=>confirmedCounters.has(b.id)&&Math.abs(b.baseline-block.baseline)<=3);
    const label=pageLabel||(titleLabel&&(tracksPages(list,block)||counter))||/^(?:Copyright\s*(?:©\s*)?|©\s*)\d{4}\b.{0,180}$/i.test(block.text.trim());
    if (label) { block.role = role; block.region = role; }
    else ambiguities.push({ code: 'repeated_margin', blockId: block.id, reason: 'Repeated marginal text retained; its role is uncertain.' });
  }
  const readingOrder = [];
  for (const [index, current] of pageBlocks.entries()) {
    let body = current.filter(b => b.role === 'body');
    if (body.length > 0 && body.every(b => b.bounds) && profile.readingOrder !== 'source') {
      body = orderRegions(body,rawPages[index],ambiguities);
      if (rawPages[index].layout?.rotation) ambiguities.push({ code: 'rotated_page', page: rawPages[index].page, name: rawPages[index].name, reason: 'Coordinate transform retained; verify text orientation against source.' });
    }
    readingOrder.push(...body.map(b => b.id));
    const referencePage=body.some(b=>/^(?:Answer\s+Key|Transcript|参考答案|答案|转录)$/i.test(b.text.trim()));
    for(const b of current)b.visibility=referencePage||hasReferenceMarker(b.text)?'reference':'source';
    for(const row of projectedRows(body))for(const b of row)b.projectedRowId=row[0].id;
  }
  return { parserVersion: 'document-layout-2', blocks, readingOrder, evidenceMap, ambiguities };
}

export function projectDocumentChunks(rawPages, layout) {
  const index = new Map(layout.blocks.map(b => [b.id,b]));
  return rawPages.map((page, chunkIndex) => {
    const blocks = layout.readingOrder.map(id => index.get(id)).filter(b => b.chunkIndex === chunkIndex);
    // A block's text may itself contain line breaks; keep every per-line array
    // aligned with the projected text lines, not with layout rows.
    const lines = projectedRows(blocks).flatMap(row => row.map(b => b.text).join(' ').split('\n').map(text => ({ text, row })));
    return { ...page, text: lines.map(line => line.text).join('\n'), sourceBlockIds: lines.map(({ row }) => row.map(b => b.id)), sourceLineMap: lines.map(({ row }) => layout.evidenceMap[row[0].id].rawLines[0] || null), sourceLineX: lines.map(({ row }) => row[0].bounds ? Math.round(row[0].bounds.x) : null), parserVersion: layout.parserVersion };
  });
}

/** Extract semantic nodes, never HTML or fabricated Word page coordinates. */
export function projectDocxSemantics(document, name) {
  const chunks = [];
  const text = node => node.type === 'text' ? node.value : node.type === 'tab' ? '\t' : node.type === 'break' ? '\n' : (node.children || []).map(text).join(node.type === 'tableCell' ? '\n' : '');
  const visit = (node, path = []) => {
    if (node.type === 'paragraph') chunks.push({ name, text: text(node), paragraph: chunks.length + 1, kind: 'docx', layoutState: 'unknown', semantic: { kind: 'paragraph', path, styleId: node.styleId || null } });
    else if (node.type === 'table') for (const [rowIndex,row] of (node.children || []).entries()) {
      const cells = (row.children || []).map((cell,cellIndex) => ({ text: text(cell), path: [...path,rowIndex,cellIndex], colSpan: cell.colSpan || 1, rowSpan: cell.rowSpan || 1 }));
      chunks.push({ name, text: cells.map(c => c.text).join('\t'), paragraph: chunks.length + 1, kind: 'docx', layoutState: 'unknown', semantic: { kind: 'table-row', path: [...path,rowIndex], cells } });
    } else for (const [index,child] of (node.children || []).entries()) visit(child, [...path,index]);
  };
  visit(document); return chunks;
}

/** Matches are source-navigation evidence, not proof that an answer is correct. */
export function mapDocumentFields(pack, layout) {
  const result = [], byId = new Map(layout.blocks.map(b => [b.id,b]));
  const blocks = layout.readingOrder.map(id => byId.get(id));
  const documents = new Map();
  for (const block of blocks) {
    let document = documents.get(block.name);
    if (!document) documents.set(block.name, document = { text: '', spans: [] });
    const start = document.text.length; document.text += normal(block.text) + ' ';
    document.spans.push({start,end:document.text.length-1,id:block.id});
  }
  const add = (path,value,source,answer = false) => {
    const needle = normal(value);
    let matches = [],valueLocated=false,answerState='unmapped';
    if (needle && answer) {
      const ref = String(source || '').match(/(?:答案|转录)来自 (.+?) · 第 (\d+) 页 · 第 (\d+) 行/);
      if (ref) {
        const anchors = layout.blocks.filter(b => b.name === ref[1] && b.page === Number(ref[2]) && layout.evidenceMap[b.id].rawLines.includes(Number(ref[3])));
        // Table columns may be separate source-stream lines. Retain the whole
        // bounded projected row, including the answer cell, not only its number.
        const row=blocks.filter(b=>anchors.some(a=>b.id===a.id||(b.projectedRowId&&b.projectedRowId===a.projectedRowId)));
        const ids=row.map(b=>b.id);
        if (ids.length) {
          matches=[ids];answerState='referenced';
          // A row address proves only location. Literal scalar values can be
          // checked against a simple key row; generated option-ID permutations
          // require separate derivation evidence and remain merely referenced.
          if(typeof value==='string'||typeof value==='number'){
            const rowText=normal(row.map(b=>b.text).join(' '));
            const numbered=rowText.match(/^\d+[.)]?\s+(.+)$/);
            const literal=numbered?.[1]||rowText.replace(/^Answer\s*:\s*/i,'');
            valueLocated=literal===needle;
            answerState=valueLocated?'known':numbered?'conflict':'referenced';
          }
        }
      }
    } else if (needle) {
      const sourceName = blocks.find(b => source?.startsWith(b.name))?.name;
      const pool = sourceName ? blocks.filter(b => b.name === sourceName) : blocks;
      matches = pool.filter(b => normal(b.text).includes(needle)).map(b => [b.id]);
      if (!matches.length) {
        for (const [name,document] of documents) {
          if (sourceName && name !== sourceName) continue;
          let at = document.text.indexOf(needle), count = 0;
          while (at >= 0 && count++ < 100) {
            matches.push(document.spans.filter(s => s.end > at && s.start < at+needle.length).map(s => s.id));
            at = document.text.indexOf(needle, at+1);
          }
        }
      }
    }
    result.push({ path, state: answer ? answerState : matches.length === 1 ? 'known' : matches.length > 1 ? 'ambiguous' : 'missing', blockIds: [...new Set(matches.flat())], method: answer ? valueLocated?'literal-answer-row-match':'parser-source-reference' : 'literal-source-match', ...(answer?{valueLocated}:{}) });
  };
  for (const [gi,g] of (pack.groups || []).entries()) {
    add(`groups.${gi}.passage`,g.passage,g.questions?.[0]?.source);
    for (const [qi,q] of (g.questions || []).entries()) {
      const base = `groups.${gi}.questions.${qi}`;
      add(`${base}.prompt`,q.prompt,q.source);
      for (const [oi,o] of (q.options || []).entries()) add(`${base}.options.${oi}.text`,o.text,q.source);
      add(`${base}.answer`,q.answer,q.source,true); add(`${base}.explanation`,q.explanation,q.source);
    }
  }
  const referenceIds=new Set(blocks.filter(isReferenceBlock).map(b=>b.id));
  for(const entry of result)if(isReferenceField(entry.path))for(const id of entry.blockIds)referenceIds.add(id);
  for(const entry of result){
    entry.sourceReferences=entry.blockIds.map(blockId=>({blockId,visibility:referenceIds.has(blockId)?'reference':'source'}));
    entry.visibility=isReferenceField(entry.path)||(entry.sourceReferences.length&&entry.sourceReferences.every(r=>r.visibility==='reference'))?'reference':'source';
  }
  return result;
}
