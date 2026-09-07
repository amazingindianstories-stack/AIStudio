import dotenv from 'dotenv';
import { writeFile, mkdir } from 'node:fs/promises';
import sharp from 'sharp';
import { generateImageSeedream } from '../src/lib/providers/seedream';
async function main() {
dotenv.config({ path: process.env.SEEDREAM_ENV_FILE, quiet: true });
if (process.env.ARK_BASE_URL === '[SENSITIVE]') delete process.env.ARK_BASE_URL;
const dir = '/private/tmp/seedream-live';
await mkdir(dir, { recursive: true });
const start = Date.now();
try {
 const bytes = await generateImageSeedream({ prompt: 'A studio photograph of a blue ceramic teapot with delicate gold floral engraving and a red silk ribbon on a pale gray table. Small printed card reads DETAIL TEST 07. Side lighting, intricate surface details, sharp focus.', resolution: '2K', aspectRatio: '1:1' }, { signal: AbortSignal.timeout(240000) });
 await writeFile(`${dir}/text-2k.png`, bytes);
 const {width,height,format}=await sharp(bytes).metadata();
 const result={case:'text-2k',width,height,format,latencyMs:Date.now()-start,estimatedUsd:0.09};
 await writeFile(`${dir}/first-result.json`,JSON.stringify(result,null,2)); console.log(result);
} catch(e) { console.log({failed:true,error:e.message,latencyMs:Date.now()-start});process.exitCode=1; }

}
main();
