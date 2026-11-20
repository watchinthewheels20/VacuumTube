const path = require('node:path')
const fs = require('node:fs')

function sessionPath(userData) {
    const current = path.join(userData, 'sessionData')
    // Pre-sessionData installations used Electron's default profile in userData.
    // Use that profile in place, keeping Chromium storage and its encryption state together.
    const hasStorage = dir => ['Local Storage/leveldb/CURRENT', 'IndexedDB', 'Network/Cookies'].some(file => fs.existsSync(path.join(dir, file)))
    return !hasStorage(current) && hasStorage(userData) ? userData : current
}

function persistSession(app, session) {
    let pending
    function flush() {
        session.flushStorageData()
        if (!pending) pending = session.cookies.flushStore().catch(() => {
            console.warn('[Session] Could not flush browser storage')
        }).finally(() => { pending = undefined })
        return pending
    }
    const timer = setInterval(flush, 30000)
    timer.unref()
    let quitting = false
    app.on('will-quit', event => {
        if (quitting) return
        event.preventDefault()
        clearInterval(timer)
        flush().finally(() => { quitting = true; app.quit() })
    })
}

module.exports = { sessionPath, persistSession }
