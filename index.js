const { Client, GatewayIntentBits, PermissionFlagsBits, EmbedBuilder, Partials } = require("discord.js");

// ---- CONFIG ----
const config = {
  exemptChannels: ["ใส่channel_id_ที่ยกเว้น"],
  logChannel: "ใส่log_channel_id",
  adminRole: "ใส่admin_role_id",

  // Anti-Spam
  rateLimit: { messages: 100, seconds: 60 },
  duplicateLimit: 10,

  // Anti-Raid
  minAccountAge: 7,           // บัญชีอายุน้อยกว่า 7 วัน = ต้องสงสัย
  raidThreshold: 5,           // เข้า server เกิน 5 คนใน 10 วินาที = raid
  raidTimeWindow: 10000,      // 10 วินาที
  newMemberAction: "kick",    // kick หรือ ban
};

// ---- Discord Client ----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel, Partials.Message],
});

// ---- Trackers ----
const spamTracker = new Map();
const joinTracker = [];  // เก็บ timestamp การเข้า server
let isLocked = false;
let isRaidMode = false;

// ---- Helpers ----
async function sendLog(guild, embed) {
  try {
    const logCh = await guild.channels.fetch(config.logChannel);
    if (logCh) await logCh.send({ content: config.adminRole ? `<@&${config.adminRole}>` : "", embeds: [embed] });
  } catch {}
}

async function lockAll(guild, reason) {
  if (isLocked) return;
  isLocked = true;
  let count = 0;
  for (const [, channel] of guild.channels.cache) {
    if (!channel.isTextBased()) continue;
    if (config.exemptChannels.includes(channel.id)) continue;
    try {
      await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false, AddReactions: false });
      count++;
    } catch {}
  }
  await sendLog(guild, new EmbedBuilder()
    .setColor("#ff0000")
    .setTitle("🔒 SERVER LOCKED!")
    .setDescription(`**สาเหตุ:** ${reason}\n**ช่องที่ล็อก:** ${count} ช่อง\nใช้ \`!unlock\` เพื่อปลดล็อก`)
    .setTimestamp()
  );
}

async function unlockAll(guild) {
  let count = 0;
  for (const [, channel] of guild.channels.cache) {
    if (!channel.isTextBased()) continue;
    if (config.exemptChannels.includes(channel.id)) continue;
    try {
      await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null, AddReactions: null });
      count++;
    } catch {}
  }
  isLocked = false;
  isRaidMode = false;
  return count;
}

// ---- Ready ----
client.once("ready", () => {
  console.log(`✅ Anti-Spam + Anti-Raid Bot ออนไลน์! ${client.user.tag}`);
});

// ---- Anti-Raid: ตรวจจับการเข้า server ----
client.on("guildMemberAdd", async (member) => {
  const now = Date.now();

  // เช็คอายุบัญชี
  const accountAge = (now - member.user.createdTimestamp) / (1000 * 60 * 60 * 24);
  const isSuspicious = accountAge < config.minAccountAge;

  // บันทึกการเข้า
  joinTracker.push({ time: now, memberId: member.id, suspicious: isSuspicious });

  // ลบ entry เก่าออก
  const recentJoins = joinTracker.filter(j => now - j.time < config.raidTimeWindow);
  joinTracker.length = 0;
  joinTracker.push(...recentJoins);

  const suspiciousJoins = recentJoins.filter(j => j.suspicious).length;

  // ถ้าเข้าเยอะเกินไปใน window = Raid!
  if (recentJoins.length >= config.raidThreshold && !isRaidMode) {
    isRaidMode = true;
    await lockAll(member.guild, `🚨 ตรวจพบ RAID! มีคน ${recentJoins.length} คนเข้า server ใน ${config.raidTimeWindow / 1000} วินาที`);
  }

  // ถ้าบัญชีน้อยกว่า X วัน และ raid mode เปิดอยู่
  if (isSuspicious && isRaidMode) {
    try {
      if (config.newMemberAction === "ban") {
        await member.ban({ reason: `Anti-Raid: บัญชีอายุน้อยกว่า ${config.minAccountAge} วัน` });
      } else {
        await member.kick(`Anti-Raid: บัญชีอายุน้อยกว่า ${config.minAccountAge} วัน`);
      }
      await sendLog(member.guild, new EmbedBuilder()
        .setColor("#ff6600")
        .setTitle(`🚨 ${config.newMemberAction === "ban" ? "แบน" : "Kick"} สมาชิกต้องสงสัย`)
        .addFields(
          { name: "👤 ชื่อ", value: member.user.tag, inline: true },
          { name: "📅 อายุบัญชี", value: `${Math.floor(accountAge)} วัน`, inline: true },
          { name: "🆔 ID", value: member.id, inline: true },
        )
        .setTimestamp()
      );
    } catch {}
    return;
  }

  // แจ้งเตือนถ้าบัญชีใหม่น่าสงสัยแม้ไม่ raid mode
  if (isSuspicious) {
    await sendLog(member.guild, new EmbedBuilder()
      .setColor("#ffcc00")
      .setTitle("⚠️ สมาชิกใหม่บัญชีอายุน้อย")
      .addFields(
        { name: "👤 ชื่อ", value: member.user.tag, inline: true },
        { name: "📅 อายุบัญชี", value: `${Math.floor(accountAge)} วัน`, inline: true },
        { name: "🆔 ID", value: member.id, inline: true },
      )
      .setTimestamp()
    );
  }
});

// ---- Anti-Spam: ตรวจจับข้อความ ----
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;

  const isAdmin = message.member?.roles.cache.has(config.adminRole) ||
                  message.member?.permissions.has(PermissionFlagsBits.Administrator);

  // ---- Admin Commands ----
  if (message.content === "!unlock" && isAdmin) {
    const count = await unlockAll(message.guild);
    return message.reply(`✅ ปลดล็อก ${count} ช่องแล้วครับ! Raid mode ปิดแล้ว`);
  }

  if (message.content === "!raidmode" && isAdmin) {
    if (isRaidMode) {
      isRaidMode = false;
      return message.reply("✅ ปิด Raid Mode แล้วครับ");
    } else {
      isRaidMode = true;
      return message.reply("🚨 เปิด Raid Mode แล้วครับ บัญชีใหม่จะถูก kick อัตโนมัติ");
    }
  }

  if (message.content === "!status" && isAdmin) {
    return message.reply({ embeds: [new EmbedBuilder()
      .setColor(isLocked ? "#ff0000" : "#00cc66")
      .setTitle("📊 สถานะระบบ")
      .addFields(
        { name: "🔒 Server Lock", value: isLocked ? "🔴 ล็อกอยู่" : "🟢 ปกติ", inline: true },
        { name: "🚨 Raid Mode", value: isRaidMode ? "🔴 เปิดอยู่" : "🟢 ปิด", inline: true },
      )
      .setTimestamp()
    ]});
  }

  // ---- Spam Detection ----
  const userId = message.author.id;
  const now = Date.now();

  if (!spamTracker.has(userId)) {
    spamTracker.set(userId, { messages: [], lastContent: "", duplicateCount: 0 });
  }

  const tracker = spamTracker.get(userId);
  tracker.messages = tracker.messages.filter(t => now - t < config.rateLimit.seconds * 1000);
  tracker.messages.push(now);

  if (message.content === tracker.lastContent) {
    tracker.duplicateCount++;
  } else {
    tracker.duplicateCount = 1;
    tracker.lastContent = message.content;
  }

  const isRateSpam = tracker.messages.length >= config.rateLimit.messages;
  const isDupSpam = tracker.duplicateCount >= config.duplicateLimit;

  if ((isRateSpam || isDupSpam) && !isAdmin) {
    const reason = isRateSpam && isDupSpam ? "ส่งเร็วเกิน + ซ้ำ" : isRateSpam ? "ส่งข้อความเร็วเกินไป" : "ข้อความซ้ำ";
    spamTracker.delete(userId);
    if (!isLocked) {
      await lockAll(message.guild, `🚨 Spam จาก ${message.author.tag}: ${reason}`);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
