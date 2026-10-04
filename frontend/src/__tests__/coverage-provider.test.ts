import {afterEach,expect,test,vi} from 'vitest';
import * as fs from 'node:fs';
import {V8CoverageProvider} from '@vitest/coverage-v8/dist/provider.js';
import provider,{BoundProvider} from '../../tools/coverage-provider.ts';
vi.mock('@vitest/coverage-v8',()=>({default:{}}));
vi.mock('@vitest/coverage-v8/dist/provider.js',()=>({V8CoverageProvider:class {options={reportsDirectory:'/coverage'};async remapCoverage(){} async generateReports(){} }}));
vi.mock('node:fs',()=>{const value={readFileSync:vi.fn(),writeFileSync:vi.fn()};return {...value,default:value};});
afterEach(()=>{vi.resetAllMocks();vi.unstubAllEnvs();});
const empty={statementMap:{},s:{},fnMap:{},f:{},branchMap:{},b:{}};
function setup(){vi.spyOn(V8CoverageProvider.prototype,'remapCoverage').mockResolvedValue({'/a.ts':empty});vi.mocked(fs.readFileSync).mockReturnValue('source');return new BoundProvider();}
test('provider binds source contents and complete maps across conversions',async()=>{
 const p=setup();const result={map:{sources:['file:///a.ts'],sourcesContent:['source']},code:'source'};
 expect(await p.remapCoverage('file:///a.ts',0,result,[])).toEqual({'/a.ts':empty});await p.remapCoverage('file:///a.ts',0,result,[]);expect(p.sources['/a.ts']).toHaveLength(64);expect(provider.getProvider()).toBeInstanceOf(BoundProvider);
 await expect(p.remapCoverage('file:///a.ts',0,{code:''},[])).rejects.toThrow('Missing source');
 await expect(p.remapCoverage('file:///a.ts',0,{map:{sources:['file:///a.ts'],sourcesContent:['old']}},[])).rejects.toThrow('Transformed source');
});
test('provider refuses dropped conversions and mismatched file sets',async()=>{
 const p=setup();const result={map:{sources:['file:///a.ts'],sourcesContent:['source']}};
 vi.mocked(V8CoverageProvider.prototype.remapCoverage).mockResolvedValue({});await expect(p.remapCoverage('file:///a.ts',0,result,[])).rejects.toThrow('Empty conversion');
 vi.mocked(V8CoverageProvider.prototype.remapCoverage).mockResolvedValueOnce({'/a.ts':empty}).mockResolvedValueOnce({});await expect(p.remapCoverage('file:///a.ts',0,result,[])).rejects.toThrow('Converted file');
});
test('collector writes exclusively after reports and checks run identity',async()=>{
 const p=setup();vi.stubEnv('QUALITY_RUN_DIR','/run');vi.stubEnv('QUALITY_RUN_ID','new');
 vi.mocked(fs.readFileSync).mockImplementation((file:any)=>String(file).endsWith('request.json')?JSON.stringify({runId:'new',fingerprint:'source'}):'{}');
 await p.generateReports({},true);expect(fs.writeFileSync).toHaveBeenCalledWith('/run/collected.json',expect.stringContaining('coverageSha256'),{flag:'wx'});
 vi.stubEnv('QUALITY_RUN_ID','old');await expect(p.generateReports({},true)).rejects.toThrow('identity');
});
test('configured class-method exclusions cannot shrink both inventories',async()=>{
 const p=setup();const result={map:{sources:['file:///a.ts'],sourcesContent:['source']}};
 p.options.ignoreClassMethods=[];await expect(p.remapCoverage('file:///a.ts',0,result,[])).resolves.toEqual({'/a.ts':empty});
 p.options.ignoreClassMethods=['remapCoverage','generateReports'];await expect(p.remapCoverage('file:///a.ts',0,result,[])).rejects.toThrow('exclusions forbidden');
});
test('real provider rejects method exclusions before both conversions can shrink',async()=>{
 const {execFileSync}=await vi.importActual<typeof import('node:child_process')>('node:child_process');
 const program=`import {BoundProvider} from './tools/coverage-provider.ts';import ts from 'typescript';import {readFileSync} from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
 const file=path.resolve('tools/coverage-provider.ts');const url=pathToFileURL(file).href;const source=readFileSync(file,'utf8');const transformed=ts.transpileModule(source,{fileName:file,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,sourceMap:true,inlineSources:true}});const map=JSON.parse(transformed.sourceMapText);map.sources=[url];const p=new BoundProvider();p.options={};const complete=await p.remapCoverage(url,0,{code:transformed.outputText,map},[]);p.options.ignoreClassMethods=['remapCoverage','generateReports'];try{await p.remapCoverage(url,0,{code:transformed.outputText,map},[]);throw Error('Exclusion accepted');}catch(e){if(!e.message.includes('exclusions forbidden'))throw e;}console.log(Object.keys(complete[file].fnMap).length);`;
 expect(Number(execFileSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',program],{cwd:process.cwd(),encoding:'utf8'}).trim())).toBeGreaterThan(1);
});
