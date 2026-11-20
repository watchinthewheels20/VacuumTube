const { addResponseModifier } = require('../util/xhrModifiers')

function filterGuide(json) {
    for (const section of json.items || []) {
        const guide = section.guideSectionRenderer
        if (!Array.isArray(guide?.items)) continue
        guide.items = guide.items.filter(item => {
            const entry = item.guideEntryRenderer
            const endpoint = entry?.navigationEndpoint
            return Boolean(endpoint?.searchEndpoint || endpoint?.applicationSettingsEndpoint ||
                ['FEtopics', 'FEwhat_to_watch', 'FEsubscriptions', 'FElibrary'].includes(endpoint?.browseEndpoint?.browseId) ||
                ['SEARCH', 'WHAT_TO_WATCH', 'SUBSCRIPTIONS', 'TAB_LIBRARY', 'SETTINGS'].includes(entry?.icon?.iconType))
        })
    }
    return json
}

module.exports = () => addResponseModifier((url, text) => {
    if (/^(?:https:\/\/www\.youtube\.com)?\/youtubei\/v1\/guide(?:\?|$)/.test(url)) return JSON.stringify(filterGuide(JSON.parse(text)))
})
