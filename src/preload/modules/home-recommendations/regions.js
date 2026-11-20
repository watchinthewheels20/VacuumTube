const { lists, video, lockupTile, videoId } = require('./feed')
const { findField } = require('./channels')

const europe = new Set('AD AL AM AT AZ BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GE GG GI GR HR HU IE IM IS IT JE KZ LI LT LU LV MC MD ME MK MT NL NO PL PT RO RS RU SE SI SJ SK SM TR UA VA XK'.split(' '))
const displayNames = new Intl.DisplayNames(['en'], { type: 'region' })
const countries = new Map([...europe].map(code => [displayNames.of(code), code]))
countries.set('Turkey', 'TR')
countries.set('Czech Republic', 'CZ')
countries.set('Macedonia', 'MK')

function matchesRegion(country, region) {
    const code = countries.get(country) || country
    return region === 'UK' ? code === 'GB' : region === 'EU' && europe.has(code)
}

function nextToken(list) {
    const entry = list?.continuations?.[0]
    return entry?.nextContinuationData?.continuation || entry?.reloadContinuationData?.continuation
}

async function regionalRows(rows, { region, lookup, continuation, excluded = new Set(), related }) {
    const deadline = Date.now() + 6500
    const candidates = new Map()
    const queue = []
    let active = 0
    function pump() {
        while (queue.length && active < 12) {
            const { tile, resolve } = queue.shift()
            if (Date.now() >= deadline) {
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
    const states = rows.map(list => ({ list, accepted: [], seeds: list.items.map(video).filter(Boolean), ids: new Set() }))
    async function filter(state, items) {
        const results = new Array(items.length)
        let index = 0
        let timer
        async function worker() {
            while (index < items.length && Date.now() < deadline) {
                const slot = index++
                const item = items[slot]
                const tile = video(item) || lockupTile(item.lockupViewModel, findField(item.lockupViewModel, 'menuRenderer'))
                if (!tile || excluded.has(tile.contentId) || state.ids.has(tile.contentId)) continue
                state.ids.add(tile.contentId)
                if (!candidates.has(tile.contentId)) candidates.set(tile.contentId, new Promise(resolve => {
                    queue.push({ tile, resolve })
                    pump()
                }))
                if (matchesRegion(await candidates.get(tile.contentId), region)) results[slot] = { tileRenderer: tile }
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
        for (let page = 0; page < 2 && state.accepted.length < 4 && Date.now() < deadline; page++) {
            const token = nextToken(state.list)
            if (!token || !continuation) break
            const response = await continuation(token).catch(() => undefined)
            const next = lists(response)[0]
            if (!next || nextToken(next) === token) break
            state.list.continuations = next.continuations
            await filter(state, next.items)
        }
        if (related && state.accepted.length < 4 && Date.now() < deadline) {
            const seed = (state.accepted.map(video).find(Boolean) || state.seeds[0])?.contentId
            if (videoId.test(seed)) {
                const result = await related(seed).catch(() => undefined)
                const shelves = result?.contents?.singleColumnWatchNextResults?.pivot?.sectionListRenderer?.contents || []
                await filter(state, shelves.flatMap(shelf => shelf.shelfRenderer?.content?.horizontalListRenderer?.items || []).slice(0, 24))
            }
        }
        state.list.items = state.accepted
    }))
}

module.exports = { matchesRegion, regionalRows }
