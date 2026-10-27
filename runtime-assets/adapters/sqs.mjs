// Send-only SQS tool for one queue, with a message size limit.
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { ToolInputError, dispatch, loadConfig, requireString } from './common.mjs';

const config = loadConfig();
const client = new SQSClient({});

export const tools = {
  async send_message(input) {
    const body = requireString(input, 'body', { maxLength: config.maxBodyBytes });
    if (Buffer.byteLength(body, 'utf8') > config.maxBodyBytes) {
      throw new ToolInputError(`"body" must be at most ${config.maxBodyBytes} bytes.`);
    }
    const groupId = requireString(input, 'messageGroupId', {
      optional: !config.fifo,
      maxLength: 128,
    });
    const result = await client.send(
      new SendMessageCommand({
        QueueUrl: config.queueUrl,
        MessageBody: body,
        MessageGroupId: config.fifo ? groupId : undefined,
      }),
    );
    return { messageId: result.MessageId };
  },
};

export const handler = (event, context) => dispatch(tools, event, context);
