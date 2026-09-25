// Writes the bot token from the clipboard into .env without printing it.
//
//   Developer Portal: Bot → Reset Token → Copy, then
//   npm run token
//
// With --wait it waits up to 10 minutes for a token to show up in the
// clipboard, so it doesn't matter whether you copy the command or the token first.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

function clipboard() {
  for (const [command, args] of [['wl-paste', ['-n']], ['pbpaste', []], ['xclip', ['-o', '-selection', 'clipboard']]]) {
    try {
      return execFileSync(command, args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {
      // try the next tool
    }
  }
  return '';
}

// Bot tokens are three base64 parts separated by dots.
const looksLikeToken = (value) => /^[\w-]{20,}\.[\w-]{4,}\.[\w-]{20,}$/.test(value);
let token = clipboard();
if (!looksLikeToken(token) && process.argv.includes('--wait')) {
  console.log('Waiting up to 10 minutes for the token in the clipboard …');
  for (let waited = 0; waited < 600 && !looksLikeToken(token); waited++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    token = clipboard();
  }
}
if (!looksLikeToken(token)) {
  console.error('There is no bot token in the clipboard.');
  console.error('Developer Portal: Bot → Reset Token → Copy, then type the command (don\'t copy it).');
  process.exit(1);
}

const file = new URL('../.env', import.meta.url);
if (!existsSync(file)) copyFileSync(new URL('../.env.example', import.meta.url), file);
const content = readFileSync(file, 'utf8');
const line = `RADIO_BOT_TOKEN=${token}`;
writeFileSync(file, /^RADIO_BOT_TOKEN=.*$/m.test(content)
  ? content.replace(/^RADIO_BOT_TOKEN=.*$/m, () => line)
  : `${line}\n${content}`);
console.log(`Token saved (${token.length} characters). Next: npm run dev`);
