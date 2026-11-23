import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { listPackage } from '@electron/asar'

// Use a hosted Windows runner: this deliberately exercises the normal per-user
// installation, including the real uninstaller registration and default profile.
assert.equal(process.platform, 'win32')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vacuumtube-reinstall-'))
const installDir = path.join(root, 'Install')
const setup = path.resolve('dist/VacuumTube-Setup.exe')
const app = path.join(installDir, 'VacuumTube.exe')
const uninstaller = path.join(installDir, 'Uninstall VacuumTube.exe')
const portFile = path.join(process.env.APPDATA, 'VacuumTube', 'sessionData', 'DevToolsActivePort')
const server = http.createServer((_req, res) => res.end('<title>Profile smoke test</title>'))
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const origin = 'http://127.0.0.1:' + server.address().port

async function run(exe, args) {
    const process = spawn(exe, args, { windowsHide: true, stdio: 'ignore' })
    const [code] = await once(process, 'exit')
    assert.equal(code, 0, path.basename(exe))
}

async function checkProfile(write) {
    const child = spawn(app, ['--debug-gpu', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'], { windowsHide: true, stdio: 'ignore' })
    const exit = once(child, 'exit')
    let ws
    try {
        let target
        for (let i = 0; i < 120 && !target; i++) {
            assert.equal(child.exitCode, null, 'Installed app exited before startup')
            await delay(250)
            try {
                const port = Number((await fs.readFile(portFile, 'utf8')).split('\n')[0])
                const tabs = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
                target = tabs.find(tab => tab.type === 'page' && tab.url.startsWith('chrome://gpu'))
            } catch { /* Chromium is starting. */ }
        }
        assert.ok(target, 'Installed window started')
        ws = new WebSocket(target.webSocketDebuggerUrl)
        await once(ws, 'open')
        let sequence = 0
        async function call(method, params) {
            const id = ++sequence
            ws.send(JSON.stringify({ id, method, params }))
            for (;;) {
                const [event] = await once(ws, 'message', { signal: AbortSignal.timeout(10000) })
                const message = JSON.parse(event.data)
                if (message.id !== id) continue
                assert.ok(!message.error && !message.result?.exceptionDetails, method)
                return message.result
            }
        }
        async function evaluate(expression) {
            const reply = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
            return reply.result.value
        }
        await call('Page.navigate', { url: origin })
        for (let i = 0; i < 50 && await evaluate('location.origin') !== origin; i++) await delay(100)
        assert.equal(await evaluate('location.origin'), origin)
        if (write) await evaluate("localStorage.setItem('profile-check','yes'); document.cookie='vt_smoke=yes; Max-Age=86400; SameSite=Strict'; true")
        assert.equal(await evaluate("localStorage.getItem('profile-check') === 'yes' && document.cookie.split('; ').includes('vt_smoke=yes')"), true, 'Profile storage survived')
        await evaluate('setTimeout(() => window.close(), 100); true')
        const code = await Promise.race([exit.then(([c]) => c), delay(10000, -1, { ref: false })])
        assert.equal(code, 0, 'Application closed cleanly')
    } finally {
        ws?.close()
        if (child.exitCode === null && child.signalCode === null) child.kill()
    }
}

async function install() {
    await run(setup, ['/S', '/currentuser', '/D=' + installDir])
    await fs.access(app)
}
async function checkDistribution() {
    const resources = path.join(installDir, 'resources')
    const updateSource = await fs.readFile(path.join(resources, 'app-update.yml'), 'utf8')
    assert.match(updateSource, /^owner: watchinthewheels20\s*$/m)
    assert.match(updateSource, /^repo: VacuumTube\s*$/m)
    const files = new Set(listPackage(path.join(resources, 'app.asar')).map(file => file.replaceAll('\\', '/')))
    for (const module of ['sidebar.js', 'home-recommendations/regions.js']) {
        assert.ok(files.has('/src/preload/modules/' + module), module + ' is included in the installed fork')
    }
    console.log('Installer contains the fork’s regional feeds, sidebar and update source.')
}
async function uninstall() {
    // _?= keeps the uninstaller in-process so its exit means removal has finished.
    await run(uninstaller, ['/S', '/currentuser', '_?=' + installDir])
    await assert.rejects(fs.access(app), { code: 'ENOENT' })
}
try {
    await install()
    await checkDistribution()
    await checkProfile(true)
    await install()
    await checkProfile(false)
    await uninstall()
    await install()
    await checkProfile(false)
    await uninstall()
    console.log('Installed profile retained its persistent cookie and local storage across both reinstall paths.')
} finally {
    server.close()
}
