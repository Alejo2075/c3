// PutEvents tool for one event bus, with a fixed source and an allowlist of
// detail types. IAM conditions enforce both.
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { ToolInputError, dispatch, loadConfig, requireString } from './common.mjs';

const config = loadConfig();
const client = new EventBridgeClient({});

export const tools = {
  async put_event(input) {
    const detailType = requireString(input, 'detailType', { maxLength: 128 });
    if (!config.detailTypes.includes(detailType)) {
      throw new ToolInputError(`"detailType" must be one of: ${config.detailTypes.join(', ')}`);
    }
    const detail = requireString(input, 'detail', { maxLength: config.maxDetailBytes });
    try {
      const parsed = JSON.parse(detail);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    } catch {
      throw new ToolInputError('"detail" must be a JSON object encoded as a string.');
    }
    const result = await client.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: config.eventBusName,
            Source: config.source,
            DetailType: detailType,
            Detail: detail,
          },
        ],
      }),
    );
    if (result.FailedEntryCount) {
      return { error: result.Entries?.[0]?.ErrorMessage ?? 'The event was not accepted.' };
    }
    return { eventId: result.Entries?.[0]?.EventId };
  },
};

export const handler = (event, context) => dispatch(tools, event, context);
