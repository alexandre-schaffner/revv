# Revv for Claude Code

This plugin connects the active Claude Code checkout to the matching pull
request in the local Revv app. It provides the walkthrough, ratings, flagged
issues, and review conversations, plus scoped tools for recording verified
fixes and addressing comments.

Install it from **Revv → Settings → Integrations → Connect Claude Code**. Revv
must remain running in the tray while the plugin is in use.

Revv generates the rest of this plugin at install time: the stdio MCP bridge
comes from `integrations/external-mcp-bridge/`, and the `address-feedback`
skill body comes from `integrations/external-agent-guides/`, so every agent
Revv supports reads the same instructions.

The installed copy contains an account-scoped credential and is managed by
Revv. Reconnecting rotates that credential; disconnecting revokes it.
