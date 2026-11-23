const configManager = require('../../config')
const xhr = require('../../util/xhrModifiers')
const commands = require('../../util/resolveCommandModifiers')
const locale = require('../../util/localeProvider')
const { toast, popupMenu } = require('../../util/ui')
const feed = require('./feed')
const { channelDirectory, findField } = require('./channels')
const { discover, discoveryVideos, creatorTile } = require('./creators')
const { decorateThumbnails } = require('./flags')
const { matchesRegion, cachedRegionalRows, regionalRows } = require('./regions')

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
    let activeBrowse
    let staged
    let lastInteraction = 0
    function onHomeRoute() {
        const hash = window.location?.hash || ''
        const route = new URLSearchParams(hash.split('?')[1])
        const browseId = route.get('c')
        return /^(?:#\/?)?$/.test(hash) || Boolean(feed.feedSource({ browseId }))
    }
    function updateHomeLayout() {
        document.documentElement.classList.toggle('vt-compact-home', onHomeRoute() && !isKids())
        if (!onHomeRoute()) showRegionalLoading(false)
    }
    function showRegionalLoading(loading) {
        if (typeof document !== 'undefined' && document.documentElement) {
            if (loading) document.documentElement.setAttribute('data-vt-region-loading', labels().checking_region || english.checking_region)
            else document.documentElement.removeAttribute('data-vt-region-loading')
        }
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
    window.addEventListener('hashchange', () => {
        stopRefreshing()
        // Native Home changes the hash during a browse. Keep that browse alive, but stop
        // filling shelves when the user leaves for a player, search or another screen.
        if (!onHomeRoute()) activeBrowse?.abort()
    })
    window.addEventListener('pagehide', () => {
        stopRefreshing()
        activeBrowse?.abort()
    })

    // Only refresh a visible, idle Home, and only after its newest upload changes.
    // Leaving the route also releases the account-bound request callback.
    function watchUploads(load, firstId, browseId, generation) {
        let busy = false
        refreshTimer = setInterval(async () => {
            if (busy || document.hidden || !document.hasFocus() || Date.now() - lastInteraction < 15000 || document.querySelector('video')?.paused === false) return
            if (document.querySelector('[role="dialog"], #vt-settings-overlay-root:not(.vt-settings-hidden), ytlr-overlay-panel-renderer')) return
            busy = true
            try {
                const next = await load(activeBrowse?.signal)
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
    async function enrich(rows, preferUK, signal) {
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
            while (index < queue.length && !signal?.aborted && Date.now() < deadline) {
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

    function account(request, info) {
        const config = window.ytcfg?.data_
        return JSON.stringify([info.authenticated, config?.LOGGED_IN, config?.SESSION_INDEX,
            config?.DELEGATED_SESSION_ID, request.context?.user])
    }

    xhr.addRequestModifier((url, body, info) => {
        if (!isBrowse(url) || typeof body !== 'string') return body
        const request = JSON.parse(body)
        if (isKids(request)) return body
        if (request.browseId) {
            stopRefreshing()
            currentHome = feed.feedSource(request) ? feed.regionalHomes[feed.regionFor(request)] || 'FEtopics' : undefined
            if (info && staged?.browseId === request.browseId && staged.until > Date.now() && staged.account === account(request, info)) {
                info.homeStaged = staged.snapshot
            } else {
                if (info && staged?.browseId === request.browseId) info.skipHomeUpgrade = true
                activeBrowse?.abort()
                activeBrowse = new AbortController()
            }
            staged = undefined
            if (typeof document !== 'undefined') showRegionalLoading(false)
        }
        if (info) info.homeSignal = activeBrowse?.signal
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
        const signal = info.homeSignal
        if (signal?.aborted) return region ? '{}' : undefined
        getDirectory(request.context?.client?.clientVersion)
        const interaction = lastInteraction
        const hasHome = Boolean(request.browseId && Array.isArray(feed.sectionList(json)?.contents))
        const load = async signal => {
            const subscriptions = await info.subscriptions(request.context, signal)
            if (subscriptions?.contents) return feed.subscriptionList(subscriptions, config.hide_shorts)
        }
        function publish(snapshot) {
            if (!signal?.aborted) {
                if (hasHome) {
                    latestUploads = snapshot.uploadIds
                    creators.clear()
                    for (const item of snapshot.suggestions) creators.set(item.id, item)
                    if (snapshot.loadedUploads) watchUploads(load, snapshot.firstUpload, currentHome, homeGeneration)
                } else if (source === 'uploads') {
                    for (const id of snapshot.uploadIds) latestUploads.add(id)
                }
                for (const [id, card] of snapshot.cards) remember(id, card)
            }
            return JSON.stringify(snapshot.json)
        }
        if (info.homeStaged) return publish(info.homeStaged)

        const loadFirstPage = hasHome && (info.authenticated || window.ytcfg?.data_?.LOGGED_IN !== false)
        const canDiscover = loadFirstPage && info.channel && info.related && info.history
        const excluded = new Set([...(config.home_hidden_videos || []), ...(config.home_watched_videos || [])])
        const blockedCreators = blocked()
        const discoveryContext = structuredClone(request.context)
        if (discoveryContext?.client && (region || config.prefer_uk_creators)) {
            discoveryContext.client.gl = region === 'EU' ? 'FR' : 'GB'
        }
        let countryFound
        const regionalOptions = {
            region, excluded, signal,
            onMatch: () => countryFound?.(),
            known: tile => {
                const identity = details(tile)
                if (!blockedCreators.some(entry => feed.matchesCreator(entry, identity))) return directory.knownCountry(identity.id)
            },
            lookup: async tile => {
                const id = details(tile).id || (await directory.owner(tile.contentId))?.id
                if (!signal?.aborted && id && !blockedCreators.some(entry => feed.matchesCreator(entry, { ...details(tile), id }))) {
                    return directory.country(id)
                }
            }
        }
        let uploads
        const uploadsRequest = loadFirstPage && load(signal).then(result => { uploads = result }).catch(() => {})
        const creatorRequest = canDiscover && (async () => {
            const [history] = await Promise.all([info.history(request.context, signal).catch(() => undefined), uploadsRequest])
            if (signal?.aborted) return []
            return discover({
                history: discoveryVideos(history?.contents), uploads: uploads?.items.map(feed.video).filter(Boolean) || [],
                home: discoveryVideos(feed.sectionList(json)?.contents),
                related: id => info.related(discoveryContext, id, signal),
                details, owner: directory.owner, lookup: id => info.channel(request.context, id, signal),
                ignored: config.home_ignored_creators || [], blocked: blockedCreators, excluded, signal,
                eligible: region && (async id => matchesRegion(await directory.country(id), region))
            })
        })().catch(() => [])

        async function build(complete) {
            const result = structuredClone(json)
            const sections = feed.sectionList(result)
            const rows = feed.lists(result)
            for (const row of rows) row.items = row.items.map(item => {
                const tile = feed.lockupTile(item?.lockupViewModel, findField(item?.lockupViewModel, 'menuRenderer'))
                return tile ? { tileRenderer: tile } : item
            })
            async function regional(lists, isDiscovery) {
                if (!complete) return cachedRegionalRows(lists, regionalOptions)
                const context = isDiscovery ? discoveryContext : request.context
                await regionalRows(lists, {
                    ...regionalOptions,
                    continuation: info.continuation && (token => info.continuation(context, token, signal)),
                    related: isDiscovery && info.related && (id => info.related(context, id, signal))
                })
            }
            const discovery = source === 'home' && (region
                ? regional(rows, true)
                : complete && enrich(rows, config.prefer_uk_creators, signal))
            if (complete) await uploadsRequest
            const uploadList = source === 'uploads' ? feed.subscriptionList(result, config.hide_shorts) : structuredClone(uploads)
            const firstUpload = uploadList?.items[0]?.tileRenderer?.contentId
            const subscriptions = uploadList && (region ? regional([uploadList], false) : complete && enrich([uploadList], false, signal))
            await Promise.all([discovery, subscriptions])
            const seen = new Set(request.continuation && source === 'home' ? latestUploads : [])
            const cards = new Map()
            const options = { seen, blocked: blockedCreators, excluded, details, labels: labels(), region,
                remember: (id, info) => cards.set(id, info) }
            if (uploadList) feed.rankList(uploadList, 'uploads', options)
            const uploadIds = new Set(seen)
            if (source === 'uploads') {
                result.continuationContents = { horizontalListContinuation: uploadList }
                return { json: result, cards, uploadIds, suggestions: [] }
            }
            if (hasHome && (uploadList?.items.length || uploadList?.continuations?.length)) {
                const index = sections.contents.findIndex(item => item.shelfRenderer || item.gridRenderer)
                sections.contents.splice(index < 0 ? sections.contents.length : index, 0, feed.subscriptionShelf(uploadList, labels().uploads))
            }
            const titles = new Map()
            for (const section of sections?.contents || []) {
                const shelf = section.shelfRenderer
                const heading = shelf?.headerRenderer?.shelfHeaderRenderer?.avatarLockup?.avatarLockupRenderer?.title || shelf?.title
                if (heading) titles.set(shelf.content?.horizontalListRenderer, feed.text(heading))
            }
            for (const row of rows) {
                feed.rankList(row, 'home', { ...options, remember: (id, card) => cards.set(id, { ...card, shelf: titles.get(row) }) })
            }
            const suggestions = (complete && await creatorRequest) || []
            if (suggestions.length) {
                const row = feed.subscriptionShelf({ items: suggestions.map(creatorTile) }, labels().creators)
                const firstDiscovery = sections.contents.findIndex(entry => rows.includes(entry.shelfRenderer?.content?.horizontalListRenderer))
                sections.contents.splice(firstDiscovery < 0 ? sections.contents.length : firstDiscovery + 1, 0, row)
            }
            if (sections?.contents) sections.contents = sections.contents.filter(section => {
                const list = section.shelfRenderer?.content?.horizontalListRenderer
                if (region && !list && !section.gridRenderer && discoveryVideos(section).length) return false
                return !list || list.items?.length || list.continuations?.length
            })
            feed.tagContinuations(sections, source, region)
            return { json: result, cards, uploadIds, firstUpload, loadedUploads: Boolean(uploadList), suggestions }
        }

        if (source === 'uploads' && !json.continuationContents) return
        const complete = build(true).catch(() => undefined)
        let timer
        let initial
        const warmRegion = region && feed.lists(json).some(list => list.items.some(item => {
            const tile = feed.video(item) || feed.lockupTile(item?.lockupViewModel)
            return tile && !excluded.has(tile.contentId) && matchesRegion(regionalOptions.known(tile), region)
        }))
        const firstPaintBudget = warmRegion ? 80 : region ? 500 : 250
        try {
            // Only verified matches may render. Never wait for every country or optional shelf.
            initial = await Promise.race([complete, new Promise(resolve => { timer = setTimeout(resolve, firstPaintBudget) })])
        } finally { clearTimeout(timer) }
        if (initial) return publish(initial)
        const first = await build(false)
        if (hasHome && !signal?.aborted && !info.skipHomeUpgrade && typeof document !== 'undefined') {
            const browseId = feed.regionalHomes[region] || 'FEtopics'
            const profile = account(request, info)
            let visible = first
            let coldTimer
            function upgrade(snapshot) {
                if (!snapshot || signal?.aborted || currentHome !== browseId || !onHomeRoute()) return
                if (lastInteraction !== interaction && visible.cards.size) return
                if (snapshot.cards.size <= visible.cards.size && snapshot.uploadIds.size <= visible.uploadIds.size &&
                    snapshot.suggestions.length <= visible.suggestions.length) return
                visible = snapshot
                const pending = staged?.browseId === browseId && staged.until > Date.now()
                staged = { snapshot, browseId, account: profile, until: Date.now() + 5000 }
                if (!pending) commands.resolveCommand({ browseEndpoint: { browseId } })
            }
            if (region && !first.cards.size) {
                showRegionalLoading(true)
                countryFound = () => {
                    if (coldTimer || visible.cards.size || signal?.aborted) return
                    // Coalesce nearby checks into the first batch while the remaining shelves fill.
                    coldTimer = setTimeout(() => {
                        coldTimer = undefined
                        if (!signal?.aborted) void build(false).then(upgrade).catch(() => {})
                    }, 150)
                }
            }
            void complete.then(upgrade).finally(() => {
                clearTimeout(coldTimer)
                if (region && !signal?.aborted) showRegionalLoading(false)
            }).catch(() => {})
        }
        return publish(first)
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
