const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { sessionPath } = require('../src/session-profile')
const { rankList } = require('../src/preload/modules/home-recommendations/feed')
const { suggestion, suggestedCreators, discover, discoveryVideos, creatorTile } = require('../src/preload/modules/home-recommendations/creators')
const { homeTileStyle, creator } = require('../src/preload/modules/home-recommendations/feed')
const { thumbnailId, decorateThumbnails } = require('../src/preload/modules/home-recommendations/flags')
const labels = require('../locale/en.json').settings.home_recommendations
const { filterGuide } = require('../src/preload/modules/sidebar')
const { regionalRows, matchesRegion, fillRegionalPage, arrangeRegionalPage } = require('../src/preload/modules/home-recommendations/regions')
const feed = require('../src/preload/modules/home-recommendations/feed')
const channel = 'UC' + 'a'.repeat(22)
const video = id => ({ tileRenderer: { contentType: 'TILE_CONTENT_TYPE_VIDEO', contentId: id, onSelectCommand: { watchEndpoint: { videoId: id } } } })

test('guide filtering covers the main section, account bar and Settings footer', () => {
    const section = icons => ({ guideSectionRenderer: { items: icons.map(iconType => ({ guideEntryRenderer: { icon: { iconType } } })) } })
    const json = { items: [section(['SEARCH', 'WHAT_TO_WATCH', 'SUBSCRIPTIONS', 'TAB_LIBRARY', 'NEWS'])],
        topbar: section(['SIGN_IN']), footer: section(['SETTINGS', 'UNKNOWN']) }
    filterGuide(json)
    const icons = [json.topbar, ...json.items, json.footer].flatMap(group => group.guideSectionRenderer.items.map(row => row.guideEntryRenderer.icon.iconType))
    assert.deepEqual(icons, ['SEARCH', 'WHAT_TO_WATCH', 'SUBSCRIPTIONS', 'TAB_LIBRARY', 'SETTINGS'])
})

test('regional entries send native Home and preserve the filter on continuation requests', () => {
    const json = { items: [{ guideSectionRenderer: { items: [{ guideEntryRenderer: {
        navigationEndpoint: { browseEndpoint: { browseId: 'FEtopics' } }
    } }] } }] }
    filterGuide(json, true)
    const [, uk, eu] = json.items[0].guideSectionRenderer.items
    for (const [item, region, market] of [[uk, 'UK', 'GB'], [eu, 'EU', 'FR']]) {
        const request = { ...item.guideEntryRenderer.navigationEndpoint.browseEndpoint, context: { client: {} } }
        assert.equal(feed.regionFor(request), region)
        assert.equal(feed.prepareRequest(request, false), true)
        assert.equal(request.browseId, 'FEtopics')
        assert.equal(request.context.client.gl, market)
        const list = { continuations: [{ nextContinuationData: { continuation: 'opaque' } }] }
        feed.tagContinuations(list, 'uploads', region)
        assert.equal(feed.regionFor(list.continuations[0].nextContinuationData), region)
        assert.equal(feed.feedSource(list.continuations[0].nextContinuationData), 'uploads')
    }
})

test('regional shelves exclude unknown countries and replenish from matching continuation videos', async () => {
    const ids = ['1','2','3','4','5','6'].map(n => n.repeat(11))
    const country = new Map(ids.map((id, index) => [id, [undefined, 'United States', 'United Kingdom', 'France', 'Norway', 'United Kingdom'][index]]))
    const list = { items: ids.slice(0, 3).map(video), continuations: [{ nextContinuationData: { continuation: 'later' } }] }
    await regionalRows([list], { region: 'EU', lookup: async tile => country.get(tile.contentId), continuation: async token => {
        assert.equal(token, 'later')
        return { continuationContents: { horizontalListContinuation: { items: ids.slice(3).map(video) } } }
    } })
    assert.deepEqual(list.items.map(item => item.tileRenderer.contentId), ids.slice(2))
    assert.equal(list.continuations, undefined)
    assert.equal(matchesRegion('GB', 'UK'), true)
    assert.equal(matchesRegion('France', 'UK'), false)
    assert.equal(matchesRegion(undefined, 'EU'), false)
})

test('both regional pages fill six shelves from sparse Home, skipping duplicates and unverified countries', async () => {
    const setup = index => video(String(index).padStart(11, '0'))
    const ids = (start, length) => Array.from({ length }, (_, i) => setup(start + i))
    for (const region of ['UK', 'EU']) {
        const title = 'More from ' + region
        const sections = { contents: [feed.subscriptionShelf({ items: ids(0, 4) }, 'First shelf')],
            continuations: [{ nextContinuationData: { continuation: 'next-home' } }] }
        const country = tile => {
            const id = Number(tile.contentId)
            return id < 4 ? [undefined, 'United States', 'United Kingdom', 'Ireland'][id] :
                id % 2 === 0 ? 'United Kingdom' : 'Ireland'
        }
        const seen = new Set(['00000000002'])
        const calls = []
        await fillRegionalPage(sections, { region, title, seen, known: country, lookup: async () => undefined,
            continuation: async token => {
                calls.push(token)
                return { continuationContents: { sectionListContinuation: {
                    contents: [feed.subscriptionShelf({ items: ids(4, 60) }, 'More native Home')],
                    continuations: [{ nextContinuationData: { continuation: 'unneeded-page' } }]
                } } }
            }
        })
        assert.deepEqual(calls, ['next-home'])
        assert.equal(sections.continuations[0].nextContinuationData.continuation, 'unneeded-page')
        const rows = feed.lists({ continuationContents: { sectionListContinuation: sections } })
        const tiles = rows.flatMap(row => row.items.map(feed.video))
        assert.ok(rows.filter(row => row.items.length >= 4).length >= 6)
        assert.equal(new Set(tiles.map(tile => tile.contentId)).size, tiles.length)
        assert.ok(tiles.every(tile => !seen.has(tile.contentId) && matchesRegion(country(tile), region)))
        assert.ok(sections.contents.some(section => section.shelfRenderer?.headerRenderer?.shelfHeaderRenderer?.avatarLockup?.avatarLockupRenderer?.title.runs[0].text === 'More native Home'))
    }
})

test('regional backfill uses personalised related videos without querying topics or bulk channel uploads', { timeout: 2000 }, async () => {
    const firstMatch = Promise.withResolvers()
    const sections = { contents: [feed.subscriptionShelf({ items: [video('00000000099')] }, 'Recommended')] }
    const items = Array.from({ length: 24 }, (_, i) => video(String(i + 1).padStart(11, '0')))
    const complete = fillRegionalPage(sections, {
        region: 'UK', title: 'More from the UK',
        known: () => undefined, lookup: async tile => tile.contentId === '00000000099' ? undefined : 'United Kingdom',
        onMatch: firstMatch.resolve,
        related: async id => {
            assert.equal(id, '00000000099')
            return { contents: { singleColumnWatchNextResults: { pivot: { sectionListRenderer: {
                contents: [feed.subscriptionShelf({ items }, 'Related')]
            } } } } }
        },
        search: () => { throw Error('Unsolicited topic search') },
        relatedChannels: () => { throw Error('Unsolicited channel backfill') }
    })
    const first = await firstMatch.promise
    assert.ok(items.some(item => item.tileRenderer === first))
    await complete
    assert.equal(sections.contents.length, 6)
})

test('two full native shelves still backfill a whole page from personalised related recommendations', async () => {
    const items = Array.from({ length: 24 }, (_, i) => video(String(i + 1).padStart(11, '0')))
    const sections = { contents: [feed.subscriptionShelf({ items: items.slice(0, 4) }, 'Recommended'),
        feed.subscriptionShelf({ items: items.slice(4, 8) }, 'Another native shelf')] }
    let calls = 0
    await fillRegionalPage(sections, { region: 'UK', title: 'More from the UK', known: () => 'United Kingdom',
        lookup: async () => { throw Error('Known countries should be reused') },
        related: async () => {
            calls++
            return { contents: { singleColumnWatchNextResults: { pivot: { sectionListRenderer: {
                contents: [feed.subscriptionShelf({ items }, 'Related')]
            } } } } }
        }
    })
    const rows = feed.lists({ continuationContents: { sectionListContinuation: sections } })
    assert.equal(calls, 3, 'stop the related backfill after the first sufficient batch')
    assert.deepEqual(rows.map(row => row.items.length), [4, 4, 4, 4, 4, 4])
    assert.equal(new Set(rows.flatMap(row => row.items.map(item => feed.video(item).contentId))).size, 24)
})

test('a long shelf and a short paged shelf become six rows when 24 verified videos are already available', () => {
    const items = Array.from({ length: 24 }, (_, i) => video(String(i + 1).padStart(11, '0')))
    const sections = { contents: [
        feed.subscriptionShelf({ items: items.slice(0, 22) }, 'Recommended'),
        feed.subscriptionShelf({ items: items.slice(22), continuations: [{ nextContinuationData: { continuation: 'cursor' } }] }, 'Recently uploaded')
    ] }
    assert.equal(arrangeRegionalPage(sections, 'More from the UK', [], new Set()), 6)
    const lists = feed.lists({ continuationContents: { sectionListContinuation: sections } })
    assert.deepEqual(lists.map(list => list.items.length), [4, 4, 4, 4, 4, 4])
    assert.equal(new Set(lists.flatMap(list => list.items.map(item => feed.video(item).contentId))).size, 24)
})

test('reinstalls prefer the established session and retain a legacy root profile in place', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vacuumtube-profile-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const nested = path.join(root, 'sessionData')
    assert.equal(sessionPath(root), nested)
    fs.mkdirSync(path.join(root, 'IndexedDB'))
    assert.equal(sessionPath(root), root)
    fs.mkdirSync(path.join(nested, 'IndexedDB'), { recursive: true })
    assert.equal(sessionPath(root), nested)
})

test('hidden and watched videos are removed before ranking and following tiles fill the slots', () => {
    const ids = [1, 2, 3, 4, 5, 6].map(n => String(n).repeat(11))
    const list = { items: ids.map(video), visibleItemCount: 3 }
    const endpoint = { feedbackEndpoint: { feedbackToken: 'fixture' } }
    list.items[0].tileRenderer.onLongPressCommand = { showMenuCommand: { menu: { menuRenderer: { items: [
        { menuServiceItemRenderer: { text: { simpleText: 'Hide' }, serviceEndpoint: endpoint } }
    ] } } } }
    const cards = new Map()
    rankList(list, 'home', { seen: new Set(), blocked: [], excluded: new Set([ids[1], ids[3]]),
        details: () => ({}), labels, remember: (id, info) => cards.set(id, info) })
    assert.equal(list.visibleItemCount, 4)
    assert.deepEqual(list.items.map(item => item.tileRenderer.contentId), [ids[0], ids[2], ids[4], ids[5]])
    assert.equal(cards.get(ids[0]).nativeHide, endpoint)
    assert.equal(list.items[0].tileRenderer.onLongPressCommand.showMenuCommand.menu.menuRenderer.items[0].menuServiceItemRenderer.serviceEndpoint.vtHomeAction, 'hide')
})

test('creator cards require an explicit unsubscribed state and an action for the matching channel', async () => {
    const subscribe = { subscribeEndpoint: { channelIds: [channel] } }
    const button = { channelId: channel, subscribed: false, serviceEndpoints: [subscribe] }
    const header = { title: { simpleText: 'Fixture channel' }, buttons: [{ subscribeButtonRenderer: button }],
        selectableDescription: { selectableTextRenderer: { compactDescription: { simpleText: 'A science channel.' } } } }
    const reply = { header: { channelHeaderRenderer: header } }
    const sample = video('a'.repeat(11))
    assert.equal(suggestion(reply, channel, sample.tileRenderer).subscribe, subscribe)
    button.subscribed = true
    assert.equal(suggestion(reply, channel, sample.tileRenderer), undefined)
    delete button.subscribed
    assert.equal(suggestion(reply, channel, sample.tileRenderer), undefined)
    button.subscribed = false
    const options = { details: () => ({ id: channel }), lookup: async () => reply, blocked: [], ignored: [], excluded: new Set() }
    const tiles = [sample.tileRenderer, sample.tileRenderer]
    assert.equal((await suggestedCreators(tiles, options)).length, 1)
    assert.deepEqual(await suggestedCreators(tiles, { ...options, ignored: [channel] }), [])
    assert.deepEqual(await suggestedCreators(tiles, { ...options, blocked: [{ id: channel }] }), [])
})

test('Home uses a fixed native widescreen slot for video and creator cards, including restyled uploads', () => {
    for (const source of ['home', 'uploads']) {
        const item = video('a'.repeat(11))
        item.tileRenderer.styling = { scale: 'TILE_SCALE_XL' }
        rankList({ items: [item] }, source, { seen: new Set(), blocked: [], details: () => ({}), labels, remember() {} })
        assert.equal(item.tileRenderer.style, 'TILE_STYLE_YTLR_EDU')
        assert.equal(item.tileRenderer.styling, undefined)
    }
    assert.equal(creatorTile({ id: channel }).tileRenderer.style, homeTileStyle)
})

test('thumbnail identity works for stills, live video, previews, storyboards and DeArrow', () => {
    const id = 'video-123_4'
    for (const path of ['vi', 'vi_webp', 'vi_live', 'an_webp', 'sb']) {
        assert.equal(thumbnailId('url("https://i.ytimg.com/' + path + '/' + id + '/frame.jpg")'), id)
    }
    assert.equal(thumbnailId('url("https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=' + id + '")'), id)
    assert.equal(thumbnailId('https://yt3.ggpht.com/a-channel-avatar'), undefined)
})

test('a recycled thumbnail gets its globe immediately and keeps it when the old country arrives late', async t => {
    let frame, mutate, intersect
    let source = '/vi/11111111111/default.jpg'
    const pending = new Map()
    t.mock.method(fs.promises, 'readFile', async () => 'fixture')
    const host = { isConnected: true, style: {}, querySelectorAll: () => [{ src: source, style: {} }],
        appendChild(badge) { this.badge = badge; badge.parentElement = this } }
    const doc = { documentElement: {}, querySelectorAll: () => [host], createElement: () => ({
        style: {}, setAttribute() {}, remove() { this.parentElement = null }
    }) }
    const globals = { document: doc, window: new EventTarget(), getComputedStyle: () => ({ position: 'relative' }),
        requestAnimationFrame(fn) { frame = fn; return 1 },
        IntersectionObserver: class { constructor(fn) { intersect = fn } observe() {} unobserve() {} },
        MutationObserver: class { constructor(fn) { mutate = fn } observe() {} } }
    for (const [key, value] of Object.entries(globals)) {
        global[key] = value
        t.after(() => { delete global[key] })
    }
    decorateThumbnails(id => new Promise(resolve => pending.set(id, resolve)), () => 'Unknown', () => true)
    frame()
    assert.equal(host.badge.title, 'Unknown')
    intersect([{ target: host, isIntersecting: true }])
    await Promise.resolve()
    const original = host.badge
    source = '/vi/22222222222/default.jpg'
    mutate([{ type: 'attributes', target: { closest: () => host } }])
    frame()
    await Promise.resolve()
    assert.notEqual(host.badge, original)
    pending.get('11111111111')('United Kingdom')
    pending.get('22222222222')(undefined)
    await new Promise(resolve => setImmediate(resolve))
    // A native render can discard the decoration without changing its video.
    host.badge.remove()
    mutate([{ type: 'childList', target: { closest: () => host } }])
    frame()
    assert.equal(host.badge.parentElement, host)
    assert.equal(host.badge.title, 'Unknown')
})

test('new creators come from related videos and exclude Home, subscriptions, history, hidden and ignored choices', async () => {
    const channelId = n => 'UC' + n.repeat(22)
    const tile = (n, by) => ({ ...video(n.repeat(11)).tileRenderer, shortBylineText: { runs: [{
        text: by, navigationEndpoint: { browseEndpoint: { browseId: channelId(by) } }
    }] } })
    const history = discoveryVideos({ items: [{ lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', contentId: '1'.repeat(11),
        metadata: { lockupMetadataViewModel: { metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: 'a' } }] }] } } } }
    } }] })
    const seeds = []
    const candidates = [tile('4','a'), tile('5','b'), tile('6','c'), tile('7','d'), tile('8','e'), tile('9','f'), tile('0','g')]
    const options = { history, uploads: [tile('2','b')], home: [tile('3','c')], details: creator, owner: async () => undefined,
        ignored: [channelId('d')], blocked: [{ id: channelId('e') }], excluded: new Set(['9'.repeat(11)]),
        related: async id => {
            seeds.push(id)
            return { contents: { singleColumnWatchNextResults: { pivot: { items: candidates.map(tileRenderer => ({ tileRenderer })) } } } }
        }, lookup: async id => ({ header: { channelHeaderRenderer: { title: { simpleText: 'A new creator' },
            selectableDescription: { selectableTextRenderer: { compactDescription: { simpleText: 'Channel description' } } },
            buttons: [{ subscribeButtonRenderer: { channelId: id, subscribed: false, serviceEndpoints: [{ subscribeEndpoint: { channelIds: [id] } }] } }] } } }) }
    assert.deepEqual((await discover(options)).map(c => c.id), [channelId('g')])
    assert.deepEqual(seeds, ['1','2','3'].map(n => n.repeat(11)))
    assert.deepEqual(await discover({ ...options, related: async () => { throw Error('offline') } }), [])
})
