import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createServer } from './server.js';

const adminUser = 'test-agent';
const adminPassword = 'test-password-with-entropy';
let directory;
let server;
let baseUrl;

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'queue-support-test-'));
  server = createServer({
    dataFile: path.join(directory, 'tickets.json'),
    adminUser,
    adminPassword
  });
  await server.ready;
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  if (directory) await rm(directory, { recursive: true, force: true });
});

function staffHeaders() {
  return { Authorization: `Basic ${Buffer.from(`${adminUser}:${adminPassword}`).toString('base64')}` };
}

test('public form is accessible while staff inbox data requires authentication', async () => {
  const form = await fetch(baseUrl);
  assert.equal(form.status, 200);
  assert.match(await form.text(), /Create support ticket/);

  const inbox = await fetch(`${baseUrl}/admin`);
  assert.equal(inbox.status, 401);
  assert.match(inbox.headers.get('www-authenticate'), /Basic/);

  const tickets = await fetch(`${baseUrl}/api/admin/tickets`);
  assert.equal(tickets.status, 401);
});

test('visitors can create tickets and staff can update and persist them', async () => {
  const invalid = await fetch(`${baseUrl}/api/tickets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Visitor', email: 'not-an-email' })
  });
  assert.equal(invalid.status, 400);

  const created = await fetch(`${baseUrl}/api/tickets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Jane Smith',
      email: 'JANE@example.com',
      category: 'Technical',
      subject: 'Cannot sign in',
      message: 'The sign-in page returns an error whenever I submit my details.'
    })
  });
  assert.equal(created.status, 201);
  const reference = await created.json();
  assert.equal(reference.id, 'TK-000001');
  assert.equal(reference.status, 'open');
  assert.match(reference.accessToken, /^[A-Za-z0-9_-]{43}$/);

  const missingCustomerAuth = await fetch(`${baseUrl}/api/customer/ticket`);
  assert.equal(missingCustomerAuth.status, 401);
  const invalidCustomerAuth = await fetch(`${baseUrl}/api/customer/ticket`, {
    headers: { Authorization: `Bearer ${'x'.repeat(43)}` }
  });
  assert.equal(invalidCustomerAuth.status, 404);

  const customerHeaders = { Authorization: `Bearer ${reference.accessToken}` };
  const customerView = await fetch(`${baseUrl}/api/customer/ticket`, { headers: customerHeaders });
  assert.equal(customerView.status, 200);
  const visibleTicket = await customerView.json();
  assert.equal(visibleTicket.id, reference.id);
  assert.equal(visibleTicket.messages.length, 1);
  assert.equal('email' in visibleTicket, false);
  assert.equal('activity' in visibleTicket, false);
  assert.equal('customerAccessTokenHash' in visibleTicket, false);

  const privateNote = await fetch(`${baseUrl}/api/admin/tickets/${reference.id}`, {
    method: 'PATCH',
    headers: { ...staffHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ note: 'This note is only for support staff.' })
  });
  assert.equal(privateNote.status, 200);
  const customerViewWithNote = await fetch(`${baseUrl}/api/customer/ticket`, { headers: customerHeaders });
  assert.equal((await customerViewWithNote.json()).messages.length, 1);

  const customerReply = await fetch(`${baseUrl}/api/customer/ticket/messages`, {
    method: 'POST',
    headers: { ...customerHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Here is another detail that may help solve my issue.' })
  });
  assert.equal(customerReply.status, 200);
  assert.equal((await customerReply.json()).messages.length, 2);

  const listed = await fetch(`${baseUrl}/api/admin/tickets`, { headers: staffHeaders() });
  assert.equal(listed.status, 200);
  const tickets = await listed.json();
  assert.equal(tickets.length, 1);
  assert.equal('customerAccessTokenHash' in tickets[0], false);
  assert.equal(tickets[0].email, 'jane@example.com');
  assert.equal(typeof tickets[0].messages[0].createdAt, 'string');
  assert.equal(typeof tickets[0].messages[2].createdAt, 'string');
  assert.equal(tickets[0].messages[2].text, 'Here is another detail that may help solve my issue.');
  assert.equal(tickets[0].messages[1].note, true);

  const staffReply = await fetch(`${baseUrl}/api/admin/tickets/${reference.id}`, {
    method: 'PATCH',
    headers: { ...staffHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'I have checked your sign-in issue and found the cause.' })
  });
  assert.equal(staffReply.status, 200);
  const staffReplyTicket = await staffReply.json();
  assert.equal(typeof staffReplyTicket.messages[3].createdAt, 'string');
  assert.match(staffReplyTicket.activity[0].text, /^Reply saved by /);

  const closeWithoutReason = await fetch(`${baseUrl}/api/admin/tickets/${reference.id}`, {
    method: 'PATCH',
    headers: { ...staffHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'closed' })
  });
  assert.equal(closeWithoutReason.status, 400);
  const closed = await fetch(`${baseUrl}/api/admin/tickets/${reference.id}`, {
    method: 'PATCH',
    headers: { ...staffHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'closed', resolutionReason: 'Customer confirmed the issue is fixed.' })
  });
  assert.equal(closed.status, 200);
  assert.equal((await closed.json()).resolutionReason, 'Customer confirmed the issue is fixed.');
  const savedAfterClose = JSON.parse(await readFile(path.join(directory, 'tickets.json'), 'utf8'));
  assert.equal(savedAfterClose[0].activity[0].text, 'Ticket resolved: Customer confirmed the issue is fixed.');
  const closedView = await fetch(`${baseUrl}/api/customer/ticket`, { headers: customerHeaders });
  assert.equal((await closedView.json()).status, 'closed');
  const rejectedReply = await fetch(`${baseUrl}/api/customer/ticket/messages`, {
    method: 'POST',
    headers: { ...customerHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'This reply should not go through on a closed ticket.' })
  });
  assert.equal(rejectedReply.status, 409);

  const updated = await fetch(`${baseUrl}/api/admin/tickets/${reference.id}`, {
    method: 'PATCH',
    headers: { ...staffHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignee: 'Jordan Kim' })
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).assignee, 'Jordan Kim');

  const saved = JSON.parse(await readFile(path.join(directory, 'tickets.json'), 'utf8'));
  assert.equal(saved[0].assignee, 'Jordan Kim');
  assert.equal(saved[0].activity[0].text, 'Assigned to Jordan Kim');
  assert.equal(saved[0].customerAccessTokenHash, createHash('sha256').update(reference.accessToken).digest('hex'));
  assert.equal(JSON.stringify(saved).includes(reference.accessToken), false);
});

test('simultaneous submissions receive distinct ticket numbers', async () => {
  const submit = (name) => fetch(`${baseUrl}/api/tickets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      email: `${name.replace(/\s+/g, '.').toLowerCase()}@example.com`,
      category: 'General',
      subject: 'A general support question',
      message: 'Please help me with a general support question.'
    })
  });
  const responses = await Promise.all([submit('Alex Smith'), submit('Taylor Jones')]);
  assert.deepEqual(responses.map((response) => response.status), [201, 201]);
  const references = await Promise.all(responses.map((response) => response.json()));
  assert.equal(new Set(references.map((reference) => reference.id)).size, 2);
});
