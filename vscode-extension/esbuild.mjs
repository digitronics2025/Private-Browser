import { build } from 'esbuild';

await Promise.all([
  build({ entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], outfile: 'dist/extension.cjs', sourcemap: true }),
  build({ entryPoints: ['src/playwright-runner.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20', outfile: 'dist/playwright-runner.cjs' }),
]);
