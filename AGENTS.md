# Workspace Guidelines

- Never hardcode color values in UI code or styles. Use the existing themed CSS variables instead.
- Never kill already running development servers or processes. They're probably already running.
- Never commit or push changes yourself. Only commit or push when explicitly asked by the user.
- Keep answers very brief and short, limited to only the most relevant information. Avoid long explanations or unnecessary details.
- Never let a user act through mureview in a way their own forge account could not act outside of it. Use the acting user's own credentials for every forge call, and gate actions (merging, settings, refreshing, creating pull requests, comments) on the acting user's forge permissions — not on ownership alone.
