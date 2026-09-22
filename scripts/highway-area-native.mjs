import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function nativeHighwayAreaSolver(python) {
  return async (model, options, incumbentColumns) => {
    const directory = await mkdtemp(join(tmpdir(), 'highway-area-'));
    try {
      const input = join(directory, 'model.lp');
      const output = join(directory, 'solution.json');
      await writeFile(input, model);
      const args = [
        fileURLToPath(new URL('./highway-area-native.py', import.meta.url)),
        input,
        output,
        String(options.time_limit),
      ];
      if (incumbentColumns) {
        const seed = join(directory, 'incumbent.json');
        await writeFile(seed, JSON.stringify(incumbentColumns));
        args.push(seed);
      }
      const process = spawn(python, args, { stdio: 'inherit' });
      const [code] = await once(process, 'exit');
      if (code !== 0) throw new Error(`Native highway area solver exited with ${code}`);
      return JSON.parse(await readFile(output, 'utf8'));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}
