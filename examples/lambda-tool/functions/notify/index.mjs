// Demo tool: logs the notification instead of sending it anywhere.
// AgentCore Gateway passes the tool arguments as the event and the tool name
// (prefixed with "<target>___") in the client context.
import { randomUUID } from 'node:crypto';

const SEVERITIES = new Set(['info', 'warning', 'critical']);

export const handler = async (event, context) => {
  const tool = context.clientContext?.custom?.bedrockAgentCoreToolName ?? '';
  if (!tool.endsWith('___send_notification')) {
    return { error: `Unknown tool ${tool}` };
  }
  const message = typeof event.message === 'string' ? event.message.slice(0, 280) : '';
  if (!message) return { error: '"message" is required.' };
  const severity = SEVERITIES.has(event.severity) ? event.severity : 'info';

  const id = randomUUID();
  console.log(JSON.stringify({ event: 'notification', id, severity, length: message.length }));
  return { delivered: true, id };
};
