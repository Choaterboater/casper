# 45. Your other tools' skill folders are yours; a project's follow folder trust

Date: 2026-10-29. Status: accepted (merged 2026-10-29 in #542). Builds on 44 (folder trust).
Replaces the opt-in, review-each-skill `skills.imports` and the per-skill review of `<project>/.casper/skills`.

**What:**
- **Your other tools' folders are read by default, as yours.** These are `~/.agents/skills` (the shared Agent Skills
  folder that Copilot, Codex and Pi read), `~/.claude/skills`, `~/.copilot/skills`, `~/.pi/agent/skills` and
  `~/.codex/skills`. A skill in them is trusted when its real file is in one of your folders, as `~/.casper/skills` is.
  `skills.imports` (yours only; a project file can't set it) lists fewer, and `[]` reads only Casper's own.
- **A repository's own folders follow folder trust.** These are `.casper/skills`, `.agents/skills`, `.claude/skills`,
  `.github/skills`, `.pi/skills` and `.codex/skills`. Their skills are used only while you trust the folder (44). There
  is no review of each skill; `/skills trust` on one says to trust the folder, and `/skills block` still stops one.
- **The same name in two folders:** the first folder in this order is used: `~/.casper/skills`, your other tools'
  folders in the order above, then the project's. `/skills` lists the others as not used and says which one is.

**Why:** the owner: "skills shouldnt be limimited to the folder - in case someone else uses the skills built in". Casper
saw 1 of the 55 skills on his Mac, and a skill the AI put in a project's `.claude/skills` was never used. Claude Code,
Copilot, Codex and Pi read these folders, and Claude Code loads a project's skills once its folder is trusted.

**Same as:**
- Claude Code: personal `~/.claude/skills` over project `.claude/skills`, loaded after its workspace trust.
- Copilot: `.github/skills`, `.claude/skills` and `.agents/skills` in a project; `~/.copilot/skills` and
  `~/.agents/skills` for you.
- Codex and Pi: `.agents/skills` and `~/.agents/skills`.

**Guard rails:**
- A skill is text in the prompt, never a command. Its scripts run only through the AI's shell and its boxes.
- A link out of your folders (into a cloned repository) is not yours. It needs `/skills trust` and its review.
- A repository's skills are never used in a folder you haven't trusted, your home folder or the top of a drive.
- Only `~/.casper/skills` may stand in for a bundled skill, and only while it keeps the bundled layout.
- A project file can't change `skills.imports`.

**A finding:** a project's skill used in a folder you haven't trusted; a skill whose real file is outside your folders
used without a review; another tool's or a project's skill standing in for a bundled one; or a project file changing
which folders are read.
