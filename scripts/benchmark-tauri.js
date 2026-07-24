'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const root = path.resolve(__dirname, '..');
const runsArg = process.argv.find((argument) => argument.startsWith('--runs='));
const runCount = Number(runsArg?.split('=')[1] || 10);
const skipBuild = process.argv.includes('--skip-build');
const oldRendererKb = 543.50;
const env = { ...process.env };

if (!Number.isInteger(runCount) || runCount < 3) {
  throw new Error('--runs must be an integer of at least 3');
}

if (process.platform === 'win32') {
  const required = [
    String.raw`C:\msys64\mingw64\bin`,
    String.raw`C:\Program Files\Rust stable GNU 1.97\bin`,
  ];
  const pathKeys = Object.keys(env).filter((key) => key.toLowerCase() === 'path');
  const currentPath = pathKeys.map((key) => env[key]).find(Boolean) || '';
  const existing = currentPath.split(path.delimiter).filter((entry) => entry && !required.includes(entry));
  for (const key of pathKeys) delete env[key];
  env.PATH = [...required, ...existing].join(path.delimiter);
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function formatMb(bytes) {
  return bytes / 1024 / 1024;
}

function rendererChunkSize() {
  const assets = path.join(root, 'dist-tauri', 'assets');
  const renderer = fs.readdirSync(assets).find((name) => /^renderer-.*\.js$/.test(name));
  if (!renderer) throw new Error('renderer chunk was not found; run the frontend build first');
  return { name: renderer, bytes: fs.statSync(path.join(assets, renderer)).size };
}

function readRss(pid) {
  if (process.platform === 'win32') {
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).WorkingSet64`],
      { encoding: 'utf8', windowsHide: true },
    );
    const bytes = Number(result.stdout.trim());
    if (!Number.isFinite(bytes)) throw new Error(`could not read RSS for process ${pid}`);
    return bytes;
  }
  const result = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' });
  const kib = Number(result.stdout.trim());
  if (!Number.isFinite(kib)) throw new Error(`could not read RSS for process ${pid}`);
  return kib * 1024;
}

function measureOnce(executable, index) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(executable, ['--performance-test'], {
      cwd: root,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let coldMs;
    let inputSamples;
    let renderer;
    let rssBytes;
    let rssTimer;
    let settled = false;

    const finish = () => {
      if (settled || coldMs === undefined || !inputSamples || rssBytes === undefined) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      process.stdout.write(`  run ${String(index + 1).padStart(2)}: ${coldMs.toFixed(1)} ms cold, ${formatMb(rssBytes).toFixed(1)} MB RSS\r`);
      resolve({ coldMs, inputSamples, rssBytes, renderer });
    };

    const consume = (chunk) => {
      stdout += chunk;
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop();
      for (const line of lines) {
        const marker = line.indexOf('TAURI_PERF ');
        if (marker < 0) continue;
        const message = JSON.parse(line.slice(marker + 'TAURI_PERF '.length));
        if (message.kind === 'prompt' && coldMs === undefined) {
          coldMs = performance.now() - startedAt;
          renderer = message.result.renderer;
          rssTimer = setTimeout(() => {
            try {
              rssBytes = readRss(child.pid);
              finish();
            } catch (error) {
              reject(error);
            }
          }, 1000);
        } else if (message.kind === 'input') {
          inputSamples = message.result.samples;
          finish();
        }
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', consume);
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(rssTimer);
      if (!settled) reject(new Error(`benchmark app exited early (${code}): ${stderr.trim()}`));
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`benchmark run timed out: ${stderr.trim()}`));
    }, 20000);
  });
}

async function main() {
  if (!skipBuild) {
    run(process.execPath, [path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'), 'build']);
  }
  const executable = path.join(
    root,
    'src-tauri',
    'target',
    'release',
    process.platform === 'win32' ? 'cupertino-terminal.exe' : 'cupertino-terminal',
  );
  if (!fs.existsSync(executable)) throw new Error(`built Tauri executable not found: ${executable}`);

  console.log(`Measuring ${runCount} isolated Tauri launches...`);
  const results = [];
  for (let index = 0; index < runCount; index += 1) {
    results.push(await measureOnce(executable, index));
  }
  process.stdout.write('\n');

  const cold = results.map((result) => result.coldMs);
  const input = results.flatMap((result) => result.inputSamples);
  const rss = results.map((result) => result.rssBytes);
  const chunk = rendererChunkSize();
  const rows = [
    {
      Metric: 'Cold start → interactive prompt',
      Median: percentile(cold, 0.5).toFixed(1),
      P95: percentile(cold, 0.95).toFixed(1),
      Unit: 'ms',
    },
    {
      Metric: 'Synthetic keydown → xterm write commit',
      Median: percentile(input, 0.5).toFixed(3),
      P95: percentile(input, 0.95).toFixed(3),
      Unit: 'ms',
    },
    {
      Metric: 'Idle app-process RSS (+1 second)',
      Median: formatMb(percentile(rss, 0.5)).toFixed(1),
      P95: formatMb(percentile(rss, 0.95)).toFixed(1),
      Unit: 'MB',
    },
    {
      Metric: `Initial renderer chunk (${chunk.name})`,
      Median: (chunk.bytes / 1000).toFixed(2),
      P95: `old ${oldRendererKb.toFixed(2)}`,
      Unit: 'kB',
    },
  ];
  console.table(rows);
  console.log(`Renderer: ${[...new Set(results.map((result) => result.renderer))].join(', ')} (DOM fallback retained)`);

  const coldP95 = percentile(cold, 0.95);
  if (coldP95 < 500) console.log(`SOFT GATE PASS: cold-start p95 ${coldP95.toFixed(1)} ms < 500 ms`);
  else console.warn(`SOFT GATE WARNING: cold-start p95 ${coldP95.toFixed(1)} ms >= 500 ms`);
  const inputP95 = percentile(input, 0.95);
  if (inputP95 < 16) console.log(`INPUT TARGET PASS: p95 ${inputP95.toFixed(3)} ms < 16 ms`);
  else console.warn(`INPUT TARGET WARNING: p95 ${inputP95.toFixed(3)} ms >= 16 ms`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
