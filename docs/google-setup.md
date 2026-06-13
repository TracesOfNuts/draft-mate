# Google credentials for draft-mate (step by step)

draft-mate connects to Gmail with **your own** OAuth client — no third-party
server is involved. This walks through creating that client in Google Cloud
Console. ~10 minutes, one time.

You start on **APIs & Services → Credentials**. Google requires two setup steps
before it will let you create a client, so do them in this order.

---

## A. Enable the Gmail API

1. Top search bar → type **Gmail API** → open the result → **Enable**.
   (Or: APIs & Services → **Library** → search "Gmail API" → **Enable**.)

## B. Configure the OAuth consent screen

In the left nav this is **Google Auth Platform** (older projects call it
**OAuth consent screen**).

1. Click **Get started** / configure if prompted.
2. **Branding** — App name `draft-mate`; user support email = your email;
   developer contact email = your email. Save.
3. **Audience** — choose **External**. Save.
4. Still under **Audience → Test users → + Add users** → add **your own Gmail
   address**. Save.
   - Leave the app in **Testing** (do not publish). As a listed test user you
     can use Gmail's restricted scopes without app verification.
5. *(Optional, recommended)* **Data access → Add or remove scopes** → filter for
   `gmail.readonly` → tick **`.../auth/gmail.readonly`** → **Update** → **Save**.

## C. Create the OAuth client

1. Left nav → **Clients** (or **Credentials**) → **+ Create credentials** →
   **OAuth client ID**.
2. **Application type: `Desktop app`** — important. Desktop clients accept the
   `http://127.0.0.1:<port>` loopback redirect automatically, so you don't
   enter any redirect URI.
3. Name `draft-mate desktop` → **Create**.

## D. Copy the credentials

The dialog shows a **Client ID** and **Client secret**. Copy both. You can
re-open or **Download JSON** from the Clients list later.

> Google labels the desktop client's secret as not truly confidential — it ships
> in installed apps by design. draft-mate keeps it in an env var and only stores
> the resulting refresh token, encrypted, under `~/.draft-mate`.

## E. Connect the account

Run in the **same shell** you'll launch draft-mate from:

**PowerShell**
```powershell
$env:GMAIL_CLIENT_ID="<your-id>.apps.googleusercontent.com"
$env:GMAIL_CLIENT_SECRET="<your-secret>"
node dist/cli.js connect --provider gmail --email you@gmail.com --key work
```

**Git Bash**
```bash
export GMAIL_CLIENT_ID="<your-id>.apps.googleusercontent.com"
export GMAIL_CLIENT_SECRET="<your-secret>"
node dist/cli.js connect --provider gmail --email you@gmail.com --key work
```

A browser opens → sign in → you'll see an **"unverified app"** warning (expected
for your own app in Testing) → **Advanced → Go to draft-mate (unsafe) → Allow**.

Then launch the dashboard and pick **work** from the account dropdown:
```powershell
node dist/cli.js serve
```
Or from the terminal: `node dist/cli.js triage --account work --unread --limit 20`.

---

## Notes & gotchas

- **Read-only by default.** The default scope `gmail.readonly` lets draft-mate
  fetch and rank but never modify mail. To let it **save reply drafts**, re-run
  `connect` after widening scopes:
  ```powershell
  $env:GMAIL_SCOPES="https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose"
  ```
- **Testing-mode tokens expire after 7 days.** While the app is in *Testing*,
  Google expires refresh tokens weekly — just re-run `connect`. Publish the app
  for permanence.
- **Right project?** The project picker at the top of the console must show the
  project where you enabled the API and made the client.
- **`access_denied` / not a test user?** Make sure the Google account you sign in
  with is listed under **Audience → Test users**.
- **`redirect_uri_mismatch`?** You almost certainly created a "Web application"
  client instead of **Desktop app**. Create a Desktop app client.
