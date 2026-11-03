import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import {
  AudioPlayerStatus,
  NetworkingStatusCode,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  type AudioPlayer,
  type AudioPlayerState,
  type AudioResource,
  type VoiceConnection,
  type VoiceConnectionState,
} from '@discordjs/voice';
import {
  ActivityType,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  escapeMarkdown,
  type AutocompleteInteraction,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type ModalSubmitInteraction,
  type GuildMember,
  type StringSelectMenuInteraction,
  type VoiceChannel,
  type VoiceState,
} from 'discord.js';
import { env } from './env.js';
import { log } from './logger.js';
import { RULES, STATIONS, getState, target, updateState, type Station } from './settings.js';
import { t } from './texts.js';
import {
  addPlaylist,
  addWish,
  clearPlaylist,
  clearQueue,
  downloadState,
  finishHead,
  followFile,
  finishPlaylistTrack,
  head,
  isPlaylistLink,
  onQueueChange,
  playlist,
  playlistHead,
  resetCache,
  supportedLink,
  tracks,
  type PlaylistView,
  type Track,
} from './queue.js';

/**
 * Radio im Sprachkanal: Der Bot sitzt dauerhaft im Kanal aus RADIO_CHANNEL_ID
 * und spielt einen Internetradio-Stream. ffmpeg wandelt das MP3 in Opus, das
 * Discord annimmt; @discordjs/voice taktet die Pakete und verschlüsselt sie.
 *
 * Vorrang hat ein Wunsch, dann eine Playlist, dann das Radio. Ein laufender
 * Song wird nicht für einen anderen unterbrochen, nur das Radio.
 *
 * Gestreamt wird nur, solange jemand mit eingeschaltetem Ton zuhört. Sender,
 * Lautstärke und an/aus liegen im Zustand (settings.ts) und überstehen so
 * einen Neustart. Abstimmungen leben nur eine Minute und deshalb nur im
 * Arbeitsspeicher; ein Neustart beendet sie, ihre Buttons melden danach „vorbei“.
 */

export type { Station };
type Outcome = 'open' | 'passed' | 'failed' | 'team' | 'obsolete';
type VoteKind = 'station' | 'skip' | 'playlist';
type Tally = { yes: number; no: number; undecided: number; outcome: 'open' | 'passed' | 'failed' };
type Vote = {
  id: string;
  kind: VoteKind;
  /** Für einen Senderwechsel der Sender; fürs Überspringen die ID des Songs oder der Playlist. */
  station: Station | null;
  targetId: string | null;
  label: string;
  starterId: string;
  yes: Set<string>;
  no: Set<string>;
  endsAt: number;
  timer: NodeJS.Timeout;
  outcome: Outcome;
  final: Tally | null;
};

/** Was das Panel zeigt. Ein Schnappschuss, damit es nichts von innen anfassen muss. */
export type RadioSnapshot = {
  enabled: boolean;
  station: Station | undefined;
  /** Der Radiosender läuft gerade (nicht ein Wunsch). */
  playing: boolean;
  /** Der Wunsch oder Playlist-Song, der gerade läuft. */
  track: Pick<Track, 'id' | 'title' | 'duration' | 'source' | 'requesterId' | 'thumbnail' | 'url' | 'playlistId'> | null;
  /** Wünsche, die danach kommen, ohne den laufenden. */
  upcoming: Pick<Track, 'id' | 'title' | 'duration' | 'requesterId' | 'status'>[];
  /** Die Playlist; `left` zählt die Songs, die noch kommen, ohne den laufenden. `loading`: ihr nächster Song lädt noch. */
  playlist: (PlaylistView & { left: number; loading: boolean }) | null;
  listeners: number;
  volume: number;
  bitrateKbps: number;
  vote: { id: string; kind: VoteKind; label: string; starterId: string; endsAt: number; tally: Tally } | null;
  lastEvent: { text: string; at: number } | null;
};

const EPHEMERAL = { flags: MessageFlags.Ephemeral } as const;
const NO_PINGS = { allowedMentions: { parse: [] as never[] } };
const MAX_BACKOFF_MS = 5 * 60_000;

let client: Client | null = null;
let started = false;
let player: AudioPlayer | null = null;
let connection: VoiceConnection | null = null;
let ffmpeg: ChildProcess | null = null;
let resource: AudioResource | null = null;
/** Liest einen Song, der noch lädt, und reicht ihn an ffmpeg weiter. */
let feed: Readable | null = null;
let playing: string | null = null;
let playingSince = 0;
/** Startstelle des laufenden Wunsches in Sekunden (nach einer Unterbrechung). */
let playingFrom = 0;
let restartTimer: NodeJS.Timeout | null = null;
let restartDelay = 5_000;
let rejoinTimer: NodeJS.Timeout | null = null;
let rejoinDelay = 15_000;
let ffmpegMissingReported = false;
const watched = new WeakSet<VoiceConnection>();

let vote: Vote | null = null;
const nextVoteAt: Record<VoteKind, number> = { station: 0, skip: 0, playlist: 0 };
let lastEvent: RadioSnapshot['lastEvent'] = null;
const changeListeners = new Set<() => void>();

/** Das Panel hört hier zu und zeichnet sich neu. */
export function onRadioChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function changed(): void {
  for (const listener of changeListeners) listener();
}

function event(text: string): void {
  lastEvent = { text, at: Date.now() };
}

export function radioSnapshot(): RadioSnapshot {
  const channel = radioChannel();
  const current = playingTrack();
  const list = playlist();
  const fromList = Boolean(list && current?.playlistId === list.id);
  return {
    enabled: getState().enabled,
    station: currentStation(),
    playing: playing !== null && !playing.startsWith('track:'),
    track: current && {
      id: current.id, title: current.title, duration: current.duration, source: current.source,
      requesterId: current.requesterId, thumbnail: current.thumbnail, url: current.url, playlistId: current.playlistId,
    },
    upcoming: tracks().filter((track) => track !== current)
      .map(({ id, title, duration, requesterId, status }) => ({ id, title, duration, requesterId, status })),
    playlist: list && {
      ...list,
      left: Math.max(0, list.total - list.position + (fromList ? 0 : 1)),
      loading: !fromList && playlistHead()?.status === 'loading',
    },
    listeners: channel ? listeners(channel).length : 0,
    volume: getState().volume,
    bitrateKbps: channel ? streamBitrate(channel) : RULES.minBitrateKbps,
    vote: vote && { id: vote.id, kind: vote.kind, label: vote.label, starterId: vote.starterId, endsAt: vote.endsAt, tally: currentTally(vote) },
    lastEvent,
  };
}

/** Nur für Tests: so tun, als liefe dieser Wunsch gerade, ohne Sprachverbindung. */
export function pretendPlaying(trackId: string | null): void {
  playing = trackId ? `track:${trackId}` : null;
}

/** Erster Wunsch und aktueller Playlist-Song: nur diese beiden können laufen. */
function candidates(): Track[] {
  return [head(), playlistHead()].filter((track) => track !== undefined);
}

/** Der Song, der gerade spielt – nicht bloß der erste in der Schlange. */
function playingTrack(): Track | null {
  if (!playing?.startsWith('track:')) return null;
  return candidates().find((track) => playing === `track:${track.id}`) ?? null;
}

/**
 * Was jetzt laufen soll. Ein Song, der schon läuft, spielt zu Ende; einer,
 * der unterbrochen wurde, geht zuerst weiter. Sonst der erste Wunsch vor der
 * Playlist. Lädt beides noch, läuft solange das Radio.
 *
 * Ein Song, der noch lädt, kann nur von vorn laufen: Mittendrin weiter geht
 * erst, wenn die Datei komplett ist.
 */
export function nextTrack(): Track | null {
  const ready = candidates().filter((track) => track.file &&
    (track.status === 'ready' || (track.status === 'partial' && !(track.resumeAt ?? 0))));
  return ready.find((track) => playing === `track:${track.id}`)
    ?? ready.find((track) => (track.resumeAt ?? 0) > 0)
    ?? ready[0] ?? null;
}

// Neue, geladene oder fehlgeschlagene Wünsche: abspielen, was dran ist.
onQueueChange((text) => {
  if (text) event(text);
  // Der Titel oder die Playlist, über die abgestimmt wurde, ist schon vorbei.
  if (vote?.kind === 'skip' && !candidates().some((track) => track.id === vote?.targetId)) conclude(vote, 'obsolete');
  if (vote?.kind === 'playlist' && playlist()?.id !== vote.targetId) conclude(vote, 'obsolete');
  syncRadio();
  changed();
});

// ================================================================ Sender

export function stations(): Station[] {
  return STATIONS;
}

export function stationByKey(key: string | null | undefined): Station | undefined {
  return key ? stations().find((station) => station.key === key) : undefined;
}

function currentStation(): Station | undefined {
  return stationByKey(getState().station) ?? stations()[0];
}

function radioChannel(): VoiceChannel | null {
  const id = target.channelId;
  const channel = id ? client?.guilds.cache.get(target.guildId)?.channels.cache.get(id) : null;
  return channel?.type === ChannelType.GuildVoice ? channel : null;
}

/** Wer zuhört: Menschen im Radio-Kanal mit eingeschaltetem Ton. */
function listeners(channel: VoiceChannel): GuildMember[] {
  return [...channel.members.values()].filter((member) => !member.user.bot && !member.voice.deaf);
}

function isListening(member: GuildMember, channel: VoiceChannel): boolean {
  return member.voice.channelId === channel.id && !member.voice.deaf;
}

/** Team: Server-Owner, Administrator oder eine Rolle aus RADIO_TEAM_ROLES. */
export function isTeam(member: GuildMember): boolean {
  if (member.id === member.guild.ownerId) return true;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return env.teamRoles.some((id) => member.roles.cache.has(id));
}

/** Ins Log, und wenn RADIO_ERROR_CHANNEL_ID gesetzt ist, auch in den Kanal. */
async function alert(message: string, context: Record<string, unknown> = {}, error?: unknown): Promise<void> {
  log.error(message, { ...context, ...(error ? { error: String(error) } : {}) });
  if (!env.errorChannelId || !client) return;
  try {
    const channel = await client.channels.fetch(env.errorChannelId);
    const details = Object.entries(context).filter(([, value]) => value !== undefined)
      .map(([key, value]) => `**${key}:** \`${String(value).slice(0, 200)}\``).join('\n');
    if (channel?.isSendable()) await channel.send({ content: `🚨 ${message}\n${details}`.slice(0, 2000), ...NO_PINGS });
  } catch {
    // Ein Fehler beim Melden eines Fehlers darf keine Schleife auslösen.
  }
}

// ============================================================ Abstimmung

/**
 * Mehr Ja als Nein gewinnt; wer nicht abstimmt, blockiert nicht. Gezählt
 * werden nur Leute, die gerade zuhören: Wer geht, nimmt seine Stimme mit.
 * Entschieden ist schon vor Ablauf der Zeit, sobald die Unentschiedenen das
 * Ergebnis nicht mehr drehen können. Gleichstand heißt: Es bleibt beim Alten.
 */
export function tally(listenerIds: Iterable<string>, yes: Set<string>, no: Set<string>): Tally {
  const present = new Set(listenerIds);
  const yesCount = [...yes].filter((id) => present.has(id)).length;
  const noCount = [...no].filter((id) => present.has(id)).length;
  const undecided = present.size - yesCount - noCount;
  const outcome = yesCount > noCount + undecided ? 'passed' : yesCount + undecided <= noCount ? 'failed' : 'open';
  return { yes: yesCount, no: noCount, undecided, outcome };
}

/** Nach Ablauf der Zeit zählen nur die abgegebenen Stimmen. */
export function decideAtEnd(counts: Tally): 'passed' | 'failed' {
  return counts.yes > counts.no ? 'passed' : 'failed';
}

function currentTally(v: Vote): Tally {
  const channel = radioChannel();
  return tally(channel ? listeners(channel).map((member) => member.id) : [], v.yes, v.no);
}

/**
 * Beendet die Abstimmung im Speicher und hält das Ergebnis für das Panel
 * fest. Ein angenommener Wechsel meldet sich über switchStation.
 */
function conclude(v: Vote, outcome: Exclude<Outcome, 'open'>): void {
  if (vote === v) vote = null;
  clearTimeout(v.timer);
  v.final = currentTally(v);
  v.outcome = outcome;
  if (outcome === 'obsolete') return;
  nextVoteAt[v.kind] = Date.now() + (v.kind === 'station' ? RULES.voteCooldownMinutes * 60_000 : RULES.skipCooldownSeconds * 1000);
  if (outcome === 'failed') {
    const key = v.kind === 'station' ? 'event_failed' : v.kind === 'skip' ? 'event_skip_failed' : 'event_playlist_vote_failed';
    event(t(key, { station: v.label, title: v.label, yes: v.final.yes, no: v.final.no }));
  }
  changed();
}

/** Angenommen: Sender wechseln, den Titel oder die Playlist überspringen, falls sie noch laufen. */
async function applyVote(v: Vote): Promise<void> {
  if (v.outcome !== 'passed') return;
  if (v.kind === 'station' && v.station) await switchStation(v.station, v.starterId, 'vote');
  if (v.kind === 'skip' && v.targetId) skipTrack(v.targetId, t('event_skip_passed', { title: v.label }));
  if (v.kind === 'playlist' && playlist()?.id === v.targetId) {
    log.info('Radio: playlist skipped by vote', { title: v.label });
    clearPlaylist(t('event_playlist_passed', { title: v.label }));
  }
}

function startVote(kind: VoteKind, label: string, starterId: string, seconds: number, extra: { station?: Station; targetId?: string }): Vote {
  const v: Vote = {
    id: Date.now().toString(36),
    kind, label, starterId,
    station: extra.station ?? null,
    targetId: extra.targetId ?? null,
    yes: new Set([starterId]),
    no: new Set(),
    endsAt: Date.now() + seconds * 1000,
    timer: setTimeout(() => void expireVote(v).catch((error) =>
      alert('Radio: could not end the vote', { vote: v.id }, error)), seconds * 1000),
    outcome: 'open',
    final: null,
  };
  vote = v;
  changed();
  return v;
}

/** Nach einer Änderung im Kanal neu zählen: Wer geht, nimmt seine Stimme mit. */
async function reviewVote(v: Vote): Promise<void> {
  if (vote !== v) return;
  const counts = currentTally(v);
  if (counts.outcome !== 'open') conclude(v, counts.outcome);
  else changed();
  await applyVote(v);
}

async function expireVote(v: Vote): Promise<void> {
  if (vote !== v) return;
  conclude(v, decideAtEnd(currentTally(v)));
  await applyVote(v);
}

// ============================================================== Befehle

export async function handleRadioCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  // Discord liefert immer die englischen Namen, auch wenn der Client sie auf Deutsch zeigt.
  if (sub === 'station') await requestStation(interaction, interaction.options.getString('station', true));
  else if (sub === 'now') await showNowPlaying(interaction);
  else if (sub === 'volume') await setRadioVolume(interaction, interaction.options.getInteger('percent'));
  else if (sub === 'request') await requestWish(interaction, interaction.options.getString('link', true));
  else if (sub === 'playlist') {
    await requestPlaylist(interaction, interaction.options.getString('link', true), interaction.options.getBoolean('shuffle') ?? false);
  } else if (sub === 'skip') await requestSkip(interaction);
  else if (sub === 'playlist-skip') await requestPlaylistSkip(interaction);
  else if (sub === 'clear') await clearWishes(interaction);
  else await setRadioEnabled(interaction, sub === 'on');
}

export async function requestStation(interaction: ChatInputCommandInteraction | StringSelectMenuInteraction, key: string): Promise<void> {
  const station = stationByKey(key);
  if (!station) {
    await interaction.reply({ content: t('unknown_station'), ...EPHEMERAL });
    return;
  }
  const channel = radioChannel();
  if (!getState().enabled || !channel) {
    await interaction.reply({ content: t('off'), ...EPHEMERAL });
    return;
  }
  if (station.key === currentStation()?.key) {
    await interaction.reply({ content: t('already', { station: station.name }), ...EPHEMERAL });
    return;
  }

  const member = interaction.member as GuildMember;
  if (isTeam(member)) {
    // Auch nach einem Team-Wechsel gilt die Pause, sonst stimmt der Kanal
    // die Entscheidung sofort wieder um.
    if (vote) conclude(vote, 'team');
    else nextVoteAt.station = Date.now() + RULES.voteCooldownMinutes * 60_000;
    await switchStation(station, member.id, 'direct');
    await interaction.reply({ content: t('switched', { station: station.name }), ...EPHEMERAL });
    return;
  }

  if (!isListening(member, channel)) {
    await interaction.reply({ content: t('not_listening', { channel: `<#${channel.id}>` }), ...EPHEMERAL });
    return;
  }
  if (vote) {
    await interaction.reply({ content: t('vote_running'), ...EPHEMERAL });
    return;
  }
  if (Date.now() < nextVoteAt.station) {
    await interaction.reply({ content: t('cooldown', { time: `<t:${Math.ceil(nextVoteAt.station / 1000)}:R>` }), ...EPHEMERAL });
    return;
  }

  // Allein im Kanal gibt es niemanden zu fragen.
  if (listeners(channel).length <= 1) {
    await switchStation(station, member.id, 'direct');
    await interaction.reply({ content: t('switched', { station: station.name }), ...EPHEMERAL });
    return;
  }

  startVote('station', station.name, member.id, RULES.voteSeconds, { station });
  await interaction.reply({ content: t('vote_started', { station: station.name }), ...EPHEMERAL });
}

// ============================================================== Wünsche

/** Wünschen darf, wer zuhört; das Team auch von außerhalb. Ein Playlist-Link startet die Playlist. */
export async function requestWish(interaction: ChatInputCommandInteraction | ModalSubmitInteraction, link: string): Promise<void> {
  const url = supportedLink(link);
  if (url && isPlaylistLink(url)) {
    await requestPlaylist(interaction, link);
    return;
  }
  if (!env.wishes) {
    await interaction.reply({ content: t('wishes_off'), ...EPHEMERAL });
    return;
  }
  const channel = radioChannel();
  if (!getState().enabled || !channel) {
    await interaction.reply({ content: t('off'), ...EPHEMERAL });
    return;
  }
  const member = interaction.member as GuildMember;
  const team = isTeam(member);
  if (!team && !isListening(member, channel)) {
    await interaction.reply({ content: t('not_listening', { channel: `<#${channel.id}>` }), ...EPHEMERAL });
    return;
  }
  // yt-dlp braucht ein paar Sekunden für Titel und Länge.
  await interaction.deferReply(EPHEMERAL);
  const result = await addWish(link, member.id, team, (track) => t('event_wish', { user: `<@${member.id}>`, title: track.title }));
  if ('error' in result) {
    await interaction.editReply({ content: t(`wish_${result.error}`, {
      max: result.error === 'full' ? RULES.queueMax : RULES.wishesPerPerson,
      minutes: RULES.maxTrackMinutes, detail: result.detail ?? '',
    }) });
    return;
  }
  log.info('Radio: request queued', { title: result.track.title, source: result.track.source, by: member.id });
  await interaction.editReply({ content: t('wish_added', { title: result.track.title, position: result.position }) });
}

// ============================================================== Playlist

/**
 * Eine Playlist starten darf, wer zuhört, und das Team. Es läuft höchstens
 * eine; eine laufende ersetzt nur das Team.
 */
export async function requestPlaylist(interaction: ChatInputCommandInteraction | ModalSubmitInteraction, link: string,
  shuffle = false): Promise<void> {
  if (!env.wishes) {
    await interaction.reply({ content: t('wishes_off'), ...EPHEMERAL });
    return;
  }
  const channel = radioChannel();
  if (!getState().enabled || !channel) {
    await interaction.reply({ content: t('off'), ...EPHEMERAL });
    return;
  }
  const member = interaction.member as GuildMember;
  const team = isTeam(member);
  if (!team && !isListening(member, channel)) {
    await interaction.reply({ content: t('not_listening', { channel: `<#${channel.id}>` }), ...EPHEMERAL });
    return;
  }
  const running = playlist();
  if (running && !team) {
    await interaction.reply({ content: t('playlist_running', { title: escapeMarkdown(running.title) }), ...EPHEMERAL });
    return;
  }
  // Das Inhaltsverzeichnis einer langen Playlist braucht ein paar Sekunden.
  await interaction.deferReply(EPHEMERAL);
  const result = await addPlaylist(link, member.id, team, {
    shuffle,
    announce: (list, count) => t(list.endless ? 'event_mix' : 'event_playlist', { user: `<@${member.id}>`, title: escapeMarkdown(list.title), count }),
  });
  if ('error' in result) {
    await interaction.editReply({ content: t(`playlist_${result.error}`, {
      title: escapeMarkdown(playlist()?.title ?? ''), detail: result.detail ?? '', minutes: RULES.maxTrackMinutes,
    }) });
    return;
  }
  log.info('Radio: playlist started', { title: result.playlist.title, songs: result.count, shuffle, by: member.id });
  // Wünsche kommen zuerst; das sollen alle wissen, die gerade eine Playlist starten.
  const waiting = tracks().length;
  const key = waiting > 0 ? 'playlist_added_after' : result.playlist.endless ? 'playlist_added_mix' : 'playlist_added';
  await interaction.editReply({ content: t(key, {
    title: escapeMarkdown(result.playlist.title), count: result.count, wishes: waiting,
  }) });
}

/**
 * Die ganze Playlist überspringen: Team und wer sie gestartet hat sofort,
 * allein im Kanal auch, sonst stimmen die Zuhörenden ab.
 */
export async function requestPlaylistSkip(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
  const list = playlist();
  const channel = radioChannel();
  if (!list || !channel) {
    await interaction.reply({ content: t('playlist_nothing'), ...EPHEMERAL });
    return;
  }
  const member = interaction.member as GuildMember;
  if (isTeam(member) || member.id === list.requesterId || (isListening(member, channel) && listeners(channel).length <= 1)) {
    if (vote?.kind === 'playlist') conclude(vote, 'obsolete');
    log.info('Radio: playlist skipped', { title: list.title, by: member.id });
    clearPlaylist(t('event_playlist_skipped', { user: `<@${member.id}>`, title: escapeMarkdown(list.title) }));
    await interaction.reply({ content: t('playlist_skipped', { title: escapeMarkdown(list.title) }), ...EPHEMERAL });
    return;
  }
  if (!isListening(member, channel)) {
    await interaction.reply({ content: t('not_listening', { channel: `<#${channel.id}>` }), ...EPHEMERAL });
    return;
  }
  if (vote) {
    await interaction.reply({ content: t('vote_running'), ...EPHEMERAL });
    return;
  }
  if (Date.now() < nextVoteAt.playlist) {
    await interaction.reply({ content: t('cooldown', { time: `<t:${Math.ceil(nextVoteAt.playlist / 1000)}:R>` }), ...EPHEMERAL });
    return;
  }
  startVote('playlist', list.title, member.id, RULES.skipVoteSeconds, { targetId: list.id });
  await interaction.reply({ content: t('playlist_vote_started', { title: escapeMarkdown(list.title) }), ...EPHEMERAL });
}

// ========================================================= Überspringen

/**
 * Überspringen geht nur bei Wünschen und Playlist-Songs; das Radio läuft live.
 * Team und wer sich den Titel gewünscht oder die Playlist gestartet hat,
 * überspringen sofort, sonst stimmen die Zuhörenden ab.
 */
export async function requestSkip(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
  const current = playingTrack();
  const channel = radioChannel();
  if (!current || !channel) {
    await interaction.reply({ content: t('skip_nothing'), ...EPHEMERAL });
    return;
  }
  const member = interaction.member as GuildMember;
  if (isTeam(member) || member.id === current.requesterId || (isListening(member, channel) && listeners(channel).length <= 1)) {
    if (vote?.kind === 'skip') conclude(vote, 'obsolete');
    skipTrack(current.id, t('event_skipped', { user: `<@${member.id}>`, title: current.title }));
    await interaction.reply({ content: t('skipped', { title: current.title }), ...EPHEMERAL });
    return;
  }
  if (!isListening(member, channel)) {
    await interaction.reply({ content: t('not_listening', { channel: `<#${channel.id}>` }), ...EPHEMERAL });
    return;
  }
  if (vote) {
    await interaction.reply({ content: t('vote_running'), ...EPHEMERAL });
    return;
  }
  if (Date.now() < nextVoteAt.skip) {
    await interaction.reply({ content: t('cooldown', { time: `<t:${Math.ceil(nextVoteAt.skip / 1000)}:R>` }), ...EPHEMERAL });
    return;
  }
  startVote('skip', current.title, member.id, RULES.skipVoteSeconds, { targetId: current.id });
  await interaction.reply({ content: t('skip_vote_started', { title: current.title }), ...EPHEMERAL });
}

/** Nur fürs Team: alle Wünsche verwerfen, das Radio läuft weiter. */
export async function clearWishes(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isTeam(interaction.member as GuildMember)) {
    await interaction.reply({ content: t('team_only'), ...EPHEMERAL });
    return;
  }
  const count = clearQueue(t('event_cleared', { user: `<@${interaction.user.id}>` }));
  await interaction.reply({ content: t('cleared', { count }), ...EPHEMERAL });
}

/** Nur, wenn der Titel noch dran ist. Die neue Wiedergabe startet über den Hinweis der Warteschlange. */
function skipTrack(id: string, text: string): void {
  if (head()?.id === id) {
    log.info('Radio: request skipped', { title: head()?.title });
    finishHead(text);
  } else if (playlistHead()?.id === id) {
    log.info('Radio: playlist song skipped', { title: playlistHead()?.title });
    finishPlaylistTrack(text);
  }
}

export async function handleRadioButton(interaction: ButtonInteraction, action: string, id: string): Promise<void> {
  const v = vote;
  if (!v || v.id !== id) {
    await interaction.reply({ content: t('vote_over'), ...EPHEMERAL });
    // Das Panel zeigt dann gleich wieder den aktuellen Stand ohne alte Buttons.
    changed();
    return;
  }
  const channel = radioChannel();
  const member = interaction.member as GuildMember | null;
  if (!channel || !member || !isListening(member, channel)) {
    await interaction.reply({ content: t('not_listening', { channel: channel ? `<#${channel.id}>` : '–' }), ...EPHEMERAL });
    return;
  }

  // Umentscheiden ist erlaubt: Die neue Stimme ersetzt die alte.
  if (action === 'yes') {
    v.yes.add(member.id);
    v.no.delete(member.id);
  } else {
    v.no.add(member.id);
    v.yes.delete(member.id);
  }
  // Bestätigen ohne sichtbare Antwort; das Panel zeichnet sich neu.
  await interaction.deferUpdate();
  const counts = currentTally(v);
  if (counts.outcome !== 'open') conclude(v, counts.outcome);
  else changed();
  await applyVote(v);
}

export async function showNowPlaying(interaction: ChatInputCommandInteraction): Promise<void> {
  const channel = radioChannel();
  const station = currentStation();
  if (!getState().enabled || !channel || !station) {
    await interaction.reply({ content: t('off'), ...EPHEMERAL });
    return;
  }
  const count = listeners(channel).length;
  if (count === 0) {
    await interaction.reply({ content: t('now_idle', { channel: `<#${channel.id}>`, station: station.name }), ...EPHEMERAL });
    return;
  }
  await interaction.deferReply(EPHEMERAL);
  const title = await fetchStreamTitle(station.url);
  const vars = { channel: `<#${channel.id}>`, station: station.name, title: escapeMarkdown(title ?? ''), listeners: count };
  await interaction.editReply({ content: t(title ? 'now' : 'now_untitled', vars) });
}

/** Nur für das Team. */
export async function setRadioEnabled(interaction: ChatInputCommandInteraction, enabled: boolean): Promise<void> {
  if (!isTeam(interaction.member as GuildMember)) {
    await interaction.reply({ content: t('team_only'), ...EPHEMERAL });
    return;
  }
  updateState({ enabled });
  if (!enabled && vote) conclude(vote, 'team');
  event(t(enabled ? 'event_on' : 'event_off', { user: `<@${interaction.user.id}>` }));
  rejoinDelay = 15_000;
  syncRadio();
  changed();
  await interaction.reply({ content: t(enabled ? 'turned_on' : 'turned_off'), ...EPHEMERAL });
}

/** Ohne Wert zeigt es die Lautstärke an, mit Wert stellt das Team sie ein. */
export async function setRadioVolume(interaction: ChatInputCommandInteraction, percent: number | null): Promise<void> {
  if (percent === null) {
    await interaction.reply({ content: t('volume_now', { percent: getState().volume }), ...EPHEMERAL });
    return;
  }
  if (!isTeam(interaction.member as GuildMember)) {
    await interaction.reply({ content: t('team_only'), ...EPHEMERAL });
    return;
  }
  const changedVolume = percent !== getState().volume;
  updateState({ volume: percent });
  log.info('Radio: volume changed', { percent, by: interaction.user.id });
  // Ein laufender Stream übernimmt die Lautstärke erst mit einem neuen ffmpeg,
  // das gibt eine Lücke von ein, zwei Sekunden. Bei gleichem Wert unnötig.
  if (playing && changedVolume) {
    stopStream();
    syncRadio();
  }
  changed();
  await interaction.reply({ content: t('volume_set', { percent }), ...EPHEMERAL });
}

export async function radioAutocomplete(interaction: AutocompleteInteraction, term: string): Promise<void> {
  const search = term.toLowerCase();
  const current = currentStation()?.key;
  await interaction.respond(
    stations()
      .filter((station) => station.key.includes(search) || station.name.toLowerCase().includes(search))
      .slice(0, 25)
      .map((station) => ({
        name: station.key === current ? t('choice_current', { station: station.name }) : station.name,
        value: station.key,
      })),
  );
}

async function switchStation(station: Station, actorId: string, how: 'direct' | 'vote'): Promise<void> {
  updateState({ station: station.key });
  log.info('Radio: station switched', { station: station.key, by: actorId, how });
  event(how === 'vote'
    ? t('event_passed', { station: station.name })
    : t('event_switched', { user: `<@${actorId}>`, station: station.name }));
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  restartDelay = 5_000;
  syncRadio();
  changed();
}

// =========================================================== Wiedergabe

/**
 * Gleicht den gewünschten Zustand mit dem tatsächlichen ab: im richtigen Kanal
 * sein, und genau dann streamen, wenn jemand zuhört. Jede Änderung — Neustart,
 * Senderwechsel, jemand kommt oder geht, Verbindung steht — landet hier.
 */
export function syncRadio(): void {
  if (!started) return;
  try {
    const channel = radioChannel();
    if (!getState().enabled || !channel) {
      leave();
      return;
    }
    if (!connection || connection.joinConfig.channelId !== channel.id) {
      if (!rejoinTimer) join(channel);
      return;
    }
    const station = currentStation();
    if (connection.state.status !== VoiceConnectionStatus.Ready || !station || listeners(channel).length === 0) {
      stopStream();
      return;
    }
    // Ein fertig geladener Wunsch oder Playlist-Song hat Vorrang vor dem Radio.
    // Lädt er noch, läuft solange weiter das Radio.
    const track = nextTrack();
    if (track) {
      if (playing !== `track:${track.id}`) startTrack(track, streamBitrate(channel));
      return;
    }
    // Während der Wartezeit nach einem Abbruch nicht sofort neu verbinden,
    // sonst hämmert jeder Kanalbeitritt auf einen ausgefallenen Stream.
    if (playing !== station.key && !restartTimer) startStream(station, streamBitrate(channel));
  } catch (error) {
    void alert('Radio: could not sync', {}, error);
  }
}

function join(channel: VoiceChannel): void {
  const next = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true, // Der Bot hört nichts, er sendet nur.
    selfMute: false, // Standard wäre stumm, dann käme kein Ton an.
  });
  connection = next;
  next.subscribe(audioPlayer());
  if (watched.has(next)) return;
  watched.add(next);

  // Wo es hängt, sagt mehr als der Fehler selbst: OpeningWs heißt TCP zum
  // Voice-Server, UdpHandshaking heißt UDP für den Ton.
  const probe: Probe = { error: [] };
  next.on('stateChange', (_old, state) => {
    if (!('networking' in state)) return;
    const networking = state.networking.state;
    probe.stage = NetworkingStatusCode[networking.code];
    if ('connectionOptions' in networking) probe.endpoint = networking.connectionOptions.endpoint;
  });
  next.on(VoiceConnectionStatus.Ready, () => {
    rejoinDelay = 15_000;
    voiceFailureReported = false;
    probe.error = [];
    log.info('Radio: in the voice channel', { channel: next.joinConfig.channelId });
    syncRadio();
  });
  next.on(VoiceConnectionStatus.Disconnected, async () => {
    stopStream();
    // Verschoben oder Voice-Server gewechselt: Die Verbindung kommt allein zurück.
    const back = await reaches(next, [VoiceConnectionStatus.Signalling, VoiceConnectionStatus.Connecting], 5_000);
    if (!back && next.state.status !== VoiceConnectionStatus.Destroyed) next.destroy();
  });
  next.on(VoiceConnectionStatus.Destroyed, () => {
    if (connection === next) connection = null;
    stopStream();
    scheduleRejoin();
  });
  next.on('error', (error) => {
    const first = probe.error.length === 0;
    probe.error = describeNetworkError(error);
    if (first) log.warn('Radio: voice connection error', { ...probe });
    // Nach einem Fehler baut die Bibliothek sofort neu auf. Scheitert das
    // mehrfach, lieber mit wachsender Pause neu beitreten, statt im Sekundentakt.
    if (next.rejoinAttempts >= 3) giveUp(next, 'several attempts failed', probe);
  });

  void reaches(next, [VoiceConnectionStatus.Ready], 30_000).then((ready) => {
    if (!ready) giveUp(next, 'not connected after 30 seconds', probe);
  });
}

type Probe = { endpoint?: string; stage?: string; error: string[] };

let voiceFailureReported = false;

/**
 * Häufigste Ursache ist eine Firewall: Die Gateway-Verbindung steht, aber
 * TCP zum Voice-Server oder UDP für den Ton kommen nicht durch. Einmal in
 * RADIO_ERROR_CHANNEL_ID melden, danach nur noch im Log, bis es wieder klappt.
 */
function giveUp(target: VoiceConnection, reason: string, probe: Probe): void {
  if (target.state.status === VoiceConnectionStatus.Destroyed || connection !== target) return;
  const details = { reason, ...probe, error: probe.error.join(', ') || undefined, retryInSeconds: rejoinDelay / 1000 };
  log.warn('Radio: no voice connection, retrying later', details);
  if (!voiceFailureReported) {
    voiceFailureReported = true;
    void alert('Radio: no voice connection to Discord', {
      ...details, hint: "Allow outbound TCP and UDP to Discord's voice servers",
    });
  }
  target.destroy();
}

/** Ein AggregateError (IPv4 und IPv6 gescheitert) sagt erst in seinen Einzelfehlern etwas. */
export function describeNetworkError(error: unknown): string[] {
  const parts = error instanceof AggregateError && error.errors.length > 0 ? error.errors : [error];
  return parts.map((part) => {
    const e = part as NodeJS.ErrnoException & { address?: string; port?: number };
    const where = e.address ? ` ${e.address}${e.port ? `:${e.port}` : ''}` : '';
    return `${e.code ?? (e instanceof Error ? e.message : String(e))}${where}`;
  });
}

/**
 * Wie entersState, nur ohne Abbruch bei einem `error`-Event: entersState
 * wartet mit events.once, und das bricht bei jedem Fehler sofort ab.
 */
function reaches(target: VoiceConnection, statuses: VoiceConnectionStatus[], ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (statuses.includes(target.state.status)) {
      resolve(true);
      return;
    }
    const finish = (result: boolean) => {
      clearTimeout(timer);
      target.off('stateChange', onChange);
      resolve(result);
    };
    const onChange = (_old: VoiceConnectionState, state: VoiceConnectionState) => {
      if (statuses.includes(state.status)) finish(true);
      else if (state.status === VoiceConnectionStatus.Destroyed) finish(false);
    };
    const timer = setTimeout(() => finish(false), ms);
    target.on('stateChange', onChange);
  });
}

function scheduleRejoin(): void {
  if (!started || rejoinTimer || !getState().enabled) return;
  const delay = rejoinDelay;
  rejoinDelay = Math.min(rejoinDelay * 2, MAX_BACKOFF_MS);
  rejoinTimer = setTimeout(() => {
    rejoinTimer = null;
    syncRadio();
  }, delay);
}

function leave(): void {
  stopStream();
  if (rejoinTimer) clearTimeout(rejoinTimer);
  rejoinTimer = null;
  const current = connection;
  connection = null;
  if (current && current.state.status !== VoiceConnectionStatus.Destroyed) current.destroy();
}

function audioPlayer(): AudioPlayer {
  if (player) return player;
  player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  player.on(AudioPlayerStatus.Idle, (oldState: AudioPlayerState) => {
    if (!playing || !('resource' in oldState) || oldState.resource !== resource) return;
    // Ein Song ist zu Ende: der nächste Wunsch, die Playlist, oder wieder das Radio.
    if (playing.startsWith('track:')) {
      const id = playing.slice('track:'.length);
      stopStream();
      if (head()?.id === id) finishHead();
      else if (playlistHead()?.id === id) finishPlaylistTrack();
      else syncRadio();
      return;
    }
    // Der Stream ist abgerissen, nicht von uns beendet: später erneut.
    const station = playing;
    const ranFor = Date.now() - playingSince;
    stopStream();
    if (ranFor > 60_000) restartDelay = 5_000;
    const delay = restartDelay;
    restartDelay = Math.min(restartDelay * 2, MAX_BACKOFF_MS);
    log.warn('Radio: stream dropped, retrying', { station, seconds: delay / 1000 });
    restartTimer = setTimeout(() => {
      restartTimer = null;
      syncRadio();
    }, delay);
  });
  player.on('error', (error) => log.warn('Radio: playback error', { error: error.message }));
  return player;
}

export function ffmpegArgs(url: string, { volume = 100, bitrateKbps = 128, seek = 0 } = {}): string[] {
  const gain = Math.min(Math.max(volume, 0), 200) / 100;
  const live = /^https?:/.test(url);
  return [
    '-hide_banner', '-loglevel', 'error',
    // Kurze Aussetzer des Streams überbrückt ffmpeg selbst; 15 s ohne Daten gilt
    // als tot. Für eine heruntergeladene Datei gibt es diese Optionen nicht.
    ...(live ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-rw_timeout', '15000000'] : []),
    // Bei einer Datei an die Stelle springen, an der es weitergehen soll.
    ...(!live && seek > 0 ? ['-ss', seek.toFixed(1)] : []),
    '-i', url,
    '-vn',
    // Die Lautstärke regelt ffmpeg vor dem Kodieren. Node müsste dafür Opus
    // erst dekodieren und neu kodieren, das kostet ein Vielfaches an CPU.
    ...(gain === 1 ? [] : ['-af', `volume=${gain.toFixed(2)}`]),
    // Discord erwartet Opus mit 48 kHz Stereo. ffmpeg kodiert gleich selbst,
    // Node muss die Ogg-Pakete dann nur noch auspacken.
    '-c:a', 'libopus', '-b:a', `${bitrateKbps}k`, '-ar', '48000', '-ac', '2',
    '-f', 'ogg', 'pipe:1',
  ];
}

/**
 * So viel, wie der Kanal hergibt (Boost-Stufe 3: 384 kbit/s), aber nie weniger
 * als RULES.minBitrateKbps. Über 510 kbit/s kann Opus nicht.
 */
export function streamBitrate(channel: Pick<VoiceChannel, 'bitrate'>): number {
  return Math.min(Math.max(Math.round(channel.bitrate / 1000), RULES.minBitrateKbps), 510);
}

function startStream(station: Station, bitrateKbps: number): void {
  startSource(station.key, station.url, station.name, bitrateKbps);
}

/**
 * Ein Song geht nach einer Unterbrechung dort weiter, wo er war: neue
 * Lautstärke oder Bitrate, oder alle waren kurz aus dem Kanal.
 */
function startTrack(track: Track, bitrateKbps: number): void {
  // Lädt er noch, liest ffmpeg über eine Leitung, die auf den Rest der Datei wartet.
  const input = track.status === 'partial' ? followFile(track.file!, () => downloadState(track)) : track.file!;
  startSource(`track:${track.id}`, input, track.title, bitrateKbps, track.resumeAt ?? 0);
}

/** Radio (URL), Wunsch (Datei) oder ein Song, der noch lädt (Stream): ffmpeg starten und an den Player hängen. */
function startSource(key: string, input: string | Readable, label: string, bitrateKbps: number, seek = 0): void {
  stopStream();
  const piped = typeof input !== 'string';
  const child = spawn('ffmpeg', ffmpegArgs(piped ? 'pipe:0' : input, { volume: getState().volume, bitrateKbps, seek: piped ? 0 : seek }),
    { stdio: [piped ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  if (piped) {
    feed = input;
    // Endet ffmpeg vorher (Überspringen), bricht das Schreiben ab; das ist kein Fehler.
    child.stdin?.on('error', () => {});
    input.on('error', (error) => log.warn('Radio: could not read the download', { source: key, error: String(error) }));
    input.pipe(child.stdin!);
  }
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-500);
  });
  child.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' && !ffmpegMissingReported) {
      ffmpegMissingReported = true;
      void alert('Radio: ffmpeg is not installed', {}, error);
    }
  });
  child.on('close', (code) => {
    if (child.killed) return;
    if (code !== 0) log.warn('Radio: ffmpeg exited', { source: key, code, stderr: stderr.trim() || undefined });
  });

  ffmpeg = child;
  playing = key;
  playingSince = Date.now();
  playingFrom = seek;
  resource = createAudioResource(child.stdout!, { inputType: StreamType.OggOpus });
  audioPlayer().play(resource);
  client?.user?.setActivity(label, { type: ActivityType.Listening });
  changed();
  log.info('Radio: streaming', { source: key, kbps: bitrateKbps, volume: getState().volume });
}

/** Wie weit der laufende Wunsch gerade ist, in Sekunden. */
function trackPosition(): number {
  return playingFrom + (Date.now() - playingSince) / 1000;
}

function stopStream(): void {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  // Für ein Weiterspielen an derselben Stelle merken.
  const current = playingTrack();
  if (current) current.resumeAt = trackPosition();
  const wasPlaying = playing !== null;
  playing = null;
  resource = null;
  feed?.destroy();
  feed = null;
  if (ffmpeg && ffmpeg.exitCode === null) ffmpeg.kill();
  ffmpeg = null;
  player?.stop(true);
  if (wasPlaying) {
    client?.user?.setPresence({ activities: [] });
    changed();
  }
}

// ============================================================ Songtitel

/**
 * Icecast schickt den Titel eingebettet in den Audiostrom: nach je
 * `icy-metaint` Bytes Audio ein Längenbyte (×16) und dann `StreamTitle='…';`.
 */
export function parseIcyTitle(data: Buffer, metaint: number): string | null {
  if (data.length <= metaint) return null;
  const length = data[metaint] * 16;
  const block = data.subarray(metaint + 1, metaint + 1 + length).toString('utf8');
  const title = /StreamTitle='(.*?)';/s.exec(block)?.[1]?.trim();
  return title || null;
}

/** Holt nur den ersten Metadatenblock, wenige Kilobyte, und bricht dann ab. */
export async function fetchStreamTitle(url: string, timeoutMs = 5_000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { 'Icy-MetaData': '1' }, signal: controller.signal });
    const metaint = Number(response.headers.get('icy-metaint'));
    if (!response.ok || !response.body || !Number.isInteger(metaint) || metaint <= 0) return null;
    const reader = response.body.getReader();
    let data = Buffer.alloc(0);
    let needed = metaint + 1;
    while (data.length < needed) {
      const { value, done } = await reader.read();
      if (done) break;
      data = Buffer.concat([data, Buffer.from(value)]);
      if (data.length > metaint) needed = metaint + 1 + data[metaint] * 16;
    }
    await reader.cancel().catch(() => {});
    return parseIcyTitle(data, metaint);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

// ============================================================ Lebenszyklus

/** Der Client, über den Kanal und Mitglieder gelesen werden. Tests reichen einen nachgebauten. */
export function attachClient(value: Client): void {
  client = value;
}

/** Nach dem Ready-Event: in den Kanal gehen und loslegen. */
export function startRadio(ready: Client): void {
  attachClient(ready);
  resetCache();
  started = true;
  syncRadio();
}

/** Beim Herunterfahren: Stream beenden und den Kanal sauber verlassen. */
export function stopRadio(): void {
  started = false;
  if (vote) clearTimeout(vote.timer);
  vote = null;
  leave();
  // Heruntergeladene Wünsche und Playlist-Songs nicht liegen lassen.
  clearQueue();
  clearPlaylist();
}

/** Neue Bitrate im Radio-Kanal: Ein laufender Stream übernimmt sie sofort. */
export function handleRadioChannelUpdate(oldChannel: { id: string; bitrate?: number }, newChannel: { id: string; bitrate?: number }): void {
  if (newChannel.id !== target.channelId || oldChannel.bitrate === newChannel.bitrate || !playing) return;
  log.info('Radio: channel bitrate changed', { kbps: (newChannel.bitrate ?? 0) / 1000 });
  stopStream();
  syncRadio();
  changed();
}

/** Jede Änderung im Radio-Kanal oder am Bot selbst. */
export function handleRadioVoiceState(oldState: VoiceState, newState: VoiceState): void {
  const id = target.channelId;
  const self = (newState.member ?? oldState.member)?.id === client?.user?.id;
  if (!self && oldState.channelId !== id && newState.channelId !== id) return;
  syncRadio();
  changed();
  if (vote) void reviewVote(vote).catch((error) =>
    alert('Radio: could not recount the vote', {}, error));
}
