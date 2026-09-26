import {isReferenceBlock,isReferenceField} from './document-source-policy.mjs';

// Before reference opt-in, show only literal text already present in the
// selected visible field. Legacy/unclassified blocks cannot leak extra tails.
function selectedSourceSnippets(blocks,value) {
  const words=String(value??'').trim().split(/\s+/).filter(Boolean),snippets=new Map();
  if(!words.length)return snippets;
  const escape=text=>text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const expression=new RegExp(words.map(escape).join('\\s+'),'g');
  let text='';const spans=[];
  for(const block of blocks){const start=text.length;text+=block.text;spans.push({block,start,end:text.length});text+='\n';}
  let count=0;
  for(const match of text.matchAll(expression)){
    if(count++>=100)break;
    for(const span of spans){
      const start=Math.max(span.start,match.index),end=Math.min(span.end,match.index+match[0].length);
      if(start<end){const fragments=snippets.get(span.block.id)||[];fragments.push(text.slice(start,end));snippets.set(span.block.id,fragments);}
    }
  }
  return new Map([...snippets].map(([id,parts])=>[id,[...new Set(parts)].join('\n…\n')]));
}

/** Standalone source reviewer. Pass persisted extraction artifacts, not source HTML.
 * The host owns the author-mode decision; the component defaults to student mode.
 */
export function mountDocumentSourceReview(root, draft, { author = false } = {}) {
  const doc = root.ownerDocument;
  const node = (tag,text) => { const el=doc.createElement(tag);if(text!==undefined)el.textContent=text;return el; };
  root.replaceChildren();
  if(!author){root.append(node('p','来源校对在作者视图中开放，可能包含题面与答案。'));return;}
  const title=node('h3','字段与原始来源对照');
  const notice=node('p','来源定位用于核对提取结果；匹配成功不表示答案正确。未展开参考内容时，仅显示与所选字段一致的原文片段。原件保持不变。');
  const label=node('label'),toggle=node('input');toggle.type='checkbox';label.append(toggle,doc.createTextNode('展开答案来源（会剧透）'));
  const columns=node('div');Object.assign(columns.style,{display:'grid',gridTemplateColumns:'repeat(auto-fit, minmax(min(100%, 300px), 1fr))',gap:'16px'});
  const fields=node('section'),source=node('section');source.dataset.sourcePane='';source.setAttribute('aria-live','polite');
  Object.assign(source.style,{whiteSpace:'pre-wrap',overflowWrap:'anywhere',minWidth:'0',border:'1px solid #888',padding:'12px'});
  Object.assign(fields.style,{minWidth:'0',overflowWrap:'anywhere'});columns.append(fields,source);root.append(title,notice,label,columns);
  const blocks=new Map((draft.documentLayout?.blocks||[]).map(b=>[b.id,b]));
  const referenceIds=new Set([...blocks.values()].filter(isReferenceBlock).map(b=>b.id));
  const isSensitive=entry=>entry.visibility==='reference'||isReferenceField(entry.path);
  for(const entry of draft.fieldEvidence||[]){
    if(isSensitive(entry))for(const id of entry.blockIds||[])referenceIds.add(id);
    for(const ref of entry.sourceReferences||[])if(ref.visibility==='reference')referenceIds.add(ref.blockId);
  }
  const valueAt=path=>path.split('.').reduce((value,key)=>value?.[key],draft.pack);
  const labels={passage:'共享文章',prompt:'题干',answer:'答案',explanation:'解释',text:'选项'};
  const render=()=>{
    fields.replaceChildren();source.replaceChildren(node('p','选择左侧字段，查看对应的原始文字。'));
    for(const entry of draft.fieldEvidence||[]){
      const sensitive=isSensitive(entry);
      if(sensitive&&!toggle.checked)continue;
      const parts=entry.path.split('.'),group=Number(parts[1])+1,question=parts[2]==='questions'?Number(parts[3])+1:null;
      const button=node('button',`题组 ${group}${question?` · 第 ${question} 题`:''} · ${labels[parts.at(-1)]||'字段'}${parts[4]==='options'?` ${Number(parts[5])+1}`:''}`);button.type='button';button.dataset.sourceField=entry.path;button.className='button tiny';
      Object.assign(button.style,{display:'block',maxWidth:'100%',whiteSpace:'normal',overflowWrap:'anywhere',margin:'8px 0'});
      const value=node('p',String(valueAt(entry.path)??'未提供'));fields.append(button,value);
      button.onclick=()=>{
        source.replaceChildren(node('p',entry.state==='conflict'?'所填值与引用行冲突，请对照原件。':entry.state==='referenced'?'已定位引用，尚未证明字段值与来源一致。':entry.state==='ambiguous'?'有多个可能来源，请逐一核对。':entry.blockIds?.length?'原始提取文字':'没有可确认的文字来源，请对照原件。'));
        const referenced=(entry.blockIds||[]).map(id=>blocks.get(id)).filter(Boolean);
        const visible=toggle.checked?referenced:referenced.filter(b=>!referenceIds.has(b.id));
        const snippets=toggle.checked?new Map(visible.map(b=>[b.id,b.text])):selectedSourceSnippets(visible,valueAt(entry.path));
        if(visible.length<referenced.length)source.append(node('p','部分来源包含答案或参考内容，已隐藏。'));
        if(visible.length&&!snippets.size)source.append(node('p','未定位到可单独展示的原文字段片段；展开参考来源后可核对完整块。'));
        for(const block of visible){
          if(!snippets.has(block.id))continue;
          const location=`${block.name}${block.page!=null?` · 第 ${block.page} 页`:block.paragraph!=null?` · 第 ${block.paragraph} 段`:''}${block.layoutState==='unknown'?' · 分页与精确布局未知':''}`;
          source.append(node('h4',location),node('p',snippets.get(block.id)));
        }
      };
    }
  };
  toggle.onchange=render;render();
}
