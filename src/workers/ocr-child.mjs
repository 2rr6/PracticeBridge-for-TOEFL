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
  async function recognize(png){
    if(!config.assets)throw Error('OCR_ASSETS_MISSING');
    if(!worker){
      process.env.PRACTICEBRIDGE_OCR_RUNTIME=config.assets.runtimeRoot;
      process.env.PRACTICEBRIDGE_OCR_CORE_RECEIPT=path.join(config.outputDir,'core-selection.json');
      process.env.PRACTICEBRIDGE_OCR_CORE_FILES=JSON.stringify(config.assets.coreFiles);
      const require=createRequire(import.meta.url);const {createWorker}=require(config.assets.modulePath);
      worker=await createWorker('eng',1,{workerPath:spec.workerPath,langPath:config.assets.assetDir,gzip:true,cacheMethod:'none',workerBlobURL:false,logger:()=>{},errorHandler:()=>{}});
    }
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
        const canvas=createCanvas(rect.width,rect.height);const context=canvas.getContext('2d');context.fillStyle='white';context.fillRect(0,0,rect.width,rect.height);
        if(page)await page.render({canvasContext:context,viewport:view,transform:[1,0,0,1,-rect.x,-rect.y],background:'white'}).promise;
        else context.drawImage(image,-rect.x,-rect.y);
        const png=canvas.toBuffer('image/png');totalOutput+=png.length;if(totalOutput>config.budget.maxOutputBytes)throw Error('OCR_OUTPUT_LIMIT');
        const imageName=`page-${selection.page}.png`;await fs.writeFile(path.join(config.outputDir,imageName),png,{flag:'wx'});
        const base={page:selection.page,region,pixelRect:rect,pageDimensions:{width:view.width,height:view.height},textLayer:textLayer.text,partialTextItems:textLayer.partialTextItems===true,imageName,imageHash:hash(png),width:rect.width,height:rect.height};
        if(config.toolId==='document.render'){results.push({...base,state:'rendered',ocrCalled:false});continue;}
        try{const ocr=await recognize(png);results.push({...base,...ocr,state:'recognized',ocrCalled:true});}
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
