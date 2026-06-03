const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const fs = require('fs');
const path = require('path');

// โหลดไฟล์ config
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// โหลดคำสั่งจากโฟลเดอร์ commands
client.commands = new Map();
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  client.commands.set(command.data.name, command);
}

// ไฟล์ JSON ใช้เก็บข้อมูล spam/raid และ whitelist
const stateFilePath = './state.json';
let state = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));

// บันทึก state ลงไฟล์
function saveState() {
  fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2));
}

// Log ระบบ
const logChannelId = config.logChannelId;

// Event: เมื่อ Bot Online
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
});

// Event: เมื่อมีข้อความใหม่
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const { content, author, guild } = message;

  // ตรวจสอบ Whitelisted Role
  const memberRoles = message.member.roles.cache;
  if (memberRoles.some(role => config.whitelistedRoles.includes(role.id))) return;

  try {
    // คำสั่ง Lock/Unlock (แยกไฟล์ในโฟลเดอร์ commands)
    if (content.startsWith(config.prefix)) {
      const args = content.slice(config.prefix.length).trim().split(/\s+/);
      const command = args.shift().toLowerCase();

      if (client.commands.has(command)) {
        await client.commands.get(command).execute(message, args, state);
        saveState(); // บันทึก state หลังคำสั่ง
      }
    }

    // ตรวจจับ Spam หรือข้อความซ้ำ
    if (!state.spamUsers[author.id]) {
      state.spamUsers[author.id] = { lastMessage: '', repeatCount: 0, timeout: false };
    }

    const userState = state.spamUsers[author.id];
    if (userState.timeout) return;

    if (userState.lastMessage === content) {
      userState.repeatCount++;
    } else {
      userState.lastMessage = content;
      userState.repeatCount = 0;
    }

    if (userState.repeatCount >= config.spamThreshold) {
      await message.member.timeout(60 * 1000, 'Spamming messages');
      userState.timeout = true;
      client.channels.cache.get(logChannelId)?.send(`User ${author.tag} was timed out for spamming.`);
      saveState();
    }

  } catch (error) {
    console.error('Error handling message:', error);
  }
});

// Event: สมาชิกใหม่เข้ามา
client.on('guildMemberAdd', async (member) => {
  const guildStats = state.guilds[member.guild.id] || { memberJoinTimes: [] };
  const joinTime = Date.now();
  guildStats.memberJoinTimes.push(joinTime);
  state.guilds[member.guild.id] = guildStats;

  // ลบข้อมูลเก่ากว่า 1 นาที
  guildStats.memberJoinTimes = guildStats.memberJoinTimes.filter(time => joinTime - time < 60000);

  if (guildStats.memberJoinTimes.length >= config.raidThreshold) {
    state.raidMode = true; // เปิด Raid mode
    client.channels.cache.get(logChannelId)?.send(`Raid detection triggered. Raid mode enabled!`);
    saveState();
  }

  saveState();
});

// พิมพ์คำสั่ง Error ให้เห็น
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);

  if (!command) return;

  try {
    await command.execute(interaction, state);
    saveState();
  } catch (error) {
    console.error(error);
    await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
  }
});

// Login to Discord
client.login(config.token);