const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const feed = require('../src/preload/modules/home-recommendations/feed')
const { channelDirectory } = require('../src/preload/modules/home-recommendations/channels')
const labels = require('../locale/en.json').settings.home_recommendations

const first = '11111111111'
const second = '22222222222'
const third = '33333333333'
const channel = 'UC' + 'a'.repeat(22)
const other = 'UC' + 'b'.repeat(22)

function item(id, owner, handle = '@example') {
    return { tileRenderer: {
        contentId: id, contentType: 'TILE_CONTENT_TYPE_VIDEO',
        onSelectCommand: { watchEndpoint: { videoId: id } },
        onLongPressCommand: { showMenuCommand: {
            subtitle: { simpleText: 'Creator • ' + handle },
            menu: { menuRenderer: { items: [{ menuNavigationItemRenderer: {
                text: { simpleText: 'Go to channel' }, navigationEndpoint: { browseEndpoint: { browseId: owner } }
            } }] } }
        } }
    } }
}

function surface(content) {
    return { contents: { tvBrowseRenderer: { content: { tvSurfaceContentRenderer: { content } } } } }
}

test('Home and its tagged continuations use the UK preference independently of other feeds', () => {
    for (const browseId of ['default', 'FEtopics', 'FEwhat_to_watch', 'FEsubscriptions', 'FElibrary', 'FEtopics_music']) {
        const request = { browseId, context: { client: { gl: 'US' } } }
        const home = ['default', 'FEtopics', 'FEwhat_to_watch'].includes(browseId)
        assert.equal(feed.prepareRequest(request, true), home)
        assert.equal(request.context.client.gl, home ? 'GB' : 'US')
    }
    const list = { continuations: [{ nextContinuationData: { continuation: 'opaque' } }] }
    feed.tagContinuations(list, 'uploads')
    const original = list.continuations[0].nextContinuationData.continuation
    const request = { continuation: original, context: { client: { gl: 'US' } } }
    assert.equal(feed.feedSource(request), 'uploads')
    assert.equal(feed.prepareRequest(request, true), true)
    assert.equal(request.continuation, 'opaque')
    assert.equal(request.context.client.gl, 'US')
    assert.equal(feed.feedSource(request), undefined)
})

test('UK promotion preserves non-video slots, the native menu and other discovery choices', () => {
    const untouched = { unrelatedRenderer: {} }
    const list = { items: [item(first, channel), untouched, item(second, other)] }
    const seen = new Set()
    feed.rankList(list, 'home', { seen, blocked: [], labels, remember() {},
        details: tile => ({ ...feed.creator(tile), uk: tile.contentId === second }) })
    assert.deepEqual(list.items.map(i => i.tileRenderer?.contentId), [second, undefined, first])
    assert.equal(list.items[1], untouched)
    const tile = list.items[0].tileRenderer
    assert.equal(tile.onSelectCommand.watchEndpoint.videoId, second)
    const menu = tile.onLongPressCommand.showMenuCommand.menu.menuRenderer.items
    assert.deepEqual(menu.map(entry => entry.menuNavigationItemRenderer.navigationEndpoint.vtHomeAction), [undefined, 'why', 'block', 'hide', 'watched'])
    assert.equal(list.visibleItemCount, 4)
    assert.equal(feed.matchesCreator({ id: channel, handle: '@same' }, { id: other, handle: '@same' }), false)
})

test('public metadata resolves the uploader and its About country once, with credentials omitted', async () => {
    const requests = []
    const directory = channelDirectory(async (url, options) => {
        requests.push({ url, options })
        const data = JSON.parse(options.body)
        if (data.videoId) return Response.json({ contents: { twoColumnWatchNextResults: { results: { results: {
            contents: [{ videoSecondaryInfoRenderer: { owner: { videoOwnerRenderer: { navigationEndpoint: { browseEndpoint: { browseId: channel } } } } } }]
        } } } } })
        if (data.browseId) return Response.json({ header: { pageHeaderRenderer: { continuationCommand: { token: 'about' } } } })
        return Response.json({ onResponseReceivedEndpoints: [{ aboutChannelViewModel: { channelId: channel, country: 'United Kingdom' } }] })
    }, '2.test')
    assert.equal((await directory.owner(first)).id, channel)
    assert.deepEqual(await Promise.all([directory.country(channel), directory.country(channel)]), ['United Kingdom', 'United Kingdom'])
    assert.equal(directory.knownUK(channel), true)
    assert.equal(directory.knownUK(other), false)
    assert.equal(requests.length, 3)
    assert.ok(requests.every(({ options }) => options.credentials === 'omit' && options.redirect === 'error'))
})

test('subscriptions take videos from the selected TV tab and honour the existing Hide Shorts setting', () => {
    const video = item(first, channel)
    const short = item(second, other)
    short.tileRenderer.contentType = 'TILE_CONTENT_TYPE_SHORTS'
    const json = { contents: { tvBrowseRenderer: { content: { tvSecondaryNavRenderer: { sections: [
        { tvSecondaryNavSectionRenderer: { tabs: [
            { tabRenderer: {} },
            { tabRenderer: { selected: true, content: { tvSurfaceContentRenderer: { content: {
                gridRenderer: { items: [video, short], continuations: [{ nextContinuationData: { continuation: 'more' } }] }
            } } } } }
        ] } }
    ] } } } } }
    assert.deepEqual(feed.subscriptionList(json, false).items, [video, short])
    assert.deepEqual(feed.subscriptionList(json, true).items, [video])
    assert.equal(feed.subscriptionList(json, true).continuations[0].nextContinuationData.continuation, 'more')
})

test('preload combines feeds, handles actions and older uploads, and leaves other screens and Kids alone', async t => {
    const hooks = {}
    const commands = []
    const panels = []
    const config = { prefer_uk_creators: false, home_blocked_creators: [] }
    const mocks = {
        '../../config': { get: () => config, set: patch => Object.assign(config, patch) },
        '../../util/xhrModifiers': { addRequestModifier: fn => { hooks.send = fn }, addResponseModifier: fn => { hooks.receive = fn } },
        '../../util/resolveCommandModifiers': { addInputModifier: fn => { hooks.action = fn }, resolveCommand: cmd => commands.push(cmd) },
        '../../util/localeProvider': { getLocale: () => undefined },
        '../../util/ui': { toast() {}, popupMenu: options => { panels.push(options); return { openPopupAction: {} } } }
    }
    const originalLoad = Module._load
    t.mock.method(Module, '_load', function (name, ...args) { return mocks[name] || originalLoad.call(this, name, ...args) })
    let publicFetch = async () => { throw Error('unexpected public request') }
    const win = Object.assign(new EventTarget(), { fetch: (...args) => publicFetch(...args) })
    global.window = win
    t.after(() => { win.dispatchEvent(new Event('pagehide')); delete global.window })
    require('../src/preload/modules/home-recommendations')()
    const url = '/youtubei/v1/browse'
    const home = surface({ sectionListRenderer: { contents: [feed.subscriptionShelf({ items: [item(first, channel), item(second, other, '@other')] }, 'Recommended')] } })
    const uploads = surface({ gridRenderer: { items: [item(first, channel)], continuations: [{ nextContinuationData: { continuation: 'older' } }] } })
    let requests = 0
    async function browse(request, response = home, getUploads = async () => { requests++; return structuredClone(uploads) }) {
        const body = JSON.stringify({ context: { client: { clientName: 'TVHTML5' } }, ...request })
        const info = { body, subscriptions: getUploads }
        const sent = JSON.parse(hooks.send(url, body, info))
        const result = await hooks.receive(url, JSON.stringify(response), info)
        return { sent, json: result && JSON.parse(result) }
    }
    assert.equal((await browse({ browseId: 'default' })).json, undefined)
    home.contents.tvBrowseRenderer.content.tvSurfaceContentRenderer.targetId = 'browse-feedFEtopics'
    const initial = await browse({ browseId: 'default' })
    const [subRow, discovery] = feed.lists(initial.json)
    assert.deepEqual(subRow.items.map(i => i.tileRenderer.contentId), [first])
    assert.deepEqual(discovery.items.map(i => i.tileRenderer.contentId), [second])
    const action = (tile, i) => tile.onLongPressCommand.showMenuCommand.menu.menuRenderer.items[i].menuNavigationItemRenderer.navigationEndpoint
    hooks.action(action(subRow.items[0].tileRenderer, 1))
    hooks.action(action(discovery.items[0].tileRenderer, 1))
    assert.deepEqual(panels.map(panel => panel.subtitle), [labels.subscription_reason, labels.shelf_reason.replace('{shelf}', 'Recommended')])
    const older = await browse({ continuation: subRow.continuations[0].nextContinuationData.continuation },
        { continuationContents: { gridContinuation: { items: [item(third, channel)] } } })
    assert.equal(older.sent.continuation, 'older')
    assert.equal(older.json.continuationContents.horizontalListContinuation.items[0].tileRenderer.contentId, third)
    hooks.action(action(subRow.items[0].tileRenderer, 2))
    assert.equal(config.home_blocked_creators[0].id, channel)
    assert.equal(commands.at(-1).browseEndpoint.browseId, 'FEtopics')
    const refreshed = await browse({ browseId: 'FEtopics' })
    assert.deepEqual(feed.lists(refreshed.json).flatMap(row => row.items.map(i => i.tileRenderer.contentId)), [second])
    const native = feed.lists((await browse({ browseId: 'FEsubscriptions' })).json)[0].items[0].tileRenderer
    assert.deepEqual(native.onLongPressCommand.showMenuCommand.menu.menuRenderer.items.map(entry =>
        entry.menuNavigationItemRenderer.navigationEndpoint.vtHomeAction), [undefined, 'watched'])
    hooks.action(action(native, 1))
    assert.deepEqual(config.home_watched_videos, [first])
    assert.equal((await browse({ browseId: 'FEtopics', context: { client: { clientName: 'TVHTML5_FOR_KIDS' } } })).json, undefined)
    assert.equal(requests, 2)
    const offline = await browse({ browseId: 'FEtopics' }, home, async () => { throw Error('offline') })
    assert.equal(feed.lists(offline.json)[0].items[0].tileRenderer.contentId, second)

    let poll
    t.mock.method(global, 'setInterval', (fn, ms) => { assert.equal(ms, 120000); poll = fn; return 1 })
    t.mock.method(global, 'clearInterval', () => { poll = null })
    global.document = { hidden: false, hasFocus: () => true, querySelector: () => null }
    t.after(() => { delete global.document })
    let latest = []
    await browse({ browseId: 'default' }, home, async () => surface({ gridRenderer: { items: latest } }))
    commands.length = 0
    await poll()
    assert.equal(commands.length, 0)
    latest = [item(third, other)]
    global.document.hidden = true
    await poll()
    assert.equal(commands.length, 0)
    global.document.hidden = false
    await poll()
    assert.equal(commands[0].browseEndpoint.browseId, 'FEtopics')
    win.dispatchEvent(new Event('hashchange'))
    assert.equal(poll, null)

    let finishCountry
    const countryPending = new Promise(resolve => { finishCountry = resolve })
    let publicRequests = 0
    publicFetch = async (_url, request) => {
        publicRequests++
        if (JSON.parse(request.body).browseId) return Response.json({ header: { continuationCommand: { token: 'about' } } })
        await countryPending
        return Response.json({ onResponseReceivedEndpoints: [{ aboutChannelViewModel: { channelId: other, country: 'United Kingdom' } }] })
    }
    const regional = { browseId: feed.regionalHomes.UK }
    commands.length = 0
    const cold = await browse(regional, home, async () => undefined)
    assert.equal(cold.sent.browseId, 'FEtopics')
    assert.deepEqual(feed.lists(cold.json), [], 'an unresolved country never enters the first grid')
    const pendingRequests = publicRequests
    assert.ok(pendingRequests > 0)
    await browse({ browseId: 'FEsubscriptions' })
    finishCountry()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(commands, [], 'a finished lookup never reopens a regional screen the user left')
    const warm = await browse(regional, home, async () => undefined)
    assert.deepEqual(feed.lists(warm.json).flatMap(row => row.items.map(i => i.tileRenderer.contentId)), [second])
    assert.equal(publicRequests, pendingRequests, 'the warm country cache is shared across screens')
    await browse({ browseId: 'FElibrary' })
    const emptyHome = surface({ sectionListRenderer: { contents: [] } })
    const restored = await browse(regional, emptyHome, async () => { throw Error('the completed page should be reused') })
    assert.deepEqual(feed.lists(restored.json).flatMap(row => row.items.map(i => i.tileRenderer.contentId)), [second])
    config.home_watched_videos.push(second)
    const invalidated = await browse(regional, home, async () => undefined)
    assert.deepEqual(feed.lists(invalidated.json), [], 'changed watched preferences invalidate the cached page')
})
