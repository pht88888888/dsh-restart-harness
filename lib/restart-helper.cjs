const fs = require('node:fs');
const net = require('node:net');
const { spawn } = require('node:child_process');

const configPath = process.argv[2];
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch (error) {
  process.exitCode = 1;
  throw error;
}

const logPath = config.logPath;
function log(message, data) {
  try {
    const suffix = data === undefined ? '' : ` ${JSON.stringify(data)}`;
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] helper ${message}${suffix}\n`, 'utf8');
  } catch {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

function launchReplacement() {
  const child = spawn(config.file, config.args || [], {
    cwd: config.cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
    windowsHide: true
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => { stdout = (stdout + chunk).slice(-4000); });
  child.stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  child.once('error', (error) => log('replacement spawn error', { message: error.message, file: config.file, args: config.args }));
  child.once('close', (code, signal) => log('replacement closed', { code, signal, stdout, stderr }));
  child.unref();
  log('replacement handed off directly', { pid: child.pid, file: config.file, args: config.args });
  return child.pid;
}

async function main() {
  log('started', { pid: process.pid, configPath, port: config.port });
  if (config.port > 0) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && await isListening(config.port)) await sleep(250);
    log('old port check complete', { port: config.port, stillBusy: await isListening(config.port) });
    await sleep(500);
  } else {
    await sleep(1500);
  }
  const replacementPid = launchReplacement();
  if (config.port > 0) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !await isListening(config.port)) await sleep(500);
    log('new port check complete', { port: config.port, accepting: await isListening(config.port), replacementPid });
  }
  log('finished');
}

main().catch((error) => log('fatal error', { message: error && error.message ? error.message : String(error) }));
