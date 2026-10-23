# Platform playbooks (optional)

Content generation does **not** require any files here. When a platform has no
playbook, the engine uses a built-in generic playbook (`genericPlaybook` in
`../engine.js`) plus the brand voice and the per-format length/shape rules
(`FORMAT_SPEC` / `genericFormatSpec` in `../engine.js`). Length is always
enforced regardless of what's in this folder.

To give a platform higher-fidelity, platform-specific guidance (hook rules,
structure, formatting conventions), drop a file here by convention:

    server/skills/<platform-id>-post/SKILL.md

`<platform-id>` is the platform's `id` in `client/src/data.js` (e.g. `linkedin`,
`instagram`, `x`). It's auto-discovered by `resolveSkillDir()` — no code change
needed. Use markdown with YAML frontmatter:

    ---
    name: <platform-id>-post
    description: One line describing when to use this playbook.
    ---

    # <Platform> post playbook
    ...your structure / hook / formatting rules...

Keep length rules OUT of the playbook — length is owned by `FORMAT_SPEC` per
format, so a platform's "short" and "long" formats stay distinct.
