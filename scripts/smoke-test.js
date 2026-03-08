import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitFor(check, timeoutMs, label) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await check();
    } catch (error) {
      lastError = error;
      await delay(150);
    }
  }

  const reason = lastError ? `${label}: ${lastError.message}` : label;
  throw new Error(`Timed out waiting for ${reason}`);
}

async function waitForServer(port, apiKey) {
  return await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      cache: 'no-store',
      headers: {
        'x-api-key': apiKey,
      },
    });

    if (!response.ok) {
      throw new Error(`server returned HTTP ${response.status}`);
    }

    return await response.json();
  }, 12_000, 'backend server');
}

async function waitForStatusMessage(url) {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timeoutId = setTimeout(() => {
      ws.close();
      reject(new Error('Timed out waiting for websocket status message'));
    }, 8_000);

    ws.addEventListener('message', (event) => {
      const payload = JSON.parse(String(event.data));
      if (payload.type !== 'status') {
        return;
      }

      clearTimeout(timeoutId);
      ws.close();
      resolve(payload);
    });

    ws.addEventListener('error', () => {
      clearTimeout(timeoutId);
      reject(new Error('WebSocket connection failed'));
    });
  });
}

async function main() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const cwd = path.join(__dirname, '..');
  const serverPath = path.join(cwd, 'src', 'server.js');
  const mockOpenclawPath = path.join(__dirname, 'mock-openclaw.js');
  const apiKey = 'backend-test-key';
  const port = await getFreePort();
  const stdout = [];
  const stderr = [];

  await chmod(mockOpenclawPath, 0o755);

  const child = spawn(process.execPath, [serverPath], {
    cwd,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      API_KEY: apiKey,
      REQUIRE_API_KEY: 'true',
      OPENCLAW_BIN: mockOpenclawPath,
      CORS_ORIGIN: 'http://127.0.0.1:4173',
      WS_STATUS_INTERVAL_MS: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => stdout.push(chunk.toString()));
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()));

  try {
    const healthPayload = await waitForServer(port, apiKey);
    assert.equal(healthPayload.ok, true);

    const unauthorizedHealthResponse = await fetch(`http://127.0.0.1:${port}/health`, {
      cache: 'no-store',
    });
    assert.equal(unauthorizedHealthResponse.status, 401);

    const optionsResponse = await fetch(`http://127.0.0.1:${port}/api/openclaw/status`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://127.0.0.1:4173',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'x-api-key',
      },
    });
    assert.equal(optionsResponse.status, 204);
    assert.match(
      optionsResponse.headers.get('access-control-allow-headers') || '',
      /x-api-key/i,
    );

    const statusResponse = await fetch(`http://127.0.0.1:${port}/api/openclaw/status`, {
      cache: 'no-store',
      headers: {
        'x-api-key': apiKey,
      },
    });
    assert.equal(statusResponse.status, 200);
    const statusPayload = await statusResponse.json();
    assert.equal(statusPayload.ok, true);
    assert.equal(statusPayload.data.zone, 'rest');
    assert.equal(statusPayload.data.taskCount, 2);
    assert.equal(statusPayload.data.openclaw.summary.cronJobs, 2);

    const statsResponse = await fetch(`http://127.0.0.1:${port}/api/tasks/stats`, {
      cache: 'no-store',
      headers: {
        'x-api-key': apiKey,
      },
    });
    assert.equal(statsResponse.status, 200);
    const statsPayload = await statsResponse.json();
    assert.equal(statsPayload.data.totalSessions, 2);
    assert.equal(statsPayload.data.totalCronJobs, 2);

    const runtimeResponse = await fetch(`http://127.0.0.1:${port}/api/tasks/runtime`, {
      cache: 'no-store',
      headers: {
        'x-api-key': apiKey,
      },
    });
    assert.equal(runtimeResponse.status, 200);
    const runtimePayload = await runtimeResponse.json();
    assert.equal(runtimePayload.data.openclawHealthy, true);

    const wsPayload = await waitForStatusMessage(
      `ws://127.0.0.1:${port}/ws/openclaw/status?apiKey=${apiKey}`,
    );
    assert.equal(wsPayload.data.zone, 'rest');
    assert.equal(wsPayload.data.openclaw.tasks.totalCronJobs, 2);
  } finally {
    child.kill('SIGINT');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      delay(2_000).then(() => {
        child.kill('SIGKILL');
      }),
    ]);
  }

  if (child.exitCode && child.exitCode !== 0) {
    throw new Error(
      `Backend server exited early.\nstdout:\n${stdout.join('')}\nstderr:\n${stderr.join('')}`,
    );
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
