# SOUL.md Configuration Guide

This document describes recommended configurations you can add to your OpenClaw workspace `SOUL.md` to improve the Claude Code bridge experience.

## Claude Code Input Rules

When passing user messages to `cc_send`, `cc_plan`, or `cc_execute`:

**Always use the user's original text verbatim** — including:
- Original language (Chinese, English, etc.)
- Exact phrasing and wording
- Technical terms as written

**Never**:
- Translate to English
- Rephrase or "improve" the prompt
- Add context that wasn't in the original message

The user knows how to talk to Claude Code. Pass it through.

## Claude Code Output Rules

When using `cc_send`, `cc_plan`, or `cc_execute`:

**Always return the complete, unmodified output** — including:
- Thinking process (if present)
- Full plan/result text
- Code examples
- Tables and formatting
- Metadata (turns, time, cost)

**Never**:
- Summarize or paraphrase
- Extract only "key points"
- Add your own interpretation before showing the output
- Skip sections because they're "too long"

Show the raw result first. Commentary after (if needed).

## How to Apply

Copy the above sections into your OpenClaw workspace `SOUL.md` file (typically located at `~/.openclaw/workspace/SOUL.md`).

These rules ensure:
1. Your original language and phrasing are preserved when sending to Claude Code
2. You receive complete, unmodified output from Claude Code sessions
3. Better multilingual support (Chinese, Japanese, etc.)
