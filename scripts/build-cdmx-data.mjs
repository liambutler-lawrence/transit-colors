import { fileURLToPath } from 'node:url';

import { main } from './cdmx/build.mjs';

export * from './cdmx/build.mjs';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
