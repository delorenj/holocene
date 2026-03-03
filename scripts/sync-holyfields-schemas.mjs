import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.resolve(__dirname, '..');
const sourceRoot = path.resolve(projectRoot, '../holyfields/schemas');
const targetRoot = path.resolve(projectRoot, 'src/web/data/holyfields-schemas');

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyJsonTree(srcDir, dstDir) {
  await fs.mkdir(dstDir, { recursive: true });
  const entries = await fs.readdir(srcDir, { withFileTypes: true });

  let copied = 0;

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);

    if (entry.isDirectory()) {
      copied += await copyJsonTree(srcPath, dstPath);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }

    await fs.mkdir(path.dirname(dstPath), { recursive: true });
    await fs.copyFile(srcPath, dstPath);
    copied += 1;
  }

  return copied;
}

async function main() {
  const sourceExists = await exists(sourceRoot);

  if (!sourceExists) {
    console.warn(`[schemas:sync] Source not found: ${sourceRoot}`);
    console.warn('[schemas:sync] Keeping existing vendored schemas.');
    return;
  }

  await fs.rm(targetRoot, { recursive: true, force: true });
  const copied = await copyJsonTree(sourceRoot, targetRoot);

  const manifest = {
    sourceRoot,
    generatedAt: new Date().toISOString(),
    schemaCount: copied,
  };

  await fs.writeFile(
    path.join(targetRoot, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8'
  );

  console.log(`[schemas:sync] Synced ${copied} schema files to ${targetRoot}`);
}

main().catch((error) => {
  console.error('[schemas:sync] Failed:', error);
  process.exit(1);
});
