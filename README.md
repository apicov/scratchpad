# Pico Scratchpad

Plain-text notes ("scratchpads") that sync live between your devices: an Android app, any web browser and Neovim. Edits are saved about 150 ms after you stop typing, and they appear on the other devices right away.

- **Server:** `server/server.js`, a single Node.js file with no dependencies. It stores each scratchpad as an ordinary text file.
- **App:** `app/`, a small web page (`app/www/`) that is also packaged as an Android app with Capacitor.
- **Neovim:** `nvim/lua/scratchpad.lua`, a plugin that opens scratchpads as live-synced buffers.

There is no login. The server is meant to be reachable only inside a private network, such as a [Tailscale](https://tailscale.com) tailnet, so that only your own devices can reach it.

---

## Setup

### 1. Server

You need a Linux machine with Node.js 20 or newer. A small VPS or a home server works. The examples use Fedora (`dnf`); on other distributions use their package manager.

**Quick test (any machine):**

```sh
node server/server.js        # serves on http://127.0.0.1:8787, notes go to server/data/
node --test server/server.test.js
```

**Permanent install on a Fedora server with Tailscale.** `server/setup-server.sh` does all of this in one go:
- installs and starts Tailscale
- opens the firewall for tailnet traffic only
- installs a systemd service `pico-scratchpad` that listens on the server's Tailscale IP, port 8787

1. Install Node.js: `sudo dnf install nodejs`
2. Copy this repository to the server, e.g. to `/home/<user>/code/pico-scratchpad`.
3. From that folder, run `sudo bash server/setup-server.sh`.
   - The server runs as the user who called `sudo`, from the folder the script is in.
   - To run it as another account, use `sudo APP_USER=<account> bash server/setup-server.sh`.
   - The first time, Tailscale prints a login URL; open it and approve the machine.
4. The script ends by printing the address, e.g. `http://<server-ip>:8787`. Open it in a browser on another tailnet device to check.

Notes are stored in `/home/<user>/scratchpad-data/`.

**Settings.** These are environment variables; set them in the systemd unit with `Environment=`.

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | Address to listen on (the setup script uses the Tailscale IP) |
| `PORT` | `8787` | Port |
| `DATA_DIR` | `server/data` | Where scratchpads are stored |
| `WEB_DIR` | `app/www` | The web app the server serves at `/` |
| `BACKUP_DIR` | `DATA_DIR/.backups` | Where backups go |
| `BACKUP_EVERY_MS` | `3600000` (1 h) | At most one backup per scratchpad per this interval |
| `BACKUP_KEEP_DAYS` | `30` | Backups older than this are deleted |

**Updating the server later.** Copy the new `server/` and `app/www/` folders over the old ones, then restart:

```sh
rsync -a --exclude data --exclude node_modules server/ <user>@<server>:code/pico-scratchpad/server/
rsync -a app/www/ <user>@<server>:code/pico-scratchpad/app/www/
ssh <user>@<server> 'sudo systemctl restart pico-scratchpad'
```

Without sudo, the service user can restart it instead by stopping its own process. The unit has `Restart=always`, so systemd starts it again within a few seconds:

```sh
ssh <user>@<server> 'kill $(systemctl show -p MainPID --value pico-scratchpad)'
```

### 2. Devices: join the private network

Every device that should use the scratchpad must be on the same tailnet as the server: install Tailscale and sign in with the same account. A device that isn't on the tailnet cannot reach the server; in the app, the status dot stays red.

### 3. Web browser

Open `http://<server-ip>:8787` in a browser on a tailnet device. That's the whole setup.

### 4. Android app

**Requirements on your computer:**
- Node.js
- JDK 21: `sudo dnf install java-21-openjdk-devel`
- the Android SDK (Android Studio installs it to `~/Android/Sdk`)

**App ID.** The app ID is `com.example.scratchpad`. If you publish your own build, change it to your own reverse-domain ID in all of these places:
- `app/capacitor.config.json`
- `app/android/app/build.gradle` (`namespace` and `applicationId`)
- `app/android/app/src/main/res/values/strings.xml`
- the package line and folder of `MainActivity.java`

**Build and install:**

```sh
cd app
npm install                    # first time only
./install-android.sh           # builds and installs on a phone connected over USB
./install-android.sh --no-install   # only builds: app/android/app/build/outputs/apk/debug/app-debug.apk
```

For a USB install, turn on *USB debugging* in the phone's developer options and allow the computer when the phone asks. You can also copy the APK to the phone and open it there.

On first start, the app asks for the server address (`http://<server-ip>:8787`). You can change it later with ⚙.

### 5. Neovim

Requires Neovim 0.10 or newer and `curl` 7.84 or newer.

With [lazy.nvim](https://github.com/folke/lazy.nvim), add a plugin spec (adjust `dir` to where you cloned the repo):

```lua
return {
  {
    dir = "~/code/pico-scratchpad/nvim",
    name = "pico-scratchpad",
    cmd = { "Scratch", "ScratchSnapshot", "ScratchDelete" },
    keys = { { "<leader>ns", "<cmd>Scratch<cr>", desc = "Scratchpad notes" } },
    config = function()
      require("scratchpad").setup({ url = "http://<server-ip>:8787" })
    end,
  },
}
```

Without a plugin manager, add the `nvim` folder to `runtimepath` and call `require("scratchpad").setup({ url = ... })` in your config.

---

## User guide

### App and browser

```
 ●                      [+] [⤓] [🗑] [⚙]
 notes.md   shopping.txt   ideas.md
 ─────────────────────────────────────
 your text…
```

| Control | What it does |
|---|---|
| ● | Connection status: green = connected, red = offline. Hover to see the server address. |
| Tabs | One tab per scratchpad. Tap to switch. On wide screens they sit next to the buttons. |
| **+** | New scratchpad. Enter a name such as `notes.md`. If the name already exists, that scratchpad opens. |
| **⤓** | Snapshot: saves the current text as a separate local file (see below). |
| **🗑** | Deletes the current scratchpad on all devices. The server keeps a backup. |
| **⚙** | Server address. Only needed in the Android app; the browser version always uses the server it was loaded from. |

There is no save button: the app saves while you type. The app remembers which tab you had open.

**Names** may contain letters A–Z and a–z, digits, spaces, `-`, `_` and `.`. They can be up to 100 characters long and must not start with a dot. Accented letters aren't allowed. The extension is only a label, but `.md` gets Markdown highlighting in Neovim.

### Neovim

| Command | What it does |
|---|---|
| `:Scratch name` | Opens that scratchpad, creating it if it doesn't exist. Tab completion lists existing ones. |
| `:Scratch` | Picks from a list of all scratchpads. |
| `:w` | Saves immediately (it also saves while you type). |
| `:ScratchSnapshot [path]` | Snapshot of the current scratchpad (see below). |
| `:ScratchDelete` | Deletes the current scratchpad on all devices, after asking. |

Each scratchpad is a normal buffer named `scratch://<name>`, so you switch between them like any other buffers. Anything you typed just before quitting Neovim is still sent to the server.

### Snapshots: keeping a copy as an ordinary file

A snapshot is a copy of what a scratchpad contains right now, saved as an independent text file. Later edits to the scratchpad don't change it. The file is named after the scratchpad plus the date and time, e.g. `notes-2026-11-20_1430.md`.

| Where | Saved to |
|---|---|
| Android app | `Documents/Scratchpad/` on the phone; Android 10 and older ask for storage permission the first time |
| Browser | Your normal downloads folder |
| Neovim | `:ScratchSnapshot` → current directory; `:ScratchSnapshot ~/notes/` → that folder; `:ScratchSnapshot ~/x.md` → that file |

### When two devices edit at the same time

If you type on two devices at the same moment, the server accepts whichever save arrives first. The other device doesn't lose its text:
- its version is saved as a new scratchpad named like `notes conflict 2026-11-20 143012.md`,
- it then shows the accepted version,
- and it tells you what happened.

Compare the two, copy over what you need, and delete the conflict copy.

### When a scratchpad is deleted on another device

- **App:** switches to another tab.
- **Neovim:** keeps your text in a buffer marked `(deleted)` that no longer syncs. Typing in it won't bring the scratchpad back. Use `:ScratchSnapshot` if you want to keep that text.

### Backups on the server

The server keeps old versions in `DATA_DIR/.backups/<scratchpad name>/`:
- at most one copy per scratchpad per hour, saved just before the scratchpad changes,
- one copy right before a scratchpad is deleted,
- copies older than 30 days are deleted automatically.

Backup files are named by date and time in UTC, e.g. `2026-11-20_143012.md`. To see them:

```sh
ssh <user>@<server> 'ls ~/scratchpad-data/.backups/notes.md/'
```

**Restoring a backup.** Send it back through the server, so open devices update right away:

```sh
ssh <user>@<server> 'curl -X PUT --data-binary @$HOME/scratchpad-data/.backups/notes.md/2026-11-20_143012.md http://<server-ip>:8787/api/files/notes.md'
```

To restore under a new name instead, change `notes.md` at the end of the URL. You can also open the backup file and copy text from it by hand.

---

## Troubleshooting

| Problem | Check |
|---|---|
| Red status dot / "cannot reach" in Neovim | Is the device on the tailnet (`tailscale status`)? Is the service running (`systemctl status pico-scratchpad` on the server)? Is the server address right (⚙ in the app, `url` in the Neovim setup)? |
| Service doesn't start after a reboot | It retries every 3 s until the Tailscale IP exists. `journalctl -u pico-scratchpad` shows why it fails. |
| `install-android.sh` says JDK 21 not found | `sudo dnf install java-21-openjdk-devel`, or point `JAVA_HOME` at a JDK 21. |
| "No phone connected" | USB debugging on, computer allowed on the phone; check with `adb devices`. |
| Opening the server in a browser by a domain name gives `bad host` | On purpose, to block DNS-rebinding attacks. Use the IP address, the short Tailscale machine name, or the full `*.ts.net` name. |

## HTTP API

This is what the clients use, in case you want to script against the server.

| Request | Effect |
|---|---|
| `GET /api/files` | JSON list of scratchpad names |
| `GET /api/files/<name>` | The text. The `X-Rev` header is the revision. |
| `PUT /api/files/<name>` | Saves the request body as the text. Headers:<br>• `If-Match: <rev>` saves only if the revision matches; otherwise `409` with the current `{rev, text}`.<br>• `If-None-Match: *` only creates; `412` if the scratchpad exists. |
| `DELETE /api/files/<name>` | Deletes it (after a backup) |
| `GET /api/events` | Server-Sent Events: `change`, `delete` and `list` messages |
