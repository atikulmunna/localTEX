// Run against a debug desktop instance started with a loopback WebView2 debug port.
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';

const browser=await chromium.connectOverCDP('http://127.0.0.1:9223');
const page=browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().includes('1420'));
assert.ok(page,'The native localTEX webview must be open');
await page.waitForSelector('.brand');
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
const indexed=await invoke('index_project',{projectId:project.id});assert.ok(indexed.some(d=>d.path==='renamed notes.tex'));
// A copied project's config cannot grant shell execution without local consent.
await writeFile(join(directory,'.localtex','project.json'),JSON.stringify({version:1,root:'main.tex',engine:'pdflatex',shellEscape:true}),'utf8');
const untrusted=await invoke('refresh_project',{projectId:project.id});assert.equal(untrusted.config.shellEscape,false);
await invoke('save_settings',{settings:{recent:[directory],toolDirectory:null}});
await page.reload();await page.getByRole('button').filter({hasText:project.name}).click();
await page.getByRole('textbox',{name:'LaTeX source editor'}).waitFor();
await page.screenshot({path:'.cache/native-workspace.png'});
console.log('Native smoke passed: project creation/open, file read/save/conflict, traversal rejection, rename, settings, recovery, indexing, local trust, and UI project loading.');
await browser.close();
