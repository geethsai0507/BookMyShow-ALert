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
5. Optional: type a **Screen / format** (e.g. `PCX`, `EPIC`, `IMAX`) — suggestions come from the screens on the page you're on
6. Optional: type a **Movie** (e.g. `Doomsday`)
7. Choose **Any date** or a **Specific date**
8. Choose how to be notified: **Every new date**, **Once**, or **Stop after N notifications**
9. Choose **Notify for**: **All bookable shows** (🟢 available + 🟠 filling fast) or **Only available 🟢**
10. Click Activate Alert

Example: "Doomsday · PCX · Any date · Every new date" at Prasads tells you each time PCX opens a new date for Doomsday, and never fires for the other screens.
Screen and movie matching ignores case and matches part of the name (`pcx` matches `PCX` and `Screen 1 - PCX`).

## 4) Add alert manually
1. Open extension popup
2. Expand Add Alert Manually
3. Enter Theatre Code, Theatre Name and City
4. Optionally set Screen / format and Movie, then pick the date and notify options (same as above)
5. Click + Add Alert

## 5) Optional email provider setup
1. Open extension popup
2. Click Settings
3. Select provider: Resend, Brevo, Mailjet, MailerSend, or None
4. Enter API Key (and API Secret for Mailjet)
5. Click Save Settings

## 6) Manage alerts
1. Active Alerts list shows each alert's screen, movie, date mode, and the dates found so far
2. Click ⏸ to pause an alert and ▶ to resume it
3. Click X beside an alert to remove it
4. Click Clear all to remove all alerts

## 7) Notification behavior
1. Desktop notification is sent when matching shows open
2. Email is also sent if provider is configured
3. A date is never notified twice for the same alert
4. If several dates open at once, they arrive in **one** notification (counted as one toward "Stop after N")
5. Click **Book Now** to open the date, or **Stop this alert** to stop watching
6. Every few minutes the extension checks each theatre in a separate **minimized window** (it opens and closes on its own; your tabs aren't touched)

## 8) Development
Run the unit tests (Node 18+, no install needed):

    node --test
