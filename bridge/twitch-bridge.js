class TwitchBridge {
    constructor(config) {
        this.channel   = config.channel.toLowerCase();
        this.clientId  = config.clientId  || null;
        this.token     = config.token     || null;
        this.username  = config.username  || null;
        this.fieldData = config.fieldData;

        this.channelId     = null;
        this.currentUserId = null;
        this.badgeCache    = new Map();

        this._ircWs          = null;
        this._ircReconnectMs = 1000;
        this._authFailed     = false;   
        this._widgetLoaded   = false;   
        this._roomStateTimer = null;

        this._eventSubWs       = null;
        this._sessionId        = null;
        this._eventSubDisabled = false; 
    }

    async init() {
        if (this.clientId && this.token) {
            await this._fetchCurrentUser().catch(e =>
                console.warn('[Bridge] currentUser:', e.message)
            );
        }
        this._connectIRC();
    }

    async _fetchCurrentUser() {
        const data = await this._twitchGet('https://api.twitch.tv/helix/users');
        this.currentUserId = data.data[0].id;
    }

    async _fetchBadges() {
        const store = (sets) => {
            sets.forEach(set =>
                set.versions.forEach(v =>
                    this.badgeCache.set(`${set.set_id}/${v.id}`, {
                        type:        set.set_id,
                        version:     v.id,
                        url:         v.image_url_2x,
                        description: v.description || v.title || set.set_id,
                    })
                )
            );
        };

        const global = await this._twitchGet('https://api.twitch.tv/helix/chat/badges/global');
        store(global.data);

        if (this.channelId) {
            const channel = await this._twitchGet(
                `https://api.twitch.tv/helix/chat/badges?broadcaster_id=${this.channelId}`
            );
            store(channel.data);
        }
    }

    async _twitchGet(url) {
        const res = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${this.token}`,
                'Client-Id':     this.clientId,
            }
        });
        if (res.status === 401) {
            throw new Error(
                '401 Unauthorized – Token ungültig/abgelaufen oder clientId passt nicht. ' +
                'Token prüfen unter: https://id.twitch.tv/oauth2/validate'
            );
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    _connectIRC() {
        this._ircWs = new WebSocket('wss://irc-ws.chat.twitch.tv:443');

        this._ircWs.onopen = () => {
            const ws = this._ircWs;
            ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');

            // Authenticated oder Anonymous – _authFailed verhindert Reconnect-Schleife
            if (this.token && this.username && !this._authFailed) {
                ws.send(`PASS oauth:${this.token}`);
                ws.send(`NICK ${this.username.toLowerCase()}`);
            } else {
                ws.send('PASS SCHMOOPIIE');
                ws.send(`NICK justinfan${Math.floor(Math.random() * 89999) + 10000}`);
            }

            ws.send(`JOIN #${this.channel}`);
            this._ircReconnectMs = 1000;

            // Fallback: falls ROOMSTATE ausbleibt (z.B. Channel existiert nicht)
            clearTimeout(this._roomStateTimer);
            this._roomStateTimer = setTimeout(() => {
                if (!this._widgetLoaded) {
                    console.warn('[Bridge] ROOMSTATE Timeout – starte ohne Channel-ID');
                    this._fireWidgetLoad();
                }
            }, 6000);
        };

        this._ircWs.onmessage = (evt) => {
            evt.data.split('\r\n').forEach(line => {
                if (line.trim()) this._parseIRCLine(line);
            });
        };

        this._ircWs.onclose = () => {
            console.warn(`[Bridge] IRC getrennt – Reconnect in ${this._ircReconnectMs}ms`);
            clearTimeout(this._roomStateTimer);
            setTimeout(() => this._connectIRC(), this._ircReconnectMs);
            this._ircReconnectMs = Math.min(this._ircReconnectMs * 2, 30000);
        };

        this._ircWs.onerror = (e) => console.error('[Bridge] IRC Fehler:', e);
    }

    _parseIRCLine(line) {
        if (line === 'PING :tmi.twitch.tv') {
            this._ircWs.send('PONG :tmi.twitch.tv');
            return;
        }

        let tags = {};
        let rest = line;

        if (line.startsWith('@')) {
            const sp = line.indexOf(' ');
            line.slice(1, sp).split(';').forEach(tag => {
                const eq = tag.indexOf('=');
                tags[tag.slice(0, eq)] = tag.slice(eq + 1);
            });
            rest = line.slice(sp + 1);
        }

        const parts  = rest.split(' ');
        let nick     = '';
        let i        = 0;

        if (parts[0].startsWith(':')) {
            nick = parts[0].slice(1).split('!')[0];
            i = 1;
        }

        const command = parts[i];
        const trailingIdx = rest.indexOf(' :');
        const trailing    = trailingIdx !== -1 ? rest.slice(trailingIdx + 2) : '';

        switch (command) {
            case 'ROOMSTATE':
                this._handleRoomState(tags);
                break;

            case 'NOTICE':
                // Twitch schickt dies wenn Token/Login falsch ist
                if (trailing.includes('Login authentication failed') ||
                    trailing.includes('Improperly formatted auth')) {
                    console.error('[Bridge] IRC Auth fehlgeschlagen – wechsle zu anonymem Login.');
                    console.error('[Bridge] Prüfe token/username in bridge/config.js');
                    this._authFailed = true;
                    this._ircWs.close();  // löst Reconnect aus, diesmal anonym
                }
                break;

            case 'PRIVMSG':
                this._handlePrivMsg(tags, nick, trailing);
                break;

            case 'CLEARCHAT':
                this._dispatch('delete-messages', {
                    userId: tags['target-user-id'] || null
                });
                break;

            case 'CLEARMSG':
                this._dispatch('delete-message', {
                    msgId: tags['target-msg-id'] || ''
                });
                break;

            case 'USERNOTICE':
                this._handleUserNotice(tags, trailing);
                break;
        }
    }

    _handleRoomState(tags) {
        if (!tags['room-id'] || this.channelId) return;

        this.channelId = tags['room-id'];
        console.info(`[Bridge] Channel-ID: ${this.channelId} (aus IRC ROOMSTATE)`);
        clearTimeout(this._roomStateTimer);

        // Jetzt Badges laden (brauchen die Channel-ID)
        if (this.clientId && this.token) {
            this._fetchBadges().catch(e =>
                console.warn('[Bridge] Badges:', e.message)
            );
            this._connectEventSub();
        }

        this._fireWidgetLoad();
    }

    _fireWidgetLoad() {
        if (this._widgetLoaded) return;
        this._widgetLoaded = true;
        this._dispatchWidgetLoad();
    }

    _handlePrivMsg(tags, nick, text) {
        let isAction = false;
        if (text.startsWith('ACTION ')) {
            text = text.slice(8).replace(/$/, '');
            isAction = true;
        }

        const userId       = tags['user-id']       || '';
        const msgId        = tags['id']             || crypto.randomUUID();
        const displayName  = tags['display-name']   || nick;
        const displayColor = tags['color']          || this._colorForUser(nick);
        const badgeStr     = tags['badges']         || '';

        const emotes = this._parseEmotes(tags['emotes'] || '', text);
        const badges = this._parseBadges(badgeStr, tags['badge-info'] || '');

        const msgData = {
            time: parseInt(tags['tmi-sent-ts']) || Date.now(),
            tags: {
                badges:          badgeStr,
                color:           displayColor,
                'display-name':  displayName,
                emotes:          tags['emotes'] || '',
                id:              msgId,
                mod:             tags['mod']        || '0',
                'room-id':       tags['room-id']    || '',
                subscriber:      tags['subscriber'] || '0',
                'tmi-sent-ts':   tags['tmi-sent-ts'] || String(Date.now()),
                'user-id':       userId,
                'user-type':     tags['user-type']  || '',
            },
            nick,
            userId,
            displayName,
            displayColor,
            badges,
            channel:  this.channel,
            text,
            isAction,
            emotes,
            msgId,
        };

        this._dispatch('message', { data: msgData });

        const bits = parseInt(tags['bits'] || '0');
        if (bits > 0) {
            this._dispatch('cheer-latest', {
                name:    displayName,
                amount:  bits,
                message: text,
            });
        }
    }

    _parseEmotes(emoteStr, text) {
        if (!emoteStr) return [];
        const result = [];

        emoteStr.split('/').forEach(part => {
            if (!part) return;
            const [id, positions] = part.split(':');
            if (!positions) return;

            positions.split(',').forEach(pos => {
                const [start, end] = pos.split('-').map(Number);
                result.push({
                    type: 'twitch',
                    name: text.slice(start, end + 1),
                    id,
                    gif:  false,
                    urls: {
                        1: `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/1.0`,
                        2: `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`,
                        4: `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/3.0`,
                    },
                    start,
                    end,
                });
            });
        });

        return result;
    }

    _parseBadges(badgeStr, badgeInfoStr) {
        if (!badgeStr) return [];

        return badgeStr.split(',').map(b => {
            const [setId, version] = b.split('/');
            if (!setId) return null;

            const cached = this.badgeCache.get(`${setId}/${version}`);
            if (cached) return cached;

            return {
                type:        setId === 'founder' ? 'subscriber' : setId,
                version:     version || '1',
                url:         null,
                description: setId,
            };
        }).filter(Boolean);
    }

    _handleUserNotice(tags, trailing) {
        const name   = tags['display-name'] || tags['login'] || '';
        const sender = tags['msg-param-sender-name'] || tags['msg-param-sender-login'] || '';
        const text   = trailing || '';

        switch (tags['msg-id']) {
            case 'sub':
                this._dispatch('subscriber-latest', {
                    name, sender: name, amount: 1,
                    isCommunityGift: false, bulkGifted: false, gifted: false,
                    message: text,
                });
                break;

            case 'resub':
                this._dispatch('subscriber-latest', {
                    name, sender: name,
                    amount:          parseInt(tags['msg-param-cumulative-months'] || '1'),
                    isCommunityGift: false, bulkGifted: false, gifted: false,
                    message: text,
                });
                break;

            case 'subgift':
                this._dispatch('subscriber-latest', {
                    name:            tags['msg-param-recipient-display-name'] || '',
                    sender:          name,
                    amount:          1,
                    isCommunityGift: false, bulkGifted: false, gifted: true,
                    message: text,
                });
                break;

            case 'submysterygift':
                this._dispatch('subscriber-latest', {
                    name, sender: name,
                    amount:          parseInt(tags['msg-param-mass-gift-count'] || '1'),
                    isCommunityGift: false, bulkGifted: true, gifted: false,
                    message: text,
                });
                break;

            case 'communitypaygift':
                this._dispatch('subscriber-latest', {
                    name, sender: name, amount: 1,
                    isCommunityGift: true, bulkGifted: false, gifted: true,
                    message: text,
                });
                break;

            case 'raid':
                this._dispatch('raid-latest', {
                    name,
                    amount:  parseInt(tags['msg-param-viewerCount'] || '0'),
                    message: '',
                });
                break;
        }
    }


    _connectEventSub() {
        if (this._eventSubDisabled) return;

        this._eventSubWs = new WebSocket('wss://eventsub.wss.twitch.tv/ws');

        this._eventSubWs.onopen = () =>
            console.info('[Bridge] EventSub verbunden');

        this._eventSubWs.onmessage = async (evt) => {
            const msg = JSON.parse(evt.data);
            await this._handleEventSubMsg(msg);
        };

        this._eventSubWs.onclose = () => {
            if (this._eventSubDisabled) return;
            console.warn('[Bridge] EventSub getrennt – Reconnect in 5s');
            setTimeout(() => this._connectEventSub(), 5000);
        };

        this._eventSubWs.onerror = (e) =>
            console.error('[Bridge] EventSub Fehler:', e);
    }

    async _handleEventSubMsg(msg) {
        const type    = msg.metadata?.message_type;
        const payload = msg.payload || {};

        switch (type) {
            case 'session_welcome':
                this._sessionId = payload.session.id;
                await this._subscribeToEvents();
                break;
            case 'session_reconnect':
                this._eventSubWs.close();
                this._eventSubWs = new WebSocket(payload.session.reconnect_url);
                break;
            case 'notification':
                this._handleEventSubNotification(
                    msg.metadata.subscription_type,
                    payload.event
                );
                break;
        }
    }

    async _subscribeToEvents() {
        const sub = async (type, version, condition) => {
            try {
                const res = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
                    method:  'POST',
                    headers: {
                        'Authorization': `Bearer ${this.token}`,
                        'Client-Id':     this.clientId,
                        'Content-Type':  'application/json',
                    },
                    body: JSON.stringify({
                        type, version, condition,
                        transport: { method: 'websocket', session_id: this._sessionId },
                    }),
                });
                if (res.status === 401) {
                    console.error(
                        '[Bridge] EventSub Token ungültig (401) – Follower-Alerts deaktiviert.\n' +
                        'Token prüfen: https://id.twitch.tv/oauth2/validate\n' +
                        'Benötigter Scope: moderator:read:followers'
                    );
                    this._eventSubDisabled = true;
                    this._eventSubWs.onclose = null;
                    this._eventSubWs.close();
                    return;
                }
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    console.warn(`[Bridge] EventSub "${type}":`, err.message || res.status);
                }
            } catch (e) {
                console.warn(`[Bridge] EventSub "${type}":`, e);
            }
        };

        await sub('channel.follow', '2', {
            broadcaster_user_id: this.channelId,
            moderator_user_id:   this.currentUserId || this.channelId,
        });
    }

    _handleEventSubNotification(type, event) {
        if (type === 'channel.follow') {
            this._dispatch('follower-latest', {
                name:    event.user_name,
                message: '',
            });
        }
    }

    _dispatchWidgetLoad() {
        window.dispatchEvent(new CustomEvent('onWidgetLoad', {
            detail: {
                fieldData: this.fieldData,
                channel:   { providerId: this.channelId || '0' },
                currency:  { symbol: '€' },
            }
        }));
        console.info('[Bridge] onWidgetLoad gefeuert (providerId:', this.channelId, ')');
    }

    _dispatch(listener, eventData) {
        window.dispatchEvent(new CustomEvent('onEventReceived', {
            detail: { listener, event: eventData }
        }));
    }

    _colorForUser(username) {
        const palette = [
            '#FF4500','#2E8B57','#DAA520','#FF69B4',
            '#5F9EA0','#1E90FF','#FF7F50','#9ACD32',
        ];
        let hash = 0;
        for (let i = 0; i < username.length; i++)
            hash = username.charCodeAt(i) + ((hash << 5) - hash);
        return palette[Math.abs(hash) % palette.length];
    }
}
