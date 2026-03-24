import { mkdir, rm, copyFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const targets = [
  {
    id: 'linux-x64',
    pkgTarget: 'node18-linux-x64',
    binaryName: 'cpa-authfile-cleaner',
    archiveName: 'cpa-authfile-cleaner-linux-x64.tar.gz'
  },
  {
    id: 'linux-arm64',
    pkgTarget: 'node18-linux-arm64',
    binaryName: 'cpa-authfile-cleaner',
    archiveName: 'cpa-authfile-cleaner-linux-arm64.tar.gz'
  },
  {
    id: 'win-x64',
    pkgTarget: 'node18-win-x64',
    binaryName: 'cpa-authfile-cleaner.exe',
    archiveName: 'cpa-authfile-cleaner-win-x64.zip'
  }
];

const requestedTargetIds = parseRequestedTargets(process.argv.slice(2));
const selectedTargets = requestedTargetIds.length === 0 ? targets : targets.filter((target) => requestedTargetIds.includes(target.id));

if (selectedTargets.length === 0) {
  throw new Error(`No matching targets. Available targets: ${targets.map((target) => target.id).join(', ')}`);
}

await rm(join(root, 'build'), { recursive: true, force: true });
await rm(join(root, 'releases'), { recursive: true, force: true });
await rm(join(root, 'release-bundles'), { recursive: true, force: true });
await mkdir(join(root, 'build'), { recursive: true });
await mkdir(join(root, 'releases'), { recursive: true });
await mkdir(join(root, 'release-bundles'), { recursive: true });

await run('npx', [
  'esbuild',
  'src/index.ts',
  '--bundle',
  '--platform=node',
  '--format=cjs',
  '--target=node18',
  '--outfile=build/index.cjs'
]);

await run('npx', [
  'pkg',
  'build/index.cjs',
  '-t',
  selectedTargets.map((target) => target.pkgTarget).join(','),
  '--no-bytecode',
  '--public',
  '--out-path',
  'releases'
]);

for (const target of selectedTargets) {
  const bundleDir = join(root, 'release-bundles', target.id);
  await mkdir(bundleDir, { recursive: true });

  const pkgOutputName = getPkgOutputName(target.id, selectedTargets.length);
  const pkgOutputPath = join(root, 'releases', pkgOutputName);
  const binaryPath = join(bundleDir, target.binaryName);

  if (!existsSync(pkgOutputPath)) {
    throw new Error(`Missing packaged binary: ${pkgOutputPath}`);
  }

  await copyFile(pkgOutputPath, binaryPath);
  await copyFile(join(root, 'cleaner.config.example.json'), join(bundleDir, 'cleaner.config.example.json'));
  await writeFile(join(bundleDir, 'README.txt'), renderBundleReadme(target.binaryName), 'utf8');

  if (target.id === 'win-x64') {
    await run('zip', ['-j', join(root, target.archiveName), binaryPath, join(bundleDir, 'cleaner.config.example.json'), join(bundleDir, 'README.txt')]);
  } else {
    await run('tar', ['-czf', join(root, target.archiveName), '-C', bundleDir, '.']);
  }
}

function renderBundleReadme(binaryName) {
  return [
    'Usage:',
    `${binaryName} --help`,
    '',
    'Copy cleaner.config.example.json to cleaner.config.json, then run the executable.',
    '',
    'Management key can also be provided with MANAGEMENT_KEY.'
  ].join('\n');
}

async function run(command, args) {
  await execFileAsync(command, args, {
    cwd: root,
    env: {
      ...process.env,
      PKG_CACHE_PATH: join(root, 'pkg-cache')
    }
  });
}

function parseRequestedTargets(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--target') {
      return splitTargets(argv[i + 1] ?? '');
    }
    if (arg.startsWith('--target=')) {
      return splitTargets(arg.slice('--target='.length));
    }
  }
  return [];
}

function splitTargets(value) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function getPkgOutputName(targetId, targetCount) {
  if (targetCount === 1) {
    return targetId === 'win-x64' ? 'index.exe' : 'index';
  }
  return `index-${targetId}${targetId === 'win-x64' ? '.exe' : ''}`;
}
