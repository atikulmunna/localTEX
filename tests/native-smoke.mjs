// Run against a debug desktop instance started with a loopback WebView2 debug port.
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
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
// A copied project's config cannot grant shell execution or its latexmkrc without local consent.
await writeFile(join(directory,'latexmkrc'),'print "localtex rc loaded\\n";\n','utf8');
await writeFile(join(directory,'.localtex','project.json'),JSON.stringify({version:1,root:'main.tex',engine:'pdflatex',shellEscape:true,latexmkrc:true}),'utf8');
const untrusted=await invoke('refresh_project',{projectId:project.id});
assert.equal(untrusted.config.shellEscape,false);assert.equal(untrusted.config.latexmkrc,false);
// Consent given in this app is recorded locally, so the next build reads the rc file.
await invoke('save_project_config',{projectId:project.id,config:{version:1,root:'main.tex',engine:'pdflatex',shellEscape:false,latexmkrc:true}});
assert.equal((await invoke('refresh_project',{projectId:project.id})).config.latexmkrc,true);
await invoke('save_settings',{settings:{recent:[directory],toolDirectory:null}});
await page.reload();await page.getByRole('button').filter({hasText:project.name}).click();
await page.getByRole('textbox',{name:'LaTeX source editor'}).waitFor();
// A finished setup is remembered, so the reload must not show it again.
assert.equal(await page.getByRole('dialog').count(),0);
await page.getByRole('button',{name:/^Compile/}).click();
await page.locator('.pdf-page canvas').waitFor({timeout:5*60_000});
await page.getByText('PDF is up to date').waitFor();
await page.screenshot({path:'.cache/native-workspace.png'});
await page.locator('.build-status').click();
await page.getByRole('button',{name:'Compiler output',exact:true}).click();
assert.match(await page.locator('.compiler-log').innerText(),/localtex rc loaded/);
console.log('Native smoke passed: first-launch LaTeX setup, remembered setup, project creation/open, file read/save/conflict, traversal rejection, rename, settings, recovery, indexing, local trust, UI project loading, CRLF/BOM-preserving saves, Windows-1252 files, trusted latexmkrc, and a real compile to PDF.');
await browser.close();
// The project exists only for this run; its Bangla name checks non-ASCII paths.
await rm(directory,{recursive:true,force:true});
