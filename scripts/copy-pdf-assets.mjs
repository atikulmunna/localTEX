import {cpSync,existsSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
const source=fileURLToPath(new URL('../node_modules/pdfjs-dist/',import.meta.url));
const target=fileURLToPath(new URL('../public/pdf-assets/',import.meta.url));
mkdirSync(target,{recursive:true});
for(const directory of ['cmaps','standard_fonts','wasm','iccs']){
  const from=join(source,directory);
  if(existsSync(from))cpSync(from,join(target,directory),{recursive:true});
}
console.log('PDF fonts, character maps and decoders are bundled for offline use.');
