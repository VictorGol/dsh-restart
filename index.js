/**
 * Host half of the restart bundle.
 *
 * The Client only asks; every process decision stays here: one loopback-only
 * HTTP route spawns a detached helper, and that helper stops this application
 * and starts it again once the old processes are gone.
 */
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROUTE = '/dsh-restart/restart'
const VERSION = '1.3.0'
const LOG_FILE = join(tmpdir(), 'dsh-restart.log')
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export const inject = ['webServer']

function sendJson(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-dsh-restart': VERSION,
  })
  response.end(JSON.stringify(value))
}

/**
 * macOS application bundle containing this Electron host, when it runs from one.
 * @returns the `.app` path, or null outside a bundle.
 */
function desktopBundle() {
  if (process.platform !== 'darwin') return null
  const executable = process.execPath
  const marker = '/Contents/MacOS/'
  const at = executable.indexOf(marker)
  return at < 0 ? null : executable.slice(0, at)
}

/**
 * What the helper must stop and start again.
 *
 * The Desktop host runs as a child of the application process, and that
 * application owns the window, the single-instance lock and the port, so a
 * restart means relaunching the application. A terminal host owns the port
 * itself, so it replays its own invocation after the port goes quiet.
 * @param ctx - Host context providing the Web server origin.
 * @returns the mode, the pid to stop, the launch, and how to confirm it worked.
 */
function relaunchPlan(ctx) {
  const desktop = process.versions.electron !== undefined && process.connected
  if (desktop) {
    const bundle = desktopBundle()
    if (bundle !== null) {
      return {
        mode: 'desktop',
        target: process.ppid,
        file: 'open',
        args: ['-a', bundle],
        forceArgs: ['-n', '-a', bundle],
        activateArgs: ['-a', bundle],
        // Everything this bundle started, not just the application process.
        match: `${bundle}/Contents/`,
        exe: process.execPath,
        verify: bundle,
        cwd: tmpdir(),
        port: null,
      }
    }
    return {
      mode: 'desktop',
      target: process.ppid,
      file: process.execPath,
      args: [],
      forceArgs: null,
      activateArgs: null,
      match: null,
      exe: process.execPath,
      verify: process.execPath,
      cwd: tmpdir(),
      port: null,
    }
  }
  let port = null
  try {
    const parsed = Number(new URL(ctx.webServer.getOrigin()).port)
    port = Number.isInteger(parsed) && parsed > 0 ? parsed : null
  } catch {
    port = null
  }
  return {
    mode: 'terminal',
    target: process.pid,
    file: process.execPath,
    args: [...process.execArgv, ...process.argv.slice(1)],
    forceArgs: null,
    activateArgs: null,
    match: null,
    exe: null,
    verify: process.execPath,
    cwd: process.cwd(),
    port,
  }
}

/**
 * Source of the detached helper that outlives this process.
 *
 * Three failures shaped it:
 * - a replacement started before the old application's processes are gone
 *   meets the old instance's single-instance lock;
 * - `open` hands the caller's environment to the application it starts, so
 *   this Host's own ELECTRON_RUN_AS_NODE=1 launched the application as Node,
 *   with no window, exiting in under a second;
 * - waiting for the launched process to exit hangs on the one launch that
 *   works, because a GUI application does not exit.
 *
 * So: strip the launch-only variables, wait for the old processes, launch and
 * return, then check that the application is really running and retry
 * otherwise. Every step lands in one log file, because the process that could
 * report a failure is the one being restarted.
 * @param plan - the pid to stop, the launch that replaces it, and the evidence
 *   that the replacement came up.
 * @returns runnable Node source.
 */
function helperSource(plan) {
  return [
    "const { execFileSync, spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    "const net = require('node:net')",
    `const plan = ${JSON.stringify(plan)}`,
    `const logPath = ${JSON.stringify(LOG_FILE)}`,
    "const note = (line) => { try { fs.appendFileSync(logPath, '[' + new Date().toISOString() + '] ' + line + String.fromCharCode(10)) } catch {} }",
    'const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))',
    'const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }',
    "const free = (port) => new Promise((resolve) => {",
    "  const probe = net.connect({ host: '127.0.0.1', port })",
    '  const done = (value) => { probe.destroy(); resolve(value) }',
    "  probe.on('connect', () => done(false))",
    "  probe.on('error', () => done(true))",
    '  setTimeout(() => done(false), 500)',
    '})',
    "const accepts = (port) => new Promise((resolve) => {",
    "  const probe = net.connect({ host: '127.0.0.1', port })",
    "  probe.on('connect', () => { probe.destroy(); resolve(true) })",
    "  probe.on('error', () => resolve(false))",
    '  setTimeout(() => { probe.destroy(); resolve(false) }, 800)',
    '})',
    'const running = () => {',
    '  try {',
    "    if (process.platform === 'win32' || !plan.match) return false",
    // `ps` rather than `pgrep -f`: on macOS the application and its Host child
    // are missing from pgrep's full-command matches, while ps lists them.
    "    const out = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })",
    '    return out.split(String.fromCharCode(10)).some((line) => {',
    '      const trimmed = line.trim()',
    '      if (trimmed === \'\' || trimmed.indexOf(plan.match) === -1) return false',
    "      const pid = Number(trimmed.split(' ')[0])",
    '      return Number.isInteger(pid) && pid > 0 && pid !== process.pid',
    '    })',
    '  } catch { return false }',
    '}',
    // `open` passes the caller's environment to the new application, and this
    // Host is Electron running as Node: ELECTRON_RUN_AS_NODE=1 would launch the
    // application as Node instead of the GUI. Strip what a Finder launch lacks.
    'const launchEnv = Object.assign({}, process.env)',
    'for (const name of [',
    "  'ELECTRON_RUN_AS_NODE',",
    "  'ELECTRON_NO_ATTACH_CONSOLE',",
    "  'DSH_SESSION_ID',",
    "  'DSH_SHELL',",
    "  'DSH_WEB_URL',",
    "  'DSH_PROFILE',",
    "  'DSH_PROFILE_DIR',",
    ']) delete launchEnv[name]',
    "note('launch environment prepared (ELECTRON_RUN_AS_NODE ' + (process.env.ELECTRON_RUN_AS_NODE === undefined ? 'was unset' : 'stripped') + ')')",
    'const launch = (file, args) => {',
    '  try {',
    "    const child = spawn(file, args, { cwd: plan.cwd, detached: true, stdio: 'ignore', env: launchEnv })",
    "    child.on('error', (error) => note('launch error: ' + String((error && error.message) || error)))",
    "    child.on('exit', (code, signal) => note('launch process exited code ' + String(code) + ' signal ' + String(signal)))",
    '    child.unref()',
    '    return true',
    "  } catch (error) { note('launch threw: ' + String((error && error.message) || error)); return false }",
    '}',
    'const activate = () => {',
    '  if (!plan.activateArgs) return',
    '  launch(plan.file, plan.activateArgs)',
    "  note('activation requested')",
    '}',
    'const main = async () => {',
    "  note('helper up for pid ' + String(plan.target))",
    '  await sleep(600)',
    // Never stop the application for a launch that cannot happen: a moved or
    // deleted app bundle would otherwise leave the user with nothing.
    "  if (typeof plan.verify !== 'string' || !fs.existsSync(plan.verify)) {",
    "    note('launch target missing: ' + String(plan.verify))",
    '    return',
    '  }',
    '  if (alive(plan.target)) {',
    "    try { process.kill(plan.target, 'SIGTERM'); note('SIGTERM sent') } catch (error) { note('SIGTERM failed: ' + String((error && error.message) || error)) }",
    '  }',
    '  const termBy = Date.now() + 4000',
    '  while (Date.now() < termBy && alive(plan.target)) await sleep(100)',
    '  if (alive(plan.target)) {',
    "    try { process.kill(plan.target, 'SIGKILL'); note('SIGKILL sent') } catch (error) { note('SIGKILL failed: ' + String((error && error.message) || error)) }",
    '    const killBy = Date.now() + 4000',
    '    while (Date.now() < killBy && alive(plan.target)) await sleep(100)',
    '  }',
    "  if (plan.mode === 'desktop') {",
    "    const verifiable = plan.match !== null && process.platform !== 'win32'",
    '    if (!verifiable) {',
    '      launch(plan.file, plan.args)',
    "      note('launch requested (this platform cannot verify the result)')",
    '      await sleep(3000)',
    '      return',
    '    }',
    '    const goneBy = Date.now() + 20000',
    '    while (Date.now() < goneBy && running()) await sleep(300)',
    "    note('old application processes are gone')",
    // The single-instance lock and socket outlive the processes for a moment.
    '    await sleep(1200)',
    '    const forced = plan.forceArgs === null ? plan.args : plan.forceArgs',
    '    const attempts = [',
    '      { file: plan.file, args: plan.args },',
    '      { file: plan.file, args: forced },',
    '      { file: plan.file, args: plan.args },',
    '      { file: plan.exe, args: [] },',
    '      { file: plan.file, args: forced },',
    '    ]',
    '    for (let index = 0; index < attempts.length; index++) {',
    "      if (running()) { activate(); note('application is running'); return }",
    '      const step = attempts[index]',
    "      note('launch attempt ' + String(index + 1) + ' via ' + String(step.file))",
    '      launch(step.file, step.args)',
    '      await sleep(3500)',
    "      if (running()) { activate(); note('application is running after attempt ' + String(index + 1)); return }",
    '      await sleep(1200)',
    '    }',
    "    note('the application did not come back after ' + String(attempts.length) + ' attempts')",
    '    return',
    '  }',
    '  if (plan.port !== null) {',
    '    const portBy = Date.now() + 30000',
    '    while (Date.now() < portBy) { if (await free(plan.port)) break; await sleep(250) }',
    '  }',
    '  await sleep(200)',
    '  launch(plan.file, plan.args)',
    "  note('launched ' + plan.file)",
    '  if (plan.port !== null) {',
    '    const upBy = Date.now() + 30000',
    '    let up = false',
    '    while (Date.now() < upBy) { if (await accepts(plan.port)) { up = true; break } await sleep(300) }',
    "    note(up ? 'replacement answered on port ' + String(plan.port) : 'replacement did not answer on port ' + String(plan.port))",
    '  }',
    '  await sleep(1500)',
    '}',
    'main()',
  ].join('\n')
}

/**
 * Schedule one restart.
 * @param ctx - Host context used to resolve the launch.
 * @returns the detached helper's pid.
 */
function scheduleRestart(ctx) {
  const plan = relaunchPlan(ctx)
  const helper = spawn(process.execPath, ['-e', helperSource(plan)], {
    detached: true,
    stdio: 'ignore',
    cwd: tmpdir(),
    env: process.env,
  })
  helper.unref()
  return { plan, helper: helper.pid ?? null }
}

export function apply(ctx) {
  let restarting = false
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: (request, response) => {
        if (request.method !== 'POST') {
          response.writeHead(405, { allow: 'POST', 'x-dsh-restart': VERSION })
          response.end()
          return
        }
        if (!LOOPBACK.has(request.socket.remoteAddress)) {
          sendJson(response, 403, { error: 'Restart is limited to loopback requests' })
          return
        }
        // A custom header cannot be sent cross-origin without a preflight,
        // which this route never answers; the Desktop proxy keeps it while
        // replacing the cookie and dropping Host/Origin.
        if (request.headers['x-dsh-restart'] !== '1') {
          sendJson(response, 403, { error: 'Missing restart header' })
          return
        }
        if (restarting) {
          sendJson(response, 409, { error: 'A restart is already scheduled' })
          return
        }
        restarting = true
        try {
          const { plan, helper } = scheduleRestart(ctx)
          sendJson(response, 202, { ok: true, mode: plan.mode, helper })
        } catch (error) {
          restarting = false
          sendJson(response, 500, {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    }),
  )
}
