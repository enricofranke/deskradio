import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { env } from './env.js';
import { log } from './logger.js';
import { RULES } from './settings.js';
import { t } from './texts.js';

/**
 * Warteschlange für Wünsche von YouTube und SoundCloud. yt-dlp liest Titel und
 * Länge und lädt die Tonspur vorab herunter; gespielt wird die fertige Datei.
 * Das ist verlässlicher als direktes Streamen: keine ablaufenden Stream-URLs,
 * keine Abbrüche mitten im Song. Die Schlange lebt nur im Arbeitsspeicher.
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
  status: 'loading' | 'ready';
  /** Sekunden, an denen es nach einer Unterbrechung weitergeht. */
  resumeAt?: number;
};
export type TrackInfo = { title: string; duration: number; isLive: boolean; source: string; url: string; thumbnail: string | null };
export type WishError = 'link' | 'full' | 'limit' | 'live' | 'long' | 'failed';
export type WishResult = { track: Track; position: number } | { error: WishError; detail?: string };

const HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be',
  'soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com', 'on.soundcloud.com',
]);

const queue: Track[] = [];
let nextId = 1;
let pumping = false;
const listeners = new Set<(event?: string) => void>();

/** Nur YouTube und SoundCloud: yt-dlp soll keine beliebigen Seiten abrufen. */
export function supportedLink(input: string): URL | null {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return HOSTS.has(url.hostname.toLowerCase()) ? url : null;
  } catch {
    return null;
  }
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

// ================================================================= yt-dlp

type Runner = (args: string[], timeoutMs: number) => Promise<string>;
let run: Runner = runYtDlp;

/** Für Tests: yt-dlp durch eine Attrappe ersetzen. */
export function useRunner(runner: Runner): void {
  run = runner;
}

function runYtDlp(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((done, fail) => {
    // Node als JavaScript-Laufzeit: YouTube verlangt inzwischen, dass yt-dlp
    // ein Skript ausführt, bevor es die Tonspur herausgibt.
    const child = spawn(env.ytDlp, ['--no-playlist', '--no-warnings', '--js-runtimes', 'node', ...args],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { err = (err + chunk.toString()).slice(-2000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      fail(new Error(error.code === 'ENOENT' ? 'yt-dlp is not installed' : error.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
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
  const json = JSON.parse(await run(['--dump-single-json', '--', url], 45_000)) as Record<string, unknown>;
  return {
    title: typeof json.title === 'string' ? json.title : url,
    duration: Math.round(Number(json.duration) || 0),
    isLive: json.is_live === true || json.live_status === 'is_live',
    source: typeof json.extractor_key === 'string' ? json.extractor_key : 'Link',
    url: typeof json.webpage_url === 'string' ? json.webpage_url : url,
    thumbnail: typeof json.thumbnail === 'string' && json.thumbnail.startsWith('https://') ? json.thumbnail : null,
  };
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

function removeFile(track: Track | undefined): void {
  if (track?.file) rmSync(track.file, { force: true });
}

function cacheDir(): string {
  return resolve(env.cacheDir);
}

/** Beim Start: Reste früherer Läufe löschen. */
export function resetCache(): void {
  rmSync(cacheDir(), { recursive: true, force: true });
  mkdirSync(cacheDir(), { recursive: true });
}

/** Lädt die Titel der Reihe nach herunter, einer nach dem anderen. */
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const next = queue.find((track) => track.status === 'loading');
      if (!next) break;
      try {
        mkdirSync(cacheDir(), { recursive: true });
        // Drei Minuten plus Zeit für lange Titel: Ein Stunden-Mix braucht länger.
        const timeoutMs = 180_000 + next.duration * 200;
        const out = await run(['-f', 'bestaudio/best', '--no-progress', '--quiet',
          '-o', join(cacheDir(), `${next.id}.%(ext)s`), '--print', 'after_move:filepath', '--', next.url], timeoutMs);
        const file = out.trim().split('\n').at(-1) ?? '';
        if (!queue.includes(next)) {
          rmSync(file, { force: true });
          continue;
        }
        next.file = file;
        next.status = 'ready';
        changed();
      } catch (error) {
        log.warn('Queue: could not load track', { title: next.title, error: String(error) });
        const index = queue.indexOf(next);
        if (index !== -1) queue.splice(index, 1);
        changed(t('event_wish_failed', { title: next.title }));
      }
    }
  } finally {
    pumping = false;
  }
}
