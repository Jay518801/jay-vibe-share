import {afterEach,expect,test,vi} from 'vitest';
import * as fs from 'node:fs';
import * as child from 'node:child_process';
import * as gate from '../../tools/coverage-gate.ts';
import {runCommand,runQuality} from '../../tools/run-quality.ts';
vi.mock('node:fs',async original=>{const value={...await original<any>(),mkdirSync:vi.fn(),mkdtempSync:vi.fn(),readFileSync:vi.fn(),writeFileSync:vi.fn()};return {...value,default:value};});
vi.mock('node:child_process',async original=>{const actual=await original<any>();const value={...actual,execFileSync:vi.fn(actual.execFileSync)};return {...value,default:value};});
vi.mock('../../tools/coverage-gate.ts',()=>({DEBT_BASE:'baseline',digest:vi.fn(()=> 'hash'),snapshot:vi.fn(),evaluate:vi.fn(),verifyProduction:vi.fn()}));
afterEach(()=>vi.resetAllMocks());
test.each([true,false])('runner binds a fresh run and successful subprocess receipts: %s',passed=>{
 vi.spyOn(console,'log').mockImplementation(()=>{});vi.mocked(fs.mkdtempSync).mockReturnValue('/tmp/quality-run');
 vi.mocked(gate.snapshot).mockReturnValue({fingerprint:'source',scope:[{file:'frontend/tools/new.ts',kind:'executable'},{file:'deleted.ts',kind:'executable',deleted:true},{file:'readme.md',kind:'non-executable'}]});
 vi.mocked(gate.evaluate).mockReturnValue({passed,totals:{}});vi.mocked(fs.readFileSync).mockReturnValue('{"version":"locked"}');vi.mocked(child.execFileSync).mockReturnValue('' as any);
 const report=runQuality('/repo');expect(report.passed).toBe(passed);expect(report.commands).toHaveLength(4);expect(report.commands.every((c:any)=>c.exitCode===0)).toBe(true);
 expect(child.execFileSync).toHaveBeenCalledWith(expect.anything(),expect.arrayContaining(['--coverage.include=tools/new.ts']),expect.objectContaining({env:expect.objectContaining({QUALITY_RUN_DIR:'/tmp/quality-run',QUALITY_RUN_ID:report.runId})}));
 expect(fs.writeFileSync).toHaveBeenLastCalledWith('/tmp/quality-run/report.json',expect.stringContaining('collectionSha256'));
});
test('real child failures and signals cannot return successful receipts',async()=>{
 const actual=await vi.importActual<typeof import('node:child_process')>('node:child_process');vi.mocked(child.execFileSync).mockImplementation(actual.execFileSync);
 expect(runCommand(process.execPath,['-e','process.exit(0)'],{stdio:'pipe'}).exitCode).toBe(0);
 for(const code of ['process.exit(23)','process.kill(process.pid,"SIGTERM")'])expect(()=>runCommand(process.execPath,['-e',code],{stdio:'pipe'})).toThrow();
});
test('runner never writes a final report after child failure',()=>{
 vi.mocked(fs.mkdtempSync).mockReturnValue('/tmp/quality-run');vi.mocked(gate.snapshot).mockReturnValue({fingerprint:'source',scope:[]});
 vi.mocked(child.execFileSync).mockImplementation(()=>{throw new Error('child failed');});expect(()=>runQuality('/repo')).toThrow('child failed');expect(gate.evaluate).not.toHaveBeenCalled();expect(vi.mocked(fs.writeFileSync).mock.calls.some(c=>String(c[0]).endsWith('report.json'))).toBe(false);
});
test.each([true,false])('CLI entry propagates gate verdict: %s',async passed=>{
 vi.resetModules();vi.spyOn(console,'log').mockImplementation(()=>{});vi.mocked(fs.mkdtempSync).mockReturnValue('/tmp/quality-run');vi.mocked(gate.snapshot).mockReturnValue({fingerprint:'source',scope:[]});vi.mocked(gate.evaluate).mockReturnValue({passed,totals:{}});vi.mocked(fs.readFileSync).mockReturnValue('{"version":"locked"}');vi.mocked(child.execFileSync).mockReturnValue('' as any);
 const previous=process.argv[1];const exitCode=process.exitCode;process.argv[1]=process.cwd()+'/tools/run-quality.ts';
 try{await import('../../tools/run-quality.ts');expect(process.exitCode??0).toBe(passed?0:1);}finally{process.argv[1]=previous;process.exitCode=exitCode;}
});
test('import without an entry argument does not execute gate',async()=>{
 vi.resetModules();const previous=process.argv[1];delete process.argv[1];try{await import('../../tools/run-quality.ts');expect(gate.snapshot).not.toHaveBeenCalled();}finally{process.argv[1]=previous;}
});
