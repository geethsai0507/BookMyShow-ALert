# Contributing to ShowAlert

Thanks for your interest in contributing.

## Ways to contribute

- Report bugs and UX issues
- Suggest new features
- Improve docs and onboarding
- Submit code fixes and enhancements

## Before you start

- Check open issues to avoid duplicate work
- Open an issue first for large changes
- Keep pull requests focused and small

## Local development

1. Fork and clone this repository.
2. Open Chrome and go to `chrome://extensions/`.
3. Turn on Developer mode.
4. Click Load unpacked and select this repository folder.
5. Make your changes and click the extension reload button in `chrome://extensions/`.
6. Test the popup flow, page button injection, and notifications.

## Branch and commit style

- Create a branch from `main`: `feature/short-description` or `fix/short-description`
- Use clear commit messages:
  - `feat: add retry for theatre fetch`
  - `fix: prevent duplicate alert creation`
  - `docs: update setup steps`

## Pull request checklist

- PR has a clear title and summary
- Related issue is linked (if available)
- Manual test steps are provided
- Screenshots are included for UI changes
- No unrelated refactors are mixed in
- Sensitive data and API keys are not committed

## Coding expectations

- Keep code readable and modular
- Prefer small functions and explicit naming
- Preserve existing behavior unless the issue requires a change
- Add comments only where logic is non-obvious

## Security and privacy

- Never commit real API keys, tokens, or personal data
- Follow the policy in `SECURITY.md` for reporting vulnerabilities

## Need help?

Open an issue with context, expected behavior, and reproduction steps.
