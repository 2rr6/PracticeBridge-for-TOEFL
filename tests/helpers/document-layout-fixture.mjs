// Entirely original test corpus, with deliberately scrambled content streams.
// Expected answers/locations live in the tests and are not derived by the parser.
export function authoredPdf() {
  const row=(s,x,y,size=12)=>({s,x,y,size});
  const page=(n,lines,extra={})=>({lines:[row(`Original Workbook 9 ${n}`,180,20),...lines.map((s,i)=>typeof s==='string'?row(s,40,730-i*22):s)],...extra});
  const pages=[
    page(1,['Reading Section, Module 1','Read a notice.','The red door is NOT open.','1. Which door is NOT open?']),
    page(2,['(A) Red door','(B) Blue door']),
    page(3,['Reading Section, Module 1','Answer Key','Question','Number','Answer','1 A']),
    page(4,['Reading Section, Module 2','Fill in the missing letters in the paragraph.','(Questions 1-1)','A ca _ sleeps.']),
    page(5,['Reading Section, Module 2','Answer Key','1 t']),
    page(6,['Speaking Section','Take an Interview','Interviewer: Describe your original drawing.']),
    page(7,[row('Reading exercise heading across both columns',40,750,22),row('Right first',340,700),row('Right second',340,670),row('Left column begins here',40,700),row('Left second',40,670)]),
    page(8,[row('Rotated source',40,700)],{rotation:90}),
    page(9,['o\x80ce','ne _','_ the door']),
  ];
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 4 0 R >>'];
  const cmap='/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Original def /CMapType 2 def 1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <80> <FB03> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end';
  objects.push(`<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`);
  const kids=[];
  for(const p of pages){
    const id=objects.length+1;kids.push(`${id} 0 R`);
    const escape=s=>s.replaceAll('\\','\\\\').replaceAll('(','\\(').replaceAll(')','\\)');
    const stream=p.lines.map(({s,x,y,size=12})=>`BT /F1 ${size} Tf 1 0 0 1 ${x} ${y} Tm (${escape(s)}) Tj ET`).join('\n');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Rotate ${p.rotation||0} /Resources << /Font << /F1 3 0 R >> >> /Contents ${id+1} 0 R >>`,`<< /Length ${Buffer.byteLength(stream,'latin1')} >>\nstream\n${stream}\nendstream`);
  }
  objects[1]=`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;
  let pdf='%PDF-1.4\n';const offsets=[];
  objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(pdf,'latin1'));pdf+=`${i+1} 0 obj\n${o}\nendobj\n`;});
  const start=Buffer.byteLength(pdf,'latin1');pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
  return Buffer.from(pdf,'latin1');
}
