import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';

import { config } from './config.js';

// Claude in Amazon Bedrock, reached at
// https://bedrock-mantle.{region}.api.aws/anthropic/v1/messages. The SDK signs
// requests with SigV4 using the standard AWS credential chain, so inside the
// cluster it picks up the web-identity token IRSA projects into the pod and
// exchanges it for the role Terraform created — no API key, no secret, nothing
// for External Secrets to deliver.
//
// Two consequences of running on Bedrock rather than the first-party API are
// load-bearing for the code that uses this client:
//
//   1. Structured outputs are not supported. Anywhere the agent needs a typed
//      result (the eval judge's verdict, a sub-agent's change set) it uses a
//      forced tool call with a JSON schema instead of `output_config.format`.
//   2. Server-side tools (web search, web fetch, code execution) are not
//      available. Every tool in this codebase is client-implemented, which is
//      the property that makes the agent's action surface enumerable — and
//      therefore auditable and gate-able.
let client: AnthropicBedrockMantle | undefined;

export function bedrockClient(): AnthropicBedrockMantle {
  client ??= new AnthropicBedrockMantle({ awsRegion: config.bedrock.region });
  return client;
}
