const configManager = require('../../config')
const xhr = require('../../util/xhrModifiers')
const commands = require('../../util/resolveCommandModifiers')
const locale = require('../../util/localeProvider')
const { toast, popupMenu } = require('../../util/ui')
const feed = require('./feed')
const { channelDirectory, findField } = require('./channels')
const { discover, discoveryVideos, creatorTile } = require('./creators')
const { decorateThumbnails } = require('./flags')
const { matchesRegion, regionalRows } = require('./regions')

const english = require('../../../../locale/en.json').settings.home_recommendations
const labels = () => locale.getLocale()?.settings.home_recommendations || english

function isBrowse(url) {
    return typeof url === 'string' && /^(?:https:\/\/www\.youtube\.com)?\/youtubei\/v1\/browse(?:\?|$)/.test(url)
}

function isKids(request) {
    return request?.context?.client?.clientName === 'TVHTML5_FOR_KIDS' || window.ytcfg?.data_?.INNERTUBE_CLIENT_NAME === 'TVHTML5_FOR_KIDS'
}

function addWatchedMenus(node, label) {
    if (!node || typeof node !== 'object') return
    const tile = feed.video(node)
    const lockup = node.lockupViewModel
    if (tile) {
        tile.onLongPressCommand ||= { showMenuCommand: {
            contentId: tile.contentId, title: tile.metadata?.tileMetadataRenderer?.title,
            thumbnail: tile.header?.tileHeaderRenderer?.thumbnail, menu: { menuRenderer: { items: [] } }
        } }
        return feed.watchedMenu(findField(tile.onLongPressCommand, 'menuRenderer')?.items, tile.contentId, label)
    } else if (lockup?.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO') {
        lockup.rendererContext ||= {}
        const context = lockup.rendererContext.commandContext ||= {}
        context.onLongPress ||= { innertubeCommand: { showMenuCommand: {
            contentId: lockup.contentId, title: { simpleText: lockup.metadata?.lockupMetadataViewModel?.title?.content },
            menu: { menuRenderer: { items: [] } }
        } } }
        return feed.watchedMenu(findField(context.onLongPress, 'menuRenderer')?.items, lockup.contentId, label)
    } else {
        let changed = false
        for (const child of Object.values(node)) if (addWatchedMenus(child, label)) changed = true
        return changed
    }
}

module.exports = () => {
    const config = configManager.get()
    const cards = new Map()
    const creators = new Map()
    const blocked = () => Array.isArray(config.home_blocked_creators) ? config.home_blocked_creators.filter(Boolean) : []
    let directory
    let homeGeneration = 0
    let refreshTimer
    let latestUploads = new Set()
    let currentHome
    let lastInteraction = 0
    function onHomeRoute() {
        const hash = window.location?.hash || ''
        const route = new URLSearchParams(hash.split('?')[1])
        const browseId = route.get('c')
        return /^(?:#\/?)?$/.test(hash) || Boolean(feed.feedSource({ browseId }))
    }
    function updateHomeLayout() {
        document.documentElement.classList.toggle('vt-compact-home', onHomeRoute() && !isKids())
    }
    function getDirectory(version) {
        if (!directory) {
            const date = version?.match(/\b(20\d{6})\b/)?.[1] || new Date().toISOString().slice(0, 10).replaceAll('-', '')
            directory = channelDirectory(window.fetch.bind(window), '2.' + date + '.00.00')
        }
        return directory
    }
    if (typeof document !== 'undefined') {
        const startFlags = () => decorateThumbnails(async id => {
            const publicData = getDirectory(window.ytcfg?.data_?.INNERTUBE_CLIENT_VERSION)
            const channel = cards.get(id)?.id || (await publicData.owner(id))?.id
            return channel && publicData.country(channel)
        }, () => labels().unknown_country, () => !isKids(), id =>
            directory?.knownCountry(cards.get(id)?.id || directory.knownOwner(id)?.id))
        const start = () => {
            startFlags()
            updateHomeLayout()
            window.addEventListener('hashchange', updateHomeLayout)
        }
        if (document.readyState !== 'loading') start()
        else window.addEventListener('DOMContentLoaded', start, { once: true })
    }
    for (const type of ['keydown', 'pointerdown', 'wheel']) {
        window.addEventListener(type, () => { lastInteraction = Date.now() }, { passive: true, capture: true })
    }
    function stopRefreshing() {
        clearInterval(refreshTimer)
        homeGeneration++
    }
    window.addEventListener('hashchange', stopRefreshing)
    window.addEventListener('pagehide', stopRefreshing)

    // Only refresh a visible, idle Home, and only after its newest upload changes.
    // Leaving the route also releases the account-bound request callback.
    function watchUploads(load, firstId, browseId, generation) {
        let busy = false
        refreshTimer = setInterval(async () => {
            if (busy || document.hidden || !document.hasFocus() || Date.now() - lastInteraction < 15000 || document.querySelector('video')?.paused === false) return
            if (document.querySelector('[role="dialog"], #vt-settings-overlay-root:not(.vt-settings-hidden), ytlr-overlay-panel-renderer')) return
            busy = true
            try {
                const next = await load()
                const id = next?.items[0]?.tileRenderer?.contentId
                if (generation === homeGeneration && id && id !== firstId) {
                    commands.resolveCommand({ browseEndpoint: { browseId } })
                }
            } catch { /* The next Home visit also checks for uploads. */ }
            finally { busy = false }
        }, 120000)
    }

    function remember(id, info) {
        if (cards.size >= 1500) cards.delete(cards.keys().next().value)
        cards.set(id, info)
    }

    function details(tile) {
        const direct = feed.creator(tile)
        const owner = directory?.knownOwner(tile.contentId)
        const id = direct.id || owner?.id
        return { id, handle: direct.handle || owner?.handle, name: direct.name || owner?.name,
            uk: config.prefer_uk_creators && directory?.knownUK(id) }
    }

    // Limit public lookups and how long Home waits for them. Missing countries stay neutral.
    async function enrich(rows, preferUK) {
        const candidates = rows.flatMap(row => row.items.map(feed.video).filter(Boolean))
        const hidden = blocked()
        const needsIdentity = tile => {
            const known = details(tile)
            return !known.id && hidden.some(entry =>
                !known.handle || !entry.handle || entry.name === known.name || entry.handle === known.handle)
        }
        const checks = candidates.filter(needsIdentity)
        const sample = preferUK ? rows.flatMap(row => row.items.map(feed.video).filter(Boolean).slice(0, 4)).slice(0, 12) : []
        const queue = [...new Set([...checks, ...sample])]
        let index = 0
        const deadline = Date.now() + 1800
        async function work() {
            while (index < queue.length && Date.now() < deadline) {
                const tile = queue[index++]
                const owner = details(tile)
                const id = owner.id || (await directory.owner(tile.contentId))?.id
                if (id && preferUK && sample.includes(tile)) await directory.country(id)
            }
        }
        if (queue.length) {
            let timer
            try {
                await Promise.race([Promise.all([work(), work(), work()]), new Promise(resolve => { timer = setTimeout(resolve, 1800) })])
            } finally { clearTimeout(timer) }
        }
    }

    xhr.addRequestModifier((url, body, info) => {
        if (!isBrowse(url) || typeof body !== 'string') return body
        const request = JSON.parse(body)
        if (isKids(request)) return body
        if (request.browseId) stopRefreshing()
        if (request.browseId) currentHome = feed.feedSource(request) ? feed.regionalHomes[feed.regionFor(request)] || 'FEtopics' : undefined
        if (info) info.homeGeneration = homeGeneration
        return feed.prepareRequest(request, config.prefer_uk_creators) ? JSON.stringify(request) : body
    })

    xhr.addResponseModifier(async (url, text, info) => {
        if (!/^(?:https:\/\/www\.youtube\.com)?\/youtubei\/v1\/(?:browse|next|search)(?:\?|$)/.test(url) || isKids()) return
        const json = JSON.parse(text)
        if (json.error) return
        const request = info && JSON.parse(info.body)
        if (isKids(request)) return
        const source = isBrowse(url) && feed.feedSource(request)
        if (!source) {
            if (addWatchedMenus(json.contents || json.continuationContents || json.onResponseReceivedCommands, labels().watched)) return JSON.stringify(json)
            return
        }
        const region = feed.regionFor(request)
        // Leanback sends browseId "default" on startup and when navigating back to Home.
        if (request.browseId === 'default' && json.contents?.tvBrowseRenderer?.content?.tvSurfaceContentRenderer?.targetId !== 'browse-feedFEtopics') return
        const generation = info.homeGeneration
        const home = request.browseId && feed.sectionList(json)
        getDirectory(request.context?.client?.clientVersion)
        const rows = feed.lists(json)
        for (const row of rows) row.items = row.items.map(item => {
            const tile = feed.lockupTile(item.lockupViewModel, findField(item.lockupViewModel, 'menuRenderer'))
            return tile ? { tileRenderer: tile } : item
        })
        const load = async () => {
            const subscriptions = await info.subscriptions(request.context)
            if (subscriptions?.contents) return feed.subscriptionList(subscriptions, config.hide_shorts)
        }
        const loadFirstPage = Array.isArray(home?.contents) && (info.authenticated || window.ytcfg?.data_?.LOGGED_IN !== false)
        const canDiscover = loadFirstPage && info.channel && info.related
        const homeVideos = canDiscover ? discoveryVideos(home.contents) : []
        const [uploads, history] = await Promise.all([
            loadFirstPage ? load().catch(() => undefined) : undefined,
            canDiscover ? info.history(request.context).catch(() => undefined) : undefined,
            region ? undefined : enrich(rows, config.prefer_uk_creators && source === 'home')
        ])
        const seen = new Set(request.continuation && source === 'home' ? latestUploads : [])
        const excluded = new Set([...(config.home_hidden_videos || []), ...(config.home_watched_videos || [])])
        const options = { seen, blocked: blocked(), excluded, details, labels: labels(), remember, region }
        const regionalContext = region && structuredClone(request.context)
        if (regionalContext?.client) regionalContext.client.gl = region === 'UK' ? 'GB' : 'FR'
        const filterRegion = (lists, isDiscovery) => regionalRows(lists, {
            region, excluded,
            lookup: async tile => {
                const id = details(tile).id || (await directory.owner(tile.contentId))?.id
                if (id && !options.blocked.some(entry => feed.matchesCreator(entry, { ...details(tile), id }))) return directory.country(id)
            },
            continuation: info.continuation && (token => info.continuation(isDiscovery ? regionalContext : request.context, token)),
            related: isDiscovery && info.related && (id => info.related(regionalContext, id))
        })
        const uploadVideos = uploads?.items.map(feed.video).filter(Boolean) || []
        if (source === 'uploads') {
            if (!json.continuationContents) return
            const list = feed.subscriptionList(json, config.hide_shorts)
            json.continuationContents = { horizontalListContinuation: list }
            if (region) await filterRegion([list], false)
            feed.rankList(list, 'uploads', options)
            for (const id of seen) latestUploads.add(id)
            return JSON.stringify(json)
        }
        if (home && generation === homeGeneration) latestUploads = new Set()
        if (region) await Promise.all([filterRegion(rows, true), uploads && filterRegion([uploads], false)])
        if (uploads) {
            const firstId = uploadVideos[0]?.contentId
            if (!region) await enrich([uploads], false)
            feed.rankList(uploads, 'uploads', options)
            if (generation === homeGeneration) {
                latestUploads = new Set(seen)
                watchUploads(load, firstId, feed.regionalHomes[region] || 'FEtopics', generation)
            }
            if (uploads.items.length || uploads.continuations?.length) {
                const index = home.contents.findIndex(item => item.shelfRenderer || item.gridRenderer)
                home.contents.splice(index < 0 ? home.contents.length : index, 0, feed.subscriptionShelf(uploads, labels().uploads))
            }
        }
        const titles = new Map()
        for (const section of feed.sectionList(json)?.contents || []) {
            const shelf = section.shelfRenderer
            const heading = shelf?.headerRenderer?.shelfHeaderRenderer?.avatarLockup?.avatarLockupRenderer?.title || shelf?.title
            if (heading) titles.set(shelf.content?.horizontalListRenderer, feed.text(heading))
        }
        for (const row of rows) {
            feed.rankList(row, 'home', { ...options, remember: (id, card) => remember(id, { ...card, shelf: titles.get(row) }) })
        }
        if (home && generation === homeGeneration) creators.clear()
        if (canDiscover && generation === homeGeneration) {
            const discoveryContext = structuredClone(request.context)
            if (config.prefer_uk_creators && discoveryContext.client) discoveryContext.client.gl = 'GB'
            const suggestions = await discover({
                history: discoveryVideos(history?.contents), uploads: uploadVideos, home: homeVideos,
                related: id => info.related(discoveryContext, id),
                details, owner: directory.owner, lookup: id => info.channel(request.context, id),
                ignored: config.home_ignored_creators || [], blocked: options.blocked, excluded,
                eligible: region && (async id => matchesRegion(await directory.country(id), region))
            }).catch(() => [])
            if (suggestions.length && generation === homeGeneration) {
                for (const item of suggestions) creators.set(item.id, item)
                const row = feed.subscriptionShelf({ items: suggestions.map(creatorTile) }, labels().creators)
                const firstDiscovery = home.contents.findIndex(entry => rows.includes(entry.shelfRenderer?.content?.horizontalListRenderer))
                home.contents.splice(firstDiscovery < 0 ? home.contents.length : firstDiscovery + 1, 0, row)
            }
        }
        const sections = feed.sectionList(json)
        if (sections?.contents) sections.contents = sections.contents.filter(section => {
            const list = section.shelfRenderer?.content?.horizontalListRenderer
            if (region && !list && !section.gridRenderer && discoveryVideos(section).length) return false
            return !list || list.items?.length || list.continuations?.length
        })
        feed.tagContinuations(feed.sectionList(json), source, region)
        return JSON.stringify(json)
    })

    commands.addInputModifier(command => {
        const menu = command?.showMenuCommand
        if (menu && !isKids()) feed.watchedMenu(menu.menu?.menuRenderer?.items, menu.contentId, labels().watched)
        const refreshHome = () => commands.resolveCommand({ browseEndpoint: { browseId: currentHome || 'FEtopics' } })
        if (command?.vtCreatorAction) {
            const creator = creators.get(command.channelId)
            if (!creator) return false
            const action = command.vtCreatorAction
            if (action === 'options') {
                const strings = labels()
                const items = ['watch', 'channel', 'subscribe', 'ignore'].map(key => ({ compactLinkRenderer: {
                    title: { simpleText: strings[key] }, serviceEndpoint: { vtCreatorAction: key, channelId: creator.id }
                } }))
                const panel = popupMenu({ title: creator.name, subtitle: creator.description, items })
                panel.openPopupAction.popupType = 'FULLSCREEN_OVERLAY'
                panel.openPopupAction.uniqueId = 'vt-suggested-creator'
                commands.resolveCommand(panel)
            } else {
                commands.resolveCommand({ signalAction: { signal: 'POPUP_BACK' } })
                if (action === 'watch') commands.resolveCommand(creator.watch)
                if (action === 'channel') commands.resolveCommand({ browseEndpoint: { browseId: creator.id } })
                if (action === 'ignore') {
                    configManager.set({ home_ignored_creators: [...new Set([...(config.home_ignored_creators || []), creator.id])] })
                    refreshHome()
                }
                if (action === 'subscribe') {
                    commands.resolveCommand(creator.subscribe)
                    const generation = homeGeneration
                    setTimeout(() => { if (generation === homeGeneration) refreshHome() }, 700)
                }
            }
            return false
        }
        const action = command?.vtHomeAction
        if (!['why', 'block', 'hide', 'watched'].includes(action)) return command
        const id = command.videoId
        const card = cards.get(id)
        if (!feed.videoId.test(id) || (!card && action !== 'watched')) return false
        commands.resolveCommand({ signalAction: { signal: 'POPUP_BACK' } })
        const strings = labels()
        if (action === 'hide' || action === 'watched') {
            const key = action === 'hide' ? 'home_hidden_videos' : 'home_watched_videos'
            configManager.set({ [key]: [...new Set([...(config[key] || []), id])] })
            if (action === 'hide' && card.nativeHide) commands.resolveCommand(card.nativeHide)
            if (currentHome && onHomeRoute()) refreshHome()
            else if (action === 'watched') toast(strings.watched)
        } else if (action === 'why') {
            let reason = strings.discovery_reason
            if (card.source === 'uploads') reason = strings.subscription_reason
            else if (card.shelf) reason = strings.shelf_reason.replace('{shelf}', () => card.shelf)
            if (card.source === 'home' && card.uk) reason += ' ' + strings.uk_reason
            const panel = popupMenu({ title: strings.why, subtitle: reason, items: [
                { compactLinkRenderer: { title: { simpleText: strings.done }, serviceEndpoint: { signalAction: { signal: 'POPUP_BACK' } } } }
            ] })
            panel.openPopupAction.popupType = 'FULLSCREEN_OVERLAY'
            panel.openPopupAction.uniqueId = 'vt-home-recommendation-reason'
            commands.resolveCommand(panel)
        } else {
            void (async () => {
                const owner = card.id ? card : await directory.owner(id)
                const entry = { id: owner?.id, handle: card.handle || owner?.handle, name: card.name || owner?.name }
                if (!entry.id && !entry.handle) return toast(strings.block, strings.unknown_creator)
                const entries = blocked()
                if (!entries.some(other => feed.matchesCreator(entry, other))) configManager.set({ home_blocked_creators: [...entries, entry] })
                // Reread Home so every currently displayed row observes the block.
                refreshHome()
            })()
        }
        return false
    })
}
