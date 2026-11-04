import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { env } from './env.js';
import { log } from './logger.js';
import { RULES } from './settings.js';
import { t } from './texts.js';

/**
 * Warteschlange für Wünsche von YouTube und SoundCloud. yt-dlp liest Titel und
 * Länge und lädt die Tonspur vorab herunter; gespielt wird die fertige Datei.
 * Das ist verlässlicher als direktes Streamen: keine ablaufenden Stream-URLs,
 * keine Abbrüche mitten im Song. Die Schlange lebt nur im Arbeitsspeicher.
 *
 * Daneben höchstens eine Playlist: Sie spielt, wenn keine Wünsche anstehen,
 * und erst wenn sie durch ist, kommt wieder das Radio. Geladen werden nur der
 * laufende Song und der nächste, nicht die ganze Liste auf einmal. Ein
 * YouTube-Mix („Radio“, list=RD…) hat kein Ende: Bevor er ausgeht, kommt ein
 * neuer Mix ab dem letzten Song dazu.
 *
 * Ein YouTube-Song (WebM) kann schon laufen, während er noch lädt: Über den
 * Proxy dauert der Download länger als das Abrufen, aber viel kürzer als der Song.
 */

export type Track = {
  id: string;
  source: string;
  title: string;
  /** Sekunden */
  duration: number;
  url: string;
  requesterId: string;
  /** Vorschaubild von YouTube oder SoundCloud fürs Panel. */
  thumbnail: string | null;
  file: string | null;
  /** `partial`: Die Datei wächst noch, abspielbar von vorn. */
  status: 'loading' | 'partial' | 'ready';
  /** Sekunden, an denen es nach einer Unterbrechung weitergeht. */
  resumeAt?: number;
  /** Gesetzt, wenn der Song aus einer Playlist kommt. */
  playlistId?: string;
  /** Stelle in der Playlist, ab 0. */
  entryIndex?: number;
};
export type TrackInfo = { title: string; duration: number; isLive: boolean; source: string; url: string; thumbnail: string | null };
export type WishError = 'link' | 'full' | 'limit' | 'live' | 'long' | 'failed';
export type WishResult = { track: Track; position: number } | { error: WishError; detail?: string };

/** Ein Eintrag aus der Playlist, noch nicht heruntergeladen. SoundCloud nennt den Titel erst beim Download. */
export type PlaylistEntry = { id: string | null; url: string; title: string | null; duration: number; thumbnail: string | null };
export type PlaylistInfo = { title: string; source: string; url: string; entries: PlaylistEntry[] };
/** Was Panel und Befehle über die laufende Playlist wissen müssen. */
export type PlaylistView = {
  id: string;
  title: string;
  url: string;
  requesterId: string;
  /** Stelle des aktuellen Songs, ab 1. */
  position: number;
  total: number;
  /** YouTube-Mix: läuft, bis jemand ihn überspringt. */
  endless: boolean;
};
export type PlaylistError = 'link' | 'running' | 'empty' | 'failed';
export type PlaylistResult = { playlist: PlaylistView; count: number } | { error: PlaylistError; detail?: string };

type Playlist = Omit<PlaylistView, 'position'> & {
  source: string;
  team: boolean;
  entries: PlaylistEntry[];
  /** Der aktuelle Song und der nächste, fertig oder im Download. */
  buffer: Track[];
  /** Der nächste Eintrag, der in den Puffer kommt. */
  nextEntry: number;
  /** Downloads, die nacheinander gescheitert sind. */
  failures: number;
  /** Schon in der Liste, damit ein nachgeladener Mix nichts doppelt bringt. */
  seen: Set<string>;
  extending: boolean;
  extendFailures: number;
};

const HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be',
  'soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com', 'on.soundcloud.com',
]);

const queue: Track[] = [];
let list: Playlist | null = null;
let nextId = 1;
let pumping = false;
const listeners = new Set<(event?: string) => void>();

/** Einträge einer SoundCloud-Playlist zeigen manchmal auf die API statt auf die Seite. */
const ENTRY_HOSTS = new Set([...HOSTS, 'api.soundcloud.com', 'api-v2.soundcloud.com']);

/** Nur YouTube und SoundCloud: yt-dlp soll keine beliebigen Seiten abrufen. */
export function supportedLink(input: string, hosts: ReadonlySet<string> = HOSTS): URL | null {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return hosts.has(url.hostname.toLowerCase()) ? url : null;
  } catch {
    return null;
  }
}

/**
 * Zeigt der Link eindeutig auf eine Playlist? `…/playlist?list=…` und
 * SoundCloud-Sets ja. Ein Video aus einer Playlist (`watch?v=…&list=…`) bleibt
 * ein einzelner Wunsch; als Playlist geht es über den Playlist-Befehl.
 */
export function isPlaylistLink(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (host.endsWith('soundcloud.com')) return /^\/[^/]+\/sets\/[^/]+/.test(url.pathname);
  // „Radio starten“ auf YouTube: gemeint ist der Mix, nicht nur der erste Song.
  if (url.searchParams.has('list') && url.searchParams.get('start_radio') === '1') return true;
  if (host === 'youtu.be') return false;
  return url.searchParams.has('list') && !url.searchParams.has('v');
}

/** YouTube-Mix („Radio“): Die Liste beginnt mit RD und hat kein festes Ende. */
export function isMixLink(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return !host.endsWith('soundcloud.com') && (url.searchParams.get('list') ?? '').startsWith('RD');
}

/** radio.ts hört zu; `event` landet als letzte Änderung im Panel. */
export function onQueueChange(listener: (event?: string) => void): void {
  listeners.add(listener);
}

function changed(event?: string): void {
  for (const listener of listeners) listener(event);
}

export function tracks(): readonly Track[] {
  return queue;
}

export function head(): Track | undefined {
  return queue[0];
}

/** Die laufende Playlist, oder null. */
export function playlist(): PlaylistView | null {
  if (!list) return null;
  const { id, title, url, requesterId, total, endless } = list;
  return { id, title, url, requesterId, total, endless, position: (list.buffer[0]?.entryIndex ?? list.nextEntry) + 1 };
}

/** Der Song der Playlist, der als Nächstes dran ist oder gerade läuft. */
export function playlistHead(): Track | undefined {
  return list?.buffer[0];
}

// ================================================================= yt-dlp

/** `signal` bricht einen Download ab, den niemand mehr braucht. */
type Runner = (args: string[], timeoutMs: number, signal?: AbortSignal) => Promise<string>;
let run: Runner = runYtDlp;

/** Für Tests: yt-dlp durch eine Attrappe ersetzen. */
export function useRunner(runner: Runner): void {
  run = runner;
}

let cookieFile: string | undefined;

/**
 * yt-dlp schreibt die Cookies nach jedem Lauf zurück. Die Vorlage kann schreibgeschützt
 * sein (Kubernetes-Secret), deshalb arbeitet es auf einer Kopie, die beim Start entsteht.
 */
function cookieArgs(): string[] {
  if (!env.ytDlpCookies) return [];
  if (!cookieFile) {
    cookieFile = join(tmpdir(), `deskradio-cookies-${process.pid}.txt`);
    copyFileSync(env.ytDlpCookies, cookieFile);
  }
  return ['--cookies', cookieFile];
}

function runYtDlp(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((done, fail) => {
    // Node als JavaScript-Laufzeit: YouTube verlangt inzwischen, dass yt-dlp
    // ein Skript ausführt, bevor es die Tonspur herausgibt.
    let extra: string[];
    try {
      extra = [...cookieArgs(), ...(env.ytDlpProxy ? ['--proxy', env.ytDlpProxy] : [])];
    } catch (error) {
      fail(new Error(`cookie file not readable: ${(error as Error).message}`));
      return;
    }
    const child = spawn(env.ytDlp, ['--no-warnings', '--js-runtimes', 'node', ...extra, ...args],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { err = (err + chunk.toString()).slice(-2000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const stop = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', stop, { once: true });
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      fail(new Error(error.code === 'ENOENT' ? 'yt-dlp is not installed' : error.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      if (code === 0) done(out);
      else fail(new Error(ytDlpError(err) ?? `yt-dlp exited with code ${code}`));
    });
  });
}

/** „ERROR: [youtube] abc: Private video“ → „Private video“ */
export function ytDlpError(stderr: string): string | null {
  const line = stderr.split('\n').reverse().find((entry) => entry.startsWith('ERROR:'));
  return line ? line.replace(/^ERROR:\s*(\[[^\]]+\]\s*[^:]+:\s*)?/, '').trim() : null;
}

export async function probe(url: string): Promise<TrackInfo> {
  const json = JSON.parse(await run(['--no-playlist', '--dump-single-json', '--', url], 45_000)) as Record<string, unknown>;
  return {
    title: typeof json.title === 'string' ? json.title : url,
    duration: Math.round(Number(json.duration) || 0),
    isLive: json.is_live === true || json.live_status === 'is_live',
    source: typeof json.extractor_key === 'string' ? json.extractor_key : 'Link',
    url: typeof json.webpage_url === 'string' ? json.webpage_url : url,
    thumbnail: typeof json.thumbnail === 'string' && json.thumbnail.startsWith('https://') ? json.thumbnail : null,
  };
}

export class NotAPlaylist extends Error {}

/**
 * Nur das Inhaltsverzeichnis (`--flat-playlist`): ein paar Anfragen statt
 * eine pro Song. Private, gelöschte und Livestreams fliegen gleich raus.
 */
export async function probePlaylist(url: string, limit = RULES.playlistMax): Promise<PlaylistInfo> {
  const json = JSON.parse(await run(['--yes-playlist', '--flat-playlist', '--playlist-end', String(limit),
    '--dump-single-json', '--', url], 120_000)) as Record<string, unknown>;
  if (json._type !== 'playlist' || !Array.isArray(json.entries)) throw new NotAPlaylist('not a playlist');
  return {
    title: typeof json.title === 'string' && json.title.trim() ? json.title.trim() : 'Playlist',
    source: typeof json.extractor_key === 'string' ? json.extractor_key.replace(/(Tab|Set|Playlist)$/, '') : 'Link',
    url: typeof json.webpage_url === 'string' ? json.webpage_url : url,
    entries: json.entries.map((raw) => playlistEntry(raw as Record<string, unknown>)).filter((entry) => entry !== null),
  };
}

export function playlistEntry(raw: Record<string, unknown> | null): PlaylistEntry | null {
  if (!raw) return null;
  const id = typeof raw.id === 'string' ? raw.id : null;
  const youtube = raw.ie_key === 'Youtube';
  const url = typeof raw.url === 'string' ? raw.url : youtube && id ? `https://www.youtube.com/watch?v=${id}` : null;
  if (!url || !supportedLink(url, ENTRY_HOSTS)) return null;
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : null;
  if (title && /^\[(private|deleted) video\]$/i.test(title)) return null;
  if (raw.is_live === true || raw.live_status === 'is_live' || raw.live_status === 'is_upcoming') return null;
  const thumbnails = Array.isArray(raw.thumbnails) ? raw.thumbnails as Array<{ url?: unknown }> : [];
  const last = thumbnails.at(-1)?.url;
  const thumbnail = youtube && id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
    : typeof last === 'string' && last.startsWith('https://') ? last : null;
  return { id, url, title, duration: Math.round(Number(raw.duration) || 0), thumbnail };
}

// ================================================================= Wünsche

function roomFor(requesterId: string, team: boolean): WishError | null {
  if (queue.length >= RULES.queueMax) return 'full';
  if (!team && queue.filter((track) => track.requesterId === requesterId).length >= RULES.wishesPerPerson) return 'limit';
  return null;
}

/**
 * `announce` liefert den Hinweis fürs Panel. Er wird im selben Moment gesetzt,
 * in dem der Titel eingereiht wird: Schlägt der Download danach schnell fehl,
 * überschreibt der Wunsch-Hinweis die Fehlermeldung nicht mehr.
 */
export async function addWish(link: string, requesterId: string, team: boolean,
  announce?: (track: Track) => string): Promise<WishResult> {
  const url = supportedLink(link);
  if (!url) return { error: 'link' };
  const early = roomFor(requesterId, team);
  if (early) return { error: early };

  let info: TrackInfo;
  try {
    info = await probe(url.href);
  } catch (error) {
    return { error: 'failed', detail: error instanceof Error ? error.message : String(error) };
  }
  // Ohne Länge ist es meist ein Livestream.
  if (info.isLive || info.duration <= 0) return { error: 'live' };
  // Das Team darf auch lange Mixe wünschen.
  if (!team && info.duration > RULES.maxTrackMinutes * 60) return { error: 'long' };
  // Während des Abrufs kann die Schlange voll geworden sein.
  const late = roomFor(requesterId, team);
  if (late) return { error: late };

  const track: Track = {
    id: `w${nextId++}`, source: info.source, title: info.title, duration: info.duration,
    url: info.url, requesterId, thumbnail: info.thumbnail, file: null, status: 'loading',
  };
  queue.push(track);
  changed(announce?.(track));
  void pump();
  return { track, position: queue.indexOf(track) + 1 };
}

/** Der erste Titel ist gelaufen oder übersprungen: weg damit samt Datei. */
export function finishHead(event?: string): Track | undefined {
  const done = queue.shift();
  removeFile(done);
  changed(event);
  void pump();
  return done;
}

export function clearQueue(event?: string): number {
  const count = queue.length;
  for (const track of queue.splice(0)) removeFile(track);
  changed(event);
  return count;
}

// ================================================================ Playlist

/**
 * Lädt das Inhaltsverzeichnis und startet die Playlist. Läuft schon eine,
 * ersetzt nur das Team sie. Ohne Team-Rechte gelten die Grenzen der Wünsche
 * pro Song: zu lange Titel werden ausgelassen.
 */
export async function addPlaylist(link: string, requesterId: string, team: boolean,
  options: { shuffle?: boolean; announce?: (playlist: PlaylistView, count: number) => string } = {}): Promise<PlaylistResult> {
  const url = supportedLink(link);
  if (!url) return { error: 'link' };
  if (list && !team) return { error: 'running' };

  // Einen Mix nur anlesen: YouTube gibt ihn in kleinen Stücken heraus, 500 Einträge dauern über eine halbe Minute.
  const mix = isMixLink(url);
  let info: PlaylistInfo;
  try {
    info = await probePlaylist(url.href, mix ? RULES.mixBatch : RULES.playlistMax);
  } catch (error) {
    if (error instanceof NotAPlaylist) return { error: 'link' };
    return { error: 'failed', detail: error instanceof Error ? error.message : String(error) };
  }
  let entries = allowed(unique(info.entries), team);
  // Ein Video aus der Playlist im Link: dort anfangen.
  const start = entries.findIndex((entry) => entry.id !== null && entry.id === url.searchParams.get('v'));
  if (start > 0) entries = entries.slice(start);
  if (options.shuffle) entries = shuffled(entries);
  if (entries.length === 0) return { error: 'empty' };
  // Während des Abrufs kann jemand anderes eine Playlist gestartet haben.
  if (list && !team) return { error: 'running' };

  dropPlaylist();
  list = {
    id: `p${nextId++}`, title: info.title, url: info.url, source: info.source, requesterId, team,
    entries, total: entries.length, buffer: [], nextEntry: 0, failures: 0,
    endless: mix, seen: new Set(info.entries.map(entryKey)), extending: false, extendFailures: 0,
  };
  fillBuffer(list);
  const view = playlist()!;
  changed(options.announce?.(view, entries.length));
  void pump();
  return { playlist: view, count: entries.length };
}

function entryKey(entry: PlaylistEntry): string {
  return entry.id ?? entry.url;
}

/** Ein Mix wiederholt Songs; jeder Song nur einmal. */
export function unique(entries: readonly PlaylistEntry[]): PlaylistEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => !seen.has(entryKey(entry)) && Boolean(seen.add(entryKey(entry))));
}

/** Ohne Team-Rechte gilt die Längengrenze der Wünsche, soweit die Länge schon bekannt ist. */
function allowed(entries: PlaylistEntry[], team: boolean): PlaylistEntry[] {
  return team ? entries : entries.filter((entry) => entry.duration <= RULES.maxTrackMinutes * 60);
}

/**
 * Den Mix verlängern: ein neuer Mix ab dem letzten Song, ohne Songs, die schon
 * dran waren. Kommt nichts Neues oder scheitert es dreimal, endet er normal.
 */
async function extendMix(p: Playlist): Promise<void> {
  const seed = p.entries.at(-1)?.id;
  if (p.extending || !p.endless) return;
  if (!seed) {
    p.endless = false;
    return;
  }
  p.extending = true;
  try {
    const info = await probePlaylist(`https://www.youtube.com/watch?v=${seed}&list=RD${seed}`, RULES.mixBatch);
    if (list !== p) return;
    const fresh = allowed(unique(info.entries).filter((entry) => !p.seen.has(entryKey(entry))), p.team);
    for (const entry of info.entries) p.seen.add(entryKey(entry));
    p.entries.push(...fresh);
    p.total = p.entries.length;
    p.extendFailures = 0;
    if (fresh.length === 0) p.endless = false;
    log.info('Queue: mix extended', { title: p.title, added: fresh.length, total: p.total });
    fillBuffer(p);
    changed();
    void pump();
  } catch (error) {
    log.warn('Queue: could not extend the mix', { title: p.title, error: String(error) });
    if (++p.extendFailures >= 3) p.endless = false;
  } finally {
    p.extending = false;
  }
}

/** Fisher-Yates, damit jede Reihenfolge gleich wahrscheinlich ist. */
export function shuffled<T>(items: readonly T[], random = Math.random): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Aktueller Song plus einer im Voraus, damit es ohne Pause weitergeht. Ein Mix lädt rechtzeitig nach. */
function fillBuffer(p: Playlist): void {
  while (p.buffer.length < 2 && p.nextEntry < p.entries.length) {
    const entry = p.entries[p.nextEntry];
    p.buffer.push({
      id: `p${nextId++}`, source: p.source, title: entry.title ?? `${p.title} #${p.nextEntry + 1}`,
      duration: entry.duration, url: entry.url, requesterId: p.requesterId, thumbnail: entry.thumbnail,
      file: null, status: 'loading', playlistId: p.id, entryIndex: p.nextEntry,
    });
    p.nextEntry++;
  }
  if (p.endless && p.entries.length - p.nextEntry <= RULES.mixRefill) void extendMix(p);
}

/**
 * Der aktuelle Song der Playlist ist gelaufen oder übersprungen. War es der
 * letzte, ist die Playlist vorbei und das Radio kommt zurück.
 */
export function finishPlaylistTrack(event?: string): Track | undefined {
  const p = list;
  if (!p) return undefined;
  const done = p.buffer.shift();
  removeFile(done);
  fillBuffer(p);
  if (p.buffer.length === 0) {
    list = null;
    changed(event ?? t('event_playlist_done', { title: p.title }));
    return done;
  }
  changed(event);
  void pump();
  return done;
}

/** Die ganze Playlist überspringen. */
export function clearPlaylist(event?: string): PlaylistView | null {
  const view = playlist();
  if (!view) return null;
  dropPlaylist();
  changed(event);
  return view;
}

function dropPlaylist(): void {
  for (const track of list?.buffer ?? []) removeFile(track);
  list = null;
}

function removeFile(track: Track | undefined): void {
  if (track?.file) rmSync(track.file, { force: true });
}

/** Alles, was der Download eines Titels hinterlassen hat, auch eine halbe Datei. */
function removeDownload(track: Track): void {
  removeFile(track);
  try {
    for (const name of readdirSync(cacheDir())) {
      if (name.startsWith(`${track.id}.`)) rmSync(join(cacheDir(), name), { force: true });
    }
  } catch {
    // Kein Cache-Ordner: nichts aufzuräumen.
  }
}

function cacheDir(): string {
  return resolve(env.cacheDir);
}

/** Beim Start: Reste früherer Läufe löschen. */
export function resetCache(): void {
  rmSync(cacheDir(), { recursive: true, force: true });
  mkdirSync(cacheDir(), { recursive: true });
}

/** yt-dlp meldet nach dem Download Pfad und Angaben als JSON in der letzten Zeile. */
export type Download = { file: string; title: string | null; duration: number; thumbnail: string | null };

export function parseDownload(out: string): Download | null {
  const line = out.trim().split('\n').at(-1) ?? '';
  if (!line) return null;
  try {
    const json = JSON.parse(line) as Record<string, unknown>;
    if (typeof json.filepath !== 'string' || !json.filepath) return null;
    return {
      file: json.filepath,
      title: typeof json.title === 'string' && json.title.trim() ? json.title.trim() : null,
      duration: Math.round(Number(json.duration) || 0),
      thumbnail: typeof json.thumbnail === 'string' && json.thumbnail.startsWith('https://') ? json.thumbnail : null,
    };
  } catch {
    return null;
  }
}

/**
 * Ab wann ein wachsender Download abgespielt wird, und wie oft nachgesehen wird.
 * `minRate` (Bytes pro Sekunde): Ein Song braucht beim Abspielen rund 20 KB/s.
 * Lädt er nicht deutlich schneller (ein langsamer Proxy-Ausgang), holt die
 * Wiedergabe den Download ein; dann erst spielen, wenn er ganz da ist.
 * Für Tests veränderbar.
 */
export const PARTIAL = { bytes: 256 * 1024, pollMs: 500, minRate: 48 * 1024 };

/** Eine Messung der wachsenden Datei: wann, wie groß. */
export type Sample = { at: number; size: number };

/** Genug da, und der Download wächst schnell genug, dass die Wiedergabe ihn nicht einholt. */
export function playableWhileLoading(first: Sample, now: Sample): boolean {
  if (now.size < PARTIAL.bytes) return false;
  const seconds = (now.at - first.at) / 1000;
  // Schon bei der ersten Messung genug da: schneller geht es kaum.
  if (seconds <= 0) return true;
  return (now.size - first.size) / seconds >= PARTIAL.minRate;
}

/**
 * Wie es um den Download eines Titels steht, für den Leser, der die wachsende
 * Datei abspielt: `gone` heißt gescheitert oder verworfen.
 */
export function downloadState(track: Track): 'growing' | 'done' | 'gone' {
  if (!stillWanted(track)) return 'gone';
  return track.status === 'ready' ? 'done' : 'growing';
}

/**
 * Liest eine Datei, die noch geschrieben wird: Am Ende wartet er auf mehr,
 * bis `state` meldet, dass der Download fertig (oder weg) ist.
 */
export function followFile(path: string, state: () => 'growing' | 'done' | 'gone', pollMs = 200): Readable {
  let handle: FileHandle | null = null;
  let position = 0;
  return new Readable({
    async read(size) {
      try {
        handle ??= await open(path, 'r');
        while (!this.destroyed) {
          // Erst fragen, dann lesen: Ist der Download vorher fertig und kommt nichts mehr, ist es das Ende.
          const finished = state() !== 'growing';
          const buffer = Buffer.alloc(Math.max(size, 64 * 1024));
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
          if (bytesRead > 0) {
            position += bytesRead;
            this.push(buffer.subarray(0, bytesRead));
            return;
          }
          if (finished) {
            this.push(null);
            return;
          }
          await sleep(pollMs);
        }
      } catch (error) {
        this.destroy(error as Error);
      }
    },
    destroy(error, callback) {
      const closing = handle?.close() ?? Promise.resolve();
      handle = null;
      closing.catch(() => {}).finally(() => callback(error));
    },
  });
}

/** Erst die Wünsche, dann die Playlist. */
function nextToLoad(): Track | undefined {
  return queue.find((track) => track.status === 'loading') ?? list?.buffer.find((track) => track.status === 'loading');
}

export function stillWanted(track: Track): boolean {
  return queue.includes(track) || Boolean(list?.buffer.includes(track));
}

/** Lädt die Titel der Reihe nach herunter, einer nach dem anderen. */
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const next = nextToLoad();
      if (!next) break;
      const owner = next.playlistId ? list : null;
      // Übersprungen oder verworfen, während er noch lädt: Download abbrechen, damit der nächste gleich drankommt.
      const abort = new AbortController();
      try {
        mkdirSync(cacheDir(), { recursive: true });
        // Drei Minuten plus Zeit für lange Titel: Ein Stunden-Mix braucht länger.
        // Ohne bekannte Länge (SoundCloud-Playlists) mit Luft für eine halbe Stunde.
        const timeoutMs = 180_000 + (next.duration || 1800) * 200;
        // Playlist-Songs sind nicht einzeln geprüft: keine Livestreams, ohne Team nichts zu Langes.
        const filter = owner ? ['--match-filter', owner.team ? '!is_live' : `!is_live & duration <=? ${RULES.maxTrackMinutes * 60}`] : [];
        // Ohne .part-Datei: Sobald genug WebM da ist, kann der Song schon laufen.
        const growing = join(cacheDir(), `${next.id}.webm`);
        let first: Sample | null = null;
        const watch = setInterval(() => {
          if (!stillWanted(next)) {
            abort.abort();
            return;
          }
          if (next.status !== 'loading') return;
          let sample: Sample;
          try {
            sample = { at: Date.now(), size: statSync(growing).size };
          } catch {
            return;
          }
          first ??= sample;
          if (!playableWhileLoading(first, sample)) return;
          next.file = growing;
          next.status = 'partial';
          log.info('Queue: playing while downloading', {
            title: next.title, kbPerSecond: Math.round((sample.size - first.size) / Math.max(sample.at - first.at, 1)),
          });
          changed();
        }, PARTIAL.pollMs);
        let out: string;
        try {
          out = await run(['--no-playlist', ...filter, '-f', 'bestaudio/best', '--no-progress', '--quiet', '--no-part',
            '-o', join(cacheDir(), `${next.id}.%(ext)s`),
            '--print', 'after_move:%(.{filepath,title,duration,thumbnail})j', '--', next.url], timeoutMs, abort.signal);
        } finally {
          clearInterval(watch);
        }
        const download = parseDownload(out);
        // Kein Pfad heißt: vom Filter ausgelassen.
        if (!download) throw new Error(owner ? 'skipped by filter (live or too long)' : 'no file');
        if (!stillWanted(next)) {
          rmSync(download.file, { force: true });
          continue;
        }
        next.file = download.file;
        next.status = 'ready';
        // SoundCloud nennt Titel und Länge einer Playlist erst hier.
        if (next.playlistId) {
          if (download.title) next.title = download.title;
          if (download.duration) next.duration = download.duration;
          next.thumbnail ??= download.thumbnail;
          if (owner) owner.failures = 0;
        }
        changed();
      } catch (error) {
        if (abort.signal.aborted || !stillWanted(next)) {
          removeDownload(next);
          log.info('Queue: download dropped', { title: next.title });
          continue;
        }
        log.warn('Queue: could not load track', { title: next.title, error: String(error) });
        // Aus einer inzwischen ersetzten Playlist: nichts zu melden.
        if (next.playlistId) {
          if (owner && owner === list) playlistTrackFailed(owner, next);
        } else {
          const index = queue.indexOf(next);
          if (index !== -1) queue.splice(index, 1);
          changed(t('event_wish_failed', { title: next.title }));
        }
      }
    }
  } finally {
    pumping = false;
  }
}

/**
 * Ein Song der Playlist lässt sich nicht laden: auslassen und den nächsten
 * holen. Scheitern mehrere hintereinander, stimmt etwas Grundsätzliches nicht
 * (etwa YouTube sperrt), dann endet die Playlist, statt sie durchzuprobieren.
 */
function playlistTrackFailed(p: Playlist, track: Track): void {
  const index = p.buffer.indexOf(track);
  if (index === -1) return;
  p.buffer.splice(index, 1);
  p.failures++;
  if (p.failures >= RULES.playlistMaxFailures) {
    dropPlaylist();
    changed(t('event_playlist_broken', { title: p.title }));
    return;
  }
  fillBuffer(p);
  if (p.buffer.length === 0) {
    list = null;
    changed(t('event_playlist_done', { title: p.title }));
    return;
  }
  changed(t('event_wish_failed', { title: track.title }));
}
