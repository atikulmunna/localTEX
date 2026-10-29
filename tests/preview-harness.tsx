import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PdfPreview} from '../src/PdfPreview';
import type {SyncPoint} from '../src/types';
import 'pdfjs-dist/web/pdf_viewer.css';
import '../src/styles.css';
function fixturePdf(){
  const objects=[
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>','',
  ];
  for(const [index,text] of [[4,'A real PDF preview'],[6,'The second page']] as const){const stream=`BT /F1 24 Tf 60 740 Td (${text}) Tj ET`;objects[index]=`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;}
  let body='%PDF-1.4\n';const offsets=[0];objects.forEach((obj,i)=>{offsets.push(body.length);body+=`${i+1} 0 obj\n${obj}\nendobj\n`;});
  const xref=body.length;body+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('');
  body+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new TextEncoder().encode(body);
}
function Harness(){
  const [point,setPoint]=useState<SyncPoint|null>(null);const [stale,setStale]=useState(false);const [data,setData]=useState<Uint8Array|null>(fixturePdf);
  return <main style={{height:'100vh',display:'flex',flexDirection:'column'}}><nav><button onClick={()=>setStale(true)}>Mark stale</button><button onClick={()=>setData(fixturePdf())}>Rebuild PDF</button><output aria-label="Inverse position">{point?`${point.page}:${point.x}:${point.y}`:''}</output></nav><PdfPreview data={data} stale={stale} sync={null} onInverse={setPoint} onExport={()=>{}}/></main>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);
