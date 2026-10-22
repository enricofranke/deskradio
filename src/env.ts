import 'dotenv/config';

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : undefined;
}

function required(name: string): string {
  const value = optional(name);
  if (!value) throw new Error(`Environment variable ${name} is missing. Set it in .env (template: .env.example).`);
  return value;
}

/** Aus, wenn ausdrücklich abgeschaltet; alles andere gilt als an. */
function flag(name: string, fallback: boolean): boolean {
  const value = optional(name)?.toLowerCase();
  if (value === undefined) return fallback;
  return !['0', 'false', 'off', 'no', 'nein', 'aus'].includes(value);
}

export type Language = 'en' | 'de';

/** Nur Betriebsparameter. Sender und Abstimmungsregeln stehen in settings.ts. */
export const env = {
  token: required('RADIO_BOT_TOKEN'),
  guildId: optional('RADIO_GUILD_ID'),
  channelId: optional('RADIO_CHANNEL_ID'),
  teamRoles: (optional('RADIO_TEAM_ROLES') ?? '').split(',').map((id) => id.trim()).filter(Boolean),
  errorChannelId: optional('RADIO_ERROR_CHANNEL_ID'),
  /** Name im Panel. Der Name des Bots selbst kommt aus dem Developer Portal. */
  name: optional('RADIO_NAME') ?? 'Deskradio',
  /** Sprache von Panel und Antworten; die Befehle zeigt Discord in der Sprache der Nutzer. */
  language: (optional('RADIO_LANGUAGE')?.toLowerCase().startsWith('de') ? 'de' : 'en') as Language,
  /** Wünsche von YouTube und SoundCloud über yt-dlp. */
  wishes: flag('RADIO_WISHES', true),
  stateFile: optional('RADIO_STATE_FILE') ?? 'data/state.json',
  /** Heruntergeladene Wünsche; wird bei jedem Start geleert. */
  cacheDir: optional('RADIO_CACHE_DIR') ?? 'data/cache',
  ytDlp: optional('RADIO_YTDLP') ?? 'yt-dlp',
  /** Cookie-Datei (Netscape-Format) für YouTube, wenn es die Server-IP für einen Bot hält. */
  ytDlpCookies: optional('RADIO_YTDLP_COOKIES'),
  /** Proxy für yt-dlp, z. B. http://user:pass@host:port oder socks5://host:port. */
  ytDlpProxy: optional('RADIO_YTDLP_PROXY'),
  healthPort: Number(optional('HEALTH_PORT') ?? 0),
  logLevel: (optional('LOG_LEVEL') ?? 'info') as 'debug' | 'info' | 'warn' | 'error',
  isProduction: optional('NODE_ENV') === 'production',
};
