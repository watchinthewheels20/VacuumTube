// Windows media remotes can control Chromium media sessions even when their window
// is not focused. Guard Media Session actions without disabling keyboard/controller
// controls or preventing playback from continuing in the background.
function protectMediaSession(mediaSession, { isFocused, getVideo }) {
    if (!mediaSession || typeof mediaSession.setActionHandler !== 'function') return false;

    const nativeSetActionHandler = mediaSession.setActionHandler.bind(mediaSession)

    function fallback(action) {
        const video = getVideo()
        if (!video) return;

        if (action === 'play' && typeof video.play === 'function') {
            const result = video.play()
            if (result && typeof result.catch === 'function') result.catch(() => {})
        } else if (action === 'pause' && typeof video.pause === 'function') {
            video.pause()
        }
    }

    // Chromium applies play/pause directly to <video> if a page has no media
    // session action handlers. Install focused equivalents so it cannot bypass
    // our check when YouTube has not registered its own callbacks.
    const defaultActions = new Set(['play', 'pause'])
    const guard = (callback) => (details) => {
        if (!isFocused()) return;
        return callback(details)
    }

    mediaSession.setActionHandler = function (action, handler) {
        if (handler == null && defaultActions.has(action)) {
            return nativeSetActionHandler(action, guard(() => fallback(action)))
        }
        if (typeof handler === 'function') {
            return nativeSetActionHandler(action, guard(handler))
        }
        return nativeSetActionHandler(action, handler)
    }

    for (const action of defaultActions) {
        mediaSession.setActionHandler(action, null)
    }

    return true;
}

module.exports = () => {
    const { ipcRenderer } = require('electron')
    let windowFocused = true;

    ipcRenderer.on('blur', () => { windowFocused = false })
    ipcRenderer.on('focus', () => { windowFocused = true })

    protectMediaSession(navigator.mediaSession, {
        isFocused: () => windowFocused && document.hasFocus(),
        getVideo: () => window.yt?.player?.utils?.videoElement_ || document.querySelector('video')
    })
}

module.exports.protectMediaSession = protectMediaSession
