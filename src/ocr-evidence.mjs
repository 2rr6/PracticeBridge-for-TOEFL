const normal=s=>String(s||'').replace(/\s+/g,' ').trim();
export function reliableTextRegion({text,items,imageIntersects=false}={}){
  return !imageIntersects&&Array.isArray(items)&&items.length>0&&items.every(i=>i.visible===true)&&normal(text).length>=16&&!/[\ufffd\u0000-\u0008]/.test(text)&&/[A-Za-z]{2}/.test(text);
}
export function compareOcrEvidence(textLayer,ocrText){
  const issues=[];
  if(normal(textLayer)&&normal(textLayer)!==normal(ocrText)){
    issues.push({code:'text_ocr_disagreement',reason:'文字层和图像识别不同，需要对照原图。'});
    const neg=s=>(s.match(/\b(?:not|no|never|except|without)\b/gi)||[]).map(x=>x.toLowerCase()).join('|');
    if(neg(textLayer)!==neg(ocrText))issues.push({code:'critical_negation_conflict',reason:'否定或排除词不同，不能自动决定题意。'});
    if((textLayer.match(/_/g)||[]).length!==(ocrText.match(/_/g)||[]).length)issues.push({code:'blank_anchor_conflict',reason:'补字空格数不同，不能恢复精确补字交互。'});
    if((textLayer.match(/\d+/g)||[]).join('|')!==(ocrText.match(/\d+/g)||[]).join('|'))issues.push({code:'number_conflict',reason:'题号或数字不同，需要核对。'});
  }
  return {textLayer,ocrText,preferred:null,issues};
}
export function projectOcrEvidence({data,source,engine,textLayer=''}={}){
  const text=String(data?.text||'');const words=[];let line=-1;
  for(const b of data?.blocks||[])for(const p of b.paragraphs||[])for(const l of p.lines||[]){line++;for(const w of l.words||[]){
    const bb=w.bbox;if(!bb||!['x0','y0','x1','y1'].every(k=>Number.isFinite(bb[k]))||bb.x0<0||bb.y0<0||bb.x1>source.width+1||bb.y1>source.height+1||bb.x1<bb.x0||bb.y1<bb.y0)continue;
    words.push({text:String(w.text||''),confidence:Number.isFinite(w.confidence)?w.confidence:null,bbox:{x0:bb.x0,y0:bb.y0,x1:bb.x1,y1:bb.y1},line});
  }}
  const comparison=compareOcrEvidence(textLayer,text);const issues=[...comparison.issues];
  if(!text.trim())issues.push({code:'ocr_empty',reason:'识别正常结束但没有读到文字，未恢复题目。'});
  else if(!words.length)issues.push({code:'ocr_word_boxes_missing',reason:'没有可靠词框，需核对完整题界。'});
  if(Number.isFinite(data?.confidence)&&data.confidence<85)issues.push({code:'ocr_low_confidence',reason:'识别置信度偏低；置信度不是准确率。'});
  if(/_/.test(text))issues.push({code:'blank_anchor_requires_review',reason:'OCR 不建立原始 UTF-16 补字锚点，格数必须人工核对。'});
  return {version:1,kind:'ocr-evidence',state:text.trim()?'needs_review':'empty',text,words,confidence:Number.isFinite(data?.confidence)?data.confidence:null,source,engine:{...engine,engineVersion:typeof data?.version==='string'?data.version:null},comparison,issues,answerVerified:false};
}
