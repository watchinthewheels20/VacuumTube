const { lists, sectionList, subscriptionShelf, video, lockupTile, videoId } = require('./feed')
const { findField } = require('./channels')

const europe = new Set('AD AL AM AT AZ BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GE GG GI GR HR HU IE IM IS IT JE KZ LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM TR UA VA XK'.split(' '))
const displayNames = new Intl.DisplayNames(['en'], { type: 'region' })
const countries = new Map([...europe].map(code => [displayNames.of(code), code]))
countries.set('Turkey', 'TR')
countries.set('Czech Republic', 'CZ')
countries.set('Macedonia', 'MK')

const pageRows = 6
const cardsAcross = 4
const searches = {
    UK: ['UK documentary nature history', 'British science technology explainers', 'UK cooking travel', 'British arts music culture',
        'UK local history independent documentary', 'UK wildlife countryside walking'],
    EU: ['European documentary nature history', 'France science documentaire', 'Deutschland Technik Wissenschaft',
        'España viajes cultura', 'Italia cucina tradizionale', 'Polska przyroda reportaż', 'UK documentary nature history']
}

function matchesRegion(country, region) {
    const code = countries.get(country) || country
    return region === 'UK' ? code === 'GB' : region === 'EU' && europe.has(code)
}

function nextToken(list) {
    const entry = list?.continuations?.[0]
    return entry?.nextContinuationData?.continuation || entry?.reloadContinuationData?.continuation
}

function regionalVideo(item) {
    return video(item) || lockupTile(item?.lockupViewModel, findField(item?.lockupViewModel, 'menuRenderer'))
}

function cachedRegionalRows(rows, { region, known, excluded, allow = () => true }) {
    for (const list of rows) {
        list.items = list.items.flatMap(item => {
            const tile = regionalVideo(item)
            return tile && allow(tile) && !excluded.has(tile.contentId) && matchesRegion(known(tile), region)
                ? [{ tileRenderer: tile }] : []
        })
    }
}

async function regionalRows(rows, { region, lookup, known = () => undefined, continuation, excluded = new Set(), related, signal, onMatch,
    budget = 6500, concurrency = 10, allow = () => true }) {
    const deadline = Date.now() + budget
    const candidates = new Map()
    const queue = []
    let active = 0
    function pump() {
        while (queue.length && active < concurrency) {
            const { tile, resolve } = queue.shift()
            if (signal?.aborted || Date.now() >= deadline) {
                resolve()
                continue
            }
            active++
            Promise.resolve().then(() => lookup(tile)).catch(() => undefined).then(resolve).finally(() => {
                active--
                pump()
            })
        }
    }
    const states = rows.map(list => ({ list, accepted: [], seeds: list.items.map(regionalVideo).filter(Boolean), ids: new Set() }))
    async function filter(state, items) {
        const results = new Array(items.length)
        let index = 0
        let timer
        async function worker() {
            while (index < items.length && !signal?.aborted && Date.now() < deadline) {
                const slot = index++
                const item = items[slot]
                const tile = regionalVideo(item)
                if (!tile || !allow(tile) || excluded.has(tile.contentId) || state.ids.has(tile.contentId)) continue
                state.ids.add(tile.contentId)
                const country = known(tile)
                if (country) {
                    if (matchesRegion(country, region)) results[slot] = { tileRenderer: tile }
                    continue
                }
                if (!candidates.has(tile.contentId)) candidates.set(tile.contentId, new Promise(resolve => {
                    queue.push({ tile, resolve })
                    pump()
                }))
                if (matchesRegion(await candidates.get(tile.contentId), region)) {
                    results[slot] = { tileRenderer: tile }
                    if (!signal?.aborted) onMatch?.()
                }
            }
        }
        try {
            await Promise.race([Promise.all(Array.from({ length: 8 }, worker)), new Promise(resolve => {
                timer = setTimeout(resolve, Math.max(0, deadline - Date.now()))
            })])
        } finally { clearTimeout(timer) }
        state.accepted.push(...results.filter(Boolean))
    }
    // Check the same shelf's subsequent pages first. Only discovery shelves can use related videos.
    await Promise.all(states.map(async state => {
        await filter(state, state.list.items)
        const visited = new Set()
        for (let page = 0; page < 4 && state.accepted.length < cardsAcross && !signal?.aborted && Date.now() < deadline; page++) {
            const token = nextToken(state.list)
            if (!token || !continuation || visited.has(token)) break
            visited.add(token)
            const response = await continuation(token).catch(() => undefined)
            const next = lists(response)[0]
            if (!next || nextToken(next) === token) break
            state.list.continuations = next.continuations
            await filter(state, next.items)
        }
        if (related && state.accepted.length < cardsAcross && !signal?.aborted && Date.now() < deadline) {
            const seed = (state.accepted.map(video).find(Boolean) || state.seeds[0])?.contentId
            if (videoId.test(seed)) {
                const result = await related(seed, signal).catch(() => undefined)
                const shelves = result?.contents?.singleColumnWatchNextResults?.pivot?.sectionListRenderer?.contents || []
                await filter(state, shelves.flatMap(shelf => shelf.shelfRenderer?.content?.horizontalListRenderer?.items || []).slice(0, 24))
            }
        }
        state.list.items = state.accepted
    }))
}

function searchTiles(node, items = []) {
    if (!node || typeof node !== 'object' || node.adSlotRenderer || node.promotedVideoRenderer) return items
    const tile = regionalVideo(node)
    if (tile) items.push({ tileRenderer: tile })
    else for (const child of Object.values(node)) searchTiles(child, items)
    return items
}

function sectionRows(sections) {
    return lists({ continuationContents: { sectionListContinuation: sections } })
}

// Keep the source shelves in order. Pool short shelves under an accurate regional title.
// A shelf with its own continuation remains reachable for native horizontal paging.
function arrangeRegionalPage(sections, title, supplemental, seen) {
    const sparse = []
    const shortWithContinuation = []
    let full = 0
    sections.contents = sections.contents.filter(section => {
        const [list] = sectionRows({ contents: [section] })
        if (!list) return true
        list.items = uniqueRegionalItems(list.items, seen)
        if (list.items.length >= cardsAcross) {
            full++
            return true
        }
        if (list.continuations?.length && list.items.length) shortWithContinuation.push(section)
        else sparse.push(...list.items)
        return false
    })
    const pool = [...sparse, ...uniqueRegionalItems(supplemental, seen).slice(0, Math.max(0, pageRows * cardsAcross - full * cardsAcross))]
    for (let i = 0; i < pool.length; i += cardsAcross) {
        const items = pool.slice(i, i + cardsAcross)
        sections.contents.push(subscriptionShelf({ items }, title))
        if (items.length === cardsAcross) full++
    }
    sections.contents.push(...shortWithContinuation)
    return full
}

function uniqueRegionalItems(items, seen) {
    return items.filter(item => {
        const id = video(item)?.contentId
        if (!id || seen.has(id)) return false
        seen.add(id)
        return true
    })
}

async function fillRegionalPage(sections, { title, search, seen = new Set(), ...options }) {
    const initial = sectionRows(sections)
    const background = AbortSignal.timeout(12000)
    const signal = options.signal ? AbortSignal.any([options.signal, background]) : background
    const scoped = { ...options, signal }
    const extra = []
    const first = regionalRows(initial, scoped)

    // Prepare additional native Home shelves in order, even if the original grid is sparse.
    const later = (async () => {
        if (!options.continuation) return
        const visited = new Set()
        for (let i = 0; i < 3 && !signal.aborted; i++) {
            const cursor = nextToken(sections)
            if (!cursor || visited.has(cursor)) break
            visited.add(cursor)
            const next = sectionList(await options.continuation(cursor, signal).catch(() => undefined))
            if (!next?.contents || nextToken(next) === cursor) break
            const candidates = next.contents.filter(section => sectionRows({ contents: [section] }).length)
            await regionalRows(sectionRows({ contents: candidates }), { ...scoped, related: undefined, budget: 2600, concurrency: 6 })
            extra.push(...candidates)
            sections.continuations = next.continuations
            if (extra.filter(section => sectionRows({ contents: [section] })[0].items.length >= cardsAcross).length >= pageRows) break
        }
    })()

    // Search supplies a wider candidate pool when Home is too narrow. Country lookup is
    // still mandatory, and native recommendations stay ahead of search results.
    const count = () => {
        const verified = structuredClone({ contents: [...sections.contents, ...extra] })
        cachedRegionalRows(sectionRows(verified), { ...options, known: options.known || (() => undefined), excluded: options.excluded || new Set() })
        return arrangeRegionalPage(verified, title, [], new Set(seen))
    }
    const more = []
    if (search && searches[options.region]) {
        for (const queries of [searches[options.region].slice(0, 3), searches[options.region].slice(3)]) {
            if (signal.aborted || count() + Math.floor(more.length / cardsAcross) >= pageRows) break
            const results = await Promise.all(queries.map(query => search(query, signal).catch(() => undefined)))
            const batch = results.map(result => ({ items: searchTiles(result?.contents).slice(0, 32) }))
            await regionalRows(batch, { ...scoped, related: undefined, continuation: undefined, budget: 4200, concurrency: 8 })
            const known = new Set([...seen, ...more.map(item => video(item).contentId)])
            more.push(...uniqueRegionalItems(batch.flatMap(row => row.items), known))
        }
    }
    await Promise.all([first, later])
    sections.contents.push(...extra)
    arrangeRegionalPage(sections, title, more, new Set(seen))
}

module.exports = { matchesRegion, cachedRegionalRows, regionalRows, fillRegionalPage }
