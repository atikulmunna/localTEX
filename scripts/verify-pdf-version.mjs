import { readFileSync } from 'node:fs';
const {version}=JSON.parse(readFileSync(new URL('../node_modules/pdfjs-dist/package.json',import.meta.url),'utf8'));
const actual=version.split('.').map(Number), minimum=[6,2,108];
const difference=actual.map((n,i)=>n-minimum[i]).find(n=>n!==0)??0;
if(difference<0){
  throw new Error(`PDF.js ${version} is not approved for packaging. Run: npm install --save-exact pdfjs-dist@6.2.108`);
}
console.log(`PDF.js ${version}: release dependency check passed.`);
