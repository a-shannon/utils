import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * Build and import the public package entry with Node's native ESM loader.
 * @returns Names and runtime types of the adapter's public exports
 */
export const importBuiltIndex = (): string[][] => {
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  const compiler = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  execFileSync(
    process.execPath,
    [
      compiler,
      '--project',
      'tsconfig.build.json',
      '--incremental',
      'false',
      '--composite',
      'false',
    ],
    { cwd: packageRoot },
  );

  const environment = { ...process.env };
  delete environment.NODE_OPTIONS;
  const entry = new URL('../dist/index.js', import.meta.url);
  const result = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const entry = await import(${JSON.stringify(entry.href)});
console.log(JSON.stringify(['DataSource', 'BigIntValueTransformer'].map((name) => [name, typeof entry[name]])));`,
    ],
    { cwd: packageRoot, env: environment, encoding: 'utf8' },
  );
  return JSON.parse(result);
};
