import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const BOOT_ID = `${process.pid}-${Date.now()}`;
const RESTART_PATH = '/dsh-restart/restart';
const STATUS_PATH = '/dsh-restart/status';
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const LOG_PATH = join(DSH_HOME, 'dsh-restart-harness.log');
const PENDING_SESSION_PATH = join(DSH_HOME, 'dsh-restart-harness.session.json');
const HELPER_PATH = fileURLToPath(new URL('./restart-helper.cjs', import.meta.url));
const PENDING_SESSION_MAX_AGE_MS = 10 * 60 * 1000;

function recoveryMessage(reason) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: `DeepSeek Harness has restarted successfully and this session has been restored. Restart reason: ${reason}\nPlease inspect the unfinished work from the previous turn and continue.` }],
    source: { kind: 'plugin', plugin: 'dsh-restart-harness', form: 'notice', summary: 'Harness restarted; session restored' }
  };
}

function log(message, data) {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true });
    const suffix = data === undefined ? '' : ` ${JSON.stringify(data)}`;
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] host ${message}${suffix}\n`, 'utf8');
  } catch {}
}

function readPendingSession() {
  try {
    const pending = JSON.parse(readFileSync(PENDING_SESSION_PATH, 'utf8'));
    if (pending === null || typeof pending !== 'object') return null;
    if (typeof pending.sessionId !== 'string' || pending.sessionId.length === 0) return null;
    if (typeof pending.requestedAt !== 'number' || Date.now() - pending.requestedAt > PENDING_SESSION_MAX_AGE_MS) {
      unlinkSync(PENDING_SESSION_PATH);
      return null;
    }
    return pending;
  } catch {
    return null;
  }
}

function writePendingSession(value) {
  mkdirSync(dirname(PENDING_SESSION_PATH), { recursive: true });
  const temporary = `${PENDING_SESSION_PATH}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), 'utf8');
  renameSync(temporary, PENDING_SESSION_PATH);
}

function clearPendingSession() {
  try { unlinkSync(PENDING_SESSION_PATH); } catch {}
}

log('loaded', { pid: process.pid, boot: BOOT_ID, helperPath: HELPER_PATH });

function servingPort(request, fallback) {
  const host = typeof request.headers.host === 'string' ? request.headers.host : '';
  const match = /:(\d{1,5})$/u.exec(host);
  if (match === null) return fallback;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

function trustedRequest(request) {
  const address = request.socket.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false;
  if (request.headers.forwarded !== undefined || request.headers['x-forwarded-for'] !== undefined || request.headers['x-real-ip'] !== undefined) return false;
  const host = request.headers.host;
  const origin = request.headers.origin;
  if (typeof host !== 'string' || typeof origin !== 'string') return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host;
  } catch {
    return false;
  }
}

function writeJson(response, status, value) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8'
  });
  response.end(JSON.stringify(value));
}

async function notifyPendingAgent(agent) {
  const pending = readPendingSession();
  if (pending === null || String(agent.id) !== pending.sessionId) return false;
  const reason = typeof pending.reason === 'string' && pending.reason.length > 0 ? pending.reason : 'AI requested a Harness restart';
  try {
    agent.followup(recoveryMessage(reason));
    clearPendingSession();
    log('pending session notified and woken', { sessionId: pending.sessionId });
    return true;
  } catch (error) {
    log('pending session notification failed', { sessionId: pending.sessionId, message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

async function recoverPendingSession(ctx, attempt = 0) {
  const pending = readPendingSession();
  if (pending === null) return;
  const agents = ctx.get('agents');
  const persistence = ctx.get('sessionPersistence');
  if (agents === undefined || persistence === undefined) {
    log('pending session recovery waiting for services', { hasAgents: agents !== undefined, hasPersistence: persistence !== undefined });
    if (attempt < 30) ctx.timeout(() => { void recoverPendingSession(ctx, attempt + 1); }, 1000);
    return;
  }
  const live = agents.get(pending.sessionId);
  if (live !== undefined) {
    await notifyPendingAgent(live);
    return;
  }
  try {
    const inspected = await persistence.inspect(pending.sessionId);
    const presets = ctx.get('agentPresets');
    const presetId = typeof pending.presetId === 'string'
      ? pending.presetId
      : typeof inspected.meta.agentPreset === 'string' ? inspected.meta.agentPreset : undefined;
    if (presetId !== undefined && presets === undefined) {
      log('pending session recovery waiting for agentPresets', { sessionId: pending.sessionId, presetId });
      if (attempt < 30) ctx.timeout(() => { void recoverPendingSession(ctx, attempt + 1); }, 1000);
      return;
    }
    log('resuming pending session', { sessionId: pending.sessionId, presetId });
    await agents.resume({
      resumeSessionId: pending.sessionId,
      setup: presetId !== undefined && presets !== undefined
        ? (agentCtx) => presets.mount(agentCtx, presetId)
        : undefined
    });
  } catch (error) {
    log('pending session recovery failed', { sessionId: pending.sessionId, message: error instanceof Error ? error.message : String(error) });
    if (attempt < 30) ctx.timeout(() => { void recoverPendingSession(ctx, attempt + 1); }, 1000);
  }
}

function scheduleRestart(port) {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry.length === 0) throw new Error('cannot determine the current DSH entry');
  const args = [...process.execArgv, resolve(entry), ...process.argv.slice(2)];
  // The existing browser tab performs the recovery reload; do not open another one.
  if (args.includes('web') && !args.includes('--no-open')) args.push('--no-open');
  const configPath = join(DSH_HOME, 'dsh-restart-harness.pending.json');
  const config = { file: process.execPath, args, cwd: process.cwd(), port, logPath: LOG_PATH };
  writeFileSync(configPath, JSON.stringify(config), 'utf8');
  log('restart scheduled', { pid: process.pid, configPath, file: config.file, args: config.args, cwd: config.cwd, port });
  const helper = spawn(process.execPath, [HELPER_PATH, configPath], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    env: process.env,
    windowsHide: true
  });
  log('helper spawned directly', { helperPid: helper.pid, helperPath: HELPER_PATH, configPath });
  helper.once('error', (error) => log('helper spawn error', { message: error.message }));
  helper.unref();
  setTimeout(() => {
    log('requesting old process exit', { pid: process.pid });
    process.kill(process.pid, 'SIGTERM');
  }, 500);
  return { boot: BOOT_ID, logPath: LOG_PATH };
}

export const name = 'dsh-restart-harness';
export const inject = ['webServer', 'tools', 'timer'];

export function apply(ctx) {
  ctx.on('agent/created', ({ agent }) => {
    void notifyPendingAgent(agent).catch((error) => log('agent-created notification failed', { message: error instanceof Error ? error.message : String(error) }));
  });
  void recoverPendingSession(ctx).catch((error) => log('startup recovery failed', { message: error instanceof Error ? error.message : String(error) }));

  ctx.tools.register({
    name: 'restart_harness',
    description: 'Restart the DeepSeek Harness Web host when a restart is necessary to apply a configuration or plugin change. This terminates the current host and starts the same dsh web invocation through an independent helper. After the host comes back, the original session is resumed and receives a recovery message so the agent can continue unfinished work. Only call after explaining the impact; confirm must be true and reason must state why the restart is needed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string', description: 'Short explanation of why the Harness must restart.' },
        confirm: { type: 'boolean', description: 'Explicit confirmation that restarting may interrupt active work.' }
      },
      required: ['reason', 'confirm']
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }]
    },
    execute(args, exec) {
      if (typeof args.reason !== 'string' || args.reason.trim().length === 0) return 'Harness was not restarted: a reason is required.';
      if (args.confirm !== true) return 'Harness was not restarted: confirm must be true because the current process and active work may be interrupted.';
      if (exec === undefined || exec.agent === undefined) return 'Harness was not restarted: this tool must be called from an active session.';
      try {
        const presets = ctx.get('agentPresets');
        const presetId = presets === undefined ? undefined : presets.composedPreset(exec.agent.ctx);
        writePendingSession({
          sessionId: String(exec.agent.id),
          reason: args.reason.trim(),
          ...presetId === undefined ? {} : { presetId },
          requestedAt: Date.now()
        });
        log('restart requested by AI tool', { sessionId: String(exec.agent.id), reason: args.reason.trim(), presetId });
        const result = scheduleRestart(ctx.webServer.port);
        return `Harness restart scheduled. The current process will exit and the original session will be resumed after recovery. boot=${result.boot}`;
      } catch (error) {
        clearPendingSession();
        log('AI restart scheduling failed', { message: error instanceof Error ? error.message : String(error) });
        return `Harness was not restarted: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
  });

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-restart/log',
    handler(request, response) {
      if (request.method !== 'GET') { writeJson(response, 405, { error: 'method not allowed' }); return; }
      try { writeJson(response, 200, { path: LOG_PATH, text: readFileSync(LOG_PATH, 'utf8').slice(-20000) }); }
      catch { writeJson(response, 200, { path: LOG_PATH, text: '' }); }
    }
  }));
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATUS_PATH,
    handler(request, response) {
      if (request.method !== 'GET') { writeJson(response, 405, { error: 'method not allowed' }); return; }
      writeJson(response, 200, { boot: BOOT_ID, pid: process.pid });
    }
  }));
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: RESTART_PATH,
    handler(request, response) {
      if (request.method !== 'POST') { writeJson(response, 405, { error: 'method not allowed' }); return; }
      if (!trustedRequest(request)) { writeJson(response, 403, { error: 'restart is limited to same-origin loopback requests' }); return; }
      try { writeJson(response, 202, { ok: true, ...scheduleRestart(servingPort(request, ctx.webServer.port)) }); }
      catch (error) { log('restart scheduling failed', { message: error instanceof Error ? error.message : String(error) }); writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) }); }
    }
  }));
}
