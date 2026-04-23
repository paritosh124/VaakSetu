# VaakSetu — Agent Translator (Chrome Extension)

Real-time voice translator overlay for call-center agents. Works on top of
any call platform that runs in a browser tab (Google Meet, Zoom Web, Teams,
Genesys Cloud, Freshcaller, Talkdesk, Exotel dialer, etc.).

## How it works

- You open the call tab and click the VaakSetu icon → **Start translator**.
- A floating widget appears over the call. Two push-to-talk buttons:
  - **Customer speaks** → captures tab audio → translates into agent's language → speaks it aloud (agent hears it).
  - **Agent speaks** → captures your mic → translates into customer's language → speaks it aloud through your speakers (the customer hears it via their phone's microphone — you must use speakerphone mode on this laptop).
- Transcripts of both sides appear in the floating feed.

No virtual audio cable is required in this phase — the translated customer-
directed audio reaches the customer through your laptop speakers feeding back
into the call microphone. It's rough but works for a first test.

## One-time install (developer mode, unpacked)

1. Deploy your Vercel backend first — this extension calls `https://vaak-setu.vercel.app/api/*`.
   Make sure `GROQ_API_KEY`, `SARVAM_API_KEY`, and `ELEVENLABS_API_KEY` are set in Vercel env vars and you have redeployed.
2. Open Chrome → `chrome://extensions`.
3. Top-right: toggle **Developer mode** on.
4. Click **Load unpacked** → pick this `extension/` folder.
5. Pin the VaakSetu icon to your toolbar (puzzle icon → pin).

## First test — translate a YouTube video (no live call needed)

Good smoke test before you try a real call.

1. Open a YouTube video in Spanish (or any foreign language).
2. Click VaakSetu icon → Agent speaks = English, Customer speaks = Spanish → **Start translator**.
3. Widget appears on the YouTube tab. Press and hold **Customer speaks** while a phrase plays. Release.
4. You should see the Spanish transcript → English translation → hear English TTS.

## Second test — Google Meet / Zoom Web with a friend

1. Start a Meet/Zoom call in a browser tab. Ask your friend to speak Spanish.
2. Turn **on speakerphone** on your laptop (translated audio must reach your mic to feed back to them).
3. Click VaakSetu → set languages → **Start translator**.
4. Hold **Customer speaks** while they talk → widget shows translation, plays English through your speakers (you hear it).
5. Hold **Agent speaks** while you talk in English → widget plays Spanish through your speakers → your friend's phone/laptop mic picks it up → they hear Spanish.

## Troubleshooting

- **Widget doesn't appear after Start**: close and reopen the call tab, then Start again. Content scripts aren't injected into tabs that were already open when the extension loaded.
- **"Audio capture failed"**: mic permission not granted. Chrome settings → Privacy → Site settings → Microphone → allow `chrome-extension://<your-ext-id>`.
- **"Sarvam STT failed (401)"** or similar: API keys missing in Vercel env vars. Check `vercel env ls production`.
- **No sound for customer-directed audio**: laptop isn't on speakerphone, or your mic is muted in the call. Speaker output must reach your mic.
- **Restricted pages**: extension cannot inject the widget on `chrome://`, the Chrome Web Store, or a few other special pages. Use a normal website (Meet, Zoom, YouTube, etc.).

## Known limits (phase 1, by design)

- **Push-to-talk only.** No automatic silence detection — you hold the button. Phase 2 will add VAD.
- **Speakerphone routing.** Translated audio reaches the other side via your speakers feeding back into your mic. Customers will hear a slight echo and some background. Phase 2 will use a virtual audio cable (VB-Cable / BlackHole) for clean routing.
- **No usage logging.** Minutes consumed aren't tracked anywhere yet.
- **Same-origin only for backend.** The extension calls the deployed Vercel site. If you need to test against localhost, change `API_BASE` in `extension/lib/config.js` and add the local URL to `host_permissions` in `manifest.json`.

## File layout

```
extension/
  manifest.json           MV3 manifest, permissions, host access
  background.js           Service worker — message router + session lifecycle
  popup/                  Toolbar popup — language selection + start/stop
  offscreen/              Hidden page — tabCapture + mic + MediaRecorder + pipeline
  widget/                 Content script — floating push-to-talk overlay + feed
  lib/
    config.js             API_BASE + language catalogs
    pipeline.js           Routing: Sarvam (Indian↔Indian) vs Groq+ElevenLabs (intl)
    api/
      sarvam.js           Saaras STT + Mayura translate + Bulbul TTS (via Vercel)
      groq.js             Whisper STT + Llama translate (via Vercel)
      elevenlabs.js       ElevenLabs TTS (via Vercel)
  icons/                  16/48/128 PNGs (placeholder amber squares)
```
