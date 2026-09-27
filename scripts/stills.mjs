// node stills.mjs 30 110 200 ...  -> out/stills/fNNNN.png (half size) + out/contact.png. COMP=<id> to pick a composition.
import {bundle} from '@remotion/bundler';
import {renderStill, selectComposition, getCompositions} from '@remotion/renderer';
import {execSync} from 'node:child_process';
import path from 'node:path';
const chromiumOptions = {gl: 'angle'}; // real GPU WebGL; the default swiftshader can't create a context for three.js
const serveUrl = await bundle({entryPoint: path.resolve('src/index.ts')});
const id = process.env.COMP || (await getCompositions(serveUrl, {chromiumOptions}))[0].id;
const composition = await selectComposition({serveUrl, id, chromiumOptions});
execSync('rm -f out/stills/*.png && mkdir -p out/stills');
for (const f of process.argv.slice(2).map(Number)) {
  await renderStill({composition, serveUrl, frame: f, output: `out/stills/f${String(f).padStart(4, '0')}.png`, scale: 0.5, chromiumOptions});
}
execSync(`ffmpeg -v error -y -pattern_type glob -i 'out/stills/f*.png' -filter_complex "scale=640:-1,tile=3x${Math.ceil((process.argv.length - 2) / 3)}:padding=4:color=gray" -frames:v 1 out/contact.png`);
console.log('out/contact.png');
