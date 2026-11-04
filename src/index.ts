import { createServer, type Server } from 'node:http';
import { ChannelType, Client, Events, GatewayIntentBits, MessageFlags, PermissionsBitField, RESTJSONErrorCodes, type Guild } from 'discord.js';
import { env } from './env.js';
import { errorContext, log } from './logger.js';
import { radioCommand } from './commands.js';
import { handlePanelMessage, playlistModal, resetPanelSelection, startPanel, stopPanel, wishModal } from './panel.js';
import { loadState, target } from './settings.js';
import { t } from './texts.js';
import {
  handleRadioButton,
  handleRadioChannelUpdate,
  handleRadioCommand,
  handleRadioVoiceState,
  handleWishChoice,
  radioAutocomplete,
  requestPlaylist,
  requestPlaylistSkip,
  requestSkip,
  requestStation,
  requestWish,
  startRadio,
  stopRadio,
} from './radio.js';

// GuildMessages nur, um zu merken, dass im Kanal-Chat geschrieben wird (Panel rückt
// nach unten). Den Inhalt braucht der Bot nicht, daher kein MessageContent.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessages],
});

function inviteLink(clientId: string): string {
  const permissions = new PermissionsBitField([
    'ViewChannel', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory', 'Connect', 'Speak', 'SetVoiceChannelStatus',
  ]).bitfield;
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot%20applications.commands&permissions=${permissions}`;
}

/**
 * Ohne RADIO_GUILD_ID der einzige Server, auf dem der Bot ist, und nur, wenn
 * er klein ist: Landet der Bot aus Versehen auf einem großen Server, soll er
 * dort nicht einfach loslegen.
 */
function pickGuild(ready: Client<true>): Guild | string {
  if (env.guildId) return ready.guilds.cache.get(env.guildId) ?? `The bot is not on server ${env.guildId}.`;
  const guilds = [...ready.guilds.cache.values()];
  if (guilds.length === 0) return 'The bot is not on any server yet. Invite it with the link below.';
  if (guilds.length > 1) return `The bot is on several servers (${guilds.map((g) => `${g.name} ${g.id}`).join(', ')}). Set RADIO_GUILD_ID.`;
  if (guilds[0].memberCount > 10) return `"${guilds[0].name}" has ${guilds[0].memberCount} members. For a real server, set RADIO_GUILD_ID on purpose.`;
  return guilds[0];
}

client.once(Events.ClientReady, async (ready) => {
  try {
    const guild = pickGuild(ready);
    if (typeof guild === 'string') {
      log.error(guild, { invite: inviteLink(ready.user.id) });
      await shutdown(1);
      return;
    }
    const channel = env.channelId
      ? guild.channels.cache.get(env.channelId)
      : guild.channels.cache.find((c) => c.type === ChannelType.GuildVoice);
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      log.error('No voice channel found. Set RADIO_CHANNEL_ID.', { server: guild.name });
      await shutdown(1);
      return;
    }
    target.guildId = guild.id;
    target.channelId = channel.id;

    loadState();
    await guild.commands.set([radioCommand({ wishes: env.wishes })]);
    startRadio(ready);
    await startPanel(ready, channel);
    log.info(`${env.name} is ready`, { user: ready.user.tag, server: guild.name, channel: channel.name, language: env.language, wishes: env.wishes });
  } catch (error) {
    log.error('Startup failed', errorContext(error));
    await shutdown(1);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.guildId !== target.guildId) return;
  if (interaction.isAutocomplete()) {
    if (interaction.commandName === 'radio') await radioAutocomplete(interaction, String(interaction.options.getFocused())).catch(() => {});
    return;
  }
  if (!interaction.isChatInputCommand() && !interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) return;
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'radio') await handleRadioCommand(interaction);
    if (interaction.isStringSelectMenu() && interaction.customId === 'radio:pick') {
      await requestStation(interaction, interaction.values[0]);
      resetPanelSelection();
    }
    if (interaction.isButton() && interaction.customId === 'radio:wish') await interaction.showModal(wishModal());
    else if (interaction.isButton() && interaction.customId === 'radio:playlist') await interaction.showModal(playlistModal());
    else if (interaction.isButton() && interaction.customId === 'radio:skip') await requestSkip(interaction);
    else if (interaction.isButton() && interaction.customId === 'radio:playlist-skip') await requestPlaylistSkip(interaction);
    else if (interaction.isButton() && interaction.customId.startsWith('radio:wish-')) {
      // „Sofort“ oder „Warteschlange“ auf die Frage nach einem Team-Wunsch.
      const [, choice, id] = interaction.customId.split(':');
      await handleWishChoice(interaction, choice === 'wish-now', id);
    } else if (interaction.isButton() && interaction.customId.startsWith('radio:')) {
      const [, action, id] = interaction.customId.split(':');
      await handleRadioButton(interaction, action, id);
    }
    if (interaction.isModalSubmit() && interaction.customId === 'radio:wish') {
      await requestWish(interaction, interaction.fields.getTextInputValue('link'));
    }
    if (interaction.isModalSubmit() && interaction.customId === 'radio:playlist') {
      await requestPlaylist(interaction, interaction.fields.getTextInputValue('link'));
    }
  } catch (error) {
    // Abgelaufen oder doppelt geklickt: Eine Antwort käme ohnehin nicht mehr an.
    const code = (error as { code?: unknown }).code;
    if (code === RESTJSONErrorCodes.UnknownInteraction || code === RESTJSONErrorCodes.InteractionHasAlreadyBeenAcknowledged) return;
    log.error('Command failed', { user: interaction.user.id, ...errorContext(error) });
    const reply = { content: t('error'), flags: MessageFlags.Ephemeral } as const;
    if (interaction.deferred || interaction.replied) await interaction.editReply({ content: reply.content }).catch(() => {});
    else await interaction.reply(reply).catch(() => {});
  }
});

client.on(Events.MessageCreate, (message) => {
  if (message.guildId === target.guildId) handlePanelMessage(message);
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  if ((newState.guild ?? oldState.guild).id === target.guildId) handleRadioVoiceState(oldState, newState);
});

client.on(Events.ChannelUpdate, (oldChannel, newChannel) => {
  if (!('guildId' in newChannel) || newChannel.guildId !== target.guildId) return;
  handleRadioChannelUpdate(oldChannel as { id: string; bitrate?: number }, newChannel as { id: string; bitrate?: number });
});

client.on(Events.Error, (error) => log.error('Discord client error', errorContext(error)));
process.on('unhandledRejection', (reason) => log.error('Unhandled promise rejection', errorContext(reason)));

// Für Kubernetes: /health ist gesund, solange die Gateway-Verbindung steht.
let health: Server | null = null;
if (env.healthPort > 0) {
  health = createServer((request, response) => {
    const ok = request.url === '/health' && client.isReady();
    response.writeHead(ok ? 200 : 503, { 'content-type': 'text/plain' }).end(ok ? 'ok' : 'not ready');
  }).listen(env.healthPort);
}

async function shutdown(code = 0): Promise<void> {
  await stopPanel();
  stopRadio();
  health?.close();
  await client.destroy().catch(() => {});
  process.exit(code);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await client.login(env.token);
