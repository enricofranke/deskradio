import { SlashCommandBuilder } from 'discord.js';

/**
 * Ein Befehl für alle. Team-Rechte prüft radio.ts, da Discord Rechte nur für
 * den ganzen Befehl ausblenden kann. Namen und Beschreibungen sind englisch,
 * Discord zeigt sie auf Deutsch, wenn der Client auf Deutsch steht.
 */
export function radioCommand({ wishes = true } = {}) {
  const command = new SlashCommandBuilder().setName('radio')
    .setDescription('Radio in the voice channel: show and switch stations')
    .setDescriptionLocalizations({ de: 'Radio im Sprachkanal: Sender anzeigen und wechseln' })
    .addSubcommand((sub) => sub.setName('station').setNameLocalizations({ de: 'sender' })
      .setDescription('Switches the station: the team instantly, everyone else by vote')
      .setDescriptionLocalizations({ de: 'Wechselt den Sender: das Team sofort, alle anderen per Abstimmung im Kanal' })
      .addStringOption((option) => option.setName('station').setNameLocalizations({ de: 'sender' })
        .setDescription('Which station?').setDescriptionLocalizations({ de: 'Welcher Sender?' })
        .setRequired(true).setAutocomplete(true)))
    .addSubcommand((sub) => sub.setName('now').setNameLocalizations({ de: 'jetzt' })
      .setDescription('Shows the station and the current song')
      .setDescriptionLocalizations({ de: 'Zeigt Sender und laufenden Song' }))
    .addSubcommand((sub) => sub.setName('volume').setNameLocalizations({ de: 'lautstärke' })
      .setDescription('Shows the volume; the team can change it')
      .setDescriptionLocalizations({ de: 'Zeigt die Lautstärke; das Team kann sie einstellen' })
      .addIntegerOption((option) => option.setName('percent').setNameLocalizations({ de: 'prozent' })
        .setDescription('New volume in percent of the original (team only)')
        .setDescriptionLocalizations({ de: 'Neue Lautstärke in Prozent des Originals (nur Team)' })
        .setMinValue(1).setMaxValue(100)));

  if (wishes) {
    command
      .addSubcommand((sub) => sub.setName('request').setNameLocalizations({ de: 'wunsch' })
        .setDescription('Requests a song from YouTube or SoundCloud')
        .setDescriptionLocalizations({ de: 'Wünscht einen Song von YouTube oder SoundCloud' })
        .addStringOption((option) => option.setName('link')
          .setDescription('Link to YouTube or SoundCloud').setDescriptionLocalizations({ de: 'Link zu YouTube oder SoundCloud' })
          .setRequired(true).setMaxLength(300)))
      .addSubcommand((sub) => sub.setName('playlist')
        .setDescription('Plays a YouTube or SoundCloud playlist, then the radio comes back')
        .setDescriptionLocalizations({ de: 'Spielt eine YouTube- oder SoundCloud-Playlist, danach kommt wieder das Radio' })
        .addStringOption((option) => option.setName('link')
          .setDescription('Link to the playlist').setDescriptionLocalizations({ de: 'Link zur Playlist' })
          .setRequired(true).setMaxLength(300))
        .addBooleanOption((option) => option.setName('shuffle').setNameLocalizations({ de: 'zufällig' })
          .setDescription('Shuffle the songs').setDescriptionLocalizations({ de: 'Songs in zufälliger Reihenfolge' })))
      .addSubcommand((sub) => sub.setName('skip')
        .setDescription('Skips the current request or playlist song: team and requester instantly, otherwise by vote')
        .setDescriptionLocalizations({ de: 'Überspringt den laufenden Wunsch oder Playlist-Song: Team und Wünschende sofort, sonst Abstimmung' }))
      .addSubcommand((sub) => sub.setName('playlist-skip').setNameLocalizations({ de: 'playlist-überspringen' })
        .setDescription('Skips the whole playlist: team and whoever started it instantly, otherwise by vote')
        .setDescriptionLocalizations({ de: 'Überspringt die ganze Playlist: Team und wer sie gestartet hat sofort, sonst Abstimmung' }))
      .addSubcommand((sub) => sub.setName('clear').setNameLocalizations({ de: 'leeren' })
        .setDescription('Clears the queue (team only)')
        .setDescriptionLocalizations({ de: 'Leert die Warteschlange (nur Team)' }));
  }

  return command
    .addSubcommand((sub) => sub.setName('off').setNameLocalizations({ de: 'aus' })
      .setDescription('Turns the radio off (team only)').setDescriptionLocalizations({ de: 'Schaltet das Radio aus (nur Team)' }))
    .addSubcommand((sub) => sub.setName('on').setNameLocalizations({ de: 'an' })
      .setDescription('Turns the radio back on (team only)').setDescriptionLocalizations({ de: 'Schaltet das Radio wieder an (nur Team)' }))
    .toJSON();
}
