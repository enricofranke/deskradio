import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Radio ohne Discord und ohne Audio: Kanal, Client und Interaktionen sind
// nachgebaut, der Zustand liegt in einer Datei im Temp-Verzeichnis. Geprüft
// wird, wer wann den Sender wechseln darf, wie Abstimmungen im Panel ausgehen
// und was Panel und Kanalstatus anzeigen.
const dir = mkdtempSync(join(tmpdir(), 'deskradio-'));
const stateFile = join(dir, 'state.json');
Object.assign(process.env, {
  RADIO_BOT_TOKEN: 'offline', RADIO_TEAM_ROLES: '900', RADIO_LANGUAGE: 'de', RADIO_STATE_FILE: stateFile, LOG_LEVEL: 'error',
  RADIO_CACHE_DIR: join(dir, 'cache'),
});
const { Collection, ChannelType } = await import('discord.js');
const { RULES, getState, loadState, target, updateState } = await import('../src/settings.ts');
const { t, TEXTS } = await import('../src/texts.ts');
const { env } = await import('../src/env.ts');
const { radioCommand } = await import('../src/commands.ts');
const radio = await import('../src/radio.ts');
const panel = await import('../src/panel.ts');
const queue = await import('../src/queue.ts');

// yt-dlp-Attrappe: Titel und Länge aus einer Tabelle, „Download“ legt eine Datei an.
const catalog = new Map([
  ['https://www.youtube.com/watch?v=kurz', { title: 'Kurzer Song', duration: 180, extractor_key: 'Youtube', thumbnail: 'https://i.ytimg.com/vi/kurz/hq.jpg' }],
  ['https://soundcloud.com/ncs/zwei', { title: 'Zweiter Song', duration: 200, extractor_key: 'Soundcloud' }],
  ['https://youtu.be/drei', { title: 'Dritter Song', duration: 150, extractor_key: 'Youtube' }],
  ['https://www.youtube.com/watch?v=lang', { title: 'Mix (1 Stunde)', duration: 3600, extractor_key: 'Youtube' }],
  ['https://www.youtube.com/watch?v=live', { title: 'Lofi Radio 24/7', duration: 0, is_live: true, extractor_key: 'Youtube' }],
  ['https://www.youtube.com/watch?v=vier', { title: 'Vierter Song', duration: 200, extractor_key: 'Youtube' }],
  ['https://www.youtube.com/watch?v=fuenf', { title: 'Fünfter Song', duration: 210, extractor_key: 'Youtube' }],
  ['https://api.soundcloud.com/tracks/77', { title: 'Langer API-Song', duration: 900, extractor_key: 'Soundcloud' }],
  ['https://soundcloud.com/ncs/vier', { title: 'Vierter SC-Song', duration: 240, extractor_key: 'Soundcloud' }],
  ['https://www.youtube.com/watch?v=s1', { title: 'Mix-Song 1', duration: 200, extractor_key: 'Youtube' }],
  ['https://www.youtube.com/watch?v=s2', { title: 'Mix-Song 2', duration: 210, extractor_key: 'Youtube' }],
]);
// Playlists, wie yt-dlp sie mit --flat-playlist liefert: SoundCloud ohne Titel und Länge.
const yt = (id, title, duration) => ({ _type: 'url', ie_key: 'Youtube', id, url: `https://www.youtube.com/watch?v=${id}`, title, duration });
const sc = (url, id) => ({ _type: 'url_transparent', ie_key: 'Soundcloud', id, url, title: null, duration: null });
const playlists = new Map([
  ['PLfocus', { title: 'Focus Mix', extractor_key: 'YoutubeTab', webpage_url: 'https://www.youtube.com/playlist?list=PLfocus', entries: [
    yt('kurz', 'Kurzer Song', 180), yt('privat', '[Private video]', null), yt('lang', 'Mix (1 Stunde)', 3600),
    yt('vier', 'Vierter Song', 200), yt('fuenf', 'Fünfter Song', 210),
  ] }],
  ['https://soundcloud.com/ncs/sets/best', { title: 'Best of', extractor_key: 'SoundcloudSet', webpage_url: 'https://soundcloud.com/ncs/sets/best', entries: [
    sc('https://soundcloud.com/ncs/zwei', '1'), sc('https://api.soundcloud.com/tracks/77', '77'), sc('https://soundcloud.com/ncs/vier', '4'),
  ] }],
  ['PLkaputt', { title: 'Kaputt', extractor_key: 'YoutubeTab', webpage_url: 'https://www.youtube.com/playlist?list=PLkaputt',
    entries: [1, 2, 3, 4, 5, 6].map((n) => yt(`k${n}`, `K${n}`, 100)) }],
  // YouTube-Mix: wiederholt Songs; der Nachfolger-Mix ab dem letzten Song bringt ein paar neue.
  ['RDseed', { title: 'Mix - Seed', extractor_key: 'YoutubeTab', webpage_url: 'https://www.youtube.com/watch?v=s1&list=RDseed',
    entries: ['s1', 's2', 's3', 's2', 's4', 's5', 's6', 's7'].map((id) => yt(id, `Song ${id}`, 200)) }],
  ['RDs7', { title: 'Mix - Song s7', extractor_key: 'YoutubeTab', webpage_url: 'https://www.youtube.com/watch?v=s7&list=RDs7',
    entries: ['s7', 's6', 'n1', 'n2', 'n3'].map((id) => yt(id, `Song ${id}`, 200)) }],
]);
/** Jede Abfrage eines Inhaltsverzeichnisses. */
const probes = [];
/** Downloads, die erst halb geschrieben sind, bis ihr Promise sich erfüllt. */
const slow = new Map();
const failDownload = new Set();
/** YouTube will eine Anmeldung: so oft noch für diese Adresse. */
const blocked = new Map();
/** Jeder Download mit seinen Argumenten, für die Playlist-Tests. */
const downloads = [];
/** Downloads, die abgebrochen wurden, weil niemand sie mehr braucht. */
const aborted = [];
queue.useRunner(async (args, _timeoutMs, signal) => {
  const url = args.at(-1);
  if (args.includes('--flat-playlist')) {
    probes.push(url);
    const list = playlists.get(new URL(url).searchParams.get('list') ?? url);
    if (list) return JSON.stringify({ _type: 'playlist', ...list });
    const info = catalog.get(url);
    if (!info) throw new Error('Video unavailable');
    return JSON.stringify({ _type: 'video', ...info, webpage_url: url });
  }
  if (args.includes('--dump-single-json')) {
    const info = catalog.get(url);
    if (!info) throw new Error('Video unavailable');
    return JSON.stringify({ ...info, webpage_url: url });
  }
  const info = catalog.get(url);
  if (!info) throw new Error('Video unavailable');
  if (failDownload.has(url)) throw new Error('HTTP Error 403: Forbidden');
  if (blocked.get(url) > 0) {
    blocked.set(url, blocked.get(url) - 1);
    throw new Error('Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.');
  }
  downloads.push({ url, args });
  // --match-filter wie yt-dlp: ausgelassen heißt, es kommt nichts zurück.
  const filter = args.includes('--match-filter') ? args[args.indexOf('--match-filter') + 1] : '';
  if (info.duration > Number(/duration <=\? (\d+)/.exec(filter)?.[1] ?? Infinity)) return '';
  const file = args[args.indexOf('-o') + 1].replace('%(ext)s', 'webm');
  if (slow.has(url)) {
    writeFileSync(file, 'teil');
    await new Promise((resolve, reject) => {
      slow.get(url).then(resolve);
      signal?.addEventListener('abort', () => {
        aborted.push(url);
        reject(new Error('yt-dlp exited with code null'));
      }, { once: true });
    });
    appendFileSync(file, '-rest');
  } else writeFileSync(file, 'ton');
  return `${JSON.stringify({ filepath: file, title: info.title, duration: info.duration })}\n`;
});
/** Warten, bis die Attrappe alle Downloads „fertig“ hat. */
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

loadState();
RULES.voteCooldownMinutes = 0;
RULES.skipCooldownSeconds = 0;
target.guildId = '200';
target.channelId = '306';
const saved = () => JSON.parse(readFileSync(stateFile, 'utf8'));

const guild = { id: '200', ownerId: '999', channels: { cache: new Collection() }, members: { cache: new Collection() } };
const statuses = [];
const client = {
  user: { id: 'bot', setActivity() {}, setPresence() {}, avatarURL: () => null },
  guilds: { cache: new Collection([['200', guild]]) },
  rest: { put: async (_route, { body }) => { statuses.push(body.status); } },
};

let nextId = 1000, nextMessage = 5000;
const posted = [];
const channel = {
  id: '306', type: ChannelType.GuildVoice, members: new Collection(), guild, bitrate: 384000, lastMessageId: null,
  async send(payload) {
    const message = {
      id: String(++nextMessage), channelId: '306', author: { id: 'bot' }, deleted: false,
      ...payload,
      async edit(update) { Object.assign(message, update); return message; },
      async delete() { message.deleted = true; },
    };
    channel.lastMessageId = message.id;
    posted.push(message);
    return message;
  },
};
guild.channels.cache.set(channel.id, channel);
radio.attachClient(client);
panel.attachPanel(client, channel);

function member({ staff = false, deaf = false } = {}) {
  const id = String(++nextId);
  const m = {
    id, guild, user: { id, bot: false },
    roles: { cache: new Collection(staff ? [['900', {}]] : []) },
    permissions: { has: () => false },
    voice: { channelId: null, deaf },
  };
  guild.members.cache.set(id, m);
  return m;
}
function voiceState(m) {
  return { channelId: m.voice.channelId, member: m };
}
function enter(m) {
  const old = voiceState(m);
  m.voice = { ...m.voice, channelId: channel.id };
  channel.members.set(m.id, m);
  radio.handleRadioVoiceState(old, voiceState(m));
}
function exit(m) {
  const old = voiceState(m);
  m.voice = { ...m.voice, channelId: null };
  channel.members.delete(m.id);
  radio.handleRadioVoiceState(old, voiceState(m));
}
function command(m) {
  const replies = [];
  return {
    member: m, user: { id: m.id }, replies,
    async reply(payload) { replies.push(payload); },
  };
}
/** Ein Befehl, der erst „denkt …“ zeigt und dann die Antwort nachreicht. */
function deferred(m) {
  const replies = [];
  return {
    member: m, user: { id: m.id }, replies,
    async reply(payload) { replies.push(payload); },
    async deferReply() {},
    async editReply(payload) { replies.push(payload); },
  };
}
const lastReply = (interaction) => interaction.replies.at(-1).content;
/** Das Panel, wie es gerade im Kanal steht. */
async function panelNow() {
  await panel.flushPanel();
  return panel.panelMessage();
}
/** Alles, was im Panel zu lesen ist: Kopf, Text, Blöcke, Fußzeile. */
const text = (message) => {
  const e = message.embeds[0].data;
  return [e.author?.name, e.title, e.description, ...(e.fields ?? []).flatMap((f) => [f.name, f.value]), e.footer?.text]
    .filter(Boolean).join('\n');
};
const voteButtons = (message) => message.components[2].components.map((b) => b.data.label);
const voteOpen = (message) => message.components.length === 3;
async function click(m, action, id) {
  const message = await panelNow();
  const buttonId = id ? `radio:${action}:${id}` : message.components[2].components[action === 'yes' ? 0 : 1].data.custom_id;
  const [, clicked, voteId] = buttonId.split(':');
  const replies = [];
  const interaction = {
    member: m, user: { id: m.id }, message, replies, deferred: false,
    async reply(payload) { replies.push(payload); },
    async deferUpdate() { interaction.deferred = true; },
  };
  await radio.handleRadioButton(interaction, clicked, voteId);
  return interaction;
}
const station = () => getState().station;
const tick = () => new Promise((resolve) => setImmediate(resolve));
function empty() {
  for (const m of [...channel.members.values()]) exit(m);
}

test('mehr Ja als Nein gewinnt, Schweigen blockiert nicht', () => {
  const listening = ['a', 'b', 'c', 'd'];
  // Vorschlag allein, drei schweigen: noch offen, am Ende angenommen.
  const quiet = radio.tally(listening, new Set(['a']), new Set());
  assert.deepEqual(quiet, { yes: 1, no: 0, undecided: 3, outcome: 'open' });
  assert.equal(radio.decideAtEnd(quiet), 'passed');
  // Gleichstand am Ende: bleibt beim Alten.
  assert.equal(radio.decideAtEnd(radio.tally(listening, new Set(['a']), new Set(['b']))), 'failed');
  assert.equal(radio.decideAtEnd(radio.tally(listening, new Set(['a', 'c']), new Set(['b']))), 'passed');
  // Früh entschieden, wenn die Unentschiedenen nichts mehr drehen können.
  assert.equal(radio.tally(listening, new Set(['a', 'b', 'c']), new Set()).outcome, 'passed');
  assert.equal(radio.tally(listening, new Set(['a']), new Set(['b', 'c'])).outcome, 'failed');
  assert.equal(radio.tally(['a', 'b'], new Set(['a']), new Set(['b'])).outcome, 'failed', 'eins zu eins, niemand mehr unentschieden');
  // Wer den Kanal verlassen hat, zählt nicht mehr mit.
  assert.deepEqual(radio.tally(['a', 'b'], new Set(['a', 'x', 'y']), new Set()), { yes: 1, no: 0, undecided: 1, outcome: 'open' });
  assert.equal(radio.tally([], new Set(['a']), new Set()).outcome, 'failed');
});

test('der Songtitel wird aus den Icecast-Metadaten gelesen', () => {
  const meta = Buffer.alloc(48);
  meta.write("StreamTitle='John Bartmann - Lofi Jam';");
  const data = Buffer.concat([Buffer.alloc(16), Buffer.from([3]), meta]);
  assert.equal(radio.parseIcyTitle(data, 16), 'John Bartmann - Lofi Jam');
  assert.equal(radio.parseIcyTitle(Buffer.concat([Buffer.alloc(16), Buffer.from([0])]), 16), null);
  assert.equal(radio.parseIcyTitle(Buffer.alloc(10), 16), null);
});

test('ffmpeg liefert Opus mit 48 kHz Stereo im Ogg-Container', () => {
  const args = radio.ffmpegArgs('https://radio.cliamp.stream/lofi/stream');
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(value('-i'), 'https://radio.cliamp.stream/lofi/stream');
  assert.equal(value('-c:a'), 'libopus');
  assert.equal(value('-ar'), '48000');
  assert.equal(value('-ac'), '2');
  assert.equal(value('-f'), 'ogg');
  assert.equal(value('-b:a'), '128k', 'so viel, wie die MP3-Quelle hergibt');
  assert.equal(args.includes('-af'), false, 'volle Lautstärke braucht keinen Filter');
  assert.equal(args.at(-1), 'pipe:1');

  const quieter = radio.ffmpegArgs('https://radio.cliamp.stream/lofi/stream', { volume: 40, bitrateKbps: 96 });
  assert.equal(quieter[quieter.indexOf('-af') + 1], 'volume=0.40');
  assert.equal(quieter[quieter.indexOf('-b:a') + 1], '96k');
  assert(quieter.indexOf('-af') > quieter.indexOf('-i'), 'der Filter wirkt auf die Eingabe');

  const file = radio.ffmpegArgs('/app/data/cache/w1.webm');
  assert.equal(file.includes('-reconnect'), false, 'eine Datei braucht keine Wiederverbindung');
  assert.equal(file[file.indexOf('-i') + 1], '/app/data/cache/w1.webm');
  assert.equal(file.includes('-ss'), false, 'von vorn');
  const resumed = radio.ffmpegArgs('/app/data/cache/w1.webm', { seek: 95.26 });
  assert.equal(resumed[resumed.indexOf('-ss') + 1], '95.3', 'weiter an der alten Stelle');
  assert(resumed.indexOf('-ss') < resumed.indexOf('-i'), 'schneller Sprung vor dem Einlesen');
  assert.equal(radio.ffmpegArgs('https://radio.example/stream', { seek: 30 }).includes('-ss'), false, 'im Livestream nicht');
});

test('Netzwerkfehler nennen Adresse und Port jedes Versuchs', () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED', address: '66.22.231.5', port: 2096 });
  const unreachable = Object.assign(new Error('connect ENETUNREACH'), { code: 'ENETUNREACH', address: '2606:4700::1', port: 2096 });
  assert.deepEqual(radio.describeNetworkError(new AggregateError([refused, unreachable])),
    ['ECONNREFUSED 66.22.231.5:2096', 'ENETUNREACH 2606:4700::1:2096']);
  assert.deepEqual(radio.describeNetworkError(new Error('kaputt')), ['kaputt']);
});

test('Bitrate folgt dem Kanal, nie unter der Quelle und nie über Opus', () => {
  assert.equal(radio.streamBitrate({ bitrate: 64000 }), 128);
  assert.equal(radio.streamBitrate({ bitrate: 256000 }), 256);
  assert.equal(radio.streamBitrate({ bitrate: 384000 }), 384);
  assert.equal(radio.streamBitrate({ bitrate: 800000 }), 510);
});

test('Befehl /radio mit Sender-Auswahl, Anzeige und Schalter fürs Team', () => {
  const definition = radioCommand();
  assert.deepEqual(definition.options.map((o) => o.name),
    ['station', 'now', 'volume', 'request', 'playlist', 'skip', 'playlist-skip', 'clear', 'off', 'on']);
  assert.deepEqual(definition.options.map((o) => o.name_localizations?.de ?? o.name),
    ['sender', 'jetzt', 'lautstärke', 'wunsch', 'playlist', 'skip', 'playlist-überspringen', 'leeren', 'aus', 'an'], 'auf Deutsch wie bisher');
  const playlistOptions = definition.options[4].options;
  assert.deepEqual(playlistOptions.map((o) => [o.name, o.name_localizations?.de ?? o.name, o.required ?? false]),
    [['link', 'link', true], ['shuffle', 'zufällig', false]]);
  assert(definition.options.every((o) => o.description_localizations?.de), 'jede Beschreibung auch auf Deutsch');
  const volume = definition.options[2].options[0];
  assert.deepEqual([volume.name, volume.name_localizations.de, volume.min_value, volume.max_value, volume.required ?? false],
    ['percent', 'prozent', 1, 100, false]);
  const option = definition.options[0].options[0];
  assert.equal(option.name, 'station');
  assert.equal(option.autocomplete, true);
  assert.equal(option.required, true);
  assert.equal(radio.stations().length, 18);
  assert(radio.stations().length <= 25, 'mehr fasst das Dropdown nicht');
  assert(radio.stations().every((s) => s.url.startsWith('https://') && s.genre.en && s.genre.de && s.kbps >= 128));
  assert.equal(new Set(radio.stations().map((s) => s.key)).size, radio.stations().length, 'Schlüssel eindeutig');
  assert.equal(radio.stationByKey(station()).name, 'Lofi');
});

test('wer nicht im Kanal zuhört, kann nicht wechseln', async () => {
  const outsider = member();
  const deaf = member({ deaf: true });
  enter(deaf);
  for (const m of [outsider, deaf]) {
    const interaction = command(m);
    await radio.requestStation(interaction, 'synthwave');
    assert.equal(interaction.replies[0].content, t('not_listening', { channel: '<#306>' }));
  }
  assert.equal(station(), 'lofi');
  empty();
});

test('allein im Kanal wird sofort gewechselt, das Panel zeigt es', async () => {
  const alone = member();
  enter(alone);
  const interaction = command(alone);
  await radio.requestStation(interaction, 'synthwave');
  assert.equal(station(), 'synthwave');
  assert.equal(interaction.replies[0].content, t('switched', { station: 'Synthwave' }));
  const message = await panelNow();
  assert.equal(message.embeds[0].data.title, '📻 Synthwave');
  assert(text(message).includes(t('event_switched', { user: `<@${alone.id}>`, station: 'Synthwave' })));
  assert.equal(voteOpen(message), false);

  const again = command(alone);
  await radio.requestStation(again, 'synthwave');
  assert.equal(again.replies[0].content, t('already', { station: 'Synthwave' }));
  empty();
});

test('zu zweit entscheidet der andere, abgestimmt wird im Panel', async () => {
  const [a, b] = [member(), member()];
  enter(a); enter(b);
  const before = posted.length;
  const interaction = command(a);
  await radio.requestStation(interaction, 'edm');
  assert.equal(interaction.replies[0].content, t('vote_started', { station: 'EDM' }));
  const message = await panelNow();
  assert.equal(voteOpen(message), true);
  assert.match(text(message), /🗳️ Wechsel auf EDM\?/);
  assert.deepEqual(voteButtons(message), ['Ja · 1', 'Nein · 0'], 'wer abstimmen lässt, hat schon Ja gesagt');
  assert.match(text(message), /Mehr Ja als Nein gewinnt/, 'die Regel steht nur während der Abstimmung da');
  assert.equal(posted.length, before, 'keine eigene Nachricht mehr, das Panel wird bearbeitet');
  assert.equal(station(), 'synthwave');

  const second = command(b);
  await radio.requestStation(second, 'ncs');
  assert.equal(second.replies[0].content, t('vote_running', { station: 'EDM' }));

  const yes = await click(b, 'yes');
  assert.equal(yes.deferred, true);
  assert.equal(station(), 'edm');
  const after = await panelNow();
  assert.equal(voteOpen(after), false);
  assert(text(after).includes(t('event_passed', { station: 'EDM' })));

  // Ein Klick auf eine alte Abstimmung ändert nichts mehr.
  const late = await click(a, 'no', 'alt');
  assert.equal(late.replies[0].content, t('vote_over'));
  empty();
});

test('drei Zuhörende: zwei Ja reichen, ein Unentschieden zu zweit scheitert', async () => {
  const [a, b, c] = [member(), member(), member()];
  enter(a); enter(b); enter(c);
  await radio.requestStation(command(a), 'ncs-dnb');
  await click(b, 'yes');
  assert.equal(station(), 'ncs-dnb', 'zwei von drei reichen');

  await radio.requestStation(command(a), 'ncs-house');
  await click(b, 'no');
  assert.equal(voteOpen(await panelNow()), true, 'c kann noch entscheiden');
  exit(c);
  await tick();
  const message = await panelNow();
  assert.equal(voteOpen(message), false, 'eins zu eins zu zweit: keine Mehrheit mehr möglich');
  assert(text(message).includes(t('event_failed', { station: 'NCS House', yes: 1, no: 1 })));
  assert.equal(station(), 'ncs-dnb');
  empty();
});

test('niemand drückt etwas: nach 60 Sekunden wird gewechselt', async () => {
  const [a, b, c] = [member(), member(), member()];
  enter(a); enter(b); enter(c);
  const before = station();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await radio.requestStation(command(a), 'edm');
    mock.timers.tick(59_000);
    assert.equal(station(), before, 'die Zeit läuft noch');
    mock.timers.tick(1_000);
  } finally {
    mock.timers.reset();
  }
  await tick();
  assert.equal(station(), 'edm');
  assert(text(await panelNow()).includes(t('event_passed', { station: 'EDM' })));
  empty();
});

test('Gleichstand nach 60 Sekunden: es bleibt beim Alten', async () => {
  const [a, b, c] = [member(), member(), member()];
  enter(a); enter(b); enter(c);
  const before = station();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await radio.requestStation(command(a), 'omarchy');
    await click(b, 'no');
    mock.timers.tick(60_000);
  } finally {
    mock.timers.reset();
  }
  await tick();
  assert.equal(station(), before);
  assert(text(await panelNow()).includes(t('event_failed', { station: 'Omarchy Radio', yes: 1, no: 1 })));
  empty();
});

test('wer mit Nein geht, nimmt die Stimme mit', async () => {
  const [a, b, c, d] = [member(), member(), member(), member()];
  enter(a); enter(b); enter(c); enter(d);
  await radio.requestStation(command(a), 'ncs-trap');
  await click(b, 'yes');
  await click(c, 'no');
  assert.equal(voteOpen(await panelNow()), true, 'zwei von vier reichen nicht');
  exit(c);
  await tick();
  assert.equal(station(), 'ncs-trap', 'zwei von drei reichen');
  assert.equal(voteOpen(await panelNow()), false);
  empty();
});

test('das Team wechselt sofort und beendet eine laufende Abstimmung', async () => {
  const [a, b] = [member(), member()];
  const admin = member({ staff: true });
  enter(a); enter(b);
  await radio.requestStation(command(a), 'omarchy');
  const running = (await panelNow()).components[2].components[0].data.custom_id.split(':')[2];

  // Das Team muss dafür nicht im Kanal sitzen.
  const interaction = command(admin);
  await radio.requestStation(interaction, 'ncs-phonk');
  assert.equal(station(), 'ncs-phonk');
  assert.equal(interaction.replies[0].content, t('switched', { station: 'NCS Phonk' }));
  const message = await panelNow();
  assert.equal(voteOpen(message), false);
  assert(text(message).includes(t('event_switched', { user: `<@${admin.id}>`, station: 'NCS Phonk' })));

  const stale = await click(b, 'yes', running);
  assert.equal(stale.replies[0].content, t('vote_over'));
  empty();
});

test('Panel: Dropdown mit laufendem Sender, aus wenn das Radio aus ist', () => {
  const snapshot = {
    enabled: true, station: radio.stationByKey('lofi'), playing: true, listeners: 3, volume: 10, bitrateKbps: 384,
    vote: null, lastEvent: null, track: null, upcoming: [],
  };
  const on = panel.renderPanel(snapshot, 'Lo-Fi Astronaut – Analog', ['JMHBM – Flashy']);
  const select = on.components[0].components[0].toJSON();
  assert.equal(select.custom_id, 'radio:pick');
  assert.equal(select.options.length, 18);
  assert.equal(select.options.find((o) => o.default).value, 'lofi');
  assert.equal(select.options.find((o) => o.default).description, 'läuft gerade · Chill · 128 kbit/s');
  assert.equal(select.options.find((o) => o.value === 'ilove-deutschrap').description, 'Deutschrap · 192 kbit/s');
  assert.equal(select.disabled ?? false, false);
  assert.equal(on.embeds[0].data.title, '📻 Lofi');
  assert.match(on.embeds[0].data.description, /🎵 Lo-Fi Astronaut – Analog/);
  assert.match(on.embeds[0].data.description, /Zuletzt: JMHBM – Flashy/);
  assert.equal(on.embeds[0].data.footer.text, '👥 3 · 🔊 10 % · 384 kbit/s');
  assert.equal(on.embeds[0].data.fields, undefined, 'ohne Wünsche und Abstimmung keine Blöcke');

  const off = panel.renderPanel({ ...snapshot, enabled: false }, null, []);
  assert.equal(off.components[0].components[0].toJSON().disabled, true);
  assert.equal(off.embeds[0].data.title, t('panel_off'));
  const idle = panel.renderPanel({ ...snapshot, playing: false, listeners: 0 }, null, []);
  assert.match(idle.embeds[0].data.description, /Wartet auf Zuhörende/);
});

test('Kanalstatus zeigt Sender und Song, leer wenn aus', async () => {
  const base = { enabled: true, station: radio.stationByKey('ncs-phonk'), playing: true };
  assert.equal(panel.statusText(base, 'xxephyrr – BUSSIN'), '📻 NCS Phonk – xxephyrr – BUSSIN');
  assert.equal(panel.statusText({ ...base, playing: false }, 'alt'), '📻 NCS Phonk');
  assert.equal(panel.statusText({ ...base, enabled: false }, 'egal'), '');
  assert.equal(panel.statusText(base, 'x'.repeat(300)).length, 200);
  await panelNow();
  assert.equal(statuses.at(-1), `📻 ${radio.stationByKey(station()).name}`, 'gesetzt, ohne Stream nur der Sender');
});

test('schreibt jemand im Kanal-Chat, rückt das Panel nach einer Pause nach unten', async () => {
  const old = await panelNow();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await channel.send({ content: 'hallo' });
    channel.lastMessageId = 'fremd';
    panel.handlePanelMessage({ channelId: '306', author: { id: 'jemand' } });
    panel.handlePanelMessage({ channelId: '306', author: { id: 'jemand' } });
    mock.timers.tick(19_000);
    assert.equal(panel.panelMessage(), old, 'noch nicht, es wird noch geschrieben');
    mock.timers.tick(1_000);
  } finally {
    mock.timers.reset();
  }
  await panel.flushPanel();
  assert.notEqual(panel.panelMessage(), old);
  assert.equal(old.deleted, true, 'das alte Panel verschwindet');
  assert.equal(channel.lastMessageId, panel.panelMessage().id);

  // Eigene Nachrichten lösen nichts aus.
  panel.handlePanelMessage({ channelId: '306', author: { id: 'bot' } });
});

test('nur YouTube- und SoundCloud-Links', () => {
  for (const ok of ['https://www.youtube.com/watch?v=abc', 'https://youtu.be/abc', 'https://music.youtube.com/watch?v=abc',
    'https://soundcloud.com/ncs/song', 'https://on.soundcloud.com/xyz']) assert(queue.supportedLink(ok), ok);
  for (const bad of ['https://example.com/song.mp3', 'file:///etc/passwd', 'javascript:alert(1)', 'youtube.com/watch?v=x',
    'https://youtube.com.evil.example/watch']) assert.equal(queue.supportedLink(bad), null, bad);
  assert.equal(queue.ytDlpError('WARNING: x\nERROR: [youtube] abc123: Private video'), 'Private video');
});

test('Wünsche: eingereiht, geladen, mit Grenzen für Länge, Livestreams und pro Person', async () => {
  const [a, b] = [member(), member()];
  enter(a); enter(b);
  const wish = async (m, link) => {
    const replies = [];
    const interaction = {
      member: m, user: { id: m.id }, replies,
      async reply(payload) { replies.push(payload); },
      async deferReply() {},
      async editReply(payload) { replies.push(payload); },
    };
    await radio.requestWish(interaction, link);
    return replies.at(-1).content;
  };
  assert.equal(await wish(a, 'https://example.com/x'), t('wish_link'));
  assert.equal(await wish(a, 'https://www.youtube.com/watch?v=lang'), t('wish_long', { minutes: 10 }));
  assert.equal(await wish(a, 'https://www.youtube.com/watch?v=live'), t('wish_live'));
  assert.equal(await wish(a, 'https://www.youtube.com/watch?v=weg'), t('wish_failed', { detail: 'Video unavailable' }));
  assert.equal(await wish(a, 'https://www.youtube.com/watch?v=kurz'), t('wish_added', { title: 'Kurzer Song', position: 1 }));
  assert.equal(await wish(a, 'https://soundcloud.com/ncs/zwei'), t('wish_added', { title: 'Zweiter Song', position: 2 }));
  assert.equal(await wish(a, 'https://youtu.be/drei'), t('wish_limit', { max: 2 }), 'zwei pro Person');
  assert.equal(await wish(b, 'https://youtu.be/drei'), t('wish_added', { title: 'Dritter Song', position: 3 }));
  await settle();
  assert(queue.tracks().every((track) => track.status === 'ready' && existsSync(track.file)));
  assert.equal(queue.tracks()[0].thumbnail, 'https://i.ytimg.com/vi/kurz/hq.jpg');
  assert.equal(queue.tracks()[1].thumbnail, null);

  const outsider = member();
  assert.equal(await wish(outsider, 'https://youtu.be/drei'), t('not_listening', { channel: '<#306>' }));


  const message = await panelNow();
  assert.match(text(message), /⏭️ Als Nächstes/);
  assert.match(text(message), /`1\.` Kurzer Song · 3:00/);
  assert.match(text(message), /Danach wieder/);
  assert(text(message).includes(t('event_wish', { user: `<@${b.id}>`, title: 'Dritter Song' })));  empty();
});

test('überspringen: wer gewünscht hat und das Team sofort, sonst Abstimmung', async () => {
  const [first, second] = queue.tracks();
  const requester = guild.members.cache.get(first.requesterId);
  const [x, y] = [member(), member()];
  enter(x); enter(y);

  const nothing = command(x);
  await radio.requestSkip(nothing);
  assert.equal(nothing.replies[0].content, t('skip_nothing'), 'solange kein Wunsch läuft, gibt es nichts zu überspringen');

  // Wer sich den Titel gewünscht hat, überspringt ihn ohne Abstimmung.
  radio.pretendPlaying(first.id);
  const own = command(requester);
  await radio.requestSkip(own);
  assert.equal(own.replies[0].content, t('skipped', { title: 'Kurzer Song' }));
  assert.equal(existsSync(first.file), false, 'die Datei ist gleich wieder weg');
  assert.equal(queue.head(), second);

  // Andere stimmen ab: mehr Ja als Nein.
  radio.pretendPlaying(second.id);
  const ask = command(x);
  await radio.requestSkip(ask);
  assert.equal(ask.replies[0].content, t('skip_vote_started', { title: 'Zweiter Song' }));
  assert.match(text(await panelNow()), /🗳️ „Zweiter Song“ überspringen\?/);
  await click(y, 'yes');
  assert.notEqual(queue.head(), second, 'übersprungen');
  assert(text(await panelNow()).includes(t('event_skip_passed', { title: 'Zweiter Song' })));

  // Das Team überspringt sofort.
  const third = queue.head();
  radio.pretendPlaying(third.id);
  const admin = member({ staff: true });
  await radio.requestSkip(command(admin));
  assert.equal(queue.tracks().length, 0);
  radio.pretendPlaying(null);
  empty();
});

test('das Team darf auch lange Mixe wünschen, Livestreams aber nicht', async () => {
  const admin = member({ staff: true });
  const wish = async (link) => {
    let reply = null;
    const interaction = { member: admin, user: { id: admin.id }, async reply(p) { reply = p; }, async deferReply() {}, async editReply(p) { reply = p; } };
    await radio.requestWish(interaction, link);
    return reply.content;
  };
  // Von außerhalb des Kanals, und ohne 10-Minuten-Grenze.
  assert.equal(await wish('https://www.youtube.com/watch?v=lang'), t('wish_added', { title: 'Mix (1 Stunde)', position: 1 }));
  assert.equal(await wish('https://www.youtube.com/watch?v=live'), t('wish_live'));
  await settle();
  assert.equal(queue.head().status, 'ready');
  queue.clearQueue();
});

test('ein Titel, der sich nicht laden lässt, fliegt raus und steht im Panel', async () => {
  const m = member();
  enter(m);
  failDownload.add('https://youtu.be/drei');
  const interaction = { member: m, user: { id: m.id }, async reply() {}, async deferReply() {}, async editReply() {} };
  await radio.requestWish(interaction, 'https://youtu.be/drei');
  await settle();
  assert.equal(queue.tracks().length, 0);
  assert(text(await panelNow()).includes('⚠️ **Dritter Song** ließ sich nicht laden'));
  failDownload.clear();
  empty();
});

test('läuft der Titel zu Ende, während abgestimmt wird, endet die Abstimmung still', async () => {
  const [a, b, c] = [member(), member(), member()];
  enter(a); enter(b); enter(c);
  const interaction = { member: a, user: { id: a.id }, async reply() {}, async deferReply() {}, async editReply() {} };
  await radio.requestWish(interaction, 'https://www.youtube.com/watch?v=kurz');
  await settle();
  radio.pretendPlaying(queue.head().id);
  await radio.requestSkip(command(b));
  assert.equal(voteOpen(await panelNow()), true);
  queue.finishHead();
  radio.pretendPlaying(null);
  assert.equal(voteOpen(await panelNow()), false);
  empty();
});

test('Panel zeigt den laufenden Wunsch und einen Überspringen-Button', () => {
  const snapshot = {
    enabled: true, station: radio.stationByKey('lofi'), playing: false, listeners: 2, volume: 10, bitrateKbps: 384,
    vote: null, lastEvent: null, upcoming: [],
    track: { id: 'w9', title: 'Cartoon – On & On', duration: 208, source: 'Youtube', requesterId: '42',
      thumbnail: 'https://i.ytimg.com/vi/K4DyBUG242c/maxresdefault.jpg', url: 'https://www.youtube.com/watch?v=K4DyBUG242c' },
  };
  const payload = panel.renderPanel(snapshot, null, [], { cover: 'https://cover.example/radio.jpg', avatar: 'https://avatar.example/bot.png' });
  assert.equal(payload.embeds[0].data.image.url, 'https://i.ytimg.com/vi/K4DyBUG242c/maxresdefault.jpg', 'Wunsch: Vorschaubild groß');
  assert.equal(payload.embeds[0].data.thumbnail, undefined);
  assert.equal(payload.embeds[0].data.title, '▶️ Cartoon – On & On');
  assert.equal(payload.embeds[0].data.url, 'https://www.youtube.com/watch?v=K4DyBUG242c');
  assert.match(payload.embeds[0].data.description, /von <@42> · 3:28 · Youtube/);
  assert.match(payload.embeds[0].data.fields[0].value, /Danach wieder 📻 \*\*Lofi\*\*/);
  assert.deepEqual(payload.components[1].components.map((b) => b.data.custom_id), ['radio:wish', 'radio:playlist', 'radio:skip']);
  assert.equal(panel.statusText(snapshot, 'egal'), '▶️ Cartoon – On & On');
  assert.equal(panel.formatDuration(61), '1:01');
});

test('Radio: Album-Cover klein rechts, sonst das Profilbild', () => {
  const radioSnapshot = {
    enabled: true, station: radio.stationByKey('lofi'), playing: true, listeners: 2, volume: 10, bitrateKbps: 384,
    vote: null, lastEvent: null, upcoming: [], track: null,
  };
  const withCover = panel.renderPanel(radioSnapshot, 'AIRGLOW – Memory Bank', [], { cover: 'https://cover.example/a.jpg', avatar: 'https://avatar.example/bot.png' });
  assert.equal(withCover.embeds[0].data.thumbnail.url, 'https://cover.example/a.jpg');
  assert.equal(withCover.embeds[0].data.image, undefined);
  const noCover = panel.renderPanel(radioSnapshot, 'Unbekannt', [], { cover: null, avatar: 'https://avatar.example/bot.png' });
  assert.equal(noCover.embeds[0].data.thumbnail.url, 'https://avatar.example/bot.png');
  const bare = panel.renderPanel(radioSnapshot, 'Unbekannt', []);
  assert.equal(bare.embeds[0].data.thumbnail, undefined, 'ohne Profilbild kein Bild');

  assert.equal(panel.coverSearchTerm('Cartoon, Jéja - On & On (feat. Daniel Levi) [NCS Release]'), 'Cartoon, Jéja - On & On');
  assert.equal(panel.coverFromItunes({ results: [{ artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/x/y.png/100x100bb.jpg' }] }),
    'https://is1-ssl.mzstatic.com/image/thumb/x/y.png/600x600bb.jpg');
  assert.equal(panel.coverFromItunes({ results: [] }), null);
  assert.equal(panel.coverFromItunes(null), null);
});

test('Lautstärke: alle sehen sie, nur das Team stellt sie ein', async () => {
  const listener = member();
  const admin = member({ staff: true });
  const show = command(listener);
  await radio.setRadioVolume(show, null);
  assert.equal(show.replies[0].content, t('volume_now', { percent: 10 }), 'Standard: 10 %');

  const denied = command(listener);
  await radio.setRadioVolume(denied, 30);
  assert.equal(denied.replies[0].content, t('team_only'));
  assert.equal(getState().volume, 10);

  const set = command(admin);
  await radio.setRadioVolume(set, 40);
  assert.equal(set.replies[0].content, t('volume_set', { percent: 40 }));
  assert.equal(getState().volume, 40);
  assert.equal(saved().volume, 40, 'übersteht einen Neustart');
});

test('die Auswahl markiert den laufenden Sender', async () => {
  let choices = [];
  await radio.radioAutocomplete({ respond: async (list) => { choices = list; } }, 'ncs');
  assert.equal(choices.length, 6);
  assert(choices.every((choice) => choice.value.startsWith('ncs')));
  assert.equal(choices.find((choice) => choice.value === 'ncs-phonk').name, t('choice_current', { station: 'NCS Phonk' }));
});

test('Playlist-Links erkennen, Einträge lesen, mischen', () => {
  const is = (link) => queue.isPlaylistLink(new URL(link));
  assert.equal(is('https://www.youtube.com/playlist?list=PL123'), true);
  assert.equal(is('https://music.youtube.com/playlist?list=PL123'), true);
  assert.equal(is('https://soundcloud.com/ncs/sets/best-of'), true);
  assert.equal(is('https://www.youtube.com/watch?v=abc&list=PL123'), false, 'ein Video aus einer Playlist bleibt ein Wunsch');
  assert.equal(is('https://youtu.be/abc?list=PL123'), false);
  assert.equal(is('https://soundcloud.com/ncs/song'), false);
  assert.equal(is('https://www.youtube.com/watch?v=abc'), false);
  assert.equal(is('https://www.youtube.com/watch?v=9D-QD_HIfjA&list=RD9D-QD_HIfjA&start_radio=1'), true, '„Radio starten“ meint den Mix');
  assert.equal(is('https://www.youtube.com/watch?v=abc&list=RDabc&index=3'), false, 'ein Song aus einem laufenden Mix');
  const mix = (link) => queue.isMixLink(new URL(link));
  assert.equal(mix('https://www.youtube.com/watch?v=abc&list=RDabc&start_radio=1'), true);
  assert.equal(mix('https://music.youtube.com/watch?v=abc&list=RDAMVMabc'), true);
  assert.equal(mix('https://www.youtube.com/playlist?list=PL123'), false);
  assert.deepEqual(queue.unique([{ id: 'a', url: 'x' }, { id: 'b', url: 'y' }, { id: 'a', url: 'x' }, { id: null, url: 'z' }, { id: null, url: 'z' }])
    .map((entry) => entry.id ?? entry.url), ['a', 'b', 'z'], 'jeder Song nur einmal');

  assert.deepEqual(queue.playlistEntry({ ie_key: 'Youtube', id: 'abc', url: 'https://www.youtube.com/watch?v=abc', title: 'Song', duration: 201.6 }),
    { id: 'abc', url: 'https://www.youtube.com/watch?v=abc', title: 'Song', duration: 202, thumbnail: 'https://i.ytimg.com/vi/abc/hqdefault.jpg' });
  assert.equal(queue.playlistEntry({ ie_key: 'Youtube', id: 'abc' }).url, 'https://www.youtube.com/watch?v=abc', 'die ID reicht');
  assert.equal(queue.playlistEntry({ ie_key: 'Youtube', id: 'p', url: 'https://www.youtube.com/watch?v=p', title: '[Private video]' }), null);
  assert.equal(queue.playlistEntry({ ie_key: 'Youtube', id: 'd', url: 'https://www.youtube.com/watch?v=d', title: '[Deleted video]' }), null);
  assert.equal(queue.playlistEntry({ ie_key: 'Youtube', id: 'l', url: 'https://www.youtube.com/watch?v=l', title: 'Live', live_status: 'is_live' }), null);
  assert.equal(queue.playlistEntry({ url: 'https://evil.example/x', title: 'x' }), null, 'nur YouTube und SoundCloud');
  assert.equal(queue.playlistEntry(null), null);
  assert.deepEqual(queue.playlistEntry({ ie_key: 'Soundcloud', id: '77', url: 'https://api.soundcloud.com/tracks/77', title: null, duration: null }),
    { id: '77', url: 'https://api.soundcloud.com/tracks/77', title: null, duration: 0, thumbnail: null }, 'SoundCloud-API-Links sind erlaubt');

  // Mit festem Zufall: alles bleibt drin, nur die Reihenfolge ändert sich.
  const mixed = queue.shuffled([1, 2, 3, 4], () => 0);
  assert.deepEqual(mixed, [2, 3, 4, 1]);
  assert.deepEqual(queue.parseDownload('{"filepath": "/tmp/a.webm", "title": "A", "duration": 184.3}\n'),
    { file: '/tmp/a.webm', title: 'A', duration: 184, thumbnail: null });
  assert.equal(queue.parseDownload(''), null, 'vom Filter ausgelassen');
  assert.equal(queue.parseDownload('kein json'), null);
});

test('Playlist: startet per Link, lädt nur zwei Songs vor, Wünsche zuerst, Song und Playlist überspringen', async () => {
  const [starter, other] = [member(), member()];
  enter(starter); enter(other);
  const before = downloads.length;
  // Ein reiner Playlist-Link im Wunsch-Formular startet die Playlist.
  const start = deferred(starter);
  await radio.requestWish(start, 'https://www.youtube.com/playlist?list=PLfocus');
  assert.equal(lastReply(start), t('playlist_added', { title: 'Focus Mix', count: 3 }), 'ohne privates Video und ohne den Stunden-Mix');
  await settle();
  assert.deepEqual([queue.playlist().title, queue.playlist().position, queue.playlist().total], ['Focus Mix', 1, 3]);
  assert.equal(queue.playlistHead().status, 'ready');
  assert.deepEqual(downloads.slice(before).map((d) => d.url),
    ['https://www.youtube.com/watch?v=kurz', 'https://www.youtube.com/watch?v=vier'], 'der laufende und der nächste, nicht alle');
  const args = downloads.at(-1).args;
  assert.equal(args[args.indexOf('--match-filter') + 1], '!is_live & duration <=? 600', 'ohne Team keine langen Songs');
  assert(args.includes('--no-playlist'));

  // Eine zweite Playlist ersetzt nur das Team.
  const second = deferred(other);
  await radio.requestPlaylist(second, 'https://soundcloud.com/ncs/sets/best');
  assert.equal(lastReply(second), t('playlist_running', { title: 'Focus Mix' }));

  const first = queue.playlistHead();
  radio.pretendPlaying(first.id);
  const message = await panelNow();
  assert.equal(message.embeds[0].data.author.name, t('panel_author_playlist', { name: env.name }));
  assert.equal(message.embeds[0].data.title, '▶️ Kurzer Song');
  assert(text(message).includes(`📃 Focus Mix · Song 1/3 · 3:00 · von <@${starter.id}>`));
  assert(text(message).includes(`📃 Playlist **Focus Mix** · 2 übrig · von <@${starter.id}>`));
  assert.deepEqual(message.components[1].components.map((b) => b.data.custom_id),
    ['radio:wish', 'radio:playlist', 'radio:skip', 'radio:playlist-skip']);
  assert.equal(panel.statusText(radio.radioSnapshot(), null), '▶️ Kurzer Song');

  // Wer die Playlist gestartet hat, überspringt Songs sofort.
  const skip = command(starter);
  await radio.requestSkip(skip);
  assert.equal(skip.replies[0].content, t('skipped', { title: 'Kurzer Song' }));
  assert.equal(existsSync(first.file), false, 'die Datei ist gleich wieder weg');
  await settle();
  assert.equal(queue.playlistHead().title, 'Vierter Song');
  assert.equal(queue.playlist().position, 2);

  // Ein Wunsch unterbricht den laufenden Playlist-Song nicht, kommt aber danach als Erstes.
  radio.pretendPlaying(queue.playlistHead().id);
  await radio.requestWish(deferred(other), 'https://soundcloud.com/ncs/zwei');
  await settle();
  assert.equal(radio.nextTrack(), queue.playlistHead(), 'der laufende Song spielt zu Ende');
  radio.pretendPlaying(null);
  assert.equal(radio.nextTrack(), queue.head(), 'danach zuerst der Wunsch');
  assert.match(text(await panelNow()), /`1\.` Zweiter Song[\s\S]*📃 Playlist \*\*Focus Mix\*\* · 2 übrig[\s\S]*Danach wieder/);
  queue.clearQueue();
  assert.equal(radio.nextTrack(), queue.playlistHead(), 'ohne Wünsche wieder die Playlist');

  // Die ganze Playlist: andere stimmen ab.
  const files = [queue.playlistHead().file];
  const ask = command(other);
  await radio.requestPlaylistSkip(ask);
  assert.equal(ask.replies[0].content, t('playlist_vote_started', { title: 'Focus Mix' }));
  assert.match(text(await panelNow()), /🗳️ Playlist „Focus Mix“ überspringen\?/);
  await click(starter, 'yes');
  assert.equal(queue.playlist(), null);
  assert(files.every((file) => !existsSync(file)), 'heruntergeladene Songs sind weg');
  const after = await panelNow();
  assert(text(after).includes(t('event_playlist_passed', { title: 'Focus Mix' })));
  assert.deepEqual(after.components[1].components.map((b) => b.data.custom_id), ['radio:wish', 'radio:playlist']);

  const none = command(other);
  await radio.requestPlaylistSkip(none);
  assert.equal(none.replies[0].content, t('playlist_nothing'));
  empty();
});

test('Playlist: das Team ersetzt eine laufende, beginnt beim Video im Link, danach kommt das Radio', async () => {
  const m = member();
  enter(m);
  await radio.requestPlaylist(deferred(m), 'https://www.youtube.com/playlist?list=PLfocus');
  const admin = member({ staff: true });
  const replace = deferred(admin);
  await radio.requestPlaylist(replace, 'https://www.youtube.com/watch?v=vier&list=PLfocus');
  assert.equal(lastReply(replace), t('playlist_added', { title: 'Focus Mix', count: 2 }), 'ab dem vierten Song, das Team auch mit langen');
  assert.equal(queue.playlist().requesterId, admin.id);
  await settle();
  assert.equal(queue.playlistHead().title, 'Vierter Song');
  assert.equal(downloads.at(-1).args[downloads.at(-1).args.indexOf('--match-filter') + 1], '!is_live', 'Team: keine Längengrenze');

  queue.finishPlaylistTrack();
  await settle();
  assert.equal(queue.playlistHead().title, 'Fünfter Song');
  queue.finishPlaylistTrack();
  assert.equal(queue.playlist(), null);
  assert(text(await panelNow()).includes(t('event_playlist_done', { title: 'Focus Mix' })));

  const single = deferred(admin);
  await radio.requestPlaylist(single, 'https://www.youtube.com/watch?v=kurz');
  assert.equal(lastReply(single), t('playlist_link'), 'ein einzelnes Video ist keine Playlist');
  const broken = deferred(admin);
  await radio.requestPlaylist(broken, 'https://example.com/playlist?list=x');
  assert.equal(lastReply(broken), t('playlist_link'));
  empty();
});

test('Playlist: SoundCloud nennt Titel erst beim Download, zu Langes und Kaputtes wird ausgelassen', async () => {
  const m = member();
  enter(m);
  await radio.requestPlaylist(deferred(m), 'https://soundcloud.com/ncs/sets/best');
  await settle();
  assert.equal(queue.playlistHead().title, 'Zweiter Song', 'Titel aus dem Download');
  assert.equal(queue.playlistHead().duration, 200);
  // Der 15-Minuten-Song fällt ohne Team-Rechte durch den Filter, der nächste rückt nach.
  assert(text(await panelNow()).includes(t('event_wish_failed', { title: 'Best of #2' })));
  queue.finishPlaylistTrack();
  await settle();
  assert.equal(queue.playlistHead().title, 'Vierter SC-Song');
  assert.equal(queue.playlist().position, 3);
  queue.clearPlaylist();

  // Scheitern mehrere Songs hintereinander, endet die Playlist, statt alle durchzuprobieren.
  const before = downloads.length;
  await radio.requestPlaylist(deferred(m), 'https://www.youtube.com/playlist?list=PLkaputt');
  await settle();
  assert.equal(queue.playlist(), null);
  assert.equal(downloads.length, before);
  assert(text(await panelNow()).includes(t('event_playlist_broken', { title: 'Kaputt' })));
  empty();
});

test('YouTube-Mix: per „Radio starten“-Link, ohne Doppelte, lädt endlos nach', async () => {
  const m = member();
  enter(m);
  const before = probes.length;
  const start = deferred(m);
  await radio.requestWish(start, 'https://www.youtube.com/watch?v=s1&list=RDseed&start_radio=1');
  assert.equal(lastReply(start), t('playlist_added_mix', { title: 'Mix - Seed' }));
  assert.equal(queue.playlist().endless, true);
  await settle();
  // Sieben verschiedene Songs, fünf davon noch nicht im Puffer: Der Mix lädt sofort nach, ab dem letzten Song.
  assert.deepEqual(probes.slice(before), ['https://www.youtube.com/watch?v=s1&list=RDseed&start_radio=1',
    'https://www.youtube.com/watch?v=s7&list=RDs7']);
  assert.equal(queue.playlist().total, 10, 's7 und s6 kamen schon vor, n1–n3 sind neu');
  assert.equal(queue.playlistHead().title, 'Mix-Song 1');

  radio.pretendPlaying(queue.playlistHead().id);
  const message = await panelNow();
  assert(text(message).includes(`📻 Mix - Seed · Song 1 · 3:20 · von <@${m.id}>`));
  assert(text(message).includes(`📻 Mix **Mix - Seed** · endlos · von <@${m.id}>`));
  assert(text(message).includes(t('panel_after_mix', { station: radio.stationByKey(station()).name })));
  assert(text(message).includes(t('event_mix', { user: `<@${m.id}>`, title: 'Mix - Seed' })));
  radio.pretendPlaying(null);
  queue.clearPlaylist();
  empty();
});

test('Panel: lädt der erste Song der Playlist noch, steht es dabei', () => {
  const snapshot = {
    enabled: true, station: radio.stationByKey('lofi'), playing: true, listeners: 2, volume: 10, bitrateKbps: 384,
    vote: null, lastEvent: null, track: null, upcoming: [],
    playlist: { id: 'p1', title: 'Focus', url: 'https://www.youtube.com/playlist?list=x', requesterId: '7', position: 1, total: 20,
      endless: false, left: 20, loading: true },
  };
  const loading = text(panel.renderPanel(snapshot, null, []));
  assert(loading.includes(`📃 Playlist **Focus** · 20 übrig · von <@7>${t('panel_loading')}`));
  assert(loading.includes(t('panel_after', { station: 'Lofi' })));
  const loaded = text(panel.renderPanel({ ...snapshot, playlist: { ...snapshot.playlist, loading: false } }, null, []));
  assert(!loaded.includes(t('panel_loading')));
});

test('ein Song, der noch lädt, wird gelesen, bis der Download fertig ist', async () => {
  const file = join(dir, 'wachsend.webm');
  writeFileSync(file, 'anfang-');
  let state = 'growing';
  const reader = queue.followFile(file, () => state, 5);
  const chunks = [];
  const finished = new Promise((resolve, reject) => {
    reader.on('data', (chunk) => chunks.push(chunk));
    reader.on('end', resolve);
    reader.on('error', reject);
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  appendFileSync(file, 'mitte-');
  await new Promise((resolve) => setTimeout(resolve, 30));
  appendFileSync(file, 'ende');
  state = 'done';
  await finished;
  assert.equal(Buffer.concat(chunks).toString(), 'anfang-mitte-ende', 'nichts verloren, auch nicht das letzte Stück');

  // Gescheitert oder übersprungen: liest, was da ist, und hört auf.
  writeFileSync(file, 'halb');
  let rest = '';
  for await (const chunk of queue.followFile(file, () => 'gone', 5)) rest += chunk;
  assert.equal(rest, 'halb');
});

test('ein YouTube-Song läuft schon, während er noch lädt, mittendrin weiter erst, wenn er ganz da ist', async () => {
  const admin = member({ staff: true });
  Object.assign(queue.PARTIAL, { pollMs: 5, bytes: 4 });
  let release;
  slow.set('https://www.youtube.com/watch?v=vier', new Promise((resolve) => { release = resolve; }));
  try {
    await radio.requestWish(deferred(admin), 'https://www.youtube.com/watch?v=vier');
    await new Promise((resolve) => setTimeout(resolve, 40));
    const track = queue.head();
    assert.equal(track.status, 'partial');
    assert.match(track.file, /\.webm$/);
    assert.equal(queue.downloadState(track), 'growing');
    assert.equal(radio.nextTrack(), track, 'von vorn kann er schon laufen');
    track.resumeAt = 30;
    assert.equal(radio.nextTrack(), null, 'an Sekunde 30 geht es erst weiter, wenn die Datei komplett ist');
    track.resumeAt = undefined;
    release();
    await settle();
    assert.equal(track.status, 'ready');
    assert.equal(queue.downloadState(track), 'done');
    assert.equal(readFileSync(track.file, 'utf8'), 'teil-rest');
    assert(downloads.at(-1).args.includes('--no-part'), 'ohne .part-Datei, sonst gäbe es nichts zu lesen');
    queue.clearQueue();
    assert.equal(queue.downloadState(track), 'gone');
  } finally {
    // Auch nach einem Fehler den Download beenden, sonst wartet der Test ewig.
    release?.();
    slow.clear();
    Object.assign(queue.PARTIAL, { pollMs: 500, bytes: 256 * 1024 });
    queue.clearQueue();
  }
});

test('während des Ladens nur abspielen, wenn genug da ist und der Download der Wiedergabe davonläuft', () => {
  const kb = 1024;
  assert.equal(queue.playableWhileLoading({ at: 0, size: 0 }, { at: 1000, size: 100 * kb }), false, 'noch zu wenig da');
  assert.equal(queue.playableWhileLoading({ at: 0, size: 300 * kb }, { at: 0, size: 300 * kb }), true, 'beim ersten Blick schon genug');
  assert.equal(queue.playableWhileLoading({ at: 0, size: 0 }, { at: 2000, size: 300 * kb }), true, '150 KB/s');
  assert.equal(queue.playableWhileLoading({ at: 0, size: 0 }, { at: 10_000, size: 300 * kb }), false,
    '30 KB/s: die Wiedergabe holt den Download ein, also erst spielen, wenn er ganz da ist');
});

test('übersprungen, während er noch lädt: Download bricht ab, der nächste Song lädt sofort', async () => {
  const admin = member({ staff: true });
  enter(admin);
  Object.assign(queue.PARTIAL, { pollMs: 5 });
  let release;
  slow.set('https://www.youtube.com/watch?v=kurz', new Promise((resolve) => { release = resolve; }));
  try {
    await radio.requestPlaylist(deferred(admin), 'https://www.youtube.com/playlist?list=PLfocus');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const first = queue.playlistHead();
    assert.equal(first.url, 'https://www.youtube.com/watch?v=kurz');
    assert.equal(first.status, 'loading');
    const before = downloads.length;
    queue.finishPlaylistTrack();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(aborted, ['https://www.youtube.com/watch?v=kurz']);
    assert.equal(downloads[before]?.url, queue.playlistHead().url, 'der nächste lädt, ohne auf den alten Download zu warten');
    assert.equal(readdirSync(env.cacheDir).some((name) => name.startsWith(`${first.id}.`)), false, 'die halbe Datei ist weg');
    assert.equal(queue.playlist().position, 2, 'kein Fehler, die Playlist läuft weiter');
  } finally {
    release?.();
    slow.clear();
    aborted.length = 0;
    Object.assign(queue.PARTIAL, { pollMs: 500 });
    queue.clearPlaylist();
    await settle();
    empty();
  }
});

test('YouTube will eine Anmeldung: derselbe Song kommt später noch mal, der laufende spielt immer zu Ende', async () => {
  assert.equal(queue.blockedByYouTube('Sign in to confirm you’re not a bot. Use --cookies-from-browser'), true);
  assert.equal(queue.blockedByYouTube('HTTP Error 403: Forbidden'), false);
  const m = member();
  enter(m);
  const retries = RULES.blockedRetrySeconds;
  RULES.blockedRetrySeconds = [0.01, 0.01];
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    // Einmal geblockt: Beim zweiten Versuch klappt es, ohne dass ein Song ausfällt.
    blocked.set('https://www.youtube.com/watch?v=vier', 1);
    const before = downloads.length;
    await radio.requestPlaylist(deferred(m), 'https://www.youtube.com/playlist?list=PLfocus');
    await wait(60);
    const first = queue.playlistHead();
    assert.equal(first.title, 'Kurzer Song');
    assert.equal(blocked.get('https://www.youtube.com/watch?v=vier'), 0, 'einmal geblockt');
    assert.equal(downloads.slice(before).filter((d) => d.url.endsWith('v=vier')).length, 1, 'beim zweiten Versuch geladen');
    assert(!text(await panelNow()).includes(t('event_wish_failed', { title: 'Vierter Song' })));

    // YouTube blockt weiter: Der nächste Song lässt sich nicht laden, der laufende spielt trotzdem zu Ende.
    blocked.set('https://www.youtube.com/watch?v=fuenf', 99);
    queue.finishPlaylistTrack();
    const current = queue.playlistHead();
    assert.equal(current.title, 'Vierter Song');
    radio.pretendPlaying(current.id);
    await wait(80);
    assert.equal(queue.playlistHead(), current, 'der laufende Song bleibt');
    assert.equal(radio.nextTrack(), current);
    assert.equal(radio.radioSnapshot().playlist.left, 0, 'danach kommt nichts mehr');
    queue.finishPlaylistTrack();
    assert.equal(queue.playlist(), null);
    assert(text(await panelNow()).includes(t('event_playlist_blocked', { title: 'Focus Mix' })), 'erst jetzt die Meldung');
  } finally {
    RULES.blockedRetrySeconds = retries;
    blocked.clear();
    radio.pretendPlaying(null);
    queue.clearPlaylist();
    empty();
  }
});

test('abgelehnt, sobald die Mehrheit unerreichbar ist, danach Pause', async () => {
  // Zuletzt: Die Pause gilt ab hier für alle weiteren Abstimmungen.
  RULES.voteCooldownMinutes = 3;
  const current = station();
  const [a, b, c] = [member(), member(), member()];
  enter(a); enter(b); enter(c);
  await radio.requestStation(command(a), 'ncs');
  await click(b, 'no');
  assert.equal(voteOpen(await panelNow()), true, 'eine Nein-Stimme von dreien entscheidet noch nichts');
  await click(c, 'no');
  const message = await panelNow();
  assert.equal(voteOpen(message), false);
  assert(text(message).includes(t('event_failed', { station: 'NCS', yes: 1, no: 2 })));
  assert.equal(station(), current);

  const retry = command(b);
  await radio.requestStation(retry, 'ncs');
  assert.match(retry.replies[0].content, /^Die nächste Abstimmung ist <t:\d+:R> möglich\.$/);
  empty();
});

test('ausgeschaltet nimmt das Radio keine Wünsche an', async () => {
  const m = member();
  enter(m);
  updateState({ enabled: false });
  const interaction = command(m);
  await radio.requestStation(interaction, 'lofi');
  assert.equal(interaction.replies[0].content, t('off'));
  updateState({ enabled: true });
  empty();
  radio.stopRadio();
  await panel.stopPanel();
  assert.equal(saved().station, station(), 'der Sender übersteht einen Neustart');
});

test('eine kaputte Zustandsdatei fällt auf die Standardwerte zurück', () => {
  const broken = join(dir, 'kaputt.json');
  updateState({}, broken);
  rmSync(broken);
  assert.deepEqual(loadState(broken), { enabled: true, station: 'lofi', volume: 10 });
  loadState();
});

test('Team: Owner, Administrator oder eine Team-Rolle', () => {
  const base = { guild: { ownerId: '999' }, roles: { cache: new Collection() }, permissions: { has: () => false } };
  assert.equal(radio.isTeam({ ...base, id: '1' }), false);
  assert.equal(radio.isTeam({ ...base, id: '999' }), true);
  assert.equal(radio.isTeam({ ...base, id: '2', permissions: { has: () => true } }), true);
  assert.equal(radio.isTeam({ ...base, id: '3', roles: { cache: new Collection([['900', {}]]) } }), true);
});

test('ohne Wünsche: keine Befehle, kein Button, freundliche Absage', async () => {
  const definition = radioCommand({ wishes: false });
  assert.deepEqual(definition.options.map((o) => o.name), ['station', 'now', 'volume', 'off', 'on']);

  env.wishes = false;
  try {
    const snapshot = {
      enabled: true, station: radio.stationByKey('lofi'), playing: true, listeners: 1, volume: 10, bitrateKbps: 128,
      vote: null, lastEvent: null, track: null, upcoming: [],
    };
    const payload = panel.renderPanel(snapshot, null, []);
    assert.equal(payload.components.length, 1, 'nur das Dropdown, keine leere Button-Zeile');
    const m = member();
    enter(m);
    const interaction = command(m);
    await radio.requestWish(interaction, 'https://www.youtube.com/watch?v=kurz');
    assert.equal(interaction.replies[0].content, t('wishes_off'));
    empty();
  } finally {
    env.wishes = true;
  }
});

test('Credit steht immer ganz unten im Panel', () => {
  const snapshot = {
    enabled: true, station: radio.stationByKey('lofi'), playing: true, listeners: 1, volume: 10, bitrateKbps: 128,
    vote: null, lastEvent: null, track: null, upcoming: [],
  };
  const plain = panel.renderPanel(snapshot, 'Song', []).embeds[0].data;
  assert(plain.description.endsWith(panel.CREDIT), 'ohne Blöcke am Ende der Beschreibung');
  assert.match(panel.CREDIT, /\[Deskradio\]\(https:\/\/github\.com\/enricofranke\/deskradio\) · by Enrico Franke/);

  const withQueue = panel.renderPanel({ ...snapshot, upcoming: [{ id: 'w1', title: 'A', duration: 60, requesterId: '1', status: 'ready' }] }, null, []).embeds[0].data;
  assert(withQueue.fields.at(-1).value.endsWith(panel.CREDIT), 'mit Blöcken im letzten');
  assert(!withQueue.description.includes(panel.CREDIT), 'nur einmal');

  const off = panel.renderPanel({ ...snapshot, enabled: false }, null, []).embeds[0].data;
  assert(off.description.endsWith(panel.CREDIT), 'auch wenn das Radio aus ist');
});

test('Deutsch und Englisch haben dieselben Texte und Platzhalter', () => {
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  assert.deepEqual(Object.keys(TEXTS.en).sort(), Object.keys(TEXTS.de).sort());
  for (const key of Object.keys(TEXTS.de)) {
    assert.deepEqual(placeholders(TEXTS.en[key]), placeholders(TEXTS.de[key]), key);
  }
  assert.equal(t('switched', { station: 'Lofi' }, 'en'), 'Switched to **Lofi**.');
  assert.equal(t('switched', { station: 'Lofi' }, 'de'), 'Gewechselt auf **Lofi**.');
});
