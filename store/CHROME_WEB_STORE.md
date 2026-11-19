# Publishing Sakina on the Chrome Web Store

Upload file: `Sakina-<version>.zip` (about 31 MB), made by `npm run zip`. Rebuild with `npm run zip` after any change, and
raise `version` in `static/manifest.json` for every later upload.

## Steps (about 5 minutes)

1. Open https://chrome.google.com/webstore/devconsole with your developer account.
2. **Add new item** → upload the zip.
3. **Store listing** tab: paste the listing below. Upload the images from `store/images/`:
   - screenshots `screenshot-1-1280x800.png` to `screenshot-5-1280x800.png`, in that order
   - small promo tile `promo-440x280.png`, marquee promo tile `marquee-1400x560.png`
   - store icon `icon-128x128.png` (same as the package icon)
   - the store icon is taken from the package (`icons/icon128.png`)
4. **Privacy** tab: paste the answers below.
5. **Distribution**: Public, all regions. The extension is free.
6. **Submit for review.** A first review usually takes a few days. The extension's size and its WebAssembly
   can trigger a longer manual review.
7. When it is live, note the item ID here. Later updates can then go through the API (see the end).

## Store listing

- **Name** (from the manifest): Sakina سكينة
- **Summary** (from the manifest, 121 chars): Removes background music from YouTube videos on your computer, keeping voices and Quran recitation. Sound effects optional.
- **Category:** Entertainment
- **Language:** English
- **Description:**

  > Watch YouTube without the background music.
  >
  > Sakina separates each video's sound into music, speech and sound effects on your computer, and plays it back without the music. Speech and Quran recitation stay. The cleaned sound stays in sync with the video, with no added delay.
  >
  > • Works on any YouTube video
  > • Protects speech and recitation from being treated as music
  > • Only voices are left by default; turn on Keep sound effects to keep footsteps, doors and applause
  > • Best quality, or Light for slower computers
  >
  > Private by design: everything runs on your computer. No audio or browsing data is sent anywhere, and there is no account.
  >
  > Honest limits: no filter is perfect. Some music can slip through, especially singing over instruments, and voices sung in layered harmony can be thinned. For the first second or two of a video, and right after you skip ahead, the Light filter plays while Best catches up.

- **Arabic listing** (optional; add Arabic under "Store listing → language"):

  > شاهد يوتيوب من دون الموسيقى الخلفية.
  >
  > تفصل سكينة صوت كل فيديو على جهازك إلى موسيقى وكلام ومؤثرات، ثم تشغّله من دون الموسيقى، مع الإبقاء على الكلام وتلاوة القرآن، ومتزامنًا مع الفيديو بلا تأخير. ويمكنك إبقاء المؤثرات الصوتية أو حذفها أيضًا.
  >
  > كل شيء يعمل على جهازك: لا يُرسل أي صوت أو بيانات تصفّح، ولا حاجة إلى حساب.

## Privacy tab

- **Single purpose:** Remove the background music from YouTube videos while they play, keeping voices, Quran recitation and, if the user wants, sound effects. Everything runs on the user's device.
- **Permission justifications:**
  - `storage`: saves the user's settings (on/off, quality, keep sound effects, strength, voice protection, centre focus).
  - Host permission (content scripts on `https://www.youtube.com/*` and `https://m.youtube.com/*`): Sakina has to process the sound of the YouTube video being watched. It runs only on YouTube.
- **Remote code:** No, I am not using remote code. All JavaScript, WebAssembly modules (ONNX Runtime, RNNoise), and the separation model are included in the package.
- **Data usage:** tick none of the data types, and confirm the three certifications.
- **Privacy policy URL:** https://abdeljalil1.github.io/minicard/sakina/privacy.html (source: `store/privacy.html`).

## Moving the store item from 0.2.0 to 0.4.0

0.2.0 was submitted with the 18+ blur and the old name. 0.4.0 removes the blur. The new zip changes the name and
summary by itself; the rest of the listing does not follow the zip:

1. If 0.2.0 is still in review, cancel it in the dashboard (or wait for the result).
2. Upload `Sakina-0.4.0.zip` (or run `npm run release` once the API setup below is done).
3. Store listing: replace the description (and the Arabic one) with the text above. Delete the old screenshots
   and upload `screenshot-1` to `screenshot-5`, the promo tile and the marquee tile (all in `store/images/`;
   `node store/art/render.mjs` redraws them from `store/art/`).
4. Privacy tab: replace the single purpose and the `storage` justification with the text above.
5. Submit for review.

## Before you submit: three things to decide

1. **Single-purpose policy.** Since 0.4.0 Sakina has one purpose, music removal (the 18+ blur was removed).
2. **Model training data.** The MRX model's code and weights are MIT. Its training set (Divide and Remaster)
   includes FMA and FSD50K clips, some under non-commercial licences. A free extension is the lower-risk choice.
   Get advice before charging for it.
3. **Not yet verified:** a listening test, Windows, and slower computers (v2 needs better than 1× real time;
   it falls back to Live mode otherwise).

## Updates from the terminal

Sakina's item ID is `gjiadlibjmopbfcglkaolniphiojkhna`. After the first approval, every update is:

```bash
npm run bump            # 0.3.0 → 0.3.1 (or: npm run bump minor)
npm run release         # builds the zip, uploads it, submits it for review
npm run store:status    # published / in-review versions
```

`release` refuses to upload while a version is still in review, or when the store already has this
version or a newer one. Listing text, screenshots and privacy answers still change only in the dashboard.

### One-time setup (about 10 minutes)

1. https://console.cloud.google.com → create a project (for example "Store publishing").
2. **APIs & Services → Library** → enable **Chrome Web Store API**.
3. **Google Auth Platform → Branding / Audience**: user type *External*, any app name, your email. Under
   **Audience**, set the publishing status to **In production**. In *Testing*, Google expires the refresh
   token after 7 days. Google will show "unverified app" when you sign in; choose *Advanced → continue*.
   That screen only affects you.
4. **Clients → Create client → Desktop app** → copy the client ID and client secret.
5. In the terminal: `npm run store:setup`. Paste the two values (the secret is hidden as you type) and your
   publisher ID (the long ID after `/devconsole/` in the dashboard address), then sign in in the browser
   window that opens.

Credentials go to the macOS Keychain (service `chrome-web-store`), never into this folder. The same
credentials can publish other extensions in the same developer account.
