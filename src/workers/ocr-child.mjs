import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { hash, OCR_LIMITS } from '../ocr-policy.mjs';
import { reliableTextRegion } from '../ocr-evidence.mjs';
import {verifyOcrLaunchSpec,assertOcrLaunchModule} from '../ocr-launch.mjs';

const multiply=(a,b)=>[a[0]*b[0]+a[2]*b[1],a[1]*b[0]+a[3]*b[1],a[0]*b[2]+a[2]*b[3],a[1]*b[2]+a[3]*b[3],a[0]*b[4]+a[2]*b[5]+a[4],a[1]*b[4]+a[3]*b[5]+a[5]];
const bounds=m=>{const x=[m[4],m[0]+m[4],m[2]+m[4],m[0]+m[2]+m[4]],y=[m[5],m[1]+m[5],m[3]+m[5],m[1]+m[3]+m[5]];return {x:Math.min(...x),y:Math.min(...y),width:Math.max(...x)-Math.min(...x),height:Math.max(...y)-Math.min(...y)};};
const intersects=(a,b)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
const contained=(a,b)=>a.x>=b.x&&a.y>=b.y&&a.x+a.width<=b.x+b.width&&a.y+a.height<=b.y+b.height;

// Ruled answer tables defeat Tesseract's page segmentation: the grid is read as
// glyphs. Thin straight ink runs are found with a small tolerance for scan tilt
// and blur; such pages are read again with the rules erased, at a larger scale,
// as one uniform text block, and the reading with more confident words is kept.
function ruleMask(context,width,height){
  const band=2,d=context.getImageData(0,0,width,height).data,dark=new Uint8Array(width*height),ink=new Uint8Array(width*height);
  for(let i=0;i<width*height;i++){const v=Math.min(d[i*4],d[i*4+1],d[i*4+2]);dark[i]=v<200?1:0;ink[i]=v<235?1:0;}
  const mask=new Uint8Array(width*height),rowHit=new Uint8Array(height),colHit=new Uint8Array(width),minRow=Math.round(width*0.08),minCol=Math.round(height*0.03);
  for(let y=0;y<height;y++){let start=-1;for(let x=0;x<=width;x++){let on=false;if(x<width)for(let k=-band;k<=band&&!on;k++){const yy=y+k;if(yy>=0&&yy<height&&dark[yy*width+x])on=true;}
    if(on&&start<0)start=x;if(!on&&start>=0){if(x-start>=minRow){rowHit[y]=1;for(let xx=start;xx<x;xx++)for(let k=-band;k<=band;k++){const yy=y+k;if(yy>=0&&yy<height&&ink[yy*width+xx])mask[yy*width+xx]=1;}}start=-1;}}}
  for(let x=0;x<width;x++){let start=-1;for(let y=0;y<=height;y++){let on=false;if(y<height)for(let k=-band;k<=band&&!on;k++){const xx=x+k;if(xx>=0&&xx<width&&dark[y*width+xx])on=true;}
    if(on&&start<0)start=y;if(!on&&start>=0){if(y-start>=minCol){colHit[x]=1;for(let yy=start;yy<y;yy++)for(let k=-band;k<=band;k++){const xx=x+k;if(xx>=0&&xx<width&&ink[yy*width+xx])mask[yy*width+xx]=1;}}start=-1;}}}
  // Filled areas such as a dark footer band are not rules.
  const thin=(hits,limit)=>{let n=0,run=0;for(let i=0;i<=hits.length;i++){if(i<hits.length&&hits[i])run++;else{if(run>0&&run<=limit)n++;run=0;}}return n;};
  return {mask,horizontal:thin(rowHit,Math.max(12,Math.round(height*0.02))),vertical:thin(colHit,Math.max(12,Math.round(width*0.02)))};
}
const ruledTable=r=>r.horizontal>=6||r.horizontal>=4&&r.vertical>=2;
function eraseMask(context,width,height,mask){const image=context.getImageData(0,0,width,height),d=image.data;for(let i=0;i<mask.length;i++)if(mask[i])d[i*4]=d[i*4+1]=d[i*4+2]=255;context.putImageData(image,0,0);}
const numberedLines=data=>(data?.blocks||[]).flatMap(b=>(b.paragraphs||[]).flatMap(p=>p.lines||[])).filter(l=>/^\s*\d{1,3}[.)]?\s+\S/.test(l.text||'')).length;
const betterReading=(table,auto)=>{const t=numberedLines(table),a=numberedLines(auto);return t!==a?t>a:confidentWords(table)>confidentWords(auto);};
const confidentWords=data=>(data?.blocks||[]).flatMap(b=>(b.paragraphs||[]).flatMap(p=>(p.lines||[]).flatMap(l=>l.words||[]))).filter(w=>Number(w.confidence)>=70&&/[A-Za-z0-9]/.test(w.text||'')).length;
// Scans are often a degree or two off. The angle whose horizontal projection of
// ink is sharpest (text lines line up) is found on a small copy; the page is
// turned upright before it is saved and read, so boxes match the saved image.
function estimateSkew(createCanvas,canvas){
  const scale=Math.min(1,700/canvas.width),w=Math.max(1,Math.round(canvas.width*scale)),h=Math.max(1,Math.round(canvas.height*scale));
  const small=createCanvas(w,h),sx=small.getContext('2d');sx.drawImage(canvas,0,0,w,h);const d=sx.getImageData(0,0,w,h).data,xs=[],ys=[];
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4;if(Math.min(d[i],d[i+1],d[i+2])<150){xs.push(x-w/2);ys.push(y);}}
  if(xs.length<200)return 0;let best=0,bestScore=-1;
  for(let step=-30;step<=30;step++){const a=step/10,t=Math.tan(a*Math.PI/180),bins=new Float64Array(h+w);for(let k=0;k<xs.length;k++){const b=Math.round(ys[k]-xs[k]*t+w/2);if(b>=0&&b<bins.length)bins[b]++;}let score=0;for(const v of bins)score+=v*v;if(score>bestScore){bestScore=score;best=a;}}
  return best;
}
function upright(createCanvas,canvas,angle){
  const out=createCanvas(canvas.width,canvas.height),x=out.getContext('2d');x.fillStyle='white';x.fillRect(0,0,out.width,out.height);
  x.translate(out.width/2,out.height/2);x.rotate(-angle*Math.PI/180);x.drawImage(canvas,-canvas.width/2,-canvas.height/2);return out;
}
function scaleBoxes(value,factor){
  if(Array.isArray(value))return value.map(v=>scaleBoxes(v,factor));
  if(!value||typeof value!=='object')return value;
  const out={};for(const [k,v] of Object.entries(value))out[k]=k==='bbox'&&v&&typeof v==='object'?Object.fromEntries(Object.entries(v).map(([n,m])=>[n,Number.isFinite(m)?m*factor:m])):scaleBoxes(v,factor);return out;
}

function textBounds(item,style,view){
  const matrix=multiply(view.transform,item.transform),horizontal=Math.hypot(matrix[0],matrix[1]),vertical=Math.hypot(matrix[2],matrix[3]);
  if(!horizontal||!vertical||!Number.isFinite(item.width)||!Number.isFinite(item.height))return null;
  const width=Math.abs(item.width*view.scale),height=Math.abs(item.height*view.scale);
  const ascent=Number.isFinite(style?.ascent)?Math.max(1,style.ascent):1,descent=Number.isFinite(style?.descent)?Math.min(-0.25,style.descent):-0.25;
  const x=[matrix[0]/horizontal*width,matrix[1]/horizontal*width],y=[matrix[2]/vertical*height,matrix[3]/vertical*height];
  const points=[0,1].flatMap(t=>[ascent,descent].map(v=>[matrix[4]+t*x[0]+v*y[0],matrix[5]+t*x[1]+v*y[1]]));
  const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
  return {x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)};
}

async function pageText(page,view,rect,OPS){
  const content=await page.getTextContent({disableNormalization:true});const list=await page.getOperatorList();
  let transform=[1,0,0,1,0,0],unsafe=false,imageIntersects=false;const stack=[];
  for(let i=0;i<list.fnArray.length;i++){
    const op=list.fnArray[i],args=list.argsArray[i];
    if(op===OPS.save){stack.push([...transform]);continue;}
    if(op===OPS.restore){transform=stack.pop()||[1,0,0,1,0,0];continue;}
    if(op===OPS.transform){transform=multiply(transform,args);continue;}
    if(op===OPS.paintFormXObjectBegin){stack.push([...transform]);if(args[0])transform=multiply(transform,args[0]);continue;}
    if(op===OPS.paintFormXObjectEnd){transform=stack.pop()||[1,0,0,1,0,0];continue;}
    if(op===OPS.setTextRenderingMode&&args[0]!==0)unsafe=true;
    if([OPS.setGState,OPS.clip,OPS.eoClip].includes(op))unsafe=true;
    if(op===OPS.setFillRGBColor&&!(args.length===1&&['#000000','#000'].includes(args[0])||args.length===3&&args.every(n=>n===0)))unsafe=true;
    if(op===OPS.setFillGray&&args[0]!==0)unsafe=true;
    if(op===OPS.setFillCMYKColor&&!(args.length===4&&args[0]===0&&args[1]===0&&args[2]===0&&args[3]===1))unsafe=true;
    if([OPS.setFillColor,OPS.setFillColorN,OPS.fill,OPS.eoFill,OPS.fillStroke,OPS.eoFillStroke,OPS.closeFillStroke,OPS.closeEOFillStroke,OPS.shadingFill].includes(op))unsafe=true;
    if([OPS.paintImageXObject,OPS.paintInlineImageXObject,OPS.paintImageMaskXObject].includes(op)&&intersects(bounds(multiply(view.transform,transform)),rect))imageIntersects=true;
    if([OPS.paintImageXObjectRepeat,OPS.paintImageMaskXObjectRepeat,OPS.paintImageMaskXObjectGroup].includes(op))imageIntersects=true;
  }
  const items=[];let partialTextItems=false;
  for(const it of content.items){
    if(typeof it.str!=='string'||!it.str)continue;const b=textBounds(it,content.styles?.[it.fontName],view);
    if(!b){partialTextItems=true;continue;}
    if(!intersects(b,rect))continue;
    // PDF.js items may contain a whole line. Without glyph offsets, including
    // an intersecting item's string would disclose text outside this crop.
    if(!contained(b,rect)){partialTextItems=true;continue;}
    items.push({str:it.str,visible:!unsafe&&b.height>=8&&b.width>0,bbox:b,hasEOL:it.hasEOL});
  }
  const text=items.map(i=>i.str+(i.hasEOL?'\n':' ')).join('').trim();return {text,items,imageIntersects,partialTextItems,reliable:!partialTextItems&&reliableTextRegion({text,items,imageIntersects})};
}

async function run(config){
  const spec=config.launchSpec,verified=await verifyOcrLaunchSpec(spec),equal=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
  if(!equal(spec.entryPath,fileURLToPath(import.meta.url))||!equal(spec.cwd,process.cwd())||spec.writableJobDir===null||!equal(spec.writableJobDir,config.outputDir))throw Error('OCR_LAUNCH_INVALID');
  if(config.assets){
    if(!equal(config.assets.runtimeRoot,spec.runtimeRoot)||!equal(config.assets.modulePath,path.join(spec.runtimeRoot,'tesseract.js/src/index.js')))throw Error('OCR_LAUNCH_INVALID');
    const coreFiles=verified.lock.files.filter(file=>/^node_modules\/tesseract\.js-core\/tesseract-core(?:-(?:simd|relaxedsimd))?(?:-lstm)?\.(?:js|wasm)$/.test(file.path)).map(file=>({name:file.path.slice(13),sha256:file.sha256}));
    if(!Array.isArray(config.assets.coreFiles)||config.assets.coreFiles.length!==coreFiles.length||coreFiles.some(file=>!config.assets.coreFiles.some(value=>value.name===file.name&&value.sha256===file.sha256)))throw Error('OCR_CORE_UNVERIFIED');
    config.assets.coreFiles=coreFiles;
  }
  const bytes=await fs.readFile(config.inputPath);if(bytes.length>OCR_LIMITS.maxInputBytes||hash(bytes)!==config.assetId)throw Error('OCR_INPUT_INVALID');
  const {createCanvas,loadImage}=await import(assertOcrLaunchModule(verified,import.meta.resolve('@napi-rs/canvas'),'@napi-rs/canvas'));
  let document,task,worker,totalPixels=0,totalOutput=0;const results=[];
  async function recognize(png,pageSegMode='3'){
    if(!config.assets)throw Error('OCR_ASSETS_MISSING');
    if(!worker){
      process.env.PRACTICEBRIDGE_OCR_RUNTIME=config.assets.runtimeRoot;
      process.env.PRACTICEBRIDGE_OCR_CORE_RECEIPT=path.join(config.outputDir,'core-selection.json');
      process.env.PRACTICEBRIDGE_OCR_CORE_FILES=JSON.stringify(config.assets.coreFiles);
      const require=createRequire(import.meta.url);const {createWorker}=require(config.assets.modulePath);
      worker=await createWorker('eng',1,{workerPath:spec.workerPath,langPath:config.assets.assetDir,gzip:true,cacheMethod:'none',workerBlobURL:false,logger:()=>{},errorHandler:()=>{}});
    }
    await worker.setParameters({tessedit_pageseg_mode:pageSegMode});
    const result=await worker.recognize(png,{}, {text:true,blocks:true});
    const core=JSON.parse(await fs.readFile(path.join(config.outputDir,'core-selection.json'),'utf8'));
    return {data:result.data,coreEntry:core.coreEntry,coreHash:core.coreHash,wasmEntry:core.wasmEntry,wasmHash:core.wasmHash};
  }
  try{
    const isPdf=bytes.subarray(0,1024).includes(Buffer.from('%PDF-'));
    let pdfjs;
    if(isPdf){
      pdfjs=await import(assertOcrLaunchModule(verified,import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs'),'pdfjs-dist'));const url=assertOcrLaunchModule(verified,import.meta.resolve('pdfjs-dist/package.json'),'pdfjs-dist');
      task=pdfjs.getDocument({data:new Uint8Array(bytes),verbosity:0,maxImageSize:config.budget.maxPixels,isEvalSupported:false,useSystemFonts:false,disableFontFace:true,useWorkerFetch:false,standardFontDataUrl:fileURLToPath(new URL('standard_fonts/',url)).replaceAll('\\','/'),cMapUrl:fileURLToPath(new URL('cmaps/',url)).replaceAll('\\','/'),cMapPacked:true});document=await task.promise;
      if(document.numPages>200)throw Error('OCR_PAGE_LIMIT');
    }
    for(const selection of config.pages){
      let page;
      try{
        const region=selection.region||{x:0,y:0,width:1,height:1};let view,image,rect,textLayer={text:'',items:[],reliable:false};
        if(isPdf){page=await document.getPage(selection.page);view=page.getViewport({scale:2});}
        else {if(selection.page!==1)throw Error('OCR_PAGE_INVALID');image=await loadImage(bytes);view={width:image.width,height:image.height};}
        // Budget the selected pixels before allocating the canvas; a large page
        // can be inspected through a small explicitly selected region.
        const left=Math.ceil(view.width*region.x),top=Math.ceil(view.height*region.y);
        rect={x:left,y:top,width:Math.floor(view.width*(region.x+region.width))-left,height:Math.floor(view.height*(region.y+region.height))-top};
        if(rect.width<1||rect.height<1||rect.width>16000||rect.height>16000||totalPixels+rect.width*rect.height>config.budget.maxPixels)throw Error('OCR_PIXEL_LIMIT');
        totalPixels+=rect.width*rect.height;
        if(page)textLayer=await pageText(page,view,rect,pdfjs.OPS);
        if(textLayer.reliable&&config.toolId==='document.ocr'){results.push({page:selection.page,region,pixelRect:rect,pageDimensions:{width:view.width,height:view.height},state:'text_layer',textLayer:textLayer.text,width:rect.width,height:rect.height,ocrCalled:false});continue;}
        let canvas=createCanvas(rect.width,rect.height);let context=canvas.getContext('2d');context.fillStyle='white';context.fillRect(0,0,rect.width,rect.height);
        if(page)await page.render({canvasContext:context,viewport:view,transform:[1,0,0,1,-rect.x,-rect.y],background:'white'}).promise;
        else context.drawImage(image,-rect.x,-rect.y);
        const skew=config.toolId==='document.ocr'?estimateSkew(createCanvas,canvas):0;
        if(Math.abs(skew)>=1){canvas=upright(createCanvas,canvas,skew);context=canvas.getContext('2d');}
        const png=canvas.toBuffer('image/png');totalOutput+=png.length;if(totalOutput>config.budget.maxOutputBytes)throw Error('OCR_OUTPUT_LIMIT');
        const imageName=`page-${selection.page}.png`;await fs.writeFile(path.join(config.outputDir,imageName),png,{flag:'wx'});
        const base={page:selection.page,region,pixelRect:rect,pageDimensions:{width:view.width,height:view.height},textLayer:textLayer.text,partialTextItems:textLayer.partialTextItems===true,imageName,imageHash:hash(png),width:rect.width,height:rect.height};
        if(config.toolId==='document.render'){results.push({...base,state:'rendered',ocrCalled:false});continue;}
        try{
          let ocr=await recognize(png),mode='auto';
          if(ruledTable(ruleMask(context,rect.width,rect.height))&&rect.width*1.5<=16000&&rect.height*1.5<=16000){
            const w3=Math.round(rect.width*1.5),h3=Math.round(rect.height*1.5),large=createCanvas(w3,h3),lc=large.getContext('2d');lc.fillStyle='white';lc.fillRect(0,0,w3,h3);
            if(page){const view3=page.getViewport({scale:3});await page.render({canvasContext:lc,viewport:view3,transform:[1,0,0,1,-rect.x*1.5,-rect.y*1.5],background:'white'}).promise;}
            else lc.drawImage(image,-rect.x*1.5,-rect.y*1.5,view.width*1.5,view.height*1.5);
            let straight=large,sc=lc;if(Math.abs(skew)>=1){straight=upright(createCanvas,large,skew);sc=straight.getContext('2d');}
            eraseMask(sc,w3,h3,ruleMask(sc,w3,h3).mask);
            const table=await recognize(straight.toBuffer('image/png'),'6');
            if(betterReading(table.data,ocr.data)){ocr={...table,data:scaleBoxes(table.data,1/1.5)};mode='ruled_table';}
          }
          results.push({...base,...ocr,recognitionMode:mode,deskewDegrees:Math.abs(skew)>=1?skew:0,state:'recognized',ocrCalled:true});
        }
        catch(e){results.push({...base,state:'unavailable',code:config.assets?'OCR_RECOGNITION_FAILED':'OCR_ASSETS_MISSING',ocrCalled:Boolean(config.assets)});}
      }catch(e){results.push({page:selection.page,state:'failed',code:/^OCR_[A-Z_]+$/.test(e.message)?e.message:'OCR_PAGE_FAILED',ocrCalled:false});}
      finally{page?.cleanup();}
    }
    return {version:1,results,totalPixels,renderEngine:document?'pdfjs-dist@6.3.289':'@napi-rs/canvas',actualDevice:'cpu'};
  }finally{await worker?.terminate();await task?.destroy();}
}

let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>262144)throw Error('OCR_PROTOCOL_LIMIT');}
try{const result=await run(JSON.parse(input));process.stdout.write(JSON.stringify(result));}
catch(e){process.stdout.write(JSON.stringify({version:1,results:[],code:/^OCR_[A-Z_]+$/.test(e.message)?e.message:'OCR_WORKER_FAILED'}));process.exitCode=1;}
