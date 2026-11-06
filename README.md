# website-test
Making a website with AI.
JavaScript

## Run the support desk

The public site creates real support tickets and stores them in `data/tickets.json`. Run it with Node.js 20 or newer:

```sh
npm start
```

Open <http://localhost:5501/> for the public ticket form and <http://localhost:5501/admin> for the staff inbox. On a local development run, the server prints a generated staff password in the terminal; the username is `admin`. Tickets persist across server restarts. The inbox refreshes automatically while open.

The staff inbox and its API require HTTP Basic authentication. Before deploying, set a unique staff username and a strong password of at least 12 characters:

```sh
NODE_ENV=production \
SUPPORT_ADMIN_USER=your-staff-name \
SUPPORT_ADMIN_PASSWORD='use-a-long-unique-secret' \
HOST=0.0.0.0 \
npm start
```

Deploy on a Node.js host, put the app behind HTTPS, and mount persistent storage for the `data/` directory. This JSON-file version is intended to run as one server instance. Do not use a static-only host or commit ticket data or production credentials. Configure regular backups for `data/tickets.json`.

If a trusted reverse proxy in front of the app overwrites `X-Forwarded-For` with the visitor's address, set `TRUST_PROXY=true` so public submission rate limits are applied per visitor. Do not enable this when clients can connect directly to the app.

When a visitor creates a ticket, the server returns a random, private access link once. The link is shown on screen and in the browser URL; visitors must save or bookmark it to return to their ticket. Its access token is kept in the URL fragment, is not sent to the server in page requests, and is stored server-side only as a hash. Anyone with the private link can read and reply to that ticket, so visitors should not share it publicly.

Customers can use their link to read staff replies and send messages. The customer view never includes internal staff notes, and replying is disabled as soon as staff close a ticket; customers with an open ticket are redirected back to Queue Support when it is closed. Staff and customer replies are saved in the inbox, but email delivery is not configured, so customers need their private link to see staff responses. Private links are issued only for tickets created after customer access was added; previously created tickets do not have customer access links.

The staff inbox includes Analytics summaries based on saved tickets, including a first-response-time trend with date ranges from 7 days through 12 months and the dates of recent first replies. Response times are measured from ticket creation to the first public staff reply; older tickets without dated reply history are omitted from this metric. A Community view of General and Other customer requests (visible to authenticated staff) and browser-local settings for refresh frequency and compact ticket rows are also available. Staff must enter a resolution reason before closing a ticket; the reason is saved in the ticket activity and closing requests without one are rejected.

Run the automated checks with `npm test`.