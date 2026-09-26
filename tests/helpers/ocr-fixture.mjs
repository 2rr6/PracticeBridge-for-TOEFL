import {createCanvas} from '@napi-rs/canvas';
import {deflateSync} from 'node:zlib';

export function authoredScanPng(){
  const canvas=createCanvas(1200,1000),ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,1200,1000);ctx.fillStyle='black';ctx.font='32px Arial';
  const lines=['Reading: An original practice notice','Read the notice and choose one answer.','The red door is NOT open. The blue door is open.','1. Which door is NOT open?','A. The red door.','B. The blue door.'];
  lines.forEach((line,i)=>ctx.fillText(line,60,100+i*90));return {bytes:canvas.toBuffer('image/png'),canvas,lines};
}
export function authoredOcrPdf(kind='scan'){
  const {canvas}=authoredScanPng(),pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data,rgb=Buffer.alloc(canvas.width*canvas.height*3);
  for(let i=0,j=0;i<pixels.length;i+=4){rgb[j++]=pixels[i];rgb[j++]=pixels[i+1];rgb[j++]=pixels[i+2];}
  const image=deflateSync(rgb),text='BT /F1 16 Tf 40 760 Td (Read this reliable original text region.) Tj ET';
  const stream=kind==='text'?text:kind==='hidden'?`1 1 1 rg\n${text}`:kind==='mixed'?`${text}\nq 300 0 0 250 250 100 cm /Im1 Do Q`:'q 600 0 0 500 0 150 cm /Im1 Do Q';
  const objects=[Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 5 0 R >> /XObject << /Im1 6 0 R >> >> /Contents 4 0 R >>'),Buffer.from(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`),Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${image.length} >>\nstream\n`),image,Buffer.from('\nendstream')])];
  const chunks=[Buffer.from('%PDF-1.4\n')],offsets=[];let length=chunks[0].length;
  objects.forEach((o,i)=>{offsets.push(length);const b=Buffer.concat([Buffer.from(`${i+1} 0 obj\n`),o,Buffer.from('\nendobj\n')]);chunks.push(b);length+=b.length;});
  chunks.push(Buffer.from(`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF`));return Buffer.concat(chunks);
}
