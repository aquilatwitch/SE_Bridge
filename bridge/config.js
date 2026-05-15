const TWITCH_CONFIG = {
    channel:  "aquilavt",
    clientId: "",
    token:    "",
    username: "aquilavt",

    fieldData: {},

    async loadFieldData(path = 'fieldData.json') {
        const res = await fetch(path);
        if (!res.ok) throw new Error(`[Config] fieldData konnte nicht geladen werden: ${path} (${res.status})`);
        this.fieldData = await res.json();
    }
};
