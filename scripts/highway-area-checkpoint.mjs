import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Replay completed solves against the exact same model, rebuilding all cuts
// through the normal validation path. This does not resume an in-flight MIP's
// branch-and-bound tree or turn a time-limited result into a proven optimum.
export function checkpointHighwayAreaSolver(solve, directory) {
  return async (model, options, incumbent) => {
    const digest = createHash('sha256')
      .update(JSON.stringify({ version: 1, model, options }))
      .digest('hex');
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${digest}.json`);
    try {
      const saved = JSON.parse(await readFile(path, 'utf8'));
      if (saved.digest !== digest || !saved.solution?.Columns)
        throw new Error(`Invalid area solver checkpoint: ${path}`);
      return saved.solution;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const solution = await solve(model, options, incumbent);
    if (
      ['Optimal', 'Time limit reached'].includes(solution.Status) &&
      solution.Columns
    ) {
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ digest, solution }));
      await rename(temporary, path);
    }
    return solution;
  };
}
