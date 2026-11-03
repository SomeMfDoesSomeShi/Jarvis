# J.A.R.V.I.S. Spatial Edition — Quest 3 starter

A browser-based J.A.R.V.I.S. workspace for desktop and Meta Quest 3. This is a runnable starter project, not a finished native Quest application.

## What is included

- Desktop dashboard, assistant chat, project library and code preview.
- WebXR immersive VR entry for compatible browsers over HTTPS.
- Spatial hologram-style panels with translucent surfaces; panels can be repositioned and their layout is saved locally.
- **Hand tracking:** pinch to select/activate a panel button, pinch and hold a panel body to move it. The browser must expose WebXR hand tracking.
- **Controllers:** trigger to select buttons and grab/move panels.
- A separate immersive AR/MR entry point. Passthrough is only available if the Quest browser/runtime exposes `immersive-ar`; it cannot be forced by a website.
- Web and immersive project records, local persistence, JSON export, and a simple web preview.
- Optional Supabase authentication/project sync and a Supabase Edge Function that keeps the Groq API key server-side.
- Browser speech synthesis fallback; optional Groq Orpheus speech endpoint.

## Important compatibility notes

- Use Meta Quest Browser on the Quest 3, with the site served over HTTPS. `localhost` is suitable for desktop development only; headset access needs a deployed HTTPS URL or a trusted HTTPS development tunnel.
- WebXR support varies by browser version. The app checks `immersive-vr` and `immersive-ar` at runtime. If MR is unavailable, use VR mode.
- Hand tracking requires hand tracking enabled on the headset and permission/support in the browser. Controllers remain available as an alternative.
- The panels are virtual 3D surfaces inside the WebXR scene. They are not native OS windows, and their saved positions are app-local rather than persistent physical-world anchors.
- Generated `vr.js` modules execute in the app page context because they need access to the Three.js scene. Only run code you trust. This prototype is intended for personal/local use, not as a public multi-user code execution service.
- AI calls are disabled until you configure Supabase and deploy the Edge Function. The app does not embed a secret API key in browser code.

## Requirements

- Node.js 20.19+ (Node 22 LTS recommended)
- A Supabase project (free tier may be sufficient; service limits can change)
- A Groq API key for AI chat and optional Orpheus speech. Groq usage and model availability are subject to the provider's current limits and pricing.
- Meta Quest 3 with Meta Quest Browser for headset testing

## Run locally on your computer

```bash
npm install
npm run dev
```

Open the local Vite URL shown in the terminal. The desktop interface works locally. WebXR headset testing requires HTTPS and a browser/runtime that supports WebXR.

## Configure Supabase and Groq

1. Create a Supabase project.
2. In Supabase **SQL Editor**, run `supabase/schema.sql`.
3. Install the Supabase CLI and authenticate, then link this folder to your Supabase project:

   ```bash
   supabase login
   supabase link --project-ref YOUR_PROJECT_REF
   ```

4. Set the Groq secret and deploy the Edge Function:

   ```bash
   supabase secrets set GROQ_API_KEY=YOUR_GROQ_API_KEY
   supabase functions deploy jarvis
   ```

5. In J.A.R.V.I.S. Configuration, enter the Supabase Project URL and the project's **publishable/anon client key**. Do not use a service-role key in the browser.
6. Create an account or sign in. Chat and optional premium voice then use the deployed Edge Function.

The Orpheus speech endpoint may be unavailable to some Groq accounts/models and can incur usage charges. Leave premium voice disabled to use browser speech synthesis.

## Deploy the frontend with GitHub Pages

1. Create a GitHub repository and upload the contents of this folder.
2. Ensure the default branch is named `main` (or edit `.github/workflows/deploy.yml`).
3. In GitHub repository settings, enable Pages with **GitHub Actions** as the source.
4. Push to `main`. The included workflow builds and deploys `dist/`.
5. Open the resulting HTTPS Pages URL on desktop or Quest Browser.

The Supabase Edge Function is deployed separately; GitHub Pages only hosts the frontend.

## Project format

- `kind: "web"`: `index.html`, optional `style.css`, optional `app.js`.
- `kind: "vr"`: `vr.js` exporting `mount({ THREE, scene, camera, renderer, addPanel, addButton, onFrame })`.

The assistant is instructed to return project files in this format. Exported project records are JSON files that can be saved and re-imported manually in a future version.

## Troubleshooting

- **AI says it needs Supabase:** check the Project URL and client key, save settings, and verify that the `jarvis` Edge Function is deployed with `GROQ_API_KEY` set.
- **Sign-up does not immediately log in:** check Supabase email confirmation settings and confirm the account if required.
- **VR button reports unsupported:** open the deployed HTTPS site in Meta Quest Browser, update the browser/headset, and check WebXR availability.
- **Hand pinch does nothing:** enable hand tracking on the Quest, allow hand tracking in the browser, and retry. Use controller triggers if the browser does not expose hand joints.
- **MR button is unavailable:** this is a runtime/browser capability limitation, not a setting the website can override.
- **No sound:** allow microphone/audio permissions where relevant and interact with the page once to satisfy browser audio playback policies.

## Project structure

```text
index.html
src/main.js       desktop app, chat, project library, settings
src/vr.js         Three.js scene, WebXR session, hands/controllers, spatial panels
src/style.css     interface styling
supabase/schema.sql
supabase/functions/jarvis/index.ts
.github/workflows/deploy.yml
```
