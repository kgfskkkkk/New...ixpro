const BOT_NAME_FANCY = '𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗';

const config = {
  AUTO_VIEW_STATUS: false,
  AUTO_LIKE_STATUS: false,
  AUTO_RECORDING: false,
  AUTO_REACT: false,
  AUTO_LIKE_EMOJI: ['❤️', '💸', '😇', '🍂', '💥', '💯', '🔥', '💫', '💎', '💗', '🤍', '🖤', '👀', '🙌', '🙆', '🚩', '🥰', '💐', '😎', '🤎', '✅', '🫀', '🧡', '😁', '🎧', '🌸', '🕊️', '🌷', '⛅', '🌟', '🗿', '💜', '💙', '🌝', '🖤','❓', '💤','☘️','❤️‍🩹','🫂','🙈','🍁','🙃','🧸','😘','🏴‍☠️','👀','❤️‍🔥'],
  PREFIX: '.',
  MAX_RETRIES: 3,
  GROUP_INVITE_LINK: 'https://chat.whatsapp.com/DFsaaKIf6Kt5IHUq4IpOiB',
  IMAGE_PATH: 'https://raw.githubusercontent.com/lovelyx80/OWNER_DATA/main/IMG_DATA/alive-clean.png',
  RCD_IMAGE_PATH: 'https://raw.githubusercontent.com/lovelyx80/OWNER_DATA/main/IMG_DATA/alive-clean.png',
  SET_IMAGE_PATH: 'https://raw.githubusercontent.com/lovelyx80/OWNER_DATA/main/IMG_DATA/settings-clean.png',
  ANTI_DELETE: 'off',
  NEWSLETTER_JID: '120363408616895692@g.us',
  OTP_EXPIRY: 300000,
  WORK_TYPE: 'public',
  // 🔒 Main owners (hidden from public menus): 94755457054 + 94764642432.
  // 🔒 94720251446 = locked .setpremium executor (always allowed) — keep it in
  // OWNER_NUMBER so it also counts as a regular owner.
  OWNER_NUMBER: process.env.OWNER_NUMBER || '94755457054,94764642432,94720251446',
  // 📞 Public-facing owner number(s) shown in menus / system info / NSFW prompts.
  // Shows the main owners only — 94720251446 (premium executor) stays hidden.
  PUBLIC_OWNER_NUMBER: process.env.PUBLIC_OWNER_NUMBER || '94755457054,94764642432',
  // 🥷 Owner auto-react list: ONLY these numbers get the owner emoji reaction.
  OWNER_REACT_NUMBER: process.env.OWNER_REACT_NUMBER || '94755457054,94764642432',
  // The session number that is the ONLY sender of premium notifications
  // (activated / expired / owner alerts). Premium notices must never come
  // from other users' sessions — only from this owner session.
  PREMIUM_NOTIFY_NUMBER: process.env.PREMIUM_NOTIFY_NUMBER || '94720251446',
  CHANNEL_LINK: 'https://whatsapp.com/channel/0029VbAe6Nt545uv1kaCDE3j',
  BOT_NAME: '*𝗜𝗦𝗛𝗔𝗡-𝐗 𝗠𝗗 𝐏𝐑𝐎 🧑‍💻🇱🇰*',
  BOT_VERSION: '*7.0.0 ᴘʀᴏ*',
  OWNER_NAME: '© 𝙸𝚂𝙷𝙰𝙽-𝙼𝙰𝙳𝚄𝚂𝙰𝙽𝙺𝙴',
  BOT_FOOTER: '> _*🧑‍💻 𝐃𝙴𝚅𝙴𝙻𝙾𝙿𝙴𝚁: 𝐈𝚂𝙷𝙰𝙽-𝐗 × 𝐋𝙾𝚅𝙴𝙻𝚈 🇱🇰*_',
  BUTTON_IMAGES: { ALIVE: 'https://raw.githubusercontent.com/minibotsjsisns/IMAGE_DATA/refs/heads/main/file_000000005eac720896d40b719700b3c0.png' }
};

module.exports = { config, BOT_NAME_FANCY };
