const { findField } = require('./channels')
const { text, channelId, videoId, homeTileStyle, video, matchesCreator } = require('./feed')

// History and related results can contain either TV tiles or newer video lockups.
function discoveryVideos(node, result = []) {
    if (!node || typeof node !== 'object') return result
    if (node.tileRenderer) {
        const tile = video(node)
        if (tile) result.push(tile)
    } else if (node.lockupViewModel) {
        const lockup = node.lockupViewModel
        if (lockup.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO' || !videoId.test(lockup.contentId)) return result
        const label = lockup.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text
        const endpoint = findField(label, 'browseEndpoint') || findField(lockup.rendererContext?.menuContext, 'browseEndpoint')
        result.push({ contentId: lockup.contentId, shortBylineText: { runs: [{ text: label?.content, navigationEndpoint: { browseEndpoint: endpoint } }] },
            onSelectCommand: { watchEndpoint: { videoId: lockup.contentId } },
            header: { tileHeaderRenderer: { thumbnail: { thumbnails: lockup.contentImage?.thumbnailViewModel?.image?.sources || [] } } } })
    } else {
        for (const child of Object.values(node)) discoveryVideos(child, result)
    }
    return result
}

function interleave(groups) {
    const result = []
    const length = Math.max(0, ...groups.map(group => group.length))
    for (let i = 0; i < length; i++) {
        for (const group of groups) if (group[i]) result.push(group[i])
    }
    return result
}

async function discover({ history, uploads, home, related, ...options }) {
    const familiar = [...history, ...uploads, ...home]
    const excluded = new Set([...options.excluded, ...familiar.map(tile => tile.contentId)])
    const blocked = [...options.blocked, ...familiar.map(options.details)]
    const seedCreators = new Set()
    const seeds = []
    for (const tile of [...interleave([history, uploads]), ...home]) {
        if (options.excluded.has(tile.contentId)) continue
        const identity = options.details(tile)
        if (options.blocked.some(entry => matchesCreator(entry, identity))) continue
        const key = identity.id || identity.handle || identity.name || tile.contentId
        if (seedCreators.has(key)) continue
        seedCreators.add(key)
        seeds.push(tile.contentId)
        if (seeds.length === 3) break
    }
    const groups = await Promise.all(seeds.map(async id => {
        const page = await related(id).catch(() => undefined)
        return discoveryVideos(page?.contents?.singleColumnWatchNextResults?.pivot)
    }))
    return suggestedCreators(interleave(groups), { ...options, excluded, blocked })
}

function suggestion(response, id, sample) {
    const header = findField(response?.header || response?.contents, 'channelHeaderRenderer')
    const button = findField(header?.buttons, 'subscribeButtonRenderer')
    if (button?.channelId !== id || button.subscribed !== false || button.enabled === false) return
    const subscribe = button.serviceEndpoints?.find(command => {
        const endpoint = command.authDeterminedCommand?.authenticatedCommand || command
        return endpoint.subscribeEndpoint?.channelIds?.includes(id)
    })
    const name = text(header.title)
    const description = text(header.selectableDescription?.selectableTextRenderer?.compactDescription)
        .replace(/\s*\.\.\.more$/i, '').trim()
    if (!subscribe || !name || !description) return
    const short = description.length > 140 ? description.slice(0, 137).replace(/\s+\S*$/, '') + '…' : description
    return { id, name, description: short, subscribe, watch: sample.onSelectCommand,
        thumbnail: sample.header?.tileHeaderRenderer?.thumbnail || header.avatar }
}

async function suggestedCreators(tiles, { details, owner, lookup, ignored, blocked, excluded, eligible }) {
    const samples = tiles.filter(tile => !excluded.has(tile.contentId))
    const ids = new Set()
    const result = new Map()
    let index = 0
    const deadline = Date.now() + 1600
    async function worker() {
        while (index < samples.length && Date.now() < deadline && ids.size < 12 && result.size < 8) {
            const order = index++
            const tile = samples[order]
            const direct = details(tile)
            const id = direct.id || (await owner(tile.contentId))?.id
            if (!channelId.test(id) || ids.has(id) || ignored.includes(id)) continue
            const identity = { ...direct, id }
            if (blocked.some(entry => matchesCreator(entry, identity) ||
                (!entry.id && entry.name && identity.name && entry.name.trim().toLowerCase() === identity.name.trim().toLowerCase()))) continue
            ids.add(id)
            if (eligible && !await eligible(id)) continue
            const response = await lookup(id).catch(() => undefined)
            const match = suggestion(response, id, tile)
            if (match) result.set(order, match)
        }
    }
    let timer
    try {
        await Promise.race([Promise.all([worker(), worker(), worker()]), new Promise(resolve => { timer = setTimeout(resolve, 1650) })])
    } finally { clearTimeout(timer) }
    return [...result].sort(([a], [b]) => a - b).slice(0, 8).map(([, item]) => item)
}

function creatorTile(creator) {
    return { tileRenderer: {
        style: homeTileStyle, contentType: 'TILE_CONTENT_TYPE_CHANNEL', contentId: creator.id,
        header: { tileHeaderRenderer: { thumbnail: creator.thumbnail } },
        metadata: { tileMetadataRenderer: { title: { simpleText: creator.name },
            lines: [{ lineRenderer: { items: [{ lineItemRenderer: { text: { simpleText: creator.description } } }] } }] } },
        onSelectCommand: { vtCreatorAction: 'options', channelId: creator.id }
    } }
}

module.exports = { discover, discoveryVideos, suggestedCreators, creatorTile, suggestion }
