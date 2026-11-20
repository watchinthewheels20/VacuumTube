const { regionalHomes } = require('./home-recommendations/feed')

function filterGuide(json, regions = false) {
    for (const section of [...(json.items || []), json.topbar, json.footer]) {
        const guide = section?.guideSectionRenderer
        if (!Array.isArray(guide?.items)) continue
        guide.items = guide.items.filter(item => {
            const entry = item.guideEntryRenderer
            const endpoint = entry?.navigationEndpoint
            return Boolean(endpoint?.searchEndpoint || endpoint?.applicationSettingsEndpoint ||
                ['FEtopics', 'FEwhat_to_watch', 'FEsubscriptions', 'FElibrary'].includes(endpoint?.browseEndpoint?.browseId) ||
                ['SEARCH', 'WHAT_TO_WATCH', 'SUBSCRIPTIONS', 'TAB_LIBRARY', 'SETTINGS'].includes(entry?.icon?.iconType))
        })
        const home = guide.items.findIndex(item => ['FEtopics', 'FEwhat_to_watch'].includes(
            item.guideEntryRenderer?.navigationEndpoint?.browseEndpoint?.browseId))
        if (regions && home >= 0) guide.items.splice(home + 1, 0, ...Object.entries(regionalHomes).map(([label, browseId]) => ({
            guideEntryRenderer: {
                formattedTitle: { simpleText: label }, icon: { iconType: 'WHAT_TO_WATCH' },
                navigationEndpoint: { browseEndpoint: { browseId } }
            }
        })))
    }
    return json
}

module.exports = () => require('../util/xhrModifiers').addResponseModifier((url, text) => {
    if (/^(?:https:\/\/www\.youtube\.com)?\/youtubei\/v1\/guide(?:\?|$)/.test(url)) {
        return JSON.stringify(filterGuide(JSON.parse(text), window.ytcfg?.data_?.INNERTUBE_CLIENT_NAME !== 'TVHTML5_FOR_KIDS'))
    }
})
module.exports.filterGuide = filterGuide
