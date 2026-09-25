import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
]);
const failDownload = new Set();
queue.useRunner(async (args) => {
  const url = args.at(-1);
  if (args.includes('--dump-single-json')) {
    const info = catalog.get(url);
    if (!info) throw new Error('Video unavailable');
    return JSON.stringify({ ...info, webpage_url: url });
  }
  if (failDownload.has(url)) throw new Error('HTTP Error 403: Forbidden');
  const file = args[args.indexOf('-o') + 1].replace('%(ext)s', 'webm');
  writeFileSync(file, 'ton');
  return `${file}\n`;
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
  assert.deepEqual(definition.options.map((o) => o.name), ['station', 'now', 'volume', 'request', 'skip', 'clear', 'off', 'on']);
  assert.deepEqual(definition.options.map((o) => o.name_localizations?.de ?? o.name),
    ['sender', 'jetzt', 'lautstärke', 'wunsch', 'skip', 'leeren', 'aus', 'an'], 'auf Deutsch wie bisher');
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
  assert.deepEqual(payload.components[1].components.map((b) => b.data.custom_id), ['radio:wish', 'radio:skip']);
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
