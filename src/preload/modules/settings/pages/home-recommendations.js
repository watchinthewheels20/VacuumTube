const configManager = require('../../../config')

module.exports = {
    id: 'home_recommendations',
    title: locale => locale.home_recommendations.title,
    sections(config, locale) {
        const labels = locale.home_recommendations
        const blocked = Array.isArray(config.home_blocked_creators) ? config.home_blocked_creators.filter(entry => entry?.id || entry?.handle) : []
        return [
            { rows: [{ type: 'toggle', key: 'prefer_uk_creators', title: labels.prefer_uk, description: labels.prefer_uk_description }] },
            { title: labels.blocked, rows: blocked.length ? blocked.map(entry => ({
                type: 'button', id: entry.id || entry.handle, title: labels.restore.replace('{creator}', () => entry.name || entry.handle || entry.id),
                run: () => configManager.set({ home_blocked_creators: configManager.get().home_blocked_creators.filter(other =>
                    (other.id || other.handle) !== (entry.id || entry.handle)) })
            })) : [{ type: 'text', text: labels.empty }] }
        ]
    }
}
