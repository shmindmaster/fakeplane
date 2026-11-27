/**
 * A webhook endpoint that providers redeliver to (retries on slow responses, timeouts and
 * non-2xx). Each event is handled once per (conversation, event id).
 *
 * The script starts the server, then plays a redelivery storm against it: the same event
 * three times at once, and again after it finished.
 *
 *   npx tsx examples/webhook-server.ts
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MemoryStore, createReplyOnce } from 'replyonce';
import { webhookOnce } from 'replyonce/adapters';

const ro = createReplyOnce({ store: new MemoryStore() });
const ticketsCreated: string[] = [];

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
    event_id: string;
    event: { channel: string; text: string };
  };

  const { status, retryAfter, result } = await webhookOnce(
    ro,
    { scope: body.event.channel, eventId: body.event_id, intent: 'create_ticket' },
    async () => {
      await new Promise((r) => setTimeout(r, 50)); // slow downstream API
      ticketsCreated.push(body.event.text);
      return { ticket: `T-${ticketsCreated.length}` };
    },
  );
  res.writeHead(status, retryAfter ? { 'retry-after': String(retryAfter) } : {});
  res.end(JSON.stringify({ status: result.status }));
});

async function main() {
  await new Promise<void>((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`;
  const event = JSON.stringify({ event_id: 'Ev0123', event: { channel: 'C-support', text: 'Printer is on fire' } });
  const post = () => fetch(url, { method: 'POST', body: event }).then(async (r) => `${r.status} ${await r.text()}`);

  console.log('three concurrent deliveries:', await Promise.all([post(), post(), post()]));
  console.log('a late redelivery:          ', await post());
  console.log('tickets created:', ticketsCreated.length);
  server.close();
}

main();
