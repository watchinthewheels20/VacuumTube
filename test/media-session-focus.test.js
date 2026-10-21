const test = require('node:test')
const assert = require('node:assert/strict')
const { protectMediaSession } = require('../src/preload/modules/media-session-focus')

function harness() {
    const handlers = new Map()
    const mediaSession = {
        setActionHandler(action, callback) { handlers.set(action, callback) }
    }
    let focused = true;
    let playing = false;
    let playCalls = 0;
    let pauseCalls = 0;
    const video = {
        play() { playCalls++; playing = true; return Promise.resolve() },
        pause() { pauseCalls++; playing = false }
    }

    assert.equal(protectMediaSession(mediaSession, {
        isFocused: () => focused,
        getVideo: () => video
    }), true)

    return {
        mediaSession,
        handlers,
        video,
        focus: (value) => { focused = value },
        calls: () => ({ playCalls, pauseCalls, playing })
    };
}

test('default play/pause actions work while focused and do nothing when unfocused', () => {
    const h = harness()

    h.handlers.get('play')()
    assert.deepEqual(h.calls(), { playCalls: 1, pauseCalls: 0, playing: true })

    h.focus(false)
    h.handlers.get('pause')()
    h.handlers.get('play')()
    assert.deepEqual(h.calls(), { playCalls: 1, pauseCalls: 0, playing: true })

    h.focus(true)
    h.handlers.get('pause')()
    assert.deepEqual(h.calls(), { playCalls: 1, pauseCalls: 1, playing: false })
})

test('YouTube-provided media session callbacks are guarded, including non-play actions', () => {
    const h = harness()
    const invoked = []
    const data = { seekTime: 45 };

    h.mediaSession.setActionHandler('pause', (details) => invoked.push(['pause', details]))
    h.mediaSession.setActionHandler('seekto', (details) => invoked.push(['seekto', details]))

    h.focus(false)
    h.handlers.get('pause')({ action: 'pause' })
    h.handlers.get('seekto')(data)
    assert.deepEqual(invoked, [])

    h.focus(true)
    h.handlers.get('seekto')(data)
    h.handlers.get('pause')({ action: 'pause' })
    assert.deepEqual(invoked, [['seekto', data], ['pause', { action: 'pause' }]])
})

test('clearing a play/pause callback retains the guarded Chromium fallback', () => {
    const h = harness()
    let called = 0;

    h.mediaSession.setActionHandler('play', () => { called++ })
    h.handlers.get('play')()
    assert.equal(called, 1)

    h.mediaSession.setActionHandler('play', null)
    h.focus(false)
    h.handlers.get('play')()
    assert.equal(h.calls().playCalls, 0)

    h.focus(true)
    h.handlers.get('play')()
    assert.equal(h.calls().playCalls, 1)
    assert.equal(called, 1)
})

test('clearing unrelated media action handlers preserves native removal', () => {
    const h = harness()
    h.mediaSession.setActionHandler('nexttrack', () => {})
    h.mediaSession.setActionHandler('nexttrack', null)
    assert.equal(h.handlers.get('nexttrack'), null)
})

test('unsupported media sessions are ignored', () => {
    assert.equal(protectMediaSession(null, { isFocused: () => true, getVideo: () => null }), false)
})
