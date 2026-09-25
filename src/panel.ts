import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  RESTJSONErrorCodes,
  Routes,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
  type Client,
  type Message,
  type VoiceChannel,
} from 'discord.js';
import { env } from './env.js';
import { log } from './logger.js';
import { fetchStreamTitle, onRadioChange, radioSnapshot, type RadioSnapshot } from './radio.js';
import { STATIONS, stationGenre } from './settings.js';
import { t } from './texts.js';

/**
 * Das Radio-Panel: eine Nachricht im Chat des Sprachkanals mit Sender, Song,
 * Zuhörenden und einem Dropdown zum Wählen. Abstimmungen laufen darin, statt
 * den Chat mit eigenen Nachrichten zu füllen. Schreiben Leute im Chat, rückt
 * das Panel nach einer Pause wieder nach unten. Den Song zeigt zusätzlich der
 * Kanalstatus unter dem Kanalnamen.
 */

export const PANEL_TITLE = `📻 ${env.name}`;
export const REPO_URL = 'https://github.com/enricofranke/deskradio';
/** Klein unten im Panel, auch wenn RADIO_NAME einen eigenen Namen setzt. */
export const CREDIT = `-# [Deskradio](${REPO_URL}) · by Enrico Franke`;
const TITLE_POLL_MS = 30_000;
const REFRESH_DEBOUNCE_MS = 1_500;
const STICKY_QUIET_MS = 20_000;
const HISTORY_SIZE = 3;

let client: Client | null = null;
let channel: VoiceChannel | null = null;
let panel: Message | null = null;
let lastRendered = '';
let refreshTimer: NodeJS.Timeout | null = null;
let stickyTimer: NodeJS.Timeout | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let busy: Promise<void> = Promise.resolve();

let stationKey: string | null = null;
let title: string | null = null;
let cover: string | null = null;
let history: string[] = [];
const covers = new Map<string, string | null>();
let lastStatus: string | null = null;
let statusDenied = false;

// ================================================================ Anzeige

/** 3:07 */
export function formatDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

const SHOWN_UPCOMING = 5;

/**
 * Bilder: bei einem Wunsch das Vorschaubild groß, beim Radio das Album-Cover
 * des Songs klein rechts, sonst das Profilbild des Bots.
 */
export type PanelArt = { cover?: string | null; avatar?: string | null };

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Oben groß, was läuft; darunter eine Zeile dazu und die letzte Änderung.
 * Warteschlange und Abstimmung stehen in eigenen Blöcken, der Zählstand auf
 * den Buttons, Zuhörende und Klang klein in der Fußzeile.
 */
export function renderPanel(s: RadioSnapshot, song: string | null, recent: string[], art: PanelArt = {}) {
  const on = s.enabled && Boolean(s.station);
  const embed = new EmbedBuilder().setColor(s.vote ? 0x5865f2 : 0xe67e22);
  const lines: string[] = [];
  if (!on || !s.station) {
    embed.setAuthor({ name: PANEL_TITLE }).setTitle(t('panel_off'));
  } else if (s.track) {
    embed.setAuthor({ name: t('panel_author_wish', { name: env.name }) }).setTitle(clip(`▶️ ${s.track.title}`, 256));
    if (s.track.url.startsWith('https://')) embed.setURL(s.track.url);
    lines.push(t('panel_track_meta', {
      user: `<@${s.track.requesterId}>`, duration: formatDuration(s.track.duration), source: s.track.source,
    }));
  } else {
    embed.setAuthor({ name: PANEL_TITLE }).setTitle(clip(`📻 ${s.station.name}`, 256));
    lines.push(s.playing ? (song ? `🎵 ${escapeMarkdown(song)}` : t('panel_playing')) : t('panel_idle'));
    if (recent.length > 0) lines.push(`-# ${t('panel_recent', { titles: recent.map((entry) => escapeMarkdown(entry)).join(' · ') })}`);
  }
  if (s.lastEvent) lines.push(`-# ${s.lastEvent.text} · <t:${Math.floor(s.lastEvent.at / 1000)}:R>`);

  const fields: { name: string; value: string }[] = [];
  if (on && s.station && (s.track || s.upcoming.length > 0)) {
    const items = s.upcoming.slice(0, SHOWN_UPCOMING).map((track, index) => t('panel_next_item', {
      position: index + 1, title: escapeMarkdown(clip(track.title, 80)), duration: formatDuration(track.duration),
      user: `<@${track.requesterId}>`, loading: track.status === 'loading' ? t('panel_loading') : '',
    }));
    if (s.upcoming.length > SHOWN_UPCOMING) items.push(t('panel_next_more', { count: s.upcoming.length - SHOWN_UPCOMING }));
    items.push(t('panel_after', { station: s.station.name }));
    fields.push({ name: t('panel_next'), value: items.join('\n') });
  }
  if (s.vote) {
    fields.push({
      name: clip(t(s.vote.kind === 'skip' ? 'panel_vote_skip' : 'panel_vote_station', { title: s.vote.label, station: s.vote.label }), 256),
      value: t('panel_vote_value', { starter: `<@${s.vote.starterId}>`, end: `<t:${Math.ceil(s.vote.endsAt / 1000)}:R>` }),
    });
  }
  // Der Credit steht ganz unten über der Fußzeile: im letzten Feld, sonst in der Beschreibung.
  const last = fields.at(-1);
  if (last) last.value = `${clip(last.value, 1023 - CREDIT.length)}\n${CREDIT}`;
  else lines.push(CREDIT);
  if (lines.length > 0) embed.setDescription(clip(lines.join('\n'), 4000));
  if (fields.length > 0) embed.addFields(fields);
  if (on) {
    const stats = t('panel_stats', { listeners: s.listeners, volume: s.volume, kbps: s.bitrateKbps });
    embed.setFooter({ text: s.vote ? `${stats} · ${t('panel_rule')}` : stats });
  }
  if (on && s.track?.thumbnail) embed.setImage(s.track.thumbnail);
  else if (on && s.playing && art.cover) embed.setThumbnail(art.cover);
  else if (art.avatar) embed.setThumbnail(art.avatar);

  const select = new StringSelectMenuBuilder().setCustomId('radio:pick').setPlaceholder(t('panel_pick'))
    .setDisabled(!s.enabled)
    .addOptions(STATIONS.map((station) => ({
      label: station.name,
      value: station.key,
      default: station.key === s.station?.key,
      description: station.key === s.station?.key ? t('panel_current', { genre: stationGenre(station) }) : stationGenre(station),
    })));
  const actions = new ActionRowBuilder<ButtonBuilder>();
  if (env.wishes) {
    actions.addComponents(new ButtonBuilder().setCustomId('radio:wish').setLabel(t('panel_wish')).setEmoji('🎵')
      .setStyle(ButtonStyle.Primary).setDisabled(!s.enabled));
  }
  if (s.track) {
    actions.addComponents(new ButtonBuilder().setCustomId('radio:skip').setLabel(t('panel_skip')).setEmoji('⏭️')
      .setStyle(ButtonStyle.Secondary));
  }
  const components: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
  ];
  // Eine leere Zeile nimmt Discord nicht an.
  if (actions.components.length > 0) components.push(actions);
  if (s.vote) {
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`radio:yes:${s.vote.id}`).setLabel(t('vote_yes', { count: s.vote.tally.yes }))
        .setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`radio:no:${s.vote.id}`).setLabel(t('vote_no', { count: s.vote.tally.no }))
        .setEmoji('❌').setStyle(ButtonStyle.Secondary),
    ));
  }
  return { embeds: [embed], components, allowedMentions: { parse: [] as never[] } };
}

/** Das Formular hinter dem Wunsch-Button. */
export function wishModal(): ModalBuilder {
  return new ModalBuilder().setCustomId('radio:wish').setTitle(t('wish_modal_title')).addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId('link').setLabel(t('wish_modal_label')).setStyle(TextInputStyle.Short)
        .setPlaceholder('https://www.youtube.com/watch?v=…').setRequired(true).setMaxLength(300),
    ),
  );
}

/** Kurz genug für den Kanalstatus; leer, wenn das Radio aus ist. */
export function statusText(s: RadioSnapshot, song: string | null): string {
  if (!s.enabled || !s.station) return '';
  const text = s.track ? `▶️ ${s.track.title}` : s.playing && song ? `📻 ${s.station.name} – ${song}` : `📻 ${s.station.name}`;
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

// ============================================================== Nachricht

/** Änderungen sammeln: Beitritte, Klicks und Songwechsel kommen oft in Schüben. */
export function schedulePanelRefresh(delay = REFRESH_DEBOUNCE_MS): void {
  if (!channel) return;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void queue(refresh);
  }, delay);
}

/**
 * Neu zeichnen, auch wenn sich nichts geändert hat: Nach einer Auswahl im
 * Dropdown zeigt Discord sonst weiter die Wahl statt des laufenden Senders.
 */
export function resetPanelSelection(): void {
  lastRendered = '';
  schedulePanelRefresh(0);
}

/** Sofort aktualisieren, ohne Wartezeit. Für Tests und das Herunterfahren. */
export async function flushPanel(): Promise<void> {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  await queue(refresh);
}

export function panelMessage(): Message | null {
  return panel;
}

/** Nacheinander, damit ein Neupost nicht mit einer Bearbeitung kollidiert. */
function queue(task: () => Promise<void>): Promise<void> {
  busy = busy.then(task).catch((error) => log.warn('Radio panel: error', { error: String(error) }));
  return busy;
}

async function refresh(): Promise<void> {
  if (!channel) return;
  const snapshot = radioSnapshot();
  trackStation(snapshot);
  const payload = renderPanel(snapshot, title, history, panelArt());
  const rendered = JSON.stringify({ e: payload.embeds.map((e) => e.toJSON()), c: payload.components.map((c) => c.toJSON()) });
  await updateStatus(snapshot);
  if (panel && rendered === lastRendered) return;
  lastRendered = rendered;
  if (panel) {
    try {
      await panel.edit(payload);
      return;
    } catch (error) {
      // Von Hand gelöscht: einfach neu posten.
      if ((error as { code?: unknown }).code !== RESTJSONErrorCodes.UnknownMessage) throw error;
    }
  }
  panel = await channel.send(payload);
}

/** Das Panel wieder ans Ende des Chats holen, das alte verschwindet. */
async function repost(): Promise<void> {
  if (!channel) return;
  if (panel && channel.lastMessageId === panel.id) return;
  const old = panel;
  panel = await channel.send(renderPanel(radioSnapshot(), title, history, panelArt()));
  await old?.delete().catch(() => {});
}

/** Jede fremde Nachricht im Kanal-Chat: nach einer ruhigen Pause nach unten rücken. */
export function handlePanelMessage(message: Message): void {
  if (!channel || message.channelId !== channel.id || message.author.id === client?.user?.id) return;
  if (stickyTimer) clearTimeout(stickyTimer);
  stickyTimer = setTimeout(() => {
    stickyTimer = null;
    void queue(repost);
  }, STICKY_QUIET_MS);
}

// ============================================================ Songtitel

function trackStation(s: RadioSnapshot): void {
  const key = s.station?.key ?? null;
  if (key === stationKey) return;
  stationKey = key;
  title = null;
  cover = null;
  history = [];
  // Der neue Stream braucht ein, zwei Sekunden bis zum ersten Titel.
  if (s.playing) setTimeout(() => void pollTitle(), 3_000);
}

async function pollTitle(): Promise<void> {
  const s = radioSnapshot();
  if (!s.playing || !s.station) return;
  const key = s.station.key;
  const next = await fetchStreamTitle(s.station.url);
  if (!next || key !== stationKey || next === title) return;
  if (title) history = [title, ...history.filter((entry) => entry !== title)].slice(0, HISTORY_SIZE);
  title = next;
  cover = null;
  schedulePanelRefresh(0);
  const found = await findCover(next);
  if (title !== next) return;
  cover = found;
  if (found) schedulePanelRefresh(0);
}

function panelArt(): PanelArt {
  return { cover, avatar: client?.user?.avatarURL({ size: 256 }) ?? null };
}

// ================================================================ Cover

/** „Cartoon, Jéja - On & On (feat. Daniel Levi) [NCS Release]“ → ohne Klammern. */
export function coverSearchTerm(song: string): string {
  return song.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Aus der Antwort der iTunes-Suche das Cover in 600×600. */
export function coverFromItunes(response: unknown): string | null {
  const result = (response as { results?: Array<{ artworkUrl100?: string }> })?.results?.[0];
  const url = result?.artworkUrl100;
  return typeof url === 'string' && url.startsWith('https://') ? url.replace(/\/\d+x\d+bb\./, '/600x600bb.') : null;
}

/**
 * Album-Cover zum laufenden Radio-Song aus der freien iTunes-Suche. Pro Titel
 * nur eine Anfrage; ohne Treffer oder bei Fehlern bleibt es beim Profilbild.
 */
async function findCover(song: string): Promise<string | null> {
  if (covers.has(song)) return covers.get(song) ?? null;
  let found: string | null = null;
  try {
    const term = encodeURIComponent(coverSearchTerm(song));
    const response = await fetch(`https://itunes.apple.com/search?media=music&entity=song&limit=1&term=${term}`,
      { signal: AbortSignal.timeout(5_000) });
    if (response.ok) found = coverFromItunes(await response.json());
  } catch {
    // Kein Cover ist kein Fehler.
  }
  if (covers.size > 200) covers.clear();
  covers.set(song, found);
  return found;
}

// ============================================================ Kanalstatus

/**
 * Der Text unter dem Kanalnamen. Braucht die Berechtigung „Status des
 * Sprachkanals festlegen“; fehlt sie, einmal ins Log und dann Ruhe.
 */
async function updateStatus(s: RadioSnapshot): Promise<void> {
  if (!client || !channel || statusDenied) return;
  const status = statusText(s, title);
  if (status === lastStatus) return;
  try {
    await client.rest.put(Routes.channelVoiceStatus(channel.id), { body: { status } });
    lastStatus = status;
  } catch (error) {
    if ((error as { code?: unknown }).code === RESTJSONErrorCodes.MissingPermissions) {
      statusDenied = true;
      log.warn('Radio: not allowed to set the channel status. The "Set Voice Channel Status" permission is missing.');
      return;
    }
    log.warn('Radio: could not set the channel status', { error: String(error) });
  }
}

// ============================================================ Lebenszyklus

/**
 * Alte Panels und Abstimmungen früherer Läufe wegräumen und ein frisches
 * posten. Angefasst werden nur eigene Nachrichten.
 */
export async function startPanel(ready: Client, target: VoiceChannel): Promise<void> {
  client = ready;
  channel = target;
  const recent = await target.messages.fetch({ limit: 50 }).catch(() => null);
  for (const message of recent?.values() ?? []) {
    if (message.author.id !== ready.user?.id) continue;
    const heading = message.embeds[0]?.title ?? '';
    const author = message.embeds[0]?.author?.name ?? '';
    // Am Dropdown erkennt man ein Panel auch dann, wenn RADIO_NAME sich geändert hat.
    const withPicker = message.components.some((row) => 'components' in row &&
      (row.components as Array<{ customId?: string | null }>).some((component) => component.customId === 'radio:pick'));
    const leftover = withPicker || author.startsWith(PANEL_TITLE) || heading === PANEL_TITLE;
    if (leftover) await message.delete().catch(() => {});
  }
  onRadioChange(() => schedulePanelRefresh());
  pollTimer = setInterval(() => void pollTitle(), TITLE_POLL_MS);
  await flushPanel();
  void pollTitle();
}

/** Für Tests: Kanal und Client setzen, ohne aufzuräumen oder zu pollen. */
export function attachPanel(ready: Client, target: VoiceChannel): void {
  client = ready;
  channel = target;
}

export async function stopPanel(): Promise<void> {
  for (const timer of [refreshTimer, stickyTimer]) if (timer) clearTimeout(timer);
  if (pollTimer) clearInterval(pollTimer);
  refreshTimer = stickyTimer = pollTimer = null;
  // Ohne Bot im Kanal wäre der Status veraltet.
  if (client && channel && lastStatus) {
    await client.rest.put(Routes.channelVoiceStatus(channel.id), { body: { status: '' } }).catch(() => {});
  }
}
