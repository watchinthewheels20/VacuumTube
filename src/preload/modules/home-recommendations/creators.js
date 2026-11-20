const { findField } = require('./channels')
const { text, channelId, video, matchesCreator } = require('./feed')

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

async function suggestedCreators(rows, { details, owner, lookup, ignored, blocked, excluded }) {
    const samples = rows.flatMap(row => row.items.slice(0, 5)).map(video)
        .filter(tile => tile && !excluded.has(tile.contentId)).slice(0, 16)
    const ids = new Set()
    const result = new Map()
    let index = 0
    const deadline = Date.now() + 1600
    async function worker() {
        while (index < samples.length && Date.now() < deadline && ids.size < 8) {
            const order = index++
            const tile = samples[order]
            const direct = details(tile)
            const id = direct.id || (await owner(tile.contentId))?.id
            if (!channelId.test(id) || ids.has(id) || ignored.includes(id) || blocked.some(entry => matchesCreator(entry, { ...direct, id }))) continue
            ids.add(id)
            const response = await lookup(id).catch(() => undefined)
            const match = suggestion(response, id, tile)
            if (match) result.set(order, match)
        }
    }
    let timer
    try {
        await Promise.race([Promise.all([worker(), worker(), worker()]), new Promise(resolve => { timer = setTimeout(resolve, 1650) })])
    } finally { clearTimeout(timer) }
    return [...result].sort(([a], [b]) => a - b).map(([, item]) => item)
}

function creatorTile(creator) {
    return { tileRenderer: {
        style: 'TILE_STYLE_YTLR_DEFAULT', contentType: 'TILE_CONTENT_TYPE_CHANNEL', contentId: creator.id,
        header: { tileHeaderRenderer: { thumbnail: creator.thumbnail } },
        metadata: { tileMetadataRenderer: { title: { simpleText: creator.name },
            lines: [{ lineRenderer: { items: [{ lineItemRenderer: { text: { simpleText: creator.description } } }] } }] } },
        onSelectCommand: { vtCreatorAction: 'options', channelId: creator.id }
    } }
}

module.exports = { suggestedCreators, creatorTile, suggestion }
