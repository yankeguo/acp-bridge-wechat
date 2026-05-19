/**
 * Runtime WeChat API options set by the bridge before protocol calls.
 */

let botAgent: string | undefined;
let routeTag: string | undefined;

export function setWeixinRuntimeConfig(opts: {
  botAgent?: string;
  routeTag?: string;
}): void {
  botAgent = opts.botAgent;
  routeTag = opts.routeTag;
}

export function loadConfigBotAgent(): string | undefined {
  return botAgent;
}

export function loadConfigRouteTag(): string | undefined {
  return routeTag;
}
