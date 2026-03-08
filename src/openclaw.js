import { spawn } from 'node:child_process';

function buildArgs(args, profile) {
  const out = [];
  if (profile) out.push('--profile', profile);
  out.push(...args);
  return out;
}

export async function runOpenClaw({ bin = 'openclaw', profile = '', args = [] }) {
  const finalArgs = buildArgs(args, profile);

  return await new Promise((resolve) => {
    const p = spawn(bin, finalArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    p.stdout.on('data', (d) => (stdout += d.toString()));
    p.stderr.on('data', (d) => (stderr += d.toString()));

    p.on('close', (code) => {
      let parsed = null;
      try {
        parsed = stdout.trim() ? JSON.parse(stdout) : null;
      } catch {
        parsed = null;
      }

      resolve({
        ok: code === 0,
        code,
        stdout,
        stderr,
        data: parsed,
        command: [bin, ...finalArgs].join(' '),
      });
    });
  });
}
