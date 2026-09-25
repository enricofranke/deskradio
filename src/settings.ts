import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { env, type Language } from './env.js';
import { log } from './logger.js';

/** Genre für das Dropdown im Panel, in beiden Sprachen; kbps ist die Bitrate der Quelle. */
export type Station = { key: string; name: string; url: string; genre: Record<Language, string>; kbps: number };

/**
 * Alle Sender liefern MP3 mit Songtitel im Stream (Icecast). Die ersten zehn
 * bringt cliamp mit (128 kbit/s). Höchstens 25, mehr fasst das Dropdown nicht.
 */
export const STATIONS: Station[] = [
  { key: 'lofi', name: 'Lofi', genre: { en: 'Chill', de: 'Chill' }, kbps: 128, url: 'https://radio.cliamp.stream/lofi/stream' },
  { key: 'synthwave', name: 'Synthwave', genre: { en: 'Retro electro', de: 'Retro-Elektro' }, kbps: 128, url: 'https://radio.cliamp.stream/synthwave/stream' },
  { key: 'edm', name: 'EDM', genre: { en: 'Electronic', de: 'Elektro' }, kbps: 128, url: 'https://radio.cliamp.stream/edm/stream' },
  { key: 'omarchy', name: 'Omarchy Radio', genre: { en: 'Mixed', de: 'Gemischt' }, kbps: 128, url: 'https://radio.cliamp.stream/omarchy/stream' },
  { key: 'ncs', name: 'NCS', genre: { en: 'Electronic', de: 'Elektro' }, kbps: 128, url: 'https://radio.cliamp.stream/ncs/stream' },
  { key: 'ncs-house', name: 'NCS House', genre: { en: 'House', de: 'House' }, kbps: 128, url: 'https://radio.cliamp.stream/ncs-house/stream' },
  { key: 'ncs-dubstep', name: 'NCS Dubstep', genre: { en: 'Dubstep', de: 'Dubstep' }, kbps: 128, url: 'https://radio.cliamp.stream/ncs-dubstep/stream' },
  { key: 'ncs-dnb', name: 'NCS Drum & Bass', genre: { en: 'Drum & Bass', de: 'Drum & Bass' }, kbps: 128, url: 'https://radio.cliamp.stream/ncs-dnb/stream' },
  { key: 'ncs-trap', name: 'NCS Trap', genre: { en: 'Trap', de: 'Trap' }, kbps: 128, url: 'https://radio.cliamp.stream/ncs-trap/stream' },
  { key: 'ncs-phonk', name: 'NCS Phonk', genre: { en: 'Phonk', de: 'Phonk' }, kbps: 128, url: 'https://radio.cliamp.stream/ncs-phonk/stream' },
  { key: 'soma-groovesalad', name: 'SomaFM Groove Salad', genre: { en: 'Chill, ambient beats', de: 'Chill, Ambient-Beats' }, kbps: 256, url: 'https://ice1.somafm.com/groovesalad-256-mp3' },
  { key: 'soma-deepspace', name: 'SomaFM Deep Space One', genre: { en: 'Ambient, space', de: 'Ambient, Space' }, kbps: 128, url: 'https://ice1.somafm.com/deepspaceone-128-mp3' },
  { key: 'soma-defcon', name: 'SomaFM DEF CON Radio', genre: { en: 'Electronic for coding', de: 'Elektro zum Coden' }, kbps: 256, url: 'https://ice1.somafm.com/defcon-256-mp3' },
  { key: 'ilove-deutschrap', name: 'I♥ Deutschrap', genre: { en: 'German rap', de: 'Deutschrap' }, kbps: 192, url: 'https://streams.ilovemusic.de/iloveradio6.mp3' },
  { key: 'ilove-hiphop', name: 'I♥ Hip Hop', genre: { en: 'Hip-hop', de: 'Hip-Hop' }, kbps: 192, url: 'https://streams.ilovemusic.de/iloveradio3.mp3' },
  { key: 'bigfm-deutschrap', name: 'bigFM Deutschrap', genre: { en: 'German rap', de: 'Deutschrap' }, kbps: 128, url: 'https://streams.bigfm.de/bigfm-deutschrap-128-mp3' },
  { key: 'ilove-radio', name: 'I♥ Radio', genre: { en: 'Hits & charts', de: 'Hits & Charts' }, kbps: 192, url: 'https://streams.ilovemusic.de/iloveradio1.mp3' },
  { key: '1live', name: '1LIVE', genre: { en: 'Hits & pop', de: 'Hits & Pop' }, kbps: 128, url: 'https://wdr-1live-live.icecastssl.wdr.de/wdr/1live/live/mp3/128/stream.mp3' },
];

/** „Chill · 128 kbit/s“ */
export function stationGenre(station: Station, language: Language = env.language): string {
  return `${station.genre[language]} · ${station.kbps} kbit/s`;
}

export const RULES = {
  voteSeconds: 60,
  /** Pause nach jeder Abstimmung und nach einem Wechsel durch das Team. */
  voteCooldownMinutes: 3,
  /**
   * Der Bot sendet mit der Bitrate des Kanals (Boost-Stufe 3: bis 384 kbit/s),
   * aber nie mit weniger. Die Quelle liefert 128 kbit/s.
   */
  minBitrateKbps: 128,
  /** Wünsche: höchstens so lang und so viele pro Person (beides nicht fürs Team), so viele insgesamt. */
  maxTrackMinutes: 10,
  wishesPerPerson: 2,
  queueMax: 20,
  skipVoteSeconds: 30,
  /** Pause nach einer Abstimmung zum Überspringen. */
  skipCooldownSeconds: 30,
};

/** Server und Kanal stehen erst nach dem Login fest (index.ts). */
export const target = { guildId: env.guildId ?? '', channelId: env.channelId ?? '' };

export type State = { enabled: boolean; station: string; volume: number };
/** Erster Start: Lofi, leise im Hintergrund. Danach gilt, was zuletzt eingestellt war. */
const DEFAULT_STATE: State = { enabled: true, station: 'lofi', volume: 10 };

let state: State = { ...DEFAULT_STATE };
let writeWarned = false;

/**
 * Was Team und Abstimmungen ändern, übersteht einen Neustart in einer kleinen
 * JSON-Datei. Fehlt sie oder ist sie kaputt, gelten die Standardwerte.
 */
export function loadState(file = env.stateFile): State {
  try {
    const stored = JSON.parse(readFileSync(file, 'utf8')) as Partial<State>;
    state = { ...DEFAULT_STATE, ...stored };
  } catch {
    state = { ...DEFAULT_STATE };
  }
  return state;
}

export function getState(): Readonly<State> {
  return state;
}

/** Im Speicher sofort, auf der Platte atomar. Ohne Schreibrecht läuft es weiter. */
export function updateState(patch: Partial<State>, file = env.stateFile): void {
  state = { ...state, ...patch };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2));
    renameSync(`${file}.tmp`, file);
  } catch (error) {
    if (!writeWarned) log.warn('Could not save state, it only lasts until the next restart', { file, error: String(error) });
    writeWarned = true;
  }
}
