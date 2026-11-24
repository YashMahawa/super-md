"""Install the complete bundled authoring skill, with reversible replacement."""
import argparse, json, os, shutil, sys, uuid
from pathlib import Path

REQUIRED_SKILL_FILES = (
    "SKILL.md",
    "references/study-notes.md",
    "references/visual-authoring.md",
    "references/agent-connection.md",
    "assets/study-visual-example.svg",
)


def default_skill_destination(agent: str = "codex") -> Path:
    key = (agent or "codex").strip().lower()
    home = Path.home()
    presets = {
        "codex": Path(os.environ.get("CODEX_HOME", str(home / ".codex"))) / "skills" / "super-md",
        "claude": Path(os.environ.get("CLAUDE_CONFIG_DIR", str(home / ".claude"))) / "skills" / "super-md",
        "claude-code": Path(os.environ.get("CLAUDE_CONFIG_DIR", str(home / ".claude"))) / "skills" / "super-md",
        "cursor": Path(os.environ.get("CURSOR_HOME", str(home / ".cursor"))) / "skills" / "super-md",
        "gemini": Path(os.environ.get("GEMINI_CLI_HOME", str(home))) / ".gemini" / "skills" / "super-md"
        if "GEMINI_CLI_HOME" in os.environ else home / ".gemini" / "skills" / "super-md",
        "agents": home / ".agents" / "skills" / "super-md",
    }
    if key not in presets:
        supported = ", ".join(sorted(presets))
        raise ValueError(f"Unsupported --agent target {agent!r}; choose one of: {supported}")
    return presets[key]


class _SkillArgumentParser(argparse.ArgumentParser):
    def error(self, message: str):
        raise ValueError(message)


def main(argv):
    p = _SkillArgumentParser(description="Install the complete Super MD skill")
    p.add_argument("--agent", help="Target AI client preset (codex, claude, claude-code, cursor, gemini, agents)")
    p.add_argument("--destination", type=Path, help="Explicit destination directory for the super-md skill")
    p.add_argument("--replace", action="store_true", help="Back up and replace an existing skill directory")
    args = p.parse_args(argv)
    if args.agent and args.destination is not None:
        raise ValueError("Pass either --agent or --destination, not both")
    selected_agent = (args.agent or "codex").strip().lower() if args.destination is None else None
    destination = default_skill_destination(selected_agent) if args.destination is None else args.destination

    root = Path(sys._MEIPASS) / "resources" if getattr(sys, "frozen", False) else Path(__file__).resolve().parent.parent
    source = root / "dist/super-md-skill"
    if not source.is_dir():
        source = root / "docs/skills/super-md"
    for relative in REQUIRED_SKILL_FILES:
        if not (source / relative).is_file():
            raise ValueError("The complete skill is missing from this installation")
    dest = destination.expanduser().absolute()
    backup = None
    if dest.is_symlink():
        raise ValueError("Choose a real skill directory, not a symlink")
    if dest.exists():
        if not args.replace:
            raise ValueError("Skill directory exists; use --replace to back it up and update it")
        backup = dest.with_name(dest.name + ".backup-" + uuid.uuid4().hex[:8])
        dest.rename(backup)
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source, dest, ignore=shutil.ignore_patterns("local-preferences.md", ".*"))
        if backup and (backup / "references/local-preferences.md").is_file():
            shutil.copyfile(backup / "references/local-preferences.md", dest / "references/local-preferences.md")
    except Exception:
        if dest.exists():
            shutil.rmtree(dest)
        if backup:
            backup.rename(dest)
        raise
    payload = {
        "installed": str(dest),
        "backup": str(backup) if backup else None,
        "completePackage": True,
    }
    if selected_agent is not None:
        payload["agent"] = "claude" if selected_agent == "claude-code" else selected_agent
    print(json.dumps({"ok": True, "result": payload}))
    return 0
