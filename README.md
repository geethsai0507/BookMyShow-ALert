# BookMyShow-ALert
BookMyShow Alert is a Chrome extension that monitors selected BookMyShow theatre/date pages and sends instant desktop and optional email alerts the moment ticket bookings open, with one-click alert setup from the cinema page plus manual multi-theatre tracking

## Community

For contributors, start here:

- [CONTRIBUTING.md](CONTRIBUTING.md)
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- [SECURITY.md](SECURITY.md)
- [Issue templates](.github/ISSUE_TEMPLATE)
- [Pull request template](.github/PULL_REQUEST_TEMPLATE.md)

# ShowAlert User Guide

## 1) Load the extension
1. Open Chrome and go to chrome://extensions/
2. Turn on Developer mode
3. Click Load unpacked
4. Select this folder: showalert-extension

## 2) First-time setup
1. Click the ShowAlert extension icon
2. Enter your email
3. Click Start Monitoring

## 3) Add alert from BookMyShow page (recommended)
1. Open a BookMyShow cinema buytickets page
2. Click the floating Notify Me button on the page
3. Open the extension popup
4. Click + Notify Me in the detected theatre banner
5. Select date
6. Click Activate Alert

## 4) Add alert manually
1. Open extension popup
2. Expand Add Alert Manually
3. Enter Theatre Code, Theatre Name, City, and Date
4. Click + Add Alert

## 5) Optional email provider setup
1. Open extension popup
2. Click Settings
3. Select provider: Resend, Brevo, Mailjet, MailerSend, or None
4. Enter API Key (and API Secret for Mailjet)
5. Click Save Settings

## 6) Manage alerts
1. Active Alerts list shows all current alerts
2. Click X beside an alert to remove it
3. Click Clear all to remove all alerts

## 7) Notification behavior
1. Desktop notification is sent when tickets open
2. Email is also sent if provider is configured
3. Each alert notifies once per theatre and date
