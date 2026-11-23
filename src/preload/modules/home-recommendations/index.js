const configManager = require('../../config')
const xhr = require('../../util/xhrModifiers')
const commands = require('../../util/resolveCommandModifiers')
const locale = require('../../util/localeProvider')
const { toast, popupMenu } = require('../../util/ui')
const feed = require('./feed')
const { channelDirectory, findField } = require('./channels')
const { discover, discoveryVideos, creatorTile } = require('./creators')
const { decorateThumbnails } = require('./flags')
const { matchesRegion, cachedRegionalRows, regionalRows, fillRegionalPage, arrangeRegionalPage, countFullRows, pageRows } = require('./regions')

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
    let latestRegionalVideos = new Set()
    const regionalPages = new Map()
    let regionalAccount
    let currentHome
    let activeBrowse
    let staged
    let refreshSequence = 0
    let lastInteraction = 0
    const newRegionalParams = () => 'vacuumtube-region-refresh-' + ++refreshSequence
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
        if (!onHomeRoute()) {
            currentHome = undefined
            activeBrowse?.abort()
        }
        const cached = regionalPages.get(feed.regionFor({ browseId: currentHome }))
        if (cached?.loadUploads && cached.key === pageKey(regionalAccount) && cached.expires > Date.now()) {
            watchUploads(cached.loadUploads, cached.snapshot.firstUpload, currentHome, homeGeneration)
        }
    })
    window.addEventListener('pagehide', () => {
        stopRefreshing()
        activeBrowse?.abort()
        for (const page of regionalPages.values()) page.controller.abort()
    })

    // Only refresh a visible, idle Home, and only after its newest upload changes.
    // Leaving the route also releases the account-bound request callback.
    function watchUploads(load, firstId, browseId, generation) {
        clearInterval(refreshTimer)
        let busy = false
        refreshTimer = setInterval(async () => {
            if (busy || document.hidden || !document.hasFocus() || Date.now() - lastInteraction < 15000 || document.querySelector('video')?.paused === false) return
            if (document.querySelector('[role="dialog"], #vt-settings-overlay-root:not(.vt-settings-hidden), ytlr-overlay-panel-renderer')) return
            busy = true
            try {
                const next = await load(activeBrowse?.signal)
                const id = next?.items[0]?.tileRenderer?.contentId
                if (generation === homeGeneration && id && id !== firstId) {
                    regionalPages.delete(feed.regionFor({ browseId }))
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

    function regionalKey(request, info) {
        const profile = account(request, info)
        if (regionalAccount !== profile) {
            for (const page of regionalPages.values()) page.controller.abort()
            regionalPages.clear()
            regionalAccount = profile
        }
        return pageKey(profile)
    }

    function pageKey(profile) {
        return JSON.stringify([profile, config.hide_shorts, config.prefer_uk_creators, config.home_hidden_videos, config.home_watched_videos,
            config.home_blocked_creators, config.home_ignored_creators])
    }

    xhr.addRequestModifier((url, body, info) => {
        if (!isBrowse(url) || typeof body !== 'string') return body
        const request = JSON.parse(body)
        if (isKids(request)) return body
        const visibleRegion = feed.regionFor({ browseId: currentHome })
        if (request.continuation && !feed.feedSource(request) && visibleRegion && onHomeRoute()) {
            // Some server-generated shelves dispatch a raw continuation rather than
            // the cursor tagged in our response. Bind it to the visible regional route.
            request.continuation = 'vacuumtube.home.home.' + visibleRegion + '.' + request.continuation
            if (info) info.body = JSON.stringify(request)
        }
        if (request.browseId) {
            if (info) info.regionalKey = regionalKey(request, info)
            stopRefreshing()
            currentHome = feed.feedSource(request) ? feed.regionalHomes[feed.regionFor(request)] || 'FEtopics' : undefined
            if (info && staged?.browseId === request.browseId && (!staged.params || staged.params === request.params) &&
                staged.until > Date.now() && staged.key === info.regionalKey) {
                info.homeStaged = staged.snapshot
            } else {
                if (info && staged?.browseId === request.browseId) info.skipHomeUpgrade = true
                activeBrowse?.abort()
                activeBrowse = new AbortController()
            }
            staged = undefined
            showRegionalLoading(Boolean(feed.regionFor(request)))
        }
        if (info) info.homeSignal = activeBrowse?.signal
        return feed.prepareRequest(request, config.prefer_uk_creators) ? JSON.stringify(request) : body
    })

    async function modifyFeed(url, json, request, info) {
        if (json.error) return
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
        if (signal?.aborted || (region && request.continuation && currentHome !== feed.regionalHomes[region])) {
            return region ? JSON.stringify(feed.emptyRegionalResponse(request, json)) : undefined
        }
        getDirectory(request.context?.client?.clientVersion)
        const interaction = lastInteraction
        const hasHome = Boolean(request.browseId && Array.isArray(feed.sectionList(json)?.contents))
        if (region && (request.browseId ? !hasHome : !feed.sectionList(json) && !feed.lists(json).length)) {
            return JSON.stringify(feed.emptyRegionalResponse(request, json))
        }
        const load = async signal => {
            const subscriptions = await info.subscriptions(request.context, signal)
            if (subscriptions?.contents) return feed.subscriptionList(subscriptions, config.hide_shorts)
        }
        function publish(snapshot) {
            if (!signal?.aborted) {
                if (hasHome) {
                    const saved = region && regionalPages.get(region)
                    if (saved?.key === info.regionalKey && snapshot.fullRows >= pageRows && request.params) {
                        saved.routeParams = request.params
                        if (snapshot.loadedUploads) saved.loadUploads = load
                    }
                    latestUploads = snapshot.uploadIds
                    latestRegionalVideos = new Set(snapshot.cards.keys())
                    creators.clear()
                    for (const item of snapshot.suggestions) creators.set(item.id, item)
                    if (snapshot.loadedUploads) watchUploads(load, snapshot.firstUpload, currentHome, homeGeneration)
                } else if (source === 'uploads') {
                    for (const id of snapshot.uploadIds) latestUploads.add(id)
                }
                if (region && !hasHome) for (const id of snapshot.cards.keys()) latestRegionalVideos.add(id)
                for (const [id, card] of snapshot.cards) remember(id, card)
            }
            return JSON.stringify(snapshot.json)
        }
        if (info.homeStaged) return publish(info.homeStaged)
        const previous = region && hasHome ? regionalPages.get(region) : undefined
        const saved = previous && previous.key === info.regionalKey && previous.expires > Date.now() ? previous : undefined
        if (saved?.snapshot?.fullRows >= pageRows) return publish(saved.snapshot)
        const cachedPage = saved && !saved.finished ? saved : undefined
        const page = region && hasHome
            ? cachedPage || { key: info.regionalKey, controller: new AbortController(), expires: Date.now() + 120000,
                tiles: new Map(saved?.tiles), snapshot: saved?.snapshot }
            : undefined
        if (page && !cachedPage) {
            previous?.controller.abort()
            regionalPages.set(region, page)
        }
        const workSignal = page?.controller.signal || signal
        const seenRegional = new Set(region && !hasHome ? latestRegionalVideos : [])

        const loadFirstPage = hasHome && (info.authenticated || window.ytcfg?.data_?.LOGGED_IN !== false)
        const canDiscover = loadFirstPage && info.channel && info.related && info.history
        const excluded = new Set([...(config.home_hidden_videos || []), ...(config.home_watched_videos || []), ...seenRegional])
        const blockedCreators = blocked()
        const discoveryContext = structuredClone(request.context)
        if (discoveryContext?.client && (region || config.prefer_uk_creators)) {
            discoveryContext.client.gl = region === 'EU' ? 'FR' : 'GB'
        }
        const moreTitle = region === 'UK' ? labels().more_uk || english.more_uk : labels().more_europe || english.more_europe
        const regionalOptions = {
            region, excluded, signal: workSignal,
            allow: tile => !config.hide_shorts || tile.contentType === 'TILE_CONTENT_TYPE_VIDEO',
            onMatch: tile => {
                if (page) {
                    if (page.tiles.size < 96 && !page.tiles.has(tile.contentId)) page.tiles.set(tile.contentId, structuredClone(tile))
                }
            },
            known: tile => {
                const identity = details(tile)
                if (!blockedCreators.some(entry => feed.matchesCreator(entry, identity))) return directory.knownCountry(identity.id)
            },
            lookup: async tile => {
                const id = details(tile).id || (await directory.owner(tile.contentId))?.id
                if (!workSignal?.aborted && id && !blockedCreators.some(entry => feed.matchesCreator(entry, { ...details(tile), id }))) {
                    return directory.country(id)
                }
            }
        }
        let uploads
        const uploadsRequest = !cachedPage && loadFirstPage && load(workSignal).then(result => { uploads = result }).catch(() => {})
        let readySuggestions = []
        const creatorRequest = !cachedPage && canDiscover && (async () => {
            const [history] = await Promise.all([info.history(request.context, workSignal).catch(() => undefined), uploadsRequest])
            if (workSignal?.aborted) return []
            readySuggestions = await discover({
                history: discoveryVideos(history?.contents), uploads: uploads?.items.map(feed.video).filter(Boolean) || [],
                home: discoveryVideos(feed.sectionList(json)?.contents),
                related: id => info.related(discoveryContext, id, workSignal),
                details, owner: directory.owner, lookup: id => info.channel(request.context, id, workSignal),
                ignored: config.home_ignored_creators || [], blocked: blockedCreators, excluded, signal: workSignal,
                eligible: region && (async id => matchesRegion(await directory.country(id), region))
            })
            return readySuggestions
        })().catch(() => [])

        async function build(complete) {
            const result = structuredClone(json)
            const sections = feed.sectionList(result)
            let rows = feed.lists(result)
            for (const row of rows) row.items = row.items.map(item => {
                const tile = feed.lockupTile(item?.lockupViewModel, findField(item?.lockupViewModel, 'menuRenderer'))
                return tile ? { tileRenderer: tile } : item
            })
            function regionalInventory() {
                if (!page?.tiles.size) return []
                const supplemental = { items: [...page.tiles.values()].map(tile => ({ tileRenderer: structuredClone(tile) })) }
                cachedRegionalRows([supplemental], regionalOptions)
                return supplemental.items
            }
            async function regional(lists, isDiscovery) {
                if (!complete) {
                    cachedRegionalRows(lists, regionalOptions)
                    if (isDiscovery && page?.tiles.size && Array.isArray(sections?.contents)) {
                        arrangeRegionalPage(sections, moreTitle, regionalInventory(), new Set(seenRegional))
                        rows = feed.lists(result)
                    }
                    return
                }
                const context = isDiscovery ? discoveryContext : request.context
                const settings = {
                    ...regionalOptions,
                    continuation: info.continuation && ((token, signal = workSignal) => info.continuation(context, token, signal)),
                    related: isDiscovery && info.related && ((id, signal = workSignal) => info.related(context, id, signal))
                }
                if (isDiscovery && Array.isArray(sections?.contents)) {
                    await fillRegionalPage(sections, { ...settings, title: moreTitle, seen: seenRegional,
                        additional: page && regionalInventory
                    })
                    rows = feed.lists(result)
                } else await regionalRows(lists, settings)
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
            if (region && sections) {
                // Subscription overlap is known now. Refill the discovery slots after
                // removing those duplicates, before assigning native geometry/menus.
                arrangeRegionalPage(sections, moreTitle, regionalInventory(), new Set([...seenRegional, ...uploadIds]))
                rows = feed.lists(result)
            }
            if (hasHome && (uploadList?.items.length || (!region && uploadList?.continuations?.length))) {
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
            const fullRows = region && sections ? countFullRows(sections) : 0
            const suggestions = (complete && await creatorRequest) || readySuggestions
            if (suggestions.length) {
                const row = feed.subscriptionShelf({ items: suggestions.map(creatorTile) }, labels().creators)
                const firstDiscovery = sections.contents.findIndex(entry => rows.includes(entry.shelfRenderer?.content?.horizontalListRenderer))
                sections.contents.splice(firstDiscovery < 0 ? sections.contents.length : firstDiscovery + 1, 0, row)
            }
            if (sections?.contents) sections.contents = sections.contents.filter(section => {
                const list = section.shelfRenderer?.content?.horizontalListRenderer || section.gridRenderer
                // Native creates permanent skeleton cards for a horizontal shelf with
                // an empty list and a cursor. Keep the vertical cursor for later rows.
                if (region) return Boolean(list?.items?.length)
                return !list || list.items?.length || list.continuations?.length
            })
            feed.tagContinuations(sections, source, region)
            return { json: result, cards, uploadIds, firstUpload, loadedUploads: Boolean(uploadList), suggestions, fullRows }
        }

        if (source === 'uploads' && !json.continuationContents) return
        let complete = cachedPage?.promise || build(true).catch(() => undefined)
        if (page && !cachedPage) {
            page.promise = complete.then(snapshot => {
                page.finished = true
                if (!workSignal.aborted && snapshot?.cards.size &&
                    (!page.snapshot || snapshot.fullRows >= page.snapshot.fullRows)) page.snapshot = snapshot
                if (!page.snapshot && regionalPages.get(region) === page) regionalPages.delete(region)
                return page.snapshot || snapshot
            })
            complete = page.promise
        }
        if (region) {
            // Deliver one prepared response. Country lookups and personalised backfill
            // may keep warming the cache after navigation, but never reload the route.
            let cancelled
            const abort = new Promise(resolve => {
                cancelled = () => resolve()
                if (signal?.aborted) cancelled()
                else signal?.addEventListener('abort', cancelled, { once: true })
            })
            let snapshot
            try { snapshot = await Promise.race([complete, abort]) }
            finally { signal?.removeEventListener('abort', cancelled) }
            return !signal?.aborted && snapshot ? publish(snapshot) : JSON.stringify(feed.emptyRegionalResponse(request, json))
        }
        let initial
        let timer
        let stopWaiting
        const firstPaint = new Promise(resolve => {
            stopWaiting = () => resolve()
            timer = setTimeout(stopWaiting, 250)
            signal?.addEventListener('abort', stopWaiting, { once: true })
        })
        try { initial = await Promise.race([complete, firstPaint]) }
        finally {
            clearTimeout(timer)
            signal?.removeEventListener('abort', stopWaiting)
        }
        if (signal?.aborted) return
        if (initial) return publish(initial)
        const draft = await build(false)
        const first = saved?.snapshot && saved.snapshot.fullRows >= draft.fullRows ? saved.snapshot : draft
        if (hasHome && !signal?.aborted && !info.skipHomeUpgrade && typeof document !== 'undefined') {
            const browseId = 'FEtopics'
            const key = info.regionalKey
            let visible = first
            function upgrade(snapshot) {
                if (!snapshot || signal?.aborted || currentHome !== browseId || !onHomeRoute()) return
                if (snapshot.fullRows <= visible.fullRows && snapshot.cards.size <= visible.cards.size && snapshot.uploadIds.size <= visible.uploadIds.size &&
                    snapshot.suggestions.length <= visible.suggestions.length) return
                if (lastInteraction !== interaction && visible.cards.size) return
                visible = snapshot
                const pending = staged?.browseId === browseId && staged.until > Date.now()
                staged = { snapshot, browseId, key, until: Date.now() + 5000 }
                if (!pending) commands.resolveCommand({ browseEndpoint: { browseId } })
            }
            void complete.then(upgrade).catch(() => {})
        }
        return publish(first)
    }

    xhr.addResponseModifier(async (url, text, info) => {
        if (!/^(?:https:\/\/www\.youtube\.com)?\/youtubei\/v1\/(?:browse|next|search)(?:\?|$)/.test(url) || isKids()) return
        const request = info && JSON.parse(info.body)
        let json
        try {
            json = JSON.parse(text)
            return await modifyFeed(url, json, request, info)
        } catch (error) {
            if (!isBrowse(url) || isKids(request) || !feed.regionFor(request)) throw error
            console.warn('[regional Home] Could not render a filtered response:', error.name)
            return JSON.stringify(feed.emptyRegionalResponse(request, json))
        } finally {
            if (request?.browseId && feed.regionFor(request) && !info.homeSignal?.aborted) {
                // Native renders after this response is released. Cover its first
                // layout pass so the old page cannot flash underneath the new grid.
                if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(() => {
                    if (!info.homeSignal?.aborted) showRegionalLoading(false)
                }))
                else showRegionalLoading(false)
            }
        }
    })
    commands.addInputModifier(command => {
        const endpoint = command?.browseEndpoint
        const region = feed.regionFor(endpoint)
        if (region && !endpoint.params && !isKids()) {
            const saved = regionalPages.get(region)
            const reusable = saved?.routeParams && saved.key === pageKey(regionalAccount) &&
                saved.expires > Date.now() && saved.snapshot?.fullRows >= pageRows
            if (reusable && currentHome !== endpoint.browseId) {
                // Leanback can reopen the completed native route without another request.
                stopRefreshing()
                activeBrowse?.abort()
                activeBrowse = new AbortController()
                currentHome = endpoint.browseId
                latestUploads = saved.snapshot.uploadIds
                latestRegionalVideos = new Set(saved.snapshot.cards.keys())
                creators.clear()
                for (const creator of saved.snapshot.suggestions) creators.set(creator.id, creator)
                for (const [id, card] of saved.snapshot.cards) remember(id, card)
                showRegionalLoading(false)
            }
            return { ...command, browseEndpoint: { ...endpoint, params: reusable ? saved.routeParams : newRegionalParams() } }
        }
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
