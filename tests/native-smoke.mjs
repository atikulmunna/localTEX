// Run against a debug desktop instance started with a loopback WebView2 debug port.
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';

const browser=await chromium.connectOverCDP('http://127.0.0.1:9223');
const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('1420'));
assert.ok(page,'The native localTEX webview must be open');
await page.waitForSelector('.brand');
// Fresh app data means first launch: setup runs against the real TeX installation.
const setup=page.getByRole('dialog',{name:/^(LaTeX is ready|LaTeX setup needs attention)$/});
await setup.waitFor({timeout:15*60_000});
assert.equal(await setup.getAttribute('aria-label'),'LaTeX is ready',await setup.innerText());
await setup.getByRole('button',{name:'Start writing'}).click();
const invoke=(command,args={})=>page.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args});
const parent=resolve('.cache/native-projects');await mkdir(parent,{recursive:true});
const directory=await invoke('create_project',{parent,name:`Smoke বাংলা ${Date.now()}`,template:'article'});
const project=await invoke('open_project',{directory});assert.ok(project.files.some(f=>f.path==='main.tex'));
const original=await invoke('read_file',{projectId:project.id,path:'main.tex'});
const savedText='% Saved through native IPC\n'+original.text;
const revision=await invoke('save_file',{projectId:project.id,document:{...original,text:savedText}});
assert.notEqual(revision,original.revision);
await assert.rejects(invoke('save_file',{projectId:project.id,document:original}),/CONFLICT/);
await assert.rejects(invoke('read_file',{projectId:project.id,path:'../private.tex'}),/relative path/);
await invoke('create_file',{projectId:project.id,path:'notes.tex'});
await invoke('rename_file',{projectId:project.id,from:'notes.tex',to:'renamed notes.tex'});
await invoke('save_project_config',{projectId:project.id,config:{version:1,root:'main.tex',engine:'pdflatex',shellEscape:false}});
const draft={project:project.id,path:'main.tex',text:'unsaved thought',revision};
await invoke('save_draft',{draft});assert.equal((await invoke('load_drafts',{project:project.id}))[0].text,draft.text);
await invoke('remove_draft',{project:project.id,path:draft.path});assert.deepEqual(await invoke('load_drafts',{project:project.id}),[]);
await writeFile(join(directory,'main.tex'),'% An external edit\n'+savedText,'utf8');
const refreshed=await invoke('read_file',{projectId:project.id,path:'main.tex'});assert.notEqual(refreshed.revision,revision);
// Files from Windows editors keep their CRLF line endings and byte-order mark when saved.
await writeFile(join(directory,'windows.tex'),'\ufeff% From a Windows editor\r\nLine two\r\n','utf8');
const windows=await invoke('read_file',{projectId:project.id,path:'windows.tex'});
assert.equal(windows.text,'% From a Windows editor\nLine two\n');
await invoke('save_file',{projectId:project.id,document:{...windows,text:windows.text+'Line three\n'}});
assert.equal(await readFile(join(directory,'windows.tex'),'utf8'),'\ufeff% From a Windows editor\r\nLine two\r\nLine three\r\n');
// Older projects in Windows-1252 (latin1, ansinew) open and save in their own encoding.
await writeFile(join(directory,'latin1.tex'),Buffer.from([0x43,0x61,0x66,0xe9,0x0d,0x0a]));
const latin1=await invoke('read_file',{projectId:project.id,path:'latin1.tex'});
assert.equal(latin1.encoding,'Windows-1252');assert.equal(latin1.text,'Café\n');
await invoke('save_file',{projectId:project.id,document:{...latin1,text:latin1.text+'Naïve\n'}});
assert.deepEqual([...await readFile(join(directory,'latin1.tex'))],[0x43,0x61,0x66,0xe9,0x0d,0x0a,0x4e,0x61,0xef,0x76,0x65,0x0d,0x0a]);
const indexed=await invoke('index_project',{projectId:project.id});assert.ok(indexed.some(d=>d.path==='renamed notes.tex'));
// Folders, added files (named so nothing is overwritten), previews and Recycle Bin deletes.
await invoke('create_folder',{projectId:project.id,path:'figures'});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
const outside=join(parent,`smoke-plot-${Date.now()}.png`);await writeFile(outside,png);
const name=outside.split(/[\\/]/).at(-1);
assert.deepEqual(await invoke('import_files',{projectId:project.id,folder:'figures',sources:[outside]}),[`figures/${name}`]);
const copy=`figures/${name.replace('.png',' (2).png')}`;
assert.deepEqual(await invoke('import_files',{projectId:project.id,folder:'figures',sources:[outside]}),[copy]);
await rm(outside);
const previewBytes=await page.evaluate(async({id,path})=>(await window.__TAURI_INTERNALS__.invoke('read_binary',{projectId:id,path})).byteLength,{id:project.id,path:`figures/${name}`});
assert.equal(previewBytes,png.length);
await invoke('delete_entry',{projectId:project.id,path:copy});
assert.ok(!existsSync(join(directory,copy)));
assert.ok((await invoke('refresh_project',{projectId:project.id})).folders.includes('figures'));
// A copied project's config cannot grant shell execution or its latexmkrc without local consent.
await writeFile(join(directory,'latexmkrc'),'print "localtex rc loaded\\n";\n','utf8');
await writeFile(join(directory,'.localtex','project.json'),JSON.stringify({version:1,root:'main.tex',engine:'pdflatex',shellEscape:true,latexmkrc:true}),'utf8');
const untrusted=await invoke('refresh_project',{projectId:project.id});
assert.equal(untrusted.config.shellEscape,false);assert.equal(untrusted.config.latexmkrc,false);
// Consent given in this app is recorded locally, so the next build reads the rc file.
await invoke('save_project_config',{projectId:project.id,config:{version:1,root:'main.tex',engine:'pdflatex',shellEscape:false,latexmkrc:true}});
assert.equal((await invoke('refresh_project',{projectId:project.id})).config.latexmkrc,true);
// A package the document loads is downloaded when the project opens, before compiling.
const findtexmf=file=>{try{return execFileSync('findtexmf',[file],{timeout:30_000}).toString().trim();}catch{return '';}};
const algorithmMissing=!findtexmf('algorithm2e.sty');
const mainPath=join(directory,'main.tex');
await writeFile(mainPath,(await readFile(mainPath,'utf8')).replace('\\usepackage[T1]{fontenc}','\\usepackage[T1]{fontenc}\n\\usepackage[ruled]{algorithm2e}'),'utf8');
await invoke('save_settings',{settings:{recent:[directory],toolDirectory:null}});
await page.reload();await page.getByRole('button').filter({hasText:project.name}).click();
await page.getByRole('textbox',{name:'LaTeX source editor'}).waitFor();
// A finished setup is remembered, so the reload must not show it again.
assert.equal(await page.getByRole('dialog').count(),0);
if(algorithmMissing)await page.getByText('Downloaded algorithm2e for this project.').waitFor({timeout:10*60_000});
assert.ok(findtexmf('algorithm2e.sty'),'algorithm2e should be installed');
await page.getByRole('button',{name:/^Compile/}).click();
await page.locator('.pdf-page canvas').first().waitFor({timeout:5*60_000});
await page.getByText('PDF is up to date').waitFor();
assert.match(await page.locator('.page-count').innerText(),/^1 \/ \d+$/);
await page.screenshot({path:'.cache/native-workspace.png'});
await page.locator('.build-status').click();
await page.getByRole('button',{name:'Compiler output',exact:true}).click();
assert.match(await page.locator('.compiler-log').innerText(),/localtex rc loaded/);
assert.match(await page.locator('.status-words').innerText(),/^\d+ words$/);
// Images open as a preview; the page's content policy must allow the blob image.
await page.locator('.file-tree').getByRole('button',{name,exact:true}).click();
const image=page.getByRole('img',{name:`figures/${name}`});
await image.waitFor();
assert.equal(await image.evaluate(img=>img.complete&&img.naturalWidth),1);
// Ctrl+B reaches the editor in WebView2, and the system spell checker runs on prose.
await page.locator('.editor-tab',{hasText:'main.tex'}).getByRole('button').first().click();
await page.getByRole('button',{name:'Auto compile'}).click();
const editor=page.getByRole('textbox',{name:'LaTeX source editor'});
await editor.click();await page.keyboard.press('Control+End');
await page.keyboard.insertText('\nThsi sentense has mispelled wrds and \\documentclass stays clean.\nword');
await page.keyboard.press('Control+Shift+ArrowLeft');await page.keyboard.press('Control+b');
assert.match(await editor.innerText(),/\\textbf\{word\}/);
// The Windows spell checker underlines the inserted prose, not the LaTeX command.
const misspelled=page.locator('.cm-misspelled');
await misspelled.filter({hasText:'Thsi'}).waitFor({timeout:15_000});
const flagged=await misspelled.allInnerTexts();
for(const word of ['Thsi','sentense','mispelled','wrds'])assert.ok(flagged.includes(word),`${word} not flagged: ${flagged}`);
assert.ok(!flagged.some(w=>w.includes('documentclass')),`LaTeX flagged: ${flagged}`);
await misspelled.filter({hasText:'Thsi'}).click({button:'right'});
await page.getByRole('menuitem',{name:'This',exact:true}).click();
assert.match(await editor.innerText(),/This sentense/);
await page.locator('.cm-line',{hasText:'sentense'}).screenshot({path:'.cache/native-spellcheck.png'});
console.log('Native smoke passed: first-launch LaTeX setup, remembered setup, project creation/open, file read/save/conflict, traversal rejection, rename, settings, recovery, indexing, local trust, UI project loading, CRLF/BOM-preserving saves, Windows-1252 files, folders, added files, image preview, Recycle Bin delete, trusted latexmkrc, Ctrl+B, word count, Windows spell checking with suggestions, downloading a package before compiling, and a real compile to PDF.');
await browser.close();
// The project exists only for this run; its Bangla name checks non-ASCII paths.
await rm(directory,{recursive:true,force:true});
