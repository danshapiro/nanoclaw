import { createRequire } from 'node:module';

const [playwriterEntryPoint] = process.argv.slice(2);
if (!playwriterEntryPoint) {
  throw new Error('Playwriter entry point is required');
}

const requireFromPlaywriter = createRequire(playwriterEntryPoint);
let foundOptionalDependency = false;

for (const dependency of ['@playwriter/patchright-core', 'sharp']) {
  try {
    const resolved = requireFromPlaywriter.resolve(dependency);
    console.error(`Optional Playwriter dependency resolves at runtime: ${dependency} -> ${resolved}`);
    foundOptionalDependency = true;
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND') {
      throw error;
    }
  }
}

if (foundOptionalDependency) {
  process.exitCode = 1;
}
