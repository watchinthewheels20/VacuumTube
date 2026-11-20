const fs = require('node:fs/promises')
const path = require('node:path')
const countries = require('flag-icons/country.json')
const names = new Intl.DisplayNames(['en'], { type: 'region' })
const codes = new Map()
for (const { code, name, iso } of countries) {
    if (!iso) continue
    codes.set(name, code)
    codes.set(names.of(code.toUpperCase()), code)
    codes.set(code.toUpperCase(), code)
}
const assets = new Map()
async function flagImage(country) {
    const code = codes.get(country)
    if (!code) return
    if (!assets.has(code)) {
        const folder = path.dirname(require.resolve('flag-icons/country.json'))
        assets.set(code, fs.readFile(path.join(folder, 'flags', '4x3', code + '.svg'), 'base64')
            .then(data => 'data:image/svg+xml;base64,' + data))
    }
    return assets.get(code)
}

// TV uses both CSS backgrounds and img elements, including alternate and live thumbnails.
function thumbnailId(source) {
    if (typeof source !== 'string') return
    return source.match(/\/(?:vi(?:_webp)?|vi_live|an_webp|sb)\/([\w-]{11})(?:\/|[?#]|$)/)?.[1] ||
        source.match(/[?&]videoID=([\w-]{11})(?:[&#"')]|$)/)?.[1]
}

function decorateThumbnails(lookup, unknownLabel, enabled) {
    const selector = 'ytlr-tile-header-renderer, yt-lockup-view-model thumbnail, yt-thumbnail-view-model, ytlr-thumbnail-view-model'
    const states = new Map()
    const visible = new Set()
    let active = 0
    let frame
    function clear(host) {
        states.get(host)?.badge.remove()
        states.delete(host)
    }
    function update(badge, label, image) {
        badge.title = label
        badge.setAttribute('aria-label', label)
        if (image) badge.style.backgroundImage = 'url("' + image + '")'
    }
    function pump() {
        for (const host of visible) {
            if (active >= 3) break
            const state = states.get(host)
            if (!state?.id || state.started) continue
            state.started = true
            active++
            Promise.resolve().then(() => lookup(state.id)).then(async country => {
                const image = await flagImage(country)
                if (image && host.isConnected && states.get(host) === state) update(state.badge, country, image)
            }).catch(() => {}).finally(() => { active--; pump() })
        }
    }
    const observer = new IntersectionObserver(entries => {
        for (const { target, isIntersecting } of entries) {
            if (isIntersecting) visible.add(target)
            else visible.delete(target)
        }
        pump()
    })
    function scan() {
        frame = undefined
        const hosts = new Set(enabled() ? document.querySelectorAll(selector) : [])
        for (const host of states.keys()) {
            if (hosts.has(host)) continue
            clear(host)
            observer.unobserve(host)
            visible.delete(host)
        }
        for (const host of hosts) {
            // A lockup can nest a thumbnail view model inside a tile header.
            if (host.parentElement?.closest(selector)) continue
            let id
            for (const image of host.querySelectorAll('ytlr-thumbnail-details, img, image, [style*="background-image"]')) {
                id = thumbnailId(image.currentSrc) || thumbnailId(image.src) || thumbnailId(image.style.backgroundImage)
                if (id) break
            }
            const video = id || host.querySelector('ytlr-thumbnail-overlay-time-status-renderer, yt-thumbnail-bottom-overlay-view-model')
            const old = states.get(host)
            if (old && video && old.id === id) {
                if (old.badge.parentElement !== host) host.appendChild(old.badge)
                continue
            }
            if (old) clear(host)
            if (!video) {
                observer.unobserve(host)
                visible.delete(host)
                continue
            }
            const badge = document.createElement('span')
            badge.className = 'vt-origin-flag'
            badge.setAttribute('role', 'img')
            if (getComputedStyle(host).position === 'static') host.style.position = 'relative'
            const state = { id, badge }
            states.set(host, state)
            update(badge, unknownLabel())
            host.appendChild(badge)
            observer.observe(host)
        }
        pump()
    }
    function schedule() {
        if (frame === undefined) frame = requestAnimationFrame(scan)
    }
    new MutationObserver(records => {
        if (frame !== undefined) return
        for (const record of records) {
            if (record.target.closest?.(selector)) return schedule()
            if (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].some(node =>
                node.nodeType === 1 && (node.matches(selector) || node.querySelector(selector)))) return schedule()
        }
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'srcset', 'style'] })
    window.addEventListener('hashchange', schedule)
    schedule()
}

module.exports = { decorateThumbnails, thumbnailId }
