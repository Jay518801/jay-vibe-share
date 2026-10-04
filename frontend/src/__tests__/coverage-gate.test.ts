import { afterEach, expect, test, vi } from 'vitest';
import convert from 'ast-v8-to-istanbul';
import { parseAstAsync } from 'vitest/node';
import ts from 'typescript';
import * as fs from 'node:fs';
import * as child from 'node:child_process';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {analyze,classify,DEBT_BASE,digest,evaluate,git,productionFiles,requireThat,sameMaps,snapshot,verifyProduction} from '../../tools/coverage-gate.ts';
vi.mock('node:child_process',async original=>{const actual=await original<any>();const value={...actual,execFileSync:vi.fn(actual.execFileSync)};return {...value,default:value};});
afterEach(()=>vi.restoreAllMocks());
async function inventory(source:string, file='/tmp/quality-syntax.tsx') {
 const transformed=ts.transpileModule(source,{fileName:file,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX,sourceMap:true,inlineSources:true}});
 const map=JSON.parse(transformed.sourceMapText!);map.sources=[`file://${file}`];
 const result=await convert({code:transformed.outputText,sourceMap:map,ast:await parseAstAsync(transformed.outputText),coverage:{url:`file://${file}`,functions:[]}});
 return Object.values(result)[0] as any;
}
function hit(expected:any) {const r=structuredClone(expected);for(const id in r.s)r.s[id]=1;for(const id in r.f)r.f[id]=1;for(const id in r.b)r.b[id]=r.b[id].map(()=>1);return r;}
const source='export const value = (x) => (x ? 2 : 3);';
test('trusted complete inventory covers current syntax, even with zero runtime functions',async()=>{
 for(const code of ['throw new Error("boom");','for(let i=0;i<2;i++){ console.log(i); }','class A { field=1; method(x=0){return x ? this.field : 2;} }','export const C=({x})=><div>{x?.name ?? "empty"}</div>;']) {
  const expected=await inventory(code);
  expect(Object.keys(expected.statementMap).length).toBeGreaterThan(0);
  expect(()=>analyze('syntax.tsx',code,{statementMap:{},s:{},fnMap:{},f:{},branchMap:{},b:{}},expected)).toThrow('Complete');
  const counts=analyze('syntax.tsx',code,hit(expected),expected);
  expect(counts.statements.covered).toBe(counts.statements.total);
 }
});
test('full statement/function/branch identities and arms are mandatory',async()=>{
 const expected=await inventory(source);const valid=hit(expected);
 const mutations=[(r:any)=>{delete r.statementMap[0];delete r.s[0];},(r:any)=>{delete r.fnMap[0];delete r.f[0];},(r:any)=>{r.branchMap[0].locations.pop();r.b[0].pop();},(r:any)=>{r.branchMap[0].locations[0].start={line:999,column:-3};},(r:any)=>{r.statementMap[0].end.column=-1;},(r:any)=>{r.branchMap[0].type='if';}];
 for(const mutate of mutations){const r=structuredClone(valid);mutate(r);expect(()=>analyze('a.ts',source,r,expected)).toThrow('Complete');}
 expect(()=>sameMaps('a',null,expected)).toThrow('Missing');
 expect(()=>sameMaps('a',valid,null)).toThrow('Missing');
 expect(analyze('a.ts',source,valid,expected).branches.total).toBe(2);
});
test('hit cardinality, integer counts and suppressions fail closed',async()=>{
 const expected=await inventory(source);
 for(const mutate of [(r:any)=>{delete r.s[0];},(r:any)=>{r.b[0]=[1];},(r:any)=>{r.b[0]=null;},(r:any)=>{r.s[0]=-1;},(r:any)=>{r.f[0]=0.5;}]){const r=hit(expected);mutate(r);expect(()=>analyze('a',source,r,expected)).toThrow();}
 expect(()=>analyze('a','// v8 ignore next\n'+source,hit(expected),expected)).toThrow('suppression');
 expect(digest('a')).toHaveLength(64);expect(()=>requireThat(false,'blocked')).toThrow('blocked');
});
function directory(){return fs.mkdtempSync(path.join(tmpdir(),'quality-graph-'));}
function fixture(root:string,files:Record<string,string>){const hashes:Record<string,string>={};for(const [file,source]of Object.entries(files)){const name=path.join(root,file);fs.mkdirSync(path.dirname(name),{recursive:true});fs.writeFileSync(name,source);hashes[file]=digest(source);}return hashes;}
test('production graph follows HTML, aliases, reexports and dynamic imports into test paths',()=>{
 const root=directory();try{
 const hashes=fixture(root,{'frontend/index.html':'<script type="module" src="/src/main.ts"></script><script src="/boot.js"></script>','frontend/public/boot.js':'window.boot=true;','frontend/tsconfig.json':JSON.stringify({compilerOptions:{baseUrl:'.',paths:{'@/*':['src/*']}}}),'frontend/src/main.ts':'import "@/barrel"; import("./tests/lazy.test.ts"); import "node:fs"; import "./style.css";','frontend/src/barrel.ts':'export {x} from "./tests/helper.test";','frontend/src/tests/helper.test.ts':'export const x=1;','frontend/src/tests/lazy.test.ts':'export const y=2;','frontend/src/tests/unused.test.ts':'export const unused=3;','frontend/tools/entry.ts':'export const tool=1;'});
 const graph=productionFiles(root,hashes);
 expect(classify('frontend/src/tests/helper.test.ts',graph)).toBe('executable');expect(classify('frontend/src/tests/lazy.test.ts',graph)).toBe('executable');expect(graph.has('frontend/src/tests/unused.test.ts')).toBe(false);
 for(const code of ['import(name);','require(name);','import.meta.glob("./tests/*.ts");','import "missing-package";']){fs.writeFileSync(path.join(root,'frontend/src/main.ts'),code);expect(productionFiles(root,hashes).has('frontend/src/tests/unused.test.ts')).toBe(true);}
 fs.writeFileSync(path.join(root,'frontend/src/main.ts'),'const =');expect(()=>productionFiles(root,hashes)).toThrow('Cannot parse');
 fs.writeFileSync(path.join(root,'frontend/index.html'),'<script src="/missing.ts"></script>');expect(()=>productionFiles(root,hashes)).toThrow('HTML');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('bound evaluation rejects stale execution, source replay and raw report replacement',async()=>{
 const root=directory();try{
 const file='frontend/example.ts';const filename=path.join(root,file);const hashes=fixture(root,{[file]:source});const expected=await inventory(source);const coverage={[filename]:hit(expected)};
 const before={scope:[{file,kind:'executable',deleted:false},{file:'removed.ts',kind:'executable',deleted:true},{file:'README.md',kind:'non-executable',deleted:false}],hashes,fingerprint:'new'};
 const collected={runId:'run-new',fingerprint:'new',sources:{[filename]:digest(source)},expected:{[filename]:expected},coverageSha256:digest(JSON.stringify(coverage))};
 expect(evaluate(root,before,before,coverage,collected,'run-new').passed).toBe(true);
 expect(()=>evaluate(root,before,before,coverage,{...collected,runId:'old'},'run-new')).toThrow('identity');
 expect(()=>evaluate(root,before,before,coverage,{...collected,fingerprint:'old'},'run-new')).toThrow('identity');
 expect(()=>evaluate(root,before,before,coverage,null,'run-new')).toThrow('identity');
 expect(()=>evaluate(root,before,before,coverage,{...collected,coverageSha256:'old'},'run-new')).toThrow('coverage mismatch');
 expect(()=>evaluate(root,before,{...before,fingerprint:'changed'},coverage,collected,'run-new')).toThrow('fingerprint');
 const different=source.replace('2','4');fs.writeFileSync(filename,different);
 const current={...before,hashes:{[file]:digest(different)}};
 expect(()=>evaluate(root,current,current,coverage,collected,'run-new')).toThrow('source mismatch');
 fs.writeFileSync(filename,source);
 coverage[filename].b[0][0]=0;collected.coverageSha256=digest(JSON.stringify(coverage));expect(evaluate(root,before,before,coverage,collected,'run-new').passed).toBe(false);
 expect(()=>evaluate(root,{...before,scope:[]},{...before,scope:[]},coverage,collected,'run-new')).toThrow('No executable');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('classification retains declarations, tests and unsupported Python scope',()=>{
 for(const [file,kind]of [['agent/new.py','blocked-python'],['agent/tests/test_x.py','test'],['frontend/a.d.ts','declaration'],['frontend/a.css','non-executable'],['frontend/a.ts','executable'],['frontend/a.test.ts','test']])expect(classify(file)).toBe(kind);
});
test('zero denominators are complete empty inventories, never missing reports',async()=>{
 const r=await inventory('export const x=1;');expect(analyze('a','export const x=1;',hit(r),r).functions.total).toBe(0);
});
test('snapshot binds baseline, untracked/deleted sources and rejects credentials and Python',()=>{
 const root=directory();const files={'frontend/index.html':'<script src="/src/main.ts"></script>','frontend/tsconfig.json':'{}','frontend/src/main.ts':'export const x=1;','.github/workflows/test.yml':'x'};
 try{fixture(root,files);
 const mock=vi.mocked(child.execFileSync);mock.mockImplementation((_cmd:any,args:any)=>{const c=args.slice(3);if(c[0]==='merge-base')return '' as any;if(c[0]==='rev-parse')return 'head\n' as any;if(c.includes('--diff-filter=D')||c.includes('--deleted'))return 'frontend/old.ts\0' as any;if(c[0]==='diff')return 'frontend/src/main.ts\0frontend/old.ts\0' as any;if(c.includes('--others'))return '' as any;return Object.keys(files).join('\0') as any;});
 const m=snapshot(root,DEBT_BASE);expect(m.fingerprint).toHaveLength(64);expect(m.hashes['frontend/old.ts']).toBeUndefined();expect(git(root,['rev-parse','HEAD'])).toBe('head\n');
 expect(()=>snapshot(root,'wrong')).toThrow('baseline');
 const original=mock.getMockImplementation()!;for(const name of ['frontend/.env','agent/new.py']){fixture(root,{[name]:'x'});mock.mockImplementation((cmd:any,args:any)=>args.includes('--others')?name+'\0' as any:original(cmd,args));expect(()=>snapshot(root,DEBT_BASE)).toThrow(name.endsWith('.py')?'Python':'Credential');}
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('graph cycles, data modules, declaration dependencies and missing inventory remain conservative',()=>{
 const root=directory();try{
 const hashes=fixture(root,{'frontend/index.html':'<script src="/src/main.ts"></script>','frontend/tsconfig.json':'{"compilerOptions":{"resolveJsonModule":true}}','frontend/src/main.ts':'import "./cycle"; import "./data.json"; import "typescript";','frontend/src/cycle.ts':'import "./main";','frontend/src/data.json':'{}','frontend/src/decl.d.ts':'export declare const x:number;','frontend/src/tests/unused.test.ts':'export const x=1;'});
 fs.symlinkSync(path.join(process.cwd(),'node_modules'),path.join(root,'frontend/node_modules'),'dir');
 expect(productionFiles(root,hashes).has('frontend/src/tests/unused.test.ts')).toBe(false);
 fs.appendFileSync(path.join(root,'frontend/src/main.ts'),'import "./decl";');expect(productionFiles(root,hashes).has('frontend/src/tests/unused.test.ts')).toBe(true);
 delete hashes['frontend/src/cycle.ts'];expect(productionFiles(root,hashes).has('frontend/src/tests/unused.test.ts')).toBe(true);
 fs.writeFileSync(path.join(root,'frontend/tsconfig.json'),'{');expect(()=>productionFiles(root,hashes)).toThrow('config');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('evaluation records genuine zero denominators',async()=>{
 const root=directory();try{const source='export const x=1;';const file='frontend/x.ts';const filename=path.join(root,file);const hashes=fixture(root,{[file]:source});const expected=await inventory(source);const coverage={[filename]:hit(expected)};const m={fingerprint:'f',hashes,scope:[{file,kind:'executable'}]};const c={runId:'r',fingerprint:'f',coverageSha256:digest(JSON.stringify(coverage)),sources:{[filename]:digest(source)},expected:{[filename]:expected}};
 expect(evaluate(root,m,m,coverage,c,'r').files[0].notApplicable.map((m:any)=>m.metric)).toEqual(['functions','branches']);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('snapshot ignores deleted bodies but rejects nonregular included paths',()=>{
 const root=directory();try{const files={'frontend/index.html':'<script src="/src/main.ts"></script>','frontend/tsconfig.json':'{}','frontend/src/main.ts':'export const x=1;'};fixture(root,files);
 vi.mocked(child.execFileSync).mockImplementation((_cmd:any,args:any)=>{const c=args.slice(3);if(c[0]==='merge-base')return '' as any;if(c[0]==='rev-parse')return 'head' as any;if(c.includes('--diff-filter=D')||c.includes('--deleted'))return 'frontend/old.ts\0' as any;if(c.includes('--others'))return '' as any;if(c[0]==='diff')return 'frontend/src/main.ts\0' as any;return [...Object.keys(files),'frontend/old.ts'].join('\0') as any;});
 expect(snapshot(root,DEBT_BASE).hashes['frontend/old.ts']).toBeUndefined();fs.rmSync(path.join(root,'frontend/src/main.ts'));fs.mkdirSync(path.join(root,'frontend/src/main.ts'));expect(()=>snapshot(root,DEBT_BASE)).toThrow('Non-regular');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('real V8 syntax executions agree with independent zero-function maps',async()=>{
 const actual=await vi.importActual<typeof import('node:child_process')>('node:child_process');
 const program=`
 import {Session} from 'node:inspector/promises';
 import vm from 'node:vm';
 import ts from 'typescript';
 import convert from 'ast-v8-to-istanbul';
 import {parseAstAsync} from 'vitest/node';
 const samples=['throw new Error("boom");','for(let i=0;i<2;i++){ Math.abs(i); }','class A { field=1; method(x=0){return x ? this.field : 2;} } new A().method(); new A().method(1);','const h=(...args)=>args; const C=({x})=><div>{x?.name ?? "empty"}</div>; C({}); C({x:{name:"ok"}});'];
 const session=new Session();session.connect();await session.post('Profiler.enable');await session.post('Profiler.startPreciseCoverage',{callCount:true,detailed:true});
 const result=[];
 for(let i=0;i<samples.length;i++){
 const filename='/tmp/quality-runtime-'+i+'.tsx';const url='file://'+filename;
 const transformed=ts.transpileModule(samples[i],{fileName:filename,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.React,jsxFactory:'h',sourceMap:true,inlineSources:true}});
 const map=JSON.parse(transformed.sourceMapText);map.sources=[url];
 try{vm.runInNewContext(transformed.outputText,{}, {filename:url});}catch(e){if(i!==0)throw e;}
 const raw=await session.post('Profiler.takePreciseCoverage');const execution=raw.result.find(x=>x.url===url);if(!execution)throw Error('Missing real execution');
 const options={code:transformed.outputText,sourceMap:map,ast:await parseAstAsync(transformed.outputText)};
 const expected=await convert({...options,coverage:{url,functions:[]}});const observed=await convert({...options,ast:await parseAstAsync(transformed.outputText),coverage:execution});
 result.push({source:samples[i],expected:Object.values(expected)[0],observed:Object.values(observed)[0]});
 }
 await session.post('Profiler.stopPreciseCoverage');session.disconnect();console.log(JSON.stringify(result));`;
 const samples=JSON.parse(actual.execFileSync(process.execPath,['--input-type=module','-e',program],{cwd:process.cwd(),encoding:'utf8'}));
 expect(samples).toHaveLength(4);for(const sample of samples){sameMaps('real syntax',sample.observed,sample.expected);expect(analyze('real syntax',sample.source,sample.observed,sample.expected).statements.total).toBeGreaterThan(0);}
});
test('deleting entries or arms from a captured real business report is rejected',()=>{
 const fixture=JSON.parse(fs.readFileSync('src/tests/fixtures/stock-coverage.json','utf8'));const code=fs.readFileSync('src/lib/stockResearch.ts','utf8');expect(digest(code)).toBe(fixture.sourceSha256);
 sameMaps('stockResearch',fixture.entry,fixture.expected);
 for(const mutate of [(r:any)=>{delete r.statementMap[0];delete r.s[0];},(r:any)=>{r.branchMap[0].locations.pop();r.b[0].pop();},(r:any)=>{r.branchMap[0].locations[0].start={line:999,column:-3};}]){const r=structuredClone(fixture.entry);mutate(r);expect(()=>analyze('stockResearch',code,r,fixture.expected)).toThrow('Complete');}
});
test('local declaration shadowing cannot hide runtime JavaScript in a test path',()=>{
 const root=directory();try{const hashes=fixture(root,{'frontend/index.html':'<script src="/src/main.ts"></script>','frontend/tsconfig.json':'{}','frontend/src/main.ts':'import "./tests/helper.js";','frontend/src/tests/helper.d.ts':'export declare const x:number;','frontend/src/tests/helper.js':'export const x=1;'});expect(classify('frontend/src/tests/helper.js',productionFiles(root,hashes))).toBe('executable');}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('node coverage ignore directives cannot shrink both converter inventories',async()=>{
 for(const source of ['/* node:coverage ignore next */\nexport function hidden(){return 1;}','/* node:coverage ignore file */\nexport function hidden(){return 1;}','/* node:coverage ignore start */\nexport function hidden(){return 1;}\n/* node:coverage ignore stop */']) {const expected=await inventory(source);expect(()=>analyze('ignored.ts',source,expected,expected)).toThrow('suppression');}
});
test('explicit runtime .js cannot be hidden by TypeScript resolving a sibling .ts',()=>{
 const root=directory();try{const hashes=fixture(root,{'frontend/index.html':'<script src="/src/main.ts"></script>','frontend/tsconfig.json':'{}','frontend/src/main.ts':'import "./tests/helper.js";','frontend/src/tests/helper.ts':'export const x=1;','frontend/src/tests/helper.js':'export const x=2;'});expect(classify('frontend/src/tests/helper.js',productionFiles(root,hashes))).toBe('executable');}finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('actual Vite modules reject test-path exemptions missed by a static alias resolver',()=>{
 const file='frontend/src/tests/runtime.ts';const m={fingerprint:'f',hashes:{[file]:'hash'},scope:[{file:'README.md',kind:'non-executable'}]};const p={fingerprint:'f',runId:'run',modules:['/repo/'+file,'/repo/frontend/src/main.ts','\0virtual']};
 expect(()=>verifyProduction('/repo',m,p,'run')).toThrow('Unmeasured');
 expect(()=>verifyProduction('/repo',m,{...p,runId:'old'},'run')).toThrow('Stale');
 expect(()=>verifyProduction('/repo',m,{...p,modules:[]},'run')).toThrow('Missing');
 for(const item of [{file,kind:'test'},{file,kind:'executable',deleted:true}])expect(()=>verifyProduction('/repo',{...m,scope:[item]},p,'run')).toThrow('Unmeasured');
 expect(()=>verifyProduction('/repo',{...m,scope:[{file,kind:'executable'}]},p,'run')).not.toThrow();
});
