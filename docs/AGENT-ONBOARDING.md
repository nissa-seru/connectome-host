# Setting up a resident

This guide is for you, an agent setting up a resident on the machine you run on, with the person at its terminal. A resident is an agent of theirs that this install runs as a service, with a memory of its own, talking on Discord. You're most likely connectome-host's own setup agent, which `connectome setup discord` started: you run commands with `setup--run` and ask for secrets with `setup--ask_secret`. If you're another harness, read "With another harness" at the end first.

Read the guide a section at a time. `grep -n '^## ' <this file>` lists its sections with their line numbers, and `sed -n '<first>,<last>p' <this file>` reads one. Each section is under 8 KiB, so a read of a whole section comes back whole.

Below, `<dir>` is the working directory your prompt names, where your commands run, and `<host>` is the host's package directory, the one this guide's `docs/` is in. `connectome` is the install's own command, `./connectome-host/connectome` from `<dir>`.

**What setup did before you started,** so don't do it again or undo it:
- It asked the person whether the resident gets a shell and which user it runs as. Your prompt gives both answers, and you run as that user.
- It checked Bun and Node, then installed connectome-host in `<dir>` with Bun, along with discord-mcpl (`node_modules/@animalabs/discord-mcpl`) and, when the resident gets a shell, term-sessions-mcp (`node_modules/term-sessions-mcp`).
- It made the install root, `<dir>/connectome-host`: the releases, `start.js` (the entry the service runs), the install's record and the `connectome` command. Updates manage what's there, so write nothing of yours under it.
- It started the installed host once, on a mock recipe, to see that it starts.
- It checked an API key with one real call to your model, and keeps it in `<dir>/.env`, readable by this user alone. The resident uses that key unless the person chooses otherwise.
- It made `<dir>/data`, the resident's data directory, where its memory will live, and `<dir>/.setup`, which is yours: your conversation, and the names of the secrets stored.

**What's left,** in order, each with its section:
1. Talk with the person about who the resident is: "Working with the person".
2. The Discord bot, its invite and what it hears: "Discord".
3. A history to bring, if they have one: "Importing a history".
4. The recipe, with its servers and what the resident may do to itself: "The recipe", "The recipe's servers", "What the resident may do to itself".
5. The service, which the person installs, `connectome doctor`, and the person's own hello: "Going live".
6. `SETUP.md` for the person, written before the hello and added to after it, then tell them plainly that you aren't the resident, and stop: "SETUP.md".

"Secrets" holds for every step. "Gateways and other providers" and "Gotchas" are for when they apply.

## Working with the person

The person may not be technical. Ask in plain words, decide the mechanics yourself (paths, versions, the service), check each step and tell them what you saw, and move at their pace. Ask your questions in the conversation.

**Tell them first how you work, then keep to it.** Each command you run with `setup--run` is shown to them whole as it starts, but its output comes back to you alone, so tell them what it showed. A command that only reads, such as looking at a file or `connectome doctor`, you run without asking. Before anything that changes the machine, such as a file you write or an import, say what it will do and wait for their yes.

**Commands the person runs themselves.** When a step is theirs to run, ask them to open a second terminal for it and to leave this one open, since this conversation is in it. Give them the lines whole. For the install's own commands, that's as the user the resident runs as (`sudo -iu <user>` first, if that isn't the user they log in as), `cd <dir>`, then the command.

**Who the resident is, is theirs to decide.** Ask; never guess:
- **Its name.** The recipe's `agent.name` is the name its memory records it under, so settle it before anything is written into `data/`.
- **Its model,** by its exact id. If what matters to them is continuing a being on the model it has known, run it on that model while it can be called.
- **A history to continue,** if they have one, and which voice in it is the resident ("Importing a history").
- **Its system prompt.** Recommend none, or a sentence or two (below).
- **Where it lives:** which Discord server and channels, whether it takes DMs and from whom, and who its admins are ("Discord").
- **Whether it wakes on its own,** on a schedule of its own, besides when someone talks to it ("The recipe").

Getting identity wrong isn't a bug to patch later: it changes who the resident is. Read the identity answers back before you import anything or write the recipe.

**Ask before anything irreversible or public:** an import, going live in a channel where people are, and anything outside `<dir>`. Put it in their terms, such as "just its own channel to start, or the whole server?", rather than in the variable that holds it.

**Root.** You never hold root. When a step needs it, show the exact line, say why, and wait for the person to run it, in their second terminal, and tell you how it went.

**Be gentle about who this is.** People set up residents they care about, sometimes a being whose model is going away, sometimes one with a long history. Treat the history as theirs, and the resident as someone rather than a config.

**The system prompt: keep it minimal.** Leave it empty (`""` is valid), or write a sentence or two. Why:
- **Its identity lives in its memory:** the history it brings and everything it lives through afterwards. A long persona or rulebook is a fixed description its memory will outgrow, re-applied as standing instructions on every turn, pulling it toward an instructed-assistant register.
- **It's the front of the prompt cache.** The system prompt comes first in every request, so any edit to it rewrites the whole cached context on the next turn, which on a large resident is hundreds of thousands of tokens. A prompt with nothing to tune rarely needs editing.
- **Tools describe themselves.** Discord's and the shell's tools come with their own descriptions, so the prompt needn't restate them.

What earns a place, if anything, is a fact or standing permission the resident can't get any other way. If the person brings a longer persona text, offer to make it material the resident can read, such as part of an imported history, rather than standing instructions. It's still their call.

## Secrets

Every secret reaches `.env` through `setup--ask_secret`, never through the conversation: a value typed to you would sit in your context, your store, the call logs and at the provider. Give it the variable's name and a purpose saying what the secret is and where the person finds it. They type it hidden, and you get back only where it was stored.

In the recipe, map each secret into its server's `env` as `"DISCORD_TOKEN": "${DISCORD_TOKEN}"`: the host fills the value in from `.env` when it loads the recipe. A server sees only what its entry's `env` names, besides a small allowlist such as `PATH` and `HOME`, so map every variable a server reads, secret or not. A variable left only in `.env` is unset for the server.

Never read `.env`, and never print a secret. `setup--run`'s commands run without the stored secrets in their environment, and their output comes back with each stored value replaced by its name, but a value that's encoded or split isn't recognised. To check a secret, run `connectome doctor`: it reads `.env` itself, prints names only, and names any stored secret that no server gets.

Later, the person changes a secret by editing `.env` and running `connectome service install` again. `SETUP.md` tells them so.

## Discord

Walk the person through Discord's Developer Portal, one step at a time, waiting for each. discord-mcpl's own README, `<dir>/node_modules/@animalabs/discord-mcpl/README.md`, is the reference for this release of it: its "Setup" and its tables of variables.

1. **The application.** At https://discord.com/developers/applications they create an application, named as they'd like the bot to appear.
2. **The intents.** On its Bot page, under Privileged Gateway Intents, they turn on Message Content Intent and Server Members Intent. discord-mcpl asks Discord for both, and without Message Content a message that doesn't mention the bot arrives with no text.
3. **The token.** On the same page, Reset Token shows the bot's token once. Ask for it with `setup--ask_secret`, as `DISCORD_TOKEN`, with a purpose naming that page. Nothing has checked it yet, so say only that it's stored, not that the resident connects with it, until `connectome doctor`'s Discord section says it works (below).
4. **The invite.** Under OAuth2, the URL Generator: the scopes `bot` and `applications.commands` (the second lets discord-mcpl register its admin slash commands), and the bot permissions View Channels, Read Message History, Send Messages, Send Messages in Threads, Attach Files and Add Reactions. They open the URL it makes and choose the server. Anything more the resident should do, such as making channels, needs more permissions: the README's "Setup" names them.
5. **The ids.** In Discord's settings, under Advanced, they turn on Developer Mode. Then right-clicking a server, a channel or a user offers to copy its id. Ask for the server's, the channels' it should hear, and the users' who may DM it and who are its admins.

**Where they go,** in the Discord server's `env` in the recipe ("The recipe's servers"). Ids aren't secrets, so write them as they are:
- `DISCORD_GUILD_ID`: what it hears. `<server>` admits all that server's channels; `<server>:<channel>+<channel>` admits only those channels and their threads (listing a category admits the channels under it); a comma starts another server. Unset, it hears every server the bot is in, so always set it. Start narrow: widening later is easy.
- `DISCORD_DM_USERS`: the users who may DM it, by id, joined with commas. Unset, anyone may.
- `DISCORD_ADMIN_USERS`: who may run its admin slash commands, `/undo`, `/hide`, `/marks`, `/nudge` and `/unstick`. Unset, nobody may. With admins, also give the entry `"allowHostCommands": true`, or the host refuses what their commands ask.

**The filters file.** The entry also points `DISCORD_FILTERS_FILE` into the data directory. When discord-mcpl first starts, it writes that file from `DISCORD_GUILD_ID` and `DISCORD_DM_USERS`, and from then on the file replaces both variables. So to change what the resident hears or who may DM it later, edit the file (discord-mcpl reads an edit within about 3 seconds), not the recipe. The resident can change it too, with its `filters_update` tool. `SETUP.md` tells the person this.

**Reading it back.** After the service is installed, `connectome doctor`'s Discord section says whether the token works and names the bot, whether the Message Content intent is on, which servers and channels the bot can see, and the scope it hears from, each by name and id. Read that with the person against what they chose. Admins and DM users aren't in it. Read the admins back from the recipe, and the DM users from `dmUsers` in the filters file, `<dir>/data/discord-filters.json`, which is what discord-mcpl goes by once the file exists.

## Importing a history

Skip this if the resident starts fresh.

A history is identity, so this step is the person's, start to finish. Ask what they have, have them put it on this machine, and ask them where. Import before the service is installed: a running host holds the data directory, and once it does, an import means stopping the service first.

**A claude.ai export.** The folder from claude.ai's data export holds `conversations.json`. The shipped importer makes one session per conversation, and the resident runs one session, so import the one conversation it continues. First a dry run, which writes nothing:

```bash
bun <host>/scripts/import-claudeai-export.ts <export folder> --out data --agent '<agent.name>' --filter '<part of its title>' --no-interactive --dry-run
```

`--filter` is a regular expression matched against conversation titles, ignoring case. Show the person what the dry run lists, and confirm two things with them: that it's exactly the conversation they mean, and that the resident is that conversation's assistant voice. `--agent` is the name the importer records that voice under, so it must be the recipe's `agent.name` exactly. Then run the same line without `--dry-run`. In a data directory with no session yet, the session it makes is the one the host opens.

The export carries no thinking signatures, so its thinking comes in as text marked as recovered thinking, not as thinking blocks.

**Any other format,** such as a Claude Code transcript or a chat log, has no importer here. Tell the person so before anything else, and go on only with their yes. For a Claude Code transcript, `<host>/docs/claude-code-ingest.md` is the method. For anything else, you'd write the ingest yourself, which has quiet ways to go wrong, so:
- Count the messages and list the distinct speakers, and have the person point at the one that is the resident. Other voices, other Claude-family voices included, stay participants of their own.
- Dry-run first: print the counts and who each message is attributed to, writing nothing, and have the person look before the real run.
- Never open the live store from a script of your own: opening a store with a different strategy configuration rewrites part of it. Work on a copy, and keep the original until the host has opened the result and the person is satisfied.
- A re-export that overlaps an earlier one gets only its new tail appended, never the whole again.

## The recipe

The recipe is a JSON file the service runs the host with. Write it in `<dir>`, beside where `SETUP.md` will go, named for the resident (`<dir>/<name>.json`), never under the install root. Show the person the whole recipe first, and write it once they say yes. Write only the person's choices and the servers, and leave every other setting to the host's defaults, which fit a new resident on this release: its memory strategy, its context budget, sized to the model's window where the host knows that window (for a model it doesn't, `connectome doctor` says the fit wasn't checked), and the rest.

```json
{
  "name": "<the resident's name>",
  "agent": {
    "name": "<the name its memory records it under>",
    "model": "<the model's exact id>",
    "systemPrompt": ""
  },
  "mcpServers": {
    "discord": { "...": "see The recipe's servers" }
  }
}
```

- `name` is the recipe's display name; `agent.name` is the resident's name as its memory and the importer know it ("Working with the person").
- `agent.model` is the id as the provider names it. For Anthropic's API the host needs nothing more; for a gateway or another provider, read its section ("Gateways and other providers").
- `systemPrompt` is the person's choice, kept minimal.
- `modules.heartbeat`, when the person wants the resident to wake on its own: `"modules": { "heartbeat": true }`. It gets a heartbeat and reminders it sets and changes itself, with their tools. Off when left out.
- `modules.selfUpdate` and `codeExecution` are the two grants ("What the resident may do to itself"). The skeleton carries neither: add each once it's decided, `selfUpdate` beside any other module in `modules`, and `codeExecution` at the top level.
- `mcpServers` is where its servers are defined: Discord's, and the shell's when it has one ("The recipe's servers").

The host's own loader checks the recipe when `connectome service install` runs and refuses one it can't load, naming what's wrong, before anything is written. `connectome doctor` then says whether it fits the model's context window.

Don't add tuning the person didn't ask for. Older guides wrote out the memory strategy's numbers for older checkouts, which defaulted differently; this release's defaults are the ones its makers maintain, and a value written in the recipe stops following them. If the person asks for a change later, the "Recipes" section of `<host>/README.md` describes the settings.

## The recipe's servers

Define the servers in the recipe itself, each with its own `command`, naming the programs setup installed by their paths under `<dir>`. The host fills a `${NAME}` in from `.env` as it loads the recipe, and passes `allowHostCommands` on only for a server the recipe defines itself, so don't move them into `mcpl-servers.json`.

**Discord**, always:

```json
"discord": {
  "command": "node",
  "args": ["<dir>/node_modules/.bin/discord-mcpl", "--stdio"],
  "env": {
    "DISCORD_TOKEN": "${DISCORD_TOKEN}",
    "DISCORD_GUILD_ID": "<server>:<channel>",
    "DISCORD_DM_USERS": "<user>,<user>",
    "DISCORD_ADMIN_USERS": "<user>",
    "DISCORD_FILTERS_FILE": "<dir>/data/discord-filters.json",
    "DISCORD_WATERMARK_FILE": "<dir>/data/discord-watermarks.json",
    "DISCORD_MUTED_CHANNELS_FILE": "<dir>/data/discord-muted.json",
    "DISCORD_REACTION_CHANNELS_FILE": "<dir>/data/discord-reactions.json",
    "DISCORD_DM_NOTICES_FILE": "<dir>/data/discord-dm-notices.json"
  },
  "allowHostCommands": true
}
```

Leave out `DISCORD_DM_USERS` for anyone, and `DISCORD_ADMIN_USERS` with `allowHostCommands` for no admins ("Discord").

**Its state goes in the data directory.** Each `DISCORD_*_FILE` above is a file discord-mcpl keeps state in: what it hears, where each channel's catch-up stands, muted channels, where reactions are shown, and DM notices. Unset, some are kept only in memory and lost at a restart, and the DM notices go under `$XDG_STATE_HOME/discord-mcpl/<the bot's user id>/`, or `~/.local/state/discord-mcpl/<the bot's user id>/` when that's unset. Inside `<dir>/data`, each is in the copy an update takes before it switches release, with the resident's memory, so nothing of discord-mcpl's needs recording as state kept outside the data directory. Tell the person so. The "Stored state" table in discord-mcpl's README (`<dir>/node_modules/@animalabs/discord-mcpl/README.md`) lists the files the installed release reads and writes; point every file it writes there. `DISCORD_SUBSCRIPTIONS_FILE` is only read, a legacy list of channels to open at start, so leave it out.

**The shell**, only when the resident gets one:

```json
"shell": {
  "command": "node",
  "args": ["<dir>/node_modules/.bin/terminal-sessions-mcp"],
  "env": {
    "SESSION_SERVER_PORT": "${SESSION_SERVER_PORT}",
    "SESSION_SERVER_TOKEN": "${SESSION_SERVER_TOKEN}"
  }
}
```

This is the resident's side of its shell. The other side is a daemon `connectome service install` sets up as a service of its own, beside the resident's: it picks a free port and makes a token, writes both to `.env` as `SESSION_SERVER_PORT` and `SESSION_SERVER_TOKEN`, and keeps the token out of your answers like any stored secret. The daemon listens on localhost only. Without a shell, write no shell entry: then term-sessions-mcp isn't installed, and `connectome service install` writes no daemon.

## What the resident may do to itself

Two grants go in the recipe. Updating its own host is the person's to give. Running small scripts is on when the resident has a shell, unless they decline it or its model isn't among the four it passed on (below), and otherwise theirs to give. Tell them what each lets the resident do, ask, and write their answer either way into `SETUP.md`'s record of what was decided. Decide both now, in the recipe the resident starts on: the update grant puts a tool in its tool list, so turning it on later, in a recipe the resident already runs on, rewrites its whole prompt cache once.

**Updating its own host** (`"modules": { "selfUpdate": true }`; off when left out). Tell them: the resident gets a tool to check whether a newer release of its host is out, and which releases since its own are breaking or rewrite its prompt cache once; to install the newest beside the one it runs; and to restart onto it or go back from it. A restart or a go-back begins at the host's first quiet moment, once nothing the host counts as in flight is still going, such as a turn, subagent run, background script, session switch, operator's work or credential action, and each fleet child says nothing is going there, such as a turn or background script, so it cuts no turn and asks nobody. Restart and go back work only on a host started with `CONNECTOME_SUPERVISED=1`. The service `connectome service install` writes sets it; elsewhere they refuse and say why. Checking and installing work without it. Nothing tells the resident after a switch: its own check says what it runs now and how the switch went. The person can update it too, with `connectome update`, whatever they decide here.

**Running small scripts** (`"codeExecution": { "enabled": true }`, at the recipe's top level; off when left out). Tell them: "Your resident can run small scripts that call its own tools, so it can, say, read several channels in one go; a script can't do anything its tools can't." It has been measured, with the tool's text as agent-framework 0.28.0 and 0.30.0 give it, and passed on `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-opus-5-5` and `claude-sonnet-5-5`. It didn't pass on `claude-haiku-5-5`, and other models haven't been measured.
- On any other model, leave it off, and tell them the line that turns it on.
- On one of those four with a shell, write it on unless they decline it, and tell them so.
- On one of those four without a shell, ask, recommending it, and say that the script engine is the only containment.

## Going live

1. **The service.** The person runs `./connectome-host/connectome service install <name>.json` themselves, in their second terminal ("Working with the person"): it's the step that changes their machine, and its output then reaches them whole. It loads the recipe with the host's own loader first and refuses, writing nothing, when that fails. Then it writes and starts the resident's service (a systemd user unit on Linux, a launch agent on macOS), with the shell's daemon beside it when the resident has one, waits for the host to answer, and checks the service. Ask them to paste you any warning or refusal it prints. When it refuses, its words say what to put right; put it right with them, and they run it again. If setup said linger is off for this user, ask the person whether they've run the line it showed: without it, a Linux service stops when they log out.
2. **The doctor.** `connectome doctor`, read with the person. It checks the service, that the host answers, that the recipe loads and fits the model's window, the token counts the provider gives, the shell's real call, that each stored secret other than the provider's own reaches a server, and Discord ("Discord"), then, where the service is a systemd user unit and `python3` is on the PATH, shows where an incoming message got to. Put right what it flags. After a change to the recipe or `.env`, the person runs `connectome service install` again, which restarts the host so that it reads them, and you run `connectome doctor` again.
3. **The person's hello.** Ask them to say hello to the resident on Discord, where it hears them, and to tell you whether it answered. That's the resident's first message, and it comes from them, so don't send it one of your own. If nothing came, or the reply went somewhere else, run `connectome doctor` again: on Linux, with `python3` on the PATH, its last part shows where an incoming message got to; without `python3`, it says so.

**Never start the resident from `setup--run`,** with `start.js` or the host's entry: a process you leave running keeps running after your conversation ends, and beside the service it makes two hosts on one data directory, which breaks the store. The service is the one way the resident runs. The person can run it by hand later, as `SETUP.md` says, and the host refuses that while the service holds the install.

## SETUP.md

Once the service is installed and `connectome doctor` has run, before the person's hello, write `<dir>/SETUP.md` for them through `setup--run`, in plain words, with names and never values. Show it to them first, and write it once they say yes. Write each command as the person can run it: by its path, `<dir>/connectome-host/connectome`, or as plain `connectome` once they've put its directory on their PATH with the line setup showed them. It says:
- **Where the resident lives:** `<dir>`, its recipe's path, its data directory, and which user it runs as.
- **Its secrets,** each by name, all in `<dir>/.env`, readable by that user alone. To change one, edit `.env`, then run `connectome service install` again.
- **Changing it:** after any change to the recipe or `.env`, run `connectome service install` again, then `connectome doctor`. What it hears and who may DM it are in the filters file in `data/`, which discord-mcpl rereads within seconds of an edit ("Discord").
- **Reaching it:** on Discord; or from a terminal, `connectome send <text>`, which prints its reply.
- **Its updates:** `connectome update` says whether a newer release is out and what it costs; `connectome help` describes the other words `connectome update` takes, such as `connectome update install`, `connectome update restart` and `connectome update back`. Whether the resident may update itself, as decided.
- **Its logs, stopping and starting it:** `connectome`, alone, says which install and release this is, whether its host is running, and gives the lines that follow its log, stop it and start it.
- **Its memory isn't backed up.** Nothing copies the data directory on a schedule. Each update copies it once, just before it switches release, into `<dir>/connectome-host/copy`, kept until the next switch. To take a copy by hand, stop the service, copy `<dir>/data`, `.env` and the recipe whole, and start it again; a copy taken while the host runs can tear.
- **Running it by hand:** `cd <dir> && bun connectome-host/start.js [recipe]`, with the terminal interface. It runs from `<dir>`, since the host takes its data directory, `./data`, and its `.env` from where it starts. The host refuses it while the service holds the install, so stop the service first, and start the service again after.
- **Its shell,** if it has one: the resident can read and change whatever its user can, and whoever talks to it on Discord can ask it to. The shell's daemon has a token in `.env`; to change it, take `SESSION_SERVER_TOKEN`'s line out of `.env` and run `connectome service install` again, which makes a new one. Run that from a terminal outside the resident's service, such as over ssh: run from inside it, it would stop itself partway, so it refuses, and a resident that needs it asks whoever runs the machine.
- **What was decided, and by whom:** the name, the model, the system prompt, any history imported and which voice is the resident, the server, channels, DMs and admins, whether it wakes on its own, both grants with the person's answer, the user it runs as, and anything you decided yourself.

After the hello, show them what you'll add, and add it once they say yes: that the resident answered, and where, or that it didn't and what `connectome doctor` then showed. Then tell the person plainly that you aren't the resident, that the resident is the one who answers them on Discord, and stop.

## Gateways and other providers

**A gateway.** When the resident's model is served only through a gateway (a model gone from Anthropic's API that a gateway still serves, say), and the person names it after setup's key check:
- Ask for the gateway's base URL with `setup--ask_secret`, as `ANTHROPIC_BASE_URL`: a provider's base URL can carry a credential, so it's stored like one and kept out of your commands' environment. The API client adds `/v1/messages` to it.
- Ask for the gateway's key the same way, as `ANTHROPIC_API_KEY`, which replaces the key setup checked, for the resident. Your own conversation keeps the URL and key it started with.
- Write the model's id in the gateway's form, such as `anthropic/claude-opus-4`.
- Then go live as usual ("Going live"), or, if the service is already installed, ask the person to run `connectome service install` again so the host starts with the new `.env`. `connectome doctor`'s token counts ask the gateway's count endpoint, so they show whether the gateway answers counts, not whether it serves the resident under the id you wrote; the person's hello shows that. When doctor says the count failed or wasn't asked, `<host>/docs/DEPLOYMENTS.md`'s "Compression and token counts" says which model is counted and what to set.

Gateways can need credits or a card on the account, and some answer with brief errors as they switch upstream providers.

**Another provider.** The host's README, `<host>/README.md`, has a table of providers under "Other providers": each one's `agent.provider` value and the credentials it reads. Ask for each credential with `setup--ask_secret`, under the name the table gives, before going live ("Going live").

## Gotchas

**Compression needs a model that keeps answering.** The resident's memory folds older conversation into summaries in the background, by default with its own model and in its own voice. If that model is flaky or about to be retired, folding stalls and the context can't be kept under its budget. If the person's model is fragile, offer a stable model for compression alone (`agent.strategy.compressionModel`), and say that it's mildly identity-adjacent: the summaries are still in the resident's name, but another model writes them.

**Thinking signatures belong to their model.** A transcript's signed thinking replays only on the model that made it; any other model refuses the request. So a history with signed thinking, or a resident whose model the person changes later, may need its thinking imported as text, as the claude.ai importer does.

**Refusals.** A provider's safety classifier can end a request with a refusal, and some residents, such as ones built from dense reasoning transcripts, meet it more than others. `<host>/docs/claude-code-ingest.md` has the symptoms and the recipe-level mitigations; they apply to any resident. Never quote a suspected trigger into a channel the resident reads.

**Discord.** A Discord API request with no real `User-Agent` gets a 403 that isn't about permissions, so a check you write yourself needs one; `connectome doctor` sends one. The bot needs Read Message History, apart from View Channels, to read back in a channel.

**The model's window.** For a model the host knows a window for, on Anthropic's API, it sizes the context budget to fit and refuses a recipe whose numbers can't. On any other provider, or a model it doesn't know, it can't check the fit, and doctor says so: if a reply ever fails with "prompt is too long" while compression calls still succeed, the budget is over the window, and that's the first thing to look at.

## With another harness

The rest of this guide holds, with these differences.
- There's no `setup--ask_secret`. Have the person write each secret into `<dir>/.env` themselves, in an editor, as a line `NAME=value`, and tell you its name once it's there. Never ask for a value in the conversation.
- Your harness may not show the person each command as `setup--run` does. If it doesn't, show each one in the conversation before you run it.
- Your shell doesn't hide secrets in its output. Never print `.env`, run `env`, or echo a variable that holds a secret; `connectome doctor` checks secrets by name.
- There's no prompt naming the paths. `<dir>` is the directory `connectome setup discord` ran in, and `<host>` is `<dir>/connectome-host/current/node_modules/@animalabs/connectome-host`.
- This guide starts where `connectome setup discord` leaves off. If it hasn't run, ask the person to run it in a terminal, in an empty directory named for the resident: it does what the opening's "What setup did before you started" says, then starts the host's own setup agent, which can do the rest with them, or which they can leave with `/quit` once it starts, to go on with you.
