import { createReadStream, promises as fs } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const categories = new Set(['General', 'Billing', 'Technical', 'Other']);
const assignees = new Set(['Avery Morgan', 'Jordan Kim', 'Riley Lee', 'Sam Chen', 'Unassigned']);
const maxBodyBytes = 16 * 1024;
const rateLimitWindowMs = 10 * 60 * 1000;
const maxSubmissionsPerWindow = 5;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  response.end(JSON.stringify(body));
}

function requireAdmin(request, response, credentials) {
  const header = request.headers.authorization || '';
  const match = /^Basic ([A-Za-z0-9+/]+=*)$/.exec(header);
  let providedUser = '';
  let providedPassword = '';

  if (match) {
    try {
      const decoded = Buffer.from(match[1], 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator !== -1) {
        providedUser = decoded.slice(0, separator);
        providedPassword = decoded.slice(separator + 1);
      }
    } catch {
      // Invalid credentials are handled by the normal unauthorized response below.
    }
  }

  if (safeEqual(providedUser, credentials.user) && safeEqual(providedPassword, credentials.password)) {
    return true;
  }

  sendJson(response, 401, { error: 'Staff authentication required.' }, {
    'WWW-Authenticate': 'Basic realm="Queue staff inbox", charset="UTF-8"'
  });
  return false;
}

async function readTickets(filePath) {
  try {
    const contents = await fs.readFile(filePath, 'utf8');
    const tickets = JSON.parse(contents);
    if (!Array.isArray(tickets)) throw new Error('Ticket data must be a JSON array.');
    return tickets;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function createActivity(text, createdAt) {
  return { text, createdAt };
}

function cleanText(value, field, minLength, maxLength) {
  if (typeof value !== 'string') throw new HttpError(400, `${field} is required.`);
  const normalized = value.trim();
  if (normalized.length < minLength || normalized.length > maxLength) {
    throw new HttpError(400, `${field} must be between ${minLength} and ${maxLength} characters.`);
  }
  return normalized;
}

async function readJson(request) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Send the request as JSON.');
  }
  const declaredLength = Number(request.headers['content-length'] || 0);
  if (declaredLength > maxBodyBytes) throw new HttpError(413, 'Request body is too large.');

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

function formatCreated(date) {
  return new Intl.DateTimeFormat('en', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);
}

function createTicket(input, tickets, customerAccessTokenHash) {
  if (typeof input.website === 'string' && input.website.trim()) {
    throw new HttpError(400, 'Unable to submit this request.');
  }
  const name = cleanText(input.name, 'Name', 2, 100);
  const email = cleanText(input.email, 'Email', 5, 254).toLowerCase();
  const subject = cleanText(input.subject, 'Subject', 5, 160);
  const message = cleanText(input.message, 'Message', 10, 5000);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new HttpError(400, 'Enter a valid email address.');
  }
  if (!categories.has(input.category)) {
    throw new HttpError(400, 'Choose a valid topic.');
  }

  const createdAt = new Date().toISOString();
  const nextNumber = tickets.reduce((highest, ticket) => {
    const number = Number(/^TK-(\d+)$/.exec(ticket.id || '')?.[1] || 0);
    return Math.max(highest, number);
  }, 0) + 1;
  const initials = name.split(/\s+/).slice(0, 2).map((part) => part[0].toUpperCase()).join('');
  const avatarColors = ['peach', 'blue', 'pink', 'green'];
  const ticket = {
    id: `TK-${String(nextNumber).padStart(6, '0')}`,
    name,
    email,
    handle: email,
    initials,
    avatar: avatarColors[nextNumber % avatarColors.length],
    subject,
    preview: message.length > 82 ? `${message.slice(0, 79)}...` : message,
    category: input.category,
    status: 'open',
    assignee: 'Unassigned',
    customerAccessTokenHash,
    channel: input.category.toLowerCase(),
    unread: true,
    createdAt,
    created: formatCreated(new Date(createdAt)),
    messages: [{
      who: name,
      initials,
      avatar: avatarColors[nextNumber % avatarColors.length],
      time: new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(new Date(createdAt)),
      createdAt,
      text: message
    }],
    labels: [input.category, 'Customer'],
    activity: [createActivity(`Ticket created by ${name}`, createdAt)]
  };
  return ticket;
}

function findCustomerTicket(request, tickets) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization || '');
  if (!match) throw new HttpError(401, 'Use your private ticket link to open this conversation.');

  const suppliedHash = createHash('sha256').update(match[1]).digest();
  const ticket = tickets.find((item) => {
    if (typeof item.customerAccessTokenHash !== 'string') return false;
    const storedHash = Buffer.from(item.customerAccessTokenHash, 'hex');
    return storedHash.length === suppliedHash.length && timingSafeEqual(storedHash, suppliedHash);
  });
  if (!ticket) throw new HttpError(404, 'This private ticket link is invalid.');
  return ticket;
}

function customerTicketView(ticket) {
  return {
    id: ticket.id,
    name: ticket.name,
    subject: ticket.subject,
    category: ticket.category,
    status: ticket.status,
    created: ticket.created,
    messages: ticket.messages
      .filter((message) => !message.note)
      .map(({ who, initials, avatar, time, staff, text }) => ({ who, initials, avatar, time, staff: Boolean(staff), text }))
  };
}

function updateTicket(ticket, input) {
  const keys = Object.keys(input);
  const allowed = new Set(['status', 'resolutionReason', 'assignee', 'addLabel', 'message', 'note', 'unread']);
  if (!keys.length || keys.some((key) => !allowed.has(key))) {
    throw new HttpError(400, 'Unsupported ticket update.');
  }
  if (input.message !== undefined && input.note !== undefined) {
    throw new HttpError(400, 'Send a reply or an internal note, not both.');
  }
  if (input.resolutionReason !== undefined && input.status !== 'closed') {
    throw new HttpError(400, 'A resolution reason can only be provided when closing a ticket.');
  }

  const createdAt = new Date().toISOString();
  if (input.status !== undefined) {
    if (!['open', 'closed'].includes(input.status)) throw new HttpError(400, 'Choose a valid status.');
    if (input.status === 'closed') {
      const reason = cleanText(input.resolutionReason, 'Resolution reason', 3, 500);
      ticket.resolutionReason = reason;
      ticket.activity.unshift(createActivity(`Ticket resolved: ${reason}`, createdAt));
    } else {
      ticket.activity.unshift(createActivity('Ticket reopened by Avery Morgan', createdAt));
    }
    ticket.status = input.status;
  }
  if (input.assignee !== undefined) {
    if (!assignees.has(input.assignee)) throw new HttpError(400, 'Choose a valid assignee.');
    ticket.assignee = input.assignee;
    ticket.activity.unshift(createActivity(`Assigned to ${input.assignee}`, createdAt));
  }
  if (input.unread !== undefined) {
    if (typeof input.unread !== 'boolean') throw new HttpError(400, 'Unread must be true or false.');
    ticket.unread = input.unread;
  }
  if (input.addLabel !== undefined) {
    const label = cleanText(input.addLabel, 'Label', 1, 32);
    if (ticket.labels.length >= 12) throw new HttpError(400, 'A ticket can have at most 12 labels.');
    if (!ticket.labels.includes(label)) {
      ticket.labels.push(label);
      ticket.activity.unshift(createActivity(`Added label: ${label}`, createdAt));
    }
  }
  if (input.message !== undefined || input.note !== undefined) {
    const isNote = input.note !== undefined;
    const text = cleanText(isNote ? input.note : input.message, isNote ? 'Note' : 'Reply', 1, 5000);
    const time = new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(new Date(createdAt));
    ticket.messages.push({
      who: 'Avery Morgan',
      initials: 'AM',
      avatar: 'green',
      time,
      createdAt,
      staff: true,
      note: isNote,
      text
    });
    ticket.preview = text.length > 82 ? `${text.slice(0, 79)}...` : text;
    ticket.unread = false;
    ticket.activity.unshift(createActivity(
      isNote ? 'Internal note added by Avery Morgan' : 'Reply saved by Avery Morgan',
      createdAt
    ));
    if (!isNote && ticket.status === 'closed') ticket.status = 'open';
  }
  return ticket;
}

export function createServer({
  dataFile = process.env.SUPPORT_DATA_FILE || path.join(root, 'data', 'tickets.json'),
  adminUser,
  adminPassword
} = {}) {
  if (!adminUser || !adminPassword) throw new Error('Staff username and password are required.');
  const limits = new Map();
  let tickets;
  let transactionQueue = Promise.resolve();

  const persistTickets = async (nextTickets) => {
    await fs.mkdir(path.dirname(dataFile), { recursive: true });
    const temporaryFile = `${dataFile}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(temporaryFile, JSON.stringify(nextTickets, null, 2), { mode: 0o600 });
    await fs.rename(temporaryFile, dataFile);
  };

  const transact = (operation) => {
    const transaction = transactionQueue.then(async () => {
      const nextTickets = structuredClone(tickets);
      const result = operation(nextTickets);
      await persistTickets(nextTickets);
      tickets = nextTickets;
      return result;
    });
    transactionQueue = transaction.then(() => undefined, () => undefined);
    return transaction;
  };

  const server = createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const route = `${request.method} ${url.pathname}`;

      if (route === 'GET /' || route === 'GET /support') {
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'strict-origin-when-cross-origin'
        });
        createReadStream(path.join(root, 'support.html')).pipe(response);
        return;
      }

      if (route === 'GET /admin') {
        if (!requireAdmin(request, response, { user: adminUser, password: adminPassword })) return;
        response.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'strict-origin-when-cross-origin'
        });
        createReadStream(path.join(root, 'index.html')).pipe(response);
        return;
      }

      if (route === 'POST /api/tickets') {
        const now = Date.now();
        const forwardedAddress = request.headers['x-forwarded-for'];
        const remoteAddress = request.socket.remoteAddress || 'unknown';
        const address = process.env.TRUST_PROXY === 'true' && typeof forwardedAddress === 'string'
          ? forwardedAddress.split(',')[0].trim() || remoteAddress
          : remoteAddress;
        const previous = limits.get(address);
        if (!previous || previous.resetAt <= now) {
          if (limits.size >= 10000) {
            for (const [client, entry] of limits) {
              if (entry.resetAt <= now) limits.delete(client);
            }
          }
          if (limits.size >= 10000) {
            throw new HttpError(503, 'Support is temporarily unavailable. Please try again later.');
          }
          limits.set(address, { count: 0, resetAt: now + rateLimitWindowMs });
        }
        const limit = limits.get(address);
        limit.count += 1;
        if (limit.count > maxSubmissionsPerWindow) {
          throw new HttpError(429, 'Too many requests. Please try again in a few minutes.');
        }

        const input = await readJson(request);
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw new HttpError(400, 'Request body must be a JSON object.');
        }
        const accessToken = randomBytes(32).toString('base64url');
        const accessTokenHash = createHash('sha256').update(accessToken).digest('hex');
        const ticket = await transact((nextTickets) => {
          const newTicket = createTicket(input, nextTickets, accessTokenHash);
          nextTickets.unshift(newTicket);
          return newTicket;
        });
        sendJson(response, 201, {
          id: ticket.id,
          status: ticket.status,
          createdAt: ticket.createdAt,
          accessToken
        });
        return;
      }

      if (route === 'GET /api/customer/ticket') {
        const ticket = findCustomerTicket(request, tickets);
        sendJson(response, 200, customerTicketView(ticket));
        return;
      }

      if (route === 'POST /api/customer/ticket/messages') {
        const input = await readJson(request);
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw new HttpError(400, 'Request body must be a JSON object.');
        }
        const text = cleanText(input.message, 'Message', 1, 5000);
        const authorization = request.headers.authorization;
        const ticket = await transact((nextTickets) => {
          const ownedTicket = findCustomerTicket({ headers: { authorization } }, nextTickets);
          if (ownedTicket.status === 'closed') throw new HttpError(409, 'This ticket is closed.');
          const createdAt = new Date().toISOString();
          const message = {
            who: ownedTicket.name,
            initials: ownedTicket.initials,
            avatar: ownedTicket.avatar,
            time: new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(new Date(createdAt)),
            createdAt,
            staff: false,
            text
          };
          ownedTicket.messages.push(message);
          ownedTicket.preview = text.length > 82 ? `${text.slice(0, 79)}...` : text;
          ownedTicket.unread = true;
          ownedTicket.activity.unshift(createActivity('Customer replied', createdAt));
          return customerTicketView(ownedTicket);
        });
        sendJson(response, 200, ticket);
        return;
      }

      if (route === 'GET /api/admin/tickets') {
        if (!requireAdmin(request, response, { user: adminUser, password: adminPassword })) return;
        await transactionQueue;
        sendJson(response, 200, tickets.map(({ customerAccessTokenHash, ...ticket }) => ticket));
        return;
      }

      const patchMatch = /^PATCH \/api\/admin\/tickets\/(TK-\d+)$/.exec(route);
      if (patchMatch) {
        if (!requireAdmin(request, response, { user: adminUser, password: adminPassword })) return;
        const input = await readJson(request);
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw new HttpError(400, 'Request body must be a JSON object.');
        }
        const ticket = await transact((nextTickets) => {
          const nextTicket = nextTickets.find((item) => item.id === patchMatch[1]);
          if (!nextTicket) throw new HttpError(404, 'Ticket not found.');
          return updateTicket(nextTicket, input);
        });
        const { customerAccessTokenHash, ...updatedTicket } = ticket;
        sendJson(response, 200, updatedTicket);
        return;
      }

      if (route.startsWith('GET ') || route.startsWith('HEAD ')) {
        sendJson(response, 404, { error: 'Page not found.' });
        return;
      }
      sendJson(response, 404, { error: 'Endpoint not found.' });
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(response, error.status, { error: error.message });
        return;
      }
      console.error('Support desk request failed:', error);
      if (!response.headersSent) sendJson(response, 500, { error: 'The request could not be completed.' });
      else response.destroy(error);
    }
  });

  server.ready = readTickets(dataFile).then((loadedTickets) => {
    tickets = loadedTickets;
  });
  return server;
}

function getCredentials() {
  const inProduction = process.env.NODE_ENV === 'production';
  let user = process.env.SUPPORT_ADMIN_USER;
  let password = process.env.SUPPORT_ADMIN_PASSWORD;
  if (!user || !password) {
    if (inProduction) {
      throw new Error('Set SUPPORT_ADMIN_USER and SUPPORT_ADMIN_PASSWORD before starting in production.');
    }
    user = user || 'admin';
    password = password || randomBytes(18).toString('base64url');
    console.log(`Local staff login: ${user} / ${password}`);
  }
  if (inProduction && password.length < 12) {
    throw new Error('SUPPORT_ADMIN_PASSWORD must be at least 12 characters in production.');
  }
  return { user, password };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const credentials = getCredentials();
    const server = createServer({ adminUser: credentials.user, adminPassword: credentials.password });
    await server.ready;
    const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
    const port = Number(process.env.PORT || 5501);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be between 0 and 65535.');
    server.listen(port, host, () => {
      console.log(`Queue support desk listening at http://${host}:${server.address().port}`);
      console.log(`Public ticket form: http://${host}:${server.address().port}/`);
      console.log(`Staff inbox: http://${host}:${server.address().port}/admin`);
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
