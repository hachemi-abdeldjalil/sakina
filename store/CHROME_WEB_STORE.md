# Publishing Sakina on the Chrome Web Store

Upload file: `Sakina-<version>.zip` (35 MB), made by `npm run zip`. Rebuild with `npm run zip` after any change, and
raise `version` in `static/manifest.json` for every later upload.

## Steps (about 5 minutes)

1. Open https://chrome.google.com/webstore/devconsole with your developer account.
2. **Add new item** → upload the zip.
3. **Store listing** tab: paste the listing below. Upload the images from `store/images/`:
   - screenshots `shot1-1280x800.png`, `shot2-1280x800.png`, `shot3-1280x800.png`
   - small promo tile `promo-440x280.png`
   - store icon `icon-128x128.png` (same as the package icon)
   - the store icon is taken from the package (`icons/icon128.png`)
4. **Privacy** tab: paste the answers below.
5. **Distribution**: Public, all regions. The extension is free.
6. **Submit for review.** A first review usually takes a few days. The extension's size and its WebAssembly
   can trigger a longer manual review.
7. When it is live, note the item ID here. Later updates can then go through the API (see the end).

## Store listing

- **Name** (from the manifest): Sakina: Music Remover & 18+ Blur
- **Summary** (from the manifest, 130 chars): Removes background music from YouTube with on-device AI, keeping voices, recitation and sound effects. Blurs scenes that look 18+.
- **Category:** Entertainment
- **Language:** English
- **Description:**

  > Watch YouTube without the background music, and without scenes you'd rather not see.
  >
  > REMOVE THE MUSIC, KEEP THE VOICES
  > Sakina runs an AI model on your computer that separates each video's sound into music, speech and sound effects, and plays it back without the music. Speech, Quran recitation and sound effects stay. The cleaned sound stays in sync with the video, with no added delay.
  >
  > • Works on any YouTube video, ahead of playback
  > • A voice model protects speech and recitation from being treated as music
  > • "Live" mode: lighter processing for slower computers
  > • Keep sound effects, or remove them too so only voices are left
  > • Adjustable strength and voice protection
  >
  > BLUR SCENES THAT LOOK 18+
  > An image model checks the video several times a second and blurs the player when a scene looks inappropriate. Choose Strict, Balanced or Relaxed. A "Show this video" button handles false alarms.
  >
  > PRIVATE BY DESIGN
  > Everything runs on your computer. No audio, video frames or browsing data are sent anywhere, and there is no account.
  >
  > HONEST LIMITS
  > No filter is perfect: some music can slip through (especially singing over music), and the blur reacts a fraction of a second after a scene appears. The first time, Sakina sets up its AI model (included in the download). For the first seconds of a video, and right after you skip ahead, it uses Live mode while the AI catches up.

- **Arabic listing** (optional; add Arabic under "Store listing → language"):

  > شاهد يوتيوب من دون الموسيقى الخلفية، ومن دون المشاهد التي لا تريد رؤيتها.
  >
  > تشغّل سكينة نموذج ذكاء اصطناعي على جهازك يفصل صوت كل فيديو إلى موسيقى وكلام ومؤثرات، ثم يشغّله من دون الموسيقى، مع الإبقاء على الكلام وتلاوة القرآن والمؤثرات، ومتزامنًا مع الفيديو بلا تأخير. ونموذج صور يفحص الفيديو عدة مرات في الثانية ويموّه المشاهد التي تبدو مخصّصة للبالغين، مع زرّ «Show this video» عند الخطأ.
  >
  > كل شيء يعمل على جهازك: لا يُرسل أي صوت أو صورة أو بيانات تصفّح، ولا حاجة إلى حساب.

## Privacy tab

- **Single purpose:** Make YouTube videos suitable for viewers who avoid music and adult imagery. While a video plays, Sakina removes the background music from its sound and blurs scenes that look 18+, entirely on the user's device.
- **Permission justifications:**
  - `storage`: saves the user's settings (on/off switches, method, strength, voice protection, keep sound effects, blur sensitivity).
  - Host permission (content scripts on `https://www.youtube.com/*` and `https://m.youtube.com/*`): Sakina has to process the sound of the YouTube video being watched and check its frames for the blur. It runs only on YouTube.
- **Remote code:** No, I am not using remote code. All JavaScript, WebAssembly modules (ONNX Runtime, RNNoise) and AI models are included in the package.
- **Data usage:** tick none of the data types, and confirm the three certifications.
- **Privacy policy URL:** https://abdeljalil1.github.io/minicard/sakina/privacy.html (source: `store/privacy.html`).

## Before you submit: three things to decide

1. **Single-purpose policy.** The store asks for one narrow purpose. Sakina's two features are framed above as one
   ("make YouTube suitable for viewers who avoid music and adult imagery"). If a reviewer disagrees, the usual fix
   is to ship the blur as a separate extension.
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
