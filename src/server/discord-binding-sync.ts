function trimString(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function getBindingList(config: any): any[] {
    const direct = Array.isArray(config?.bindings) ? config.bindings : [];
    const routed = Array.isArray(config?.routing?.bindings) ? config.routing.bindings : [];
    return [...direct, ...routed];
}

function isDiscordChannelBinding(binding: any): boolean {
    const match = binding?.match || {};
    const peer = match.peer || {};
    return trimString(match.channel) === "discord"
        && trimString(match.accountId) !== ""
        && trimString(match.accountId) !== "*"
        && trimString(match.guildId) !== ""
        && trimString(peer.kind) === "channel"
        && trimString(peer.id) !== "";
}

export function syncDiscordBindingAllowedChannels(config: any): any {
    if (!config || typeof config !== "object") return config;

    const derivedCounts = new Map<string, Map<string, number>>();
    for (const binding of getBindingList(config)) {
        if (!isDiscordChannelBinding(binding)) continue;
        const match = binding.match;
        const accountId = trimString(match.accountId);
        const guildId = trimString(match.guildId);
        const channelId = trimString(match.peer.id);
        if (!accountId || !guildId || !channelId) continue;

        let guildMap = derivedCounts.get(accountId);
        if (!guildMap) {
            guildMap = new Map<string, number>();
            derivedCounts.set(accountId, guildMap);
        }
        const key = `${guildId}\u0000${channelId}`;
        guildMap.set(key, (guildMap.get(key) || 0) + 1);
    }

    const hasDiscordAccounts = !!(config.channels && config.channels.discord && config.channels.discord.accounts);
    if (!hasDiscordAccounts && derivedCounts.size === 0) return config;

    if (!config.channels) config.channels = {};
    if (!config.channels.discord) config.channels.discord = {};
    if (!config.channels.discord.accounts) config.channels.discord.accounts = {};

    const discordAccounts = config.channels.discord.accounts as Record<string, any>;
    const accountIds = new Set<string>([...Object.keys(discordAccounts), ...derivedCounts.keys()]);

    for (const accountId of accountIds) {
        const accCfg = discordAccounts[accountId] || (discordAccounts[accountId] = {});
        if (!accCfg.guilds) accCfg.guilds = {};
        const guilds = accCfg.guilds as Record<string, any>;
        const desiredByGuild = new Map<string, Map<string, number>>();
        const accountDerived = derivedCounts.get(accountId) || new Map<string, number>();

        for (const [compoundKey, count] of accountDerived.entries()) {
            const [guildId, channelId] = compoundKey.split("\u0000");
            if (!desiredByGuild.has(guildId)) desiredByGuild.set(guildId, new Map<string, number>());
            desiredByGuild.get(guildId)!.set(channelId, count);
        }

        const guildIds = new Set<string>([...Object.keys(guilds), ...desiredByGuild.keys()]);
        for (const guildId of guildIds) {
            const guildCfg = guilds[guildId] || (guilds[guildId] = {});
            const existingChannels = guildCfg.channels && typeof guildCfg.channels === "object" ? guildCfg.channels : {};
            const existingAuto = guildCfg.bindingAllowedChannels && typeof guildCfg.bindingAllowedChannels === "object" ? guildCfg.bindingAllowedChannels : {};
            const desiredAuto = desiredByGuild.get(guildId) || new Map<string, number>();

            const nextAuto: Record<string, number> = {};
            for (const [channelId, count] of desiredAuto.entries()) {
                if (existingAuto[channelId] !== undefined || existingChannels[channelId] === undefined) {
                    nextAuto[channelId] = count;
                }
            }

            const nextChannels: Record<string, any> = {};
            for (const [channelId, channelCfg] of Object.entries(existingChannels)) {
                if (existingAuto[channelId] === undefined) {
                    nextChannels[channelId] = channelCfg;
                }
            }
            for (const channelId of Object.keys(nextAuto)) {
                if (nextChannels[channelId] === undefined) {
                    nextChannels[channelId] = { enabled: true };
                }
            }

            guildCfg.channels = nextChannels;
            if (Object.keys(nextAuto).length > 0) guildCfg.bindingAllowedChannels = nextAuto;
            else delete guildCfg.bindingAllowedChannels;
        }
    }

    return config;
}
