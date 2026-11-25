# Install or share the Super MD skill

Copy the complete `super-md/` folder into your agent's skills directory, or run `super-md agent install-skill` (`--agent codex`, `--agent claude`, `--agent cursor`, `--agent gemini`, `--agent agents`, or `--destination /path/to/super-md`; add `--replace` to back up an existing copy while preserving `references/local-preferences.md`). Keep `SKILL.md`, `references/` and `assets/` together. Reload skill discovery in the client if required; installation does not automatically add a skill to an already supplied context.

Native builds and **Settings → AI agent access** (**Export skill package (.zip)…** on desktop and Android) include `super-md-skill.zip`, containing the complete portable folder. Extract that archive into the skills directory. It contains general instructions and no personal profile, connector URLs or credentials. Optional personal defaults belong in `super-md/references/local-preferences.md` and should remain local.

The app's private MCP setup guide and this public skill package serve different purposes. Keep the private setup guide private; share the portable skill ZIP.
