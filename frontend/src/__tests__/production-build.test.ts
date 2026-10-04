import {afterEach,expect,test,vi} from 'vitest';
import * as fs from 'node:fs';
import {build} from 'vite';
import {productionBuild} from '../../tools/production-build.ts';
vi.mock('vite',()=>({build:vi.fn()}));
vi.mock('node:fs',()=>{const value={readFileSync:vi.fn(),writeFileSync:vi.fn()};return {...value,default:value};});
afterEach(()=>{vi.resetAllMocks();vi.unstubAllEnvs();});
function setup(){vi.stubEnv('QUALITY_RUN_ID','run');vi.stubEnv('QUALITY_RUN_DIR','/out');vi.mocked(fs.readFileSync).mockReturnValue('{"runId":"run","fingerprint":"f"}');vi.mocked(build).mockImplementation(async (options:any)=>{options.plugins[0].generateBundle.call({getModuleIds:()=>['/repo/a.ts?query','/repo/b.ts']});return {} as any;});}
test('real build plugin records runtime resolved module identities bound to this run',async()=>{setup();await productionBuild('/out');expect(fs.writeFileSync).toHaveBeenCalledWith('/out/production.json',expect.stringContaining('"modules":["/repo/a.ts","/repo/b.ts"]'),{flag:'wx'});});
test('build failure, missing graph and stale identity cannot emit evidence',async()=>{setup();vi.stubEnv('QUALITY_RUN_ID','other');await expect(productionBuild('/out')).rejects.toThrow('identity');vi.stubEnv('QUALITY_RUN_ID','run');vi.mocked(build).mockRejectedValueOnce(new Error('build failed'));await expect(productionBuild('/out')).rejects.toThrow('build failed');vi.mocked(build).mockResolvedValueOnce({} as any);await expect(productionBuild('/out')).rejects.toThrow('Missing');expect(fs.writeFileSync).not.toHaveBeenCalled();});
test('CLI executes the production build and bare imports do not',async()=>{setup();const previous=process.argv[1];try{vi.resetModules();process.argv[1]=process.cwd()+'/tools/production-build.ts';await import('../../tools/production-build.ts');expect(build).toHaveBeenCalledOnce();vi.resetModules();delete process.argv[1];await import('../../tools/production-build.ts');expect(build).toHaveBeenCalledOnce();}finally{process.argv[1]=previous;}});
