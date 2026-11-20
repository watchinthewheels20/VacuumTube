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

// Leanback reuses thumbnail nodes while scrolling. Recheck their video ID after each lookup.
function decorateThumbnails(lookup, unknownLabel) {
    const visible = new Set()
    const pending = new WeakMap()
    let active = 0
    function onHome() {
        const route = new URL(location.hash.slice(1) || '/', location.href)
        return route.pathname === '/' || (route.pathname === '/browse' && ['FEtopics', 'FEwhat_to_watch'].includes(route.searchParams.get('c')))
    }
    function videoId(img) {
        if (!onHome()) return
        const source = img.src || img.style.backgroundImage || ''
        return source.match(/\/(?:vi(?:_webp)?|an_webp)\/([\w-]{11})\//)?.[1] ||
            source.match(/[?&]videoID=([\w-]{11})\b/)?.[1]
    }
    async function render(img, id) {
        const country = await lookup(id)
        const image = await flagImage(country)
        if (!img.isConnected || videoId(img) !== id || pending.get(img) !== id) return
        const host = img.closest('ytlr-tile-header-renderer') || img.parentElement
        host.querySelector(':scope > .vt-origin-flag')?.remove()
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative'
        const badge = document.createElement('span')
        badge.className = 'vt-origin-flag'
        badge.setAttribute('role', 'img')
        badge.title = country || unknownLabel()
        badge.setAttribute('aria-label', badge.title)
        if (image) badge.style.backgroundImage = 'url("' + image + '")'
        else badge.textContent = '🌐'
        host.appendChild(badge)
    }
    function pump() {
        for (const img of visible) {
            if (!img.isConnected) { visible.delete(img); continue }
            if (active >= 3) break
            const id = videoId(img)
            if (!id || pending.get(img) === id) continue
            pending.set(img, id)
            active++
            render(img, id).catch(() => {}).finally(() => { active--; pump() })
        }
    }
    const observer = new IntersectionObserver(entries => {
        for (const { target, isIntersecting } of entries) {
            if (isIntersecting) visible.add(target)
            else visible.delete(target)
        }
        pump()
    })
    const selector = 'ytlr-tile-renderer ytlr-thumbnail-details, ytlr-tile-renderer img'
    let layoutFrame
    function fitRows() {
        layoutFrame = undefined
        for (const row of document.querySelectorAll('ytlr-shelf-renderer ytlr-horizontal-list-renderer')) {
            const list = row.querySelector('yt-virtual-list')
            if (!list) continue
            if (!onHome()) {
                list.classList.remove('vt-four-across')
                continue
            }
            const tiles = list.querySelectorAll('ytlr-tile-renderer')
            if (!tiles.length) continue
            // Leanback positions virtual slots in rem. Scale the whole track so scrolling
            // and focus use the same geometry as the thumbnails and captions.
            const rem = parseFloat(getComputedStyle(document.documentElement).fontSize)
            const first = tiles[0].parentElement
            const position = slot => new DOMMatrixReadOnly(getComputedStyle(slot).transform).m41
            const width = tiles[0].offsetWidth
            const step = tiles[1] ? Math.abs(position(tiles[1].parentElement) - position(first)) : width + 1.5 * rem
            if (!width || !step) continue
            const available = row.clientWidth - 8 * rem
            const scale = available / (3 * step + width)
            if (!(scale > 0 && scale < 2)) continue
            list.style.setProperty('--vt-row-scale', scale.toFixed(4))
            list.style.setProperty('--vt-row-indent', (6.5 * (1 - scale)).toFixed(4) + 'rem')
            list.classList.add('vt-four-across')
        }
    }
    function scheduleLayout() {
        if (layoutFrame === undefined) layoutFrame = requestAnimationFrame(fitRows)
    }
    window.addEventListener('resize', scheduleLayout)
    window.addEventListener('hashchange', scheduleLayout)
    function register(node) {
        if (node.nodeType !== 1) return
        if (node.matches(selector)) observer.observe(node)
        node.querySelectorAll(selector).forEach(img => observer.observe(img))
    }
    const changes = new MutationObserver(records => {
        for (const record of records) {
            if (record.type === 'attributes') {
                const img = record.target
                if (!img.matches(selector)) continue
                const host = img.closest('ytlr-tile-header-renderer') || img.parentElement
                host?.querySelector(':scope > .vt-origin-flag')?.remove()
                pending.delete(img)
                observer.observe(img)
            } else {
                record.addedNodes.forEach(register)
                for (const node of record.removedNodes) {
                    if (node.nodeType !== 1 || node.isConnected) continue
                    const images = node.matches('img, ytlr-thumbnail-details') ? [node] : node.querySelectorAll('img, ytlr-thumbnail-details')
                    for (const img of images) { observer.unobserve(img); visible.delete(img); pending.delete(img) }
                }
                scheduleLayout()
            }
        }
        pump()
    })
    register(document.documentElement)
    scheduleLayout()
    changes.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'style'] })
}
module.exports = { decorateThumbnails }
