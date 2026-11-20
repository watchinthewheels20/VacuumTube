const channelId = /^UC[\w-]{22}$/
const videoId = /^[\w-]{11}$/
const homeIds = new Set(['default', 'FEtopics', 'FEwhat_to_watch'])
const prefix = 'vacuumtube.home.'
const regionalHomes = { UK: 'FEvacuumtube_uk', EU: 'FEvacuumtube_eu' }
const continuationTag = /^vacuumtube\.home\.(home|uploads)\.(?:(UK|EU)\.)?/
// Leanback's compact widescreen tile has a fixed native slot on focus and blur.
const homeTileStyle = 'TILE_STYLE_YTLR_EDU'

function feedSource(request) {
    if (homeIds.has(request?.browseId) || regionFor(request)) return continuationTag.exec(request?.continuation)?.[1] || 'home'
    return continuationTag.exec(request?.continuation)?.[1]
}

function regionFor(request) {
    return Object.keys(regionalHomes).find(region => regionalHomes[region] === request?.browseId) ||
        continuationTag.exec(request?.continuation)?.[2]
}

function prepareRequest(request, preferUK) {
    const source = feedSource(request)
    if (!source) return false
    const region = regionFor(request)
    if (request.continuation) request.continuation = request.continuation.replace(continuationTag, '')
    if (region && request.browseId) request.browseId = 'FEtopics'
    if (source === 'home' && request.context?.client && (region || preferUK)) request.context.client.gl = region === 'EU' ? 'FR' : 'GB'
    return true
}

function tagContinuations(renderer, source, region) {
    for (const entry of renderer?.continuations || []) {
        const data = entry.nextContinuationData || entry.reloadContinuationData
        if (typeof data?.continuation === 'string' && !data.continuation.startsWith(prefix)) {
            data.continuation = prefix + source + '.' + (region ? region + '.' : '') + data.continuation
        }
    }
}

function selectedContent(json) {
    const browse = json?.contents?.tvBrowseRenderer?.content
    const sections = browse?.tvSecondaryNavRenderer?.sections || []
    for (const section of sections) {
        const tabs = section.tvSecondaryNavSectionRenderer?.tabs || []
        const tab = tabs.find(entry => entry.tabRenderer?.selected) || tabs.find(entry => entry.tabRenderer?.content)
        if (tab?.tabRenderer?.content) return tab.tabRenderer.content.tvSurfaceContentRenderer?.content
    }
    return browse?.tvSurfaceContentRenderer?.content
}

function sectionList(json) {
    const next = json?.continuationContents
    return next?.sectionListContinuation || next?.tvSurfaceContentContinuation?.content?.sectionListRenderer || selectedContent(json)?.sectionListRenderer
}

function lists(json) {
    const next = json?.continuationContents
    const single = next?.horizontalListContinuation || next?.gridContinuation || next?.tvSurfaceContentContinuation?.content?.gridRenderer || selectedContent(json)?.gridRenderer
    if (Array.isArray(single?.items)) return [single]
    return (sectionList(json)?.contents || []).map(section =>
        section?.shelfRenderer?.content?.horizontalListRenderer || section?.gridRenderer
    ).filter(list => Array.isArray(list?.items))
}

function video(item) {
    const tile = item?.tileRenderer
    if (!videoId.test(tile?.contentId) || !['TILE_CONTENT_TYPE_VIDEO', 'TILE_CONTENT_TYPE_SHORTS', 'TILE_CONTENT_TYPE_SHORT'].includes(tile.contentType)) return
    return tile
}

function lockupTile(lockup, menu) {
    if (lockup?.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO' || !videoId.test(lockup.contentId)) return
    const metadata = lockup.metadata?.lockupMetadataViewModel
    const lines = metadata?.metadata?.contentMetadataViewModel?.metadataRows?.map(row => ({ lineRenderer: {
        items: (row.metadataParts || []).map(part => ({ lineItemRenderer: { text: { runs: [{
            text: part.text?.content || '', navigationEndpoint: part.text?.commandRuns?.[0]?.onTap?.innertubeCommand
        }] } } }))
    } }))
    return {
        contentId: lockup.contentId, contentType: 'TILE_CONTENT_TYPE_VIDEO', style: homeTileStyle,
        onSelectCommand: lockup.rendererContext?.commandContext?.onTap?.innertubeCommand || { watchEndpoint: { videoId: lockup.contentId } },
        onLongPressCommand: menu && { showMenuCommand: { menu: { menuRenderer: menu }, contentId: lockup.contentId,
            title: { simpleText: metadata?.title?.content } } },
        metadata: { tileMetadataRenderer: { title: { simpleText: metadata?.title?.content }, lines } },
        header: { tileHeaderRenderer: { thumbnail: { thumbnails: lockup.contentImage?.thumbnailViewModel?.image?.sources || [] } } }
    }
}

function watchedMenu(items, id, label) {
    if (!Array.isArray(items) || !videoId.test(id) || items.some(item => item.menuNavigationItemRenderer?.navigationEndpoint?.vtHomeAction === 'watched')) return
    items.push({ menuNavigationItemRenderer: { text: { simpleText: label }, navigationEndpoint: { vtHomeAction: 'watched', videoId: id } } })
    return true
}

function text(value) {
    return value?.simpleText || value?.runs?.map(run => run.text).join('') || ''
}

function creator(tile) {
    const menu = tile.onLongPressCommand?.showMenuCommand
    const line = tile.metadata?.tileMetadataRenderer?.lines?.[0]?.lineRenderer?.items?.[0]?.lineItemRenderer?.text
    const links = (menu?.menu?.menuRenderer?.items || []).map(item => item.menuNavigationItemRenderer?.navigationEndpoint)
    const byline = tile.shortBylineText || tile.longBylineText || line
    links.unshift(...(byline?.runs || []).map(run => run.navigationEndpoint))
    const id = links.map(link => link?.browseEndpoint?.browseId).find(value => channelId.test(value))
    const subtitle = text(menu?.subtitle)
    const handle = subtitle.match(/(?:^|\s)(@[^\s•]+)$/u)?.[1]?.toLowerCase()
    return { id, handle, name: text(byline) || subtitle.split(' • ')[0] || handle || id }
}

function matchesCreator(a, b) {
    if (a.id && b.id) return a.id === b.id
    return Boolean(a.handle && a.handle === b.handle)
}

function addMenu(tile, labels) {
    if (!tile.onLongPressCommand?.showMenuCommand) tile.onLongPressCommand = { showMenuCommand: {
        contentId: tile.contentId, title: tile.metadata?.tileMetadataRenderer?.title,
        thumbnail: tile.header?.tileHeaderRenderer?.thumbnail, menu: { menuRenderer: { items: [] } }
    } }
    const items = tile.onLongPressCommand.showMenuCommand?.menu?.menuRenderer?.items
    if (!Array.isArray(items)) return
    let nativeHide
    for (const item of items) {
        const renderer = item.menuServiceItemRenderer || item.menuNavigationItemRenderer
        if (!renderer) continue
        const key = renderer.serviceEndpoint ? 'serviceEndpoint' : 'navigationEndpoint'
        if (renderer[key] && (['VISIBILITY_OFF', 'NOT_INTERESTED'].includes(renderer.icon?.iconType) ||
            /^(hide|hide this video|not interested)$/i.test(text(renderer.text)))) {
            nativeHide = renderer[key]
            renderer[key] = { vtHomeAction: 'hide', videoId: tile.contentId }
            break
        }
    }
    for (const [action, title] of [['why', labels.why], ['block', labels.block], ['hide', labels.hide]]) {
        if (action === 'hide' && nativeHide) continue
        items.push({ menuNavigationItemRenderer: {
            text: { runs: [{ text: title }] },
            navigationEndpoint: { vtHomeAction: action, videoId: tile.contentId }
        } })
    }
    watchedMenu(items, tile.contentId, labels.watched)
    return nativeHide
}

function subscriptionList(json, hideShorts) {
    const rows = lists(json)
    const items = rows.flatMap(row => row.items).filter(item => {
        const tile = video(item)
        return tile && (!hideShorts || tile.contentType === 'TILE_CONTENT_TYPE_VIDEO')
    })
    const continuations = sectionList(json)?.continuations || rows.find(row => row.continuations?.length)?.continuations
    return { items, continuations }
}

function subscriptionShelf(list, title) {
    return { shelfRenderer: {
        headerRenderer: { shelfHeaderRenderer: { avatarLockup: { avatarLockupRenderer: {
            title: { runs: [{ text: title }] }, size: 'AVATAR_LOCKUP_SIZE_SMALL'
        } } } },
        content: { horizontalListRenderer: Object.assign(list, { visibleItemCount: 4 }) }
    } }
}

// Move UK choices into the existing video slots; leave other tile types in place.
function rankList(list, source, { seen, blocked, excluded, details, labels, remember, region }) {
    const videos = []
    list.items = list.items.filter(item => {
        const tile = video(item)
        if (!tile) return true
        const info = details(tile)
        if (excluded?.has(tile.contentId) || seen.has(tile.contentId) || blocked.some(entry => matchesCreator(entry, info))) return false
        seen.add(tile.contentId)
        const nativeHide = addMenu(tile, labels)
        if (tile.contentType === 'TILE_CONTENT_TYPE_VIDEO') {
            tile.style = homeTileStyle
            delete tile.styling
        }
        remember(tile.contentId, { ...info, source, nativeHide })
        videos.push({ item, priority: source === 'home' && info.uk ? 1 : 0 })
        return true
    })
    videos.sort((a, b) => b.priority - a.priority)
    if (videos.length) list.visibleItemCount = 4
    let index = 0
    list.items = list.items.map(item => video(item) ? videos[index++].item : item)
    tagContinuations(list, source, region)
}

module.exports = { channelId, videoId, homeTileStyle, regionalHomes, regionFor, feedSource, prepareRequest, tagContinuations, sectionList, lists, video, lockupTile, watchedMenu, text, creator, matchesCreator, subscriptionList, subscriptionShelf, rankList }
