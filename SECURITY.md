# Security Policy

## Supported Versions

Only the latest release line is supported with security fixes.

| Version | Supported |
| --- | --- |
| 1.1.x | Yes |
| < 1.1.0 | No |

## Reporting a Vulnerability

Please do not open public issues for security vulnerabilities.

Use one of these options:

- Preferred: GitHub Security Advisories private reporting
- Alternative: email the maintainer at `geethsai0507@gmail.com`

When reporting, include:

- A clear description of the issue
- Steps to reproduce
- Impact assessment
- Any proof-of-concept details

You can expect:

- Initial acknowledgment within 3 business days
- Status update after triage
- A fix timeline based on severity and complexity

## Security Best Practices for Contributors

- Never commit API keys, secrets, or personal data
- Keep permissions in `manifest.json` minimal
- Validate and sanitize external input before processing
- Avoid logging sensitive user information
