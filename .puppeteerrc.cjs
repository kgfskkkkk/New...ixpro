// Puppeteer config for this bot.
//
// On this host, Puppeteer's own Chrome-for-Testing download (which normally
// runs during `npm install`) fails with:
//   "Failed to set up chrome v...! The browser folder exists but the
//    executable is missing" — i.e. the download got interrupted/blocked and
// left a half-extracted folder behind. Because that install step errors out,
// `npm install` aborts entirely, which is why later packages (like
// @whiskeysockets/baileys) never get installed either.
//
// skipDownload:true stops Puppeteer from attempting that download at all, so
// `npm install` can finish and install the rest of the dependencies.
// launchMovieBrowser() in pair.js instead points at a real Chromium binary —
// either PUPPETEER_EXECUTABLE_PATH if you set one, or the system `chromium`
// package installed by the "preinstall" script in package.json.
//
// @type {import('puppeteer').Configuration}
module.exports = {
  skipDownload: true,
};
