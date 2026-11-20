const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { sessionPath } = require('../src/session-profile')
const { rankList } = require('../src/preload/modules/home-recommendations/feed')
const { suggestion, suggestedCreators } = require('../src/preload/modules/home-recommendations/creators')
const labels = require('../locale/en.json').settings.home_recommendations
const channel = 'UC' + 'a'.repeat(22)
const video = id => ({ tileRenderer: { contentType: 'TILE_CONTENT_TYPE_VIDEO', contentId: id, onSelectCommand: { watchEndpoint: { videoId: id } } } })

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
    const rows = [{ items: [sample, sample] }]
    assert.equal((await suggestedCreators(rows, options)).length, 1)
    assert.deepEqual(await suggestedCreators(rows, { ...options, ignored: [channel] }), [])
    assert.deepEqual(await suggestedCreators(rows, { ...options, blocked: [{ id: channel }] }), [])
})
