const { channelId, text } = require('./feed')

function findField(node, key) {
    if (!node || typeof node !== 'object') return
    if (Object.hasOwn(node, key)) return node[key]
    for (const child of Object.values(node)) {
        const result = findField(child, key)
        if (result !== undefined) return result
    }
}

// Channel pages and video owners are public. Never send the TV account with these requests.
function channelDirectory(fetchPublic, version) {
    const owners = new Map()
    const countries = new Map()
    async function query(endpoint, data) {
        const response = await fetchPublic('https://www.youtube.com/youtubei/v1/' + endpoint, {
            method: 'POST', credentials: 'omit', redirect: 'error',
            headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(2500),
            body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: version, hl: 'en', gl: 'GB' } }, ...data })
        })
        if (response.ok) return response.json()
    }

    function cached(store, key, load) {
        const entry = store.get(key)
        if (entry && Date.now() < entry.expires) {
            store.delete(key)
            store.set(key, entry)
            return entry.promise
        }
        if (store.size >= 512) store.delete(store.keys().next().value)
        const next = { expires: Date.now() + 60000 }
        next.promise = load().then(value => {
            next.value = value
            if (value) next.expires = Date.now() + 3600000
            return value
        }).catch(() => undefined)
        store.set(key, next)
        return next.promise
    }

    function known(store, id) {
        const entry = store.get(id)
        return entry?.expires > Date.now() ? entry.value : undefined
    }

    function owner(id) {
        return cached(owners, id, async () => {
            const json = await query('next', { videoId: id })
            const content = json?.contents?.twoColumnWatchNextResults?.results?.results?.contents
            const renderer = content?.find(row => row.videoSecondaryInfoRenderer)?.videoSecondaryInfoRenderer.owner?.videoOwnerRenderer
            const link = renderer?.navigationEndpoint?.browseEndpoint
            if (channelId.test(link?.browseId)) return { id: link.browseId, name: text(renderer.title),
                handle: link.canonicalBaseUrl?.match(/^\/(@[^/]+)$/u)?.[1]?.toLowerCase() }
        })
    }

    function country(id) {
        return cached(countries, id, async () => {
            const page = await query('browse', { browseId: id, params: 'EgVhYm91dA==' })
            const token = findField(page?.header, 'continuationCommand')?.token
            if (!token) return
            const about = await query('browse', { continuation: token })
            const profile = findField(about?.onResponseReceivedEndpoints, 'aboutChannelViewModel')
            if (profile && (!profile.channelId || profile.channelId === id)) return profile.country
        })
    }

    return {
        owner, country,
        knownOwner: id => known(owners, id),
        knownCountry: id => known(countries, id),
        knownUK: id => known(countries, id) === 'United Kingdom'
    }
}

module.exports = { channelDirectory, findField }
